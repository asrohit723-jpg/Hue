import { useEffect, useMemo, useState } from 'react';
import type { Conversation } from '@shared/contract';
import { api, type DeviationWithEvidence, type OverviewMetrics } from '../lib/vibe';
import { BootSkeleton } from './BootSkeleton';
import { ErrorState } from './ErrorState';
import { FirstRun } from './FirstRun';
import criteriaSeed from '../../evals/criteria.seed.json';
import { page } from '../lib/layout';

/**
 * Governance overview — ported from the OVERVIEW block of the design
 * ("Helpdesk Governance.dc.html", lines 1535-1716). Every measurement, spacing
 * and colour here comes from that markup.
 *
 * The design's own numbers are placeholders: its sparkline is a literal
 * fourteen-element array, its deviation bars and sentiment split are fixed
 * counts multiplied by `callsToday / 148`, and its angry share is the constant
 * `34 / 148`. None of that survives here. The design supplies the layout; every
 * value is computed from the conversations and findings we actually hold, which
 * are in turn joined to real CMMS records server-side.
 *
 * One consequence worth stating: because the range and site pills have to move
 * every card together, the metrics are derived on the client from one loaded
 * set rather than read from the server's pre-aggregated `overview`. The
 * compliance formula is copied from that handler verbatim so the number keeps
 * its established meaning. Above the row cap we defer to the server's totals —
 * see `truncated` below.
 */

// The most rows listConversations will return. Matches its server-side clamp.
const ROW_CAP = 200;

const CARD_BORDER = '#E1E8F2';
const HERO_INK = '#0C447C';
const SPARK_STROKE = '#378ADD';

const card: React.CSSProperties = {
  background: '#fff',
  border: `1px solid ${CARD_BORDER}`,
  borderRadius: 12,
};
const kpiLabel: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: 'var(--ink-500)',
  fontWeight: 500,
};
const kpiValue: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 500,
  fontSize: 22,
  lineHeight: '28px',
  marginTop: 2,
};
const kpiSub: React.CSSProperties = { fontSize: 11, color: 'var(--ink-600)' };
const panelH3: React.CSSProperties = { fontSize: 15, fontWeight: 600, margin: 0 };
const panelSub: React.CSSProperties = { margin: '2px 0 0', fontSize: 12, color: 'var(--ink-600)' };
const linkish: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--blue-500)',
  cursor: 'pointer',
  fontWeight: 500,
};

// ---------------------------------------------------------------------------
// Ranges. The design offers these five; each is resolved against the clock at
// render time rather than against a fixed "today", so the screen keeps working
// after the demo date passes.
// ---------------------------------------------------------------------------

type RangeKey = 'Today' | 'Yesterday' | 'This Week' | 'This Month' | 'This Year';
const RANGE_KEYS: RangeKey[] = ['Today', 'Yesterday', 'This Week', 'This Month', 'This Year'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** [start, end) for a range key, plus the caption the design prints beside it. */
function resolveRange(key: RangeKey, now: Date): { from: Date; to: Date; label: string } {
  const today = startOfDay(now);
  const dayMs = 86_400_000;
  switch (key) {
    case 'Yesterday': {
      const from = new Date(today.getTime() - dayMs);
      return { from, to: today, label: `Yesterday, ${dayLabel(from)}` };
    }
    case 'This Week': {
      // Monday-based, matching the design's "10-16 Aug" week.
      const dow = (today.getDay() + 6) % 7;
      const from = new Date(today.getTime() - dow * dayMs);
      const last = new Date(from.getTime() + 6 * dayMs);
      return {
        from,
        to: new Date(from.getTime() + 7 * dayMs),
        label: `This week, ${from.getDate()}–${dayLabel(last)}`,
      };
    }
    case 'This Month': {
      const from = new Date(today.getFullYear(), today.getMonth(), 1);
      return {
        from,
        to: new Date(today.getFullYear(), today.getMonth() + 1, 1),
        label: `This month, ${MONTHS[from.getMonth()]} ${from.getFullYear()}`,
      };
    }
    case 'This Year': {
      const from = new Date(today.getFullYear(), 0, 1);
      return {
        from,
        to: new Date(today.getFullYear() + 1, 0, 1),
        label: `This year, ${from.getFullYear()}`,
      };
    }
    default: {
      return {
        from: today,
        to: new Date(today.getTime() + dayMs),
        label: `Today, ${dayLabel(today)}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Tones, lifted from the design's sevTone / rcTone helpers.
// ---------------------------------------------------------------------------

function sevDot(sev: string): string {
  if (sev === 'critical') return 'var(--danger-500)';
  if (sev === 'high') return 'var(--danger-700)';
  if (sev === 'medium') return 'var(--warning-500)';
  return 'var(--ink-400)';
}

function rcTone(rc: string): { bg: string; fg: string } {
  if (rc === 'agent') return { bg: 'var(--brand-indigo-050)', fg: 'var(--brand-indigo)' };
  if (rc === 'data') return { bg: 'var(--blue-025)', fg: 'var(--blue-600)' };
  return { bg: 'var(--warning-050)', fg: 'var(--warning-700)' };
}

/**
 * Deviation "type" = the criterion family. Criterion titles are full sentences
 * ("A service request exists in the CMMS for every issue the caller reported"),
 * far too long for the design's bar rows, and the clause refs are too cryptic
 * to read at a glance. The family prefix is the level the design's own labels
 * sat at, and it is derived from the id rather than invented.
 */
const FAMILY_LABEL: Record<string, string> = {
  LOG: 'Logging',
  SCOPE: 'Scope boundary',
  ESC: 'Escalation',
  CALL: 'Call handling',
  SCHED: 'Scheduling',
  // Present in the criteria table but not in evals/criteria.seed.json.
  CAT: 'Categorisation',
};
// The design's bar palette, in its order.
const BAR_COLORS = [
  'var(--blue-500)',
  'var(--brand-indigo-400)',
  'var(--warning-500)',
  'var(--danger-500)',
  'var(--danger-700)',
  'var(--ink-400)',
];

function familyOf(criterionId: string): string {
  const part = criterionId.split('-')[1] ?? '';
  // An unmapped family keeps its own token rather than being title-cased into
  // something that reads like a typo ("CAT" -> "Cat").
  return FAMILY_LABEL[part] ?? (part || 'Other');
}

const SENTIMENT_BUCKETS = [
  { label: 'Neutral', match: ['neutral'], color: 'var(--ink-400)' },
  { label: 'Happy', match: ['happy'], color: 'var(--success-500)' },
  { label: 'Frustrated', match: ['frustrated'], color: 'var(--warning-500)' },
  // The contract's enum calls this 'distressed'; the design's legend says Angry.
  { label: 'Angry', match: ['distressed'], color: 'var(--danger-500)' },
];

const hhmm = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------

type Load =
  | { phase: 'loading' }
  | { phase: 'ready'; metrics: OverviewMetrics; convos: Conversation[]; devs: DeviationWithEvidence[] }
  | { phase: 'error'; message: string };

export function Overview({
  onCounts,
  onOpenDeviation,
  onNavigate,
}: {
  onCounts?: (calls: number, open: number) => void;
  onOpenDeviation?: (deviationId: string) => void;
  onNavigate?: (screen: 'ints' | 'scope' | 'patterns') => void;
}) {
  const [state, setState] = useState<Load>({ phase: 'loading' });
  const [nonce, setNonce] = useState(0);

  const [range, setRange] = useState<RangeKey>('Today');
  const [rangeOpen, setRangeOpen] = useState(false);
  const [siteSel, setSiteSel] = useState<string[]>([]);
  const [siteOpen, setSiteOpen] = useState(false);
  const [exported, setExported] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setState({ phase: 'loading' });
      try {
        const [metrics, convos, devs] = await Promise.all([
          api.overview(),
          api.listConversations(ROW_CAP),
          api.listDeviations(''),
        ]);
        if (cancelled) return;
        setState({ phase: 'ready', metrics, convos, devs });
        onCounts?.(metrics.callsToday, devs.filter((d) => d.status === 'open').length);

        // Open on a range that actually contains calls. The pill shows which one
        // is selected, so nothing is hidden — this only avoids greeting the user
        // with an empty dashboard when the newest call predates today.
        const now = new Date();
        const hasCalls = (k: RangeKey) => {
          const { from, to } = resolveRange(k, now);
          return convos.some((c) => {
            const t = new Date(c.startedAt).getTime();
            return t >= from.getTime() && t < to.getTime();
          });
        };
        if (convos.length > 0 && !hasCalls('Today')) {
          const fallback = RANGE_KEYS.find(hasCalls);
          if (fallback) setRange(fallback);
        }
      } catch (err) {
        if (cancelled) return;
        // A failure here means the CMMS connector or the app DB is unreachable.
        // Surface it as an error state rather than bouncing the user to login —
        // only getCurrentUser() returning null drives the login redirect.
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : 'The CMMS connector did not respond.',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  const ready = state.phase === 'ready' ? state : null;

  const view = useMemo(() => {
    if (!ready) return null;
    const { metrics, convos, devs } = ready;
    const { from, to, label: rangeLabel } = resolveRange(range, new Date());

    const inRange = convos.filter((c) => {
      const t = new Date(c.startedAt).getTime();
      return !Number.isNaN(t) && t >= from.getTime() && t < to.getTime();
    });
    const calls = siteSel.length
      ? inRange.filter((c) => c.site && siteSel.includes(c.site))
      : inRange;

    // Findings follow their call, so a filtered call set filters its findings.
    const callIds = new Set(calls.map((c) => c.id));
    const findings = devs.filter((d) => callIds.has(d.conversationId));
    const open = findings.filter((d) => d.status === 'open');

    // Above the cap the client set is a partial view, so the server's totals are
    // the honest source for the headline figures.
    const truncated = convos.length >= ROW_CAP;

    // The share of evaluated calls with nothing open against them — matching
    // the server's definition exactly. Counting findings instead of calls goes
    // negative as soon as one call carries several, which is common.
    const complianceOver = (subset: typeof calls, openSet: typeof open) => {
      const eva = subset.filter((c) => c.evalStatus !== 'not_evaluated');
      if (!eva.length) return 100;
      const flagged = new Set(openSet.map((d) => d.conversationId));
      return Math.round((eva.filter((c) => !flagged.has(c.id)).length / eva.length) * 100);
    };
    const compliance = truncated ? metrics.compliance : complianceOver(calls, open);

    const logged = calls.filter((c) => c.srRecordId).length;
    const missing = calls.length - logged;
    const upset = calls.filter(
      (c) => c.sentiment === 'frustrated' || c.sentiment === 'distressed',
    ).length;
    const critical = open.filter((d) => d.severity === 'critical').length;

    // ---- sparkline -------------------------------------------------------
    // Preferred shape is compliance per day. Seeded and early-live data often
    // lands inside a single day, which would leave one point and no line, so
    // below three distinct days this falls back to compliance measured after
    // each successive call — the same quantity, sampled per call instead of per
    // day. `sparkBasis` says which one is on screen.
    const chron = calls
      .slice()
      .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
    const days = Array.from(new Set(chron.map((c) => c.startedAt.slice(0, 10)))).sort();

    let series: number[] = [];
    let sparkBasis = '';
    if (days.length >= 3) {
      series = days.map((day) => {
        const upTo = chron.filter((c) => c.startedAt.slice(0, 10) <= day);
        const ids = new Set(upTo.map((c) => c.id));
        return complianceOver(
          upTo,
          open.filter((d) => ids.has(d.conversationId)),
        );
      });
      sparkBasis = `by day across ${days.length} days`;
    } else if (chron.length >= 2) {
      series = chron.map((_, i) => {
        const upTo = chron.slice(0, i + 1);
        const ids = new Set(upTo.map((c) => c.id));
        return complianceOver(
          upTo,
          open.filter((d) => ids.has(d.conversationId)),
        );
      });
      sparkBasis = `after each of ${chron.length} calls`;
    }

    // Design geometry: viewBox 0 0 600 60, drawn between y=6 and y=56.
    let spark: { points: string; endX: string; endY: string } | null = null;
    if (series.length >= 2) {
      const lo = Math.min(...series) - 4;
      const hi = Math.max(...series) + 4;
      const pts = series.map((v, i) => ({
        x: ((600 / (series.length - 1)) * i).toFixed(1),
        y: (56 - ((v - lo) / (hi - lo || 1)) * 50).toFixed(1),
      }));
      spark = {
        points: pts.map((p) => `${p.x},${p.y}`).join(' '),
        endX: pts[pts.length - 1].x,
        endY: pts[pts.length - 1].y,
      };
    }

    const delta = series.length >= 2 ? series[series.length - 1] - series[0] : null;

    // ---- deviations by type ---------------------------------------------
    const byFamily = new Map<string, number>();
    for (const d of findings) {
      const f = familyOf(d.criterionId);
      byFamily.set(f, (byFamily.get(f) ?? 0) + 1);
    }
    const barsAll = Array.from(byFamily.entries()).sort((a, b) => b[1] - a[1]);
    const barMax = Math.max(1, ...barsAll.map(([, n]) => n));
    const bars = barsAll.slice(0, 6).map(([label, count], i) => ({
      label,
      count,
      pct: Math.round((count / barMax) * 100),
      color: BAR_COLORS[i % BAR_COLORS.length],
    }));

    // ---- sentiment donut -------------------------------------------------
    const C = 2 * Math.PI * 54;
    let acc = 0;
    const donut = SENTIMENT_BUCKETS.map((b) => {
      const count = calls.filter((c) => c.sentiment && b.match.includes(c.sentiment)).length;
      const len = calls.length ? (count / calls.length) * C : 0;
      const seg = {
        label: b.label,
        color: b.color,
        count,
        pct: calls.length ? Math.round((count / calls.length) * 100) : 0,
        dash: `${len.toFixed(1)} ${(C - len).toFixed(1)}`,
        offset: (-acc).toFixed(1),
      };
      acc += len;
      return seg;
    });

    // ---- recent interventions -------------------------------------------
    const recent = open
      .slice()
      .sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime())
      .slice(0, 5);

    // ---- patterns, the way the Patterns screen counts them ---------------
    const perCriterion = new Map<string, number>();
    for (const d of findings) perCriterion.set(d.criterionId, (perCriterion.get(d.criterionId) ?? 0) + 1);
    const recurring = Array.from(perCriterion.values()).filter((n) => n > 1).length;

    const siteOptions = Array.from(
      new Set(convos.map((c) => c.site).filter((s): s is string => !!s)),
    ).sort();
    const siteLabel =
      siteSel.length === 0 ? 'All sites' : siteSel.length === 1 ? siteSel[0] : `${siteSel.length} sites`;

    return {
      metrics,
      rangeLabel,
      calls,
      truncated,
      compliance,
      delta,
      spark,
      sparkBasis,
      logged,
      missing,
      upset,
      open,
      critical,
      bars,
      donut,
      recent,
      recurring,
      siteOptions,
      siteLabel,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, range, siteSel]);

  if (state.phase === 'loading') return <BootSkeleton />;
  if (state.phase === 'error') {
    return <ErrorState message={state.message} onRetry={() => setNonce((n) => n + 1)} />;
  }
  if (state.metrics.isFirstRun) return <FirstRun sites={state.metrics.sites} />;
  if (!view) return <BootSkeleton />;

  const v = view;
  const criteriaCount = (criteriaSeed as { criteria: unknown[] }).criteria.length;

  function exportExcel() {
    if (!ready) return;
    // A real export of what is on screen — the same filtered rows, nothing
    // fabricated. CSV rather than a binary workbook: Excel opens it directly
    // and it needs no dependency in the bundle.
    const esc = (val: unknown) => {
      const s = val === null || val === undefined ? '' : String(val);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows: string[] = [];
    rows.push('CALLS');
    rows.push(['Call id', 'Started', 'Caller', 'Site', 'Sentiment', 'Eval status', 'CMMS SR'].join(','));
    for (const c of v.calls) {
      rows.push(
        [c.callId, c.startedAt, c.caller.name, c.site, c.sentiment, c.evalStatus, c.srRecordId]
          .map(esc)
          .join(','),
      );
    }
    rows.push('');
    rows.push('DEVIATIONS');
    rows.push(['Criterion', 'Clause', 'Severity', 'Root cause', 'Status', 'Caller', 'Site', 'Summary'].join(','));
    for (const d of ready.devs.filter((d) => v.calls.some((c) => c.id === d.conversationId))) {
      rows.push(
        [d.criterionId, d.clauseRef, d.severity, d.rootCause, d.status, d.callerName, d.siteHint, d.summary]
          .map(esc)
          .join(','),
      );
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hue-governance-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setExported(true);
    window.setTimeout(() => setExported(false), 2400);
  }

  const exportLabel = exported ? 'Downloaded' : 'Export to Excel';

  return (
    <div style={page('28px 32px 40px')}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 20 }}>
        <div>
          <h1
            style={{
              fontSize: 26,
              lineHeight: '32px',
              fontWeight: 700,
              margin: 0,
              letterSpacing: '-.01em',
            }}
          >
            Governance overview
          </h1>
          <p style={{ margin: '6px 0 0', color: 'var(--ink-600)' }}>
            Helpdesk voice agent · {v.rangeLabel}
          </p>
        </div>

        <div style={{ position: 'relative', marginLeft: 'auto' }}>
          <PillButton onClick={() => setRangeOpen((o) => !o)} chevronUp={rangeOpen}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M3 10h18" />
              <path d="M8 2v4" />
              <path d="M16 2v4" />
            </svg>
            {range}
          </PillButton>
          {rangeOpen && (
            <Menu width={180} align="right">
              {RANGE_KEYS.map((k) => (
                <MenuRow
                  key={k}
                  active={k === range}
                  onClick={() => {
                    setRange(k);
                    setRangeOpen(false);
                  }}
                >
                  {k}
                  {k === range && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--blue-500)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </MenuRow>
              ))}
            </Menu>
          )}
        </div>

        <div style={{ position: 'relative' }}>
          <PillButton onClick={() => setSiteOpen((o) => !o)} chevronUp={siteOpen}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 6h22M5 12h14M9 18h6" />
            </svg>
            {v.siteLabel}
          </PillButton>
          {siteOpen && (
            <Menu width={220} align="left">
              {v.siteOptions.map((name) => {
                const on = siteSel.includes(name);
                return (
                  <div
                    key={name}
                    onClick={() =>
                      setSiteSel(on ? siteSel.filter((s) => s !== name) : [...siteSel, name])
                    }
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      padding: '9px 10px',
                      borderRadius: 6,
                      cursor: 'pointer',
                      fontSize: 13,
                      color: 'var(--ink-900)',
                    }}
                  >
                    <span
                      style={{
                        width: 16,
                        height: 16,
                        flex: '0 0 16px',
                        borderRadius: 4,
                        border: `1.5px solid ${on ? 'var(--blue-500)' : 'var(--border-default)'}`,
                        background: on ? 'var(--blue-500)' : '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {on && (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </span>
                    {name}
                  </div>
                );
              })}
              <div style={{ borderTop: '1px solid var(--border-default)', marginTop: 4, paddingTop: 6 }}>
                <div
                  onClick={() => {
                    setSiteSel([]);
                    setSiteOpen(false);
                  }}
                  style={{
                    padding: '7px 10px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 12,
                    color: 'var(--blue-500)',
                    fontWeight: 500,
                  }}
                >
                  Clear, show all sites
                </div>
              </div>
            </Menu>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="hue-btn"
            onClick={exportExcel}
            style={{
              height: 36,
              padding: '0 14px',
              borderRadius: 4,
              border: '1px solid var(--border-default)',
              background: '#fff',
              color: 'var(--ink-900)',
              fontWeight: 500,
              fontSize: 13,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 7,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <path d="M12 15V3" />
            </svg>
            {exportLabel}
          </button>
        </div>
      </div>

      {/* hero metrics */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1.5fr) minmax(240px,1fr)',
          gap: 16,
        }}
      >
        <div style={{ ...card, padding: '20px 22px' }}>
          <span style={{ ...kpiLabel, fontSize: 12 }}>Compliance score</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
            <span
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 500,
                fontSize: 42,
                lineHeight: '46px',
                color: HERO_INK,
              }}
            >
              {v.compliance}
            </span>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 999,
                padding: '3px 10px',
                color:
                  v.delta === null
                    ? 'var(--ink-600)'
                    : v.delta >= 0
                      ? 'var(--success-700)'
                      : 'var(--danger-500)',
                background:
                  v.delta === null
                    ? 'var(--ink-050)'
                    : v.delta >= 0
                      ? 'var(--success-050)'
                      : 'var(--danger-050)',
              }}
            >
              {v.delta === null
                ? 'No trend yet'
                : `${v.delta >= 0 ? '↑' : '↓'} ${Math.abs(v.delta)} pts`}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 4 }}>
            {v.siteLabel} · {range.toLowerCase()}
            {v.sparkBasis ? ` · ${v.sparkBasis}` : ''}
          </div>
          <svg
            viewBox="0 0 600 60"
            preserveAspectRatio="none"
            style={{ width: '100%', height: 60, display: 'block', marginTop: 14, overflow: 'visible' }}
          >
            {v.spark && (
              <>
                <polyline
                  points={v.spark.points}
                  fill="none"
                  stroke={SPARK_STROKE}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
                <circle cx={v.spark.endX} cy={v.spark.endY} r="4" fill={SPARK_STROKE} />
              </>
            )}
          </svg>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            onClick={() => onNavigate?.('ints')}
            className="hue-card-click"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onNavigate?.('ints');
            }}
            style={{ ...card, padding: '14px 16px' }}
          >
            <div style={kpiLabel}>Open interventions</div>
            <div style={{ ...kpiValue, color: 'var(--danger-500)' }}>{v.open.length}</div>
            <div style={kpiSub}>{v.critical} critical · needs review</div>
          </div>
          <div style={{ ...card, padding: '14px 16px' }}>
            <div style={kpiLabel}>Requests logged</div>
            <div style={{ ...kpiValue, color: 'var(--ink-900)' }}>
              {v.logged} of {v.calls.length}
            </div>
            <div style={kpiSub}>
              {v.missing} {v.missing === 1 ? 'call' : 'calls'} ended with no service request
            </div>
          </div>
        </div>
      </div>

      {/* secondary metrics */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))',
          gap: 16,
          marginTop: 16,
        }}
      >
        <Kpi
          label={range === 'Today' ? 'Calls today' : `Calls ${range.toLowerCase()}`}
          value={String(v.calls.length)}
          sub={v.metrics.deltaCalls}
        />
        <Kpi
          label="Angry / frustrated"
          value={`${v.calls.length ? Math.round((v.upset / v.calls.length) * 100) : 0}%`}
          sub={`${v.upset} of ${v.calls.length} callers`}
        />
        <Kpi
          label="Corrections applied"
          value={String(v.metrics.corrections)}
          sub={`all time, ${v.metrics.verified} verified`}
        />
        {/* The CHANNEL's own count, not Hue's. The two can differ while ingest
            is behind, and that gap is worth seeing rather than smoothing over —
            so this says where the number came from. */}
        <Kpi
          label="On the call channel"
          value={v.metrics.callStats ? String(v.metrics.callStats.total) : '—'}
          sub={
            v.metrics.callStats
              ? Object.entries(v.metrics.callStats.byType)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, n]) => `${n} ${k.toLowerCase()}`)
                  .join(' · ') || 'no breakdown reported'
              : 'the call channel is unreachable'
          }
        />
      </div>

      {/* deviations by type + sentiment split */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 16,
          marginTop: 16,
          alignItems: 'stretch',
        }}
      >
        <div style={{ ...card, padding: '18px 20px', display: 'flex', flexDirection: 'column' }}>
          <h3 style={panelH3}>Deviations by type</h3>
          <p style={panelSub}>{v.rangeLabel}</p>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              marginTop: 18,
              flex: 1,
              justifyContent: v.bars.length ? 'space-between' : 'center',
            }}
          >
            {v.bars.map((b) => (
              <div key={b.label} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span>{b.label}</span>
                  <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{b.count}</span>
                </div>
                <div
                  style={{
                    height: 8,
                    borderRadius: 999,
                    background: 'var(--ink-100)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${b.pct}%`,
                      background: b.color,
                      borderRadius: 999,
                    }}
                  />
                </div>
              </div>
            ))}
            {v.bars.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--ink-600)', textAlign: 'center' }}>
                No deviations in this range.
              </div>
            )}
          </div>
        </div>

        <div style={{ ...card, padding: '18px 20px', display: 'flex', flexDirection: 'column' }}>
          <h3 style={panelH3}>Sentiment split</h3>
          <p style={panelSub}>Caller sentiment at end of call · {range.toLowerCase()}</p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 32,
              marginTop: 16,
              flex: 1,
              justifyContent: 'center',
            }}
          >
            <svg viewBox="0 0 140 140" style={{ width: 196, height: 196, flex: '0 0 196px' }}>
              {v.donut.map((s) => (
                <circle
                  key={s.label}
                  cx="70"
                  cy="70"
                  r="54"
                  fill="none"
                  stroke={s.color}
                  strokeWidth="20"
                  strokeDasharray={s.dash}
                  strokeDashoffset={s.offset}
                  transform="rotate(-90 70 70)"
                />
              ))}
              <text
                x="70"
                y="70"
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize="34"
                fontFamily="Roboto Condensed"
                fontWeight="700"
                fill="#283648"
              >
                {v.calls.length}
              </text>
            </svg>
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1, minWidth: 150 }}
            >
              {v.donut.map((s) => (
                <div
                  key={s.label}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 14 }}
                >
                  <span
                    style={{ width: 10, height: 10, borderRadius: 2, background: s.color }}
                  />
                  <span style={{ flex: 1 }}>{s.label}</span>
                  <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                    {s.count}
                  </span>
                  <span
                    style={{
                      color: 'var(--ink-500)',
                      width: 40,
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {s.pct}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* recent interventions */}
      <div style={{ marginTop: 16 }}>
        <div
          style={{ background: '#fff', border: '1px solid var(--border-default)', borderRadius: 8 }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: '1px solid var(--border-default)',
            }}
          >
            <h3 style={panelH3}>Recent interventions</h3>
            <span onClick={() => onNavigate?.('ints')} className="hue-link" role="button" tabIndex={0} style={linkish}>
              View all
            </span>
          </div>
          {v.recent.map((r) => {
            const tone = rcTone(r.rootCause);
            return (
              <Row key={r.id} onClick={() => onOpenDeviation?.(r.id)}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: sevDot(r.severity),
                    flex: '0 0 6px',
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{r.summary}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 2 }}>
                    {r.callerName ?? 'Unknown caller'} · {r.siteHint ?? 'Unknown site'} ·{' '}
                    {r.criterionId}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: tone.bg,
                    color: tone.fg,
                    textTransform: 'capitalize',
                  }}
                >
                  {r.rootCause}
                </span>
                <span
                  style={{ fontSize: 12, color: 'var(--ink-500)', width: 64, textAlign: 'right' }}
                >
                  {hhmm(r.startedAt)}
                </span>
              </Row>
            );
          })}
          {v.recent.length === 0 && (
            <div style={{ padding: '18px 20px', fontSize: 13, color: 'var(--ink-600)' }}>
              No open interventions in this range.
            </div>
          )}
        </div>
      </div>

      {/* bottom row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))',
          gap: 16,
          marginTop: 16,
          background: '#fff',
          border: '1px solid var(--border-default)',
          borderRadius: 8,
          padding: '16px 20px',
        }}
      >
        <div>
          <div style={kpiLabel}>Scope of work</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>{criteriaCount} criteria active</div>
          <span onClick={() => onNavigate?.('scope')} className="hue-link" role="button" tabIndex={0} style={linkish}>
            Review criteria
          </span>
        </div>
        <div>
          <div style={kpiLabel}>Recurring problems</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {v.recurring} {v.recurring === 1 ? 'pattern' : 'patterns'} tracked
          </div>
          <span onClick={() => onNavigate?.('patterns')} className="hue-link" role="button" tabIndex={0} style={linkish}>
            Fix at source
          </span>
        </div>
        <div>
          <div style={kpiLabel}>Export</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>Calls, deviations and corrections</div>
          <span onClick={exportExcel} className="hue-link" role="button" tabIndex={0} style={linkish}>
            {exportLabel}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces, each matching the design's inline styling.
// ---------------------------------------------------------------------------

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{ ...card, padding: '14px 16px' }}>
      <div style={kpiLabel}>{label}</div>
      <div style={{ ...kpiValue, color: 'var(--ink-900)' }}>{value}</div>
      <div style={kpiSub}>{sub}</div>
    </div>
  );
}

function PillButton({
  onClick,
  chevronUp,
  children,
}: {
  onClick: () => void;
  chevronUp: boolean;
  children: React.ReactNode;
}) {
  return (
    <button className="hue-btn"
      onClick={onClick}
      style={{
        height: 36,
        padding: '0 12px',
        borderRadius: 999,
        border: '1px solid var(--border-default)',
        background: '#fff',
        fontWeight: 500,
        fontSize: 13,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        color: 'var(--ink-900)',
      }}
    >
      {children}
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={chevronUp ? { transform: 'rotate(180deg)' } : undefined}
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
  );
}

function Menu({
  width,
  align,
  children,
}: {
  width: number;
  align: 'left' | 'right';
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 42,
        [align]: 0,
        width,
        background: '#fff',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(20,30,50,0.12)',
        padding: 6,
        zIndex: 20,
      }}
    >
      {children}
    </div>
  );
}

function MenuRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '9px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        fontSize: 13,
        color: 'var(--ink-900)',
        background: active ? 'var(--blue-025)' : 'transparent',
      }}
    >
      {children}
    </div>
  );
}

/** A recent-intervention row, with the design's hover tint. */
function Row({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <div
      onClick={onClick}
      className="hue-row"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 20px',
        borderBottom: '1px solid var(--ink-100)',
        cursor: 'pointer',
        background: '#fff',
      }}
    >
      {children}
    </div>
  );
}
