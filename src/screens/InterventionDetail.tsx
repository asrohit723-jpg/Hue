import { useEffect, useRef, useState } from 'react';
import { api, vibe, type ConversationView, type DeviationWithEvidence } from '../lib/vibe';
import { BootSkeleton } from './BootSkeleton';
import { LoadError } from '../components/Chrome';
import { clock, duration, label, rootCauseTone, sentimentTone, severityTone } from '../lib/tone';
import criteriaSeed from '../../evals/criteria.seed.json';
import { page } from '../lib/layout';
import {
  classifyRootCause,
  generateEvals,
  proposeCorrection,
  JudgeTimeout,
  type JudgeContext,
} from '../lib/judges';

/**
 * Server calls used by the correction loop. These are all fast (~1s) and carry
 * no model work: fetching context, persisting a verdict, writing to the CMMS.
 * The judges themselves run in the browser — see analyse() below.
 */
async function callFn<T>(handler: string, args: Record<string, unknown>): Promise<T> {
  return (await vibe.executeFunction('governance', handler, args)) as T;
}

/** Anything the judges return that the panel needs to render. */
interface CorrectionOutcome {
  stage?: string;
  ok?: boolean;
  error?: string | null;
  retryable?: boolean;
  rootCause?: string;
  correctionId?: string;
  target?: string;
  title?: string;
  cmmsAction?: unknown;
  humanTask?: string;
  state?: string;
  appliedRecordId?: string | null;
  alreadyApplied?: boolean;
  verified?: boolean;
}

type ActionState = {
  busy: string | null;
  /** A hard failure: bad data, unusable verdict, or a thrown handler error. */
  error: string | null;
  /**
   * A judge that never finished. Held separately from `error` because the
   * meaning is different — nothing was learned, so the honest state is
   * "unknown, try again", not "no problem found".
   */
  timeout: string | null;
  outcome: CorrectionOutcome | null;
};

const IDLE: ActionState = { busy: null, error: null, timeout: null, outcome: null };

/** The stored correction, as `getCorrection` returns it. */
/**
 * What the agent is told TODAY about the clause this finding cites.
 *
 * `source` says where it came from, and the screen must not blur them: only
 * 'agent_prompt' is the agent's live configuration, and that one is not
 * reachable yet. The rest are the scope of work, which is a faithful stand-in
 * and must be labelled as one.
 */
interface CurrentClause {
  source: 'agent_prompt' | 'generated_eval' | 'sow_clause' | 'sow_no_clause' | 'none';
  clauseRef: string;
  text: string;
  reference: string;
  reason?: string;
}

interface CorrectionRecord {
  id: string;
  deviationId: string;
  target: string | null;
  title: string | null;
  rationale: string | null;
  beforeText: string | null;
  afterText: string | null;
  state: string;
  recommendedAction: string | null;
  assignee: string | null;
  cmmsAction: { verb?: string; recordId?: string; fields?: Array<{ label: string; value: string }> };
  proposedAt: string | null;
  appliedAt: string | null;
  appliedRecordId: string | null;
}

/** Criterion id -> its seeded title, clause and layer. */
const byId = new Map(
  (
    criteriaSeed as {
      criteria: Array<{
        id: string;
        title: string;
        description: string;
        clauseRef: string;
        layer: string;
      }>;
    }
  ).criteria.map((c) => [c.id, c]),
);

/** The function tags an unfinished judge with this prefix. */
const JUDGE_TIMEOUT = 'JUDGE_TIMEOUT';

export function InterventionDetail({
  deviationId,
  onBack,
  onOpenCall,
  onViewPattern,
}: {
  deviationId: string;
  onBack: () => void;
  onOpenCall: (conversationId: string) => void;
  onViewPattern?: () => void;
}) {
  const [dev, setDev] = useState<DeviationWithEvidence | null>(null);
  const [allDeviations, setAllDeviations] = useState<DeviationWithEvidence[]>([]);
  const [corr, setCorr] = useState<CorrectionRecord | null>(null);
  const [convo, setConvo] = useState<ConversationView | null>(null);
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [act, setAct] = useState<ActionState>(IDLE);
  // What the CMMS write would actually do, decided by the server from the join
  // rather than by the proposer — so the button cannot promise a create while
  // the server performs an update.
  const [cmmsPlan, setCmmsPlan] = useState<{ verb: string; recordId: string | null; reason: string } | null>(null);
  // The "before" of the diff: what the agent is told today about this clause.
  // Read from the scope of work, because its live prompt is not exposed.
  const [currentClause, setCurrentClause] = useState<CurrentClause | null>(null);
  const [sowNote, setSowNote] = useState<string | null>(null);
  // Auto-draft runs ONCE per deviation, not once per render and not on every
  // nonce bump — a screen that re-drafts on refresh burns two agent calls each
  // time and can overwrite a draft somebody is reading.
  const drafted = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setDev(null);
      setError(null);
      try {
        const all = await api.listDeviations('');
        const found = all.find((d) => d.id === deviationId) ?? null;
        if (!found) throw new Error(`Deviation ${deviationId} not found`);
        if (cancelled) return;
        setDev(found);
        // Kept for the "Seen before" cell — how often this criterion has failed.
        setAllDeviations(all);

        const [call, correction] = await Promise.all([
          api.getConversation(found.conversationId),
          callFn<{ correction: CorrectionRecord | null; cmmsPlan?: any; currentClause?: any }>(
            'getCorrection',
            { deviationId },
          ).catch(() => ({ correction: null, cmmsPlan: null, currentClause: null })),
        ]);
        if (cancelled) return;
        setConvo(call.conversation);
        setRecord(call.cmmsRecord);
        // Read on load so the diff and the applied -> verifying -> resolved
        // progression survive a refresh rather than living only in this
        // session's action state.
        setCorr(correction.correction);
        setCmmsPlan((correction as any).cmmsPlan ?? null);
        setCurrentClause((correction as any).currentClause ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [deviationId, nonce]);

  async function run(handler: string, args: Record<string, unknown>, verb: string) {
    setAct({ ...IDLE, busy: verb });
    try {
      const res = await callFn<CorrectionOutcome>(handler, args);

      // runCorrection reports failure in its RESULT rather than throwing, so a
      // successful call can still describe an unfinished judge. Read the body,
      // never just the absence of an exception.
      if (res && res.ok === false) {
        const msg = String(res.error ?? 'The step did not complete.');
        setAct({
          busy: null,
          timeout: res.retryable ? msg : null,
          error: res.retryable ? null : msg,
          // Keep whatever did succeed — a stage-1 result survives a stage-2 timeout.
          outcome: res,
        });
        setNonce((n) => n + 1);
        return;
      }

      setAct({ busy: null, error: null, timeout: null, outcome: res ?? null });
      setNonce((n) => n + 1);
    } catch (err) {
      // Handlers that still throw (classify/propose/approve) land here.
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.includes(JUDGE_TIMEOUT) || /abort|timed? ?out/i.test(msg);
      setAct({
        busy: null,
        timeout: isTimeout ? msg : null,
        error: isTimeout ? null : msg,
        outcome: null,
      });
    }
  }

  /**
   * Classify and draft, with both judges running IN THE BROWSER.
   *
   * `vibe.executeAgent` has no ~10s ceiling, so the 14s classifier and 20s
   * proposer both complete — neither could ever finish inside a function. The
   * verdicts are then posted to the server, which re-validates them before
   * writing: the browser relays a judgement, it does not get to assert one.
   */
  async function analyse() {
    setAct({ ...IDLE, busy: 'classify' });
    try {
      const ctx = await callFn<JudgeContext>('judgeContext', { deviationId: deviationId });

      const rc = await classifyRootCause(ctx);
      // Show the classification as soon as it lands — the proposal takes
      // another ~20s and there is no reason to hide finished work.
      setAct({ ...IDLE, busy: 'propose', outcome: { rootCause: rc.rootCause } });

      const proposal = await proposeCorrection({
        ...ctx,
        deviation: { ...ctx.deviation, rootCause: rc.rootCause },
      });

      const saved = await callFn<CorrectionOutcome>('saveCorrection', {
        deviationId: deviationId,
        rootCause: rc.rootCause,
        proposalJson: JSON.stringify(proposal),
      });

      setAct({
        busy: null,
        error: null,
        timeout: null,
        outcome: {
          ...saved,
          stage: 'complete',
          ok: true,
          rootCause: rc.rootCause,
          title: proposal.title,
          humanTask: proposal.humanTask,
          cmmsAction: proposal.cmmsAction,
        },
      });
      setNonce((n) => n + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAct((prev) => ({
        busy: null,
        // A judge that never answered is unknown, not a pass — same rule as
        // before, just enforced on this side of the wire now.
        timeout: err instanceof JudgeTimeout ? msg : null,
        error: err instanceof JudgeTimeout ? null : msg,
        outcome: prev.outcome,
      }));
    }
  }


  /**
   * Draft on open, so the human arrives at filled panels rather than a button.
   *
   * ONCE PER DEVIATION. Guarded by a ref rather than by correction state,
   * because a nonce bump re-runs the load and would otherwise re-draft while
   * somebody is reading — two agent calls and a replaced draft, for nothing.
   *
   * Only when nothing has been drafted yet: a deviation that already carries a
   * correction is read from the database, so reopening costs no model work.
   *
   * Drafting never commits. The CMMS and the scope of work are written only by
   * the buttons, which is what makes drafting early safe.
   */
  useEffect(() => {
    if (!dev || corr || act.busy) return;
    if (drafted.current === dev.id) return;
    drafted.current = dev.id;
    void analyse();
  }, [dev, corr]);

  /**
   * Approve the agent-side fix: write it into the scope of work.
   *
   * The evals regenerate here, in the browser, because the eval writer is an
   * agent and no agent may run in a function. A scope of work that changed
   * without its evals following would keep grading calls against the old text.
   */
  async function approveSowFix() {
    if (!corr) return;
    setSowNote(null);
    setAct({ ...IDLE, busy: 'sow' });
    try {
      const res = await callFn<{
        alreadyApplied: boolean;
        fingerprint: string;
        changed: boolean;
        needsEvalRegeneration?: boolean;
        note?: string;
      }>('applySowFix', { correctionId: corr.id });

      if (res.alreadyApplied) {
        setSowNote(res.note || 'The scope of work already carries this fix.');
      } else if (res.needsEvalRegeneration) {
        setAct({ ...IDLE, busy: 'evals' });
        const sow = await api.currentSow();
        if (sow.sow) {
          const gen = await generateEvals({
            fingerprint: sow.sow.fingerprint,
            title: sow.sow.title,
            body: sow.sow.body,
          });
          setSowNote(`Written into the scope of work · ${gen.saved} evals rewritten`);
        } else {
          setSowNote('Written into the scope of work.');
        }
      } else {
        setSowNote('Written into the scope of work.');
      }
      setAct({ ...IDLE, busy: null });
      setNonce((n) => n + 1);
    } catch (err) {
      setAct({
        busy: null,
        error: err instanceof Error ? err.message : String(err),
        timeout: null,
        outcome: null,
      });
    }
  }

  if (error) return <div style={page('24px 28px')}><LoadError message={error} onRetry={() => setNonce((n) => n + 1)} /></div>;
  if (!dev) return <BootSkeleton label="Loading finding…" />;

  const sevT = severityTone(dev.severity);
  const rcT = rootCauseTone(dev.rootCause || 'unknown');
  const rec = record as any;

  const meta = byId.get(dev.criterionId);
  const criterionTitle = meta?.title ?? dev.criterionId;
  const clauseText = meta?.description ?? null;
  const status = correctionStatus(corr?.state);
  const seenBefore = allDeviations.filter((d) => d.criterionId === dev.criterionId).length;
  const caller = convo?.callerLabel ?? dev.callerName ?? dev.callerPhone ?? 'Unknown caller';
  const site = convo?.site ?? dev.siteHint ?? null;

  return (
    <div style={page('22px 32px 48px')}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: 'var(--ink-600)',
          marginBottom: 14,
        }}
      >
        <span onClick={onBack} className="hue-link" role="button" tabIndex={0} style={{ cursor: 'pointer', color: 'var(--blue-500)', fontWeight: 500 }}>
          Interventions
        </span>
        <span>/</span>
        <span>{dev.id}</span>
      </div>

      {/* header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 320 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1
              style={{
                fontSize: 23,
                lineHeight: '29px',
                fontWeight: 700,
                margin: 0,
                letterSpacing: '-.01em',
              }}
            >
              {criterionTitle}
            </h1>
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '.05em',
                color: sevT.fg,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 999, background: sevT.fg }} />
              {dev.severity}
            </span>
            <span
              style={{
                fontSize: 12,
                fontWeight: 500,
                padding: '3px 10px',
                borderRadius: 4,
                border: '1px solid var(--border-default)',
                background: '#fff',
                color: status.fg,
              }}
            >
              {status.label}
            </span>
          </div>
          <p
            style={{
              margin: '7px 0 0',
              color: 'var(--ink-700)',
              fontSize: 15,
              lineHeight: '22px',
              maxWidth: '78ch',
              textWrap: 'pretty',
            }}
          >
            {dev.summary}
          </p>
          <div style={{ marginTop: 9, fontSize: 13, color: 'var(--ink-500)' }}>
            {[
              convo?.callId ? `Call ${convo.callId}` : dev.conversationId,
              dev.startedAt ? clock(dev.startedAt) : null,
              caller,
              site,
              convo ? duration(convo.durationSec) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="hue-btn"
            onClick={() => onOpenCall(dev.conversationId)}
            style={{
              height: 36,
              padding: '0 14px',
              borderRadius: 4,
              border: '1px solid var(--blue-500)',
              background: 'var(--blue-500)',
              color: '#fff',
              fontWeight: 500,
              fontSize: 13,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: 7,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5.5v13l11-6.5z" />
            </svg>
            Listen to the call
          </button>
        </div>
      </div>

      {/* call context strip */}
      <div
        style={{
          background: '#fff',
          border: '1px solid var(--border-default)',
          borderRadius: 8,
          marginTop: 16,
          padding: '6px 18px',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        {[
          { label: 'Call', value: convo?.callId ?? dev.conversationId, color: 'var(--ink-900)' },
          { label: 'Caller', value: caller, color: 'var(--ink-900)' },
          { label: 'Site', value: site ?? '—', color: site ? 'var(--ink-900)' : 'var(--ink-400)' },
          {
            label: 'Sentiment',
            value: convo?.sentiment ? label(convo.sentiment) : '—',
            color: convo?.sentiment ? sentimentTone(convo.sentiment).fg : 'var(--ink-400)',
          },
          {
            label: 'CMMS record',
            value: dev.checkedSrId ? `SR ${dev.checkedSrId}` : 'None found',
            color: dev.checkedSrId ? 'var(--ink-900)' : 'var(--danger-500)',
          },
          {
            // Nothing writes a quality score yet — an em dash rather than a 0
            // that would read as a real, terrible score.
            label: 'Quality score',
            value: convo?.qualityScore ? String(convo.qualityScore) : '—',
            color: convo?.qualityScore ? 'var(--ink-900)' : 'var(--ink-400)',
          },
          {
            label: 'Detected',
            value: `${dev.detectedBy}${dev.startedAt ? `, ${clock(dev.startedAt)}` : ''}`,
            color: 'var(--ink-900)',
          },
        ].map((c) => (
          <div
            key={c.label}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              padding: '8px 22px 8px 0',
              marginRight: 22,
              borderRight: '1px solid var(--ink-100)',
            }}
          >
            <span style={microLabel}>{c.label}</span>
            <span style={{ fontSize: 13, fontWeight: 500, color: c.color }}>{c.value}</span>
          </div>
        ))}
        <span
          onClick={() => onOpenCall(dev.conversationId)}
          className="hue-link"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (() => onOpenCall(dev.conversationId))();
          }}
          style={{
            marginLeft: 'auto',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--blue-500)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            padding: '8px 0',
          }}
        >
          Open full call record →
        </span>
      </div>

      <ZoneHeading title="What happened" />

      {/* at a glance */}
      <div
        style={{
          background: '#fff',
          border: '1px solid var(--border-default)',
          borderRadius: 8,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))',
          overflow: 'hidden',
        }}
      >
        <GlanceCell
          label="Rule broken"
          accent="var(--blue-500)"
          value={`Clause ${dev.clauseRef || '—'}`}
          fg="var(--blue-600)"
          detail={criterionTitle}
        />
        <GlanceCell
          label="Why it happened"
          accent={rcT.fg}
          value={dev.rootCause && dev.rootCause !== 'unknown' ? label(dev.rootCause) : 'Not classified'}
          fg="var(--ink-900)"
          // The classifier is a judge; until it has run on this finding there is
          // no root cause to state, and guessing one would be fabrication.
          detail={
            dev.rootCause && dev.rootCause !== 'unknown'
              ? `${dev.rootCause} · classified by the root-cause judge`
              : 'Run "Classify & draft fix" to have the judge determine this.'
          }
        />
        <GlanceCell
          label="Seen before"
          accent={seenBefore > 5 ? 'var(--warning-500)' : 'var(--ink-300)'}
          value={`${seenBefore} ${seenBefore === 1 ? 'time' : 'times'}`}
          fg="var(--ink-900)"
          detail={
            seenBefore > 1
              ? `${dev.criterionId} has failed on ${seenBefore} calls held here.`
              : 'The only time this criterion has failed so far.'
          }
          onLink={seenBefore > 1 ? onViewPattern : undefined}
        />
      </div>

      {/* the rule + the evidence */}
      <div
        style={{
          background: '#fff',
          border: '1px solid var(--border-default)',
          borderRadius: 8,
          overflow: 'hidden',
          marginTop: 12,
          display: 'grid',
          gridTemplateColumns: 'minmax(300px,0.9fr) minmax(0,1.1fr)',
        }}
      >
        <div style={{ padding: '16px 20px', borderRight: '1px solid var(--ink-100)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>The rule this broke</h3>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 999,
                background: 'var(--blue-025)',
                color: 'var(--blue-600)',
              }}
            >
              {dev.clauseRef || '—'}
            </span>
          </div>
          <blockquote
            style={{
              margin: '12px 0 0',
              padding: '12px 16px',
              borderLeft: '3px solid var(--blue-500)',
              background: 'var(--blue-025)',
              borderRadius: '0 6px 6px 0',
              fontSize: 13,
              lineHeight: '21px',
              color: clauseText ? 'var(--ink-900)' : 'var(--ink-500)',
              textWrap: 'pretty',
            }}
          >
            {clauseText ?? 'No clause text is held for this criterion.'}
          </blockquote>
          <div style={{ marginTop: 14 }}>
            <div style={microLabel}>Criterion failed</div>
            <div
              style={{
                fontSize: 13,
                lineHeight: '20px',
                marginTop: 4,
                color: 'var(--ink-900)',
                fontWeight: 500,
              }}
            >
              {criterionTitle}
            </div>
            <div
              style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 3, lineHeight: '18px' }}
            >
              {dev.criterionId} · {meta?.layer ?? 'unknown'} · detected by {dev.detectedBy}
            </div>
          </div>
        </div>

        <div style={{ padding: '16px 20px' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 14px' }}>On the call</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {dev.evidence.map((e, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'flex-start',
                  borderLeft: `2px solid ${e.isViolation ? 'var(--danger-500)' : 'var(--ink-200)'}`,
                  padding: '1px 0 1px 14px',
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--ink-500)',
                    fontVariantNumeric: 'tabular-nums',
                    flex: '0 0 36px',
                    paddingTop: 2,
                  }}
                >
                  {e.at || '—'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        fontSize: 11,
                        letterSpacing: '.03em',
                        textTransform: 'uppercase',
                        color: 'var(--ink-500)',
                        fontWeight: 500,
                      }}
                    >
                      {e.who}
                    </span>
                    {e.isViolation && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: '.05em',
                          textTransform: 'uppercase',
                          color: 'var(--danger-500)',
                          background: 'var(--danger-050)',
                          borderRadius: 999,
                          padding: '1px 7px',
                        }}
                      >
                        Breach
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 13,
                      lineHeight: '20px',
                      color: e.isViolation ? 'var(--danger-700)' : 'var(--ink-900)',
                      marginTop: 2,
                      textWrap: 'pretty',
                    }}
                  >
                    {e.quote}
                  </div>
                </div>
              </div>
            ))}
            {dev.evidence.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--ink-600)' }}>
                No turn-level evidence was recorded for this finding.
              </div>
            )}
          </div>
        </div>
      </div>

      <ZoneHeading
        title="Close it out"
        hint="Two independent actions — approve the fix, repair the record"
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <FixTheAgent
          dev={dev}
          corr={corr}
          status={status}
          act={act}
          sowNote={sowNote}
          currentClause={currentClause}
          onAnalyse={analyse}
          onApprove={approveSowFix}
          onVerify={() => run('verifyCorrection', { correctionId: corr?.id ?? `CO-${dev.id}` }, 'verify')}
        />

        <FixTheRecord
          dev={dev}
          corr={corr}
          rec={rec}
          plan={cmmsPlan}
          busy={act.busy}
          onWrite={() =>
            run('approveCorrection', { correctionId: corr?.id ?? `CO-${dev.id}` }, 'approve')
          }
        />
      </div>
    </div>
  );
}

const microLabel: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: 'var(--ink-500)',
  fontWeight: 500,
};

/** The design's zone divider: a small caps label and a hairline. */
function ZoneHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '26px 0 10px' }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: 'var(--ink-500)',
        }}
      >
        {title}
      </span>
      <span style={{ flex: 1, height: 1, background: 'var(--border-default)' }} />
      {hint && <span style={{ fontSize: 12, color: 'var(--ink-500)' }}>{hint}</span>}
    </div>
  );
}

function GlanceCell({
  label: cellLabel,
  accent,
  value,
  fg,
  detail,
  onLink,
}: {
  label: string;
  accent: string;
  value: string;
  fg: string;
  detail: string;
  onLink?: () => void;
}) {
  return (
    <div style={{ padding: '14px 18px', borderRight: '1px solid var(--ink-100)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, ...microLabel }}>
        <span
          style={{ width: 6, height: 6, borderRadius: 999, background: accent, flex: '0 0 6px' }}
        />
        {cellLabel}
      </div>
      <div
        style={{
          fontWeight: 600,
          fontSize: 15,
          marginTop: 6,
          lineHeight: '21px',
          color: fg,
          textWrap: 'pretty',
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 4, lineHeight: '18px' }}>
        {detail}
      </div>
      {onLink && (
        <span
          onClick={onLink}
          className="hue-link"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (onLink)();
          }}
          style={{
            display: 'inline-block',
            marginTop: 7,
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--blue-500)',
            cursor: 'pointer',
          }}
        >
          View pattern →
        </span>
      )}
    </div>
  );
}

/** The correction lifecycle in the design's vocabulary. */
function correctionStatus(state?: string | null): { label: string; fg: string } {
  switch (state) {
    case 'proposed':
      return { label: 'Proposed', fg: 'var(--warning-700)' };
    case 'approved':
    case 'applied':
      return { label: 'Applied', fg: 'var(--blue-600)' };
    case 'verifying':
      return { label: 'Verifying', fg: 'var(--blue-600)' };
    case 'resolved':
      return { label: 'Resolved', fg: 'var(--success-700)' };
    case 'rejected':
      return { label: 'Rejected', fg: 'var(--danger-500)' };
    default:
      return { label: 'Needs review', fg: 'var(--warning-700)' };
  }
}

const STEP_ORDER = ['applied', 'verifying', 'resolved'];

function stepStyle(s: 'done' | 'active' | 'todo') {
  if (s === 'done')
    return { mark: '✓', dotBg: 'var(--success-500)', dotFg: '#fff', fg: 'var(--ink-900)', bg: '#fff' };
  if (s === 'active')
    return { mark: '•', dotBg: 'var(--blue-500)', dotFg: '#fff', fg: 'var(--blue-600)', bg: 'var(--blue-025)' };
  return { mark: '', dotBg: 'var(--ink-200)', dotFg: 'var(--ink-500)', fg: 'var(--ink-500)', bg: '#fff' };
}

/**
 * Fix the agent — the propose → approve → apply → verify loop, with the
 * before/after diff and the state progression the design specifies.
 *
 * Before any judge has run there is no proposal to show, so the diff keeps its
 * two panes and says what is missing rather than rendering an invented draft.
 */
function FixTheAgent({
  dev,
  corr,
  status,
  act,
  onAnalyse,
  sowNote,
  currentClause,
  onApprove,
  onVerify,
}: {
  dev: DeviationWithEvidence;
  corr: CorrectionRecord | null;
  status: { label: string; fg: string };
  act: ActionState;
  onAnalyse: () => void;
  /** What the last scope-of-work write reported. */
  sowNote: string | null;
  /** The clause as it stands today — the left side of the diff. */
  currentClause: CurrentClause | null;
  onApprove: () => void;
  onVerify: () => void;
}) {
  const state = corr?.state ?? null;
  const isRunning = state !== null && STEP_ORDER.indexOf(state) >= 0;
  const isResolved = state === 'resolved';
  const showActions = state === 'proposed' || state === null;

  const cur = STEP_ORDER.indexOf(state ?? '');
  const steps = [
    {
      title: 'Applied',
      detail: corr?.title ? `${corr.title} — ${corr.target ?? 'agent'}` : 'The correction is written to its target',
      at: corr?.appliedAt ? 'done' : '',
    },
    { title: 'Verifying', detail: 'Re-reading the CMMS record the correction touched', at: state === 'applied' ? 'queued' : '' },
    { title: 'Resolved', detail: 'The record now satisfies the criterion', at: isResolved ? 'complete' : '' },
  ].map((s, i) => ({ ...s, ...stepStyle(cur > i ? 'done' : cur === i ? 'active' : 'todo') }));

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--blue-100)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '13px 20px',
          borderBottom: '1px solid var(--border-default)',
          background: 'var(--blue-025)',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
        }}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--brand-indigo-600)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v2m0 14v2M5.6 5.6l1.4 1.4m10 10 1.4 1.4M3 12h2m14 0h2M5.6 18.4 7 17m10-10 1.4-1.4" />
          <circle cx="12" cy="12" r="3.2" />
        </svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Fix the agent</h3>
          <div style={{ fontSize: 11, color: 'var(--ink-600)', marginTop: 1 }}>
            Stops this happening again
          </div>
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 999,
            background: 'var(--brand-indigo-050)',
            color: 'var(--brand-indigo)',
          }}
        >
          AI-drafted
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: status.fg }}>{status.label}</span>
      </div>

      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <div style={{ fontWeight: 500, color: corr ? 'var(--ink-900)' : 'var(--ink-500)' }}>
            {corr?.title || 'No correction drafted yet'}
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-600)', marginTop: 3, lineHeight: '19px' }}>
            {corr?.rationale ||
              'The root-cause judge and the proposer have not run on this finding. Nothing is drafted, and nothing is claimed about where the fix belongs.'}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ border: '1px solid var(--border-default)', borderRadius: 6, overflow: 'hidden' }}>
            <div
              style={{
                padding: '7px 12px',
                background: 'var(--ink-050)',
                borderBottom: '1px solid var(--border-default)',
                ...microLabel,
              }}
            >
              {/* Named for WHERE it came from. Only 'agent_prompt' is the
                  agent's live configuration; the rest are the scope of work
                  standing in for it, and saying so is the difference between a
                  stand-in and a claim. */}
              Current —{' '}
              {currentClause?.source === 'agent_prompt'
                ? `agent prompt ${currentClause.clauseRef}`
                : currentClause?.text
                  ? `scope of work ${currentClause.clauseRef}`
                  : 'not available'}
            </div>
            <div
              style={{
                padding: 12,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                lineHeight: '19px',
                color: currentClause?.text ? 'var(--ink-700)' : 'var(--ink-400)',
                background: 'rgba(182,25,25,0.04)',
                whiteSpace: 'pre-wrap',
                minHeight: 60,
              }}
            >
              {currentClause?.text ||
                currentClause?.reason ||
                "Current prompt not available — the agent's configuration is not exposed."}
            </div>
            {currentClause?.text ? (
              <div
                style={{
                  padding: '6px 12px',
                  borderTop: '1px solid var(--border-default)',
                  fontSize: 11,
                  color: 'var(--ink-500)',
                  background: '#fff',
                }}
              >
                {currentClause.source === 'agent_prompt'
                  ? "From the agent's live prompt."
                  : `From ${currentClause.reference}. The agent's live prompt is not readable, so this is what it is held to.`}
              </div>
            ) : null}
          </div>
          <div style={{ border: '1px solid var(--success-400)', borderRadius: 6, overflow: 'hidden' }}>
            <div
              style={{
                padding: '7px 12px',
                background: 'var(--success-050)',
                borderBottom: '1px solid var(--success-400)',
                ...microLabel,
                color: 'var(--success-700)',
              }}
            >
              Proposed
            </div>
            <div
              style={{
                padding: 12,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                lineHeight: '19px',
                color: corr?.afterText ? 'var(--ink-900)' : 'var(--ink-400)',
                background: 'rgba(41,160,30,0.05)',
                whiteSpace: 'pre-wrap',
                minHeight: 60,
              }}
            >
              {corr?.afterText || '—'}
            </div>
          </div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--ink-600)' }}>
          Applies to{' '}
          <b style={{ color: 'var(--ink-900)', fontWeight: 500 }}>
            {corr?.target || 'the helpdesk agent'}
          </b>{' '}
          · {dev.criterionId} on this call
        </div>

        {showActions && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              borderTop: '1px solid var(--ink-100)',
              paddingTop: 14,
              flexWrap: 'wrap',
            }}
          >
            <button className="hue-btn"
              onClick={corr ? onApprove : onAnalyse}
              disabled={Boolean(act.busy)}
                aria-busy={Boolean(act.busy)}
              style={{
                height: 36,
                padding: '0 16px',
                borderRadius: 4,
                border: '1px solid var(--blue-500)',
                background: 'var(--blue-500)',
                color: '#fff',
                fontWeight: 500,
                fontSize: 13,
                cursor: act.busy ? 'not-allowed' : 'pointer',
                opacity: act.busy ? 0.7 : 1,
              }}
            >
              {act.busy && <span className="hue-spinner" aria-hidden="true" />}
              {act.busy === 'classify'
                ? 'Classifying… (~15s)'
                : act.busy === 'propose'
                  ? 'Drafting fix… (~20s)'
                  : act.busy === 'sow'
                    ? 'Writing to the scope of work…'
                    : act.busy === 'evals'
                      ? 'Rewriting the evals…'
                      : corr
                        ? 'Approve fix'
                        : 'Classify & draft fix'}
            </button>
            {corr && (
              <button className="hue-btn"
                onClick={onAnalyse}
                disabled={Boolean(act.busy)}
                aria-busy={Boolean(act.busy)}
                style={secondaryBtn}
              >
                Redraft
              </button>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink-500)' }}>
              {sowNote
                ? sowNote
                : corr
                  ? 'Approving writes this into the scope of work and rewrites the evals. The CMMS is not touched from here.'
                  : 'Both judges run in your browser — the server validates before writing.'}
            </span>
          </div>
        )}

        {isRunning && (
          <div style={{ border: '1px solid var(--border-default)', borderRadius: 6, overflow: 'hidden' }}>
            {steps.map((s) => (
              <div
                key={s.title}
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'flex-start',
                  padding: '12px 14px',
                  borderBottom: '1px solid var(--ink-100)',
                  background: s.bg,
                }}
              >
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    background: s.dotBg,
                    color: s.dotFg,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    fontWeight: 700,
                    flex: '0 0 18px',
                    marginTop: 1,
                  }}
                >
                  {s.mark}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: 13, color: s.fg }}>{s.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 2 }}>{s.detail}</div>
                </div>
                <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>{s.at}</span>
              </div>
            ))}
          </div>
        )}

        {state === 'applied' && (
          <button className="hue-btn" onClick={onVerify} disabled={Boolean(act.busy)}
                aria-busy={Boolean(act.busy)} style={secondaryBtn}>
            {act.busy === 'verify' ? 'Verifying…' : 'Verify against the record'}
          </button>
        )}

        {isResolved && (
          <div
            style={{
              border: '1px solid var(--success-400)',
              background: 'var(--success-050)',
              borderRadius: 6,
              padding: 14,
              display: 'flex',
              gap: 12,
              alignItems: 'flex-start',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--success-700)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: 1 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--success-700)' }}>
                Verified{corr?.appliedRecordId ? ` — SR ${corr.appliedRecordId}` : ''}
              </div>
              <div style={{ fontSize: 13, color: 'var(--ink-700)', marginTop: 3 }}>
                The correction was applied and the CMMS record was re-read to confirm it.
              </div>
            </div>
          </div>
        )}

        {act.timeout && (
          <div
            style={{
              background: 'var(--warning-050)',
              border: '1px solid var(--warning-500)',
              borderRadius: 6,
              padding: '12px 14px',
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--warning-700)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              <span style={{ fontWeight: 600, color: 'var(--warning-700)' }}>
                Couldn't complete — the judge timed out
              </span>
            </div>
            <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--warning-700)', lineHeight: '19px', textWrap: 'pretty' }}>
              <strong>This is not a verdict</strong> — nothing has been decided about this finding,
              and nothing was written. Retry, or leave it and come back.
            </p>
          </div>
        )}

        {act.error && (
          <div
            style={{
              background: 'var(--danger-050)',
              border: '1px solid var(--danger-500)',
              borderRadius: 6,
              padding: '12px 14px',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger-700)' }}>
              That step failed
            </div>
            <p style={{ margin: '6px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--danger-700)', wordBreak: 'break-word' }}>
              {act.error}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const secondaryBtn: React.CSSProperties = {
  height: 36,
  padding: '0 14px',
  borderRadius: 4,
  border: '1px solid var(--border-default)',
  background: '#fff',
  fontWeight: 500,
  fontSize: 13,
  cursor: 'pointer',
};

/**
 * Fix the record — the CMMS write the proposer drafted, previewed before it runs.
 *
 * The design shows this only when the finding has a CMMS action. Here the card
 * is always present so the second half of "close it out" does not vanish, and
 * it states plainly when there is nothing to write yet.
 */
function FixTheRecord({
  dev,
  corr,
  rec,
  plan,
  busy,
  onWrite,
}: {
  dev: DeviationWithEvidence;
  corr: CorrectionRecord | null;
  rec: any;
  /** Decided by the server from the JOIN, not by the proposer. */
  plan: { verb: string; recordId: string | null; reason: string } | null;
  busy: string | null;
  onWrite: () => void;
}) {
  const action = corr?.cmmsAction ?? null;
  // The JOIN decides create vs update. The proposer's own verb is only a
  // fallback for a draft the server has not weighed in on yet — and it can be
  // wrong in the one direction that matters, proposing a create for a call that
  // already has a record.
  const verb = plan ? plan.verb : String(action?.verb ?? 'none');
  const fields: Array<{ label: string; value: string }> = Array.isArray(action?.fields)
    ? action.fields
    : [];
  const hasAction = verb === 'create' || verb === 'update';
  const applied = corr?.state === 'applied' || corr?.state === 'verifying' || corr?.state === 'resolved';

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--warning-500)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '13px 20px',
          background: 'var(--warning-050)',
          borderBottom: '1px solid var(--warning-500)',
          display: 'flex',
          alignItems: 'center',
          gap: 9,
        }}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--warning-700)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
        </svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--warning-700)' }}>
            Fix the record
          </h3>
          <div style={{ fontSize: 11, color: 'var(--ink-600)', marginTop: 1 }}>
            Repairs this call in your CMMS
          </div>
        </div>
      </div>

      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 13 }}>
        <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--ink-700)', textWrap: 'pretty' }}>
          {hasAction
            ? corr?.rationale || 'The proposer drafted a write against the live CMMS.'
            : dev.checkedSrId
              ? `This call resolved to SR ${dev.checkedSrId}. Draft a correction to see what would be written to it.`
              : 'The join found no service request for this call. Correcting the agent does not raise the missing request — draft a correction to see the write that would.'}
        </p>

        <div style={{ border: '1px solid var(--border-default)', borderRadius: 6, overflow: 'hidden' }}>
          <div
            style={{
              padding: '8px 12px',
              background: 'var(--ink-050)',
              borderBottom: '1px solid var(--border-default)',
              display: 'flex',
              alignItems: 'center',
              gap: 7,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--blue-600)',
                background: 'var(--blue-025)',
                border: '1px solid var(--blue-100)',
                borderRadius: 4,
                padding: '1px 6px',
              }}
            >
              {verb === 'create'
                ? 'create-service-request'
                : verb === 'update'
                  ? 'update-service-request'
                  : 'no action'}
            </span>
            <span style={microLabel}>
              {verb === 'create' ? 'New record to write' : verb === 'update' ? 'Changes to apply' : 'Nothing drafted'}
            </span>
          </div>
          <div style={{ padding: '4px 12px' }}>
            {fields.length > 0 ? (
              fields.map((f, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 14,
                    padding: '7px 0',
                    borderBottom: '1px solid var(--ink-050)',
                    alignItems: 'baseline',
                  }}
                >
                  <span style={{ fontSize: 12, color: 'var(--ink-500)', flex: '0 0 auto' }}>
                    {f.label}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--warning-700)', textAlign: 'right' }}>
                    {f.value}
                  </span>
                </div>
              ))
            ) : (
              <div style={{ padding: '10px 0', fontSize: 12, color: 'var(--ink-400)' }}>
                — no fields drafted yet
              </div>
            )}
          </div>
        </div>

        {/* ONE button, and the verb on it is the verb the server will run —
            both read the same join-derived plan, so it cannot offer to create a
            record while the server updates one. Safe to press twice: approve
            claims an idempotency key before touching the CMMS. */}
        {hasAction ? (
          <button
            className="hue-btn"
            onClick={onWrite}
            disabled={Boolean(busy) || applied}
            aria-busy={busy === 'approve'}
            title={plan?.reason}
            style={{
              height: 38,
              borderRadius: 4,
              border: `1px solid ${applied ? 'var(--border-default)' : 'var(--warning-500)'}`,
              background: applied ? 'var(--ink-050)' : 'var(--warning-500)',
              color: applied ? 'var(--ink-500)' : '#fff',
              fontWeight: 600,
              fontSize: 13,
              cursor: busy || applied ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {busy === 'approve' ? <span className="hue-spinner" aria-hidden="true" /> : null}
            {applied
              ? verb === 'create'
                ? `Service request created${corr?.appliedRecordId ? ` — SR ${corr.appliedRecordId}` : ''}`
                : `Service request updated${plan?.recordId ? ` — SR ${plan.recordId}` : ''}`
              : busy === 'approve'
                ? 'Writing to the CMMS…'
                : verb === 'create'
                  ? 'Create service request'
                  : `Update service request${plan?.recordId ? ` ${plan.recordId}` : ''}`}
          </button>
        ) : null}

        <span style={{ fontSize: 11, color: 'var(--ink-500)', textAlign: 'center' }}>
          {hasAction
            ? plan?.reason ?? `Writes to the live CMMS. Logged against ${dev.id}.`
            : `Nothing will be written to the CMMS for ${dev.id} until a correction is drafted.`}
        </span>

        {rec && (
          <div style={{ fontSize: 12, color: 'var(--ink-600)', borderTop: '1px solid var(--ink-100)', paddingTop: 11 }}>
            Current record: <b style={{ color: 'var(--ink-900)', fontWeight: 500 }}>SR {rec.id}</b> ·{' '}
            {String(rec.moduleState ?? '—')} · {String(rec.urgency ?? '—')}
          </div>
        )}
      </div>
    </div>
  );
}
