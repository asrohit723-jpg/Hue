/**
 * Hue — live call-log ingest from the Facilio Channels API.
 *
 * STATUS: built and deployable, INERT until configured. It has no host baked
 * in and will not invent one. Unconfigured, `poll` returns
 * `{ configured: false, needs: [...] }` and changes nothing — the seeded
 * transcripts stay exactly as they are, so switching this on is additive and
 * nothing regresses if the endpoint never arrives.
 *
 * ── WHERE THE ENDPOINT GOES ──────────────────────────────────────────────────
 * Everything platform-specific is resolved in `resolveConfig()` and used in
 * exactly one place, `channels()`. Nothing else in this file knows a URL.
 *
 * Config resolves in this order, so it works with whatever the platform offers:
 *   1. process.env.CHANNELS_*   — if Vibe ever injects custom env values
 *   2. handler args             — supplied by the scheduled job's --payload
 *
 * To switch on with NO CODE CHANGE:
 *
 *   facilio vibe jobs update pull-call-logs --payload '{
 *     "host":       "<US Channels host, e.g. https://xxx.facilio.com>",
 *     "listPath":   "/api/logs?since={since}&status=completed",
 *     "getPath":    "/api/logs/{callId}",
 *     "headerName": "x-integration-key",
 *     "key":        "<the key>"
 *   }'
 *
 * `{since}` and `{callId}` are substituted; everything else is passed through
 * verbatim, so a different path shape needs no code change either.
 *
 * NOTE ON THE KEY: a job payload is stored platform-side, not in this repo and
 * not in the bundle, but it is configuration rather than a vault secret. If
 * vault `environment_variable` credentials become available to Vibe functions,
 * move the key there and drop it from the payload — `resolveConfig` will pick
 * it up from process.env with no other change.
 *
 * ── WATERMARK ────────────────────────────────────────────────────────────────
 * Only calls newer than the newest already stored are pulled. Timestamps are
 * ISO-8601 UTC strings, which sort lexicographically, so MAX() is a valid
 * high-water mark. Ingest is idempotent on callId regardless, so a replayed
 * window updates rather than duplicates.
 */
import StudioFunctions, { StudioDatabase } from '@facilio/studio-functions';

const server = new StudioFunctions({ name: 'callingest' });

const CMMS = 'facilio-cmms';

function connect() {
  return new StudioDatabase({
    userName: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    schema: process.env.SCHEMA,
  });
}

// ---------------------------------------------------------------------------
// Config — the ONLY place the Channels endpoint is defined
// ---------------------------------------------------------------------------

interface ChannelsConfig {
  host: string;
  listPath: string;
  getPath: string;
  headerName: string;
  key: string;
}

/** Which config values are still missing, by name. Never reveals the key. */
function resolveConfig(args: Record<string, unknown>): {
  config: ChannelsConfig | null;
  missing: string[];
} {
  const pick = (envName: string, argName: string) =>
    String(process.env[envName] ?? args[argName] ?? '').trim();

  const config: ChannelsConfig = {
    host: pick('CHANNELS_HOST', 'host'),
    listPath: pick('CHANNELS_LIST_PATH', 'listPath'),
    getPath: pick('CHANNELS_GET_PATH', 'getPath'),
    headerName: pick('CHANNELS_HEADER_NAME', 'headerName'),
    key: pick('CHANNELS_KEY', 'key'),
  };

  const missing: string[] = [];
  if (!config.host) missing.push('host');
  if (!config.listPath) missing.push('listPath');
  if (!config.getPath) missing.push('getPath');
  if (!config.headerName) missing.push('headerName');
  if (!config.key) missing.push('key');

  return { config: missing.length ? null : config, missing };
}

/**
 * The single call into the Channels API.
 *
 * Deliberately has no default host. If the caller has not supplied one this is
 * never reached, because `poll` returns early — guessing a hostname is exactly
 * the failure mode this file exists to avoid.
 */
async function channels(config: ChannelsConfig, path: string): Promise<any> {
  const base = config.host.replace(/\/+$/, '');
  const url = `${base}${path.startsWith('/') ? '' : '/'}${path}`;

  // The sandbox permits HTTPS on 443 only, and blocks private/loopback hosts.
  // Fail with a readable message rather than an opaque network error.
  if (!/^https:\/\//i.test(url)) {
    throw new Error(`Channels host must be https:// — got "${config.host}"`);
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  headers[config.headerName] = config.key;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Channels ${path} failed: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

// ---------------------------------------------------------------------------
// Shape adapters — tolerant, because the exact payload is unconfirmed
// ---------------------------------------------------------------------------

/** Pull the call list out of whatever envelope the endpoint uses. */
function callList(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  return payload?.data ?? payload?.logs ?? payload?.callLogs ?? payload?.result ?? [];
}

/** The documented AE shape is `transcription: [{performer, message}]`. */
function transcriptionOf(payload: any): any[] {
  const t =
    payload?.transcription ??
    payload?.data?.transcription ??
    payload?.callLog?.transcription ??
    [];
  return Array.isArray(t) ? t : [];
}

function pickId(row: any): string {
  return String(row?.callLogId ?? row?.callId ?? row?.id ?? '').trim();
}

function pickEndedAt(row: any): string {
  return String(
    row?.endedAt ?? row?.completedAt ?? row?.updatedAt ?? row?.startedAt ?? row?.createdAt ?? '',
  );
}

/**
 * Map a Channels transcription turn onto Hue's turn shape.
 *
 * `performer` is carried through as-is where it is one Hue recognises, so the
 * transcript reads the same whether it was seeded or pulled live.
 */
function toTurns(transcription: any[]): any[] {
  return transcription.map((t: any) => {
    const performerRaw = String(t?.performer ?? t?.role ?? t?.speaker ?? '').toLowerCase();
    const performer =
      performerRaw === 'caller' || performerRaw === 'user' || performerRaw === 'customer'
        ? 'caller'
        : performerRaw === 'agent' || performerRaw === 'assistant' || performerRaw === 'bot'
          ? 'agent'
          : 'system';
    return {
      performer,
      message: String(t?.message ?? t?.text ?? t?.content ?? ''),
      at: String(t?.at ?? t?.timestamp ?? t?.offset ?? ''),
      toolName: t?.toolName ?? t?.tool ?? null,
      toolStatus: t?.toolStatus ?? null,
      toolArgs: t?.toolArgs ?? null,
      toolResult: t?.toolResult ?? null,
      toolRecordId: t?.toolRecordId ?? t?.recordId ?? null,
      toolError: t?.toolError ?? null,
    };
  });
}

const boolText = (v: boolean) => (v ? 'true' : 'false');

/** Store one call. Idempotent on callId — a replay replaces turns, never duplicates. */
function upsertCall(db: any, call: any, turns: any[]): { id: string; replaced: boolean } {
  const callId = pickId(call);
  const existing = db.query('select id from conversations where call_id = $1 limit 1', [callId])
    .rows[0];
  const id = existing?.id ?? `C-${callId}`;

  // The SR number the agent read back, if the payload carries one. This is the
  // claim; the join in `governance.evaluate` decides whether it is true.
  const claimedSr = String(call?.serviceRequestId ?? call?.srId ?? call?.recordId ?? '');
  const srClaimed = boolText(Boolean(claimedSr) || Boolean(call?.ticketCreated));

  const row = [
    id,
    String(call?.startedAt ?? call?.createdAt ?? pickEndedAt(call) ?? ''),
    Number(call?.durationSec ?? call?.duration ?? 0) || 0,
    String(call?.callerName ?? call?.caller?.name ?? ''),
    String(call?.callerPhone ?? call?.caller?.phone ?? call?.from ?? ''),
    String(call?.site ?? call?.siteName ?? ''),
    String(call?.status ?? 'completed'),
    String(call?.sentiment ?? ''),
    srClaimed,
    claimedSr,
  ];

  if (existing) {
    db.query(
      `update conversations set started_at=$2, duration_sec=$3, caller_name=$4, caller_phone=$5,
         site_hint=$6, status=$7, sentiment=$8, sr_claimed=$9, sr_number_claimed=$10 where id=$1`,
      row,
    );
    db.query('delete from transcript_turns where conversation_id = $1', [id]);
  } else {
    db.query(
      `insert into conversations
         (id, call_id, started_at, duration_sec, caller_name, caller_phone, site_hint,
          status, sentiment, sr_claimed, sr_number_claimed, cmms_sr_id, join_method,
          join_confidence, eval_status, quality_score)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'','none',0,'not_evaluated',0)`,
      [row[0], callId, ...row.slice(1)],
    );
  }

  turns.forEach((t: any, i: number) => {
    db.query(
      `insert into transcript_turns
         (id, conversation_id, turn_index, performer, message, at_offset,
          tool_name, tool_status, tool_args, tool_result, tool_record_id, tool_error)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        `${id}-T${i}`, id, i, t.performer, t.message, t.at,
        t.toolName, t.toolStatus, t.toolArgs, t.toolResult, t.toolRecordId, t.toolError,
      ],
    );
  });

  return { id, replaced: Boolean(existing) };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

server.addHandler({
  name: 'config',
  description:
    'Report whether the Channels endpoint is configured, and what is still missing. Never returns the key.',
  parameters: {
    host: { description: 'Channels base host, https only', type: 'string' },
    listPath: { description: 'Path template for listing call logs; {since} is substituted', type: 'string' },
    getPath: { description: 'Path template for one call log; {callId} is substituted', type: 'string' },
    headerName: { description: 'Auth header name, e.g. x-integration-key', type: 'string' },
    key: { description: 'Auth key value', type: 'string' },
  },
  execute: async (args) => {
    const { config, missing } = resolveConfig(args);
    const db = connect();
    const watermark =
      db.query("select max(started_at) as w from conversations where id <> '__seed__'").rows[0]?.w ??
      null;
    return {
      configured: Boolean(config),
      missing,
      // Echo only non-secret values so a drop-in can be verified safely.
      host: config?.host ?? null,
      listPath: config?.listPath ?? null,
      getPath: config?.getPath ?? null,
      headerName: config?.headerName ?? null,
      keyPresent: Boolean(config?.key),
      watermark,
    };
  },
});

server.addHandler({
  name: 'poll',
  description:
    'Pull call logs completed since the watermark, store their transcripts, and evaluate each. Inert and harmless until the Channels endpoint is configured.',
  parameters: {
    limit: { description: 'Max calls to pull this run', type: 'number' },
    host: { description: 'Channels base host, https only', type: 'string' },
    listPath: { description: 'Path template for listing; {since} is substituted', type: 'string' },
    getPath: { description: 'Path template for one call; {callId} is substituted', type: 'string' },
    headerName: { description: 'Auth header name', type: 'string' },
    key: { description: 'Auth key value', type: 'string' },
  },
  execute: async (args) => {
    const { config, missing } = resolveConfig(args);
    const db = connect();

    const watermark =
      db.query("select max(started_at) as w from conversations where id <> '__seed__'").rows[0]?.w ??
      '1970-01-01T00:00:00Z';

    // ---- NOT CONFIGURED: do nothing, loudly -------------------------------
    // Returning rather than throwing keeps the scheduled job green while the
    // endpoint is outstanding, and leaves the seeded transcripts untouched.
    if (!config) {
      return {
        configured: false,
        missing,
        watermark,
        ingested: 0,
        note:
          'Channels endpoint not configured. Supply host, listPath, getPath, headerName and key ' +
          'via the job payload (or CHANNELS_* env) to switch this on. Seeded transcripts are unaffected.',
      };
    }

    // ---- CONFIGURED: the live path ----------------------------------------
    const limit = Math.min(Number(args.limit) || 20, 50);
    const listPath = config.listPath.replace('{since}', encodeURIComponent(watermark));

    const listed = callList(await channels(config, listPath));

    const ingested: string[] = [];
    const failed: Array<{ callId: string; error: string }> = [];

    for (const row of listed.slice(0, limit)) {
      const callId = pickId(row);
      if (!callId) continue;

      // Skip anything already stored — the watermark is a coarse filter and the
      // endpoint may be inclusive of its boundary.
      const already = db.query('select id from conversations where call_id = $1 limit 1', [callId])
        .rows[0];
      if (already) continue;

      try {
        const detail = await channels(config, config.getPath.replace('{callId}', callId));
        const turns = toTurns(transcriptionOf(detail));
        // A call with no transcription is not worth storing as a conversation:
        // Hue would have nothing to grade and it would read as an empty call.
        if (turns.length === 0) {
          failed.push({ callId, error: 'no transcription in payload' });
          continue;
        }
        const { id } = upsertCall(db, { ...row, ...detail }, turns);
        ingested.push(id);
      } catch (err) {
        // One bad call must not abort the batch or advance past the rest.
        failed.push({ callId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      configured: true,
      watermark,
      listed: listed.length,
      ingested: ingested.length,
      conversationIds: ingested,
      failed,
      note:
        ingested.length > 0
          ? 'Run governance.evaluate on each new conversation to join it to its CMMS record.'
          : 'Nothing new since the watermark.',
    };
  },
});

server.addHandler({
  name: 'ingestOne',
  description:
    'Pull and store a single call log by id. For verifying the endpoint by hand before scheduling.',
  parameters: {
    callId: { description: 'Channels call log id', type: 'string' },
    host: { description: 'Channels base host, https only', type: 'string' },
    getPath: { description: 'Path template; {callId} is substituted', type: 'string' },
    headerName: { description: 'Auth header name', type: 'string' },
    key: { description: 'Auth key value', type: 'string' },
    listPath: { description: 'Unused here; accepted so one payload serves every handler', type: 'string' },
  },
  execute: async (args) => {
    const { config, missing } = resolveConfig(args);
    if (!config) return { configured: false, missing, ingested: 0 };

    const callId = String(args.callId ?? '').trim();
    if (!callId) throw new Error('callId is required');

    const detail = await channels(config, config.getPath.replace('{callId}', callId));
    const turns = toTurns(transcriptionOf(detail));
    if (turns.length === 0) {
      return { configured: true, callId, ingested: 0, error: 'no transcription in payload' };
    }
    const db = connect();
    const { id, replaced } = upsertCall(db, detail, turns);
    return { configured: true, callId, conversationId: id, turns: turns.length, replaced };
  },
});

server.execute();
