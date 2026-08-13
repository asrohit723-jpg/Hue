import { useEffect, useMemo, useState } from 'react';
import { api, type DeviationWithEvidence } from '../lib/vibe';
import { BootSkeleton } from './BootSkeleton';
import { Button, Empty, LoadError, PageHead, Panel, Pill } from '../components/Chrome';
import { label, rootCauseTone, severityTone } from '../lib/tone';

const SEVERITIES = ['All severities', 'critical', 'high', 'medium', 'low'];
const STATUSES = ['All statuses', 'open', 'correcting', 'resolved', 'routed_to_human'];

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function Interventions({ onOpen }: { onOpen: (deviationId: string) => void }) {
  const [items, setItems] = useState<DeviationWithEvidence[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [sev, setSev] = useState('All severities');
  const [status, setStatus] = useState('All statuses');
  const [q, setQ] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setItems(null);
      setError(null);
      try {
        const rows = await api.listDeviations('');
        if (!cancelled) setItems(rows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [nonce]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? [])
      .filter((d) => {
        if (sev !== 'All severities' && d.severity !== sev) return false;
        if (status !== 'All statuses' && d.status !== status) return false;
        if (!needle) return true;
        return [d.summary, d.criterionId, d.clauseRef, d.callerName, d.siteHint]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle));
      })
      .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  }, [items, sev, status, q]);

  if (error) return <div style={{ padding: '24px 28px', maxWidth: 1240 }}><LoadError message={error} onRetry={() => setNonce((n) => n + 1)} /></div>;
  if (!items) return <BootSkeleton label="Loading findings…" />;

  const open = items.filter((d) => d.status === 'open').length;

  return (
    <div style={{ padding: '24px 28px 40px', maxWidth: 1240 }}>
      <PageHead
        title="Interventions"
        sub={`${open} open ${open === 1 ? 'finding' : 'findings'} to act on. Ranked by what it costs the caller.`}
        right={
          <>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search findings"
              style={{ width: 220, height: 36, padding: '0 12px', border: '1px solid var(--border-default)', borderRadius: 6, fontSize: 13, outline: 'none' }}
            />
            <select value={sev} onChange={(e) => setSev(e.target.value)} style={selectStyle}>
              {SEVERITIES.map((s) => <option key={s} value={s}>{s === 'All severities' ? s : label(s)}</option>)}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle}>
              {STATUSES.map((s) => <option key={s} value={s}>{s === 'All statuses' ? s : label(s)}</option>)}
            </select>
          </>
        }
      />

      <Panel style={{ marginTop: 16 }}>
        {rows.map((d, i) => {
          const s = severityTone(d.severity);
          const rc = rootCauseTone(d.rootCause || 'unknown');
          return (
            <div
              key={d.id}
              onClick={() => onOpen(d.id)}
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpen(d.id); }}
              style={{ display: 'flex', gap: 14, padding: '16px 18px', borderBottom: '1px solid var(--ink-100)', cursor: 'pointer', alignItems: 'flex-start' }}
            >
              <span
                style={{
                  width: 26, height: 26, flex: '0 0 26px', borderRadius: 999,
                  background: s.bg, color: s.fg, display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: 12, fontWeight: 700, marginTop: 2,
                }}
              >
                {i + 1}
              </span>

              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Pill bg={s.bg} fg={s.fg}>{label(d.severity)}</Pill>
                  <Pill bg={rc.bg} fg={rc.fg}>{label(d.rootCause || 'unknown')}</Pill>
                  <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>{d.criterionId} · {d.clauseRef}</span>
                  {/* Provenance matters: a deterministic finding is a lookup, a
                      semantic one is a model judgement. Never conflate them. */}
                  <span
                    style={{
                      fontSize: 10, fontWeight: 600, letterSpacing: '.03em', textTransform: 'uppercase',
                      color: d.detectedBy === 'semantic' ? 'var(--brand-indigo)' : 'var(--ink-500)',
                      background: d.detectedBy === 'semantic' ? 'var(--brand-indigo-050)' : 'var(--ink-050)',
                      border: '1px solid var(--border-default)', borderRadius: 999, padding: '1px 7px',
                    }}
                  >
                    {d.detectedBy}
                  </span>
                </div>

                <p style={{ margin: '8px 0 0', lineHeight: '20px', textWrap: 'pretty' }}>{d.summary}</p>

                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ink-500)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {d.callerName && <span>{d.callerName}</span>}
                  {d.siteHint && <span>{d.siteHint}</span>}
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {d.checkedSrId ? `SR ${d.checkedSrId}` : 'no CMMS record'}
                  </span>
                  <span>{label(d.status)}</span>
                </div>
              </div>

              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: 6 }}>
                <path d="m9 18 6-6-6-6" />
              </svg>
            </div>
          );
        })}

        {rows.length === 0 && (
          <Empty
            title={items.length ? 'No findings match' : 'No deviations found'}
            body={items.length ? 'Nothing matches these filters.' : 'Every evaluated call satisfied its criteria.'}
            action={items.length ? <Button onClick={() => { setQ(''); setSev('All severities'); setStatus('All statuses'); }}>Clear filters</Button> : undefined}
          />
        )}
      </Panel>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  height: 36,
  border: '1px solid var(--border-default)',
  borderRadius: 6,
  padding: '0 10px',
  fontSize: 13,
  background: '#fff',
  color: 'var(--ink-900)',
  cursor: 'pointer',
  outline: 'none',
};
