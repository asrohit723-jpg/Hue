import { useEffect, useMemo, useState } from 'react';
import { api, type DeviationWithEvidence } from '../lib/vibe';
import { BootSkeleton } from './BootSkeleton';
import { Empty, LoadError, PageHead, Panel, Pill } from '../components/Chrome';
import { label, rootCauseTone, severityTone } from '../lib/tone';

interface Pattern {
  criterionId: string;
  clauseRef: string;
  count: number;
  worst: string;
  rootCause: string;
  detectedBy: string;
  sites: string[];
  example: string;
}

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Patterns are derived from the findings, not stored separately — a pattern is
 * just the same criterion failing on more than one call. Deriving it means the
 * count can never drift from the deviations it claims to summarise.
 */
export function Patterns({ onOpenCriterion }: { onOpenCriterion: () => void }) {
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

  const patterns = useMemo<Pattern[]>(() => {
    const by = new Map<string, DeviationWithEvidence[]>();
    for (const d of items ?? []) by.set(d.criterionId, [...(by.get(d.criterionId) ?? []), d]);
    return Array.from(by.entries())
      .map(([criterionId, list]) => {
        const worst = list.slice().sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9))[0];
        return {
          criterionId,
          clauseRef: worst.clauseRef,
          count: list.length,
          worst: worst.severity,
          rootCause: worst.rootCause || 'unknown',
          detectedBy: worst.detectedBy,
          sites: Array.from(new Set(list.map((d) => d.siteHint).filter(Boolean) as string[])),
          example: worst.summary,
        };
      })
      .sort((a, b) => b.count - a.count || (SEV_ORDER[a.worst] ?? 9) - (SEV_ORDER[b.worst] ?? 9));
  }, [items]);

  if (error) return <div style={{ padding: '24px 28px', maxWidth: 1100 }}><LoadError message={error} onRetry={() => setNonce((n) => n + 1)} /></div>;
  if (!items) return <BootSkeleton label="Loading patterns…" />;

  const recurring = patterns.filter((p) => p.count > 1);
  const max = Math.max(1, ...patterns.map((p) => p.count));

  return (
    <div style={{ padding: '24px 28px 40px', maxWidth: 1100 }}>
      <PageHead
        title="Patterns"
        sub={
          recurring.length
            ? `${recurring.length} ${recurring.length === 1 ? 'criterion is' : 'criteria are'} failing on more than one call.`
            : 'Each finding so far is a one-off. A pattern appears when the same criterion fails twice.'
        }
      />

      <Panel style={{ marginTop: 16 }}>
        {patterns.map((p) => {
          const s = severityTone(p.worst);
          const rc = rootCauseTone(p.rootCause);
          return (
            <div key={p.criterionId} onClick={onOpenCriterion} tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onOpenCriterion(); }}
              style={{ padding: '16px 18px', borderBottom: '1px solid var(--ink-100)', cursor: 'pointer' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600 }}>{p.criterionId}</span>
                <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>clause {p.clauseRef}</span>
                <Pill bg={s.bg} fg={s.fg}>{label(p.worst)}</Pill>
                <Pill bg={rc.bg} fg={rc.fg}>{label(p.rootCause)}</Pill>
                <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {p.count} {p.count === 1 ? 'call' : 'calls'}
                </span>
              </div>

              {/* Bar is proportional to the largest pattern, so relative scale is honest. */}
              <div style={{ marginTop: 10, height: 6, borderRadius: 999, background: 'var(--ink-100)', overflow: 'hidden' }}>
                <div style={{ width: `${(p.count / max) * 100}%`, height: '100%', background: s.fg }} />
              </div>

              <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--ink-700)', lineHeight: '19px', textWrap: 'pretty' }}>
                {p.example}
              </p>
              {p.sites.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--ink-500)' }}>{p.sites.join(', ')}</div>
              )}
            </div>
          );
        })}

        {patterns.length === 0 && (
          <Empty title="No patterns yet" body="Patterns appear once findings accumulate across calls." />
        )}
      </Panel>
    </div>
  );
}
