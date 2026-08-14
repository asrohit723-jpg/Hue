# Ask for the platform team — reach conversations that are not calls

**One request: give `helpdesk-call-logs` a way to return conversations whose
type is not `CALL`.** Everything else on our side is already built and waiting.

---

## What we can see today

`helpdesk-call-logs.get-call-stats` returns, for org 2935, agent 6208:

```json
{ "type": "CALL", "total": 18, "byType": { "WEB": 1, "PHONE": 17 } }
```

That action's own output schema documents the field as **"The conversation type
these stats cover (CALL)"** — so `CALL` is one conversation *type* among others
in the platform's model, and this connection is a view filtered to it.

The five actions on the connection are `list-call-logs`, `get-call-log`,
`export-call-transcript`, `get-call-recording`, `get-call-stats`. None of them
accepts a `type` or `channel` parameter — `list-call-logs` takes only
`{page, pageSize, search}`. So there is no way for us to widen the filter from
the client side; it lives in the action definition.

## Why we believe other types exist

Not an assumption — it is in the payload the connection already returns:

- Every conversation row carries `channelId` (4893 for PHONE, 4900 for WEB), and
  an `email` field that is null on all 18.
- Every transcript turn carries `whatsapp`, `messageType`, `mimeType`,
  `mediaUrl` and `attachments`. All null on all 18. These are not voice fields.
- The record type is called a **conversation** throughout (`conversationId` on
  every turn), with `callType` as an attribute of it.
- On call 2511 the agent itself says *"I'll send a summary on WhatsApp"*.

## The exact request

Either of these unblocks us; the first is smaller:

1. **Add an optional `type` (or `channel`) parameter to `list-call-logs`** —
   e.g. `{"page":1,"pageSize":50,"type":"WHATSAPP"}` — and have `get-call-log`
   return such a conversation by id, in the same envelope it uses today.
2. Or expose a sibling action, e.g. `list-conversations`, covering all types.

**What we need in the response** is nothing new: the same shape. We verified
that a WEB conversation and a PHONE conversation come back through
`get-call-log` with byte-identical keys, differing only in `callType`,
`channelId` and the polymorphic identity field. If a WhatsApp conversation
arrives in that same envelope, our ingest stores it with no code change.

## Two questions we could not answer ourselves

1. **Does the org have any non-CALL conversations at all right now?** We cannot
   tell — every action we can reach is CALL-scoped. If the answer is "none
   exist yet", that is a perfectly good answer and we will stop waiting on it.
2. **Is `type` filtered per connection, or per agent?** Related to the open
   `get-call-tool-calls` issue in `docs/live-call-ingest.md`, where this same
   credential cannot see agent 6208 or its threads
   (`facilio-ai-studio.agent-list` returns only our own five agents). If both
   are visibility scoping, one fix may cover both.

## What is already built on our side

Waiting only on the data:

- `conversation_channels` records `callType`/`channelId` on every conversation
  and maps it to a **modality** — `voice` for PHONE and WEB, `text` for
  WHATSAPP/CHAT/EMAIL, and `text` for anything unrecognised, so a new channel is
  never graded as speech by default.
- Channel-aware checks: on a text conversation the two voice-only criteria
  (`CR-ESC-04` dropped call, `CR-CALL-02` one-question-at-a-time) are marked
  not-applicable rather than failed, and the eight that read a CMMS record are
  marked not-checked until the reference parser below exists. Four criteria —
  scope, escalation and empathy — grade on text today.
- `writtenSrNumber` is stubbed in `functions/callingest.ts` with the format we
  expect (`SR 210412`, `#210412`, `Service Request ID: 210412`). **We will not
  implement it until we can test it against a real text conversation**: a
  guessed parser produces a confident wrong join, and a wrong join is
  indistinguishable from the agent inventing a reference, which is the exact
  failure this app exists to catch.

## Reproduction

```sh
facilio connections execute helpdesk-call-logs.get-call-stats --params '{}'
# -> {"type":"CALL","total":18,"byType":{"WEB":1,"PHONE":17}}

facilio connections schemas helpdesk-call-logs.list-call-logs --with-output
# -> input_schema properties: page, pageSize, search.  No type. No channel.

facilio connections execute helpdesk-call-logs.get-call-log --params '{"callLogId":2404}'
# -> a WEB conversation, identical envelope to a PHONE one
```
