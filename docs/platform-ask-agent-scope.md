# Ask for the platform team — read the helpdesk agent's own prompt

**One request: let this app read the configuration of agent 6208 (org 2935),
the helpdesk voice agent.** Everything downstream is already built and running
against a pasted copy of the scope of work; only the fetch is missing.

---

## What we tried, and what happened

Verified by execution on 14 Aug 2026, not assumed:

| call | result |
|---|---|
| `helpdesk-agent-tools.get-agent-details` | **`Unknown action_slug`** — by schema lookup *and* by direct execute. The connection exposes exactly one action, `get-call-tool-calls`. |
| `facilio-ai-studio.v2-get-agent {"id": 6208}` | `{"error": "Agent not found", "id": 6208}` |
| `facilio-ai-studio.v2-get-agent {"id": 6404}` | **full config**, including a 1846-character `roleDescription` |
| `facilio-ai-studio.agent-list` | five agents, all ours. Description: *"List the user-facing agents **your team** has created (system agents are hidden)."* |
| `facilio-helpdesk-copilot.create-scope` | exists — *"Create a new **scope-of-work template** for the intake agent"* — but the connection has **no read**: its only other actions are `fetch-tickets` and `list-contacts`. |

The middle two rows are the control: **the capability works and returns exactly
the shape we want.** It is the agent that is invisible, not the action that is
missing.

This is not an id-space mistake. `v2-get-agent` takes `flowAgentId`, and for
every agent we can see `id == flowAgentId`, so 6208 is the right identifier in
the right space.

## The exact request

Either one unblocks us. **The second is smaller and gives more.**

1. **Make agent 6208 readable** to the credential behind these connections, so
   `v2-get-agent` / `v2-get-agent-by-link-name` returns it. If agent visibility
   is scoped by owning app or team, a connection scoped to the helpdesk voice
   app is the fix.
2. **Add a read for scope-of-work templates on `facilio-helpdesk-copilot`** — a
   `list-scopes` / `get-scopes` mirroring the existing `create-scope`, returning
   the same fields (`label`, `category`, `description`, `text`, `emoji`). These
   are more useful to us than the raw prompt: they are already per-situation and
   structured, which is the shape evals want.

**Likely the same root cause as the open `get-call-tool-calls` blocker** in
`docs/live-call-ingest.md`, where this same credential cannot read agent 6208's
call threads either. One visibility fix may close both.

## What is already built

Waiting on nothing but the fetch:

- `sow_documents` stores the scope of work with a content fingerprint;
  re-saving identical text is a no-op, changed text supersedes the previous
  version and keeps it, because a grade produced last week was produced against
  last week's scope.
- The `eval-writer` agent (client-side, `claude-opus-4-7`) turns the scope into
  testable criteria — clause ref, separate pass and fail definitions, layer,
  channel modality, and the SOW sentence each one came from, quoted verbatim.
- `generated_evals` persists them; the server re-validates every row and
  namespaces every id as `GEN-*` so a generated criterion can never collide with
  a hand-written `CR-*`.
- `gradingCriteria` merges seeded and generated criteria into the list the
  browser walks, so a rule added to the scope of work starts grading calls with
  no code change.

**The seam is one function**, `fetchSowFromAgent()` in `functions/governance.ts`.
It returns `null` today. When it returns `{title, body}`, drift against the
stored fingerprint is detected on every read of `currentSow`, and nothing else
in the pipeline changes.

## Reproduction

```sh
facilio connections execute helpdesk-agent-tools.get-agent-details --params '{"agentId":6208}'
# -> Unknown action_slug

facilio connections execute facilio-ai-studio.v2-get-agent --params '{"id":6208}'
# -> {"error":"Agent not found","id":6208}

facilio connections execute facilio-ai-studio.v2-get-agent --params '{"id":6404}'
# -> full config incl. roleDescription (1846 chars)

facilio connections --app facilio-helpdesk-copilot search "list scopes"
# -> create-scope, fetch-tickets, list-contacts.  No read.
```
