import { useEffect, useState } from 'react';
import { api, type DeviationWithEvidence } from '../lib/vibe';
import { BootSkeleton } from './BootSkeleton';
import { Empty, LoadError, PageHead, Panel, Pill } from '../components/Chrome';
import { label, severityTone } from '../lib/tone';

/**
 * Notifications shows what WOULD be sent for each flagged finding.
 *
 * Outbound Teams delivery is not wired yet, and this screen says so rather than
 * rendering a "Sent" state that never happened. Every row here is a real
 * finding; only the delivery leg is missing.
 */
export function Notifications({ onOpen }: { onOpen: (deviationId: string) => void }) {
  const [items, setItems] = useState<DeviationWithEvidence[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setItems(null); setError(null);
      try {
        const rows = await api.listDeviations('');
        if (!cancelled) setItems(rows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [nonce]);

  if (error) return <div style={{ padding: '24px 28px', maxWidth: 1100 }}><LoadError message={error} onRetry={() => setNonce((n) => n + 1)} /></div>;
  if (!items) return <BootSkeleton label="Loading notifications…" />;

  // Only critical and high findings would page anyone; the rest sit in the queue.
  const paging = items.filter((d) => d.severity === 'critical' || d.severity === 'high');
  const rest = items.filter((d) => d.severity !== 'critical' && d.severity !== 'high');

  return (
    <div style={{ padding: '24px 28px 40px', maxWidth: 1100 }}>
      <PageHead
        title="Notifications"
        sub={`${paging.length} of ${items.length} findings meet the bar to notify someone.`}
      />

      <Panel style={{ marginTop: 16, borderColor: 'var(--warning-500)' }}>
        <div style={{ padding: '12px 16px', background: 'var(--warning-050)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--warning-700)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 16px', marginTop: 2 }}>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5" />
            <path d="M12 16h.01" />
          </svg>
          <span style={{ fontSize: 13, color: 'var(--warning-700)', lineHeight: '19px' }}>
            Outbound delivery is not wired yet. These are the messages Hue would send on a flagged
            deviation — the findings are real, the send leg is not built.
          </span>
        </div>
      </Panel>

      <Section title="Would page now" list={paging} onOpen={onOpen} />
      <Section title="Queued — below the paging bar" list={rest} onOpen={onOpen} />
    </div>
  );
}

function Section({
  title,
  list,
  onOpen,
}: {
  title: string;
  list: DeviationWithEvidence[];
  onOpen: (id: string) => void;
}) {
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--ink-500)', fontWeight: 500, marginBottom: 8 }}>
        {title}
      </div>
      <Panel>
        {list.map((d) => {
          const s = severityTone(d.severity);
          return (
            <div key={d.id} onClick={() => onOpen(d.id)} tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpen(d.id); }}
              style={{ padding: '14px 18px', borderBottom: '1px solid var(--ink-100)', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Pill bg={s.bg} fg={s.fg}>{label(d.severity)}</Pill>
                <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>{d.criterionId}</span>
                {d.siteHint && <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>{d.siteHint}</span>}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-500)' }}>
                  {d.checkedSrId ? `SR ${d.checkedSrId}` : 'no record'}
                </span>
              </div>
              <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: '19px', textWrap: 'pretty' }}>{d.summary}</p>
            </div>
          );
        })}
        {list.length === 0 && <Empty title="Nothing here" body="No findings in this band." />}
      </Panel>
    </div>
  );
}
