import { useEffect, useMemo, useState } from 'react';
import { api, type DeviationWithEvidence } from '../lib/vibe';
import { BootSkeleton } from './BootSkeleton';
import { LoadError } from '../components/Chrome';
import { clock, label, rootCauseTone, severityTone } from '../lib/tone';
import criteriaSeed from '../../evals/criteria.seed.json';
import { page } from '../lib/layout';

/**
 * Interventions — the INTERVENTIONS LIST block of the design
 * ("Helpdesk Governance.dc.html", lines 2000-2081): the three summary cards,
 * the four-control filter bar, and the six-column table with its severity dot,
 * clause pill, root-cause tag and status dot.
 *
 * Every column and control the design has is here. Where a value is not in the
 * data, the cell keeps its shape and shows an em dash rather than collapsing —
 * dropping a column would quietly redesign the table.
 *
 * One deliberate difference from the design's logic: it derives a row's status
 * from the state of the CORRECTION attached to the finding, because in the mock
 * every finding has one. Here a finding may have no correction yet, so status
 * comes from the deviation's own lifecycle, mapped onto the design's four
 * labels. That keeps the vocabulary the design established without inventing a
 * correction that does not exist.
 */

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const COLS = '92px minmax(220px,1.9fr) 72px minmax(150px,1.1fr) 96px 116px 24px';

const SEVERITY_OPTIONS = ['All severities', 'critical', 'high', 'medium', 'low'];
const ROOT_OPTIONS = ['All causes', 'agent', 'data', 'sow', 'unknown'];
const STATUS_OPTIONS = ['All statuses', 'Needs review', 'Fix applied', 'Resolved', 'With a human'];

/**
 * The deviation lifecycle in the design's words.
 *
 * 'open' is a finding nobody has acted on — the design calls that "Needs
 * review". 'correcting' means a fix is applied and being verified.
 */
function statusOf(status: string): { text: string; fg: string } {
  if (status === 'resolved') return { text: 'Resolved', fg: 'var(--success-700)' };
  if (status === 'correcting') return { text: 'Fix applied', fg: 'var(--blue-600)' };
  if (status === 'routed_to_human') return { text: 'With a human', fg: 'var(--ink-500)' };
  return { text: 'Needs review', fg: 'var(--warning-700)' };
}

const truncate: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const headCell: React.CSSProperties = { ...truncate };

export function Interventions({
  onOpen,
  onBrowseCalls,
  search = '',
}: {
  onOpen: (deviationId: string) => void;
  onBrowseCalls?: () => void;
  /** The one search box, in the top bar. This screen no longer has its own. */
  search?: string;
}) {
  const [items, setItems] = useState<DeviationWithEvidence[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [sev, setSev] = useState(SEVERITY_OPTIONS[0]);
  const [root, setRoot] = useState(ROOT_OPTIONS[0]);
  const [status, setStatus] = useState(STATUS_OPTIONS[0]);

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
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  /** Criterion id -> its full text, for the "Failed: …" line. */
  const criterionText = useMemo(() => {
    const seed = (criteriaSeed as { criteria: Array<{ id: string; title: string }> }).criteria;
    return new Map(seed.map((c) => [c.id, c.title]));
  }, []);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (items ?? [])
      .filter((d) => {
        if (sev !== SEVERITY_OPTIONS[0] && d.severity !== sev) return false;
        if (root !== ROOT_OPTIONS[0] && (d.rootCause || 'unknown') !== root) return false;
        if (status !== STATUS_OPTIONS[0] && statusOf(d.status).text !== status) return false;
        if (!needle) return true;
        return [
          d.summary,
          d.criterionId,
          criterionText.get(d.criterionId),
          d.clauseRef,
          d.callerName,
          d.callerPhone,
          d.siteHint,
        ]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle));
      })
      .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  }, [items, search, sev, root, status, criterionText]);

  if (error) {
    return (
      <div style={page('24px 28px')}>
        <LoadError message={error} onRetry={() => setNonce((n) => n + 1)} />
      </div>
    );
  }
  if (!items) return <BootSkeleton label="Loading findings…" />;

  const filtered =
    search.trim() !== '' ||
    sev !== SEVERITY_OPTIONS[0] ||
    root !== ROOT_OPTIONS[0] ||
    status !== STATUS_OPTIONS[0];

  const clearFilters = () => {
    // The search lives in the top bar now, so this clears only what this
    // screen owns — clearing someone's typed query from here would be reaching
    // outside the panel the button sits in.
    setSev(SEVERITY_OPTIONS[0]);
    setRoot(ROOT_OPTIONS[0]);
    setStatus(STATUS_OPTIONS[0]);
  };

  const summary = [
    {
      value: String(items.filter((d) => d.severity === 'critical').length),
      label: 'Critical',
      color: 'var(--danger-500)',
    },
    {
      value: String(items.filter((d) => statusOf(d.status).text === 'Needs review').length),
      label: 'Needs review',
      color: 'var(--warning-700)',
    },
    {
      value: String(items.filter((d) => d.status === 'resolved').length),
      label: 'Resolved',
      color: 'var(--success-700)',
    },
  ];

  const selects = [
    { key: 'sev', label: 'Severity', value: sev, dflt: SEVERITY_OPTIONS[0], options: SEVERITY_OPTIONS, set: setSev },
    { key: 'root', label: 'Root cause', value: root, dflt: ROOT_OPTIONS[0], options: ROOT_OPTIONS, set: setRoot },
    { key: 'status', label: 'Status', value: status, dflt: STATUS_OPTIONS[0], options: STATUS_OPTIONS, set: setStatus },
  ];

  return (
    <div style={page('24px 28px 40px')}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1
            style={{
              fontSize: 24,
              lineHeight: '30px',
              fontWeight: 700,
              margin: 0,
              letterSpacing: '-.01em',
            }}
          >
            Interventions
          </h1>
          <p style={{ margin: '5px 0 0', color: 'var(--ink-600)' }}>
            Calls that broke your scope of work. Distressed callers and hard failures first.
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {summary.map((s) => (
            <div
              key={s.label}
              style={{
                border: '1px solid var(--border-default)',
                background: '#fff',
                borderRadius: 8,
                padding: '8px 14px',
                minWidth: 96,
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 700,
                  fontSize: 20,
                  lineHeight: 1.1,
                  color: s.color,
                }}
              >
                {s.value}
              </div>
              <div style={{ fontSize: 11, color: 'var(--ink-600)', marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* filter bar */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0 0', flexWrap: 'wrap' }}
      >

        {selects.map((s) => {
          const active = s.value !== s.dflt;
          return (
            <select className="hue-field"
              key={s.key}
              value={s.value}
              onChange={(e) => s.set(e.target.value)}
              aria-label={s.label}
              style={{
                height: 36,
                width: 136,
                border: `1px solid ${active ? 'var(--blue-500)' : 'var(--border-default)'}`,
                borderRadius: 6,
                padding: '0 30px 0 10px',
                fontSize: 13,
                backgroundColor: active ? 'var(--blue-025)' : '#fff',
                backgroundImage:
                  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23283648' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\")",
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 10px center',
                appearance: 'none',
                WebkitAppearance: 'none',
                MozAppearance: 'none',
                color: active ? 'var(--blue-600)' : 'var(--ink-700)',
                fontWeight: active ? 600 : 400,
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              {s.options.map((o) => (
                <option key={o} value={o}>
                  {o.startsWith('All') || /[A-Z]/.test(o[0]) ? o : label(o)}
                </option>
              ))}
            </select>
          );
        })}

        {filtered && (
          <button className="hue-btn"
            onClick={clearFilters}
            style={{
              height: 36,
              padding: '0 10px',
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              color: 'var(--blue-500)',
            }}
          >
            Clear filters
          </button>
        )}

        <span
          style={{
            marginLeft: 'auto',
            fontSize: 13,
            color: 'var(--ink-600)',
            whiteSpace: 'nowrap',
          }}
        >
          {rows.length} of {items.length} shown
        </span>
      </div>

      {/* table */}
      <div
        style={{
          background: '#fff',
          border: '1px solid var(--border-default)',
          borderRadius: 8,
          marginTop: 12,
          overflow: 'hidden',
        }}
      >
        <div style={{ overflowX: 'auto' }}>
          <div
            style={{
              display: 'grid',
              minWidth: 880,
              gridTemplateColumns: COLS,
              gap: 14,
              padding: '9px 16px',
              background: 'var(--ink-050)',
              borderBottom: '1px solid var(--border-default)',
              fontSize: 11,
              letterSpacing: '.04em',
              textTransform: 'uppercase',
              color: 'var(--ink-600)',
              fontWeight: 500,
            }}
          >
            <span style={headCell}>Severity</span>
            <span style={headCell}>Deviation</span>
            <span style={headCell}>Clause</span>
            <span style={headCell}>Call</span>
            <span style={headCell}>Root cause</span>
            <span style={headCell}>Status</span>
            <span />
          </div>

          {rows.map((d) => (
            <Row
              key={d.id}
              d={d}
              criterionFull={criterionText.get(d.criterionId) ?? d.criterionId}
              onOpen={() => onOpen(d.id)}
            />
          ))}
        </div>

        {rows.length === 0 && items.length > 0 && (
          <div style={{ padding: '40px 24px', textAlign: 'center' }}>
            <div style={{ fontWeight: 600 }}>Nothing matches these filters</div>
            <p style={{ margin: '6px 0 14px', fontSize: 13, color: 'var(--ink-600)' }}>
              Widen the severity or root cause, or clear the search.
            </p>
            <button className="hue-btn"
              onClick={clearFilters}
              style={{
                height: 38,
                padding: '0 16px',
                borderRadius: 4,
                border: '1px solid var(--border-default)',
                background: '#fff',
                fontWeight: 500,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Clear all filters
            </button>
          </div>
        )}

        {items.length === 0 && (
          <div style={{ padding: '44px 24px', textAlign: 'center' }}>
            <span
              style={{
                width: 44,
                height: 44,
                borderRadius: 999,
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
            <div style={{ fontWeight: 600, marginTop: 12 }}>No deviations to review</div>
            <p
              style={{
                margin: '6px auto 14px',
                fontSize: 13,
                color: 'var(--ink-600)',
                maxWidth: '44ch',
                lineHeight: '20px',
              }}
            >
              Every call was checked against your scope of work and passed. Nothing needs your
              attention.
            </p>
            <button className="hue-btn"
              onClick={() => onBrowseCalls?.()}
              style={{
                height: 38,
                padding: '0 16px',
                borderRadius: 4,
                border: '1px solid var(--border-default)',
                background: '#fff',
                fontWeight: 500,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Browse today's calls
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  d,
  criterionFull,
  onOpen,
}: {
  d: DeviationWithEvidence;
  criterionFull: string;
  onOpen: () => void;
}) {
  const sev = severityTone(d.severity);
  const rc = rootCauseTone(d.rootCause || 'unknown');
  const st = statusOf(d.status);
  // Live call logs carry no caller name, so the number that rang in is the
  // caller's only identity.
  const caller = d.callerName || d.callerPhone || 'Unknown caller';

  return (
    <div
      onClick={onOpen}
      className="hue-row"
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      tabIndex={0}
      style={{
        display: 'grid',
        minWidth: 880,
        gridTemplateColumns: COLS,
        gap: 14,
        alignItems: 'center',
        padding: '12px 16px',
        borderBottom: '1px solid var(--ink-100)',
        cursor: 'pointer',
        background: '#fff',
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '.03em',
          color: sev.fg,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: sev.dot ?? sev.fg,
            flex: '0 0 7px',
          }}
        />
        {d.severity}
      </span>

      <div style={{ minWidth: 0 }}>
        <div title={d.summary} style={{ fontWeight: 500, ...truncate }}>
          {d.summary}
        </div>
        <div
          title={criterionFull}
          style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 2, ...truncate }}
        >
          Failed: {criterionFull}
        </div>
      </div>

      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--blue-600)',
          background: 'var(--blue-025)',
          borderRadius: 999,
          padding: '2px 8px',
          justifySelf: 'start',
        }}
      >
        {d.clauseRef || '—'}
      </span>

      <div style={{ minWidth: 0 }}>
        <div title={caller} style={{ fontSize: 13, ...truncate }}>
          {caller}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-600)', ...truncate }}>
          {d.siteHint || '—'} · {d.startedAt ? clock(d.startedAt) : '—'}
        </div>
      </div>

      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          padding: '2px 8px',
          borderRadius: 999,
          background: rc.bg,
          color: rc.fg,
          justifySelf: 'start',
          textTransform: 'capitalize',
        }}
      >
        {d.rootCause || 'unknown'}
      </span>

      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          fontWeight: 600,
          color: st.fg,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 999, background: st.fg }} />
        {st.text}
      </span>

      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--ink-400)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
    </div>
  );
}
