# Hue
Governance & observability layer for the AI Helpdesk voice agent — "Langfuse for clients".
Reads every call, joins it to the actual CMMS record, scores it against the SOW, flags
deviations, and runs a propose → approve → apply correction loop. Built as a Facilio Vibe app.

## Structure
- src/       frontend (Pooja)
- functions/ Vibe server functions (Rohit)
- db/        schema + seed (Rohit)
- evals/     judge prompts, rubric, criteria (Swami)
- demo/      seed data, demo script (Swami)
- shared/    contract.ts (FROZEN shared types)
