# TODO — fully-live call flow (deferred)

**Status: deferred by decision, not blocked by design.**

Today Hue's transcripts are seeded into the app database (`demo/transcripts.json`
→ `governance.ingestTranscript`) and joined to **real** CMMS service requests.
The service-request half is already fully live: every check reads the record from
`facilio-cmms` at call time, never a copy.

The missing half is pulling the transcript automatically when a call ends, so a
real phone call flows into Hue with no seeding step.

## Why it isn't built

The connections catalog exposes no way to read a call log. Probed on
2026-08-13 against Ocean's 3 (org 2935, US):

| Connection | Status | Actions found | Call-log read? |
|---|---|---|---|
| `helpdesk-channels-tools` | ACTIVE (`service_token`) | `end-call` | No |
| `facilio-helpdesk-copilot` | ACTIVE (`service_token`) | `list-contacts`, `fetch-tickets`, `create-scope` | No |

`callLogId` is clearly a first-class concept — it is a required input on
`helpdesk-channels-tools.end-call` and on
`facilio-cmms-atom-tools.list-service-requests` — but nothing *reads* a call log.

The underlying HTTP endpoints exist (in AE:
`GET https://ae.atom.facilio.ai/api/assistant/calllog/{callId}` with
`x-client-key`, and `https://channels.facilio.ae/api/logs/{callId}` with
`x-integration-key`, returning a `transcription` array of
`{performer, message}`). They are not surfaced through connections, and because
both helpdesk connections authenticate with a server-side service token, no key
is obtainable from the app side. Guessing a US hostname was explicitly avoided.

## What would unblock it

### Option A — preferred: add two read actions to `helpdesk-channels-tools`

```
get-call-log(callLogId)          -> { callId, startedAt, durationSec, caller,
                                      status, transcription: [{performer, message}] }
list-call-logs(since, status?)   -> [{ callLogId, endedAt, status }]
```

This needs **no credential work on Hue's side**. The function already reaches
that connection through `process.system.CONNECTIONS_URL`, and the platform
injects the service token — the same path the Claude judges use today, which is
verified working. Implementation would then be roughly 40 lines (below).

### Option B — raw HTTP from the function

Requires all four:

1. The US host + path equivalents of both AE endpoints.
2. The exact header name and key value for each.
3. Confirmation the host is public HTTPS on port 443 — the Studio Functions
   sandbox rejects non-443 ports and private/loopback/metadata IPs.
4. **A way to list new calls.** Both AE endpoints are fetch-by-id only. A
   watermark poller cannot discover *which* ids are new from a by-id endpoint,
   so this needs either a list endpoint or a webhook. Without it there is no
   poller to build, whatever the credentials.

The key would go in a vault `environment_variable` credential rather than in
code, so the sandbox only ever sees a placeholder.

## Implementation sketch (once either option lands)

Watermark polling, in a scheduled job:

```ts
// functions/ingestcalls.ts
server.addHandler({
  name: 'poll',
  description: 'Pull transcripts for calls completed since the watermark.',
  parameters: { limit: { description: 'Max calls per run', type: 'number' } },
  execute: async (args) => {
    const db = connect();
    // Watermark = newest call already stored. ISO-8601 UTC strings sort
    // lexicographically, so MAX() is a valid high-water mark.
    const since =
      db.query("select max(started_at) as w from conversations where id <> '__seed__'")
        .rows[0]?.w ?? '1970-01-01T00:00:00Z';

    const calls = await channels('list-call-logs', { since, status: 'completed' });

    let ingested = 0;
    for (const c of (calls.data ?? []).slice(0, Number(args.limit) || 20)) {
      // Idempotent on callId — a re-run replaces turns rather than duplicating.
      const log = await channels('get-call-log', { callLogId: c.callLogId });
      upsertConversation(db, log);          // reuse governance.ingestTranscript logic
      ingested++;
    }
    return { since, ingested };
  },
});
```

Then schedule it. Note two platform constraints that shape this:

- **Minimum interval is 15 minutes** (`intervalSeconds >= 900`), so this is
  near-real-time, not instant. A webhook would be needed for instant.
- **Scheduled jobs target the PROD function**, so the app must be promoted to
  production first — a job on a preview-only app records every fire as failed
  with "function not found".

```sh
facilio vibe jobs create pull-call-logs \
  --function ingestcalls --handler poll \
  --interval 900 --payload '{"limit":20}'
```

After ingest, each new conversation runs through the existing pipeline unchanged:
`governance.evaluate` (join + deterministic checks) then
`governance.evaluateSemantic` per semantic criterion. Nothing downstream needs to
change — the seeded and live paths converge at `ingestTranscript`.
