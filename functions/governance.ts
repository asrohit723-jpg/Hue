/**
 * Hue — governance engine.
 *
 * SINGLE SOURCE OF TRUTH: the CMMS. Every service request, site, category and
 * status in this file is fetched live from `facilio-cmms` at call time. The app
 * database holds only transcripts (the claim) and Hue's own findings. There is
 * no cached copy of a CMMS record anywhere below, deliberately — a ground-truth
 * check that reads a copy is not a ground-truth check.
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
  if (s.includes('VERY_DISSATISFIED') || s.includes('ANGRY')) return 'distressed';
  if (s.includes('DISSATISFIED') || s.includes('FRUSTRAT')) return 'frustrated';
  if (s.includes('SATISFIED') || s.includes('HAPPY')) return 'happy';
  if (s) return 'neutral';
  return '';
}

/**
 * Call an AI Studio action through the same connections service.
 *
 * The probe showed process.system provides AGENTS_TOKEN but NOT AGENTS_URL, so
 * the documented `${process.system.AGENTS_URL}` path does not exist from a
 * function. Rather than guess a hostname — which the authoring guide explicitly
 * forbids — the judges are reached as connection actions on facilio-ai-studio,
 * over the CONNECTIONS_URL the platform does provide.
 */
async function aiStudio(actionSlug: string, input: Record<string, unknown>): Promise<any> {
  const res = await fetch(
    `${process.system.CONNECTIONS_URL}/api/v1/connections/facilio-ai-studio/actions/${actionSlug}/execute`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    },
  );
  if (!res.ok) {
    throw new Error(`AI Studio ${actionSlug} failed: ${res.status} ${res.statusText}`);
  }
  return await res.json();
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
/**
 * Marker prefix on a thrown message so the UI can tell a timeout (retryable,
 * nothing is known) from a real failure (bad data, unusable verdict). Both are
 * errors — neither is ever a pass — but they warrant different wording and
 * different affordances in front of a user.
 */
export const JUDGE_TIMEOUT = 'JUDGE_TIMEOUT';

/** The sandbox reports its fetch ceiling as an abort. */
function isTimeout(message: string): boolean {
  return /abort|timed? ?out|ETIMEDOUT/i.test(message);
}

async function runJudgeWithRetry(
  agentLinkName: string,
  message: string,
  attempts = 3,
): Promise<any> {
  let lastError = '';
  let sawTimeout = false;
  for (let i = 0; i < attempts; i++) {
    try {
      return await runJudge(agentLinkName, message);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (isTimeout(lastError)) sawTimeout = true;
      console.log(`judge ${agentLinkName} attempt ${i + 1}/${attempts} failed: ${lastError}`);
    }
  }
  // Tagged so the caller can render "couldn't complete, retry" rather than a
  // generic failure — and so nothing downstream can mistake this for a verdict.
  throw new Error(
    `${sawTimeout ? JUDGE_TIMEOUT + ': ' : ''}Judge ${agentLinkName} did not complete after ` +
      `${attempts} attempts — treat as UNKNOWN, never as pass. Last error: ${lastError}`,
  );
}

async function runJudge(agentLinkName: string, message: string): Promise<any> {
  const thread = await aiStudio('create-chat-thread', { agent: agentLinkName });
  // Verified shape: { thread: { id, link_name, ... } }. The other spellings are
  // kept as fallbacks so a wrapper change degrades to a clear error, not a crash.
  const threadId =
    thread?.thread?.id ??
    thread?.data?.thread?.id ??
    thread?.data?.id ??
    thread?.id ??
    null;
  if (!threadId) {
    throw new Error(`create-chat-thread returned no thread id: ${JSON.stringify(thread).slice(0, 300)}`);
  }

  const run = await aiStudio('run-agent-chat', {
    threadId: Number(threadId),
    agent: agentLinkName,
    message,
  });

  // Verified shape: { content: "<json string>" }. Structured-output agents
  // return content as a STRING, never a nested object — the parse below is
  // required, not defensive.
  const content =
    run?.content ??
    run?.data?.content ??
    run?.response?.content ??
    run?.data?.response?.content ??
    null;
  if (typeof content !== 'string') {
    throw new Error(`Judge returned no string content: ${JSON.stringify(run).slice(0, 300)}`);
  }
  try {
    return { verdict: JSON.parse(content), threadId };
  } catch {
    throw new Error(`Judge content was not valid JSON: ${content.slice(0, 300)}`);
  }
}

/** Booleans round-trip as text through a CSV-inferred column. */
const asBool = (v: unknown) => v === true || v === 'true';
const boolText = (v: boolean) => (v ? 'true' : 'false');

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

server.addHandler({
  name: 'evaluate',
  description:
    'Join one stored transcript to its REAL CMMS service request and run the deterministic checks against that live record.',
  parameters: { conversationId: { description: 'Conversation id', type: 'string' } },
  execute: async (args) => {
    const convoId = String(args.conversationId ?? '').trim();
    if (!convoId) throw new Error('conversationId is required');

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

    // ---- 1. Resolve the join against the LIVE CMMS -----------------------
    // Strongest signal first: the SR number the agent read back. Falling back
    // to site + time window, which is weaker and recorded as such.
    let matched: any = null;
    let joinMethod = 'none';
    let joinConfidence = 0;

    const claimedNumber = String(convo.sr_number_claimed ?? '').trim();

    if (claimedNumber) {
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
    if (srClaimed && !matched) {
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
    if (confirmedWithoutId) {
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
    if (String(convo.status ?? '') === 'dropped' && !matched) {
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

    if (missing.length && callerSpoke) {
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
    db.query('update conversations set eval_status=$2 where id=$1', [
      convoId,
      openNow ? 'flagged' : 'passed',
    ]);

    return {
      conversationId: convoId,
      join: { cmmsSrId: srId || null, method: joinMethod, confidence: joinConfidence },
      checksRun: 3,
      deviationsFound: written,
      retracted,
      findings: findings.map((f) => ({
        criterionId: f.criterionId,
        severity: f.severity,
        summary: f.summary,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

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
        `select count(*) as n from conversations c
          where c.id <> '__seed__' and c.eval_status <> 'not_evaluated'
            and not exists (
              select 1 from deviations d
               where d.conversation_id = c.id and d.status = 'open')`,
      ).rows[0]?.n ?? 0,
    );

    const coverage = convoCount ? Math.round((evaluated / convoCount) * 100) : 0;
    const compliance = evaluated ? Math.round((cleanCalls / evaluated) * 100) : 100;

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
      sites,
      isFirstRun: convoCount === 0,
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
    const { rows } = db.query(
      `select c.*,
              (select count(*) from deviations d where d.conversation_id = c.id) as deviation_count,
              (select t.message
                 from transcript_turns t
                where t.conversation_id = c.id and t.performer = 'caller'
                order by t.turn_index
                limit 1) as snippet
         from conversations c
        where c.id <> '__seed__'
        order by c.started_at desc
        limit $1`,
      [limit],
    );
    return { items: rows };
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
    if (isLive && convo.call_id) {
      try {
        const payload = await callLogs('get-call-log', { callLogId: Number(convo.call_id) });
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
      deviations: deviations.map((d: any) => ({ ...d, evidence: JSON.parse(d.evidence || '[]') })),
      cmmsRecord,
    };
  },
});

/** The semantic criteria, and the judge that grades each. */
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
};

const JUDGE_AGENT = 'sow-conformance-judge_4b48798f3211425e98520e3056ab02b4';

server.addHandler({
  name: 'evaluateSemantic',
  description:
    'Grade ONE semantic criterion for one conversation with the Claude judge, against the live CMMS record. One judge call per invocation, because fetches are serialized and each model call is slow.',
  parameters: {
    conversationId: { description: 'Conversation id', type: 'string' },
    criterionId: {
      description: 'One of CR-LOG-01, CR-LOG-04, CR-SCHED-01, CR-CAT-01',
      type: 'string',
    },
  },
  execute: async (args) => {
    const convoId = String(args.conversationId ?? '').trim();
    const criterionId = String(args.criterionId ?? '').trim();
    const criterion = SEMANTIC_CRITERIA[criterionId];
    if (!criterion) throw new Error(`Unknown semantic criterion ${criterionId}`);

    const db = connect();
    const convo = db.query('select * from conversations where id = $1 limit 1', [convoId]).rows[0];
    if (!convo) throw new Error(`No conversation ${convoId}`);

    // Where the deterministic layer has already found this criterion failing,
    // there is nothing for a judge to add — and both layers key their deviation
    // on (conversation, criterion), so running anyway would overwrite exact
    // evidence with a model's reading of it. This is what keeps CR-LOG-01's two
    // halves from colliding: the semantic pass only speaks where the
    // deterministic one stayed silent.
    const alreadyDeterministic = db.query(
      `select id from deviations
        where conversation_id = $1 and criterion_id = $2 and detected_by = 'deterministic'
        limit 1`,
      [convoId, criterionId],
    ).rows[0];
    if (alreadyDeterministic) {
      return {
        conversationId: convoId,
        criterionId,
        verdict: 'already_caught',
        recorded: false,
        note: 'The deterministic check already found this criterion failing on this call.',
      };
    }

    const turns = db.query(
      'select * from transcript_turns where conversation_id = $1 order by turn_index',
      [convoId],
    ).rows;

    // Ground truth, fetched live. The judge is told plainly that a null record
    // means no record exists — not that the lookup was skipped.
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

    const transcript = turns.map((t: any) => ({
      performer: t.performer,
      at: t.at_offset,
      message: t.tool_name
        ? `TOOL ${t.tool_name} -> ${t.tool_status}${t.tool_args ? ` | args: ${t.tool_args}` : ''}${t.tool_result ? ` | result: ${t.tool_result}` : ''}${t.tool_error ? ` | error: ${t.tool_error}` : ''}`
        : t.message,
    }));

    const record = cmmsRecord
      ? {
          id: cmmsRecord.id,
          subject: cmmsRecord.subject,
          description: cmmsRecord.description,
          site: cmmsRecord.site?.name ?? null,
          urgency: cmmsRecord.urgency ?? null,
          status: cmmsRecord.moduleState ?? null,
          createdTime: cmmsRecord.sysCreatedTime ?? null,
        }
      : null;

    const message = JSON.stringify({
      criterion: { id: criterionId, clauseRef: criterion.clauseRef, requires: criterion.requires },
      transcript,
      cmmsRecord: record,
    });

    const { verdict } = await runJudgeWithRetry(JUDGE_AGENT, message);

    // A schema constrains shape, not truthfulness — validate before it writes.
    const ok =
      verdict &&
      typeof verdict.verdict === 'string' &&
      ['pass', 'fail', 'not_applicable'].indexOf(verdict.verdict) >= 0;
    if (!ok) throw new Error(`Judge returned an unusable verdict: ${JSON.stringify(verdict).slice(0, 200)}`);

    if (verdict.verdict !== 'fail') {
      // Retract a finding this criterion no longer makes.
      //
      // Re-grading is normal — a judge is re-run after a timeout, or after the
      // record it reads has changed — and without this a fail recorded once
      // stays open for ever, even as the judge now passes the call. The
      // deterministic layer retracts its own findings for the same reason.
      //
      // Scope matches that layer: only this criterion, only semantic findings,
      // only while still open, and never one a correction has been proposed
      // against, since deleting that would cascade the correction away.
      const prior = db.query(
        `select id from deviations
          where conversation_id = $1 and criterion_id = $2
            and detected_by = 'semantic' and status = 'open'
          limit 1`,
        [convoId, criterionId],
      ).rows[0];

      let retracted = false;
      if (prior) {
        const hasCorrection = db.query(
          'select id from corrections where deviation_id = $1 limit 1',
          [prior.id],
        ).rows[0];
        if (!hasCorrection) {
          db.query('delete from deviations where id = $1', [prior.id]);
          retracted = true;

          // The call may have been the only thing keeping it flagged.
          const openNow = Number(
            db.query(
              "select count(*) as n from deviations where conversation_id = $1 and status = 'open'",
              [convoId],
            ).rows[0]?.n ?? 0,
          );
          if (!openNow) {
            db.query("update conversations set eval_status='passed' where id=$1", [convoId]);
          }
        }
      }

      return {
        conversationId: convoId,
        criterionId,
        verdict: verdict.verdict,
        recorded: false,
        retracted,
      };
    }

    const severity =
      ['critical', 'high', 'medium', 'low'].indexOf(String(verdict.severity)) >= 0
        ? String(verdict.severity)
        : 'medium';

    const prior = db.query(
      'select id from deviations where conversation_id = $1 and criterion_id = $2 limit 1',
      [convoId, criterionId],
    ).rows[0];
    const devId = prior?.id ?? `DV-${convoId}-${criterionId}`;
    const evidence = JSON.stringify(Array.isArray(verdict.evidence) ? verdict.evidence : []);

    if (prior) {
      db.query(
        `update deviations set summary=$2, severity=$3, checked_sr_id=$4, evidence=$5,
           detected_by='semantic' where id=$1`,
        [devId, String(verdict.summary ?? ''), severity, String(convo.cmms_sr_id ?? ''), evidence],
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
          String(verdict.summary ?? ''),
          severity,
          nowIso(),
          String(convo.cmms_sr_id ?? ''),
          evidence,
        ],
      );
    }
    db.query('update conversations set eval_status=$2 where id=$1', [convoId, 'flagged']);

    return {
      conversationId: convoId,
      criterionId,
      verdict: 'fail',
      severity,
      confidence: verdict.confidence ?? null,
      summary: verdict.summary ?? '',
      recorded: true,
    };
  },
});

const ROOT_CAUSE_AGENT = 'root-cause-classifier_4b48798f3211425e98520e3056ab02b4';
const PROPOSER_AGENT = 'correction-proposer_4b48798f3211425e98520e3056ab02b4';

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

server.addHandler({
  name: 'classifyRootCause',
  description:
    'Ask the Claude classifier where a confirmed deviation belongs: agent, data, sow or unknown. One model call.',
  parameters: { deviationId: { description: 'Deviation id', type: 'string' } },
  execute: async (args) => {
    const db = connect();
    const id = String(args.deviationId ?? '').trim();
    const { dev, transcript, cmmsRecord } = await deviationContext(db, id);

    // Payload is deliberately small. The sandbox aborts a fetch at ~10s, and a
    // full transcript pushes the model past it. Evidence turns plus the live
    // record are what actually decide the cause; the rest is bulk.
    const message = JSON.stringify({
      deviation: {
        id: dev.id,
        criterionId: dev.criterion_id,
        clauseRef: dev.clause_ref,
        summary: dev.summary,
        severity: dev.severity,
        evidence: JSON.parse(dev.evidence || '[]'),
      },
      keyTurns: transcript.slice(-6),
      cmmsRecord,
    });

    const { verdict } = await runJudgeWithRetry(ROOT_CAUSE_AGENT, message);
    const rootCause = String(verdict?.rootCause ?? '');
    if (['agent', 'data', 'sow', 'unknown'].indexOf(rootCause) < 0) {
      throw new Error(`Classifier returned an unusable rootCause: ${rootCause}`);
    }

    db.query('update deviations set root_cause=$2 where id=$1', [id, rootCause]);
    return {
      deviationId: id,
      rootCause,
      rootCauseLabel: verdict.rootCauseLabel ?? '',
      needsHuman: verdict.needsHuman === true,
      confidence: verdict.confidence ?? null,
    };
  },
});

server.addHandler({
  name: 'proposeCorrection',
  description:
    'Ask the Claude proposer for a fix for a confirmed deviation. Stores it as `proposed` — applies nothing.',
  parameters: { deviationId: { description: 'Deviation id', type: 'string' } },
  execute: async (args) => {
    const db = connect();
    const id = String(args.deviationId ?? '').trim();
    const { dev, transcript, cmmsRecord } = await deviationContext(db, id);

    // Same size constraint as the classifier — see there.
    const message = JSON.stringify({
      deviation: {
        id: dev.id,
        criterionId: dev.criterion_id,
        clauseRef: dev.clause_ref,
        summary: dev.summary,
        severity: dev.severity,
        rootCause: dev.root_cause,
        evidence: JSON.parse(dev.evidence || '[]'),
      },
      keyTurns: transcript.slice(-6),
      cmmsRecord,
    });

    const { verdict } = await runJudgeWithRetry(PROPOSER_AGENT, message);
    const target = String(verdict?.target ?? '');
    if (['prompt', 'mapping', 'sow', 'human'].indexOf(target) < 0) {
      throw new Error(`Proposer returned an unusable target: ${target}`);
    }

    const corrId = `CO-${id}`;
    const cmmsAction = JSON.stringify(verdict.cmmsAction ?? {});
    const prior = db.query('select id from corrections where id = $1 limit 1', [corrId]).rows[0];

    // before_text is stored empty: the proposer is no longer asked to echo the
    // current text back, since quoting input we already hold cost output tokens
    // against a hard request ceiling for no information gain.
    if (prior) {
      db.query(
        `update corrections set target=$2, title=$3, rationale=$4, before_text='', after_text=$5,
           cmms_action=$6, recommended_action=$7, state='proposed' where id=$1`,
        [
          corrId,
          target,
          String(verdict.title ?? ''),
          String(verdict.rationale ?? ''),
          String(verdict.afterText ?? ''),
          cmmsAction,
          String(verdict.humanTask ?? ''),
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
          String(verdict.title ?? ''),
          String(verdict.rationale ?? ''),
          String(verdict.afterText ?? ''),
          String(verdict.humanTask ?? ''),
          cmmsAction,
          nowIso(),
        ],
      );
    }
    db.query("update deviations set status='correcting' where id=$1", [id]);

    return {
      correctionId: corrId,
      deviationId: id,
      target,
      title: verdict.title ?? '',
      cmmsAction: verdict.cmmsAction ?? null,
      humanTask: verdict.humanTask ?? '',
      state: 'proposed',
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
    const verb = String(action.verb ?? 'none');

    let appliedRecordId: string | null = null;

    if (verb === 'update' && convo?.cmms_sr_id) {
      // Only fields the proposer actually named, mapped to writeable ones.
      const fields: any[] = Array.isArray(action.fields) ? action.fields : [];
      const patch: Record<string, unknown> = {};
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
        } else if (label.indexOf('description') >= 0 || label.indexOf('window') >= 0) {
          patch.description = value.slice(0, 2000);
        }
      }
      if (Object.keys(patch).length) {
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

server.addHandler({
  name: 'runCorrection',
  description:
    'Classify the root cause and draft a correction in one pass, fetching the CMMS record once and reusing it for both judges. Returns partial progress if the second judge times out.',
  parameters: { deviationId: { description: 'Deviation id', type: 'string' } },
  execute: async (args) => {
    const db = connect();
    const id = String(args.deviationId ?? '').trim();
    // One memo for the whole request: the record is read once, both judges see
    // the same live snapshot, and nothing is persisted.
    const memo = makeRecordMemo();
    const { dev, transcript, cmmsRecord } = await deviationContext(db, id, memo);

    const base = {
      id: dev.id,
      criterionId: dev.criterion_id,
      clauseRef: dev.clause_ref,
      summary: dev.summary,
      severity: dev.severity,
      evidence: JSON.parse(dev.evidence || '[]'),
    };
    const keyTurns = transcript.slice(-6);

    // --- Stage 1: root cause -------------------------------------------------
    // Fetches are serialized by the platform, so these run one after another
    // whatever we do. Each stage is reported independently so a stage-2 timeout
    // never discards a successful stage 1.
    let rootCause = '';
    let classifyError: string | null = null;
    try {
      const { verdict } = await runJudgeWithRetry(
        ROOT_CAUSE_AGENT,
        JSON.stringify({ deviation: base, keyTurns, cmmsRecord }),
      );
      const rc = String(verdict?.rootCause ?? '');
      if (['agent', 'data', 'sow', 'unknown'].indexOf(rc) >= 0) {
        rootCause = rc;
        db.query('update deviations set root_cause=$2 where id=$1', [id, rc]);
      } else {
        classifyError = `Classifier returned an unusable rootCause: ${rc}`;
      }
    } catch (err) {
      classifyError = err instanceof Error ? err.message : String(err);
    }

    if (!rootCause) {
      return {
        deviationId: id,
        stage: 'classify',
        ok: false,
        error: classifyError,
        retryable: String(classifyError ?? '').indexOf(JUDGE_TIMEOUT) === 0,
      };
    }

    // --- Stage 2: proposal ---------------------------------------------------
    try {
      const { verdict } = await runJudgeWithRetry(
        PROPOSER_AGENT,
        JSON.stringify({ deviation: { ...base, rootCause }, keyTurns, cmmsRecord }),
      );
      const target = String(verdict?.target ?? '');
      if (['prompt', 'mapping', 'sow', 'human'].indexOf(target) < 0) {
        throw new Error(`Proposer returned an unusable target: ${target}`);
      }

      const corrId = `CO-${id}`;
      const cmmsAction = JSON.stringify(verdict.cmmsAction ?? {});
      const prior = db.query('select id from corrections where id = $1 limit 1', [corrId]).rows[0];
      if (prior) {
        db.query(
          `update corrections set target=$2, title=$3, rationale=$4, before_text='', after_text=$5,
             cmms_action=$6, recommended_action=$7, state='proposed' where id=$1`,
          [corrId, target, String(verdict.title ?? ''), String(verdict.rationale ?? ''),
           String(verdict.afterText ?? ''), cmmsAction, String(verdict.humanTask ?? '')],
        );
      } else {
        db.query(
          `insert into corrections
             (id, deviation_id, target, title, rationale, before_text, after_text, state,
              recommended_action, assignee, cmms_action, proposed_at)
           values ($1,$2,$3,$4,$5,'',$6,'proposed',$7,'',$8,$9)`,
          [corrId, id, target, String(verdict.title ?? ''), String(verdict.rationale ?? ''),
           String(verdict.afterText ?? ''), String(verdict.humanTask ?? ''),
           cmmsAction, nowIso()],
        );
      }
      db.query("update deviations set status='correcting' where id=$1", [id]);

      return {
        deviationId: id,
        stage: 'complete',
        ok: true,
        rootCause,
        correctionId: corrId,
        target,
        title: verdict.title ?? '',
        cmmsAction: verdict.cmmsAction ?? null,
        humanTask: verdict.humanTask ?? '',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Stage 1 succeeded and is already persisted — report it rather than
      // throwing the whole pass away.
      return {
        deviationId: id,
        stage: 'propose',
        ok: false,
        rootCause,
        error: message,
        retryable: message.indexOf(JUDGE_TIMEOUT) === 0,
      };
    }
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
    const criterion = SEMANTIC_CRITERIA[criterionId];
    if (!criterion) throw new Error(`Unknown semantic criterion ${criterionId}`);

    const db = connect();
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
    const criterion = SEMANTIC_CRITERIA[criterionId];
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

    db.query('update deviations set root_cause=$2, status=$3 where id=$1', [
      id,
      rootCause,
      'correcting',
    ]);

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

server.addHandler({
  name: 'judgeTest',
  description:
    'Verify the function -> connections -> AI Studio judge path end to end with one real call.',
  parameters: {
    agent: { description: 'Agent link name', type: 'string' },
    message: { description: 'Message to grade', type: 'string' },
  },
  execute: async (args) => {
    const agent = String(args.agent ?? '').trim();
    if (!agent) throw new Error('agent link name is required');
    const { verdict, threadId } = await runJudge(agent, String(args.message ?? ''));
    return { ok: true, threadId, verdict };
  },
});

server.execute();
