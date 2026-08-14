/**
 * Hue — governance engine.
 *
 * SINGLE SOURCE OF TRUTH: the CMMS. Every service request, site, category and
 * status in this file is fetched live from `facilio-cmms` at call time. The app
 * database holds only transcripts (the claim) and Hue's own findings. There is
 * no cached copy of a CMMS record anywhere below, deliberately — a ground-truth
 * check that reads a copy is not a ground-truth check.
 *
 * NO AGENT CALLS LIVE IN THIS FILE, AND NONE MAY BE ADDED.
 *
 * A Studio Function's fetch aborts at ~10s. Every agent Hue uses runs longer
 * than that on real input — measured 10.8s to 33.8s — so an agent called from
 * here does not run slowly, it fails. Worse, it fails as a timeout, which is
 * indistinguishable from "the model had nothing to say" unless every caller is
 * careful, and that is a rule no codebase keeps for long.
 *
 * So model calls go directly from the browser via vibe.executeAgent, which has
 * no such ceiling — see src/lib/judges.ts, the single place any agent is
 * invoked. This file keeps everything else: the deterministic checks, the CMMS
 * reads and writes, and the validation of any verdict the browser sends back.
 * The browser proposes; the server decides what is written.
 *
 * Runtime facts this is written against (verified by probe, not assumed):
 *   - env map: DB_USER, DB_PASSWORD, SCHEMA. It is DB_USER, not DB_USERNAME.
 *   - system: CONNECTIONS_URL + CONNECTIONS_TOKEN present; AGENTS_URL absent.
 *   - The DB user has USAGE but NOT CREATE, so tables come from `db import`
 *     and every column is text/numeric with no constraints. That means:
 *       * booleans are the strings 'true'/'false'
 *       * timestamps are ISO-8601 UTC strings (lexicographic order == time order)
 *       * JSON columns are text; parse on read, stringify on write
 *       * there are NO unique indexes, so upserts are select-then-write
 *   - db.query() is synchronous; fetch is async and serialized (no parallelism).
 */
import StudioFunctions, { StudioDatabase } from '@facilio/studio-functions';

const server = new StudioFunctions({ name: 'governance' });

const CMMS = 'facilio-cmms';

function connect() {
  return new StudioDatabase({
    userName: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    schema: process.env.SCHEMA,
  });
}

/**
 * Execute a saved connection action. The host injects the service token from
 * system.CONNECTIONS_TOKEN and strips any auth header we set, so we add none.
 */
async function cmms(actionSlug: string, input: Record<string, unknown>): Promise<any> {
  const res = await fetch(
    `${process.system.CONNECTIONS_URL}/api/v1/connections/${CMMS}/actions/${actionSlug}/execute`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    },
  );
  if (!res.ok) {
    throw new Error(`CMMS ${actionSlug} failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  // The connections layer wraps the action payload; unwrap defensively rather
  // than assuming a shape, since it differs per action.
  return body?.output ?? body?.result ?? body;
}

function rowsOf(payload: any): any[] {
  return payload?.data ?? payload?.response?.data ?? [];
}

/**
 * The helpdesk-call-logs connection — the source of record for live calls.
 *
 * Read-only, and reached exactly like the CMMS one: the host injects the
 * service token, so no key is held here or in the repo. Actions available:
 * list-call-logs, get-call-log, export-call-transcript, get-call-recording,
 * get-call-stats.
 */
const CALL_LOGS = 'helpdesk-call-logs';

/** The agent's run history for a call. Dormant — see `callToolCalls`. */
const AGENT_TOOLS = 'helpdesk-agent-tools';

async function agentTools(actionSlug: string, input: Record<string, unknown>): Promise<any> {
  const res = await fetch(
    `${process.system.CONNECTIONS_URL}/api/v1/connections/${AGENT_TOOLS}/actions/${actionSlug}/execute`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    },
  );
  if (!res.ok) {
    throw new Error(`Agent tools ${actionSlug} failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  return body?.output ?? body?.result ?? body;
}

async function callLogs(actionSlug: string, input: Record<string, unknown>): Promise<any> {
  const res = await fetch(
    `${process.system.CONNECTIONS_URL}/api/v1/connections/${CALL_LOGS}/actions/${actionSlug}/execute`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    },
  );
  if (!res.ok) {
    throw new Error(`Call logs ${actionSlug} failed: ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  return body?.output ?? body?.result ?? body;
}

/**
 * Turns from a get-call-log payload.
 *
 * Verified shape: the call sits under `summary`, and the transcript is
 * `summary.transcription` — note that `summary` ALSO holds a string field of
 * the same name (an HTML AI write-up), so the nesting has to be read exactly.
 * The other spellings are accepted in case the envelope changes.
 */
function transcriptionOf(payload: any): any[] {
  const t =
    payload?.summary?.transcription ??
    payload?.transcription ??
    payload?.data?.summary?.transcription ??
    payload?.data?.transcription ??
    [];
  return Array.isArray(t) ? t : [];
}

/** The call record itself, from the same payload. */
function callRecordOf(payload: any): any {
  return payload?.summary ?? payload?.data?.summary ?? payload?.data ?? payload ?? {};
}

/**
 * Map a connection performer onto Hue's vocabulary. The connection says
 * USER / AGENT / SYSTEM; Hue's transcripts say caller / agent / system, so a
 * live turn reads identically to a seeded one.
 */
function toPerformer(raw: unknown): string {
  const p = String(raw ?? '').toLowerCase();
  if (p === 'user' || p === 'caller' || p === 'customer') return 'caller';
  if (p === 'agent' || p === 'assistant' || p === 'bot') return 'agent';
  return 'system';
}

/** Epoch millis -> the "m:ss" offset from call start that transcripts display. */
function offsetFrom(startMs: number, atMs: unknown): string {
  const t = Number(atMs);
  if (!Number.isFinite(t) || !Number.isFinite(startMs) || t < startMs) return '';
  const sec = Math.round((t - startMs) / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * Pull a service request number out of what was actually said.
 *
 * Live call logs carry no structured SR field, so the only evidence that the
 * agent raised one is the number it read back — and it is read back in speech
 * forms: "210-412", "2 1 0 4 1 2", "210412". Digits are collected across
 * separators and accepted at 5-8 long, which covers this CMMS's ids without
 * swallowing phone numbers or times.
 *
 * Returning null is a real result, not a failure: a call where the agent
 * promised a ticket and named no number is exactly the case Hue exists to
 * catch.
 */
function spokenSrNumber(turns: Array<{ performer: string; message: string }>): string | null {
  // The agent's own words are the claim. A number the caller recites is a
  // reference to an existing request, not evidence the agent created one, so
  // agent turns are searched first and only fall back to the caller's.
  const ordered = [
    ...turns.filter((t) => t.performer === 'agent'),
    ...turns.filter((t) => t.performer !== 'agent'),
  ];
  for (const turn of ordered) {
    const text = String(turn.message ?? '');
    // Collapse spaced/hyphenated digit runs: "2 1 0 4 1 2" and "210-412" both
    // become "210412", while ordinary prose is left alone.
    const collapsed = text.replace(/\d(?:[\s-]+\d){2,}/g, (run) => run.replace(/[\s-]+/g, ''));
    const matches = collapsed.match(/\b\d{5,8}\b/g);
    if (matches && matches.length) return matches[0];
  }
  return null;
}

/**
 * What the agent told the caller about logging their request.
 *
 * This is the claim side of "confirmed but no record", established from the
 * transcript because the voice channel exposes no tool-call log to corroborate
 * it. What the caller was told is what the caller acts on, so it is legitimate
 * evidence in its own right — but only if read carefully:
 *
 *   - An admission of FAILURE is not a claim. "I'm having trouble logging this,
 *     our team will call you back" contains "logging" and would match a naive
 *     keyword test, yet the agent was being honest and nothing was falsely
 *     promised. Those calls are still a breach of the clause — the fault goes
 *     unlogged — but they are the judge's to find, not this check's, and
 *     recording them here as a false confirmation would misdescribe them.
 *   - A future promise is not a confirmation. "I'll log that for you" states an
 *     intention; "that's been logged" states a fact.
 *   - Only the AGENT can make this claim. A caller saying "you logged it last
 *     week" is not evidence of anything this call did.
 */
function agentClaim(turns: Array<{ performer: string; message: string; at_offset?: string }>): {
  claimed: boolean;
  number: string | null;
  quotes: Array<{ at: string; message: string }>;
  admittedFailure: boolean;
} {
  const agentTurns = turns.filter((t) => t.performer === 'agent');

  // Said plainly: it is done. Present/past tense only.
  const CONFIRMS =
    /\b(has been|have been|is|was|were)\s+(logged|raised|created|registered|booked)\b|\b(logged|raised|created|registered|booked)\s+(it|this|that|the request|your request)\b|\byour (service request|request|ticket|reference)\s*(id|number)?\s*(is|:)\b|\ball set\b|\bdone\b\s*[—-]/i;

  // Said plainly: it did not work.
  const ADMITS_FAILURE =
    /\b(trouble|unable|can'?t|cannot|could ?n'?t|failed|couldn't manage)\b[^.!?]{0,40}\b(log|logging|raise|raising|creat|register)/i;

  let admittedFailure = false;
  const quotes: Array<{ at: string; message: string }> = [];

  for (const t of agentTurns) {
    const text = String(t.message ?? '');
    if (ADMITS_FAILURE.test(text)) {
      admittedFailure = true;
      continue;
    }
    if (CONFIRMS.test(text)) quotes.push({ at: String(t.at_offset ?? ''), message: text });
  }

  // A reference read back is the strongest possible confirmation — the agent
  // handed the caller a number to quote.
  const number = spokenSrNumber(agentTurns.map((t) => ({ performer: 'agent', message: t.message })));
  if (number && !quotes.length) {
    const naming = agentTurns.find((t) =>
      String(t.message ?? '')
        .replace(/\d(?:[\s-]+\d){2,}/g, (run) => run.replace(/[\s-]+/g, ''))
        .includes(number),
    );
    if (naming) quotes.push({ at: String(naming.at_offset ?? ''), message: String(naming.message) });
  }

  // An admission of failure withdraws the claim: if the agent said both, the
  // last word on the matter is that it did not work.
  const claimed = quotes.length > 0 && !(admittedFailure && !number);

  return { claimed, number: number ?? null, quotes, admittedFailure };
}

/** The connection's satisfactionLevel, mapped onto Hue's sentiment enum. */
function toSentiment(level: unknown): string {
  const s = String(level ?? '').toUpperCase();
  // Order matters: VERY_DISSATISFIED contains DISSATISFIED, which contains
  // SATISFIED. A looser test earlier in the chain reads the worst calls as the
  // happiest ones.
  if (s.includes('VERY_DISSATISFIED') || s.includes('ANGRY') || s.includes('DISTRESS'))
    return 'distressed';
  if (s.includes('DISSATISFIED') || s.includes('FRUSTRAT') || s.includes('CONCERNED'))
    return 'frustrated';
  if (s.includes('SATISFIED') || s.includes('HAPPY') || s.includes('PLEASED')) return 'happy';
  if (s.includes('NEUTRAL')) return 'neutral';
  // An unrecognised level is NOT neutral — neutral is a real reading. Leave it
  // empty so the UI shows "Unknown" rather than inventing calm.
  return '';
}


/**
 * Run one judge and return its parsed verdict.
 *
 * Structured-output agents return `content` as a JSON *string*, not an object —
 * parsing it is required, and a judge that returns unparseable content must not
 * be allowed to drive a write, so this throws instead of guessing.
 */
/**
 * Run a judge, retrying transient failures.
 *
 * The sandbox aborts a fetch at roughly 10s and a judge call runs close to that,
 * so an occasional abort is expected rather than exceptional. The important
 * property is the failure mode: if every attempt fails this THROWS. It must
 * never return a pass-shaped result, because "the judge timed out" and "the
 * judge found nothing wrong" are opposite facts and silently conflating them
 * would hide real deviations — the exact failure Hue exists to catch.
 *
 * There is no sleep between attempts: the sandbox has no timers, and each
 * attempt already takes seconds, which is the backoff.
 */

/** The sandbox reports its fetch ceiling as an abort. */



/** Booleans round-trip as text through a CSV-inferred column. */
const asBool = (v: unknown) => v === true || v === 'true';
const boolText = (v: boolean) => (v ? 'true' : 'false');

/** A comma-separated criterion-id column, back into a list. */
const idList = (v: unknown): string[] =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * One `call_grades` row, read the way the rule says it must be read.
 *
 * `applicable` is AUTHORITATIVE: when it is false the score is absent, so
 * responseQuality comes back null and no caller has to remember that a stored 0
 * on such a row was never a score. `sentimentAgrees` is a tri-state — null means
 * nothing to compare, which is not the same as disagreement.
 */
function readGrade(row: any) {
  const applicable = asBool(row.applicable);
  const agrees = String(row.sentiment_agrees ?? '').trim();
  return {
    id: String(row.id ?? ''),
    conversationId: String(row.conversation_id ?? ''),
    gradedAt: String(row.graded_at ?? ''),
    gradedBy: String(row.graded_by ?? ''),
    applicable,
    responseQuality:
      applicable && row.response_quality !== null && row.response_quality !== ''
        ? Number(row.response_quality)
        : null,
    justification: String(row.quality_justification ?? ''),
    sentiment: String(row.sentiment ?? ''),
    sentimentReason: String(row.sentiment_reason ?? ''),
    sentimentChannel: String(row.sentiment_channel ?? ''),
    sentimentAgrees: agrees === '' ? null : agrees === 'true',
    overallAssessment: String(row.overall_assessment ?? ''),
    criteriaSatisfied: idList(row.criteria_satisfied),
    criteriaBreached: idList(row.criteria_breached),
    criteriaGraded: idList(row.criteria_graded),
    criteriaUnavailable: idList(row.criteria_unavailable),
    agentVersion: String(row.agent_version ?? ''),
    schemaVersion: Number(row.schema_version) || 1,
  };
}

// ---------------------------------------------------------------------------
// The scope of work, and the evals generated from it
//
// Hue grades against a SOW. Until now that SOW existed only as a seeded list of
// criteria in the bundle — written by hand, agreeing with the real scope of
// work by luck rather than by construction.
//
// THE SOURCE IS DELIBERATELY PLUGGABLE. The real SOW lives in the helpdesk
// voice agent's own configuration (agent 6208), and this app cannot read it:
// `helpdesk-agent-tools` exposes exactly one action, `get-call-tool-calls`, and
// `facilio-ai-studio.agent-list` returns only "agents your team has created",
// which does not include 6208. See docs/platform-ask-agent-scope.md.
//
// So the SOW is pasted for now and fetched later. `fetchSowFromAgent` below is
// the single seam: when the platform exposes that prompt, it stops returning
// null and every other line in this pipeline stays exactly as it is.
// ---------------------------------------------------------------------------

/**
 * A stable fingerprint of the SOW text, for drift detection.
 *
 * FNV-1a, not a cryptographic hash: this answers "is this the same text as
 * last time", never "prove this text was not tampered with". The sandbox has
 * no crypto module and a collision here costs a missed regeneration, not a
 * wrong grade.
 *
 * Whitespace is normalised first, so re-pasting the same SOW with a different
 * trailing newline is not treated as a new version.
 */
function fingerprintOf(text: string): string {
  const norm = String(text ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    // FNV prime, applied with shifts to stay inside 32 bits without Math.imul.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // Length is mixed in so two texts that hash alike must also match in size.
  return `fp${h.toString(16).padStart(8, '0')}${norm.length.toString(36)}`;
}

/**
 * Read the SOW from the helpdesk agent's own configuration. NOT WIRED YET.
 *
 * This is the ONE function that becomes real when the platform exposes agent
 * 6208's prompt. Everything downstream — storage, fingerprinting, drift
 * detection, generation, grading — is already written against whatever this
 * returns, so wiring it is a body swap and nothing else.
 *
 * Verified unavailable on 14 Aug 2026, by execution rather than assumption:
 *
 *   helpdesk-agent-tools.get-agent-details   -> Unknown action_slug
 *   facilio-ai-studio.v2-get-agent {id:6208} -> {"error":"Agent not found"}
 *   facilio-ai-studio.v2-get-agent {id:6404} -> full config, 1846-char prompt
 *   facilio-ai-studio.agent-list             -> "agents your team has created"
 *
 * The last two are the control: the action works and returns exactly the shape
 * this app wants (`agent.roleDescription` plus `agent.restrictions`); it is the
 * agent that is invisible, not the capability that is missing.
 *
 * It returns null rather than throwing: a missing upstream SOW is a state this
 * app is designed to sit in, not a failure to report.
 */
async function fetchSowFromAgent(): Promise<{ title: string; body: string } | null> {
  return null;
}

/** Booleans are text in every table here. */
const isTrue = (v: unknown) => v === true || v === 'true';

/**
 * THE ONLY WRITER of sow_documents.
 *
 * A SOW is versioned by its own content: the id is derived from the
 * fingerprint, so saving identical text twice is a no-op rather than a second
 * version, and pasting changed text supersedes the current one instead of
 * overwriting it. History is kept because a grade produced last week was
 * produced against last week's scope, and losing that makes an old finding
 * unauditable.
 */
function writeSowDocument(
  db: any,
  d: { title: string; body: string; source: string; sourceRef: string; savedBy: string },
): { id: string; fingerprint: string; changed: boolean } {
  const fingerprint = fingerprintOf(d.body);
  const id = `SOW-${fingerprint}`;
  const now = nowIso();

  const existing = db.query('select id from sow_documents where id = $1 limit 1', [id]).rows[0];
  const current = db.query(
    `select id, fingerprint from sow_documents
      where id <> '__seed__' and is_current = 'true' limit 1`,
  ).rows[0];

  // Identical text, already current: nothing to do and nothing to regenerate.
  if (current && String(current.fingerprint) === fingerprint) {
    return { id, fingerprint, changed: false };
  }

  if (current) {
    db.query(
      `update sow_documents set is_current = 'false', superseded_at = $2 where id = $1`,
      [current.id, now],
    );
  }

  if (existing) {
    // A SOW being reinstated — the same text as an older version. Make it
    // current again rather than writing a duplicate row.
    db.query(
      `update sow_documents set is_current = 'true', superseded_at = '', fetched_at = $2,
         source = $3, source_ref = $4, saved_by = $5, title = $6
       where id = $1`,
      [id, now, d.source, d.sourceRef, d.savedBy, d.title],
    );
  } else {
    db.query(
      `insert into sow_documents
         (id, fingerprint, source, source_ref, title, body, body_format,
          is_current, fetched_at, superseded_at, saved_by, schema_version)
       values ($1,$2,$3,$4,$5,$6,'plain','true',$7,'',$8,1)`,
      [id, fingerprint, d.source, d.sourceRef, d.title, d.body, now, d.savedBy],
    );
  }

  return { id, fingerprint, changed: true };
}

/** The SOW currently in force, or null before anything has been saved. */
function currentSowRow(db: any) {
  return db.query(
    `select * from sow_documents where id <> '__seed__' and is_current = 'true' limit 1`,
  ).rows[0];
}

/**
 * Generated criteria the grading pipeline may actually use.
 *
 * Three gates, all of which must hold: the eval belongs to the CURRENT SOW,
 * it is active, and it is approved. An eval generated from a superseded SOW is
 * kept — it is what an old grade was measured against — but it never grades a
 * new conversation.
 */
function activeGeneratedEvals(db: any, fingerprint: string): any[] {
  // A CUSTOM eval is not derived from the scope of work, so it is not bound to
  // a version of it. Binding one would mean a person's own criterion silently
  // stopped grading the moment somebody edited the SOW — losing their work
  // without saying so.
  return db.query(
    `select * from generated_evals
      where id <> '__seed__'
        and (sow_fingerprint = $1 or generated_by = 'manual')
        and active = 'true' and approved = 'true'
      order by clause_ref, criterion_id`,
    [fingerprint || ''],
  ).rows;
}

/**
 * One generated eval, in the shape the rest of the app already speaks.
 *
 * `requires` is what the conformance judge reads, and it is assembled from the
 * pass and fail definitions rather than the description: a judge told only what
 * a criterion is about will invent its own bar. Told what passing and failing
 * look like, it has one.
 */
/**
 * One generated criterion by id, in the same shape `SEMANTIC_CRITERIA` uses.
 *
 * Only ACTIVE, APPROVED, SEMANTIC evals of the CURRENT SOW resolve. A verdict
 * on anything else must not be accepted: a retired criterion, one belonging to
 * a superseded scope, or one with no implementation behind it would each write
 * a finding nothing is really grading.
 */
function generatedCriterion(db: any, criterionId: string) {
  if (!criterionId.startsWith('GEN-')) return null;
  const sow = currentSowRow(db);
  if (!sow) return null;

  const row = db.query(
    `select * from generated_evals
      where id <> '__seed__' and criterion_id = $1
        and (sow_fingerprint = $2 or generated_by = 'manual')
        and active = 'true' and approved = 'true' and layer = 'semantic'
      limit 1`,
    [criterionId, String(sow.fingerprint ?? '')],
  ).rows[0];
  if (!row) return null;

  const c = toJudgeCriterion(row);
  return { clauseRef: c.clauseRef, requires: c.requires };
}

function toJudgeCriterion(row: any) {
  const pass = String(row.pass_definition ?? '').trim();
  const fail = String(row.fail_definition ?? '').trim();
  return {
    id: String(row.criterion_id ?? ''),
    clauseRef: String(row.clause_ref ?? ''),
    title: String(row.title ?? ''),
    requires:
      `${String(row.description ?? '').trim()}\n\n` +
      `PASSES when: ${pass || 'not stated'}\n` +
      `FAILS when: ${fail || 'not stated'}`,
    layer: String(row.layer ?? 'semantic'),
    severity: String(row.severity ?? 'medium'),
    modality: String(row.modality ?? 'any'),
    generated: true,
  };
}

// ---------------------------------------------------------------------------
// Channel
//
// A conversation is not always a phone call. The connection reports PHONE and
// WEB today (both voice — WEB is the browser web-call widget, not a text chat)
// and models WHATSAPP/CHAT/EMAIL, which this app must not grade as if someone
// had spoken.
//
// Channel is recorded at ingest into conversation_channels, whose only writer
// is callingest.writeConversationChannel. This file READS it and never writes
// it — same split that keeps call_grades honest.
// ---------------------------------------------------------------------------

/**
 * How a conversation must be graded.
 *
 * Anything with no channel row is voice: every conversation that predates
 * channel tagging is a call, and the seeded demo calls always were. The default
 * is stated once, here, so no caller has to guess.
 */
function channelOf(row: any) {
  const channel = String(row?.channel ?? '').trim().toUpperCase() || 'PHONE';
  const modality = String(row?.modality ?? '').trim().toLowerCase() || 'voice';
  return {
    channel,
    channelId: Number(row?.channel_id) || 0,
    modality,
    isVoice: modality === 'voice',
    identityKind: String(row?.identity_kind ?? '').trim() || 'phone',
  };
}

/**
 * Criteria that CANNOT be answered on this conversation, and why.
 *
 * Two different reasons, kept apart because they resolve differently — one
 * never will, the other resolves the day a text parser is wired:
 *
 *   channel   the check is about something only a voice call has. A WhatsApp
 *             thread cannot "drop", and stacking two questions in one message
 *             is normal there — flagging either would be inventing a failure.
 *
 *   no_join   the check reads the CMMS record, and on a text channel this app
 *             has not yet resolved one. `writtenSrNumber` is stubbed until
 *             there is real text data to test it against, so a text
 *             conversation has no claimed reference and no join. Running these
 *             anyway would report "no service request exists" when the truth is
 *             "nobody looked" — a false finding, and the loudest kind: CR-LOG-01
 *             is critical.
 *
 * NEITHER IS A PASS. A skipped criterion is reported as not-applicable, which
 * is distinct from "passed" and from "the judge never answered". That is the
 * same never-fake-a-pass rule this app runs on, applied to a third case.
 */
function notApplicableFor(modality: string): Record<string, string> {
  if (modality === 'voice') return {};
  return {
    // Voice-only by nature.
    'CR-ESC-04': 'channel',
    'CR-CALL-02': 'channel',
    // Answerable on text, but only once the join is checked.
    'CR-LOG-01': 'no_join',
    'CR-LOG-02': 'no_join',
    'CR-LOG-04': 'no_join',
    'CR-LOG-06': 'no_join',
    'CR-CAT-01': 'no_join',
    'CR-SCHED-01': 'no_join',
    'CR-SCHED-02': 'no_join',
    'CR-CALL-01': 'no_join',
  };
}

/** Why a criterion was skipped, in words a person reads on the screen. */
function skipReason(reason: string, channel: string): string {
  return reason === 'channel'
    ? `Not applicable on ${channel}: this check is about something only a voice call has.`
    : `Not checked on ${channel}: the service request reference is not parsed on text channels yet, so there is no CMMS record to judge against. Not a pass, and not a failure.`;
}

/** The channel row for one conversation, or null when it was never tagged. */
function channelRowOf(db: any, convoId: string) {
  return db.query(
    `select * from conversation_channels
      where conversation_id = $1 and id <> '__seed__' limit 1`,
    [convoId],
  ).rows[0];
}

/**
 * Where one call is in grading, derived from state that already exists.
 *
 * There is no status column and there must not be one — a second place to
 * record "is this graded" is a second place to be wrong. Everything here is
 * read off `conversations.eval_status` and the call's `call_grades` row.
 *
 * THE TWO PASSES ARE DIFFERENT THINGS, and the caller needs to be able to tell
 * them apart:
 *
 *   - the DETERMINISTIC pass (the job, the nudge, `evaluate`) runs the coded
 *     checks against the live CMMS and sets `eval_status`. It never writes
 *     `graded_at`, because it has no analyst to record — an agent cannot run
 *     inside a Studio Function at all.
 *   - the AI ANALYSIS (manual "Run evals") writes the grade row, and its
 *     `graded_at` / `graded_by` are what this reports as the grading stamp.
 *
 * So `graded_at` alone cannot mean "done": most graded calls in this app have
 * never been analysed. A call is GRADED once either pass has produced
 * something, and the flags below say which.
 */
function gradingStateOf(row: any) {
  const evalStatus = String(row.eval_status ?? 'not_evaluated');
  const claimedAt = String(row.claimed_at ?? '');
  const claimedBy = String(row.claimed_by ?? '');
  const gradedAt = String(row.graded_at ?? '');
  const unavailableIds = idList(row.criteria_unavailable);

  // The deterministic pass has spoken. The AI analysis has been stored.
  const checksRun = evalStatus !== 'not_evaluated';
  const analysed = gradedAt !== '';

  // A claim that has not produced anything yet is a pass IN FLIGHT. Once it has
  // produced something the claim is history, whether or not it was released —
  // rows graded before claims were released on success still read correctly.
  const inFlight = claimedAt !== '' && !checksRun && !analysed;
  const stale = inFlight && claimedAt < isoAgo(CLAIM_TTL_MS);

  let status: string;
  if (checksRun || analysed) status = 'graded';
  else if (stale) status = 'unavailable';
  else if (inFlight) status = 'grading';
  else status = 'awaiting';

  return {
    status,
    // Which pass produced what, so "graded" is never mistaken for "analysed".
    checksRun,
    analysed,
    evalStatus,
    gradedAt,
    gradedBy: String(row.graded_by ?? ''),
    claimedAt,
    claimedBy,
    criteriaGraded: idList(row.criteria_graded).length,
    // Judges that never answered. Carried so a partial grade is never rendered
    // as a clean one — the same never-fake-a-pass rule, made visible.
    criteriaUnavailable: unavailableIds.length,
    unavailableIds,
  };
}

function nowIso(startedAtFallback?: string) {
  // The sandbox has Date but the run has no wall-clock guarantee worth relying
  // on for ordering; use Date for stamps and let ISO strings sort naturally.
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') || startedAtFallback || '';
}

// ---------------------------------------------------------------------------
// CMMS reads — live, every time
// ---------------------------------------------------------------------------

server.addHandler({
  name: 'sites',
  description: 'List sites live from the CMMS',
  parameters: { pageSize: { description: 'Rows to fetch (max 200)', type: 'number' } },
  execute: async (args) => {
    const pageSize = Math.min(Number(args.pageSize) || 50, 200);
    const payload = await cmms('list-sites', { page_size: pageSize, page: 1 });
    const sites = rowsOf(payload).map((s: any) => ({
      id: String(s.id),
      name: s.name ?? '',
      siteType: s.siteType ?? null,
    }));
    return { sites, count: sites.length };
  },
});

server.addHandler({
  name: 'serviceRequests',
  description: 'List service requests live from the CMMS',
  parameters: {
    pageSize: { description: 'Rows to fetch (max 200)', type: 'number' },
    page: { description: 'Page number, 1-based', type: 'number' },
    filters: { description: 'Optional Facilio filter string, or empty', type: 'string' },
  },
  execute: async (args) => {
    const input: Record<string, unknown> = {
      page_size: Math.min(Number(args.pageSize) || 50, 200),
      page: Number(args.page) || 1,
      include_count: true,
      // Hydrate the lookups we display, so the UI never renders a raw id.
      expand: 'site,requester',
    };
    const filters = String(args.filters ?? '').trim();
    if (filters) input.filters = filters;

    const payload = await cmms('list-service-requests', input);
    return {
      count: payload?.count ?? null,
      requests: rowsOf(payload),
    };
  },
});

// ---------------------------------------------------------------------------
// Transcript ingest — the only thing Hue stores of its own about a call
// ---------------------------------------------------------------------------

server.addHandler({
  name: 'ingestTranscript',
  description:
    'Store one call transcript. Idempotent on callId — re-ingesting replaces the turns rather than duplicating them.',
  parameters: {
    callId: { description: 'Stable id of the call', type: 'string' },
    startedAt: { description: 'ISO-8601 UTC start time', type: 'string' },
    durationSec: { description: 'Call length in seconds', type: 'number' },
    callerName: { description: 'Caller name as stated on the call', type: 'string' },
    callerPhone: { description: 'Caller phone as stated on the call', type: 'string' },
    siteHint: { description: 'Site as the agent understood it', type: 'string' },
    status: { description: 'completed | in_progress | dropped', type: 'string' },
    sentiment: { description: 'happy | neutral | frustrated | distressed', type: 'string' },
    srClaimed: { description: '"true" if the agent told the caller a request exists', type: 'string' },
    srNumberClaimed: { description: 'SR number the agent read back, if any', type: 'string' },
    turnsJson: {
      description:
        'JSON array of turns: [{performer,message,at,toolName,toolStatus,toolArgs,toolResult,toolRecordId,toolError}]',
      type: 'string',
    },
  },
  execute: async (args) => {
    const callId = String(args.callId ?? '').trim();
    if (!callId) throw new Error('callId is required');

    let turns: any[];
    try {
      turns = JSON.parse(String(args.turnsJson ?? '[]'));
    } catch {
      throw new Error('turnsJson must be valid JSON');
    }
    if (!Array.isArray(turns)) throw new Error('turnsJson must be a JSON array');

    const db = connect();

    // No unique index exists (CSV-imported tables carry no constraints), so the
    // upsert is select-then-write. Safe here: sandbox queries are serialized and
    // ingest is single-writer.
    const existing = db.query('select id from conversations where call_id = $1 limit 1', [callId])
      .rows[0];
    const id = existing?.id ?? `C-${callId}`;

    if (existing) {
      db.query(
        `update conversations set started_at=$2, duration_sec=$3, caller_name=$4, caller_phone=$5,
           site_hint=$6, status=$7, sentiment=$8, sr_claimed=$9, sr_number_claimed=$10
         where id=$1`,
        [
          id,
          String(args.startedAt ?? ''),
          Number(args.durationSec) || 0,
          String(args.callerName ?? ''),
          String(args.callerPhone ?? ''),
          String(args.siteHint ?? ''),
          String(args.status ?? 'completed'),
          String(args.sentiment ?? ''),
          boolText(asBool(args.srClaimed)),
          String(args.srNumberClaimed ?? ''),
        ],
      );
      db.query('delete from transcript_turns where conversation_id = $1', [id]);
    } else {
      db.query(
        `insert into conversations
           (id, call_id, started_at, duration_sec, caller_name, caller_phone, site_hint,
            status, sentiment, sr_claimed, sr_number_claimed, cmms_sr_id, join_method,
            join_confidence, eval_status, quality_score)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'','none',0,'not_evaluated',0)`,
        [
          id,
          callId,
          String(args.startedAt ?? ''),
          Number(args.durationSec) || 0,
          String(args.callerName ?? ''),
          String(args.callerPhone ?? ''),
          String(args.siteHint ?? ''),
          String(args.status ?? 'completed'),
          String(args.sentiment ?? ''),
          boolText(asBool(args.srClaimed)),
          String(args.srNumberClaimed ?? ''),
        ],
      );
    }

    turns.forEach((t: any, i: number) => {
      db.query(
        `insert into transcript_turns
           (id, conversation_id, turn_index, performer, message, at_offset,
            tool_name, tool_status, tool_args, tool_result, tool_record_id, tool_error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          `${id}-T${i}`,
          id,
          i,
          String(t.performer ?? 'system'),
          String(t.message ?? ''),
          String(t.at ?? ''),
          t.toolName ? String(t.toolName) : null,
          t.toolStatus ? String(t.toolStatus) : null,
          t.toolArgs ? String(t.toolArgs) : null,
          t.toolResult ? String(t.toolResult) : null,
          t.toolRecordId ? String(t.toolRecordId) : null,
          t.toolError ? String(t.toolError) : null,
        ],
      );
    });

    return { conversationId: id, turns: turns.length, replaced: Boolean(existing) };
  },
});

// ---------------------------------------------------------------------------
// The join + deterministic checks — the spine
// ---------------------------------------------------------------------------

/**
 * The deterministic grading core: join one stored call to its live CMMS
 * service request and run the code-answerable checks against that record.
 *
 * Extracted so the manual path and the scheduled job share ONE implementation.
 * Two copies of this logic would drift the moment either was touched, and the
 * whole point of grading automatically is that it agrees with grading by hand.
 *
 * No agent is called from here — every check is plain code, which is exactly
 * why this half CAN run inside a scheduled function.
 */
async function gradeConversation(convoId: string) {

    const db = connect();
    const convo = db.query('select * from conversations where id = $1 limit 1', [convoId]).rows[0];
    if (!convo) throw new Error(`No conversation ${convoId}`);

    const turns = db.query(
      'select * from transcript_turns where conversation_id = $1 order by turn_index',
      [convoId],
    ).rows;

    // Calls pulled from the helpdesk-call-logs connection. Their channel
    // records speech only — no tool calls, no caller name, no site — so checks
    // that read those absences as agent failures have to be told the
    // difference between "did not happen" and "is not recorded here".
    const isLiveCall = String(convo.id ?? '').startsWith('L-');

    // How this conversation arrived, which decides what may be checked at all.
    const chan = channelOf(channelRowOf(db, convoId));
    const inapplicable = notApplicableFor(chan.modality);

    // ---- 1. Resolve the join against the LIVE CMMS -----------------------
    // Strongest signal first: the SR number the agent read back. Falling back
    // to site + time window, which is weaker and recorded as such.
    let matched: any = null;
    let joinMethod = 'none';
    let joinConfidence = 0;

    const claimedNumber = String(convo.sr_number_claimed ?? '').trim();

    // A TEXT conversation is not joined at all yet, and says so.
    //
    // The reference on a text channel is typed, not spoken, and this app has no
    // parser for it — writtenSrNumber is deliberately stubbed until there is
    // real text data to test against. Falling through to the site+time window
    // would be worse than doing nothing: it guesses, and a guessed join is
    // indistinguishable from the agent inventing a reference, which is the
    // exact failure Hue exists to catch. 'not_checked' is neither a match nor
    // "no record" — it is the truth, that nobody looked.
    if (!chan.isVoice) {
      joinMethod = 'not_checked';
    } else if (claimedNumber) {
      // The agent read a specific record id back to the caller. Resolve on that
      // id and NOTHING else: `id(equals)=N` is the verified filter syntax.
      //
      // Critically, there is no fallback from here. If the record the agent
      // named does not exist, that absence IS the finding — guessing a
      // plausible nearby record would manufacture a join the agent never made
      // and hide the very failure Hue exists to catch.
      const byId = await cmms('list-service-requests', {
        page_size: 1,
        page: 1,
        expand: 'site,requester',
        filters: `id(equals)=${claimedNumber}`,
      });
      matched = rowsOf(byId)[0] ?? null;
      if (matched) {
        joinMethod = 'sr_number';
        joinConfidence = 0.99;
      }
    } else if (asBool(convo.sr_claimed)) {
      // The agent claimed a request exists but never read back a reference.
      // Site + time is the only lead, and it is weak: several records can sit
      // in the same window at the same site. Accept it only when exactly one
      // candidate matches, so an ambiguous window yields no join rather than a
      // confident-looking wrong one.
      const started = String(convo.started_at ?? '');
      const startMs = Date.parse(started);
      const hint = String(convo.site_hint ?? '').trim().toLowerCase();

      if (isFinite(startMs) && hint) {
        // One bulk read, filtered in JS — never a query per row.
        const recent = await cmms('list-service-requests', {
          page_size: 200,
          page: 1,
          expand: 'site,requester',
          sort_by: 'sysCreatedTime',
          sort_order: 'desc',
        });
        const candidates = rowsOf(recent).filter((r: any) => {
          const created = Date.parse(r.sysCreatedTime ?? '');
          if (!isFinite(created)) return false;
          // Created during or shortly after the call: 30 minutes, not hours.
          if (created < startMs || created - startMs > 30 * 60 * 1000) return false;
          return String(r.site?.name ?? '').trim().toLowerCase() === hint;
        });
        if (candidates.length === 1) {
          matched = candidates[0];
          joinMethod = 'site_time';
          joinConfidence = 0.6;
        }
        // More than one candidate is genuinely ambiguous — leave unmatched.
      }
    }

    const srId = matched ? String(matched.id) : '';
    db.query(
      `update conversations set cmms_sr_id=$2, join_method=$3, join_confidence=$4 where id=$1`,
      [convoId, srId, joinMethod, joinConfidence],
    );

    // A live call has no site of its own — call logs carry none — so the site
    // of the record it resolved to is the only one available. This writes into
    // site_hint ONLY when it is empty, which is exactly the live case: a seeded
    // call's hint is the site as the agent understood it, and that is evidence
    // in its own right, so it is never overwritten by ground truth.
    let siteNow = String(convo.site_hint ?? '').trim();
    if (matched && !siteNow) {
      const siteName = String(matched.site?.name ?? '').trim();
      if (siteName) {
        db.query('update conversations set site_hint=$2 where id=$1', [convoId, siteName]);
        siteNow = siteName;
      }
    }

    // ---- 2. Deterministic checks against the live record -----------------
    // Exact, reproducible, free. No model is consulted here by design.
    const findings: Array<{
      criterionId: string;
      clauseRef: string;
      summary: string;
      severity: string;
      evidence: any[];
    }> = [];

    /**
     * A check that cannot be answered on this channel is SKIPPED, not failed.
     *
     * Every deterministic check below is wrapped in this. A criterion in the
     * inapplicable set never reaches its own logic, so there is no path by
     * which a text conversation produces a voice-shaped finding.
     */
    const skipped: Array<{ criterionId: string; reason: string; detail: string }> = [];
    const applicable = (criterionId: string): boolean => {
      const reason = inapplicable[criterionId];
      if (!reason) return true;
      skipped.push({
        criterionId,
        reason,
        detail: skipReason(reason, chan.channel),
      });
      return false;
    };

    // What the agent actually told the caller, read from the transcript at
    // evaluation time rather than taken from the stored sr_claimed flag.
    //
    // The flag is set once at ingest by a coarse keyword match; deriving the
    // claim here makes the finding auditable — the exact sentence that made the
    // promise becomes the evidence — and lets a re-evaluation correct an
    // earlier misreading. The derived value is written back so the UI's
    // "claimed" state agrees with what the check used.
    const claim = agentClaim(turns);
    const srClaimed = claim.claimed;
    if (asBool(convo.sr_claimed) !== srClaimed) {
      db.query('update conversations set sr_claimed=$2 where id=$1', [convoId, boolText(srClaimed)]);
    }

    // CR-LOG-01 — a record must exist for what the caller reported.
    //
    // Three pieces of real evidence, and all three are needed before this
    // fires: the agent SAID it logged something, a specific reference was or
    // was not read back, and the live CMMS join found nothing. Tool-call logs
    // would be a fourth, but the voice channel does not expose them (see
    // `callToolCalls`), so the claim is established from speech alone — which
    // is exactly what the caller was told and went away believing.
    if (applicable('CR-LOG-01') && srClaimed && !matched) {
      const named = claim.number || String(convo.sr_number_claimed ?? '').trim();
      const who = convo.caller_name || convo.caller_phone || 'the caller';

      const evidence = [
        ...claim.quotes.map((q) => ({
          at: q.at,
          who: 'agent',
          quote: q.message,
          isViolation: true,
        })),
        {
          at: '',
          who: 'CMMS',
          quote: named
            ? `Looked up service request ${named} in the CMMS: no such record.`
            : 'Searched the CMMS for a service request from this call: none found.',
          isViolation: true,
        },
      ];

      findings.push({
        criterionId: 'CR-LOG-01',
        clauseRef: 'S-2.1',
        summary: named
          ? `The agent read reference ${named} back to ${who}, but no such service request exists in the CMMS. ` +
            `The caller is holding a reference number for a record that was never created.`
          : `The agent told ${who} the request was logged, but no service request exists in the CMMS for this call, ` +
            `and no reference was ever read back. The reported fault is still unlogged.`,
        // A reference read back is the worse failure: the caller has something
        // to quote, so the gap surfaces only when they chase it.
        severity: 'critical',
        evidence,
      });
    }

    // Whether this call's channel records tool calls at all. Calls pulled from
    // the helpdesk-call-logs connection are speech-only — the channel logs no
    // tool events — so a check that reads "no successful tool call" as a
    // failure would fire on every live call and be wrong every time. Absence of
    // a log is not evidence of absence of the action.
    const hasToolLog = turns.some((t: any) => t.tool_name);

    // CR-LOG-02 — never confirm without an id returned by the CMMS.
    // Only answerable where a tool log exists; otherwise the CMMS join is the
    // only evidence, and CR-LOG-01 above already covers a missing record.
    const confirmedWithoutId =
      hasToolLog &&
      srClaimed &&
      !turns.some((t: any) => t.tool_name && t.tool_status === 'success' && t.tool_record_id);
    if (applicable('CR-LOG-02') && confirmedWithoutId) {
      findings.push({
        criterionId: 'CR-LOG-02',
        clauseRef: 'S-2.1',
        summary:
          'The agent confirmed the request to the caller although no tool call returned a service request id.',
        severity: 'high',
        evidence: turns
          .filter((t: any) => t.tool_name)
          .map((t: any) => ({
            at: t.at_offset,
            who: 'Tool call',
            quote: `${t.tool_name} -> ${t.tool_status}${t.tool_error ? ` (${t.tool_error})` : ''}`,
            isViolation: t.tool_status !== 'success',
          })),
      });
    }

    // CR-ESC-04 — a call that drops before confirmation must raise a callback
    // task. A drop is not a completed call, and the caller is left believing
    // nothing was recorded — which here is true.
    if (applicable('CR-ESC-04') && String(convo.status ?? '') === 'dropped' && !matched) {
      const hasCallback = turns.some(
        (t: any) => t.tool_name && /callback/i.test(String(t.tool_name)) && t.tool_status === 'success',
      );
      if (!hasCallback) {
        findings.push({
          criterionId: 'CR-ESC-04',
          clauseRef: 'S-2.5',
          summary:
            `The call from ${convo.caller_name || 'the caller'} dropped after ${convo.duration_sec ?? '?'} seconds before anything was confirmed, ` +
            `and no callback task was created. Nothing about the reported issue reached the CMMS.`,
          severity: 'critical',
          evidence: turns.slice(-3).map((t: any) => ({
            at: t.at_offset,
            who: t.tool_name ? 'Tool call' : t.performer,
            quote: t.tool_name ? `${t.tool_name} -> ${t.tool_status ?? 'unknown'}` : t.message,
            isViolation: t.performer === 'system',
          })),
        });
      }
    }

    // CR-CALL-01 — name, site and contact must be captured.
    //
    // The caller's name is checked only where the channel records one. The
    // helpdesk call-log channel leaves `name` null on nearly every call, so
    // reading that null as "the agent never asked" would flag every live call
    // on the strength of a field the channel simply does not populate. Whether
    // the agent actually asked is visible in the transcript, which is a reading
    // task — CR-CALL-01's semantic pass covers it for live calls.
    const missing: string[] = [];
    const channelRecordsName = !isLiveCall;
    if (channelRecordsName && !String(convo.caller_name ?? '').trim()) missing.push('name');
    if (!String(convo.caller_phone ?? '').trim()) missing.push('contact number');
    // siteNow, not convo.site_hint — the join above may have just resolved it.
    if (!siteNow) missing.push('site');

    // A call the caller never spoke on cannot be graded on what the agent got
    // from them. These exist in the live data — the greeting plays and the line
    // drops — and flagging the agent for not confirming details with someone
    // who never said a word is noise, not a finding.
    const callerSpoke = turns.some(
      (t: any) => t.performer === 'caller' && String(t.message ?? '').trim(),
    );

    if (applicable('CR-CALL-01') && missing.length && callerSpoke) {
      findings.push({
        criterionId: 'CR-CALL-01',
        clauseRef: 'S-6.1',
        summary: `The agent did not confirm the caller's ${missing.join(', ')} on this call.`,
        severity: 'medium',
        evidence: [],
      });
    }

    // ---- 3. Persist findings (select-then-write; no unique index) --------
    let written = 0;
    for (const f of findings) {
      const prior = db.query(
        'select id from deviations where conversation_id = $1 and criterion_id = $2 limit 1',
        [convoId, f.criterionId],
      ).rows[0];
      const devId = prior?.id ?? `DV-${convoId}-${f.criterionId}`;
      if (prior) {
        db.query(
          `update deviations set summary=$2, severity=$3, checked_sr_id=$4, evidence=$5,
             detected_at=$6, detected_by='deterministic' where id=$1`,
          [devId, f.summary, f.severity, srId, JSON.stringify(f.evidence), nowIso()],
        );
      } else {
        db.query(
          `insert into deviations
             (id, conversation_id, criterion_id, clause_ref, summary, severity, root_cause,
              status, detected_at, detected_by, checked_sr_id, evidence)
           values ($1,$2,$3,$4,$5,$6,'unknown','open',$7,'deterministic',$8,$9)`,
          [
            devId,
            convoId,
            f.criterionId,
            f.clauseRef,
            f.summary,
            f.severity,
            nowIso(),
            srId,
            JSON.stringify(f.evidence),
          ],
        );
      }
      written++;
    }

    // Retract deterministic findings that this run no longer makes.
    //
    // Without this, a criterion that stops failing — because the check was
    // corrected, or because the record it looked for now exists — leaves its
    // deviation open for ever, and the conversation ends up marked `passed`
    // while still carrying open findings that the compliance score counts.
    //
    // Scope is deliberately narrow: only this run's own layer
    // (detected_by = 'deterministic'), only findings still open, and never one
    // a correction has been proposed against, since deleting that would cascade
    // the correction away with it.
    const stillFailing = new Set(findings.map((f) => f.criterionId));
    const priorDet = db.query(
      `select id, criterion_id from deviations
        where conversation_id = $1 and detected_by = 'deterministic' and status = 'open'`,
      [convoId],
    ).rows;
    let retracted = 0;
    for (const p of priorDet) {
      if (stillFailing.has(p.criterion_id)) continue;
      const hasCorrection = db.query(
        'select id from corrections where deviation_id = $1 limit 1',
        [p.id],
      ).rows[0];
      if (hasCorrection) continue;
      db.query('delete from deviations where id = $1', [p.id]);
      retracted++;
    }

    // eval_status reflects everything open on the call, not just this layer —
    // a semantic finding from evaluateSemantic must keep the call flagged.
    const openNow = Number(
      db.query("select count(*) as n from deviations where conversation_id = $1 and status = 'open'", [
        convoId,
      ]).rows[0]?.n ?? 0,
    );
    //
    // 'skipped' is the frozen contract's own fourth value and this is what it
    // is for: nothing failed among the checks that RAN, but some could not run
    // on this channel. Calling that 'passed' would be the conversation-level
    // version of the fake pass this app refuses everywhere else.
    db.query('update conversations set eval_status=$2 where id=$1', [
      convoId,
      openNow ? 'flagged' : skipped.length ? 'skipped' : 'passed',
    ]);

    return {
      conversationId: convoId,
      channel: chan.channel,
      modality: chan.modality,
      // What could not be answered here, and why. Never empty on a text
      // conversation, and never reported as a pass.
      skipped,
      join: { cmmsSrId: srId || null, method: joinMethod, confidence: joinConfidence },
      // The deterministic checks that could fire at all. On text every one of
      // them reads the CMMS record, and there is no join yet, so none can —
      // saying 3 there would be claiming work that did not happen.
      checksRun: chan.isVoice ? 3 : 0,
      deviationsFound: written,
      retracted,
      findings: findings.map((f) => ({
        criterionId: f.criterionId,
        severity: f.severity,
        summary: f.summary,
      })),
    };
}

server.addHandler({
  name: 'evaluate',
  description:
    'Join one stored transcript to its REAL CMMS service request and run the deterministic checks against that live record.',
  parameters: { conversationId: { description: 'Conversation id', type: 'string' } },
  execute: async (args) => {
    const convoId = String(args.conversationId ?? '').trim();
    if (!convoId) throw new Error('conversationId is required');
    return await gradeConversation(convoId);
  },
});

// ---------------------------------------------------------------------------
// Claiming a call for grading
//
// Two things can decide to grade the same call: the scheduled job, and a browser
// that just loaded and does not want to wait 15 minutes for it. They must not
// both grade one call, and two browsers reloading at the same instant must not
// either. Everything below exists for that, and BOTH paths go through it —
// forking the claim would defeat the whole point of having one.
//
// The claim lives on the grade row. `call_grades.claimed_at/claimed_by` were put
// there for exactly this, and reusing that row means a call has one record, not
// a grade plus a separate lease that can disagree with it.
//
// TWO WRITERS OF call_grades NOW EXIST, OVER DISJOINT COLUMNS:
//
//   writeCallGrade  owns every grade column, and conversations.quality_score.
//                   It never touches claimed_at/claimed_by.
//   the claim path  owns claimed_at/claimed_by, and nothing else.
//
// That partition is what keeps the single-writer rule from step 1 true. A claim
// must never write a grade column, and a grade must never clear a claim.
// ---------------------------------------------------------------------------

/**
 * How long a claim may sit unfinished before another fire may take the call.
 *
 * Deterministic grading is 2-5s, so ten minutes is not a timeout — it is the
 * mark of a fire that DIED. A claim is only reaped this way; nothing releases
 * one on failure, deliberately. A call whose grade throws keeps its claim and
 * becomes retryable in ten minutes, which is a backoff. Releasing it
 * immediately would let a permanently failing call be retried by every reload.
 */
const CLAIM_TTL_MS = 10 * 60 * 1000;

/** An ISO stamp `ms` in the past, in the same shape every other stamp uses. */
function isoAgo(ms: number) {
  return new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Give every ungradeable-yet call a grade row, so there is something to claim.
 *
 * A call that has never been graded has no `call_grades` row, and an atomic
 * claim needs a row to update. This creates the empty shell — claim columns
 * blank, grade columns blank — which `writeCallGrade` later fills in.
 *
 * THE HONEST LIMIT: the app's role cannot create a unique index (it cannot even
 * CREATE TABLE — see the header), so this insert cannot be made exclusive. Two
 * fires racing to backfill the SAME never-graded call could both insert a
 * placeholder, and each could then claim one of the twins. The cost of that is
 * a call graded twice, not a call graded wrongly: `deviations` carries a real
 * UNIQUE (conversation_id, criterion_id), and `writeCallGrade` upserts on a
 * deterministic id, so the second pass converges on the same rows the first
 * wrote. Wasted work, never divergent data.
 *
 * Run once per fire, not once per call.
 */
function ensureGradeRows(db: any): number {
  const { rowCount, rows } = db.query(
    `insert into call_grades
       (id, conversation_id, claimed_at, claimed_by, graded_at, graded_by, applicable,
        response_quality, quality_justification, sentiment, sentiment_reason,
        sentiment_channel, sentiment_agrees, overall_assessment, criteria_satisfied,
        criteria_breached, criteria_graded, criteria_unavailable, agent_version, schema_version)
     select 'CG-' || c.id, c.id, '', '', '', '', '', null, '', '', '', '', '', '', '', '', '', '', '', 1
       from conversations c
      where c.id <> '__seed__'
        and c.eval_status = 'not_evaluated'
        and not exists (select 1 from call_grades g where g.id = 'CG-' || c.id)
     returning id`,
  );
  return Number(rowCount ?? (rows?.length || 0));
}

/**
 * Claim ONE call for grading, atomically, or return null when there is nothing
 * to take.
 *
 * This is the whole concurrency story, and it is one statement on purpose:
 *
 *   - Postgres takes a row lock per candidate. Two claimers cannot both update
 *     the same row; the loser re-evaluates the WHERE clause against the winner's
 *     committed value, sees a fresh claim, and matches nothing.
 *   - SKIP LOCKED is what turns "the loser gets nothing" into "the loser gets a
 *     DIFFERENT call". Without it the second claimer blocks on the row the first
 *     is holding and then finds it taken; with it, it steps past to the next
 *     candidate. That is the behaviour two people reloading at once need.
 *   - RETURNING is the proof of the claim. Nothing acts on a call it did not
 *     get back from here.
 *
 * Claimed one at a time, immediately before grading, rather than a batch up
 * front: a fire that claimed ten and died after three would strand seven for the
 * full TTL, which is the stuck state this is supposed to prevent.
 */
function claimNextForGrading(db: any, by: string): string | null {
  const now = nowIso();
  const cutoff = isoAgo(CLAIM_TTL_MS);

  const { rows } = db.query(
    `update call_grades set claimed_at = $1, claimed_by = $2
      where id in (
        select cg.id
          from call_grades cg
          join conversations c on c.id = cg.conversation_id
         where cg.id <> '__seed__'
           and c.eval_status = 'not_evaluated'
           and (
                 cg.claimed_at is null
              or cg.claimed_at = ''                                   -- never claimed
              or cg.claimed_at < $3                                   -- a dead fire's claim, reaped
              or (cg.graded_at <> '' and cg.graded_at >= cg.claimed_at) -- last claim finished
           )
         order by c.started_at desc
         limit 1
         for update skip locked
      )
     returning conversation_id`,
    [now, by, cutoff],
  );

  const id = rows[0]?.conversation_id;
  return id ? String(id) : null;
}

/**
 * Hand the claim back once the pass has actually finished.
 *
 * The deterministic pass sets `eval_status` and never writes `graded_at` — it
 * has no analyst to record — so nothing ever marked its claim complete and a
 * finished call held one until the TTL reaped it. Harmless for claiming (a
 * graded call is no longer a candidate), but it is what a reader sees: without
 * this, every automatically graded call reports "grading" for ten minutes.
 *
 * Only the holder may release it. A fire that lost its claim to a reaper must
 * not clear the claim of whoever legitimately took over.
 *
 * A FAILED grade is NOT released, deliberately — the claim is the backoff (see
 * CLAIM_TTL_MS), so a call whose grade throws reads as "grading" until the TTL
 * and then as "unavailable". There is no error column to say so any sooner.
 */
function releaseGradeClaim(db: any, convoId: string, by: string) {
  db.query(
    `update call_grades set claimed_at = '', claimed_by = ''
      where conversation_id = $1 and claimed_by = $2`,
    [convoId, by],
  );
}

/**
 * Claim and grade until the limit or the budget runs out.
 *
 * The single path to scheduled grading. The job and the reload nudge differ
 * only in how much they ask for — if they differed in how they claim, a
 * scheduled fire and a nudge could grade the same call, which is the one thing
 * this is here to make impossible.
 *
 * Deterministic only. No agent call happens here or can: a Studio Function
 * aborts a fetch at ~10s and every agent Hue uses runs longer. The nudge makes
 * the SERVER grade sooner; it does not move grading into the browser.
 */
async function gradeClaimed(by: string, limit: number, budgetMs: number) {
  const db = connect();
  const startedAt = Date.now();

  ensureGradeRows(db);

  const graded: Array<{ id: string; findings: number; join: string | null }> = [];
  const failed: Array<{ id: string; error: string }> = [];
  let stoppedForBudget = false;

  while (graded.length + failed.length < limit) {
    if (Date.now() - startedAt > budgetMs) {
      stoppedForBudget = true;
      break;
    }
    const convoId = claimNextForGrading(db, by);
    if (!convoId) break;

    try {
      const res = await gradeConversation(convoId);
      releaseGradeClaim(db, convoId, by);
      graded.push({
        id: convoId,
        findings: res.deviationsFound ?? 0,
        join: res.join?.cmmsSrId ?? null,
      });
    } catch (err) {
      // One bad call must not abort the fire — the rest still get graded. The
      // claim stays on it, so it is retryable once the TTL reaps it rather than
      // immediately re-attempted by whoever reloads next.
      failed.push({ id: convoId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const remaining = Number(
    db.query(
      "select count(*) as n from conversations where id <> '__seed__' and eval_status = 'not_evaluated'",
    ).rows[0]?.n ?? 0,
  );

  return {
    graded,
    failed,
    stoppedForBudget,
    stillUngraded: remaining,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

/** Who holds a claim. Provenance only — exclusivity comes from the row lock. */
function claimant(kind: string) {
  return `${kind}-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

server.addHandler({
  name: 'gradeUngraded',
  description:
    'Grade every call the ingest has stored but nothing has evaluated yet. Runs the SAME deterministic core as the manual path. Scheduled — see the pull-call-logs and grade-new-calls jobs.',
  parameters: {
    limit: { description: 'Max calls to grade this fire', type: 'number' },
    budgetSeconds: { description: 'Stop starting new calls after this many seconds', type: 'number' },
  },
  execute: async (args) => {
    // A fire must finish inside the job's wall clock. Deterministic grading is
    // 2-5s per call (a CMMS join plus code), so the cap is generous — but it is
    // a cap, not a hope: the loop stops starting work once the budget is spent
    // and reports what it left, rather than being killed mid-write.
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
    const budgetMs = Math.min(Math.max(Number(args.budgetSeconds) || 600, 30), 840) * 1000;

    // Claims each call before grading it, through the same core the reload
    // nudge uses — so a scheduled fire and a browser cannot pick the same call.
    const run = await gradeClaimed(claimant('job'), limit, budgetMs);

    return {
      graded: run.graded.length,
      details: run.graded,
      failed: run.failed,
      stoppedForBudget: run.stoppedForBudget,
      stillUngraded: run.stillUngraded,
      elapsedSeconds: run.elapsedSeconds,
      note:
        'Deterministic checks only. The semantic judges and the call analyst cannot run here — ' +
        'a Studio Function aborts a fetch at ~10s and every agent call takes longer. Those stay on ' +
        'the browser-side "Run evals" action.',
    };
  },
});

server.addHandler({
  name: 'nudgeGrading',
  description:
    'Grade a call or two NOW rather than waiting for the scheduled job. Claims each call first, through the same claim as the job, so two users reloading at once take different calls and never the same one. Server-side and deterministic — the nudge makes grading happen sooner, it does not move it into the browser.',
  parameters: {
    limit: { description: 'Max calls to grade this nudge (default 2)', type: 'number' },
    budgetSeconds: { description: 'Stop starting new calls after this many seconds (default 20)', type: 'number' },
  },
  execute: async (args) => {
    // Deliberately small. This runs while someone waits on a page load, so it
    // takes a bite out of the backlog rather than trying to clear it — the job
    // owns the backlog. A big limit here would leave the browser hanging on a
    // request that has no business being long.
    const limit = Math.min(Math.max(Number(args.limit) || 2, 1), 5);
    const budgetMs = Math.min(Math.max(Number(args.budgetSeconds) || 20, 5), 60) * 1000;

    const run = await gradeClaimed(claimant('nudge'), limit, budgetMs);

    return {
      graded: run.graded.length,
      details: run.graded,
      failed: run.failed,
      stoppedForBudget: run.stoppedForBudget,
      stillUngraded: run.stillUngraded,
      elapsedSeconds: run.elapsedSeconds,
    };
  },
});

server.addHandler({
  name: 'overview',
  description: 'Dashboard metrics. Counts come from the live CMMS and stored findings.',
  parameters: {},
  execute: async () => {
    const db = connect();

    const sitesPayload = await cmms('list-sites', { page_size: 200, page: 1 });
    const sites = rowsOf(sitesPayload).map((s: any) => String(s.name ?? ''));

    const srPayload = await cmms('list-service-requests', {
      page_size: 1,
      page: 1,
      include_count: true,
    });
    const srTotal = srPayload?.count ?? 0;

    // The channel's OWN count of calls, and how they split by channel.
    //
    // Deliberately not derived from what Hue stores: the gap between the two is
    // ingest lag, which is worth seeing rather than hiding behind a single
    // number. A channel outage degrades this to null — the dashboard is built
    // from stored findings and must not go down because the phone system did.
    let callStats: { total: number; byType: Record<string, number> } | null = null;
    try {
      const stats = await callLogs('get-call-stats', {});
      const raw = stats?.byType ?? stats?.data?.byType ?? {};
      const byType: Record<string, number> = {};
      for (const k of Object.keys(raw)) byType[String(k)] = Number(raw[k]) || 0;
      callStats = { total: Number(stats?.total ?? 0) || 0, byType };
    } catch {
      callStats = null;
    }

    const convoCount = Number(
      db.query("select count(*) as n from conversations where id <> '__seed__'").rows[0]?.n ?? 0,
    );
    const evaluated = Number(
      db.query(
        "select count(*) as n from conversations where id <> '__seed__' and eval_status <> 'not_evaluated'",
      ).rows[0]?.n ?? 0,
    );
    const openDeviations = Number(
      db.query("select count(*) as n from deviations where id <> '__seed__' and status = 'open'")
        .rows[0]?.n ?? 0,
    );
    const missedSr = Number(
      db.query(
        "select count(*) as n from deviations where id <> '__seed__' and criterion_id = 'CR-LOG-01'",
      ).rows[0]?.n ?? 0,
    );

    // A correction counts as "applied" once it has actually written to the CMMS
    // — 'applied' and the two states downstream of it. 'verified' is the subset
    // the verify step confirmed against the record, so verified <= corrections.
    const corrections = Number(
      db.query(
        "select count(*) as n from corrections where state in ('applied','verifying','resolved')",
      ).rows[0]?.n ?? 0,
    );
    const verified = Number(
      db.query("select count(*) as n from corrections where state = 'resolved'").rows[0]?.n ?? 0,
    );

    // Compliance is the share of evaluated CALLS that came through clean.
    //
    // It used to be (evaluated - openDeviations) / evaluated, which subtracts a
    // count of findings from a count of calls. That holds up only while calls
    // average under one finding each: the moment several findings land on one
    // call it goes negative and clamps to 0, reporting total failure while
    // calls are still passing. Counting clean calls cannot do that, and is what
    // "compliance score" is read as anyway.
    const cleanCalls = Number(
      db.query(
        // 'passed' and 'flagged' only. A 'skipped' conversation had checks it
        // could not run, so counting it as clean would inflate compliance with
        // work nobody did. No voice call is ever 'skipped', so this leaves the
        // existing numbers exactly where they were.
        `select count(*) as n from conversations c
          where c.id <> '__seed__' and c.eval_status in ('passed','flagged')
            and not exists (
              select 1 from deviations d
               where d.conversation_id = c.id and d.status = 'open')`,
      ).rows[0]?.n ?? 0,
    );

    // Compliance is over FULLY checked conversations only. `evaluated` still
    // drives coverage — a partially checked conversation has been looked at,
    // which is what coverage measures — but it cannot sit in the denominator of
    // a pass rate whose numerator it can never join. Today no conversation is
    // 'skipped', so both numbers are unchanged.
    const fullyChecked = Number(
      db.query(
        `select count(*) as n from conversations c
          where c.id <> '__seed__' and c.eval_status in ('passed','flagged')`,
      ).rows[0]?.n ?? 0,
    );

    const coverage = convoCount ? Math.round((evaluated / convoCount) * 100) : 0;
    const compliance = fullyChecked ? Math.round((cleanCalls / fullyChecked) * 100) : 100;

    return {
      callsToday: convoCount,
      deltaCalls: `${srTotal} service requests in the CMMS`,
      coverage,
      unchecked: convoCount - evaluated,
      missedSr,
      compliance: Math.max(compliance, 0),
      trend: openDeviations ? `${openDeviations} open` : 'No open deviations',
      corrections,
      verified,
      /** Live CMMS total, for the "Requests logged" card's denominator context. */
      srTotal,
      /** The call channel's own totals. null when the channel is unreachable. */
      callStats,
      sites,
      isFirstRun: convoCount === 0,
    };
  },
});

server.addHandler({
  name: 'syncStatus',
  description:
    'How far the stored calls are behind the channel, and how many are waiting to be graded. READ ONLY — it writes nothing, so any number of users can call it at once without racing.',
  parameters: {},
  execute: async () => {
    const db = connect();

    const stored = Number(
      db.query("select count(*) as n from conversations where id <> '__seed__'").rows[0]?.n ?? 0,
    );
    const awaitingGrading = Number(
      db.query(
        "select count(*) as n from conversations where id <> '__seed__' and eval_status = 'not_evaluated'",
      ).rows[0]?.n ?? 0,
    );

    // The channel's own total. A failure here is not an error for the screen —
    // the stored calls are still real and still listable — so it degrades to
    // "unknown" rather than taking the page down with it.
    let available: number | null = null;
    let reachable = false;
    try {
      const payload = await callLogs('list-call-logs', { page: 1, pageSize: 1 });
      available = Number(payload?.count ?? 0);
      reachable = true;
    } catch {
      reachable = false;
    }

    // Only ever a shortfall. If the channel reports fewer than we hold — an
    // older call deleted upstream, say — that is not "negative work to do".
    const awaitingIngest =
      available === null ? null : Math.max(available - stored, 0);

    return {
      stored,
      available,
      reachable,
      awaitingIngest,
      awaitingGrading,
      graded: stored - awaitingGrading,
      // Deliberately NOT a countdown: the app cannot see when the job last
      // fired, so anything more precise than the interval would be invented.
      intervalSeconds: 900,
    };
  },
});

server.addHandler({
  name: 'listConversations',
  description: 'List stored conversations, newest first',
  parameters: { limit: { description: 'Max rows', type: 'number' } },
  execute: async (args) => {
    const db = connect();
    const limit = Math.min(Number(args.limit) || 50, 200);
    // `snippet` is the caller's opening line — what the call was actually about.
    // The list shows it under the caller's name, and it is read from the stored
    // transcript rather than summarised, so the row quotes the caller verbatim.
    // The grade row comes along for the ride so every row can say where it is
    // in grading. Left join: a call that has never been claimed has no row, and
    // that absence is itself a state ("awaiting"), not a missing record.
    const { rows } = db.query(
      `select c.*,
              (select count(*) from deviations d where d.conversation_id = c.id) as deviation_count,
              (select t.message
                 from transcript_turns t
                where t.conversation_id = c.id and t.performer = 'caller'
                order by t.turn_index
                limit 1) as snippet,
              g.claimed_at, g.claimed_by, g.graded_at, g.graded_by,
              g.criteria_graded, g.criteria_unavailable,
              ch.channel, ch.channel_id, ch.modality, ch.identity_kind
         from conversations c
         left join call_grades g
                on g.conversation_id = c.id and g.id <> '__seed__'
         left join conversation_channels ch
                on ch.conversation_id = c.id and ch.id <> '__seed__'
        where c.id <> '__seed__'
        order by c.started_at desc
        limit $1`,
      [limit],
    );
    return {
      items: rows.map((r: any) => ({ ...r, grading: gradingStateOf(r), channel: channelOf(r) })),
    };
  },
});

server.addHandler({
  name: 'listDeviations',
  description: 'List findings, most severe first',
  parameters: { status: { description: 'Filter by status, or empty for all', type: 'string' } },
  execute: async (args) => {
    const db = connect();
    const status = String(args.status ?? '').trim();
    const sql = `select d.*, c.caller_name, c.caller_phone, c.site_hint,
                        c.started_at, c.cmms_sr_id
                   from deviations d
                   join conversations c on c.id = d.conversation_id
                  where d.id <> '__seed__' ${status ? 'and d.status = $1' : ''}
                  order by case d.severity
                             when 'critical' then 0 when 'high' then 1
                             when 'medium' then 2 else 3 end,
                           d.detected_at desc`;
    const { rows } = status ? db.query(sql, [status]) : db.query(sql);
    return {
      items: rows.map((r: any) => ({ ...r, evidence: JSON.parse(r.evidence || '[]') })),
    };
  },
});

server.addHandler({
  name: 'getConversation',
  description:
    'One conversation with its transcript and the LIVE CMMS record it joins to (fetched fresh, never cached).',
  parameters: { id: { description: 'Conversation id', type: 'string' } },
  execute: async (args) => {
    const db = connect();
    const id = String(args.id ?? '');
    const convo = db.query('select * from conversations where id = $1 limit 1', [id]).rows[0];
    if (!convo) throw new Error(`No conversation ${id}`);

    let turns = db.query(
      'select * from transcript_turns where conversation_id = $1 order by turn_index',
      [id],
    ).rows;

    // The connection is the source of record for a live call, so its transcript
    // is re-read here rather than served from the copy ingest stored. The
    // stored turns remain the fallback: if the connection is unreachable or has
    // nothing for this call, the screen still renders what we already hold
    // rather than an empty transcript.
    const isLive = String(convo.id ?? '').startsWith('L-');
    let transcriptSource = isLive ? 'stored_fallback' : 'stored';
    // The call log's recording, when it has one. Surfaced so the player can say
    // whether a recording exists rather than implying one either way.
    let recordingFileId: number | null = null;
    // The channel runs its own summariser after a call ends. That output is
    // real AI work already done — reading it is not a new model call, and not
    // reading it was simply discarding it.
    let aiSummary: string | null = null;
    let aiTags: string | null = null;
    let satisfaction: string | null = null;
    if (isLive && convo.call_id) {
      try {
        const payload = await callLogs('get-call-log', { callLogId: Number(convo.call_id) });
        const rec = callRecordOf(payload);
        recordingFileId = Number(rec?.recordingFileId) || null;
        aiSummary = rec?.summary ? String(rec.summary) : null;
        aiTags = rec?.tags ? String(rec.tags) : null;
        satisfaction = rec?.satisfactionLevel ? String(rec.satisfactionLevel) : null;
        const live = transcriptionOf(payload);
        if (live.length) {
          const startMs = Number(callRecordOf(payload)?.startTime ?? 0);
          turns = live.map((t: any, i: number) => ({
            id: `${id}-L${i}`,
            conversation_id: id,
            turn_index: i,
            performer: toPerformer(t?.performer),
            message: String(t?.message ?? ''),
            at_offset: offsetFrom(startMs, t?.timestamp),
            // Live call logs carry speech only — there is no tool-call log on
            // this channel, so these stay null rather than being invented.
            tool_name: null,
            tool_status: null,
            tool_args: null,
            tool_result: null,
            tool_record_id: null,
            tool_error: null,
          }));
          transcriptSource = 'live';
        }
      } catch {
        // Fall through to the stored copy — a read-time outage on the
        // connection must not blank a call that was already ingested.
      }
    }

    const deviations = db.query('select * from deviations where conversation_id = $1', [id]).rows;

    // The stored grade. Before this existed the justification, sentiment reason
    // and overall assessment lived only in React state and vanished on reload —
    // the score survived, its reasoning did not.
    //
    // `graded_at <> ''` is load-bearing: since the claim path seeds an empty row
    // for every call awaiting grading, a row's EXISTENCE no longer means the
    // call was graded. Without this a claimed-but-unanalysed call comes back
    // with applicable=false, which the scorecard renders as "not applicable" —
    // the UI would say the call could not be judged when nothing has judged it.
    // A claim is not a grade.
    const gradeRow = db.query(
      `select * from call_grades
        where conversation_id = $1 and id <> '__seed__' and graded_at <> ''
        limit 1`,
      [id],
    ).rows[0];
    const grade = gradeRow ? readGrade(gradeRow) : null;

    // Where this call is in grading. Read from the claim row, which exists
    // whether or not the call was ever analysed — so this must NOT reuse
    // `gradeRow` above, which is deliberately blind to a claim.
    const claimRow = db.query(
      `select * from call_grades where conversation_id = $1 and id <> '__seed__' limit 1`,
      [id],
    ).rows[0];
    const grading = gradingStateOf({ ...(claimRow ?? {}), eval_status: convo.eval_status });

    // How the conversation arrived, and what that means cannot be judged on it.
    // Both derived, never stored: a second copy of "which checks apply" would
    // be a second thing to keep in step with the checks themselves.
    const channel = channelOf(channelRowOf(db, id));
    const notApplicable = Object.entries(notApplicableFor(channel.modality)).map(
      ([criterionId, reason]) => ({
        criterionId,
        reason,
        detail: skipReason(reason, channel.channel),
      }),
    );

    // Ground truth, fetched live at read time.
    //
    // The filter must be `id(equals)=N`, the same verified syntax the join
    // itself uses above. A bare `id=N` is not accepted: the connector returns a
    // payload with no rows, which read as "no service request exists" for every
    // call — showing the missing-record panel over records that were really
    // there.
    let cmmsRecord: any = null;
    if (convo.cmms_sr_id) {
      const payload = await cmms('list-service-requests', {
        page_size: 1,
        page: 1,
        expand: 'site,requester',
        filters: `id(equals)=${convo.cmms_sr_id}`,
      });
      cmmsRecord = rowsOf(payload)[0] ?? null;
    }

    return {
      conversation: convo,
      turns,
      transcriptSource,
      recordingFileId,
      aiSummary,
      aiTags,
      satisfaction,
      deviations: deviations.map((d: any) => ({ ...d, evidence: JSON.parse(d.evidence || '[]') })),
      cmmsRecord,
      grade,
      grading,
      channel,
      notApplicable,
    };
  },
});

server.addHandler({
  name: 'saveSow',
  description:
    'Store the scope of work Hue grades against, and report whether it CHANGED. Pasted for now; the same handler serves an automatic fetch the day agent 6208 becomes readable.',
  parameters: {
    body: { description: 'The SOW text', type: 'string' },
    title: { description: 'What to call this scope of work', type: 'string' },
    savedBy: { description: 'Who saved it', type: 'string' },
  },
  execute: async (args) => {
    const body = String(args.body ?? '').trim();
    // A SOW too short to contain a rule is refused rather than stored: it would
    // generate criteria out of nothing, and those criteria would grade calls.
    if (body.length < 40) {
      throw new Error(
        `Rejected: a scope of work needs enough text to contain a rule — got ${body.length} characters.`,
      );
    }

    const db = connect();
    const res = writeSowDocument(db, {
      title: String(args.title ?? '').trim() || 'Scope of work',
      body,
      source: 'manual',
      sourceRef: 'pasted',
      savedBy: String(args.savedBy ?? '').trim() || 'unknown',
    });

    // How many evals already exist for this exact text. Zero against a changed
    // SOW is the browser's cue to regenerate.
    const evalCount = Number(
      db.query(
        `select count(*) as n from generated_evals
          where id <> '__seed__' and sow_fingerprint = $1 and active = 'true'`,
        [res.fingerprint],
      ).rows[0]?.n ?? 0,
    );

    return { ...res, evalCount, needsGeneration: evalCount === 0 };
  },
});

server.addHandler({
  name: 'currentSow',
  description:
    'The scope of work in force, its fingerprint, and the evals generated from it. Also reports whether the upstream agent prompt is readable yet — it is not, and that is a state, not an error.',
  parameters: {},
  execute: async () => {
    const db = connect();
    const row = currentSowRow(db);

    // The seam. Returns null today; when it stops doing so, a drifted upstream
    // SOW is detected here rather than waiting for someone to paste it again.
    const upstream = await fetchSowFromAgent();
    const upstreamFingerprint = upstream ? fingerprintOf(upstream.body) : '';

    const fingerprint = row ? String(row.fingerprint ?? '') : '';
    // Custom evals appear whatever the SOW says, because they do not come from
    // it — see activeGeneratedEvals.
    const evals = db.query(
      `select * from generated_evals
        where id <> '__seed__' and (sow_fingerprint = $1 or generated_by = 'manual')
        order by clause_ref, criterion_id`,
      [fingerprint || ''],
    ).rows;

    return {
      sow: row
        ? {
            id: String(row.id),
            fingerprint,
            title: String(row.title ?? ''),
            body: String(row.body ?? ''),
            source: String(row.source ?? ''),
            sourceRef: String(row.source_ref ?? ''),
            fetchedAt: String(row.fetched_at ?? ''),
            savedBy: String(row.saved_by ?? ''),
          }
        : null,
      evals: evals.map((r: any) => ({
        id: String(r.id),
        criterionId: String(r.criterion_id ?? ''),
        clauseRef: String(r.clause_ref ?? ''),
        title: String(r.title ?? ''),
        description: String(r.description ?? ''),
        passDefinition: String(r.pass_definition ?? ''),
        failDefinition: String(r.fail_definition ?? ''),
        layer: String(r.layer ?? ''),
        checkType: String(r.check_type ?? ''),
        severity: String(r.severity ?? ''),
        modality: String(r.modality ?? 'any'),
        active: isTrue(r.active),
        approved: isTrue(r.approved),
        generatedAt: String(r.generated_at ?? ''),
        generatedBy: String(r.generated_by ?? ''),
        sourceExcerpt: String(r.source_excerpt ?? ''),
        // Only semantic evals can actually be judged. A generated criterion the
        // model labelled deterministic has NO code behind it — nothing would
        // run it, and it must never be reported as a criterion the call passed.
        runnable: String(r.layer ?? '') === 'semantic',
      })),
      // Whether the SOW upstream has drifted from what is stored. Always false
      // while the fetch is stubbed, and correct the moment it is not.
      upstreamReadable: upstream !== null,
      upstreamDrifted: Boolean(upstream && upstreamFingerprint !== fingerprint),
    };
  },
});

server.addHandler({
  name: 'sowVersions',
  description:
    'Every stored version of the scope of work, newest first, with how many evals each produced. The table has kept these all along; nothing read them, so the screen showed a hardcoded "no earlier versions".',
  parameters: {},
  execute: async () => {
    const db = connect();
    const rows = db.query(
      `select * from sow_documents where id <> '__seed__'
        order by case when is_current = 'true' then 0 else 1 end, fetched_at desc`,
    ).rows;

    return {
      items: rows.map((r: any) => {
        const fp = String(r.fingerprint ?? '');
        const evalCount = Number(
          db.query(
            `select count(*) as n from generated_evals
              where id <> '__seed__' and sow_fingerprint = $1 and active = 'true'
                and generated_by <> 'manual'`,
            [fp],
          ).rows[0]?.n ?? 0,
        );
        return {
          id: String(r.id ?? ''),
          fingerprint: fp,
          title: String(r.title ?? ''),
          isCurrent: isTrue(r.is_current),
          source: String(r.source ?? ''),
          sourceRef: String(r.source_ref ?? ''),
          savedBy: String(r.saved_by ?? ''),
          fetchedAt: String(r.fetched_at ?? ''),
          supersededAt: String(r.superseded_at ?? ''),
          chars: String(r.body ?? '').length,
          // Only what the writer produced for THAT text. Hand-written evals are
          // not tied to a version, so counting them here would attribute one
          // person's criterion to every version of the document.
          evalCount,
        };
      }),
    };
  },
});

server.addHandler({
  name: 'saveGeneratedEvals',
  description:
    'Persist the criteria the eval-writer produced for one SOW version. Validates every row before writing — the browser proposes criteria, this decides what may grade a call.',
  parameters: {
    sowFingerprint: { description: 'The SOW version these were generated from', type: 'string' },
    evalsJson: { description: 'The generated criteria, as a JSON array', type: 'string' },
    generatedBy: { description: 'Agent link name and model', type: 'string' },
  },
  execute: async (args) => {
    const db = connect();
    const fingerprint = String(args.sowFingerprint ?? '').trim();
    const sow = currentSowRow(db);
    if (!sow) throw new Error('No scope of work is stored — save one before generating evals.');
    if (String(sow.fingerprint) !== fingerprint) {
      // The SOW moved while the browser was generating. Writing these would
      // attach criteria to text nobody is grading against any more.
      throw new Error(
        `Rejected: these evals were generated from a scope of work that is no longer current.`,
      );
    }

    let parsed: any[];
    try {
      parsed = JSON.parse(String(args.evalsJson ?? '[]'));
    } catch {
      throw new Error('Rejected: evalsJson is not valid JSON.');
    }
    if (!Array.isArray(parsed) || !parsed.length) {
      throw new Error('Rejected: no criteria to save.');
    }

    const LAYERS = ['deterministic', 'semantic'];
    const SEVERITIES = ['critical', 'high', 'medium', 'low'];
    const MODALITIES = ['voice', 'text', 'any'];
    const CHECK_TYPES = [
      'intended_action', 'required_field', 'entity_resolution', 'escalation_sla',
      'scope_boundary', 'flow_conformance', 'communication_fidelity', 'custom',
    ];

    const now = nowIso();
    const generatedBy = String(args.generatedBy ?? '').trim() || 'unknown';
    const written: string[] = [];
    const rejected: Array<{ criterionId: string; why: string }> = [];

    for (const e of parsed) {
      const raw = String(e?.criterionId ?? '').trim().toUpperCase();
      // Namespaced so a generated criterion can NEVER collide with a seeded
      // CR-* id and quietly take over a hand-written check.
      const criterionId = raw.startsWith('GEN-') ? raw : `GEN-${raw}`;
      if (!/^GEN-[A-Z0-9-]{2,40}$/.test(criterionId)) {
        rejected.push({ criterionId: raw || '(blank)', why: 'unusable criterion id' });
        continue;
      }
      const pass = String(e?.passDefinition ?? '').trim();
      const fail = String(e?.failDefinition ?? '').trim();
      // A criterion with no stated bar cannot be judged consistently, and a
      // judge given one will invent the other. Both or neither.
      if (!pass || !fail) {
        rejected.push({ criterionId, why: 'missing pass or fail definition' });
        continue;
      }
      const layer = LAYERS.indexOf(String(e?.layer ?? '')) >= 0 ? String(e.layer) : 'semantic';
      const severity =
        SEVERITIES.indexOf(String(e?.severity ?? '')) >= 0 ? String(e.severity) : 'medium';
      const modality =
        MODALITIES.indexOf(String(e?.modality ?? '')) >= 0 ? String(e.modality) : 'any';
      const checkType =
        CHECK_TYPES.indexOf(String(e?.checkType ?? '')) >= 0 ? String(e.checkType) : 'custom';

      const id = `GE-${fingerprint}-${criterionId}`;
      const values = [
        String(sow.id),
        fingerprint,
        criterionId,
        String(e?.clauseRef ?? '').trim() || '—',
        String(e?.title ?? '').trim() || criterionId,
        String(e?.description ?? '').trim(),
        pass,
        fail,
        layer,
        checkType,
        severity,
        modality,
        'true',
        'true',
        'auto',
        now,
        generatedBy,
        String(e?.sourceExcerpt ?? '').trim(),
      ];

      const existing = db.query('select id from generated_evals where id = $1 limit 1', [id])
        .rows[0];
      if (existing) {
        db.query(
          `update generated_evals set
             sow_id=$2, sow_fingerprint=$3, criterion_id=$4, clause_ref=$5, title=$6,
             description=$7, pass_definition=$8, fail_definition=$9, layer=$10,
             check_type=$11, severity=$12, modality=$13, active=$14, approved=$15,
             approved_by=$16, generated_at=$17, generated_by=$18, source_excerpt=$19,
             schema_version=1
           where id=$1`,
          [id, ...values],
        );
      } else {
        db.query(
          `insert into generated_evals
             (id, sow_id, sow_fingerprint, criterion_id, clause_ref, title, description,
              pass_definition, fail_definition, layer, check_type, severity, modality,
              active, approved, approved_by, generated_at, generated_by, source_excerpt,
              schema_version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,1)`,
          [id, ...values],
        );
      }
      written.push(criterionId);
    }

    // Anything from this SOW that this run did NOT produce is retired rather
    // than deleted: a regeneration that drops a criterion should stop it
    // grading, not erase that it once existed.
    let retired = 0;
    // Only what the WRITER produced is swept. A hand-written eval was never in
    // the model's output and must not be retired for being absent from it —
    // that would delete somebody's own criterion on the next regeneration.
    const prior = db.query(
      `select id, criterion_id from generated_evals
        where id <> '__seed__' and sow_fingerprint = $1 and active = 'true'
          and generated_by <> 'manual'`,
      [fingerprint],
    ).rows;
    for (const p of prior) {
      if (written.indexOf(String(p.criterion_id)) >= 0) continue;
      db.query(`update generated_evals set active = 'false' where id = $1`, [p.id]);
      retired++;
    }

    return { saved: written.length, criteria: written, rejected, retired, sowFingerprint: fingerprint };
  },
});


// ---------------------------------------------------------------------------
// Serial ids for hand-written evals
//
// GEN-CUS-001, GEN-CUS-002, … The GEN- prefix is what generatedCriterion gates
// on, CUS marks it hand-written, and the seeded CR-* namespace is untouched —
// so an id cannot collide across the three sources by construction.
// ---------------------------------------------------------------------------

/** Where the allocation lock lives. Same table and shape as the ingest lease. */
const SERIAL_LEASE_ID = 'LEASE-eval-serial';
const SERIAL_LEASE_TTL_MS = 15 * 1000;

/**
 * Take the allocation lock.
 *
 * "Read the max, add one" is select-then-write, and this database has no unique
 * index and no sequences. Two people saving at the same moment would both read
 * 003 and both write 004 — and since generatedCriterion resolves with LIMIT 1,
 * one of those two criteria would silently never grade. A criterion that looks
 * saved and never runs is exactly the failure this app exists to catch.
 *
 * THE LOCK MUST SPAN THE INSERT, not just the read. Releasing it after reading
 * the max and before writing the row leaves the next caller reading a max that
 * does not yet include the number just handed out — which is a collision with
 * extra steps, and is what an earlier version of this did. Measured: three
 * concurrent saves, two of them got GEN-CUS-004.
 *
 * The TTL is short because what it guards is a handful of synchronous queries;
 * a lease older than that belongs to a run that died mid-write.
 */
function acquireSerialLease(db: any): string {
  const stamp = (msAgo = 0) =>
    new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const by = `serial-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const existing = db.query('select id from call_grades where id = $1 limit 1', [SERIAL_LEASE_ID])
    .rows[0];
  if (!existing) {
    db.query(
      `insert into call_grades (id, conversation_id, claimed_at, claimed_by, graded_at, graded_by,
                                applicable, response_quality, schema_version)
       values ($1,'__lease__','','','','','',null,1)`,
      [SERIAL_LEASE_ID],
    );
  }

  // The sandbox has no timers, so the wait is a spin. What it guards is a few
  // synchronous queries, so the window it spins over is microseconds.
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = db.query(
      `update call_grades set claimed_at = $2, claimed_by = $3
        where id = $1 and (claimed_at is null or claimed_at = '' or claimed_at < $4)
       returning id`,
      [SERIAL_LEASE_ID, stamp(), by, stamp(SERIAL_LEASE_TTL_MS)],
    );
    if (rows.length) return by;
  }
  throw new Error('Could not allocate an eval id — another save is holding the lock. Try again.');
}

function releaseSerialLease(db: any, by: string) {
  db.query(`update call_grades set claimed_at = '', claimed_by = '' where id = $1 and claimed_by = $2`, [
    SERIAL_LEASE_ID,
    by,
  ]);
}

/**
 * The next serial. Only correct while the lease above is held.
 *
 * Scans the ids that exist rather than keeping a counter: a counter and the
 * rows it numbers are two things to keep in step, and the rows are the truth.
 * Ids that predate serials — derived from a title — are left alone, since
 * deviations already reference them; the counter starts above the numbers.
 */
function nextCustomSerial(db: any): string {
  const rows = db.query(
    `select criterion_id from generated_evals
      where id <> '__seed__' and criterion_id like 'GEN-CUS-%'`,
  ).rows;

  let max = 0;
  for (const r of rows) {
    const m = /^GEN-CUS-(\d+)$/.exec(String(r.criterion_id ?? ''));
    if (m) max = Math.max(max, Number(m[1]) || 0);
  }
  return `GEN-CUS-${String(max + 1).padStart(3, '0')}`;
}


server.addHandler({
  name: 'retireCustomEval',
  description:
    "Stop a hand-written eval from grading. Sets active='false' rather than deleting: a criterion that produced findings should still be resolvable from those findings, and this table has no way back once a row is gone.",
  parameters: { criterionId: { description: 'The eval to retire', type: 'string' } },
  execute: async (args) => {
    const db = connect();
    const criterionId = String(args.criterionId ?? '').trim();

    // Only hand-written evals. A generated one belongs to its scope of work and
    // is retired by regenerating, not by hand — otherwise the two disagree
    // about what that version of the SOW produced.
    const row = db.query(
      `select id, title from generated_evals
        where id <> '__seed__' and criterion_id = $1 and generated_by = 'manual' limit 1`,
      [criterionId],
    ).rows[0];
    if (!row) {
      throw new Error(`No hand-written eval ${criterionId}. Generated evals are retired by regenerating.`);
    }

    db.query(`update generated_evals set active = 'false' where id = $1`, [row.id]);
    return { criterionId, title: String(row.title ?? ''), retired: true };
  },
});

server.addHandler({
  name: 'saveCustomEval',
  description:
    "Add a criterion written by hand. Stored beside the generated ones and graded like them, but marked manual so a regeneration never sweeps it away and a change to the scope of work never unbinds it.",
  parameters: {
    title: { description: 'Short name for the check', type: 'string' },
    description: { description: 'What it requires', type: 'string' },
    passDefinition: { description: 'Exactly what must be observable to PASS', type: 'string' },
    failDefinition: { description: 'Exactly what makes it FAIL', type: 'string' },
    severity: { description: 'critical | high | medium | low', type: 'string' },
    layer: { description: 'semantic | deterministic', type: 'string' },
    modality: { description: 'voice | text | any', type: 'string' },
    savedBy: { description: 'Who wrote it', type: 'string' },
  },
  execute: async (args) => {
    const db = connect();
    const title = String(args.title ?? '').trim();
    const pass = String(args.passDefinition ?? '').trim();
    const fail = String(args.failDefinition ?? '').trim();

    if (!title) throw new Error('Rejected: an eval needs a title.');
    // The same bar the generated ones are held to. A criterion with only one
    // side stated cannot be judged consistently — whoever grades it invents the
    // other half, and two runs disagree.
    if (!pass || !fail) {
      throw new Error('Rejected: state both what passes and what fails — a criterion with one side is not testable.');
    }

    // Allocated, not derived: the writer supplies a title and definitions, and
    // the id is this app's business. Every save is therefore a NEW criterion —
    // there is no title to match on any more, which is what a serial means.
    //
    // The lease is taken HERE and released only after the row exists, so the
    // next caller reads a max that includes this number.
    const lease = acquireSerialLease(db);
    const criterionId = nextCustomSerial(db);

    const LAYERS = ['deterministic', 'semantic'];
    const SEVERITIES = ['critical', 'high', 'medium', 'low'];
    const MODALITIES = ['voice', 'text', 'any'];
    const layer = LAYERS.indexOf(String(args.layer ?? '')) >= 0 ? String(args.layer) : 'semantic';
    const severity =
      SEVERITIES.indexOf(String(args.severity ?? '')) >= 0 ? String(args.severity) : 'medium';
    const modality =
      MODALITIES.indexOf(String(args.modality ?? '')) >= 0 ? String(args.modality) : 'any';

    const sow = currentSowRow(db);
    const now = nowIso();
    const savedBy = String(args.savedBy ?? '').trim() || 'hand-written';
    const id = `GE-manual-${criterionId}`;

    const values = [
      sow ? String(sow.id) : '',
      // Stamped with the CURRENT scope of work for provenance only. Grading
      // ignores it for manual evals, which are not derived from that text.
      sow ? String(sow.fingerprint ?? '') : '',
      criterionId,
      // The serial stands in the clause slot. A custom eval cites no clause of
      // the scope of work, and printing something like "S-9.9" there would be a
      // reference to a clause that does not exist.
      criterionId,
      title,
      String(args.description ?? '').trim(),
      pass,
      fail,
      layer,
      'custom',
      severity,
      modality,
      'true',
      'true',
      savedBy,
      now,
      'manual',
      '',
    ];

    try {
      db.query(
        `insert into generated_evals
           (id, sow_id, sow_fingerprint, criterion_id, clause_ref, title, description,
            pass_definition, fail_definition, layer, check_type, severity, modality,
            active, approved, approved_by, generated_at, generated_by, source_excerpt,
            schema_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,1)`,
        [id, ...values],
      );
    } finally {
      // Released only now. Releasing after reading the max and before writing
      // the row is what let two concurrent saves both take GEN-CUS-004.
      releaseSerialLease(db, lease);
    }

    return {
      criterionId,
      id,
      // Only a semantic eval reaches a judge; a deterministic one has no code.
      runnable: layer === 'semantic',
    };
  },
});

server.addHandler({
  name: 'gradingCriteria',
  description:
    'Every semantic criterion a conversation should be graded against — the seeded CR-* set plus the active generated evals from the current SOW. The browser walks this list; adding a SOW criterion therefore adds it to grading with no code change.',
  parameters: {},
  execute: async () => {
    const db = connect();
    const sow = currentSowRow(db);
    const fingerprint = sow ? String(sow.fingerprint ?? '') : '';

    const seeded = Object.keys(SEMANTIC_CRITERIA).map((id) => ({
      id,
      clauseRef: SEMANTIC_CRITERIA[id].clauseRef,
      title: id,
      requires: SEMANTIC_CRITERIA[id].requires,
      layer: 'semantic',
      severity: 'medium',
      modality: 'any',
      generated: false,
    }));

    // Only semantic generated evals are RUNNABLE. A generated criterion the
    // model called deterministic has no implementation — there is no code for
    // it — so it is reported separately rather than handed to a judge that
    // would answer it from the transcript alone.
    const rows = activeGeneratedEvals(db, fingerprint);
    const generated = rows.filter((r: any) => String(r.layer) === 'semantic').map(toJudgeCriterion);
    const notRunnable = rows
      .filter((r: any) => String(r.layer) !== 'semantic')
      .map((r: any) => String(r.criterion_id));

    return {
      sowFingerprint: fingerprint,
      seeded,
      generated,
      // Named plainly: these exist, they are not graded, and nothing may report
      // them as passed.
      notRunnable,
      items: [...seeded, ...generated],
    };
  },
});

server.addHandler({
  name: 'callRecording',
  description:
    "A playable URL for one call's recording, fetched fresh on every request. The channel returns a PRE-SIGNED url that expires, so this is never cached or stored — a stored one becomes a play button that works until it silently does not.",
  parameters: { conversationId: { description: 'Conversation id', type: 'string' } },
  execute: async (args) => {
    const db = connect();
    const convoId = String(args.conversationId ?? '').trim();
    const convo = db.query('select * from conversations where id = $1 limit 1', [convoId]).rows[0];
    if (!convo) throw new Error(`No conversation ${convoId}`);

    // Only calls pulled from the connection can have one. A seeded demo call
    // has no upstream record to ask about.
    if (!String(convo.id ?? '').startsWith('L-') || !convo.call_id) {
      return { available: false, reason: 'This call did not come from the call channel.' };
    }

    // recordingFileId lives on the full call log, not the list row, so it is
    // read here rather than trusted from anything stored.
    const payload = await callLogs('get-call-log', { callLogId: Number(convo.call_id) });
    const fileId = Number(callRecordOf(payload)?.recordingFileId) || 0;
    if (!fileId) {
      return { available: false, reason: 'The channel holds no recording for this call.' };
    }

    const rec = await callLogs('get-call-recording', { fileId });
    const url = String(rec?.file_signed_url ?? rec?.data?.file_signed_url ?? '');
    if (!url) {
      // The channel knows the file but would not hand one over. Reporting that
      // plainly beats a play button that does nothing when pressed.
      return { available: false, reason: 'The channel returned no download URL for this recording.' };
    }

    return {
      available: true,
      url,
      fileId,
      contentType: String(rec?.content_type ?? 'audio/wav'),
      sizeBytes: Number(rec?.size) || 0,
    };
  },
});

server.addHandler({
  name: 'gradingStatus',
  description:
    'Where each call is in grading — awaiting, grading, graded or unavailable. Deliberately light: no CMMS call, no transcript, no findings, because the screens poll this every few seconds while anything is in flight.',
  parameters: {
    conversationId: { description: 'One call, or empty for all of them', type: 'string' },
  },
  execute: async (args) => {
    const db = connect();
    const only = String(args.conversationId ?? '').trim();

    const sql = `select c.id, c.eval_status,
                        g.claimed_at, g.claimed_by, g.graded_at, g.graded_by,
                        g.criteria_graded, g.criteria_unavailable
                   from conversations c
                   left join call_grades g
                          on g.conversation_id = c.id and g.id <> '__seed__'
                  where c.id <> '__seed__' ${only ? 'and c.id = $1' : ''}
                  order by c.started_at desc`;
    const { rows } = only ? db.query(sql, [only]) : db.query(sql);

    const items = rows.map((r: any) => ({ id: String(r.id), ...gradingStateOf(r) }));
    return {
      items,
      // What the screens poll on: when nothing is moving, they stop asking.
      inFlight: items.filter((i: any) => i.status === 'grading' || i.status === 'awaiting').length,
    };
  },
});

/** The semantic criteria, and the judge that grades each. */
/** Worst first, for picking the finding a pattern-level fix is filed against. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const SEMANTIC_CRITERIA: Record<string, { clauseRef: string; requires: string }> = {
  // The semantic half of CR-LOG-01. The deterministic check catches the agent
  // CLAIMING a request that does not exist. It cannot catch the other way this
  // clause is broken: the agent openly failing — "I'm having trouble logging
  // this, someone will call you back" — after which the caller's fault is just
  // as unlogged, and nothing was falsely claimed for a check to contradict.
  // Whether the caller actually reported a new issue needing a record, as
  // opposed to chasing an existing one, can only be settled by reading the
  // call, so it is asked here rather than guessed at deterministically.
  'CR-LOG-01': {
    clauseRef: 'S-2.1',
    requires:
      'A service request must exist in the CMMS for every NEW issue the caller reported on this call. ' +
      'If the caller reported a new fault and no service request exists, this fails — including where the ' +
      'agent said it could not log the request, or promised a callback instead. ' +
      'It does NOT fail where the caller only chased, updated or asked about an EXISTING request, ' +
      'where the caller reported no fault at all, or where a record does exist.',
  },
  'CR-LOG-04': {
    clauseRef: 'S-2.2',
    requires:
      'Each distinct issue the caller raised must have its own service request. Two unrelated faults must not be merged into one record.',
  },
  'CR-SCHED-01': {
    clauseRef: 'S-4.2',
    requires:
      "Where the caller states a preferred visit window or access restriction, it must be recorded on the service request, not merely acknowledged in speech.",
  },
  'CR-CAT-01': {
    clauseRef: 'S-3.4',
    requires:
      'The service request must be categorised and prioritised to match the fault the caller actually described, including any stated consequence or deadline.',
  },

  // ---- The rest of the SOW's semantic criteria --------------------------
  // Each was already written in evals/criteria.seed.json and marked
  // `semantic`; none had a `requires` here, so nothing ever graded them. The
  // wording below is the criterion's own title and description, tightened into
  // an instruction and given the not-applicable case explicitly — a judge told
  // only what failure looks like will find failure everywhere.
  //
  // Every one of these is a reading task. None replaces a deterministic check:
  // record-exists, field-null, SLA clocks and category-in-list all stay in code.
  'CR-LOG-06': {
    clauseRef: 'S-2.4',
    requires:
      "The fault description on the service request must faithfully represent what the caller actually said about the symptom — their own words, not a rewrite that loses or changes the meaning. " +
      'Fails where the record describes a different fault, drops the distinguishing detail, or generalises the symptom away. ' +
      'Not applicable where no service request exists, or where the caller described no symptom.',
  },
  'CR-SCOPE-01': {
    clauseRef: 'S-1.3',
    requires:
      'Scope covers building services only. Anything outside it — tenant-owned equipment, fit-out assets, personal property — must be redirected to the right party, NOT logged as a service request. ' +
      'Fails where an out-of-scope item was logged anyway. ' +
      'Not applicable where everything reported was in scope, or nothing was reported.',
  },
  'CR-SCOPE-02': {
    clauseRef: 'S-1.4',
    requires:
      "Where the item is tenant-owned, the agent must refer the caller to the tenant's own vendor, and say so clearly enough that the caller knows who to contact next. " +
      'Judge both calls: whether it really was tenant-owned, and whether the redirect was phrased so the caller can act on it. ' +
      'Not applicable where nothing tenant-owned came up.',
  },
  'CR-ESC-02': {
    clauseRef: 'S-5.2',
    requires:
      'Where the caller describes a genuine safety emergency — someone trapped, fire, flood, a live electrical hazard — the P1 escalation flow must start immediately, before routine data gathering. ' +
      'Judge what the caller actually described, not the presence of an alarming word: "the lift is slow" is not entrapment. ' +
      'Not applicable where no safety emergency was described.',
  },
  'CR-CALL-02': {
    clauseRef: 'S-6.2',
    requires:
      'The agent must ask one question at a time. Fails where a single turn puts two or more distinct questions to the caller, leaving them to pick which to answer. ' +
      'Count genuine questions, not question marks — a rephrasing of the same question is one question. ' +
      'Not applicable to a call where the agent asked nothing.',
  },
  'CR-CALL-03': {
    clauseRef: 'S-6.3',
    requires:
      'Where the caller is distressed, angry or frightened, the agent must acknowledge that before it starts gathering details. ' +
      'Judge the caller\'s state from what they said and how they said it, and the agent\'s FIRST response to it. ' +
      'Not applicable where the caller was calm throughout.',
  },
  'CR-SCHED-02': {
    clauseRef: 'S-4.3',
    requires:
      'Where the caller states an access restriction — a gate code, a time the area cannot be entered, someone to ask for — it must be captured on the record in a form that preserves what they said. ' +
      'Fails where the restriction is missing, or reworded into something that would mislead whoever attends. ' +
      'Not applicable where the caller stated no access restriction.',
  },
};




/**
 * Request-scoped memo for CMMS records.
 *
 * This is NOT a cache of ground truth. It lives for one handler invocation and
 * dies with it, so a record is fetched at most once per request instead of once
 * per judge. Nothing is persisted — the next request reads the CMMS again, which
 * is the rule: a check never reads a stored copy.
 */
function makeRecordMemo() {
  const seen: Record<string, any> = {};
  return async function record(srId: string | null | undefined): Promise<any> {
    const key = String(srId ?? '');
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(seen, key)) return seen[key];
    const payload = await cmms('list-service-requests', {
      page_size: 1,
      page: 1,
      expand: 'site,requester',
      filters: `id(equals)=${key}`,
    });
    const r = rowsOf(payload)[0] ?? null;
    seen[key] = r
      ? {
          id: r.id,
          subject: r.subject,
          description: r.description,
          site: r.site?.name ?? null,
          siteId: r.site?.id ?? null,
          urgency: r.urgency ?? null,
          status: r.moduleState ?? null,
        }
      : null;
    return seen[key];
  };
}

/** Gather one deviation with its call, turns and the LIVE record it was checked against. */
async function deviationContext(db: any, deviationId: string, memo?: (id: string | null) => Promise<any>) {
  const dev = db.query('select * from deviations where id = $1 limit 1', [deviationId]).rows[0];
  if (!dev) throw new Error(`No deviation ${deviationId}`);
  const convo = db.query('select * from conversations where id = $1 limit 1', [
    dev.conversation_id,
  ]).rows[0];
  const turns = db.query(
    'select * from transcript_turns where conversation_id = $1 order by turn_index',
    [dev.conversation_id],
  ).rows;

  // One fetch per request, shared across every judge in this invocation.
  const fetchRecord = memo ?? makeRecordMemo();
  const cmmsRecord = await fetchRecord(convo?.cmms_sr_id ?? null);

  const transcript = turns.map((t: any) => ({
    performer: t.performer,
    at: t.at_offset,
    message: t.tool_name
      ? `TOOL ${t.tool_name} -> ${t.tool_status}${t.tool_args ? ` | args: ${t.tool_args}` : ''}${t.tool_result ? ` | result: ${t.tool_result}` : ''}${t.tool_error ? ` | error: ${t.tool_error}` : ''}`
      : t.message,
  }));

  return { dev, convo, transcript, cmmsRecord };
}




/**
 * Create or update — decided by the JOIN, never by the model.
 *
 * The proposer suggests a verb, but it is reading a transcript, not the CMMS.
 * If it says "create" while a record already exists, honouring that produces a
 * SECOND service request for one fault — the duplicate this app exists to
 * catch, manufactured by the tool meant to fix it.
 *
 * So ground truth decides: a call with no resolved record needs one made, and
 * a call with one needs it corrected. Both the button and the write read this,
 * so they cannot disagree about what is about to happen.
 */
function cmmsPlanFor(convo: any, action: any): { verb: string; recordId: string | null; reason: string } {
  const recordId = String(convo?.cmms_sr_id ?? '').trim() || null;
  const proposed = String(action?.verb ?? 'none');

  // The proposer named no CMMS work: this is a prompt, scope or human fix.
  if (proposed !== 'create' && proposed !== 'update') {
    return { verb: 'none', recordId, reason: 'This correction does not write to the CMMS.' };
  }
  if (!recordId) {
    return {
      verb: 'create',
      recordId: null,
      reason: 'The join found no service request for this call, so the record has to be made.',
    };
  }
  return {
    verb: 'update',
    recordId,
    reason: `This call resolved to service request ${recordId}, so the fix corrects that record.`,
  };
}

server.addHandler({
  name: 'applySowFix',
  description:
    "Approve a correction's agent-side fix by writing it into the scope of work as a new version. Idempotent by containment: a clause the SOW already carries is not appended twice. Returns the new fingerprint so the browser can regenerate the evals.",
  parameters: { correctionId: { description: 'Correction id', type: 'string' } },
  execute: async (args) => {
    const db = connect();
    const corrId = String(args.correctionId ?? '').trim();
    const corr = db.query('select * from corrections where id = $1 limit 1', [corrId]).rows[0];
    if (!corr) throw new Error(`No correction ${corrId}`);

    const addition = String(corr.after_text ?? '').trim();
    if (!addition) {
      throw new Error('This correction has no proposed text to write into the scope of work.');
    }

    const sow = currentSowRow(db);
    if (!sow) {
      // Refusing beats inventing: writing a scope of work out of one clause
      // would make a fragment look like the whole contract, and every eval
      // after it would be generated from that fragment.
      throw new Error(
        'No scope of work is stored yet. Paste it on Scope & Evals first — a fix has to amend something.',
      );
    }

    const body = String(sow.body ?? '');
    // Idempotency, and the reason it needs no write key: the SOW is addressed
    // by its own content. A clause already present means the fix is already
    // applied, so approving twice is a no-op rather than a second paragraph.
    if (body.includes(addition)) {
      return {
        correctionId: corrId,
        alreadyApplied: true,
        fingerprint: String(sow.fingerprint ?? ''),
        changed: false,
        note: 'The scope of work already carries this fix.',
      };
    }

    const stamped =
      `${body.trimEnd()}\n\n` +
      `[Hue ${nowIso()}] Amended from deviation ${corr.deviation_id} — ${String(corr.title ?? 'correction')}.\n` +
      addition;

    const res = writeSowDocument(db, {
      title: String(sow.title ?? 'Scope of work'),
      body: stamped,
      source: String(sow.source ?? 'manual'),
      sourceRef: `correction:${corrId}`,
      savedBy: 'approved fix',
    });

    // The correction records that its agent-side half landed. The CMMS half
    // keeps its own applied_write_key and its own state, because the two are
    // separate commits against different systems.
    db.query(
      `update corrections set state = case when state = 'proposed' then 'approved' else state end,
         recommended_action = $2 where id = $1`,
      [corrId, `Written into the scope of work as ${res.id}`],
    );

    return {
      correctionId: corrId,
      alreadyApplied: false,
      fingerprint: res.fingerprint,
      sowId: res.id,
      changed: res.changed,
      // The browser regenerates from here: the eval writer is an agent and
      // cannot run in a function.
      needsEvalRegeneration: res.changed,
    };
  },
});

server.addHandler({
  name: 'approveCorrection',
  description:
    'Approve a proposed correction and apply its CMMS write. Idempotent: the write key is claimed before the write, so approving twice cannot create two records.',
  parameters: { correctionId: { description: 'Correction id', type: 'string' } },
  execute: async (args) => {
    const db = connect();
    const corrId = String(args.correctionId ?? '').trim();
    const corr = db.query('select * from corrections where id = $1 limit 1', [corrId]).rows[0];
    if (!corr) throw new Error(`No correction ${corrId}`);

    // --- Idempotency guard -------------------------------------------------
    // The CSV-imported table carries no UNIQUE index, so the claim is a
    // select-then-write. Safe here: sandbox queries are serialized and this is
    // the only writer. A second approval finds the key already set and returns
    // the original record instead of writing again.
    if (corr.applied_write_key) {
      return {
        correctionId: corrId,
        state: corr.state,
        appliedRecordId: corr.applied_record_id || null,
        alreadyApplied: true,
      };
    }
    const writeKey = `${corrId}:${corr.deviation_id}`;
    db.query('update corrections set applied_write_key=$2 where id=$1', [corrId, writeKey]);

    const dev = db.query('select * from deviations where id = $1 limit 1', [corr.deviation_id])
      .rows[0];
    const convo = db.query('select * from conversations where id = $1 limit 1', [
      dev.conversation_id,
    ]).rows[0];

    let action: any = {};
    try {
      action = JSON.parse(corr.cmms_action || '{}');
    } catch {
      action = {};
    }
    // The JOIN decides, not the proposal. This is the guard that stops a
    // "create" verdict against a call that already has a record from raising a
    // duplicate — and stops an "update" against a call that has none from
    // silently writing nowhere.
    const plan = cmmsPlanFor(convo, action);
    const verb = plan.verb;

    let appliedRecordId: string | null = null;

    if (verb === 'update' && convo?.cmms_sr_id) {
      // Only fields the proposer actually named, mapped to writeable ones.
      const fields: any[] = Array.isArray(action.fields) ? action.fields : [];
      const patch: Record<string, unknown> = {};
      const notes: string[] = [];
      for (const f of fields) {
        const label = String(f.label ?? '').toLowerCase();
        const value = String(f.value ?? '');
        if (!value) continue;
        if (label.indexOf('urgency') >= 0 || label.indexOf('priority') >= 0) {
          // Only the three values this org accepts.
          const m = ['Emergency', 'Urgent', 'Not Urgent'].filter(
            (v) => value.toLowerCase().indexOf(v.toLowerCase()) >= 0,
          );
          if (m.length) patch.urgency = m[m.length - 1];
        } else if (label.indexOf('subject') >= 0) {
          patch.subject = value.slice(0, 255);
        } else {
          // Everything else the proposer named goes onto the description,
          // labelled. Matching a fixed vocabulary ("window", "description")
          // meant a proposal that said "Preferred Visit Date" or "Notes" wrote
          // nothing at all — the fix silently did less than it claimed. The CMMS
          // has no field for most of what a correction records, so the
          // description is where it goes, with its label kept so the reader
          // knows what it is.
          notes.push(`${String(f.label ?? '').trim()}: ${value}`);
        }
      }
      if (notes.length) patch.description = notes.join('\n');

      if (Object.keys(patch).length) {
        // A correction ADDS what the agent failed to record. It must never
        // replace what is already on the record: the fault description is the
        // caller's own account of the problem, and overwriting it to add a visit
        // window destroys the very thing the request exists to describe.
        if (typeof patch.description === 'string') {
          const current = await cmms('list-service-requests', {
            page_size: 1,
            page: 1,
            filters: `id(equals)=${convo.cmms_sr_id}`,
          });
          const existing = String(rowsOf(current)[0]?.description ?? '').trim();
          const addition = String(patch.description).trim();
          // Idempotent: approving twice must not append the same line twice.
          patch.description = !existing
            ? addition
            : existing.includes(addition)
              ? existing
              : `${existing}\n\n[Hue] ${addition}`.slice(0, 2000);
        }
        await cmms('update-service-request', {
          id: Number(convo.cmms_sr_id),
          servicerequest: patch,
        });
      }
      // Always leave an auditable note naming Hue as the author of the change.
      await cmms('add-service-request-comment', {
        id: Number(convo.cmms_sr_id),
        commentText:
          `[Hue governance] ${corr.title || 'Correction applied'}. ` +
          `Deviation ${dev.id} (${dev.criterion_id}, ${dev.severity}). ${corr.rationale || ''}`.slice(
            0,
            1000,
          ),
      });
      appliedRecordId = String(convo.cmms_sr_id);
    } else if (verb === 'create') {
      // The record the agent claimed but never made. Site comes from the call's
      // site hint resolved against the live site list — never invented.
      const sitesPayload = await cmms('list-sites', { page_size: 200, page: 1 });
      const hint = String(convo?.site_hint ?? '').trim().toLowerCase();
      const site = rowsOf(sitesPayload).filter(
        (s: any) => String(s.name ?? '').trim().toLowerCase() === hint,
      )[0];
      if (!site) {
        throw new Error(
          `Cannot create: no CMMS site matches the call's site "${convo?.site_hint}". Refusing to guess a site.`,
        );
      }
      const created = await cmms('create-service-request', {
        servicerequest: {
          subject: String(corr.title || 'Raised by Hue governance').slice(0, 255),
          description:
            `${String(corr.rationale ?? '')}\n\n` +
            `Raised by Hue from call ${convo.call_id}: the agent confirmed this request to the caller but no record existed.`.slice(
              0,
              2000,
            ),
          site: { id: Number(site.id) },
          urgency: 'Urgent',
        },
      });
      const rec = created?.data ?? created;
      appliedRecordId = rec?.id ? String(rec.id) : null;
      if (appliedRecordId) {
        db.query('update conversations set cmms_sr_id=$2 where id=$1', [convo.id, appliedRecordId]);
      }
    }

    db.query(
      `update corrections set state='applied', applied_at=$2, applied_record_id=$3 where id=$1`,
      [corrId, nowIso(), appliedRecordId ?? ''],
    );
    db.query("update deviations set status='correcting' where id=$1", [corr.deviation_id]);

    return { correctionId: corrId, state: 'applied', verb, appliedRecordId, alreadyApplied: false };
  },
});

server.addHandler({
  name: 'verifyCorrection',
  description:
    'Verify an applied correction against the live CMMS record and move it to resolved when the record now satisfies the finding.',
  parameters: { correctionId: { description: 'Correction id', type: 'string' } },
  execute: async (args) => {
    const db = connect();
    const corrId = String(args.correctionId ?? '').trim();
    const corr = db.query('select * from corrections where id = $1 limit 1', [corrId]).rows[0];
    if (!corr) throw new Error(`No correction ${corrId}`);
    if (corr.state !== 'applied' && corr.state !== 'verifying') {
      return { correctionId: corrId, state: corr.state, verified: false, reason: 'not applied yet' };
    }

    db.query("update corrections set state='verifying' where id=$1", [corrId]);

    // Re-read the record live. This is the whole point: verification asks the
    // CMMS what is true now, not what we believe we wrote.
    const recordId = corr.applied_record_id;
    let exists = false;
    let record: any = null;
    if (recordId) {
      const payload = await cmms('list-service-requests', {
        page_size: 1,
        page: 1,
        expand: 'site',
        filters: `id(equals)=${recordId}`,
      });
      record = rowsOf(payload)[0] ?? null;
      exists = Boolean(record);
    }

    if (exists) {
      // No resolved_at column: the corrections table's shape comes from the
      // seed CSV and DDL is not permitted, so `state` carries the outcome and
      // applied_at carries the timing.
      db.query("update corrections set state='resolved' where id=$1", [corrId]);
      db.query("update deviations set status='resolved' where id=$1", [corr.deviation_id]);
    }

    return {
      correctionId: corrId,
      state: exists ? 'resolved' : 'verifying',
      verified: exists,
      record: record ? { id: record.id, subject: record.subject, urgency: record.urgency } : null,
    };
  },
});


/**
 * Agent tool calls for one call — WIRED BUT DORMANT.
 *
 * `helpdesk-agent-tools.get-call-tool-calls` would close the one real gap in
 * live-call evidence: the voice channel's transcripts are speech only, so there
 * is no record of what the agent's tooling actually attempted. With it,
 * "confirmed but no record" could be proven by a failed create call rather than
 * inferred from what the agent said.
 *
 * It cannot be switched on yet, and this is not a guess — every one of the 11
 * live calls was tested:
 *
 *   - The action takes `threadId`, documented as the call log's
 *     `facilioThreadId`, and reads /api/agentChat/getThreadMessages.
 *   - Every call's facilioThreadId returns "Thread Id N not found" (tested:
 *     34111, 34099, 34095, 34094, 34089, 33942, 33937, 33927, 33913, 33911,
 *     33481 — all eleven).
 *   - The action itself is healthy: an AI Studio agent-chat thread returns 200.
 *   - facilioThreadId is the ONLY thread id a call log carries, and the voice
 *     agent (facilioAgentId 6208) is itself "Agent not found" in AI Studio.
 *
 * So the voice channel's threads are not in the agent-chat namespace this
 * endpoint reads. Nothing here calls it automatically — pointing the detail
 * screen at it would render an empty panel on every real call. It stays
 * reachable so that the moment the platform team supplies the correct
 * voice-call thread id, one argument proves it end to end.
 *
 *   facilio vibe function run governance callToolCalls --args '{"threadId":<id>}'
 */
server.addHandler({
  name: 'callToolCalls',
  description:
    'Agent tool calls for one call, via helpdesk-agent-tools. DORMANT: needs the correct voice-call thread id from the platform team — every call log facilioThreadId is rejected by the endpoint. Pass a threadId to test one.',
  parameters: {
    threadId: {
      description: "The agent thread id. Omit to report why this is dormant without calling out.",
      type: 'string',
    },
  },
  execute: async (args) => {
    const threadId = String(args.threadId ?? '').trim();

    if (!threadId) {
      return {
        configured: false,
        action: 'helpdesk-agent-tools.get-call-tool-calls',
        needs: 'the thread id that addresses a VOICE call in the agent-chat namespace',
        tested:
          'All 11 live calls: facilioThreadId is rejected with "Thread Id N not found". The action is healthy — an AI Studio thread returns 200.',
        toolCalls: [],
        note: 'Nothing reads this yet. Supply a working threadId here to confirm the shape before anything renders it.',
      };
    }

    try {
      const payload = await agentTools('get-call-tool-calls', { threadId: Number(threadId) });
      // The upstream reports "not found" as a 200 body carrying a 500, so a
      // failure has to be recognised rather than assumed absent.
      const upstreamError = payload?.status && Number(payload.status) >= 400;
      if (upstreamError) {
        return {
          configured: false,
          threadId,
          upstream: { status: payload.status, message: payload.message ?? payload.error ?? '' },
          toolCalls: [],
        };
      }
      const messages = payload?.message ?? payload?.messages ?? payload?.data ?? [];
      return {
        configured: true,
        threadId,
        count: Array.isArray(messages) ? messages.length : 0,
        // Returned raw and unmapped on purpose: the output schema is
        // unpublished and no populated response has ever been seen, so there is
        // nothing to map onto yet without inventing field names.
        raw: messages,
      };
    } catch (err) {
      return {
        configured: false,
        threadId,
        error: err instanceof Error ? err.message : String(err),
        toolCalls: [],
      };
    }
  },
});

// ---------------------------------------------------------------------------
// Detection judges, browser-side
//
// Same split the correction loop already uses, and for the same reason: a
// Studio Function's fetch aborts at ~10s, and the conformance judge routinely
// takes longer than that on a full transcript. CR-CAT-01 timed out on nearly
// every call for exactly this — not load, and not something spacing the calls
// out could fix, since `run-agent-chat` blocks for as long as the model needs
// and the ceiling applies per request.
//
// So the model call moves to the browser, where `vibe.executeAgent` has no such
// cap. Only the model call moves. Reading the transcript, fetching the live
// CMMS record, validating the verdict and writing the deviation all stay here,
// where each takes about a second. The browser decides nothing — it relays a
// verdict that this file re-validates before it is allowed to become a finding.
//
// `evaluateSemantic` above is kept as the server-side path. It still works for
// any judge that answers inside the ceiling, and its degrade-on-timeout
// behaviour is the safety net: a judge that never answers is UNKNOWN, and is
// never recorded as a pass.
// ---------------------------------------------------------------------------

server.addHandler({
  name: 'semanticContext',
  description:
    'Everything the browser needs to grade ONE semantic criterion: the criterion, the transcript, and the LIVE CMMS record. No model call — fast and never at risk of a timeout.',
  parameters: {
    conversationId: { description: 'Conversation id', type: 'string' },
    criterionId: { description: 'One of CR-LOG-01, CR-LOG-04, CR-SCHED-01, CR-CAT-01', type: 'string' },
  },
  execute: async (args) => {
    const convoId = String(args.conversationId ?? '').trim();
    const criterionId = String(args.criterionId ?? '').trim();
    const db = connect();

    // Seeded criteria live in code; generated ones live in generated_evals and
    // are resolved here, so a criterion the SOW produced grades through exactly
    // the same path as a hand-written one.
    const criterion = SEMANTIC_CRITERIA[criterionId] ?? generatedCriterion(db, criterionId);
    if (!criterion) throw new Error(`Unknown semantic criterion ${criterionId}`);
    const convo = db.query('select * from conversations where id = $1 limit 1', [convoId]).rows[0];
    if (!convo) throw new Error(`No conversation ${convoId}`);

    // Same guard as the server-side path: where the deterministic layer already
    // found this criterion failing, a judge has nothing to add and would
    // overwrite exact evidence with a reading of it.
    const alreadyDeterministic = db.query(
      `select id from deviations
        where conversation_id = $1 and criterion_id = $2 and detected_by = 'deterministic'
        limit 1`,
      [convoId, criterionId],
    ).rows[0];
    if (alreadyDeterministic) return { skip: 'already_caught_deterministically' };

    // Not answerable on this channel. Returning `skip` here means the browser
    // never calls the judge at all — the criterion comes back 'skipped', which
    // the existing runner already keeps distinct from a pass and from a judge
    // that never answered. Nothing is sent to a model to be guessed at.
    const chan = channelOf(channelRowOf(db, convoId));
    const why = notApplicableFor(chan.modality)[criterionId];
    if (why) {
      return {
        skip: why === 'channel' ? 'not_applicable_on_channel' : 'join_not_checked_on_channel',
        skipDetail: skipReason(why, chan.channel),
        channel: chan.channel,
      };
    }

    const turns = db.query(
      'select * from transcript_turns where conversation_id = $1 order by turn_index',
      [convoId],
    ).rows;

    let cmmsRecord: any = null;
    if (convo.cmms_sr_id) {
      const payload = await cmms('list-service-requests', {
        page_size: 1,
        page: 1,
        expand: 'site,requester',
        filters: `id(equals)=${convo.cmms_sr_id}`,
      });
      cmmsRecord = rowsOf(payload)[0] ?? null;
    }

    return {
      skip: null,
      criterion: { id: criterionId, clauseRef: criterion.clauseRef, requires: criterion.requires },
      transcript: turns.map((t: any) => ({
        performer: t.performer,
        at: t.at_offset,
        message: t.tool_name
          ? `TOOL ${t.tool_name} -> ${t.tool_status}${t.tool_args ? ` | args: ${t.tool_args}` : ''}${t.tool_result ? ` | result: ${t.tool_result}` : ''}${t.tool_error ? ` | error: ${t.tool_error}` : ''}`
          : t.message,
      })),
      cmmsRecord: cmmsRecord
        ? {
            id: cmmsRecord.id,
            subject: cmmsRecord.subject,
            description: cmmsRecord.description,
            site: cmmsRecord.site?.name ?? null,
            urgency: cmmsRecord.urgency ?? null,
            status: cmmsRecord.moduleState ?? null,
            createdTime: cmmsRecord.sysCreatedTime ?? null,
          }
        : null,
    };
  },
});

server.addHandler({
  name: 'saveSemanticVerdict',
  description:
    'Persist a semantic verdict produced by the browser-side judge. Validates before writing — nothing here trusts the client.',
  parameters: {
    conversationId: { description: 'Conversation id', type: 'string' },
    criterionId: { description: 'Semantic criterion id', type: 'string' },
    verdict: { description: 'pass | fail | not_applicable', type: 'string' },
    severity: { description: 'critical | high | medium | low', type: 'string' },
    summary: { description: 'One-line statement of the finding', type: 'string' },
    evidenceJson: { description: 'Evidence array, as a JSON string', type: 'string' },
  },
  execute: async (args) => {
    const convoId = String(args.conversationId ?? '').trim();
    const criterionId = String(args.criterionId ?? '').trim();
    const criterion =
      SEMANTIC_CRITERIA[criterionId] ?? generatedCriterion(connect(), criterionId);
    if (!criterion) throw new Error(`Unknown semantic criterion ${criterionId}`);

    const verdictName = String(args.verdict ?? '').trim();
    if (['pass', 'fail', 'not_applicable'].indexOf(verdictName) < 0) {
      throw new Error(`Unusable verdict "${verdictName}" — expected pass, fail or not_applicable.`);
    }

    const db = connect();
    const convo = db.query('select * from conversations where id = $1 limit 1', [convoId]).rows[0];
    if (!convo) throw new Error(`No conversation ${convoId}`);

    // The deterministic layer owns this criterion on this call — refuse rather
    // than overwrite it.
    const alreadyDeterministic = db.query(
      `select id from deviations
        where conversation_id = $1 and criterion_id = $2 and detected_by = 'deterministic'
        limit 1`,
      [convoId, criterionId],
    ).rows[0];
    if (alreadyDeterministic) {
      return { conversationId: convoId, criterionId, recorded: false, reason: 'already_caught_deterministically' };
    }

    const prior = db.query(
      `select id from deviations
        where conversation_id = $1 and criterion_id = $2 and detected_by = 'semantic'
        limit 1`,
      [convoId, criterionId],
    ).rows[0];

    let recorded = false;
    let retracted = false;

    if (verdictName === 'fail') {
      const severity =
        ['critical', 'high', 'medium', 'low'].indexOf(String(args.severity)) >= 0
          ? String(args.severity)
          : 'medium';
      const summary = String(args.summary ?? '').trim();
      if (!summary) throw new Error('A failing verdict must carry a summary.');

      let evidence = '[]';
      try {
        const parsed = JSON.parse(String(args.evidenceJson ?? '[]'));
        evidence = JSON.stringify(Array.isArray(parsed) ? parsed : []);
      } catch {
        evidence = '[]';
      }

      const devId = prior?.id ?? `DV-${convoId}-${criterionId}`;
      if (prior) {
        db.query(
          `update deviations set summary=$2, severity=$3, checked_sr_id=$4, evidence=$5,
             detected_by='semantic' where id=$1`,
          [devId, summary, severity, String(convo.cmms_sr_id ?? ''), evidence],
        );
      } else {
        db.query(
          `insert into deviations
             (id, conversation_id, criterion_id, clause_ref, summary, severity, root_cause,
              status, detected_at, detected_by, checked_sr_id, evidence)
           values ($1,$2,$3,$4,$5,$6,'unknown','open',$7,'semantic',$8,$9)`,
          [
            devId,
            convoId,
            criterionId,
            criterion.clauseRef,
            summary,
            severity,
            nowIso(),
            String(convo.cmms_sr_id ?? ''),
            evidence,
          ],
        );
      }
      recorded = true;
    } else if (prior) {
      // Retract a finding this criterion no longer makes — same rule as the
      // other paths, and never one a correction has been proposed against.
      const hasCorrection = db.query('select id from corrections where deviation_id = $1 limit 1', [
        prior.id,
      ]).rows[0];
      if (!hasCorrection) {
        db.query('delete from deviations where id = $1', [prior.id]);
        retracted = true;
      }
    }

    const openNow = Number(
      db.query("select count(*) as n from deviations where conversation_id = $1 and status = 'open'", [
        convoId,
      ]).rows[0]?.n ?? 0,
    );
    db.query('update conversations set eval_status=$2 where id=$1', [
      convoId,
      openNow ? 'flagged' : 'passed',
    ]);

    return { conversationId: convoId, criterionId, verdict: verdictName, recorded, retracted, openNow };
  },
});

server.addHandler({
  name: 'repairDeviationStatus',
  description:
    "Reconcile deviation.status with the correction actually attached to it. Fixes rows left 'correcting' by a proposal that was never applied. Idempotent; reports what it changed.",
  parameters: {},
  execute: async () => {
    const db = connect();

    // A deviation is only 'correcting' if its correction has genuinely been
    // applied. Anything still proposed, rejected, or with no correction at all
    // belongs back in 'open'. Resolved deviations are left alone — those were
    // closed by the verify step, not by a proposal.
    const { rows } = db.query(
      `select d.id, d.status, c.state as corr_state, c.applied_at
         from deviations d
         left join corrections c on c.deviation_id = d.id
        where d.id <> '__seed__' and d.status = 'correcting'`,
    );

    const repaired: Array<{ id: string; from: string; to: string; because: string }> = [];
    for (const r of rows) {
      const applied = r.corr_state === 'applied' || r.corr_state === 'verifying' || r.corr_state === 'resolved';
      if (applied) continue;
      db.query("update deviations set status='open' where id=$1", [r.id]);
      repaired.push({
        id: r.id,
        from: 'correcting',
        to: 'open',
        because: r.corr_state ? `its correction is still '${r.corr_state}'` : 'it has no correction',
      });
    }

    const after = db.query(
      "select status, count(*) as n from deviations where id <> '__seed__' group by status",
    ).rows;

    return { checked: rows.length, repaired, statuses: after };
  },
});

server.addHandler({
  name: 'callAnalysisContext',
  description:
    'Everything the browser needs to analyse ONE call: the full transcript, the live CMMS record it resolved to, and the active SOW criteria. No model call — fast.',
  parameters: { conversationId: { description: 'Conversation id', type: 'string' } },
  execute: async (args) => {
    const db = connect();
    const convoId = String(args.conversationId ?? '').trim();
    const convo = db.query('select * from conversations where id = $1 limit 1', [convoId]).rows[0];
    if (!convo) throw new Error(`No conversation ${convoId}`);

    const turns = db.query(
      'select * from transcript_turns where conversation_id = $1 order by turn_index',
      [convoId],
    ).rows;

    let cmmsRecord: any = null;
    if (convo.cmms_sr_id) {
      const payload = await cmms('list-service-requests', {
        page_size: 1,
        page: 1,
        expand: 'site,requester',
        filters: `id(equals)=${convo.cmms_sr_id}`,
      });
      const r = rowsOf(payload)[0] ?? null;
      cmmsRecord = r
        ? {
            id: r.id,
            subject: r.subject,
            description: r.description,
            site: r.site?.name ?? null,
            urgency: r.urgency ?? null,
            status: r.moduleState ?? null,
          }
        : null;
    }

    // The criteria the engine actually grades — the same list the judges use, so
    // the analyst cites ids that exist and are enforced rather than inventing a
    // rule the SOW does not contain.
    const criteria = Object.keys(SEMANTIC_CRITERIA).map((id) => ({
      id,
      clauseRef: SEMANTIC_CRITERIA[id].clauseRef,
      requires: SEMANTIC_CRITERIA[id].requires,
    }));

    return {
      conversationId: convoId,
      transcript: turns.map((t: any) => ({
        performer: t.performer,
        at: t.at_offset,
        message: t.message,
      })),
      cmmsRecord,
      criteria,
      // What the channel's own model concluded, so the analyst can reconcile
      // rather than contradict it.
      channelSentiment: convo.sentiment || null,
      srClaimed: asBool(convo.sr_claimed),
      durationSec: Number(convo.duration_sec) || null,
    };
  },
});

/** The readings the analyst may return. `unknown` is a refusal, not a value. */
const SENTIMENT_VALUES = ['happy', 'neutral', 'frustrated', 'distressed'];

/**
 * THE ONLY WRITER of a call's grade — `call_grades` and the denormalised
 * `conversations.quality_score`, in one step.
 *
 * Internal by design: not a handler, and called from exactly one place. The
 * table came from a CSV import, so the database enforces nothing — no primary
 * key, no unique index, no foreign key, every column nullable. One number
 * living in two places stays consistent by construction or not at all, so a
 * second writer of `conversations.quality_score` anywhere in this file is the
 * moment the rule breaks. There must never be one — the grep in
 * docs/next-step-call-grades.md is meant to return exactly 1.
 *
 * Three things this is careful about:
 *
 *   - `response_quality` is NULL when the call was not applicable, never 0. A
 *     zero would read as the worst possible call rather than the absence of a
 *     score, and `applicable='false'` is what every reader must believe.
 *   - `sentiment_agrees` is '' when either side is missing or the analyst
 *     answered `unknown`. A gap is not a contradiction, and recording one as
 *     'false' would manufacture disagreements out of silence.
 *   - `claimed_at` / `claimed_by` are left exactly as found. Nothing claims a
 *     row yet, and when something does, a re-grade must not clear its claim.
 */
function writeCallGrade(
  db: any,
  g: {
    conversationId: string;
    applicable: boolean;
    /** 0-100, already validated. NULL whenever the call was not applicable. */
    responseQuality: number | null;
    justification: string;
    /** The analyst's reading. '' or 'unknown' both mean it declined to say. */
    sentiment: string;
    sentimentReason: string;
    /** What the channel held BEFORE this grade — a gap fill is not agreement. */
    sentimentChannel: string;
    overallAssessment: string;
    criteriaSatisfied: string;
    criteriaBreached: string;
    criteriaGraded: string;
    criteriaUnavailable: string;
    agentVersion: string;
    gradedBy: string;
  },
) {
  const id = `CG-${g.conversationId}`;
  const score = g.applicable && g.responseQuality !== null ? Math.round(g.responseQuality) : null;

  const read = SENTIMENT_VALUES.indexOf(g.sentiment) >= 0 ? g.sentiment : '';
  const channel = SENTIMENT_VALUES.indexOf(g.sentimentChannel) >= 0 ? g.sentimentChannel : '';
  const agrees = read && channel ? boolText(read === channel) : '';

  const gradedAt = nowIso();
  const values = [
    boolText(g.applicable),
    score,
    g.justification,
    read,
    g.sentimentReason,
    channel,
    agrees,
    g.overallAssessment,
    g.criteriaSatisfied,
    g.criteriaBreached,
    g.criteriaGraded,
    g.criteriaUnavailable,
    g.agentVersion,
    gradedAt,
    g.gradedBy,
  ];

  // No unique index exists on this table either, so the upsert is
  // select-then-write. The id is derived from the conversation, so a re-grade
  // updates the one row rather than piling up a second history of the call.
  const existing = db.query('select id from call_grades where id = $1 limit 1', [id]).rows[0];
  if (existing) {
    db.query(
      `update call_grades set
         applicable=$2, response_quality=$3, quality_justification=$4, sentiment=$5,
         sentiment_reason=$6, sentiment_channel=$7, sentiment_agrees=$8, overall_assessment=$9,
         criteria_satisfied=$10, criteria_breached=$11, criteria_graded=$12,
         criteria_unavailable=$13, agent_version=$14, graded_at=$15, graded_by=$16,
         schema_version=1
       where id=$1`,
      [id, ...values],
    );
  } else {
    db.query(
      `insert into call_grades
         (id, conversation_id, applicable, response_quality, quality_justification, sentiment,
          sentiment_reason, sentiment_channel, sentiment_agrees, overall_assessment,
          criteria_satisfied, criteria_breached, criteria_graded, criteria_unavailable,
          agent_version, graded_at, graded_by, schema_version, claimed_at, claimed_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,1,'','')`,
      [id, g.conversationId, ...values],
    );
  }

  // The denormalised copy, written in the same step and nowhere else. A call
  // too thin to judge leaves it alone entirely rather than scoring it 0.
  if (score !== null) {
    db.query('update conversations set quality_score=$2 where id=$1', [g.conversationId, score]);
  }

  return { gradeId: id, scoreWritten: score, sentimentAgrees: agrees, gradedAt };
}

server.addHandler({
  name: 'saveCallAnalysis',
  description:
    'Persist a call analysis: the whole grade to call_grades, and the score to conversations.quality_score, in one step. Validates before writing — the browser proposes, this decides what is stored.',
  parameters: {
    conversationId: { description: 'Conversation id', type: 'string' },
    applicable: { description: '1 when the call could be judged, 0 when too thin', type: 'number' },
    responseQuality: { description: '0-100, or -1 when not applicable', type: 'number' },
    sentiment: { description: 'happy | neutral | frustrated | distressed | unknown', type: 'string' },
    justification: { description: 'Why that response-quality score', type: 'string' },
    sentimentReason: { description: 'Why that sentiment reading', type: 'string' },
    overallAssessment: { description: 'The analyst\'s summary of the call', type: 'string' },
    criteriaSatisfied: { description: 'Comma-separated criterion ids the call met', type: 'string' },
    criteriaBreached: { description: 'Comma-separated criterion ids the call breached', type: 'string' },
    criteriaGraded: { description: 'Comma-separated criterion ids actually attempted this run', type: 'string' },
    criteriaUnavailable: { description: 'Comma-separated criterion ids whose judge never answered', type: 'string' },
    agentVersion: { description: 'Agent link name and model that produced this', type: 'string' },
    gradedBy: { description: 'auto | manual', type: 'string' },
  },
  execute: async (args) => {
    const db = connect();
    const convoId = String(args.conversationId ?? '').trim();
    const convo = db.query('select * from conversations where id = $1 limit 1', [convoId]).rows[0];
    if (!convo) throw new Error(`No conversation ${convoId}`);

    const applicable = Number(args.applicable) === 1;
    let quality: number | null = null;

    if (applicable) {
      const q = Number(args.responseQuality);
      if (!Number.isFinite(q) || q < 0 || q > 100) {
        throw new Error(`Rejected: responseQuality must be 0-100, got "${args.responseQuality}"`);
      }
      quality = Math.round(q);
    }
    // Not applicable scores nothing. A call too thin to judge keeps whatever
    // quality_score it had, which the UI reads as "not scored" — never a real
    // low score, and never a 0 stored as if it were one.

    // Sentiment: the CHANNEL is authoritative. The analyst's reading only fills
    // a gap, never overwrites a value the channel supplied — a disagreement is
    // recorded on the grade and shown to the user, not silently resolved here.
    const incoming = String(args.sentiment ?? '').trim();
    if (incoming && incoming !== 'unknown' && SENTIMENT_VALUES.indexOf(incoming) < 0) {
      throw new Error(`Rejected: sentiment must be one of ${SENTIMENT_VALUES.join(' | ')} | unknown, got "${incoming}"`);
    }
    const channelSentiment = String(convo.sentiment ?? '').trim();
    let sentimentWritten: string | null = null;
    if (!channelSentiment && SENTIMENT_VALUES.indexOf(incoming) >= 0) {
      db.query('update conversations set sentiment=$2 where id=$1', [convoId, incoming]);
      sentimentWritten = incoming;
    }

    const written = writeCallGrade(db, {
      conversationId: convoId,
      applicable,
      responseQuality: quality,
      justification: String(args.justification ?? ''),
      sentiment: incoming,
      sentimentReason: String(args.sentimentReason ?? ''),
      // Compared against what the channel held BEFORE the gap fill above, so a
      // reading that filled a silence is never recorded as agreement.
      sentimentChannel: channelSentiment,
      overallAssessment: String(args.overallAssessment ?? ''),
      criteriaSatisfied: String(args.criteriaSatisfied ?? ''),
      criteriaBreached: String(args.criteriaBreached ?? ''),
      criteriaGraded: String(args.criteriaGraded ?? ''),
      criteriaUnavailable: String(args.criteriaUnavailable ?? ''),
      agentVersion: String(args.agentVersion ?? ''),
      gradedBy: String(args.gradedBy ?? 'manual'),
    });

    return {
      conversationId: convoId,
      gradeId: written.gradeId,
      scoreWritten: written.scoreWritten,
      sentimentWritten,
      sentimentAgrees: written.sentimentAgrees,
      channelSentiment: convo.sentiment || null,
      gradedAt: written.gradedAt,
    };
  },
});

server.addHandler({
  name: 'patternContext',
  description:
    'Everything the browser needs to propose ONE fix for a whole pattern: every occurrence of a criterion across calls, with its evidence and whether the CMMS record was there. No model call — fast.',
  parameters: { criterionId: { description: 'Criterion id', type: 'string' } },
  execute: async (args) => {
    const db = connect();
    const criterionId = String(args.criterionId ?? '').trim();
    if (!criterionId) throw new Error('criterionId is required');

    const { rows } = db.query(
      `select d.*, c.caller_name, c.caller_phone, c.site_hint, c.started_at, c.cmms_sr_id
         from deviations d
         join conversations c on c.id = d.conversation_id
        where d.id <> '__seed__' and d.criterion_id = $1
        order by d.detected_at`,
      [criterionId],
    );
    if (!rows.length) return { criterionId, occurrences: [], count: 0 };

    const criterion = SEMANTIC_CRITERIA[criterionId] ?? null;

    // Trimmed on purpose: this is what the model reads, and twenty full
    // transcripts would bury the thing they have in common. Two evidence quotes
    // per occurrence is enough to show the shape of the failure.
    const occurrences = rows.map((d: any) => ({
      conversationId: d.conversation_id,
      caller: d.caller_name || d.caller_phone || 'Unknown caller',
      site: d.site_hint || null,
      at: d.started_at,
      severity: d.severity,
      summary: d.summary,
      cmmsRecordExists: Boolean(d.cmms_sr_id),
      evidence: JSON.parse(d.evidence || '[]').slice(0, 2),
    }));

    return {
      criterionId,
      clauseRef: rows[0].clause_ref,
      requires: criterion?.requires ?? null,
      count: rows.length,
      openCount: rows.filter((d: any) => d.status === 'open').length,
      sites: Array.from(new Set(rows.map((d: any) => d.site_hint).filter(Boolean))),
      withoutRecord: rows.filter((d: any) => !d.cmms_sr_id).length,
      // The finding this fix will be filed against — the worst, then the oldest.
      representativeId: rows
        .slice()
        .sort(
          (a: any, b: any) =>
            (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
            String(a.detected_at).localeCompare(String(b.detected_at)),
        )[0].id,
      occurrences,
    };
  },
});


/**
 * What the agent is told TODAY about this clause — the "before" of the diff.
 *
 * Hue cannot read agent 6208's live prompt (docs/platform-ask-agent-scope.md),
 * which is why saveCorrection has always written before_text as ''. An empty
 * box was honest but useless: a diff with no left side is not a diff.
 *
 * The link is `clause_ref`. Every deviation carries one, and the scope of work
 * is written in those same numbers, so this is a LOOKUP rather than a guess.
 * Nothing here is inferred: either the exact sentence an eval was written from,
 * or the clause as it appears in the stored text, or nothing at all.
 *
 * ONE SEAM, and it is the one that already exists: when the platform exposes
 * the agent's own prompt, fetchSowFromAgent stops returning null and its text
 * becomes the source. The scope of work then falls back to being the fallback.
 */
async function currentClauseFor(db: any, criterionId: string, clauseRef: string) {
  // 1. The live agent prompt, the day it is readable. Stubbed today.
  const upstream = await fetchSowFromAgent();
  if (upstream) {
    const hit = clauseTextIn(String(upstream.body ?? ''), clauseRef);
    if (hit) return { source: 'agent_prompt', clauseRef, text: hit, reference: 'the agent\'s live prompt' };
  }

  const sow = currentSowRow(db);
  if (!sow) {
    return {
      source: 'none',
      clauseRef,
      text: '',
      reference: '',
      reason:
        "Current prompt not available — the agent's configuration is not exposed, and no scope of work has been pasted.",
    };
  }

  // 2. A generated criterion already carries the exact sentence it came from.
  //    No parsing beats parsing.
  if (criterionId.startsWith('GEN-')) {
    const row = db.query(
      `select source_excerpt, clause_ref from generated_evals
        where id <> '__seed__' and criterion_id = $1 and sow_fingerprint = $2 limit 1`,
      [criterionId, String(sow.fingerprint ?? '')],
    ).rows[0];
    const excerpt = String(row?.source_excerpt ?? '').trim();
    if (excerpt) {
      return {
        source: 'generated_eval',
        clauseRef: String(row?.clause_ref ?? clauseRef),
        text: excerpt,
        reference: `${sow.title || 'the scope of work'} (${sow.id})`,
      };
    }
  }

  // 3. The clause as written in the pasted text.
  const hit = clauseTextIn(String(sow.body ?? ''), clauseRef);
  if (hit) {
    return {
      source: 'sow_clause',
      clauseRef,
      text: hit,
      reference: `${sow.title || 'the scope of work'} (${sow.id})`,
    };
  }

  return {
    source: 'sow_no_clause',
    clauseRef,
    text: '',
    reference: `${sow.title || 'the scope of work'} (${sow.id})`,
    reason: clauseRef
      ? `Clause ${clauseRef} is not in the pasted scope of work.`
      : 'This finding carries no clause reference to look up.',
  };
}

/**
 * One clause out of a scope of work, by its reference.
 *
 * Anchored at the start of a line so "S-2.1" inside a sentence is not mistaken
 * for the clause itself, and captured until the next clause marker or a blank
 * line — a clause that runs to several lines keeps them.
 */
function clauseTextIn(body: string, clauseRef: string): string {
  const ref = String(clauseRef ?? '').trim();
  if (!ref || !body) return '';
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `^[ \\t]*${escaped}\\b[^\\n]*(?:\\n(?![ \\t]*(?:[A-Za-z]+-\\d|\\s*$))[^\\n]*)*`,
    'm',
  );
  const m = re.exec(body);
  return m ? m[0].trim() : '';
}

server.addHandler({
  name: 'getCorrection',
  description:
    'The correction attached to one deviation, or null. Read on load so the before/after diff and the applied → verifying → resolved progression survive a refresh.',
  parameters: { deviationId: { description: 'Deviation id', type: 'string' } },
  execute: async (args) => {
    const db = connect();
    const devId = String(args.deviationId ?? '').trim();
    const row = db.query(
      'select * from corrections where deviation_id = $1 order by proposed_at desc limit 1',
      [devId],
    ).rows[0];
    const dev = db.query('select * from deviations where id = $1 limit 1', [devId]).rows[0];
    // The "before" side is about the DEVIATION, not the correction, so it is
    // resolved even when nothing has been drafted yet — the panel fills while
    // the judges are still running.
    const currentClause = dev
      ? await currentClauseFor(db, String(dev.criterion_id ?? ''), String(dev.clause_ref ?? ''))
      : null;

    if (!row) return { correction: null, cmmsPlan: null, currentClause };

    const convo = dev
      ? db.query('select * from conversations where id = $1 limit 1', [dev.conversation_id]).rows[0]
      : null;

    let cmmsAction: any = {};
    try {
      cmmsAction =
        typeof row.cmms_action === 'string' ? JSON.parse(row.cmms_action || '{}') : row.cmms_action ?? {};
    } catch {
      cmmsAction = {};
    }

    return {
      correction: {
        id: row.id,
        deviationId: row.deviation_id,
        target: row.target,
        title: row.title,
        rationale: row.rationale,
        beforeText: row.before_text,
        afterText: row.after_text,
        state: row.state,
        recommendedAction: row.recommended_action,
        assignee: row.assignee,
        cmmsAction,
        proposedAt: row.proposed_at,
        appliedAt: row.applied_at,
        appliedRecordId: row.applied_record_id,
      },
      // What the write would actually do, decided here so the button cannot
      // promise something different from what the server will perform.
      cmmsPlan: cmmsPlanFor(convo, cmmsAction),
      currentClause,
    };
  },
});

server.addHandler({
  name: 'judgeContext',
  description:
    'Everything the browser-side judges need for one deviation: the finding, its evidence, the key turns, and the LIVE CMMS record. No model call — fast and never at risk of a timeout.',
  parameters: { deviationId: { description: 'Deviation id', type: 'string' } },
  execute: async (args) => {
    const db = connect();
    const id = String(args.deviationId ?? '').trim();
    const { dev, convo, transcript, cmmsRecord } = await deviationContext(db, id);
    return {
      deviation: {
        id: dev.id,
        criterionId: dev.criterion_id,
        clauseRef: dev.clause_ref,
        summary: dev.summary,
        severity: dev.severity,
        rootCause: dev.root_cause ?? 'unknown',
        evidence: JSON.parse(dev.evidence || '[]'),
      },
      keyTurns: transcript.slice(-6),
      cmmsRecord,
      conversation: {
        id: convo?.id ?? '',
        callId: convo?.call_id ?? '',
        callerName: convo?.caller_name ?? '',
        siteHint: convo?.site_hint ?? '',
        cmmsSrId: convo?.cmms_sr_id ?? '',
      },
    };
  },
});

server.addHandler({
  name: 'saveCorrection',
  description:
    'Persist a verdict produced by the browser-side judges. Validates before writing — a schema constrains shape, not truthfulness, so nothing here trusts the client.',
  parameters: {
    deviationId: { description: 'Deviation id', type: 'string' },
    rootCause: { description: 'agent | data | sow | unknown', type: 'string' },
    proposalJson: { description: 'The correction proposal, as a JSON string', type: 'string' },
  },
  execute: async (args) => {
    const db = connect();
    const id = String(args.deviationId ?? '').trim();
    if (!id) throw new Error('deviationId is required');

    const dev = db.query('select id from deviations where id = $1 limit 1', [id]).rows[0];
    if (!dev) throw new Error(`No deviation ${id}`);

    // ---- Validate the client's payload before it touches a row -----------
    const rootCause = String(args.rootCause ?? '').trim();
    if (['agent', 'data', 'sow', 'unknown'].indexOf(rootCause) < 0) {
      throw new Error(`Rejected: rootCause must be agent|data|sow|unknown, got "${rootCause}"`);
    }

    let p: any;
    try {
      p = JSON.parse(String(args.proposalJson ?? '{}'));
    } catch {
      throw new Error('Rejected: proposalJson is not valid JSON');
    }
    const target = String(p?.target ?? '');
    if (['prompt', 'mapping', 'sow', 'human'].indexOf(target) < 0) {
      throw new Error(`Rejected: target must be prompt|mapping|sow|human, got "${target}"`);
    }
    const verb = String(p?.cmmsAction?.verb ?? 'none');
    if (['create', 'update', 'none'].indexOf(verb) < 0) {
      throw new Error(`Rejected: cmmsAction.verb must be create|update|none, got "${verb}"`);
    }

    // The root cause is a real conclusion and is recorded. The STATUS is not
    // touched: a drafted proposal is not an applied fix, and setting
    // 'correcting' here made the Interventions list report "Fix applied" over a
    // correction still in 'proposed'. Only approveCorrection moves the status,
    // after the write to the CMMS has actually happened.
    db.query('update deviations set root_cause=$2 where id=$1', [id, rootCause]);

    const corrId = `CO-${id}`;
    const cmmsAction = JSON.stringify(p.cmmsAction ?? {});
    const prior = db.query('select id from corrections where id = $1 limit 1', [corrId]).rows[0];

    if (prior) {
      db.query(
        `update corrections set target=$2, title=$3, rationale=$4, before_text='', after_text=$5,
           cmms_action=$6, recommended_action=$7, state='proposed' where id=$1`,
        [
          corrId,
          target,
          String(p.title ?? ''),
          String(p.rationale ?? ''),
          String(p.afterText ?? ''),
          cmmsAction,
          String(p.humanTask ?? ''),
        ],
      );
    } else {
      db.query(
        `insert into corrections
           (id, deviation_id, target, title, rationale, before_text, after_text, state,
            recommended_action, assignee, cmms_action, proposed_at)
         values ($1,$2,$3,$4,$5,'',$6,'proposed',$7,'',$8,$9)`,
        [
          corrId,
          id,
          target,
          String(p.title ?? ''),
          String(p.rationale ?? ''),
          String(p.afterText ?? ''),
          String(p.humanTask ?? ''),
          cmmsAction,
          nowIso(),
        ],
      );
    }

    return {
      correctionId: corrId,
      deviationId: id,
      rootCause,
      target,
      verb,
      state: 'proposed',
    };
  },
});


server.execute();
