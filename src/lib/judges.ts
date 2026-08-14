import { api, vibe } from './vibe';
import { SEMANTIC_CRITERIA } from './criteria';

export { SEMANTIC_CRITERIA };

/**
 * Client-side judge runners.
 *
 * The judges run in the browser via `vibe.executeAgent`, which has no request
 * ceiling — unlike a Studio Function's `fetch`, which aborts at ~10s. Measured
 * agent latencies are 9s / 14s / 20s, so two of the three could never complete
 * server-side.
 *
 * Only the model calls moved. Everything with a side effect — persisting the
 * correction, writing to the CMMS, the idempotency guard — stays in a server
 * function, where it runs in about a second and is never at risk of a timeout.
 * The browser decides nothing; it relays a verdict to the server, which
 * validates it before it drives a write.
 */

/**
 * `executeAgent` resolves an agent by its LOGICAL name — the server derives the
 * app from the request host. The `_<apphash>` link name is not used here.
 */
const AGENTS = {
  conformance: 'sow-conformance-judge',
  rootCause: 'root-cause-classifier',
  proposer: 'correction-proposer',
  callAnalysis: 'call-analysis',
  evalWriter: 'eval-writer',
} as const;

export class JudgeTimeout extends Error {}
export class JudgeInvalid extends Error {}

function looksTransient(message: string): boolean {
  return /abort|timed? ?out|network|fetch|502|503|504|ECONN/i.test(message);
}

/**
 * Run one agent and parse its structured reply.
 *
 * Structured-output agents return `content` as a JSON *string*, never a nested
 * object — parsing is required, not defensive.
 */
async function runAgent<T>(agent: string, input: unknown, attempts = 2): Promise<T> {
  let lastError = '';
  let transient = false;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = (await vibe.executeAgent(agent, JSON.stringify(input))) as {
        response?: { content?: string };
        content?: string;
      };
      const content = res?.response?.content ?? res?.content ?? null;
      if (typeof content !== 'string') {
        throw new JudgeInvalid(`Agent ${agent} returned no string content.`);
      }
      try {
        return JSON.parse(content) as T;
      } catch {
        throw new JudgeInvalid(`Agent ${agent} returned content that is not valid JSON.`);
      }
    } catch (err) {
      // An unusable reply is a real fault — retrying will not fix a schema
      // mismatch, so fail fast rather than burning another 20 seconds.
      if (err instanceof JudgeInvalid) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      transient = looksTransient(lastError);
    }
  }

  // Exhausted. A judge that never answered is UNKNOWN — never a pass.
  throw transient
    ? new JudgeTimeout(`${AGENTS_LABEL[agent] ?? agent} did not respond. ${lastError}`)
    : new Error(`${AGENTS_LABEL[agent] ?? agent} failed: ${lastError}`);
}

/**
 * Stamped on every grade this file produces, so a stored score can be traced to
 * what produced it. A grade with no provenance is a number nobody can re-check.
 */
const CALL_ANALYSIS_VERSION = `${AGENTS.callAnalysis}@claude-opus-4-7`;

const AGENTS_LABEL: Record<string, string> = {
  [AGENTS.conformance]: 'The conformance judge',
  [AGENTS.rootCause]: 'The root-cause classifier',
  [AGENTS.proposer]: 'The correction proposer',
  [AGENTS.callAnalysis]: 'The call analyst',
  [AGENTS.evalWriter]: 'The eval writer',
};

/** Stamped on every generated eval, so a criterion can be traced to its author. */
const EVAL_WRITER_VERSION = `${AGENTS.evalWriter}@claude-opus-4-7`;

/** One criterion the eval writer produced from the scope of work. */
export interface GeneratedCriterion {
  criterionId: string;
  clauseRef: string;
  title: string;
  description: string;
  passDefinition: string;
  failDefinition: string;
  layer: 'deterministic' | 'semantic';
  checkType: string;
  severity: string;
  modality: 'voice' | 'text' | 'any';
  /** The SOW sentence this came from, verbatim. */
  sourceExcerpt: string;
}

/**
 * Turn the stored scope of work into testable criteria, and save them.
 *
 * Runs in the browser like every other agent — a Studio Function aborts a fetch
 * at ~10s and this prompt carries a whole scope of work. The server re-validates
 * every criterion before it is stored: the browser proposes what to grade
 * against, it does not decide.
 *
 * The SOW fingerprint travels with the request so the server can refuse a set
 * generated from text that is no longer current — otherwise a slow generation
 * could attach criteria to a scope of work nobody grades against any more.
 */
export async function generateEvals(sow: {
  fingerprint: string;
  title: string;
  body: string;
}): Promise<{ saved: number; criteria: string[]; rejected: Array<{ criterionId: string; why: string }>; retired: number }> {
  const v = await runAgent<{ criteria: GeneratedCriterion[] }>(AGENTS.evalWriter, {
    scopeOfWork: sow.body,
    title: sow.title,
  });

  const criteria = Array.isArray(v?.criteria) ? v.criteria : [];
  if (!criteria.length) {
    throw new JudgeInvalid('The eval writer returned no criteria for this scope of work.');
  }

  return await api.saveGeneratedEvals({
    sowFingerprint: sow.fingerprint,
    evalsJson: JSON.stringify(criteria),
    generatedBy: EVAL_WRITER_VERSION,
  });
}

// ---------------------------------------------------------------------------
// Verdict shapes — mirror the JSON schemas in evals/schemas/
// ---------------------------------------------------------------------------

export interface RootCauseVerdict {
  rootCause: 'agent' | 'data' | 'sow' | 'unknown';
  rootCauseLabel: string;
  rootCauseDetail: string;
  needsHuman: boolean;
  confidence: number;
}

export interface CorrectionProposal {
  target: 'prompt' | 'mapping' | 'sow' | 'human';
  title: string;
  rationale: string;
  afterText: string;
  cmmsAction: {
    verb: 'create' | 'update' | 'none';
    recordId: string;
    fields: Array<{ label: string; value: string }>;
  };
  humanTask: string;
}

/** Context both judges need. Kept small — it is also what the model reads. */
export interface JudgeContext {
  deviation: {
    id: string;
    criterionId: string;
    clauseRef: string;
    summary: string;
    severity: string;
    rootCause?: string;
    evidence: Array<{ at: string; who: string; quote: string; isViolation: boolean }>;
  };
  keyTurns: Array<{ performer: string; at: string | null; message: string }>;
  cmmsRecord: Record<string, unknown> | null;
}

/** What the conformance judge returns when grading one criterion. */
export interface ConformanceVerdict {
  verdict: 'pass' | 'fail' | 'not_applicable';
  severity?: 'critical' | 'high' | 'medium' | 'low';
  summary?: string;
  confidence?: number;
  evidence?: Array<{ at: string; who: string; quote: string; isViolation: boolean }>;
}

/**
 * Grade one semantic criterion.
 *
 * This is the detection judge, and it runs here for the same reason the
 * correction judges do: a Studio Function's fetch aborts at ~10s, and this one
 * routinely needs longer on a full transcript. Server-side it timed out on
 * nearly every call — `run-agent-chat` blocks until the model is done, so no
 * amount of spacing the calls out helps when the ceiling is per request.
 */
export async function judgeConformance(input: {
  criterion: { id: string; clauseRef: string; requires: string };
  transcript: Array<{ performer: string; at: string | null; message: string }>;
  cmmsRecord: Record<string, unknown> | null;
}): Promise<ConformanceVerdict> {
  const v = await runAgent<ConformanceVerdict>(AGENTS.conformance, input);
  if (['pass', 'fail', 'not_applicable'].indexOf(v?.verdict) < 0) {
    throw new JudgeInvalid(`Conformance judge returned an unusable verdict: ${v?.verdict}`);
  }
  return v;
}


export interface SemanticRun {
  criterionId: string;
  verdict: 'pass' | 'fail' | 'not_applicable' | 'skipped' | 'unavailable';
  recorded?: boolean;
  retracted?: boolean;
  summary?: string;
  error?: string;
}

/**
 * Grade one criterion end to end: fetch context from the server, run the judge
 * here, hand the verdict back to the server to validate and persist.
 *
 * A judge that never answers resolves to `unavailable` and writes nothing. That
 * is the whole point of the degrade rule — an ungraded criterion must never be
 * mistaken for a passing one.
 */
export async function runSemanticCriterion(
  conversationId: string,
  criterionId: string,
): Promise<SemanticRun> {
  try {
    const ctx = await api.semanticContext(conversationId, criterionId);
    if (ctx.skip || !ctx.criterion || !ctx.transcript) {
      return { criterionId, verdict: 'skipped' };
    }

    const v = await judgeConformance({
      criterion: ctx.criterion,
      transcript: ctx.transcript,
      cmmsRecord: ctx.cmmsRecord ?? null,
    });

    const saved = await api.saveSemanticVerdict({
      conversationId,
      criterionId,
      verdict: v.verdict,
      severity: v.severity,
      summary: v.summary,
      evidenceJson: JSON.stringify(v.evidence ?? []),
    });

    return {
      criterionId,
      verdict: v.verdict,
      recorded: saved.recorded,
      retracted: saved.retracted,
      summary: v.summary,
    };
  } catch (err) {
    if (err instanceof JudgeTimeout) {
      return { criterionId, verdict: 'unavailable', error: err.message };
    }
    return {
      criterionId,
      verdict: 'unavailable',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Grade every semantic criterion for one call, one at a time. */
export async function runSemanticSuite(conversationId: string): Promise<SemanticRun[]> {
  const out: SemanticRun[] = [];
  for (const criterionId of SEMANTIC_CRITERIA) {
    out.push(await runSemanticCriterion(conversationId, criterionId));
  }
  return out;
}

export async function classifyRootCause(ctx: JudgeContext): Promise<RootCauseVerdict> {
  const v = await runAgent<RootCauseVerdict>(AGENTS.rootCause, ctx);
  if (['agent', 'data', 'sow', 'unknown'].indexOf(v?.rootCause) < 0) {
    throw new JudgeInvalid(`Classifier returned an unusable rootCause: ${v?.rootCause}`);
  }
  return v;
}

/** One pattern's worth of context, from the `patternContext` handler. */
export interface PatternContext {
  criterionId: string;
  clauseRef?: string;
  requires?: string | null;
  count: number;
  openCount?: number;
  sites?: string[];
  withoutRecord?: number;
  representativeId?: string;
  occurrences: Array<{
    conversationId: string;
    caller: string;
    site: string | null;
    severity: string;
    summary: string;
    cmmsRecordExists: boolean;
    evidence: Array<{ at: string; who: string; quote: string; isViolation: boolean }>;
  }>;
}

/**
 * Propose ONE fix for a whole pattern.
 *
 * The per-deviation proposer answers "how do we repair this call". This asks a
 * different question — "what single change stops all N of these" — so the model
 * is given every occurrence at once rather than one, and told plainly that a
 * fix which only repairs one call is the wrong answer.
 *
 * It runs here, in the browser, for the same reason the other judges do: a
 * Studio Function's fetch aborts at ~10s and this prompt is larger than any of
 * them. The result is persisted by the server through `saveCorrection`, which
 * re-validates it — the browser proposes, it does not decide.
 */
export async function proposePatternFix(ctx: PatternContext): Promise<CorrectionProposal> {
  const v = await runAgent<CorrectionProposal>(AGENTS.proposer, {
    task: 'pattern_fix',
    instruction:
      `This criterion has failed on ${ctx.count} separate calls. Propose ONE change that prevents ` +
      `all of them, at the source. A fix that only repairs a single call is the wrong answer here. ` +
      `Say plainly where the change belongs — the agent prompt, a data mapping, or the scope of work itself.`,
    criterion: { id: ctx.criterionId, clauseRef: ctx.clauseRef, requires: ctx.requires },
    occurrenceCount: ctx.count,
    sitesAffected: ctx.sites ?? [],
    occurrencesWithNoCmmsRecord: ctx.withoutRecord ?? 0,
    occurrences: ctx.occurrences,
  });
  if (['prompt', 'mapping', 'sow', 'human'].indexOf(v?.target) < 0) {
    throw new JudgeInvalid(`Pattern proposer returned an unusable target: ${v?.target}`);
  }
  return v;
}

export async function proposeCorrection(ctx: JudgeContext): Promise<CorrectionProposal> {
  const v = await runAgent<CorrectionProposal>(AGENTS.proposer, ctx);
  if (['prompt', 'mapping', 'sow', 'human'].indexOf(v?.target) < 0) {
    throw new JudgeInvalid(`Proposer returned an unusable target: ${v?.target}`);
  }
  if (!v.cmmsAction || ['create', 'update', 'none'].indexOf(v.cmmsAction.verb) < 0) {
    throw new JudgeInvalid(`Proposer returned an unusable cmmsAction.verb.`);
  }
  return v;
}

/** What the call analyst returns. Mirrors the agent's HueCallAnalysis schema. */
export interface CallAnalysis {
  applicable: boolean;
  responseQuality?: number | null;
  responseQualityJustification: string;
  sentiment: 'happy' | 'neutral' | 'frustrated' | 'distressed' | 'unknown';
  sentimentReason: string;
  overallAssessment: string;
  criteriaSatisfied?: string[];
  criteriaBreached?: string[];
}

export interface CallAnalysisRun {
  ok: boolean;
  analysis?: CallAnalysis;
  /** What the channel's own model said, for the reconciliation line. */
  channelSentiment?: string | null;
  scoreWritten?: number | null;
  error?: string;
  unavailable?: boolean;
}

/**
 * Read one call end to end and fill what the transcript actually supports.
 *
 * Deliberately NOT a scorer of the audio pipeline: latency, speech-to-text and
 * text-to-speech are properties of sound this has never heard, and the agent is
 * instructed to refuse them. They stay "not measured" on the scorecard.
 *
 * Runs in the browser like every other judge — the prompt carries a whole
 * transcript plus the criteria, so it is nowhere near the ~10s function ceiling.
 * A call too thin to judge comes back applicable=false and writes no score; a
 * judge that never answers comes back unavailable and writes nothing at all.
 */
export async function runCallAnalysis(
  conversationId: string,
  run?: {
    /** Criteria actually attempted this run. */
    graded?: string[];
    /** Of those, the ones whose judge never answered. */
    unavailable?: string[];
  },
): Promise<CallAnalysisRun> {
  try {
    const ctx = await api.callAnalysisContext(conversationId);
    const v = await runAgent<CallAnalysis>(AGENTS.callAnalysis, {
      transcript: ctx.transcript,
      cmmsRecord: ctx.cmmsRecord,
      criteria: ctx.criteria,
      agentClaimedARequest: ctx.srClaimed,
      channelSatisfactionSignal: ctx.channelSentiment,
      durationSec: ctx.durationSec,
    });

    if (typeof v?.applicable !== 'boolean') {
      throw new JudgeInvalid('Call analyst returned no applicable flag.');
    }

    const saved = await api.saveCallAnalysis({
      conversationId,
      applicable: v.applicable ? 1 : 0,
      responseQuality: typeof v.responseQuality === 'number' ? v.responseQuality : -1,
      sentiment: v.sentiment ?? '',
      justification: v.responseQualityJustification ?? '',
      sentimentReason: v.sentimentReason ?? '',
      overallAssessment: v.overallAssessment ?? '',
      criteriaSatisfied: (v.criteriaSatisfied ?? []).join(','),
      criteriaBreached: (v.criteriaBreached ?? []).join(','),
      // What this run attempted, and which of those never came back. Storing
      // the second is what keeps "the judge was unreachable" distinct from
      // "the criterion passed" once the page is reloaded and the run is gone.
      criteriaGraded: (run?.graded ?? []).join(','),
      criteriaUnavailable: (run?.unavailable ?? []).join(','),
      agentVersion: CALL_ANALYSIS_VERSION,
      gradedBy: 'manual',
    });

    return {
      ok: true,
      analysis: v,
      channelSentiment: saved.channelSentiment,
      scoreWritten: saved.scoreWritten,
    };
  } catch (err) {
    if (err instanceof JudgeTimeout) {
      return { ok: false, unavailable: true, error: err.message };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
