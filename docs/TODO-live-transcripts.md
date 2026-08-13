# Live call-log ingest — built, waiting on one config drop

**Status: code complete and deployed. Inert until the Channels endpoint is
supplied. No code change is needed to switch it on.**

Hue's service-request half is already fully live — every check reads the record
from `facilio-cmms` at call time. The missing half is the transcript: pulling it
automatically when a real call ends, instead of seeding it.

That ingest now exists (`functions/callingest.ts`, function `callingest`, job
`pull-call-logs`). It has **no host baked in** and will not invent one. Until
configured, `poll` returns `{configured: false, missing: [...]}`, writes nothing,
and leaves the seeded transcripts exactly as they are.

## What I need from the platform team

Five values. Nothing else is outstanding.

| # | Value | Example (AE, for shape only — this org is **US**) | Notes |
|---|---|---|---|
| 1 | **Host** | `https://channels.facilio.ae` | US equivalent. Must be `https://` on port 443 — the sandbox rejects other ports and any private/loopback address. |
| 2 | **List path** | `/api/logs?since={since}&status=completed` | Must support *listing calls newer than a timestamp*. `{since}` is substituted with the watermark. **This is the one piece the AE endpoints you had do not cover** — both were fetch-by-id only, and a poller cannot discover which ids are new from a by-id endpoint. If no list endpoint exists, a webhook on call-completed works instead and I'll switch the trigger. |
| 3 | **Get path** | `/api/logs/{callId}` | Returns one call log including `transcription: [{performer, message}]`. `{callId}` is substituted. |
| 4 | **Header name** | `x-integration-key` (or `x-client-key`) | Whichever the US service expects. |
| 5 | **Key** | — | The value for that header. |

If the response envelope differs from AE's, that is already handled — the
adapters accept `data` / `logs` / `callLogs` / a bare array for the list, and
`transcription` at top level, under `data`, or under `callLog` for the detail.

## Switching it on

One command. No redeploy, no code change:

```sh
facilio vibe jobs update pull-call-logs --payload '{
  "limit": 20,
  "host":       "https://<US-CHANNELS-HOST>",
  "listPath":   "/api/logs?since={since}&status=completed",
  "getPath":    "/api/logs/{callId}",
  "headerName": "x-integration-key",
  "key":        "<KEY>"
}'

facilio vibe jobs resume pull-call-logs
```

Verify before resuming — this reports what landed and never echoes the key:

```sh
facilio vibe function run callingest config --args '{"host":"…","listPath":"…","getPath":"…","headerName":"…","key":"…"}'
facilio vibe function run callingest ingestOne --args '{"callId":"<a real call id>", …}'
```

`ingestOne` pulls exactly one call so you can confirm the shape end to end
before letting the schedule run.

## Two preconditions on the job

- **The app must be promoted to production first.** Scheduled jobs target the
  *prod* physical function; on a preview-only app every fire fails with
  "function not found". The job is therefore created **paused** — resume it after
  promotion.
- **Minimum interval is 15 minutes** (`interval >= 900`). This is near-real-time,
  not instant. A webhook would be needed for instant.

## Where the key lives

The CLI's `function create` has no `--env` flag, so config arrives as handler
args via the job payload — stored platform-side, never in this repo or the
bundle. `resolveConfig()` reads `process.env.CHANNELS_*` **first** and falls back
to args, so if vault `environment_variable` credentials become available to Vibe
functions, move the key there and delete it from the payload — no code change.

## How it behaves once live

1. Watermark = `MAX(started_at)` over stored conversations. ISO-8601 UTC strings
   sort lexicographically, so this is a valid high-water mark.
2. `poll` lists calls since the watermark, skips any `call_id` already stored,
   and fetches each remaining one.
3. Transcription turns are mapped to Hue's shape (`caller` / `agent` / `system`)
   so a live transcript reads identically to a seeded one.
4. Each call is upserted on `callId` — a replayed window updates rather than
   duplicates.
5. A call with no transcription is skipped and reported in `failed[]`, not
   stored as an empty conversation.
6. One bad call never aborts the batch.

Then run `governance.evaluate` on each new conversation to join it to its real
CMMS service request and run the deterministic checks, followed by
`governance.evaluateSemantic` per semantic criterion. Nothing downstream
changes — the seeded and live paths converge on the same tables.

## Fallback

The seeded transcripts in `demo/transcripts.json` remain the source of record
until the live feed is on, and are unaffected by it. Ingest only ever adds calls
the watermark has not seen.
