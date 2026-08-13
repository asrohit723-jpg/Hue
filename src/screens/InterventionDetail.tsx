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

type ActionState = { busy: string | null; error: string | null; result: string | null };

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
  const [act, setAct] = useState<ActionState>({ busy: null, error: null, result: null });

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
    setAct({ busy: verb, error: null, result: null });
    try {
      const res = await callFn<Record<string, unknown>>(handler, args);
      setAct({ busy: null, error: null, result: JSON.stringify(res, null, 2) });
      setNonce((n) => n + 1);
    } catch (err) {
      setAct({ busy: null, error: err instanceof Error ? err.message : String(err), result: null });
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
                <Button onClick={() => run('classifyRootCause', { deviationId: dev.id }, 'classify')} disabled={Boolean(act.busy)}>
                  {act.busy === 'classify' ? 'Classifying…' : 'Classify root cause'}
                </Button>
                <Button onClick={() => run('proposeCorrection', { deviationId: dev.id }, 'propose')} disabled={Boolean(act.busy)}>
                  {act.busy === 'propose' ? 'Drafting…' : 'Propose correction'}
                </Button>
                <Button primary onClick={() => run('approveCorrection', { correctionId: `CO-${dev.id}` }, 'approve')} disabled={Boolean(act.busy)}>
                  {act.busy === 'approve' ? 'Applying…' : 'Approve & apply'}
                </Button>
                <Button onClick={() => run('verifyCorrection', { correctionId: `CO-${dev.id}` }, 'verify')} disabled={Boolean(act.busy)}>
                  {act.busy === 'verify' ? 'Verifying…' : 'Verify'}
                </Button>
              </div>

              {act.error && (
                <div style={{ marginTop: 14, background: 'var(--danger-050)', border: '1px solid var(--danger-500)', borderRadius: 6, padding: '10px 12px' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--danger-700)' }}>That step failed</div>
                  <p style={{ margin: '4px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--danger-700)', wordBreak: 'break-word' }}>
                    {act.error}
                  </p>
                </div>
              )}

              {act.result && (
                <pre
                  style={{
                    marginTop: 14, background: 'var(--ink-050)', borderRadius: 6, padding: 12,
                    fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: '17px',
                    overflowX: 'auto', maxHeight: 320,
                  }}
                >
                  {act.result}
                </pre>
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
