import { createVibe } from '@facilio/vibe-sdk';
import type { Channel, NotApplicable } from './channel';
import type { GradingState } from './grading';
import type {
  Conversation,
  Deviation,
  ToolCall,
  TranscriptTurn,
} from '@shared/contract';

/**
 * The single Vibe client for the app. serverURL defaults to
 * window.location.origin, which is what we want — the app is served from the
 * same host it talks to, so cookies flow automatically.
 */
export const vibe = createVibe();

/**
 * Every Facilio/CMMS read goes through a server function, never through
 * `vibe.executeAction` from here.
 *
 * `executeAction` works from the browser, but it would put the connection call
 * — and its scoping — on the client, where a user can change the payload. The
 * server functions hold CONNECTIONS_TOKEN, resolve the caller's org, and filter
 * every query by it. So the browser's whole vocabulary is executeFunction.
 */
async function call<T>(fn: string, handler: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await vibe.executeFunction(fn, handler, args)) as T;
}

export interface CurrentUser {
  user: { uid: number; email: string; name: string; username: string };
  org: { orgId: number };
}

/**
 * Single source of truth for "is the user signed in?".
 *
 * Returns null when the underlying getCurrentUser returned 401. Only this path
 * drives the login redirect — a 401 from any other call is surfaced as an error
 * rather than bouncing the user out mid-task.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  return (await vibe.getCurrentUser()) as CurrentUser | null;
}

export function login(): void {
  vibe.login();
}

export function logout(): void {
  vibe.logout();
}

// ---------------------------------------------------------------------------
// Reads. Each maps to one handler in functions/.
// ---------------------------------------------------------------------------

export interface OverviewMetrics {
  callsToday: number;
  deltaCalls: string;
  coverage: number;
  unchecked: number;
  missedSr: number;
  compliance: number;
  trend: string;
  corrections: number;
  verified: number;
  /** Total service requests in the CMMS, live. */
  srTotal: number;
  /** Sites the signed-in org actually has, from facilio-cmms.list-sites. */
  sites: string[];
  /** True when the org has no conversations yet — drives the first-run screen. */
  isFirstRun: boolean;
  /**
   * The call channel's OWN totals and its split by channel type.
   *
   * Not derived from what Hue stores — the gap between the two is ingest lag,
   * which is worth seeing. null when the channel is unreachable.
   */
  callStats: { total: number; byType: Record<string, number> } | null;
}

/**
 * A stored conversation row. Columns are text/numeric because the app's tables
 * are created by CSV import, which carries no types or constraints — booleans
 * arrive as 'true'/'false' and timestamps as ISO strings.
 */
export interface ConversationRow {
  id: string;
  call_id: string;
  started_at: string;
  duration_sec: number | null;
  caller_name: string | null;
  caller_phone: string | null;
  site_hint: string | null;
  status: string;
  sentiment: string | null;
  sr_claimed: string;
  sr_number_claimed: string | null;
  cmms_sr_id: string | null;
  join_method: string;
  join_confidence: number;
  eval_status: string;
  quality_score: number | null;
  deviation_count?: number;
  /** The caller's opening line, for the list row's second line. */
  snippet?: string | null;
  /** Where this call is in grading, derived server-side. */
  grading?: GradingState;
  /** How the conversation arrived, derived server-side from its channel row. */
  channel?: Channel;
}

export interface DeviationRow {
  id: string;
  conversation_id: string;
  criterion_id: string;
  clause_ref: string;
  summary: string;
  severity: string;
  root_cause: string;
  status: string;
  detected_at: string;
  detected_by: string;
  checked_sr_id: string | null;
  evidence: Array<{ at: string; who: string; quote: string; isViolation: boolean }>;
  caller_name?: string | null;
  caller_phone?: string | null;
  site_hint?: string | null;
  started_at?: string;
  cmms_sr_id?: string | null;
}

export interface TranscriptTurnRow {
  id: string;
  conversation_id: string;
  turn_index: number;
  performer: string;
  message: string;
  at_offset: string | null;
  tool_name: string | null;
  tool_status: string | null;
  tool_args: string | null;
  tool_result: string | null;
  tool_record_id: string | null;
  tool_error: string | null;
}

// ---------------------------------------------------------------------------
// Row -> contract mappers.
//
// The app's tables are created by CSV import, so every column comes back as
// snake_case text/numeric with no types. shared/contract.ts is the shape the
// UI is written against, so the conversion happens here, once, at the boundary
// — row shapes never reach a component.
// ---------------------------------------------------------------------------

const asBool = (v: unknown) => v === true || v === 'true';

/**
 * The arguments a tool was called with and the result it returned. Both are
 * stored and both are shown on the call detail, but `ToolCall` in the frozen
 * contract carries neither, so they ride alongside the turn instead of being
 * bolted into it — the same arrangement `DeviationWithEvidence` uses.
 */
export type TurnWithToolIO = TranscriptTurn & {
  toolArgs?: string | null;
  toolResult?: string | null;
};

function toTurn(r: TranscriptTurnRow): TurnWithToolIO {
  const turn: TurnWithToolIO = {
    performer: (r.performer as TranscriptTurn['performer']) ?? 'system',
    message: r.message ?? '',
  };
  if (r.at_offset) turn.at = r.at_offset;
  if (r.tool_name) {
    turn.toolCall = {
      name: r.tool_name,
      status: (r.tool_status as ToolCall['status']) ?? 'not_called',
      resultRecordId: r.tool_record_id,
      error: r.tool_error,
    };
    turn.toolArgs = r.tool_args;
    turn.toolResult = r.tool_result;
  }
  return turn;
}

/**
 * A conversation plus the three things Hue stores that the frozen contract has
 * no room for: the tool arguments and results on each turn, the caller's
 * opening line, and how many findings the call carries. It widens
 * `Conversation` rather than replacing it, so anything typed against the
 * contract still accepts one.
 */
export type ConversationView = Conversation & {
  transcript: TurnWithToolIO[];
  snippet: string | null;
  deviationCount: number;
  /**
   * 'seed' | 'live'. Derived from the id prefix, not a column — the app's DB
   * role cannot add one. Live calls are re-read from the connection on open.
   */
  source: string;
  /** How the CMMS join was resolved: 'sr_number' | 'site_time' | 'none'. */
  joinMethod: string;
  /**
   * What to caption the caller with. Live call logs leave `name` null on most
   * calls, so the phone number is the only identity the caller has.
   */
  callerLabel: string;
  /**
   * Where the call is in grading — awaiting, grading, graded or unavailable.
   * Derived on the server from eval_status and the call's claim/grade row, so
   * the list and the detail screen cannot tell different stories.
   */
  grading: GradingState | null;
  /**
   * How the conversation arrived — phone, web call, WhatsApp, chat, email —
   * and whether it can be graded as speech. Null only for rows that predate
   * channel tagging, which are all voice.
   */
  channel: Channel | null;
  /**
   * The reference the agent read back to the caller. Distinct from
   * `srRecordId`, which is the record the join actually resolved — when the
   * agent invents a number, this is set and that one is not.
   */
  srNumberClaimed: string | null;
};

/**
 * One call's stored grade, as `getConversation` returns it.
 *
 * The server has already applied the rule that `applicable=false` is
 * authoritative, so `responseQuality` is null on a call that could not be
 * judged — there is no stored 0 to misread here. `sentimentAgrees` is
 * tri-state: null means there was nothing to compare, not a disagreement.
 */
export interface CallGrade {
  id: string;
  conversationId: string;
  gradedAt: string;
  gradedBy: string;
  applicable: boolean;
  responseQuality: number | null;
  justification: string;
  sentiment: string;
  sentimentReason: string;
  sentimentChannel: string;
  sentimentAgrees: boolean | null;
  overallAssessment: string;
  criteriaSatisfied: string[];
  criteriaBreached: string[];
  criteriaGraded: string[];
  /** Judges that never answered. Never to be read as criteria that passed. */
  criteriaUnavailable: string[];
  agentVersion: string;
  schemaVersion: number;
}

export function toConversation(
  r: ConversationRow,
  turns: TranscriptTurnRow[] = [],
): ConversationView {
  return {
    id: r.id,
    callId: r.call_id,
    startedAt: r.started_at,
    durationSec: r.duration_sec ?? null,
    caller: { name: r.caller_name || null, phone: r.caller_phone || null },
    site: r.site_hint || null,
    status: (r.status as Conversation['status']) ?? 'completed',
    sentiment: (r.sentiment as Conversation['sentiment']) || null,
    // The claim, kept honestly distinct from the resolved join below.
    srCreated: asBool(r.sr_claimed),
    // Ground truth: the real CMMS record id, or null when the join found none.
    srRecordId: r.cmms_sr_id || null,
    evalStatus: (r.eval_status as Conversation['evalStatus']) ?? 'not_evaluated',
    qualityScore: r.quality_score ?? null,
    transcript: turns.map(toTurn),
    snippet: r.snippet ?? null,
    deviationCount: Number(r.deviation_count ?? 0),
    srNumberClaimed: r.sr_number_claimed || null,
    source: String(r.id ?? '').startsWith('L-') ? 'live' : 'seed',
    joinMethod: r.join_method || 'none',
    // Falls through name -> phone -> nothing, so a live call with no name is
    // still identified by the number that rang in rather than "Unknown caller".
    callerLabel: r.caller_name || r.caller_phone || 'Unknown caller',
    grading: r.grading ?? null,
    channel: r.channel ?? null,
  };
}

export function toDeviation(r: DeviationRow): Deviation {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    criterionId: r.criterion_id,
    clauseRef: r.clause_ref,
    summary: r.summary,
    severity: r.severity as Deviation['severity'],
    rootCause: r.root_cause as Deviation['rootCause'],
    status: r.status as Deviation['status'],
    detectedAt: r.detected_at,
  };
}

/**
 * Evidence, provenance and the joined call fields are Hue's own — not part of
 * the frozen contract — so they ride alongside the contract type rather than
 * being bolted into it.
 */
export type DeviationWithEvidence = Deviation & {
  evidence: DeviationRow['evidence'];
  checkedSrId: string | null;
  detectedBy: string;
  callerName: string | null;
  callerPhone: string | null;
  siteHint: string | null;
  /** Start of the call this finding came from — the Overview filters on it. */
  startedAt: string | null;
};

function withExtras(d: DeviationRow): DeviationWithEvidence {
  return {
    ...toDeviation(d),
    evidence: d.evidence ?? [],
    checkedSrId: d.checked_sr_id ?? null,
    detectedBy: d.detected_by,
    callerName: d.caller_name ?? null,
    callerPhone: d.caller_phone ?? null,
    siteHint: d.site_hint ?? null,
    startedAt: d.started_at ?? null,
  };
}

/**
 * Handler parameters may only be `number` or `string` — the Studio Functions
 * build rejects boolean/object/array. Anything structured crosses as a JSON
 * string (see `turnsJson`).
 */
export const api = {
  overview: () => call<OverviewMetrics>('governance', 'overview'),

  /** Sites, live from the CMMS. */
  sites: (pageSize = 50) =>
    call<{ sites: Array<{ id: string; name: string; siteType: string | null }>; count: number }>(
      'governance',
      'sites',
      { pageSize },
    ),

  /** Service requests, live from the CMMS. Never a stored copy. */
  serviceRequests: (pageSize = 50, page = 1, filters = '') =>
    call<{ count: number | null; requests: Array<Record<string, unknown>> }>(
      'governance',
      'serviceRequests',
      { pageSize, page, filters },
    ),

  listConversations: async (limit = 50): Promise<ConversationView[]> => {
    const { items } = await call<{ items: ConversationRow[] }>(
      'governance',
      'listConversations',
      { limit },
    );
    return items.map((r) => toConversation(r));
  },

  getConversation: async (
    id: string,
  ): Promise<{
    conversation: ConversationView;
    deviations: DeviationWithEvidence[];
    /** Fetched live from the CMMS at read time, not cached. */
    cmmsRecord: Record<string, unknown> | null;
    /** 'live' | 'stored' | 'stored_fallback' — where the transcript came from. */
    transcriptSource: string;
    /** The call's recording, when the channel has one. */
    recordingFileId: number | null;
    /** The channel's own AI summary (HTML), tags and satisfaction reading. */
    aiSummary: string | null;
    aiTags: string | null;
    satisfaction: string | null;
    /** The stored grade, or null when this call has never been graded. */
    grade: CallGrade | null;
    /** Where the call is in grading. Present even when there is no grade. */
    grading: GradingState | null;
    /** How the conversation arrived. */
    channel: Channel | null;
    /**
     * Criteria that cannot be answered on this conversation, with the reason.
     * Distinct from passed and from "the judge never answered".
     */
    notApplicable: NotApplicable[];
  }> => {
    const res = await call<{
      conversation: ConversationRow;
      turns: TranscriptTurnRow[];
      deviations: DeviationRow[];
      cmmsRecord: Record<string, unknown> | null;
      transcriptSource?: string;
      recordingFileId?: number | null;
      aiSummary?: string | null;
      aiTags?: string | null;
      satisfaction?: string | null;
      grade?: CallGrade | null;
      grading?: GradingState | null;
      channel?: Channel | null;
      notApplicable?: NotApplicable[];
    }>('governance', 'getConversation', { id });
    return {
      transcriptSource: res.transcriptSource ?? 'stored',
      recordingFileId: res.recordingFileId ?? null,
      aiSummary: res.aiSummary ?? null,
      aiTags: res.aiTags ?? null,
      satisfaction: res.satisfaction ?? null,
      conversation: toConversation(res.conversation, res.turns),
      deviations: res.deviations.map(withExtras),
      cmmsRecord: res.cmmsRecord,
      grade: res.grade ?? null,
      grading: res.grading ?? null,
      channel: res.channel ?? null,
      notApplicable: res.notApplicable ?? [],
    };
  },

  listDeviations: async (status = ''): Promise<DeviationWithEvidence[]> => {
    const { items } = await call<{ items: DeviationRow[] }>('governance', 'listDeviations', {
      status,
    });
    return items.map(withExtras);
  },

  /**
   * The two halves of a browser-side semantic evaluation. The model call
   * happens between them, in the browser, because it exceeds a Studio
   * Function's ~10s fetch ceiling.
   */
  semanticContext: (conversationId: string, criterionId: string) =>
    call<{
      skip: string | null;
      criterion?: { id: string; clauseRef: string; requires: string };
      transcript?: Array<{ performer: string; at: string | null; message: string }>;
      cmmsRecord?: Record<string, unknown> | null;
    }>('governance', 'semanticContext', { conversationId, criterionId }),

  saveSemanticVerdict: (v: {
    conversationId: string;
    criterionId: string;
    verdict: string;
    severity?: string;
    summary?: string;
    evidenceJson?: string;
  }) =>
    call<{ recorded: boolean; retracted: boolean; openNow: number }>(
      'governance',
      'saveSemanticVerdict',
      {
        conversationId: v.conversationId,
        criterionId: v.criterionId,
        verdict: v.verdict,
        severity: v.severity ?? '',
        summary: v.summary ?? '',
        evidenceJson: v.evidenceJson ?? '[]',
      },
    ),

  /**
   * Every occurrence of one criterion, for the pattern-level fix proposer.
   * No model work — the model call happens in the browser afterwards.
   */
  patternContext: (criterionId: string) =>
    call<import('./judges').PatternContext>('governance', 'patternContext', { criterionId }),

  /**
   * How far behind the stored calls are, and how many await grading.
   * Read-only: safe to call from every open tab at once.
   */
  syncStatus: () =>
    call<{
      stored: number;
      available: number | null;
      reachable: boolean;
      awaitingIngest: number | null;
      awaitingGrading: number;
      graded: number;
      intervalSeconds: number;
    }>('governance', 'syncStatus'),

  /**
   * Where every call is in grading — or one call, when given an id.
   *
   * Deliberately light: no CMMS read, no transcript, no findings. The screens
   * poll it every few seconds WHILE something is in flight and stop the moment
   * nothing is, so a settled app makes no requests at all.
   */
  gradingStatus: (conversationId = '') =>
    call<{ items: Array<GradingState & { id: string }>; inFlight: number }>(
      'governance',
      'gradingStatus',
      { conversationId },
    ),

  /**
   * Pull in any calls that have arrived since the page loaded.
   *
   * The server takes an ingest lease before it stores anything, so two people
   * pressing Refresh at the same moment cannot write the same call twice —
   * `skipped` means someone else's pull is already doing the work.
   */
  refreshCalls: () =>
    call<{
      skipped: boolean;
      reason?: string;
      ingested: number;
      conversationIds: string[];
      failed?: Array<{ callLogId: string; error: string }>;
    }>('callingest', 'refresh'),

  /**
   * Ask the server to grade a call or two NOW instead of waiting for the job.
   *
   * Safe to call from every open tab: the server claims each call before
   * grading it, so two people reloading at the same moment take different
   * calls and never the same one. Grading itself stays server-side — this
   * only makes it happen sooner.
   */
  nudgeGrading: () =>
    call<{
      graded: number;
      details: Array<{ id: string; findings: number; join: string | null }>;
      failed: Array<{ id: string; error: string }>;
      stoppedForBudget: boolean;
      stillUngraded: number;
      elapsedSeconds: number;
    }>('governance', 'nudgeGrading'),

  /**
   * The scope of work in force, and the evals generated from it.
   *
   * `upstreamReadable` reports whether the helpdesk agent's own prompt can be
   * fetched yet. It cannot — see docs/platform-ask-agent-scope.md — which is a
   * state this screen is designed to sit in, not an error.
   */
  currentSow: () =>
    call<{
      sow: {
        id: string; fingerprint: string; title: string; body: string;
        source: string; sourceRef: string; fetchedAt: string; savedBy: string;
      } | null;
      evals: Array<{
        id: string; criterionId: string; clauseRef: string; title: string;
        description: string; passDefinition: string; failDefinition: string;
        layer: string; checkType: string; severity: string; modality: string;
        active: boolean; approved: boolean; generatedAt: string;
        generatedBy: string; sourceExcerpt: string;
        /** Only semantic evals can actually be judged. */
        runnable: boolean;
      }>;
      upstreamReadable: boolean;
      upstreamDrifted: boolean;
    }>('governance', 'currentSow'),

  /**
   * A playable URL for one call's recording.
   *
   * Fetched on demand and never stored: the channel hands back a PRE-SIGNED
   * url that expires, so a cached one becomes a play button that works until
   * it silently does not.
   */
  callRecording: (conversationId: string) =>
    call<{
      available: boolean;
      reason?: string;
      url?: string;
      fileId?: number;
      contentType?: string;
      sizeBytes?: number;
    }>('governance', 'callRecording', { conversationId }),

  /** Store the scope of work, and learn whether it CHANGED. */
  saveSow: (a: { body: string; title: string; savedBy: string }) =>
    call<{
      id: string; fingerprint: string; changed: boolean;
      evalCount: number; needsGeneration: boolean;
    }>('governance', 'saveSow', a),

  /**
   * Add a criterion by hand. Stored beside the generated ones and graded like
   * them, but marked manual so a regeneration never sweeps it away and an edit
   * to the scope of work never unbinds it.
   */
  saveCustomEval: (a: {
    title: string; clauseRef: string; description: string;
    passDefinition: string; failDefinition: string;
    severity: string; layer: string; modality: string; savedBy: string;
  }) =>
    call<{ criterionId: string; id: string; updated: boolean; runnable: boolean }>(
      'governance',
      'saveCustomEval',
      a,
    ),

  /** Persist the criteria the eval writer produced. Server re-validates each. */
  saveGeneratedEvals: (a: { sowFingerprint: string; evalsJson: string; generatedBy: string }) =>
    call<{
      saved: number; criteria: string[];
      rejected: Array<{ criterionId: string; why: string }>;
      retired: number; sowFingerprint: string;
    }>('governance', 'saveGeneratedEvals', a),

  /**
   * Every semantic criterion a conversation should be graded against — the
   * seeded set plus the active generated evals. The browser walks this, so a
   * criterion added to the SOW starts grading with no code change.
   */
  gradingCriteria: () =>
    call<{
      sowFingerprint: string;
      seeded: Array<{ id: string; clauseRef: string; requires: string }>;
      generated: Array<{ id: string; clauseRef: string; title: string; requires: string; severity: string; modality: string }>;
      notRunnable: string[];
      items: Array<{ id: string; clauseRef: string; requires: string }>;
    }>('governance', 'gradingCriteria'),

  /** Transcript + CMMS record + active criteria, for the call analyst. */
  callAnalysisContext: (conversationId: string) =>
    call<{
      transcript: Array<{ performer: string; at: string | null; message: string }>;
      cmmsRecord: Record<string, unknown> | null;
      criteria: Array<{ id: string; clauseRef: string; requires: string }>;
      channelSentiment: string | null;
      srClaimed: boolean;
      durationSec: number | null;
    }>('governance', 'callAnalysisContext', { conversationId }),

  /**
   * Persist a whole call analysis — the grade row and the denormalised score,
   * written together by the one function allowed to write either.
   *
   * Handler parameters may only be `number` or `string`, so the criteria lists
   * cross as comma-separated ids. That is also how the columns are defined.
   */
  saveCallAnalysis: (a: {
    conversationId: string;
    applicable: number;
    responseQuality: number;
    sentiment: string;
    justification: string;
    sentimentReason: string;
    overallAssessment: string;
    criteriaSatisfied: string;
    criteriaBreached: string;
    criteriaGraded: string;
    criteriaUnavailable: string;
    agentVersion: string;
    gradedBy: string;
  }) =>
    call<{
      gradeId: string;
      scoreWritten: number | null;
      sentimentWritten: string | null;
      sentimentAgrees: string;
      channelSentiment: string | null;
      gradedAt: string;
    }>('governance', 'saveCallAnalysis', a),

  /** Persist a proposal the browser-side judges produced. */
  saveCorrection: (deviationId: string, rootCause: string, proposalJson: string) =>
    call<{ correctionId: string; deviationId: string; target: string; title: string }>(
      'governance',
      'saveCorrection',
      { deviationId, rootCause, proposalJson },
    ),

  /** Join to the real CMMS record and run the deterministic checks against it. */
  evaluate: (conversationId: string) =>
    call<{
      conversationId: string;
      join: { cmmsSrId: string | null; method: string; confidence: number };
      checksRun: number;
      deviationsFound: number;
      findings: Array<{ criterionId: string; severity: string; summary: string }>;
    }>('governance', 'evaluate', { conversationId }),
};
