# Next step — wire `call_grades` (write path + read path)

**Status: steps 1 and 2 are BUILT and deployed to preview as v37 (14 Aug 2026).**
`writeCallGrade` is the single writer of both `call_grades` and
`conversations.quality_score`; `getConversation` returns the stored grade and
`ConversationDetail` seeds its analysis state from it, so the justification,
sentiment reason and overall assessment now survive a reload.

**Step 3 (the reload nudge) is also BUILT**, deployed as v38 — see
`docs/reload-nudge.md` for the claim, the reap, and what was verified.

The rest of this document is the spec as approved and built against; it is kept
because the rules in it outlive the pass that implemented them.

---

## Where things stand

`call_grades` was created on 14 Aug 2026 via `facilio vibe db import`
(`db/seed/call_grades.csv`, 20 columns, one `__seed__` row). The platform
performs that DDL, so it needed no schema grant — the app's own role is still
refused `CREATE TABLE` / `ALTER TABLE`, and `migrate up` still fails with
`permission denied for schema`.

**There is no DROP and no ALTER on this path.** The `facilio vibe db` surface is
`create · import · tables · describe`. A missed column means a second table,
which is why `schema_version` is in there.

Run `facilio vibe db describe call_grades` for the live shape.

Before this pass a call's grade lived only in `conversations.quality_score`. The
justification, sentiment reason and overall assessment were held in React state
and **vanished on reload** — that is the gap these two steps closed.

Two preview rows carry hand-written test grades from the verification below —
`CG-L-2431` and `CG-L-2437`. A real **Run evals** overwrites either in place;
that is what the deterministic id is for.

---

## The rule (approved, non-negotiable)

> `call_grades` is the single source of truth. Its write path writes that table
> **and** the denormalised `conversations.quality_score` in one step, and
> **nothing else ever writes `quality_score`**. Every reader treats
> `applicable='false'` as authoritative — a `response_quality` of 0 on such a row
> is the *absence* of a score, never a score of zero.

Two things make this worth stating rather than assuming:

- **The database enforces nothing.** These tables came from CSV import: no
  primary key, no unique, no foreign key, no trigger, every column nullable.
  The rule holds *by construction* — one function, one caller — or not at all.
- As of this writing there is exactly **one** `update conversations set
  quality_score` in the codebase, inside `saveCallAnalysis`. Keep it that way;
  if a second appears, the rule is already broken.

---

## Step 1 — write path

Replace the `saveCallAnalysis` handler in `functions/governance.ts` with:

1. **`function writeCallGrade(db, g)`** — a module-level internal, NOT a handler.
   It is the only place either write happens:
   - upsert `call_grades` on `id = 'CG-' + conversationId` (select-then-write,
     matching the pattern used elsewhere in the file — a deterministic id means
     a re-grade updates rather than piling up rows)
   - then `update conversations set quality_score` — **only** when
     `applicable && responseQuality !== null`
   - derive `sentiment_agrees`: `''` when either side is missing or the analyst
     said `unknown` (a gap is not a contradiction), else `'true'`/`'false'`
   - store `null` for `response_quality` when not applicable. Never 0.
   - `schema_version` = 1

2. **`saveCallAnalysis`** — validates, then calls `writeCallGrade` exactly once.
   Its parameters grow (handler params may only be `number` or `string`, so the
   criteria arrays cross as comma-separated strings, which is also how the
   columns are defined):

   | param | type | notes |
   |---|---|---|
   | `conversationId` | string | |
   | `applicable` | number | 1 / 0 |
   | `responseQuality` | number | 0-100, or -1 when not applicable |
   | `sentiment` | string | happy \| neutral \| frustrated \| distressed \| unknown |
   | `justification` | string | |
   | `sentimentReason` | string | |
   | `overallAssessment` | string | |
   | `criteriaSatisfied` | string | comma-separated ids |
   | `criteriaBreached` | string | comma-separated ids |
   | `criteriaGraded` | string | comma-separated ids attempted |
   | `criteriaUnavailable` | string | judges that never answered |
   | `agentVersion` | string | agent link name + model |
   | `gradedBy` | string | `auto` \| `manual` |

   Validation stays as it is now and must not be relaxed: reject
   `responseQuality` outside 0-100, reject a `sentiment` outside the enum.

3. **Sentiment ownership is unchanged.** The CHANNEL stays authoritative for
   `conversations.sentiment`; the analyst only fills a gap when the channel gave
   none. A disagreement is recorded on the grade (`sentiment_agrees='false'`)
   and shown to a human — never resolved by overwriting.

4. **Client side** (`src/lib/judges.ts`, `runCallAnalysis`): send the new fields.
   `criteriaSatisfied`/`criteriaBreached` come from the analyst verdict;
   `criteriaGraded` is the list actually attempted this run;
   `criteriaUnavailable` is the ones whose judge timed out — that column is what
   keeps "never answered" distinct from "passed" across reloads, which is the
   whole never-fake-a-pass rule made durable. `agentVersion` should be the
   `call-analysis` link name plus its model (`claude-opus-4-7`).

---

## Step 2 — read path

1. **`getConversation`** returns the stored grade. Read the `call_grades` row for
   the conversation and return it as `grade`, with the four `criteria_*` columns
   split back into arrays. `null` when there is no row.

2. **`src/lib/vibe.ts`** — add `grade` to the `getConversation` return type.

3. **`ConversationDetail`** — seed the existing `analysis` state from
   `data.grade` on load, mapped into the `CallAnalysis` shape already used by
   the tabs. A live **Run evals** still overrides it in place.

   `ScoreTab` and `SentimentTab` need **no change** — they already take a
   `CallAnalysis | null`. That is the whole point of mapping stored → same shape.

4. The "not graded yet" line and the awaiting-grading states added in the
   syncStatus pass stay as they are.

---

## Must not break

- **Manual "Run evals"** — the only route to the model-graded half. Untouched.
- **The two scheduled jobs** — `pull-call-logs` (ingest) and `grade-new-calls`
  (deterministic grading via `gradeUngraded`). Both still paused; both target
  the prod function.
- **`gradeConversation()`** — the deterministic core shared by the `evaluate`
  handler and the job. Do not fork it.
- **Agents stay client-side.** No agent call may be added to any function: a
  Studio Function aborts a fetch at ~10s and every agent call measures
  10.8-33.8s. See the header of `functions/governance.ts`.

---

## Verify after building

```sh
# write path — grade one call, then read the row back
facilio vibe function run governance saveCallAnalysis --args '{ … }'
facilio vibe db describe call_grades          # row count should climb

# read path — the grade should come back on the conversation
facilio vibe function run governance getConversation --args '{"id":"L-2431"}'

# single-writer rule still holds — expect exactly 1
grep -c 'update conversations set quality_score' functions/governance.ts

# regression: the deterministic path is unaffected
facilio vibe function run governance evaluate --args '{"conversationId":"L-2441"}'
```

Then in the UI: open a graded call (L-2431 scored 88) and confirm the
justification, sentiment reason and overall assessment render **on load**,
without pressing Run evals.

---

## Held for later

- ~~**Step 3 — the reload nudge.**~~ Built — `docs/reload-nudge.md`.
- **Ingest duplicate window.** `upsertLiveCall` is select-then-insert with no
  unique index, so two simultaneous ingests of the same new call could both
  write. Unreachable today (one scheduled ingester), and it is why reload-ingest
  was rejected in favour of the read-only `syncStatus`.
- **Tool-call rendering** — blocked on the platform team: every call's
  `facilioThreadId` is rejected by `get-call-tool-calls`. See
  `docs/live-call-ingest.md`.
