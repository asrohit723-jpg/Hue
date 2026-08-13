import { api, vibe } from './vibe';

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

const AGENTS_LABEL: Record<string, string> = {
  [AGENTS.conformance]: 'The conformance judge',
  [AGENTS.rootCause]: 'The root-cause classifier',
  [AGENTS.proposer]: 'The correction proposer',
};

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

/** Every criterion graded by a model rather than by code. */
export const SEMANTIC_CRITERIA = [
  'CR-LOG-01',
  'CR-LOG-04',
  'CR-SCHED-01',
  'CR-CAT-01',
] as const;

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
