import { vibe } from './vibe';

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
