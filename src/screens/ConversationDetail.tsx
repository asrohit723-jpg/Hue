import { useEffect, useState } from 'react';
import type { Conversation } from '@shared/contract';
import { api, type DeviationWithEvidence } from '../lib/vibe';
import { BootSkeleton } from './BootSkeleton';
import { BackLink, LoadError, Panel, Pill } from '../components/Chrome';
import { clock, duration, label, sentimentTone, severityTone } from '../lib/tone';

interface Loaded {
  conversation: Conversation;
  deviations: DeviationWithEvidence[];
  cmmsRecord: Record<string, unknown> | null;
}

export function ConversationDetail({
  id,
  onBack,
  onOpenDeviation,
}: {
  id: string;
  onBack: () => void;
  onOpenDeviation: (deviationId: string) => void;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setData(null);
      setError(null);
      try {
        const res = await api.getConversation(id);
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [id, nonce]);

  if (error) return <div style={{ padding: '24px 28px', maxWidth: 1240 }}><LoadError message={error} onRetry={() => setNonce((n) => n + 1)} /></div>;
  if (!data) return <BootSkeleton label="Loading call…" />;

  const { conversation: c, deviations, cmmsRecord } = data;
  const sent = sentimentTone(c.sentiment);
  const rec = cmmsRecord as any;

  return (
    <div style={{ padding: '24px 28px 40px', maxWidth: 1240 }}>
      <BackLink onClick={onBack}>Call logs</BackLink>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 24, lineHeight: '30px', fontWeight: 700, margin: 0, letterSpacing: '-.01em' }}>
            {c.caller.name || 'Unknown caller'}
          </h1>
          <p style={{ margin: '5px 0 0', color: 'var(--ink-600)' }}>
            {c.site} · {clock(c.startedAt)} · {duration(c.durationSec)} · call {c.callId}
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <Pill bg={sent.bg} fg={sent.fg}>{label(c.sentiment ?? 'unknown')}</Pill>
          <Pill bg="var(--ink-050)" fg="var(--ink-600)">{label(c.status)}</Pill>
        </div>
      </div>

      {/* Claim vs truth, side by side — the heart of the product. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)', gap: 16, marginTop: 20, alignItems: 'start' }}>
        <Panel>
          <div style={{ padding: '13px 18px', borderBottom: '1px solid var(--border-default)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontWeight: 600 }}>Transcript</span>
            <span style={{ fontSize: 12, color: 'var(--ink-500)' }}>what the agent said it did</span>
          </div>
          <div style={{ padding: 4 }}>
            {c.transcript.map((t, i) => {
              const isTool = Boolean(t.toolCall);
              const failed = t.toolCall && t.toolCall.status !== 'success';
              if (isTool) {
                return (
                  <div
                    key={i}
                    style={{
                      margin: '8px 14px',
                      padding: '10px 12px',
                      borderRadius: 6,
                      background: failed ? 'var(--danger-050)' : 'var(--ink-050)',
                      border: `1px solid ${failed ? 'var(--danger-500)' : 'var(--border-default)'}`,
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      color: failed ? 'var(--danger-700)' : 'var(--ink-700)',
                    }}
                  >
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <span style={{ fontWeight: 500 }}>{t.toolCall!.name}</span>
                      <span>→ {t.toolCall!.status}</span>
                      {t.at && <span style={{ marginLeft: 'auto', color: 'var(--ink-500)' }}>{t.at}</span>}
                    </div>
                    {t.toolCall!.error && <div style={{ marginTop: 4 }}>{t.toolCall!.error}</div>}
                    {t.toolCall!.resultRecordId && <div style={{ marginTop: 4 }}>record {t.toolCall!.resultRecordId}</div>}
                  </div>
                );
              }
              const isAgent = t.performer === 'agent';
              return (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 14px' }}>
                  <span style={{ width: 54, flex: '0 0 54px', fontSize: 11, color: 'var(--ink-500)', fontVariantNumeric: 'tabular-nums', paddingTop: 3 }}>
                    {t.at ?? ''}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em', color: isAgent ? 'var(--brand-indigo)' : 'var(--ink-600)' }}>
                      {t.performer}
                    </div>
                    <div style={{ marginTop: 2, lineHeight: '20px', textWrap: 'pretty' }}>{t.message}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Panel style={rec ? undefined : { border: '1px solid var(--danger-500)' }}>
            <div style={{ padding: '13px 18px', borderBottom: '1px solid var(--border-default)', background: rec ? '#fff' : 'var(--danger-050)' }}>
              <span style={{ fontWeight: 600, color: rec ? 'var(--ink-900)' : 'var(--danger-700)' }}>CMMS record</span>
              <div style={{ fontSize: 12, color: rec ? 'var(--ink-500)' : 'var(--danger-700)', marginTop: 2 }}>
                {rec ? 'ground truth, read live' : 'no record exists for this call'}
              </div>
            </div>
            <div style={{ padding: 16 }}>
              {rec ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <Field k="Record" v={`SR ${rec.id}`} mono />
                  <Field k="Subject" v={String(rec.subject ?? '—')} />
                  <Field k="Site" v={String(rec.site?.name ?? '—')} />
                  <Field k="Urgency" v={String(rec.urgency ?? '—')} />
                  <Field k="Status" v={String(rec.moduleState ?? '—')} />
                  <Field k="Created" v={String(rec.sysCreatedTime ?? '—')} />
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-700)', lineHeight: '20px', textWrap: 'pretty' }}>
                  The join found no service request for this call.
                  {c.srCreated
                    ? ' The agent told the caller one had been raised — that claim is contradicted by the CMMS.'
                    : ' The agent did not claim one was raised.'}
                </p>
              )}
            </div>
          </Panel>

          <Panel>
            <div style={{ padding: '13px 18px', borderBottom: '1px solid var(--border-default)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600 }}>Findings</span>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink-500)' }}>{deviations.length}</span>
            </div>
            {deviations.length === 0 ? (
              <div style={{ padding: '20px 18px', fontSize: 13, color: 'var(--ink-600)' }}>
                No deviations on this call.
              </div>
            ) : (
              deviations.map((d) => {
                const sev = severityTone(d.severity);
                return (
                  <div
                    key={d.id}
                    onClick={() => onOpenDeviation(d.id)}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') onOpenDeviation(d.id); }}
                    style={{ padding: '12px 18px', borderBottom: '1px solid var(--ink-100)', cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Pill bg={sev.bg} fg={sev.fg}>{label(d.severity)}</Pill>
                      <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>{d.criterionId}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-500)' }}>{d.detectedBy}</span>
                    </div>
                    <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: '19px', textWrap: 'pretty' }}>{d.summary}</p>
                  </div>
                );
              })
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Field({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
      <span style={{ width: 96, flex: '0 0 96px', fontSize: 12, color: 'var(--ink-500)' }}>{k}</span>
      <span style={{ fontSize: 13, fontVariantNumeric: mono ? 'tabular-nums' : undefined, minWidth: 0, wordBreak: 'break-word' }}>{v}</span>
    </div>
  );
}
