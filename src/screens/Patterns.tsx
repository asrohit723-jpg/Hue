import { useEffect, useMemo, useState } from 'react';
import { api, vibe, type DeviationWithEvidence } from '../lib/vibe';
import { BootSkeleton } from './BootSkeleton';
import { LoadError } from '../components/Chrome';
import { label, rootCauseTone } from '../lib/tone';
import { proposePatternFix, JudgeTimeout } from '../lib/judges';
import criteriaSeed from '../../evals/criteria.seed.json';
import { page } from '../lib/layout';

/**
 * Patterns — the PATTERNS block of the design ("Helpdesk Governance.dc.html",
 * lines 2547-2625): a card per pattern with its count and trend, a twelve-month
 * bar chart, and the "fix once at source" action beside it.
 *
 * A pattern is not stored anywhere. It is the same criterion failing on more
 * than one call, derived from the findings themselves, so the count can never
 * drift from the deviations it claims to summarise.
 *
 * Where the design carries something we do not hold, the element stays and says
 * so. The recommended fix is the clearest case: the design ships authored
 * copy per pattern, while a real recommendation only exists once the proposer
 * has drafted a correction. Until then the cell says the fix has not been
 * drafted rather than inventing advice.
 */

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const MONTHS = 12;

const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const microLabel: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: 'var(--ink-500)',
  fontWeight: 500,
};

interface Pattern {
  criterionId: string;
  title: string;
  clauseRef: string;
  count: number;
  openCount: number;
  worst: string;
  rootCause: string;
  sites: string[];
  example: string;
  representative: DeviationWithEvidence;
  /** Occurrences per month, oldest first, ending with the current month. */
  bars: number[];
  fix: string | null;
  fixTitle: string | null;
  fixState: string | null;
}

/** Month key (YYYY-MM) for the twelve buckets ending this month. */
function monthKeys(now: Date): string[] {
  const out: string[] = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export function Patterns({
  onOpenDeviation,
}: {
  onOpenDeviation?: (deviationId: string) => void;
}) {
  const [items, setItems] = useState<DeviationWithEvidence[] | null>(null);
  const [corrections, setCorrections] = useState<Map<string, { title: string; rationale: string; state: string }>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setItems(null);
      setError(null);
      try {
        const rows = await api.listDeviations('');
        if (cancelled) return;
        setItems(rows);

        // A pattern's recommended fix is whatever the proposer actually drafted
        // for one of its findings. Fetched per finding because corrections hang
        // off deviations, not off patterns — patterns are derived.
        const found = new Map<string, { title: string; rationale: string; state: string }>();
        await Promise.all(
          rows.map(async (d) => {
            try {
              const res = (await vibe.executeFunction('governance', 'getCorrection', {
                deviationId: d.id,
              })) as { correction: { title: string; rationale: string; state: string } | null };
              if (res?.correction) found.set(d.id, res.correction);
            } catch {
              // A missing correction is the normal case, not an error.
            }
          }),
        );
        if (!cancelled) setCorrections(found);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const criteria = useMemo(() => {
    const seed = (criteriaSeed as { criteria: Array<{ id: string; title: string }> }).criteria;
    const map = new Map(seed.map((c) => [c.id, c.title]));
    // CR-CAT-01 is graded by the engine and appears in the findings, but it is
    // not in evals/criteria.seed.json — the seed file and the criteria the
    // engine runs have drifted. Its text is taken from the engine's own
    // definition so the card has a title rather than a bare id; the real fix is
    // to add it to the seed.
    if (!map.has('CR-CAT-01')) {
      map.set(
        'CR-CAT-01',
        'The service request is categorised and prioritised to match the fault described',
      );
    }
    return map;
  }, []);

  const patterns = useMemo<Pattern[]>(() => {
    const keys = monthKeys(new Date());
    const by = new Map<string, DeviationWithEvidence[]>();
    for (const d of items ?? []) by.set(d.criterionId, [...(by.get(d.criterionId) ?? []), d]);

    return Array.from(by.entries())
      .map(([criterionId, list]) => {
        const worst = list
          .slice()
          .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9))[0];

        // Bucket by the CALL's date, not the detection date — the pattern is
        // about when the agent misbehaved, not when we noticed.
        const bars = keys.map((k) =>
          list.filter((d) => (d.startedAt ?? d.detectedAt ?? '').slice(0, 7) === k).length,
        );

        const drafted = list.map((d) => corrections.get(d.id)).find(Boolean) ?? null;

        return {
          criterionId,
          title: criteria.get(criterionId) ?? criterionId,
          clauseRef: worst.clauseRef,
          count: list.length,
          openCount: list.filter((d) => d.status === 'open').length,
          worst: worst.severity,
          rootCause: worst.rootCause || 'unknown',
          sites: Array.from(new Set(list.map((d) => d.siteHint).filter(Boolean) as string[])),
          example: worst.summary,
          representative: worst,
          bars,
          fix: drafted?.rationale ?? null,
          fixTitle: drafted?.title ?? null,
          fixState: drafted?.state ?? null,
        };
      })
      .sort((a, b) => b.count - a.count || (SEV_ORDER[a.worst] ?? 9) - (SEV_ORDER[b.worst] ?? 9));
  }, [items, criteria, corrections]);

  if (error) {
    return (
      <div style={page('28px 32px')}>
        <LoadError message={error} onRetry={() => setNonce((n) => n + 1)} />
      </div>
    );
  }
  if (!items) return <BootSkeleton label="Loading patterns…" />;

  return (
    <div style={page('28px 32px 40px')}>
      <h1
        style={{
          fontSize: 26,
          lineHeight: '32px',
          fontWeight: 700,
          margin: 0,
          letterSpacing: '-.01em',
        }}
      >
        Patterns
      </h1>
      <p style={{ margin: '6px 0 0', color: 'var(--ink-600)', maxWidth: 660, textWrap: 'pretty' }}>
        The same kind of deviation showing up across many calls. Each one has a single underlying
        cause, so it can be fixed once at the source instead of resolving every call by hand.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 22 }}>
        {patterns.map((p) => (
          <PatternCard
            key={p.criterionId}
            p={p}
            onOpenDeviation={onOpenDeviation}
            onProposed={() => setNonce((n) => n + 1)}
          />
        ))}

        {patterns.length === 0 && (
          <div
            style={{
              background: 'var(--surface-card)',
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-lg)',
              padding: '44px 24px',
              textAlign: 'center',
            }}
          >
            <span
              style={{
                width: 44,
                height: 44,
                borderRadius: 'var(--radius-pill)',
                background: 'var(--success-050)',
                color: 'var(--success-700)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <div style={{ fontWeight: 600, marginTop: 12 }}>No patterns yet</div>
            <p
              style={{
                margin: '6px auto 0',
                fontSize: 13,
                color: 'var(--ink-600)',
                maxWidth: '44ch',
                lineHeight: '20px',
              }}
            >
              A pattern appears once the same criterion fails on more than one call. Nothing has
              repeated yet.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function PatternCard({
  p,
  onOpenDeviation,
  onProposed,
}: {
  p: Pattern;
  onOpenDeviation?: (deviationId: string) => void;
  onProposed?: () => void;
}) {
  const [proposing, setProposing] = useState(false);
  const [proposeError, setProposeError] = useState<string | null>(null);

  /**
   * Ask the proposer for one fix covering every occurrence.
   *
   * A timeout is not a fix and is never shown as one — it surfaces as an
   * honest "could not reach the proposer", and nothing is written.
   */
  async function runProposer() {
    setProposing(true);
    setProposeError(null);
    try {
      const ctx = await api.patternContext(p.criterionId);
      if (!ctx.occurrences?.length) throw new Error('This pattern has no occurrences to read.');
      const fix = await proposePatternFix(ctx);
      await api.saveCorrection(
        ctx.representativeId ?? p.representative.id,
        p.rootCause === 'unknown' ? 'unknown' : p.rootCause,
        JSON.stringify(fix),
      );
      onProposed?.();
    } catch (err) {
      setProposeError(
        err instanceof JudgeTimeout
          ? 'The proposer did not respond. Nothing was written — try again.'
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setProposing(false);
    }
  }

  const rc = rootCauseTone(p.rootCause);
  const peak = Math.max(...p.bars, 1);
  // The design's own rule: a pattern worth fixing at source is one that has
  // happened more than once. A single occurrence is handled case by case.
  const systemic = p.count > 1;
  const applied = p.fixState === 'applied' || p.fixState === 'verifying' || p.fixState === 'resolved';

  const thisMonth = p.bars[p.bars.length - 1] ?? 0;
  const lastMonth = p.bars[p.bars.length - 2] ?? 0;
  const delta = thisMonth - lastMonth;
  const anyPrior = p.bars.slice(0, -1).some((b) => b > 0);
  const trend = !anyPrior
    ? { arrow: '→', text: 'first month seen', fg: 'var(--ink-500)' }
    : delta > 0
      ? { arrow: '↑', text: `+${delta} vs last month`, fg: 'var(--danger-500)' }
      : delta < 0
        ? { arrow: '↓', text: `${delta} vs last month`, fg: 'var(--success-700)' }
        : { arrow: '→', text: 'level with last month', fg: 'var(--ink-500)' };

  return (
    <div
      style={{
        background: 'var(--surface-card)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
      }}
    >
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '18px 22px 16px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>{p.title}</span>
            <span
              title={
                p.rootCause === 'unknown'
                  ? 'The root-cause judge has not classified this finding yet.'
                  : `Root cause: ${p.rootCause}`
              }
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11,
                fontWeight: 600,
                color: rc.fg,
                background: rc.bg,
                borderRadius: 'var(--radius-pill)',
                padding: '3px 9px',
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 'var(--radius-sm)', background: rc.fg }} />
              {label(p.rootCause)}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--blue-600)',
                background: 'var(--blue-025)',
                borderRadius: 'var(--radius-pill)',
                padding: '3px 9px',
              }}
            >
              {p.clauseRef || '—'}
            </span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-500)', marginTop: 5 }}>
            {/* Live call logs carry no site, so this is genuinely unknown on
                calls whose CMMS join found nothing. */}
            Seen at {p.sites.length ? p.sites.join(', ') : 'no site resolved'}
          </div>
        </div>
        <div style={{ textAlign: 'right', flex: '0 0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, justifyContent: 'flex-end' }}>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 700, lineHeight: 1 }}>
              {p.count}
            </span>
            <span style={{ fontSize: 13, color: 'var(--ink-500)' }}>
              {p.count === 1 ? 'call' : 'calls'}
            </span>
          </div>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 12,
              color: trend.fg,
              fontWeight: 600,
              marginTop: 3,
            }}
          >
            {trend.arrow} {trend.text}
          </div>
        </div>
      </div>

      {/* body */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.15fr)',
          gap: 0,
          borderTop: '1px solid var(--ink-100)',
        }}
      >
        {/* chart */}
        <div style={{ padding: '16px 22px', borderRight: '1px solid var(--ink-100)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 10,
            }}
          >
            <span style={microLabel}>Calls per month</span>
            <span style={{ fontSize: 11, color: 'var(--ink-400)' }}>peak {peak}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 52 }}>
            {p.bars.map((b, i) => {
              const isLast = i === p.bars.length - 1;
              const d = new Date();
              const m = new Date(d.getFullYear(), d.getMonth() - (p.bars.length - 1 - i), 1);
              return (
                <div
                  key={i}
                  title={`${b} in ${MONTH_LABEL[m.getMonth()]} ${m.getFullYear()}`}
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    height: '100%',
                  }}
                >
                  {isLast && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--blue-700)', lineHeight: '13px' }}>
                      {b}
                    </span>
                  )}
                  <div
                    style={{
                      width: '100%',
                      // A zero month still draws a sliver, so the axis reads as
                      // twelve months rather than a gap.
                      height: `${b === 0 ? 2 : Math.max(6, Math.round((b / peak) * 100))}%`,
                      background: isLast ? 'var(--blue-700)' : 'var(--border-default)',
                      borderRadius: '2px 2px 0 0',
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 6,
              fontSize: 11,
              color: 'var(--ink-400)',
            }}
          >
            <span>12 months ago</span>
            <span style={{ color: 'var(--blue-700)', fontWeight: 600 }}>this month</span>
          </div>
        </div>

        {/* action */}
        {systemic ? (
          <div
            style={{
              padding: '16px 22px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              background: applied ? 'var(--success-050)' : 'var(--blue-025)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--blue-600)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
              <span
                style={{
                  fontSize: 11,
                  letterSpacing: '.04em',
                  textTransform: 'uppercase',
                  color: 'var(--blue-600)',
                  fontWeight: 600,
                }}
              >
                Fix once at source
              </span>
            </div>
            <div style={{ fontSize: 13, lineHeight: '20px', color: 'var(--ink-700)', textWrap: 'pretty' }}>
              {p.fix ? (
                <>
                  {p.fixTitle && <b style={{ fontWeight: 600 }}>{p.fixTitle}. </b>}
                  {p.fix}
                </>
              ) : (
                <span style={{ color: 'var(--ink-600)' }}>
                  No fix has been drafted for this pattern yet. Open one of its interventions and run
                  the judges — the proposal it produces is the recommendation that appears here.
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 'auto' }}>
              <button className="hue-btn"
                onClick={p.fix ? () => onOpenDeviation?.(p.representative.id) : runProposer}
                disabled={proposing}
                aria-busy={proposing}
                style={{
                  height: 34,
                  padding: '0 15px',
                  borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${applied ? 'var(--success-500)' : 'var(--blue-500)'}`,
                  background: applied ? 'var(--success-050)' : 'var(--blue-500)',
                  color: applied ? 'var(--success-700)' : 'var(--surface-card)',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                }}
              >
                {applied && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
                {proposing && <span className="hue-spinner" aria-hidden="true" />}
                {proposing ? 'Drafting the fix…' : applied ? 'Fix applied' : p.fix ? 'Review the fix' : 'Fix at source'}
              </button>
              <span style={{ fontSize: 12, color: 'var(--ink-600)' }}>
                clears <strong>{p.openCount}</strong> open{' '}
                {p.openCount === 1 ? 'intervention' : 'interventions'}
              </span>
            </div>
            {proposeError && (
              <div style={{ fontSize: 12, color: 'var(--danger-700)', lineHeight: '18px' }}>
                {proposeError}
              </div>
            )}
          </div>
        ) : (
          <div style={{ padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ink-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span
                style={{
                  fontSize: 11,
                  letterSpacing: '.04em',
                  textTransform: 'uppercase',
                  color: 'var(--ink-500)',
                  fontWeight: 600,
                }}
              >
                Handle case by case
              </span>
            </div>
            <div style={{ fontSize: 13, lineHeight: '20px', color: 'var(--ink-600)', textWrap: 'pretty' }}>
              {p.example}
            </div>
            <span
              onClick={() => onOpenDeviation?.(p.representative.id)}
              className="hue-link"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (() => onOpenDeviation?.(p.representative.id))();
              }}
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--blue-500)',
                cursor: 'pointer',
                marginTop: 'auto',
              }}
            >
              Open the intervention →
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
