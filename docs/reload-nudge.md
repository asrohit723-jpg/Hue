# The reload nudge — grading sooner, without two people grading one call

**Status: built and deployed to preview as v38 (14 Aug 2026).**

A call arrives on the channel, gets ingested, and then waits up to fifteen
minutes for `grade-new-calls` to fire. That wait is the whole problem this
solves: when someone opens the call list and there is a backlog, the server
grades a call or two immediately instead of leaving them looking at it.

The reason this needed a design at all is that "grade it now, on load" is one
browser away from "every open tab grades the same call at once".

---

## The claim

`call_grades.claimed_at` / `claimed_by` were created for this. The claim lives
on the grade row, so a call has ONE record rather than a grade plus a separate
lease that can disagree with it.

**Two writers of `call_grades` now exist, over disjoint columns:**

| writer | owns | never touches |
|---|---|---|
| `writeCallGrade` | every grade column, and `conversations.quality_score` | `claimed_at`, `claimed_by` |
| `claimNextForGrading` | `claimed_at`, `claimed_by` | any grade column |

That partition is what keeps step 1's single-writer rule true. `quality_score`
still has exactly one writer. A claim must never write a grade column, and a
grade must never clear a claim.

## Why two users cannot take the same call

The claim is one statement:

```sql
update call_grades set claimed_at = $1, claimed_by = $2
 where id in (
   select cg.id from call_grades cg
     join conversations c on c.id = cg.conversation_id
    where c.eval_status = 'not_evaluated' and <claimable>
    order by c.started_at desc
    limit 1
    for update skip locked
 )
returning conversation_id
```

- Postgres takes a row lock per candidate, so two claimers cannot both update
  one row. The loser re-evaluates the `WHERE` against the winner's committed
  value, sees a fresh claim, and matches nothing.
- `SKIP LOCKED` is what turns "the loser gets nothing" into "the loser gets a
  DIFFERENT call" — without it the second claimer blocks on the row the first
  holds and then finds it taken.
- `RETURNING` is the proof. Nothing grades a call it did not get back.

Claims are taken **one at a time, immediately before grading**. A fire that
claimed ten and died after three would strand seven for the full TTL, which is
the stuck state this exists to prevent.

## The reap

`CLAIM_TTL_MS` is 10 minutes. Deterministic grading takes 2-5s, so ten minutes
is not a timeout — it is the mark of a fire that DIED. A row is claimable when:

- `claimed_at` is empty — never claimed; **or**
- `claimed_at` is older than the cutoff — a dead fire, reaped; **or**
- `graded_at >= claimed_at` — the last claim completed.

The columns are TEXT, so these are string comparisons; ISO-8601 UTC sorts
lexicographically in time order, which is the same property the rest of this
codebase already relies on.

**Nothing releases a claim on failure, deliberately.** A call whose grade throws
keeps its claim and becomes retryable in ten minutes. That is a backoff —
releasing immediately would let a permanently failing call be retried by every
reload.

## One shared path

`gradeClaimed()` is the only loop: claim → `gradeConversation()` → repeat until
the limit or the budget. Both callers go through it:

| caller | limit | budget |
|---|---|---|
| `gradeUngraded` (the `grade-new-calls` job) | 10 | 600s |
| `nudgeGrading` (a page load) | 2 | 20s |

They differ only in appetite. If they differed in how they claim, a scheduled
fire and a nudge could grade the same call — the one thing this makes
impossible. The nudge is small on purpose: it runs while somebody waits on a
page load, so it takes a bite out of the backlog. The job owns the backlog.

**Grading stays server-side and deterministic.** No agent call enters a Studio
Function — a fetch aborts at ~10s and every agent Hue uses runs longer. The
nudge makes the SERVER grade sooner; it does not move grading into the browser.

## A claim is not a grade

The claim path seeds an empty `call_grades` row for every call awaiting
grading, so a row's EXISTENCE no longer means the call was graded.
`getConversation` therefore requires `graded_at <> ''`. Without it a
claimed-but-unanalysed call comes back `applicable=false`, which the scorecard
renders as **"not applicable"** — the UI saying a call could not be judged when
nothing has judged it. This was caught on preview, not in review.

## The honest gap

The backfill that creates those rows cannot be made exclusive: the app's role
cannot create a unique index (it cannot CREATE TABLE at all). Two fires racing
to backfill the same never-graded call could both insert a placeholder, and
each could claim one of the twins.

The cost is a call graded **twice**, not a call graded **wrongly**: both
`gradeConversation` (deviation id `DV-<convo>-<criterion>`) and
`writeCallGrade` (`CG-<convo>`) derive a deterministic id and select-then-write
against it, so the second pass converges on the rows the first wrote. Wasted
work, never divergent data.

> **Corrected 14 Aug 2026.** An earlier version of this paragraph said
> `deviations` carries a real `UNIQUE (conversation_id, criterion_id)`. It does
> not. `facilio vibe db describe deviations` shows the same CSV-imported shape
> as everything else — all text, all nullable, no constraint. **There is no
> unique index anywhere in this database**, and only five tables exist; the DDL
> in `db/schema.sql` documents intent, not what the role was able to create.
> The conclusion above is unchanged, but it rests on deterministic ids and
> select-then-write, never on the database refusing a duplicate.

## Verified on preview

- **Exclusivity** — two `nudgeGrading` fires launched concurrently against one
  ungraded call (L-2491): one returned `graded: 1`, the other `graded: 0`.
- **Job vs nudge** — `gradeUngraded` and `nudgeGrading` fired concurrently
  against L-2501: the nudge took it, the job got nothing.
- **A claim is not a grade** — `getConversation` on a claimed, deterministically
  graded, never-analysed call returns `grade: null`; L-2431, really analysed,
  still returns its score and prose.
- **Reap arithmetic** — the claimable predicate checked across all seven states
  (never claimed, running, 9m59s, dead at 11m, graded since, claimed after its
  last grade, manual-path row) plus the ordering assumption it rests on.
- **Not demonstrated end to end:** two claimers landing on two DIFFERENT calls,
  which needs two simultaneous candidates — the channel only ever offered one
  at a time. It follows from `SKIP LOCKED`, but it was reasoned, not observed.
  Worth re-testing the first time a real backlog of two or more appears.

## Left alone

- Manual **Run evals** and the browser-side judges — untouched.
- `gradeConversation()` — not forked; both paths still call the one core.
- Steps 1 and 2 — the persisted grade write and read still work as built.
