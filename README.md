# Hue
Governance & observability layer for the AI Helpdesk voice agent — "Langfuse for clients".
Reads every call, joins it to the actual CMMS record, scores it against the SOW, flags
deviations, and runs a propose → approve → apply correction loop. Built as a Facilio Vibe app.

## Structure
- src/       frontend (Pooja)
- functions/ Vibe server functions (Rohit)
- db/        schema + seed (Rohit)
- evals/     judge prompts, rubric, criteria (Swami)
- demo/      (empty — the seeded demo calls were removed; see below)
- shared/    contract.ts (FROZEN shared types)

## Data
Every conversation in the app is a real call, pulled from the `helpdesk-call-logs`
connection and joined to its real CMMS service request. There is no demo data:
the ten seeded calls and their invented callers were deleted, and
`demo/transcripts.json` and `demo/seed.mjs` were removed with them (both remain
in git history if they are ever wanted back). `db/seed/*.csv` are NOT demo data
— each holds a single `__seed__` sentinel row that the tables were created from
by CSV import, and every query excludes it.

See `docs/live-call-ingest.md` for how calls arrive and how they are graded.
