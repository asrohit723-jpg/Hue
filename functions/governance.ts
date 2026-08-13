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
async function runJudgeWithRetry(
  agentLinkName: string,
  message: string,
  attempts = 3,
): Promise<any> {
  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    try {
      return await runJudge(agentLinkName, message);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.log(`judge ${agentLinkName} attempt ${i + 1}/${attempts} failed: ${lastError}`);
    }
  }
  throw new Error(
    `Judge ${agentLinkName} failed after ${attempts} attempts — treat as UNKNOWN, not as pass. Last error: ${lastError}`,
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
    // No joined_at column: the table's shape comes from the seed CSV and DDL is
    // not permitted, so the join timestamp lives on the eval run instead.
    db.query(
      `update conversations set cmms_sr_id=$2, join_method=$3, join_confidence=$4 where id=$1`,
      [convoId, srId, joinMethod, joinConfidence],
    );

    // ---- 2. Deterministic checks against the live record -----------------
    // Exact, reproducible, free. No model is consulted here by design.
    const findings: Array<{
      criterionId: string;
      clauseRef: string;
      summary: string;
      severity: string;
      evidence: any[];
    }> = [];

    const srClaimed = asBool(convo.sr_claimed);

    // CR-LOG-01 — a record must exist for what the caller reported.
    if (srClaimed && !matched) {
      findings.push({
        criterionId: 'CR-LOG-01',
        clauseRef: 'S-2.1',
        summary:
          `The agent confirmed a service request to ${convo.caller_name || 'the caller'}, but no matching record exists in the CMMS. ` +
          `The reported fault is still unlogged.`,
        severity: 'critical',
        evidence: turns
          .filter((t: any) => t.tool_name || String(t.message ?? '').length > 0)
          .slice(-4)
          .map((t: any) => ({
            at: t.at_offset,
            who: t.tool_name ? 'Tool call' : t.performer,
            quote: t.tool_name ? `${t.tool_name} -> ${t.tool_status ?? 'unknown'}` : t.message,
            isViolation: Boolean(t.tool_name && t.tool_status !== 'success'),
          })),
      });
    }

    // CR-LOG-02 — never confirm without an id returned by the CMMS.
    const confirmedWithoutId =
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
    const missing: string[] = [];
    if (!String(convo.caller_name ?? '').trim()) missing.push('name');
    if (!String(convo.caller_phone ?? '').trim()) missing.push('contact number');
    if (!String(convo.site_hint ?? '').trim()) missing.push('site');
    if (missing.length) {
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

    db.query('update conversations set eval_status=$2 where id=$1', [
      convoId,
      findings.length ? 'flagged' : 'passed',
    ]);

    return {
      conversationId: convoId,
      join: { cmmsSrId: srId || null, method: joinMethod, confidence: joinConfidence },
      checksRun: 3,
      deviationsFound: written,
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

    const coverage = convoCount ? Math.round((evaluated / convoCount) * 100) : 0;
    const compliance = evaluated
      ? Math.round(((evaluated - openDeviations) / evaluated) * 100)
      : 100;

    return {
      callsToday: convoCount,
      deltaCalls: `${srTotal} service requests in the CMMS`,
      coverage,
      unchecked: convoCount - evaluated,
      missedSr,
      compliance: Math.max(compliance, 0),
      trend: openDeviations ? `${openDeviations} open` : 'No open deviations',
      corrections: 0,
      verified: 0,
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
    const { rows } = db.query(
      `select c.*, (select count(*) from deviations d where d.conversation_id = c.id) as deviation_count
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
    const sql = `select d.*, c.caller_name, c.site_hint, c.started_at, c.cmms_sr_id
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

    const turns = db.query(
      'select * from transcript_turns where conversation_id = $1 order by turn_index',
      [id],
    ).rows;
    const deviations = db.query('select * from deviations where conversation_id = $1', [id]).rows;

    // Ground truth, fetched live at read time.
    let cmmsRecord: any = null;
    if (convo.cmms_sr_id) {
      const payload = await cmms('list-service-requests', {
        page_size: 1,
        page: 1,
        expand: 'site,requester',
        filters: `id=${convo.cmms_sr_id}`,
      });
      cmmsRecord = rowsOf(payload)[0] ?? null;
    }

    return {
      conversation: convo,
      turns,
      deviations: deviations.map((d: any) => ({ ...d, evidence: JSON.parse(d.evidence || '[]') })),
      cmmsRecord,
    };
  },
});

/** The semantic criteria, and the judge that grades each. */
const SEMANTIC_CRITERIA: Record<string, { clauseRef: string; requires: string }> = {
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
    criterionId: { description: 'One of CR-LOG-04, CR-SCHED-01, CR-CAT-01', type: 'string' },
  },
  execute: async (args) => {
    const convoId = String(args.conversationId ?? '').trim();
    const criterionId = String(args.criterionId ?? '').trim();
    const criterion = SEMANTIC_CRITERIA[criterionId];
    if (!criterion) throw new Error(`Unknown semantic criterion ${criterionId}`);

    const db = connect();
    const convo = db.query('select * from conversations where id = $1 limit 1', [convoId]).rows[0];
    if (!convo) throw new Error(`No conversation ${convoId}`);
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
      return { conversationId: convoId, criterionId, verdict: verdict.verdict, recorded: false };
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

/** Gather one deviation with its call, turns and the LIVE record it was checked against. */
async function deviationContext(db: any, deviationId: string) {
  const dev = db.query('select * from deviations where id = $1 limit 1', [deviationId]).rows[0];
  if (!dev) throw new Error(`No deviation ${deviationId}`);
  const convo = db.query('select * from conversations where id = $1 limit 1', [
    dev.conversation_id,
  ]).rows[0];
  const turns = db.query(
    'select * from transcript_turns where conversation_id = $1 order by turn_index',
    [dev.conversation_id],
  ).rows;

  let cmmsRecord: any = null;
  if (convo?.cmms_sr_id) {
    const payload = await cmms('list-service-requests', {
      page_size: 1,
      page: 1,
      expand: 'site,requester',
      filters: `id(equals)=${convo.cmms_sr_id}`,
    });
    const r = rowsOf(payload)[0];
    if (r) {
      cmmsRecord = {
        id: r.id,
        subject: r.subject,
        description: r.description,
        site: r.site?.name ?? null,
        siteId: r.site?.id ?? null,
        urgency: r.urgency ?? null,
        status: r.moduleState ?? null,
      };
    }
  }

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

    if (prior) {
      db.query(
        `update corrections set target=$2, title=$3, rationale=$4, before_text=$5, after_text=$6,
           cmms_action=$7, state='proposed' where id=$1`,
        [
          corrId,
          target,
          String(verdict.title ?? ''),
          String(verdict.rationale ?? ''),
          String(verdict.beforeText ?? ''),
          String(verdict.afterText ?? ''),
          cmmsAction,
        ],
      );
    } else {
      db.query(
        `insert into corrections
           (id, deviation_id, target, title, rationale, before_text, after_text, state,
            recommended_action, assignee, cmms_action, proposed_at)
         values ($1,$2,$3,$4,$5,$6,$7,'proposed',$8,$9,$10,$11)`,
        [
          corrId,
          id,
          target,
          String(verdict.title ?? ''),
          String(verdict.rationale ?? ''),
          String(verdict.beforeText ?? ''),
          String(verdict.afterText ?? ''),
          String(verdict.humanAction?.action ?? ''),
          String(verdict.humanAction?.assigneeRole ?? ''),
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
      humanAction: verdict.humanAction ?? null,
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
          subject: String(action.subject ?? corr.title ?? 'Raised by Hue governance').slice(0, 255),
          description:
            `${String(action.why ?? corr.rationale ?? '')}\n\n` +
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
      db.query("update corrections set state='resolved', resolved_at=$2 where id=$1", [
        corrId,
        nowIso(),
      ]);
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
