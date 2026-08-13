import { useEffect, useState } from 'react';
import type { Conversation } from '@shared/contract';
import { api, vibe, type DeviationWithEvidence } from '../lib/vibe';
import { BootSkeleton } from './BootSkeleton';
import { BackLink, Button, LoadError, Panel, Pill } from '../components/Chrome';
import { label, rootCauseTone, severityTone } from '../lib/tone';

/**
 * Correction actions are not in the typed `api` surface because they are the
 * write path and each is a single judge call that may exceed the sandbox's
 * fetch ceiling. Failures are surfaced verbatim rather than swallowed — a
 * timeout must never read as "nothing to fix".
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
  humanAction?: unknown;
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

/** The function tags an unfinished judge with this prefix. */
const JUDGE_TIMEOUT = 'JUDGE_TIMEOUT';

export function InterventionDetail({
  deviationId,
  onBack,
  onOpenCall,
}: {
  deviationId: string;
  onBack: () => void;
  onOpenCall: (conversationId: string) => void;
}) {
  const [dev, setDev] = useState<DeviationWithEvidence | null>(null);
  const [convo, setConvo] = useState<Conversation | null>(null);
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [act, setAct] = useState<ActionState>(IDLE);

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
        const call = await api.getConversation(found.conversationId);
        if (cancelled) return;
        setConvo(call.conversation);
        setRecord(call.cmmsRecord);
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

  if (error) return <div style={{ padding: '24px 28px', maxWidth: 1240 }}><LoadError message={error} onRetry={() => setNonce((n) => n + 1)} /></div>;
  if (!dev) return <BootSkeleton label="Loading finding…" />;

  const sev = severityTone(dev.severity);
  const rc = rootCauseTone(dev.rootCause || 'unknown');
  const rec = record as any;

  return (
    <div style={{ padding: '24px 28px 40px', maxWidth: 1100 }}>
      <BackLink onClick={onBack}>Interventions</BackLink>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Pill bg={sev.bg} fg={sev.fg}>{label(dev.severity)}</Pill>
        <Pill bg={rc.bg} fg={rc.fg}>{label(dev.rootCause || 'unknown')}</Pill>
        <span style={{ fontSize: 12, color: 'var(--ink-500)' }}>{dev.criterionId} · clause {dev.clauseRef}</span>
        <span style={{ fontSize: 12, color: 'var(--ink-500)' }}>detected by {dev.detectedBy}</span>
      </div>

      <h1 style={{ fontSize: 22, lineHeight: '30px', fontWeight: 700, margin: '12px 0 0', letterSpacing: '-.01em', textWrap: 'pretty' }}>
        {dev.summary}
      </h1>

      {convo && (
        <p style={{ margin: '8px 0 0', color: 'var(--ink-600)' }}>
          {convo.caller.name} · {convo.site} ·{' '}
          <button
            onClick={() => onOpenCall(convo.id)}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--blue-500)', fontWeight: 500, cursor: 'pointer', fontSize: 14 }}
          >
            open the call
          </button>
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)', gap: 16, marginTop: 20, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Panel>
            <div style={{ padding: '13px 18px', borderBottom: '1px solid var(--border-default)', fontWeight: 600 }}>
              Evidence
            </div>
            {dev.evidence.length === 0 ? (
              <div style={{ padding: '18px', fontSize: 13, color: 'var(--ink-600)' }}>
                No turn-level evidence was recorded for this finding.
              </div>
            ) : (
              dev.evidence.map((e, i) => (
                <div
                  key={i}
                  style={{
                    padding: '12px 18px',
                    borderBottom: '1px solid var(--ink-100)',
                    background: e.isViolation ? 'var(--danger-050)' : '#fff',
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11, color: 'var(--ink-600)' }}>
                    <span style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em' }}>{e.who}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{e.at}</span>
                    {e.isViolation && (
                      <span style={{ marginLeft: 'auto', color: 'var(--danger-500)', fontWeight: 600 }}>violation</span>
                    )}
                  </div>
                  <p style={{ margin: '5px 0 0', fontSize: 13, lineHeight: '19px', color: e.isViolation ? 'var(--danger-700)' : 'var(--ink-900)', textWrap: 'pretty' }}>
                    {e.quote}
                  </p>
                </div>
              ))
            )}
          </Panel>

          <Panel>
            <div style={{ padding: '13px 18px', borderBottom: '1px solid var(--border-default)', fontWeight: 600 }}>
              Correction
            </div>
            <div style={{ padding: 18 }}>
              <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--ink-700)', lineHeight: '20px', textWrap: 'pretty' }}>
                Classify where the fix belongs, draft it, then approve. Nothing is written to the CMMS
                until you approve, and the write key is claimed first so approving twice cannot
                create two records.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button
                  primary
                  onClick={() => run('runCorrection', { deviationId: dev.id }, 'analyse')}
                  disabled={Boolean(act.busy)}
                >
                  {act.busy === 'analyse'
                    ? 'Analysing…'
                    : act.timeout
                      ? 'Retry analysis'
                      : 'Classify & draft fix'}
                </Button>
                <Button
                  onClick={() => run('approveCorrection', { correctionId: `CO-${dev.id}` }, 'approve')}
                  disabled={Boolean(act.busy)}
                >
                  {act.busy === 'approve' ? 'Applying…' : 'Approve & apply'}
                </Button>
                <Button
                  onClick={() => run('verifyCorrection', { correctionId: `CO-${dev.id}` }, 'verify')}
                  disabled={Boolean(act.busy)}
                >
                  {act.busy === 'verify' ? 'Verifying…' : 'Verify'}
                </Button>
              </div>

              {/* Timeout: nothing was learned. Never rendered as a pass, and
                  never left blank — the only honest read is "unknown, retry". */}
              {act.timeout && (
                <div
                  style={{
                    marginTop: 14,
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
                    The model did not respond within the platform's request limit, after three
                    attempts. <strong>This is not a verdict</strong> — nothing has been decided about
                    this finding, and nothing was written. Retry, or leave it and come back.
                    {act.outcome?.rootCause && (
                      <> The root cause was classified as <strong>{act.outcome.rootCause}</strong> before the timeout, and that part is saved.</>
                    )}
                  </p>
                  <div style={{ marginTop: 10 }}>
                    <Button primary onClick={() => run('runCorrection', { deviationId: dev.id }, 'analyse')} disabled={Boolean(act.busy)}>
                      Retry
                    </Button>
                  </div>
                  <details style={{ marginTop: 10 }}>
                    <summary style={{ fontSize: 12, color: 'var(--warning-700)', cursor: 'pointer' }}>
                      Technical detail
                    </summary>
                    <p style={{ margin: '6px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--warning-700)', wordBreak: 'break-word' }}>
                      {act.timeout}
                    </p>
                  </details>
                </div>
              )}

              {/* A genuine failure — bad data or an unusable verdict. */}
              {act.error && (
                <div style={{ marginTop: 14, background: 'var(--danger-050)', border: '1px solid var(--danger-500)', borderRadius: 6, padding: '12px 14px' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger-700)' }}>That step failed</div>
                  <p style={{ margin: '6px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--danger-700)', wordBreak: 'break-word' }}>
                    {act.error}
                  </p>
                </div>
              )}

              {/* Success. */}
              {act.outcome && act.outcome.ok !== false && (
                <div style={{ marginTop: 14, background: 'var(--success-050)', border: '1px solid var(--success-400)', borderRadius: 6, padding: '12px 14px' }}>
                  <div style={{ fontWeight: 600, color: 'var(--success-700)' }}>
                    {act.outcome.stage === 'complete'
                      ? 'Correction drafted'
                      : act.outcome.state === 'applied'
                        ? act.outcome.alreadyApplied
                          ? 'Already applied — no second write'
                          : 'Applied to the CMMS'
                        : act.outcome.verified
                          ? 'Verified against the live record'
                          : 'Done'}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 13, color: 'var(--ink-900)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {act.outcome.rootCause && <span>Root cause: <strong>{act.outcome.rootCause}</strong></span>}
                    {act.outcome.target && <span>Fix belongs in: <strong>{act.outcome.target}</strong></span>}
                    {act.outcome.title && <span>{act.outcome.title}</span>}
                    {act.outcome.appliedRecordId && <span>Record: SR {act.outcome.appliedRecordId}</span>}
                  </div>
                  <details style={{ marginTop: 10 }}>
                    <summary style={{ fontSize: 12, color: 'var(--ink-600)', cursor: 'pointer' }}>Full response</summary>
                    <pre style={{ margin: '8px 0 0', background: 'var(--ink-050)', borderRadius: 6, padding: 12, fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: '17px', overflowX: 'auto', maxHeight: 280 }}>
                      {JSON.stringify(act.outcome, null, 2)}
                    </pre>
                  </details>
                </div>
              )}
            </div>
          </Panel>
        </div>

        <Panel style={rec ? undefined : { border: '1px solid var(--danger-500)' }}>
          <div style={{ padding: '13px 18px', borderBottom: '1px solid var(--border-default)', background: rec ? '#fff' : 'var(--danger-050)' }}>
            <span style={{ fontWeight: 600, color: rec ? 'var(--ink-900)' : 'var(--danger-700)' }}>
              CMMS record
            </span>
            <div style={{ fontSize: 12, color: rec ? 'var(--ink-500)' : 'var(--danger-700)', marginTop: 2 }}>
              {rec ? 'checked live against this record' : 'no record — this is the finding'}
            </div>
          </div>
          <div style={{ padding: 16, fontSize: 13 }}>
            {rec ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Row k="Record" v={`SR ${rec.id}`} />
                <Row k="Subject" v={String(rec.subject ?? '—')} />
                <Row k="Site" v={String(rec.site?.name ?? '—')} />
                <Row k="Urgency" v={String(rec.urgency ?? '—')} />
                <Row k="Status" v={String(rec.moduleState ?? '—')} />
              </div>
            ) : (
              <p style={{ margin: 0, color: 'var(--ink-700)', lineHeight: '20px', textWrap: 'pretty' }}>
                The join resolved no service request. Correcting the agent will not repair this on
                its own — the reported fault still needs raising.
              </p>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
      <span style={{ width: 84, flex: '0 0 84px', fontSize: 12, color: 'var(--ink-500)' }}>{k}</span>
      <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
    </div>
  );
}
