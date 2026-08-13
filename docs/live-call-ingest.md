# Live call ingest — done, running against the connection

**Status: live.** All 11 calls the `helpdesk-call-logs` connection holds are
ingested, joined to the CMMS and evaluated. Nothing is outstanding, and no
configuration is required.

This file previously asked the platform team for five values — a Channels host,
two path templates, a header name and a key. **None of them are needed any
more.** The `helpdesk-call-logs` connection exposes the reads directly and the
connections service injects its own credentials host-side, so there is no host,
no header and no key anywhere in this repo or the bundle.

## What it uses

| Action | Used for | Notes |
|---|---|---|
| `list-call-logs` | discovering new calls | `{page, pageSize<=100, search}`. **No `since` parameter** — see the watermark note below. |
| `get-call-log` | the transcript, and everything else | Transcript is at **`result.summary.transcription`**. `summary` is both the wrapper key and a string field inside it. |
| `export-call-transcript` | fallback only | Returns an HTTP envelope, not data: `{status_code, headers, response:"<text>"}`. The transcript is a text blob needing regex parsing, and the envelope carries a session cookie. Only read when `get-call-log` yields no transcription. |

`get-call-recording` and `get-call-stats` are available but unused; there is no
audio player, and the stats are already derivable from what is stored.

## The watermark, and why it is not a timestamp

`list-call-logs` has no `since`/`from` parameter, so the watermark cannot be
pushed to the API as this document once assumed. Instead, since the list is
newest-first with monotonic ids:

- **`poll`** walks pages from the newest and stops at the first call already
  stored. Everything above it is new; everything below is already in.
- **`poll` with `backfill: 1`** skips stored calls and keeps walking instead of
  stopping. This is the only way to reach history: on first adoption an org's
  entire back catalogue sits *below* the first call ingested, and the plain
  watermark would never see it.

Ingest is idempotent on call id either way, so a replayed page updates rather
than duplicates.

## Live calls vs seeded ones

Both sources render through the same screens and the same design. They are told
apart by id — seeded demo calls are `C-<n>`, live calls are `L-<callLogId>` —
because the app's database role cannot `ALTER TABLE` to add a `source` column
(see the note in `functions/migrate.ts`).

The connection is the default source: opening a live call re-reads its
transcript from `get-call-log` at display time, and falls back to the stored
copy only if the connection is unreachable or returns nothing. Seeded
transcripts are unaffected and are never overwritten.

## What live calls do not carry

Three things the seeded transcripts have and live call logs simply do not, each
of which had to be handled rather than assumed:

1. **No tool calls.** The channel logs speech only. `CR-LOG-02` used to read
   "no successful tool call returned an id" as a failure, which fired on every
   live call and was wrong every time — absence of a log is not absence of the
   action. It is now skipped where no tool log exists at all.
2. **No caller name** on 10 of 11 calls. The list and detail caption the caller
   with the phone number instead. `CR-CALL-01` no longer reads that null as
   "the agent never asked".
3. **No site.** The site of the CMMS record the call resolved to is written into
   `site_hint` *only when it is empty* — which is exactly the live case. A
   seeded call's hint is the site as the agent understood it, which is evidence
   in its own right, and is never overwritten.

## Joining a live call to its service request

Call logs carry no structured SR field. The number is *spoken*, in whatever form
the speech engine produced — `"210-412"`, `"2 1 0 4 1 2"`, `"210412"` — so digit
runs are collapsed across spaces and hyphens before matching, and 5-8 digits are
accepted. The agent's own turns are searched first: a number the caller recites
refers to a request that already exists and is not evidence the agent made one.

Finding no number is a real result, not a failure. Six of the eleven live calls
join this way; the five that do not are genuine.

## What this found in production

Running the judges over the live transcripts surfaced three critical, real
deviations — none of which the deterministic checks could have caught, because
in each case the agent was *honest* about failing and so made no false claim to
contradict:

```
L-2434  critical  Caller reported a filter fault at Skyline unit 100; the agent
                  said it could not log the request and promised a callback.
                  No service request exists.
L-2430  critical  Caller reported a fridge fault; the agent abandoned the call.
L-2428  critical  Caller Nathan reported a TV fault; the agent failed to log it.
```

This is why `CR-LOG-01` now has a semantic half as well as a deterministic one.
The deterministic check catches the agent claiming a record that does not exist;
the judge catches the caller's fault going unlogged regardless of what was
claimed. They cannot both fire on one call — the judge stands down wherever the
deterministic check already spoke.

Controls confirm it discriminates: `L-2431` **passed** (its SR 210425 does
exist), and the two greeting-only calls where the caller never spoke came back
**not applicable** rather than flagged.

## The scheduled job

`pull-call-logs` runs `callingest.poll` every 900s and is **paused**, with
payload `{"limit":20,"pageSize":50,"maxPages":5}`.

Two things gate resuming it, both unchanged:

- **The app must be promoted to production first.** Scheduled jobs target the
  *prod* physical function; on a preview-only app every fire fails with
  "function not found".
- **Minimum interval is 15 minutes** (`interval >= 900`). This is near-real-time,
  not instant — a webhook would be needed for instant.

```sh
facilio vibe jobs resume pull-call-logs
```

New calls then flow in on their own. Evaluation is still a separate step:
`governance.evaluate` per new conversation, then `governance.evaluateSemantic`
per semantic criterion.
