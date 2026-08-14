-- Hue — app database schema
--
-- SINGLE SOURCE OF TRUTH: the CMMS (Ocean's 3).
--
-- This database holds exactly two kinds of thing, and neither is a copy of
-- CMMS data:
--
--   1. TRANSCRIPTS — the voice agent's calls. The connections catalog has no
--      transcript-read action, so the text has to live somewhere. This is the
--      *claim*: what the agent said it did.
--
--   2. HUE'S OWN FINDINGS — criteria, deviations, corrections. These are
--      produced by Hue and exist nowhere else.
--
-- What is deliberately NOT here: service requests, work orders, sites,
-- categories, priorities, statuses, contacts. Every one of those is read live
-- from the CMMS at check time. There is no `sr_status` column to drift out of
-- date, because a check that reads a stale copy is not a ground-truth check.
--
-- The join between claim and truth is conversations.cmms_sr_id, resolved by
-- number/site/time against the live CMMS. Resolution is recorded, not the
-- record.
--
-- Migration rule (preview and production share one schema): ADDITIVE ONLY.
--
-- WHAT THIS FILE IS, AS OF 14 Aug 2026: intent, not the live shape. The app's
-- role cannot CREATE TABLE, so every table that actually exists came from
-- `facilio vibe db import` — all columns text/numeric and nullable, with NO
-- primary key, NO unique index and NO foreign key. The constraints written
-- below were never created. Nothing may rely on the database refusing a
-- duplicate; the code holds those invariants by deterministic ids and
-- select-then-write. Run `facilio vibe db describe <table>` for the truth.
--
-- Five tables exist: conversations, transcript_turns, deviations, corrections,
-- call_grades. eval_runs, notifications, criteria and the sow_* tables are
-- described here but have never been created.

-- ---------------------------------------------------------------
-- conversations — one call handled by the AI helpdesk agent
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  call_id         TEXT        NOT NULL UNIQUE,
  started_at      TIMESTAMPTZ NOT NULL,
  duration_sec    INTEGER,

  -- Caller identity as stated ON THE CALL. Not a CMMS contact record — this is
  -- what the caller said, which is itself evidence when it fails to match.
  caller_name     TEXT,
  caller_phone    TEXT,

  -- Site as the agent understood it, verbatim from the call. Used only as an
  -- input to the join; the authoritative site is whatever the matched CMMS
  -- record carries.
  site_hint       TEXT,

  -- 'completed' | 'in_progress' | 'dropped'
  status          TEXT        NOT NULL DEFAULT 'completed',
  sentiment       TEXT,

  -- ---- The claim -------------------------------------------------------
  -- What the agent asserted on the call. NEVER read as truth; it is the thing
  -- being checked. sr_claimed = the agent told the caller a request exists.
  sr_claimed      BOOLEAN     NOT NULL DEFAULT FALSE,
  -- The SR number the agent read back, if it read one back at all.
  sr_number_claimed TEXT,

  -- ---- The resolved join ----------------------------------------------
  -- The real CMMS service request id this call resolves to, or NULL when the
  -- join found nothing. NULL against sr_claimed = TRUE is the headline finding.
  cmms_sr_id      TEXT,
  -- How the join was made, so the UI can show its working and a weak match is
  -- never mistaken for a strong one.
  -- 'sr_number' | 'site_time' | 'none'
  join_method     TEXT        NOT NULL DEFAULT 'none',
  join_confidence REAL        NOT NULL DEFAULT 0,
  joined_at       TIMESTAMPTZ,

  eval_status     TEXT        NOT NULL DEFAULT 'not_evaluated',
  quality_score   INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- PROVENANCE WITHOUT A COLUMN: the app's role cannot ALTER this table (see the
-- note in functions/migrate.ts), so where a call came from is carried by its
-- id. Seeded demo calls are `C-<n>`; calls pulled from the helpdesk-call-logs
-- connection are `L-<callLogId>`. That prefix is also how the detail screen
-- knows a transcript can be re-read live, and `call_id` holds the connection's
-- own id for those rows.

CREATE INDEX IF NOT EXISTS conversations_started_idx ON conversations (started_at DESC);
CREATE INDEX IF NOT EXISTS conversations_eval_idx    ON conversations (eval_status);
CREATE INDEX IF NOT EXISTS conversations_srid_idx    ON conversations (cmms_sr_id);

-- ---------------------------------------------------------------
-- transcript_turns — the call itself, in order
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transcript_turns (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_index       INTEGER NOT NULL,
  -- 'caller' | 'agent' | 'system'
  performer        TEXT    NOT NULL,
  message          TEXT    NOT NULL DEFAULT '',
  at_offset        TEXT,

  -- Tool-call log. NULL tool_name => this turn is speech.
  -- This is still the claim side: it records what the agent's tooling reported,
  -- which is exactly what gets contradicted when the CMMS has no matching row.
  tool_name        TEXT,
  tool_status      TEXT,
  tool_args        TEXT,
  tool_result      TEXT,
  tool_record_id   TEXT,
  tool_error       TEXT,
  CONSTRAINT transcript_turn_uniq UNIQUE (conversation_id, turn_index)
);

CREATE INDEX IF NOT EXISTS transcript_turns_convo_idx
  ON transcript_turns (conversation_id, turn_index);

-- ---------------------------------------------------------------
-- sow_versions / sow_clauses — the contract Hue grades against
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sow_versions (
  id          TEXT PRIMARY KEY,
  version     TEXT        NOT NULL UNIQUE,
  body        TEXT        NOT NULL,
  is_current  BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sow_clauses (
  id              TEXT PRIMARY KEY,
  sow_version_id  TEXT    NOT NULL REFERENCES sow_versions(id) ON DELETE CASCADE,
  clause_ref      TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  edited          BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT sow_clauses_version_ref_uniq UNIQUE (sow_version_id, clause_ref)
);

-- ---------------------------------------------------------------
-- criteria — what each call is graded against
-- layer decides the engine: 'deterministic' never touches a model.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS criteria (
  id           TEXT PRIMARY KEY,
  clause_ref   TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  check_type   TEXT    NOT NULL,
  layer        TEXT    NOT NULL CHECK (layer IN ('deterministic', 'semantic')),
  source       TEXT    NOT NULL DEFAULT 'ai_drafted',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS criteria_active_idx ON criteria (active);

-- ---------------------------------------------------------------
-- deviations — Hue's findings. UNIQUE(conversation, criterion) makes a
-- re-grade update in place rather than pile up duplicates.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deviations (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  criterion_id     TEXT        NOT NULL,
  clause_ref       TEXT        NOT NULL DEFAULT '',
  summary          TEXT        NOT NULL,
  severity         TEXT        NOT NULL,
  root_cause       TEXT        NOT NULL DEFAULT 'unknown',
  status           TEXT        NOT NULL DEFAULT 'open',
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  detected_by      TEXT        NOT NULL DEFAULT 'deterministic'
                   CHECK (detected_by IN ('deterministic', 'semantic')),
  -- The CMMS record id this finding was checked against, so the evidence can
  -- be re-fetched live and audited. Not the record's contents.
  checked_sr_id    TEXT,
  evidence         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT deviations_convo_criterion_uniq UNIQUE (conversation_id, criterion_id)
);

CREATE INDEX IF NOT EXISTS deviations_status_idx   ON deviations (status, severity);
CREATE INDEX IF NOT EXISTS deviations_detected_idx ON deviations (detected_at DESC);

-- ---------------------------------------------------------------
-- corrections — the propose -> approve -> apply loop.
-- applied_write_key is claimed BEFORE any CMMS write, so approving twice
-- cannot create two service requests.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corrections (
  id                  TEXT PRIMARY KEY,
  deviation_id        TEXT        NOT NULL REFERENCES deviations(id) ON DELETE CASCADE,
  target              TEXT        NOT NULL,
  title               TEXT        NOT NULL DEFAULT '',
  rationale           TEXT        NOT NULL DEFAULT '',
  before_text         TEXT        NOT NULL DEFAULT '',
  after_text          TEXT        NOT NULL DEFAULT '',
  state               TEXT        NOT NULL DEFAULT 'proposed',
  recommended_action  TEXT,
  assignee            TEXT,
  -- The CMMS write this correction proposes, as returned by the proposer.
  cmms_action         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  proposed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at          TIMESTAMPTZ,
  resolved_at         TIMESTAMPTZ,
  applied_write_key   TEXT UNIQUE,
  applied_record_id   TEXT
);

CREATE INDEX IF NOT EXISTS corrections_state_idx     ON corrections (state);
CREATE INDEX IF NOT EXISTS corrections_deviation_idx ON corrections (deviation_id);

-- ---------------------------------------------------------------
-- eval_runs — audit trail for each grading pass
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eval_runs (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  outcome          TEXT        NOT NULL DEFAULT 'running',
  checks_run       INTEGER     NOT NULL DEFAULT 0,
  deviations_found INTEGER     NOT NULL DEFAULT 0,
  error_message    TEXT
);

CREATE INDEX IF NOT EXISTS eval_runs_convo_idx ON eval_runs (conversation_id, started_at DESC);

-- ---------------------------------------------------------------
-- notifications — outbound alerts. dedupe_key stops re-notifying.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT PRIMARY KEY,
  deviation_id  TEXT        REFERENCES deviations(id) ON DELETE CASCADE,
  channel       TEXT        NOT NULL DEFAULT 'teams',
  title         TEXT        NOT NULL,
  body          TEXT        NOT NULL DEFAULT '',
  state         TEXT        NOT NULL DEFAULT 'pending',
  dedupe_key    TEXT        NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS notifications_state_idx ON notifications (state);

-- ---------------------------------------------------------------
-- call_grades — the durable record of one call's AI grading
--
-- Created by `facilio vibe db import` (db/seed/call_grades.csv), not by the
-- DDL above: the app's role cannot CREATE TABLE, but the platform's import
-- path can. Columns are therefore inferred and every one is nullable —
-- response_quality and schema_version came out numeric because the sentinel
-- row held digits.
--
-- SINGLE SOURCE OF TRUTH for a call's grade.
--
--   * The call-grade write path writes THIS table and, in the same step, the
--     denormalised conversations.quality_score. Nothing else may ever write
--     quality_score — one number with two homes drifts the moment a second
--     writer appears.
--   * applicable='false' is AUTHORITATIVE. A response_quality of 0 on such a
--     row is the absence of a score, never a score of zero, and no reader may
--     treat it as one.
--   * criteria_* are comma-separated criterion ids (CR-LOG-01 shaped, no
--     embedded delimiters). criteria_unavailable keeps "the judge never
--     answered" distinct from "the criterion passed" — the same rule that
--     holds everywhere else in this app.
--   * claimed_at / claimed_by carry the multi-user claim: a fire claims a row
--     before grading it, so two users cannot grade the same call, and a claim
--     left behind by a dead run is reaped by age (10 min). Claimed by one
--     atomic UPDATE ... FOR UPDATE SKIP LOCKED ... RETURNING, shared by the
--     scheduled job and the reload nudge. See docs/reload-nudge.md.
--   * The claim columns and the grade columns have SEPARATE writers and must
--     stay that way: a claim never writes a grade column, a grade never clears
--     a claim. A row whose graded_at is empty is a CLAIM, not a grade — no
--     reader may treat it as one.
--
-- There is no DROP and no ALTER on this path. A further column means a further
-- table, which is why schema_version is here.
-- ---------------------------------------------------------------

-- ---------------------------------------------------------------
-- conversation_channels — how each conversation reached the agent
--
-- Created by `facilio vibe db import` (db/seed/conversation_channels.csv),
-- like call_grades: the app's role cannot CREATE TABLE, and conversations
-- itself cannot be ALTERed to carry a channel column.
--
-- The connection returns callType and channelId on every row and this app used
-- to discard both, so every conversation became "a call" — which is how a WEB
-- conversation's email address ended up in caller_phone, under a heading that
-- said phone number.
--
--   * SINGLE WRITER: callingest.writeConversationChannel, called only from
--     upsertLiveCall. governance.ts reads this table and never writes it.
--   * modality decides what may be CHECKED, and is the only thing the grading
--     path reads. 'voice' = PHONE and WEB (WEB is the browser web-call widget,
--     speech through a browser, not a text chat). 'text' = WHATSAPP, CHAT,
--     EMAIL. An UNRECOGNISED channel is text, never voice — voice is the
--     permissive case and must never be the default for something unknown.
--   * A conversation with NO row here is voice: everything that predates
--     channel tagging is a call, and the seeded demo calls always were.
--   * identity_kind says what conversations.caller_phone actually holds on
--     this channel — 'phone', 'email' or 'handle'. The upstream field is
--     polymorphic and the column name is a historical accident.
-- ---------------------------------------------------------------
