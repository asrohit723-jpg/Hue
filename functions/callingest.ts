/**
 * Vigil — live call ingest from the helpdesk-call-logs connection.
 *
 * The connection is the default and only source for live calls. It is
 * read-only and reached through the connections service, which injects the
 * service token host-side — so unlike the previous direct-HTTP version, there
 * is no host, no header name and no key to supply. Ingest works out of the box.
 *
 * ── VERIFIED SHAPES ─────────────────────────────────────────────────────────
 * Confirmed against the live connection before this was written:
 *
 *   list-call-logs  {page, pageSize<=100, search}
 *                   -> { list: [ {id, callType, status, name, phone,
 *                                 createdAt(epoch ms), lastConversation{…}} ],
 *                        count }
 *                   Rows are SPARSE: transcription, summary, satisfactionLevel,
 *                   tags, startTime, endTime and recordingFileId are all null
 *                   here and only arrive from get-call-log.
 *
 *   get-call-log    {callLogId:number}
 *                   -> { summary: { …call, transcription: [
 *                          {performer:'AGENT'|'USER'|'SYSTEM', message,
 *                           timestamp(epoch ms)} ] } }
 *                   The transcript is at summary.transcription. Note `summary`
 *                   is both the wrapper key and a string field inside it.
 *
 *   export-call-transcript {callLogId:number}
 *                   -> { status_code, headers, response:"<plain text>" }
 *                   An HTTP envelope, not data: the transcript is a text blob
 *                   of "[YYYY-MM-DD HH:MM:SS] PERFORMER: message" lines, and
 *                   the envelope carries a session cookie. Used ONLY as a
 *                   fallback when get-call-log returns no transcription.
 *
 * ── WATERMARK ───────────────────────────────────────────────────────────────
 * list-call-logs has NO since/from parameter — only page, pageSize and search.
 * So the watermark cannot be pushed to the API. Instead: the list is newest
 * first, so pages are walked from the newest and the walk stops at the first
 * call already stored. Ingest is idempotent on call id regardless, so a
 * replayed page updates rather than duplicates.
 *
 * ── CONFIG INDIRECTION, KEPT ────────────────────────────────────────────────
 * `resolveConfig` survives for the direct-HTTP Channels fallback, which remains
 * available for hosts the connection does not cover. It still reads
 * process.env.CHANNELS_* first and falls back to handler args from the job
 * payload, so a key never lands in this repo or the bundle. Unconfigured, that
 * path simply stays unused — the connection path does not need it.
 */
import StudioFunctions, { StudioDatabase } from '@facilio/studio-functions';

const server = new StudioFunctions({ name: 'callingest' });

const CALL_LOGS = 'helpdesk-call-logs';

function connect() {
  return new StudioDatabase({
    userName: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    schema: process.env.SCHEMA,
  });
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

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

function listOf(payload: any): any[] {
  const l = payload?.list ?? payload?.data?.list ?? payload?.data ?? [];
  return Array.isArray(l) ? l : [];
}

function transcriptionOf(payload: any): any[] {
  const t =
    payload?.summary?.transcription ??
    payload?.transcription ??
    payload?.data?.summary?.transcription ??
    payload?.data?.transcription ??
    [];
  return Array.isArray(t) ? t : [];
}

function callRecordOf(payload: any): any {
  return payload?.summary ?? payload?.data?.summary ?? payload?.data ?? payload ?? {};
}

// ---------------------------------------------------------------------------
// Fallback: parse the plain-text export
// ---------------------------------------------------------------------------

/**
 * Parse export-call-transcript's text blob into turns.
 *
 * Only reached when get-call-log returns no transcription. Lines look like
 * "[2026-08-13 13:46:38] AGENT: Thanks for contacting…"; anything not matching
 * (the header block) is skipped.
 */
function turnsFromExport(payload: any): Array<{ performer: string; message: string; at: string }> {
  const text = String(payload?.response ?? payload?.data?.response ?? payload ?? '');
  if (!text || text.length > 200_000) return [];
  const out: Array<{ performer: string; message: string; at: string }> = [];
  for (const line of text.split('\n')) {
    const m = /^\[([^\]]+)\]\s+([A-Z]+):\s?(.*)$/.exec(line.trim());
    if (!m) continue;
    out.push({ performer: toPerformer(m[2]), message: m[3], at: m[1] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shape mapping — kept identical to governance.ts so live and seeded calls
// render through exactly the same path
// ---------------------------------------------------------------------------

function toPerformer(raw: unknown): string {
  const p = String(raw ?? '').toLowerCase();
  if (p === 'user' || p === 'caller' || p === 'customer') return 'caller';
  if (p === 'agent' || p === 'assistant' || p === 'bot') return 'agent';
  return 'system';
}

function offsetFrom(startMs: number, atMs: unknown): string {
  const t = Number(atMs);
  if (!Number.isFinite(t) || !Number.isFinite(startMs) || t < startMs) return '';
  const sec = Math.round((t - startMs) / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * The service request number the agent read back, recovered from speech.
 *
 * Live call logs have no structured SR field. The number is spoken, and spoken
 * in several forms — "210-412", "2 1 0 4 1 2", "210412" — so digit runs are
 * collapsed across spaces and hyphens before matching. 5-8 digits covers this
 * CMMS's ids without catching phone numbers or clock times.
 *
 * The agent's turns are searched first: a number the CALLER recites refers to a
 * request that already exists, and is not evidence the agent created one.
 *
 * null is a real finding, not an error — the agent promising a ticket and
 * naming no number is precisely what Vigil is looking for.
 */
function spokenSrNumber(turns: Array<{ performer: string; message: string }>): string | null {
  const ordered = [
    ...turns.filter((t) => t.performer === 'agent'),
    ...turns.filter((t) => t.performer !== 'agent'),
  ];
  for (const turn of ordered) {
    const collapsed = String(turn.message ?? '').replace(/\d(?:[\s-]+\d){2,}/g, (run) =>
      run.replace(/[\s-]+/g, ''),
    );
    const matches = collapsed.match(/\b\d{5,8}\b/g);
    if (matches && matches.length) return matches[0];
  }
  return null;
}

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

const iso = (ms: unknown): string => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : new Date().toISOString();
};

/**
 * Did the agent tell the caller a request exists?
 *
 * Two separate signals, and they disagree in the interesting cases: a spoken
 * number is a strong claim, while "logged"/"raised"/"created" without a number
 * is a claim with nothing behind it — the shape of the failure this catches.
 */
function claimsRequest(
  turns: Array<{ performer: string; message: string }>,
  srNumber: string | null,
): boolean {
  if (srNumber) return true;
  return turns.some(
    (t) =>
      t.performer === 'agent' &&
      /\b(logged|raised|created|registered|booked|ticket is|request is)\b/i.test(t.message ?? ''),
  );
}

// ---------------------------------------------------------------------------
// Channel
//
// The connection returns a `callType` and a `channelId` on every row and this
// app used to throw both away, so every conversation became "a call" — which
// is how a WEB conversation ended up with an email address in caller_phone,
// rendered under a heading that says phone number.
//
// Vigil never filtered by channel. The `type=CALL` filter lives in the
// connection's own action definition, server-side, and there is no parameter
// to widen it (see docs/platform-ask-text-channels.md). So this does not
// "remove a filter" — it stops ASSUMING voice, and records what it is told.
// The day the connection returns WHATSAPP or CHAT rows, they land correctly
// with no change here.
// ---------------------------------------------------------------------------

/** What the platform calls each channel, mapped to how it must be graded. */
const CHANNEL_MODALITY: Record<string, string> = {
  PHONE: 'voice',
  // Not a typo: WEB is the browser web-call WIDGET — speech through a browser,
  // not a text chat. The platform's own schema says so, and its records carry
  // recordingFileId and speech-shaped turns. It grades exactly like PHONE.
  WEB: 'voice',
  WHATSAPP: 'text',
  CHAT: 'text',
  EMAIL: 'text',
};

/**
 * What the identity field actually holds on each channel.
 *
 * `record.phone` is polymorphic: a telephone number on PHONE, an email address
 * on WEB. Storing which it is means a screen can label it truthfully instead of
 * calling an email a phone number.
 */
function identityKindOf(channel: string, identity: string): string {
  if (identity.includes('@')) return 'email';
  if (/^\+?\d[\d\s-]{5,}$/.test(identity)) return 'phone';
  return CHANNEL_MODALITY[channel] === 'text' ? 'handle' : 'phone';
}

function channelOfRecord(record: any): { channel: string; channelId: number; modality: string } {
  const channel = String(record?.callType ?? '').trim().toUpperCase() || 'PHONE';
  return {
    channel,
    channelId: Number(record?.channelId) || 0,
    // An unknown channel grades as TEXT, not voice. Voice-only checks would
    // otherwise run on something that is not a call, and this app's rule is
    // that an unknown is never quietly treated as the permissive case.
    modality: CHANNEL_MODALITY[channel] ?? 'text',
  };
}

/**
 * THE ONLY WRITER of conversation_channels, called from upsertLiveCall alone.
 *
 * Same discipline as writeCallGrade: a deterministic id and select-then-write,
 * because this database has no unique index anywhere.
 */
function writeConversationChannel(
  db: any,
  convoId: string,
  record: any,
  identity: string,
) {
  const { channel, channelId, modality } = channelOfRecord(record);
  const id = `CH-${convoId}`;
  const taggedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const values = [channel, channelId, modality, identityKindOf(channel, identity), taggedAt];

  const existing = db.query('select id from conversation_channels where id = $1 limit 1', [id])
    .rows[0];
  if (existing) {
    db.query(
      `update conversation_channels
          set channel=$2, channel_id=$3, modality=$4, identity_kind=$5, tagged_at=$6,
              schema_version=1
        where id=$1`,
      [id, ...values],
    );
  } else {
    db.query(
      `insert into conversation_channels
         (id, conversation_id, channel, channel_id, modality, identity_kind, tagged_at, schema_version)
       values ($1,$2,$3,$4,$5,$6,$7,1)`,
      [id, convoId, ...values],
    );
  }
  return { channel, modality };
}

/**
 * The written service-request number, for text channels. NOT WIRED YET.
 *
 * Voice keeps `spokenSrNumber` above, unchanged. This is the text counterpart:
 * on WhatsApp or chat the number is typed rather than spoken, so it arrives as
 * "SR 210412", "SR-210412", "#210412" or "Service Request ID: 210412" instead
 * of a run of digits read aloud.
 *
 * It returns null deliberately, and must keep doing so until there is a real
 * text conversation to test it against. A parser guessed at from an imagined
 * format is worse than no parser: it would produce a confident WRONG join, and
 * a wrong join is indistinguishable from the agent inventing a reference —
 * exactly the failure Vigil exists to catch. With null, a text conversation gets
 * no claimed number, its join is recorded as `not_checked`, and every check
 * that reads the CMMS record is marked not-applicable rather than failed.
 *
 * To wire it: implement the label-first match below, prefer agent turns (a
 * number the CALLER types refers to a request that already existed), and
 * remove the `not_checked` branch in gradeConversation.
 */
function writtenSrNumber(
  _turns: Array<{ performer: string; message: string }>,
): string | null {
  return null;
}

// ---------------------------------------------------------------------------
// Storage. Idempotent on call id — a replay replaces turns, never duplicates.
// ---------------------------------------------------------------------------

function upsertLiveCall(
  db: any,
  record: any,
  turns: Array<{ performer: string; message: string; at: string }>,
): { id: string; replaced: boolean; srNumber: string | null } {
  const callLogId = String(record?.id ?? '').trim();
  const existing = db.query('select id from conversations where call_id = $1 limit 1', [callLogId])
    .rows[0];
  // The `L-` prefix IS the provenance marker. The app's role cannot ALTER the
  // table to add a `source` column (permission denied for the schema), so a
  // live call is identified by its id shape — which is also how the detail
  // screen knows it may re-read the transcript from the connection.
  const id = existing?.id ?? `L-${callLogId}`;

  // Channel decides how the reference is read. Voice keeps the spoken parser
  // exactly as it was; text has no parser yet and therefore claims no number,
  // which downstream becomes an honest "not checked" join rather than a guess.
  const { modality } = channelOfRecord(record);
  const srNumber = modality === 'voice' ? spokenSrNumber(turns) : writtenSrNumber(turns);
  const startMs = Number(record?.startTime ?? record?.createdAt ?? 0);
  const endMs = Number(record?.endTime ?? 0);
  const durationSec = endMs > startMs ? Math.round((endMs - startMs) / 1000) : 0;

  // The connection leaves `name` null on most calls; the phone number is then
  // the only identity the caller has, and the list shows it in place of a name.
  const callerName = String(record?.name ?? '').trim();
  const callerPhone = String(record?.phone ?? '').trim();

  const status = String(record?.status ?? '').toUpperCase() === 'IN_PROGRESS'
    ? 'in_progress'
    : 'completed';

  const row = [
    id,
    iso(record?.startTime ?? record?.createdAt),
    durationSec,
    callerName,
    callerPhone,
    // Live call logs carry no site. The authoritative site is whatever the
    // joined CMMS record says, and governance.evaluate fills that in.
    '',
    status,
    toSentiment(record?.satisfactionLevel),
    claimsRequest(turns, srNumber) ? 'true' : 'false',
    srNumber ?? '',
  ];

  if (existing) {
    // site_hint is deliberately absent from this UPDATE: governance.evaluate
    // fills it from the joined CMMS record, and a re-poll must not wipe it.
    db.query(
      `update conversations set started_at=$2, duration_sec=$3, caller_name=$4, caller_phone=$5,
         status=$6, sentiment=$7, sr_claimed=$8, sr_number_claimed=$9 where id=$1`,
      [row[0], row[1], row[2], row[3], row[4], row[6], row[7], row[8], row[9]],
    );
    db.query('delete from transcript_turns where conversation_id = $1', [id]);
  } else {
    db.query(
      `insert into conversations
         (id, call_id, started_at, duration_sec, caller_name, caller_phone, site_hint,
          status, sentiment, sr_claimed, sr_number_claimed, cmms_sr_id, join_method,
          join_confidence, eval_status, quality_score)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'','none',0,'not_evaluated',0)`,
      [row[0], callLogId, ...row.slice(1)],
    );
  }

  turns.forEach((t, i) => {
    db.query(
      `insert into transcript_turns
         (id, conversation_id, turn_index, performer, message, at_offset,
          tool_name, tool_status, tool_args, tool_result, tool_record_id, tool_error)
       values ($1,$2,$3,$4,$5,$6,null,null,null,null,null,null)`,
      [`${id}-T${i}`, id, i, t.performer, t.message, t.at],
    );
  });

  // Tagged AFTER the conversation row exists, so a channel row never points at
  // a conversation that is not there.
  writeConversationChannel(db, id, record, callerPhone);

  return { id, replaced: Boolean(existing), srNumber };
}

/**
 * Fetch one call and map it. get-call-log is the source; the plain-text export
 * is tried only if it yields no transcription.
 */
async function fetchCall(callLogId: string): Promise<{
  record: any;
  turns: Array<{ performer: string; message: string; at: string }>;
  via: string;
}> {
  const payload = await callLogs('get-call-log', { callLogId: Number(callLogId) });
  const record = callRecordOf(payload);
  const live = transcriptionOf(payload);

  if (live.length) {
    const startMs = Number(record?.startTime ?? record?.createdAt ?? 0);
    return {
      record,
      turns: live.map((t: any) => ({
        performer: toPerformer(t?.performer),
        message: String(t?.message ?? ''),
        at: offsetFrom(startMs, t?.timestamp),
      })),
      via: 'get-call-log',
    };
  }

  try {
    const exported = await callLogs('export-call-transcript', { callLogId: Number(callLogId) });
    const turns = turnsFromExport(exported);
    if (turns.length) return { record, turns, via: 'export-call-transcript' };
  } catch {
    // The export is a fallback; its failure is not the call's failure.
  }

  return { record, turns: [], via: 'none' };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

server.addHandler({
  name: 'config',
  description:
    'Report the ingest source and what is already stored. The connection needs no configuration.',
  parameters: {},
  execute: async () => {
    const db = connect();
    const stored = db.query(
      "select count(*) as n from conversations where id like 'L-%'",
    ).rows[0]?.n;
    const newest = db.query(
      "select max(call_id) as w from conversations where id like 'L-%'",
    ).rows[0]?.w;

    let reachable = false;
    let available: number | null = null;
    try {
      const payload = await callLogs('list-call-logs', { page: 1, pageSize: 1 });
      reachable = true;
      available = Number(payload?.count ?? 0);
    } catch {
      reachable = false;
    }

    return {
      source: CALL_LOGS,
      connectionReachable: reachable,
      callsAvailable: available,
      liveCallsStored: Number(stored ?? 0),
      newestStoredCallLogId: newest ?? null,
      note: 'The connection injects its own credentials host-side. No host or key is configured here.',
    };
  },
});

server.addHandler({
  name: 'poll',
  description:
    'Pull new calls from the helpdesk-call-logs connection, newest first, stopping at the first call already stored.',
  parameters: {
    limit: { description: 'Max calls to ingest this run', type: 'number' },
    pageSize: { description: 'Rows per page, max 100', type: 'number' },
    maxPages: { description: 'How many pages to walk before giving up', type: 'number' },
    backfill: {
      description: 'Set 1 to walk past already-stored calls and pick up history, instead of stopping at the first one',
      type: 'number',
    },
  },
  execute: async (args) =>
    await pollNewCalls({
      limit: Math.min(Number(args.limit) || 20, 100),
      pageSize: Math.min(Number(args.pageSize) || 50, 100),
      maxPages: Math.min(Number(args.maxPages) || 5, 20),
      backfill: Number(args.backfill) === 1,
    }),
});

/**
 * Pull new calls from the connection and store them.
 *
 * Extracted from the `poll` handler so the header's Refresh button runs THIS,
 * not a second copy of it. Two ingest implementations would drift, and the one
 * that drifted would be the one a person presses.
 *
 * The watermark is an optimisation for the steady state: newest-first plus
 * "stop at the first call already stored" is the cheapest way to pick up what
 * has happened since the last run.
 *
 * It cannot backfill, though — anything OLDER than a stored call is behind the
 * stopping point and would never be reached. That matters on first adoption,
 * where an org's whole call history sits below the first call ingested.
 * Backfill mode skips stored calls and keeps walking instead.
 */
async function pollNewCalls(opts: {
  limit: number;
  pageSize: number;
  maxPages: number;
  backfill: boolean;
}) {
  const db = connect();
  const { limit, pageSize, maxPages, backfill } = opts;

  const ingested: string[] = [];
  const skipped: string[] = [];
  const skippedStored: string[] = [];
  const failed: Array<{ callLogId: string; error: string }> = [];
  let listed = 0;
  let stoppedAt: string | null = null;

  outer: for (let page = 1; page <= maxPages; page++) {
    const payload = await callLogs('list-call-logs', { page, pageSize });
    const rows = listOf(payload);
    if (!rows.length) break;
    listed += rows.length;

    for (const row of rows) {
      const callLogId = String(row?.id ?? '').trim();
      if (!callLogId) continue;

      // The watermark. The list is newest-first, so the first already-stored
      // call means everything after it is older and also stored.
      const already = db.query('select id from conversations where call_id = $1 limit 1', [
        callLogId,
      ]).rows[0];
      if (already) {
        if (!backfill) {
          stoppedAt = callLogId;
          break outer;
        }
        skippedStored.push(callLogId);
        continue;
      }

      // A call still in progress has a transcript that is not finished. Leave
      // it for a later run rather than storing a partial conversation and
      // grading the agent on half a call.
      if (String(row?.status ?? '').toUpperCase() === 'IN_PROGRESS') {
        skipped.push(callLogId);
        continue;
      }

      try {
        const { record, turns, via } = await fetchCall(callLogId);
        if (!turns.length) {
          failed.push({ callLogId, error: 'no transcript from get-call-log or export' });
          continue;
        }
        const { id } = upsertLiveCall(db, { ...row, ...record, id: callLogId }, turns);
        ingested.push(id);
        if (ingested.length >= limit) {
          stoppedAt = 'limit';
          break outer;
        }
      } catch (err) {
        // One bad call must not abort the batch.
        failed.push({ callLogId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return {
    source: CALL_LOGS,
    mode: backfill ? 'backfill' : 'watermark',
    listed,
    ingested: ingested.length,
    conversationIds: ingested,
    skippedInProgress: skipped,
    skippedAlreadyStored: backfill ? skippedStored.length : 0,
    failed,
    stoppedAt,
    note: ingested.length
      ? 'Run governance.evaluate on each new conversation to join it to the CMMS, then governance.evaluateSemantic per semantic criterion.'
      : backfill
        ? 'Every call the connection lists is already stored.'
        : 'Nothing new since the newest stored call.',
  };
}

// ---------------------------------------------------------------------------
// The Refresh button's ingest
//
// Ingest from a browser was rejected once, for a good reason: upsertLiveCall is
// select-then-insert and this database has NO unique index anywhere (every table
// came from `db import`), so two people pulling at the same moment both see "not
// stored" and both insert. The id is derived from the call log id, so the result
// is the same call twice in the list.
//
// A button makes that reachable in a way a single scheduled job never did, so
// the pull takes a lease first. Same shape as the grading claim in
// governance.ts: one atomic UPDATE, and only the fire that gets a row back does
// any work.
// ---------------------------------------------------------------------------

/**
 * The lease row.
 *
 * It lives in `call_grades` because that is the only table with claimed_at /
 * claimed_by, and its conversation_id matches no conversation — so it never
 * joins, never gets claimed as a grade, and is invisible to every existing
 * reader. Reusing the columns beats inventing a table the role cannot create.
 */
const LEASE_ID = 'LEASE-ingest';
const LEASE_CONVO = '__lease__';

/** Long enough for a five-call pull, short enough that a dead tab is not felt. */
const LEASE_TTL_MS = 120 * 1000;

const leaseStamp = (msAgo = 0) =>
  new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Take the ingest lease, or report that someone else holds it.
 *
 * The row is created on first use — there is no migration to add it, and a
 * missing lease must not mean "no lock, go ahead". The insert races only the
 * very first time; every pull after that is the atomic UPDATE below.
 */
function claimIngest(db: any, by: string): boolean {
  const existing = db.query('select id from call_grades where id = $1 limit 1', [LEASE_ID])
    .rows[0];
  if (!existing) {
    db.query(
      `insert into call_grades (id, conversation_id, claimed_at, claimed_by, graded_at, graded_by,
                                applicable, response_quality, schema_version)
       values ($1,$2,'','','','','',null,1)`,
      [LEASE_ID, LEASE_CONVO],
    );
  }

  // Free when never held, or held by a run that died before releasing.
  const { rows } = db.query(
    `update call_grades set claimed_at = $2, claimed_by = $3
      where id = $1 and (claimed_at is null or claimed_at = '' or claimed_at < $4)
     returning id`,
    [LEASE_ID, leaseStamp(), by, leaseStamp(LEASE_TTL_MS)],
  );
  return rows.length > 0;
}

/** Hand it back immediately, rather than making the next press wait out the TTL. */
function releaseIngest(db: any, by: string) {
  db.query(`update call_grades set claimed_at = '', claimed_by = '' where id = $1 and claimed_by = $2`, [
    LEASE_ID,
    by,
  ]);
}

server.addHandler({
  name: 'refresh',
  description:
    'Pull in any calls that have arrived since the page loaded — what the header Refresh button runs. Takes an ingest lease first, so two people pressing it at once cannot store the same call twice. Runs the same ingest as the scheduled job.',
  parameters: {
    limit: { description: 'Max calls to pull this press (default 5)', type: 'number' },
  },
  execute: async (args) => {
    // Small on purpose: someone is watching a spinner. The scheduled job owns
    // the backlog; this only closes the gap since the page loaded.
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
    const db = connect();
    const by = `refresh-${Date.now().toString(36)}`;

    if (!claimIngest(db, by)) {
      // Not an error. Someone else's pull is already doing this work, and its
      // results are what the caller wanted — so re-read, do not re-ingest.
      return {
        skipped: true,
        reason: 'Another refresh is already running',
        ingested: 0,
        conversationIds: [],
      };
    }

    try {
      const res = await pollNewCalls({ limit, pageSize: 50, maxPages: 3, backfill: false });
      return { skipped: false, ...res };
    } finally {
      releaseIngest(db, by);
    }
  },
});

server.addHandler({
  name: 'backfillChannels',
  description:
    'Tag conversations stored before channels were recorded. One list-call-logs page carries callType and channelId for every stored call, so this is a single fetch rather than one per conversation. Idempotent — re-running rewrites the same rows.',
  parameters: {
    pageSize: { description: 'Rows per page, max 100', type: 'number' },
    maxPages: { description: 'Pages to walk', type: 'number' },
  },
  execute: async (args) => {
    const db = connect();
    const pageSize = Math.min(Math.max(Number(args.pageSize) || 100, 1), 100);
    const maxPages = Math.min(Math.max(Number(args.maxPages) || 3, 1), 20);

    const tagged: Array<{ id: string; channel: string; modality: string }> = [];
    const seen = new Set<string>();

    for (let page = 1; page <= maxPages; page++) {
      const rows = listOf(await callLogs('list-call-logs', { page, pageSize }));
      if (!rows.length) break;

      for (const row of rows) {
        const callLogId = String(row?.id ?? '').trim();
        if (!callLogId || seen.has(callLogId)) continue;
        seen.add(callLogId);

        const convo = db.query('select id, caller_phone from conversations where call_id = $1 limit 1', [
          callLogId,
        ]).rows[0];
        // Only tags what is already stored. This is a backfill, not an ingest.
        if (!convo) continue;

        const res = writeConversationChannel(
          db,
          String(convo.id),
          row,
          String(convo.caller_phone ?? ''),
        );
        tagged.push({ id: String(convo.id), channel: res.channel, modality: res.modality });
      }
    }

    const untagged = Number(
      db.query(
        `select count(*) as n from conversations c
          where c.id <> '__seed__'
            and not exists (select 1 from conversation_channels g
                             where g.conversation_id = c.id and g.id <> '__seed__')`,
      ).rows[0]?.n ?? 0,
    );

    return {
      tagged: tagged.length,
      details: tagged,
      // Seeded demo calls (C-*) are not on the connection, so they are never
      // listed here. They read as PHONE/voice by default, which is what they are.
      stillUntagged: untagged,
    };
  },
});

server.addHandler({
  name: 'ingestOne',
  description: 'Pull and store a single call by its call-log id. For verifying end to end by hand.',
  parameters: { callLogId: { description: 'Call log id on the connection', type: 'string' } },
  execute: async (args) => {
    const callLogId = String(args.callLogId ?? '').trim();
    if (!callLogId) throw new Error('callLogId is required');

    const { record, turns, via } = await fetchCall(callLogId);
    if (!turns.length) {
      return { callLogId, ingested: 0, via, error: 'no transcript from get-call-log or export' };
    }
    const db = connect();
    const { id, replaced, srNumber } = upsertLiveCall(
      db,
      { ...record, id: callLogId },
      turns,
    );
    return {
      callLogId,
      conversationId: id,
      turns: turns.length,
      via,
      replaced,
      spokenSrNumber: srNumber,
      note: 'Run governance.evaluate to join it to the CMMS.',
    };
  },
});

server.execute();
