import { useEffect, useMemo, useState } from 'react';
import seed from '../../evals/criteria.seed.json';
import { api, type DeviationWithEvidence } from '../lib/vibe';
import { BootSkeleton } from './BootSkeleton';
import { WIRED_CRITERIA } from '../lib/criteria';
import { page } from '../lib/layout';

/**
 * Scope of work & evals — the SCOPE & EVALS block of the design
 * ("Helpdesk Governance.dc.html", lines 2345-2542): the coverage meter, the
 * scope-of-work document with its version history, the eval table, and the
 * editing drawer.
 *
 * Two things here are honestly thinner than the design, and both are told
 * plainly rather than dressed up:
 *
 *   - There is no stored scope-of-work DOCUMENT. The criteria were derived from
 *     one, but only the criteria were kept, in a file that ships with the app.
 *     The panel, its editor and its version list are all present; the document
 *     body says what is missing and the editor cannot save, because there is
 *     nowhere to save it to — the app's database role cannot create a table
 *     (see functions/migrate.ts).
 *   - For the same reason the eval set is read-only. Editing, adding, pausing
 *     and removing are all rendered as the design has them, and each says it
 *     needs somewhere to persist before it can do anything.
 *
 * Everything that IS real is real: the criteria and their layer, source and
 * status come from the seed file, and the pass rate is computed from the
 * findings actually recorded against each criterion.
 */

interface SeedCriterion {
  id: string;
  clauseRef: string;
  title: string;
  description: string;
  checkType: string;
  layer: 'deterministic' | 'semantic';
  source: string;
  active: boolean;
}


/** Criterion family -> the design's category vocabulary. */
const CATEGORY: Record<string, string> = {
  LOG: 'Logging & records',
  SCOPE: 'Scope handling',
  ESC: 'Escalation & safety',
  CALL: 'Caller handling',
  SCHED: 'Scheduling',
  CAT: 'Logging & records',
};

const COLS = 'minmax(0,1fr) 150px 130px 96px 110px';

const microLabel: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: 'var(--ink-500)',
  fontWeight: 500,
};

const selectStyle: React.CSSProperties = {
  height: 32,
  border: '1px solid var(--border-default)',
  borderRadius: 6,
  padding: '0 28px 0 8px',
  fontSize: 13,
  backgroundColor: '#fff',
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23283648' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\")",
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 10px center',
  appearance: 'none',
  WebkitAppearance: 'none',
  MozAppearance: 'none',
  color: 'var(--ink-900)',
  cursor: 'pointer',
  outline: 'none',
};

const FILTERS = ['All evals', 'From scope of work', 'Added / imported', 'Paused'];

function familyOf(id: string): string {
  return CATEGORY[id.split('-')[1] ?? ''] ?? 'Added by your team';
}

function sourceOf(c: SeedCriterion): string {
  return c.source === 'ai_drafted' ? 'Scope of work' : 'Added manually';
}

export function ScopeEvals() {
  const criteria = (seed as { criteria: SeedCriterion[] }).criteria;

  const [q, setQ] = useState('');
  const [filter, setFilter] = useState(FILTERS[0]);
  const [editingDoc, setEditingDoc] = useState(false);
  const [draft, setDraft] = useState('');
  const [openEval, setOpenEval] = useState<SeedCriterion | null>(null);
  const [creating, setCreating] = useState(false);

  const [deviations, setDeviations] = useState<DeviationWithEvidence[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [evaluatedCalls, setEvaluatedCalls] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [devs, convos] = await Promise.all([
          api.listDeviations(''),
          api.listConversations(200),
        ]);
        if (cancelled) return;
        setDeviations(devs);
        setEvaluatedCalls(convos.filter((c) => c.evalStatus !== 'not_evaluated').length);
      } catch (err) {
        // The criteria themselves are bundled configuration and still render,
        // so this is a partial failure, not a dead screen: the pass-rate column
        // degrades to "—" and the banner says why rather than leaving a reader
        // to assume every criterion has never failed.
        if (!cancelled) {
          setDeviations([]);
          setEvaluatedCalls(0);
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Failures per criterion, from the findings actually recorded. */
  const failures = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of deviations ?? []) m.set(d.criterionId, (m.get(d.criterionId) ?? 0) + 1);
    return m;
  }, [deviations]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return criteria
      .map((c) => {
        const implemented = WIRED_CRITERIA.has(c.id);
        const fails = failures.get(c.id) ?? 0;
        const rate =
          implemented && evaluatedCalls
            ? Math.round(((evaluatedCalls - fails) / evaluatedCalls) * 100)
            : null;
        return { c, implemented, fails, rate };
      })
      .filter(({ c, implemented }) => {
        if (filter === 'From scope of work' && c.source !== 'ai_drafted') return false;
        if (filter === 'Added / imported' && c.source === 'ai_drafted') return false;
        // "Paused" in this data means a criterion no check runs against — it is
        // configured but inert, which is the same thing from the user's side.
        if (filter === 'Paused' && (c.active && implemented)) return false;
        if (!needle) return true;
        return [c.id, c.title, c.description, c.clauseRef, familyOf(c.id)]
          .join(' ')
          .toLowerCase()
          .includes(needle);
      });
  }, [criteria, q, filter, failures, evaluatedCalls]);

  const wired = criteria.filter((c) => WIRED_CRITERIA.has(c.id)).length;
  const coverage = criteria.length ? Math.round((wired / criteria.length) * 100) : 0;
  const det = criteria.filter((c) => c.layer === 'deterministic').length;

  if (deviations === null) return <BootSkeleton label="Loading evals…" />;

  return (
    <div style={page('28px 32px 40px')}>
      {loadError && (
        <div
          style={{
            background: 'var(--warning-050)',
            border: '1px solid var(--warning-500)',
            borderRadius: 6,
            padding: '10px 14px',
            marginBottom: 16,
            fontSize: 13,
            color: 'var(--warning-700)',
            lineHeight: '19px',
          }}
        >
          Findings could not be loaded, so pass rates show “—”. The criteria below are still
          accurate — they ship with the app. {loadError}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <h1
            style={{
              fontSize: 26,
              lineHeight: '32px',
              fontWeight: 700,
              margin: 0,
              letterSpacing: '-.01em',
            }}
          >
            Scope of work &amp; evals
          </h1>
          <p style={{ margin: '6px 0 0', color: 'var(--ink-600)', textWrap: 'pretty' }}>
            The contract your helpdesk agent answers to. Every call is scored against the evals
            drafted from it.
          </p>
        </div>

        {/* coverage */}
        <div
          style={{
            background: '#fff',
            border: '1px solid var(--border-default)',
            borderRadius: 8,
            padding: '12px 16px',
            minWidth: 260,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={microLabel}>Coverage</span>
            <span
              style={{
                fontWeight: 600,
                color:
                  coverage >= 85
                    ? 'var(--success-700)'
                    : coverage >= 50
                      ? 'var(--warning-700)'
                      : 'var(--danger-500)',
              }}
            >
              {coverage}%
            </span>
          </div>
          <div
            style={{
              height: 6,
              borderRadius: 999,
              background: 'var(--ink-200)',
              marginTop: 8,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${coverage}%`,
                background:
                  coverage >= 85
                    ? 'var(--success-500)'
                    : coverage >= 50
                      ? 'var(--warning-500)'
                      : 'var(--danger-500)',
              }}
            />
          </div>
          {/* The design shows a flat 100%. This is the real figure: how many of
              the written criteria something actually checks. */}
          <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 6 }}>
            {wired} of {criteria.length} criteria have a check behind them
          </div>
        </div>
      </div>

      {/* ---- scope of work document ---- */}
      <div
        style={{
          background: '#fff',
          border: '1px solid var(--border-default)',
          borderRadius: 8,
          marginTop: 20,
        }}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 220, display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              style={{
                width: 34,
                height: 34,
                flex: '0 0 34px',
                borderRadius: 8,
                background: 'var(--blue-025)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--blue-500)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            </span>
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Scope of work</h3>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  color: 'var(--ink-500)',
                  marginTop: 3,
                  flexWrap: 'wrap',
                }}
              >
                <span>Not stored in Hue</span>
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--ink-500)',
                  }}
                >
                  <span
                    style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--ink-400)' }}
                  />
                  {criteria.length} evals derived
                </span>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--ink-600)' }}>Version</span>
            <select disabled value="—" style={{ ...selectStyle, height: 34, width: 112, cursor: 'not-allowed', color: 'var(--ink-400)' }}>
              <option value="—">—</option>
            </select>
            <button
              onClick={() => {
                setEditingDoc(true);
                setDraft('');
              }}
              style={{
                height: 34,
                padding: '0 14px',
                borderRadius: 4,
                border: '1px solid var(--blue-500)',
                background: 'var(--blue-500)',
                color: '#fff',
                fontWeight: 500,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Edit document
            </button>
          </div>
        </div>

        {editingDoc ? (
          <div style={{ padding: '18px 20px 20px' }}>
            <div style={{ fontSize: 12, color: 'var(--ink-600)', lineHeight: '18px', marginBottom: 10 }}>
              Paste the scope of work exactly as written in your helpdesk contract. Plain paragraphs
              are fine — eval criteria are drafted from the text on save.
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Paste the scope of work paragraph here…"
              style={{
                width: '100%',
                minHeight: 300,
                resize: 'vertical',
                border: '1px solid var(--border-default)',
                borderRadius: 6,
                padding: '14px 16px',
                fontFamily: 'var(--font-sans)',
                fontSize: 14,
                lineHeight: '23px',
                color: 'var(--ink-900)',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
              <button
                disabled
                title="There is nowhere to store the document yet"
                style={{
                  height: 36,
                  padding: '0 16px',
                  borderRadius: 4,
                  border: '1px solid var(--border-default)',
                  background: 'var(--ink-100)',
                  color: 'var(--ink-400)',
                  fontWeight: 500,
                  fontSize: 13,
                  cursor: 'not-allowed',
                }}
              >
                Save
              </button>
              <button
                onClick={() => {
                  setEditingDoc(false);
                  setDraft('');
                }}
                style={{
                  height: 36,
                  padding: '0 14px',
                  borderRadius: 4,
                  border: '1px solid var(--border-default)',
                  background: '#fff',
                  fontWeight: 500,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <span style={{ fontSize: 12, color: 'var(--ink-500)' }}>
                {draft.trim() ? draft.trim().split(/\s+/).length : 0} words · saving needs a table
                Hue cannot create yet
              </span>
            </div>
          </div>
        ) : (
          <div
            style={{
              padding: '20px 20px 22px',
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) 232px',
              gap: 24,
            }}
          >
            <div
              style={{
                fontSize: 14,
                lineHeight: '24px',
                color: 'var(--ink-600)',
                maxWidth: '76ch',
                textWrap: 'pretty',
              }}
            >
              <p style={{ margin: 0 }}>
                No scope-of-work document is stored in Hue. The {criteria.length} evals below were
                derived from one and are what every call is actually graded against — but the source
                text itself was never kept, so there is nothing to show here or to diff a new version
                against.
              </p>
              <p style={{ margin: '12px 0 0' }}>
                Paste the contract with <b style={{ color: 'var(--ink-900)', fontWeight: 500 }}>Edit
                document</b> to see it here. Storing it needs a table the app's database role cannot
                create today, so the editor will not save until that is granted.
              </p>
            </div>
            <div style={{ borderLeft: '1px solid var(--ink-100)', paddingLeft: 20 }}>
              <div style={microLabel}>Version history</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 10 }}>
                <div
                  style={{
                    padding: '9px 10px',
                    borderRadius: 6,
                    background: 'var(--blue-025)',
                    borderLeft: '2px solid var(--blue-500)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--blue-600)',
                        fontWeight: 600,
                      }}
                    >
                      seed
                    </span>
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '.03em',
                        textTransform: 'uppercase',
                        color: 'var(--success-700)',
                      }}
                    >
                      Current
                    </span>
                  </div>
                  <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--ink-700)', marginTop: 3 }}>
                    {criteria.length} criteria seeded — {det} deterministic, {criteria.length - det}{' '}
                    semantic.
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--ink-500)', marginTop: 3 }}>
                    evals/criteria.seed.json · ships with the app
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-500)', padding: '9px 10px', lineHeight: '16px' }}>
                  No earlier versions. History begins when a document can be saved.
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ---- eval set ---- */}
      <div
        style={{
          background: '#fff',
          border: '1px solid var(--border-default)',
          borderRadius: 8,
          marginTop: 16,
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200, display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              style={{
                width: 34,
                height: 34,
                flex: '0 0 34px',
                borderRadius: 8,
                background: 'var(--brand-indigo-050)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--brand-indigo)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            </span>
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Evals</h3>
              <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 2 }}>
                AI-drafted from your SOW · {wired} wired to a check, {criteria.length - wired} not yet
              </div>
            </div>
          </div>
          <div style={{ position: 'relative' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-500)" strokeWidth="2" strokeLinecap="round" style={{ position: 'absolute', left: 10, top: 9 }}>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
              style={{
                width: 180,
                height: 32,
                border: '1px solid var(--border-default)',
                borderRadius: 6,
                padding: '0 10px 0 30px',
                fontSize: 13,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ ...selectStyle, width: 150 }}>
            {FILTERS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <button
            disabled
            title="Importing needs somewhere to store criteria"
            style={{
              height: 32,
              padding: '0 12px',
              borderRadius: 6,
              border: '1px solid var(--border-default)',
              background: '#fff',
              color: 'var(--ink-400)',
              fontWeight: 500,
              fontSize: 13,
              cursor: 'not-allowed',
              whiteSpace: 'nowrap',
            }}
          >
            Import
          </button>
          <button
            onClick={() => {
              setCreating(true);
              setOpenEval(null);
            }}
            style={{
              height: 32,
              padding: '0 12px',
              borderRadius: 6,
              border: '1px solid var(--blue-500)',
              background: 'var(--blue-500)',
              color: '#fff',
              fontWeight: 500,
              fontSize: 13,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            + New eval
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: COLS,
            padding: '8px 20px',
            borderTop: '1px solid var(--border-default)',
            borderBottom: '1px solid var(--border-default)',
            background: '#FAFBFD',
            fontSize: 11,
            letterSpacing: '.05em',
            textTransform: 'uppercase',
            color: 'var(--ink-500)',
            fontWeight: 500,
          }}
        >
          <span>Eval</span>
          <span>Category</span>
          <span>Source</span>
          <span>Status</span>
          <span style={{ textAlign: 'right' }}>Pass rate · 30d</span>
        </div>

        <div style={{ maxHeight: '56vh', overflow: 'auto' }}>
          {rows.map(({ c, implemented, rate }) => (
            <EvalRow
              key={c.id}
              c={c}
              implemented={implemented}
              rate={rate}
              onOpen={() => {
                setOpenEval(c);
                setCreating(false);
              }}
            />
          ))}
          {rows.length === 0 && (
            <div style={{ padding: '28px 20px', textAlign: 'center', fontSize: 13, color: 'var(--ink-500)' }}>
              No evals match.
            </div>
          )}
        </div>
        <div
          style={{
            padding: '9px 20px',
            fontSize: 12,
            color: 'var(--ink-500)',
            borderTop: '1px solid var(--border-default)',
          }}
        >
          Showing {rows.length} of {criteria.length} evals
        </div>
      </div>

      {(openEval || creating) && (
        <EvalDrawer
          c={openEval}
          creating={creating}
          fails={openEval ? (failures.get(openEval.id) ?? 0) : 0}
          evaluatedCalls={evaluatedCalls ?? 0}
          implemented={openEval ? WIRED_CRITERIA.has(openEval.id) : false}
          onClose={() => {
            setOpenEval(null);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function EvalRow({
  c,
  implemented,
  rate,
  onOpen,
}: {
  c: SeedCriterion;
  implemented: boolean;
  rate: number | null;
  onOpen: () => void;
}) {
  const [hover, setHover] = useState(false);
  // "Active" in the seed means configured; a criterion nothing checks is inert
  // whatever the flag says, and the table shows that rather than the flag.
  const status = !c.active
    ? { text: 'Paused', fg: 'var(--ink-500)', dot: 'var(--ink-400)' }
    : implemented
      ? { text: 'Active', fg: 'var(--success-700)', dot: 'var(--success-500)' }
      : { text: 'Not wired', fg: 'var(--warning-700)', dot: 'var(--warning-500)' };

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: COLS,
        alignItems: 'center',
        padding: '0 20px',
        height: 46,
        borderBottom: '1px solid var(--ink-100)',
        cursor: 'pointer',
        background: hover ? 'var(--blue-025)' : '#fff',
      }}
    >
      <span
        title={c.title}
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--ink-900)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          paddingRight: 16,
        }}
      >
        {c.title}
      </span>
      <span style={{ fontSize: 12, color: 'var(--ink-600)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {familyOf(c.id)}
      </span>
      <span style={{ fontSize: 12, color: 'var(--ink-600)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {sourceOf(c)}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, color: status.fg }}>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: status.dot }} />
        {status.text}
      </span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color:
            rate === null
              ? 'var(--ink-400)'
              : rate >= 90
                ? 'var(--success-700)'
                : rate >= 70
                  ? 'var(--warning-700)'
                  : 'var(--danger-500)',
          textAlign: 'right',
        }}
      >
        {rate === null ? '—' : `${rate}%`}
      </span>
    </div>
  );
}

/** The design's right-hand editing drawer. */
function EvalDrawer({
  c,
  creating,
  fails,
  evaluatedCalls,
  implemented,
  onClose,
}: {
  c: SeedCriterion | null;
  creating: boolean;
  fails: number;
  evaluatedCalls: number;
  implemented: boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState(c?.title ?? '');
  const rate = implemented && evaluatedCalls ? Math.round(((evaluatedCalls - fails) / evaluatedCalls) * 100) : null;
  const active = c?.active ?? true;

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(40,54,72,0.32)', zIndex: 55 }}
      />
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 440,
          maxWidth: '92vw',
          background: '#fff',
          zIndex: 56,
          boxShadow: '-16px 0 48px rgba(40,54,72,0.18)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            padding: '18px 22px',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span style={microLabel}>{creating ? 'New eval' : `Eval · ${c?.id}`}</span>
          <span
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              width: 28,
              height: 28,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--ink-600)',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </span>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px' }}>
          <div style={{ ...microLabel, marginBottom: 6 }}>Criterion</div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Describe the rule in plain English, e.g. “Always confirm the caller's mobile number”"
            style={{
              width: '100%',
              minHeight: 88,
              resize: 'vertical',
              border: '1px solid var(--border-default)',
              borderRadius: 6,
              padding: '10px 12px',
              fontFamily: 'var(--font-sans)',
              fontSize: 13,
              lineHeight: '20px',
              color: 'var(--ink-900)',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          {c && (
            <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--ink-600)', lineHeight: '18px' }}>
              {c.description}
            </p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 18 }}>
            <div>
              <div style={{ ...microLabel, marginBottom: 6 }}>Category</div>
              <select
                defaultValue={c ? familyOf(c.id) : 'Added by your team'}
                style={{ ...selectStyle, width: '100%', height: 34 }}
              >
                {Array.from(new Set([...Object.values(CATEGORY), 'Added by your team'])).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div style={{ ...microLabel, marginBottom: 6 }}>Status</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34 }}>
                <span
                  style={{
                    width: 34,
                    height: 20,
                    borderRadius: 999,
                    background: active ? 'var(--success-500)' : 'var(--ink-200)',
                    position: 'relative',
                    display: 'inline-block',
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      top: 2,
                      left: active ? 16 : 2,
                      width: 16,
                      height: 16,
                      borderRadius: 999,
                      background: '#fff',
                    }}
                  />
                </span>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: active ? 'var(--success-700)' : 'var(--ink-500)',
                  }}
                >
                  {active ? 'Active' : 'Paused'}
                </span>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 22, border: '1px solid var(--border-default)', borderRadius: 8, padding: '16px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 34,
                  fontWeight: 700,
                  lineHeight: 1,
                  color:
                    rate === null
                      ? 'var(--ink-400)'
                      : rate >= 90
                        ? 'var(--success-700)'
                        : rate >= 70
                          ? 'var(--warning-700)'
                          : 'var(--danger-500)',
                }}
              >
                {rate === null ? '—' : `${rate}%`}
              </span>
              <span style={{ fontSize: 12, color: 'var(--ink-500)' }}>pass rate · all stored calls</span>
            </div>
            <div style={{ height: 6, borderRadius: 999, background: 'var(--ink-100)', marginTop: 12, overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${rate ?? 0}%`,
                  background: rate === null ? 'transparent' : 'var(--success-500)',
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 10 }}>
              {rate === null
                ? 'No check runs against this criterion yet, so it has no pass rate.'
                : `Failed on ${fails} of ${evaluatedCalls} evaluated ${evaluatedCalls === 1 ? 'call' : 'calls'}.`}
            </div>
          </div>

          <div style={{ marginTop: 18, fontSize: 12, color: 'var(--ink-500)', lineHeight: '19px' }}>
            {c
              ? `${c.id} · clause ${c.clauseRef} · ${c.layer} · ${c.checkType} · ${sourceOf(c)}`
              : 'A new eval needs somewhere to be stored before it can grade anything.'}
          </div>
        </div>

        <div
          style={{
            padding: '14px 22px',
            borderTop: '1px solid var(--border-default)',
            display: 'flex',
            gap: 8,
            alignItems: 'center',
          }}
        >
          {creating ? (
            <>
              <button
                disabled
                title="Criteria ship in a bundled file — there is no table to add one to"
                style={{
                  height: 36,
                  padding: '0 16px',
                  borderRadius: 6,
                  border: '1px solid var(--border-default)',
                  background: 'var(--ink-100)',
                  color: 'var(--ink-400)',
                  fontWeight: 500,
                  fontSize: 13,
                  cursor: 'not-allowed',
                }}
              >
                Add eval
              </button>
              <button onClick={onClose} style={drawerBtn}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose} style={drawerBtn}>
                Done
              </button>
              <span style={{ fontSize: 12, color: 'var(--ink-500)' }}>
                Read-only — criteria ship in evals/criteria.seed.json
              </span>
              <span
                title="Removing needs a criteria table"
                style={{
                  marginLeft: 'auto',
                  fontSize: 13,
                  fontWeight: 500,
                  color: 'var(--ink-400)',
                  cursor: 'not-allowed',
                }}
              >
                Remove
              </span>
            </>
          )}
        </div>
      </div>
    </>
  );
}

const drawerBtn: React.CSSProperties = {
  height: 36,
  padding: '0 16px',
  borderRadius: 6,
  border: '1px solid var(--border-default)',
  background: '#fff',
  fontWeight: 500,
  fontSize: 13,
  cursor: 'pointer',
};
