import { useEffect, useMemo, useState } from 'react';
import seed from '../../evals/criteria.seed.json';
import { api, type DeviationWithEvidence } from '../lib/vibe';
import { generateEvals } from '../lib/judges';
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

/** One eval in the single list, whatever produced it. */
interface UnifiedEval {
  id: string;
  origin: 'seeded' | 'sow' | 'custom';
  title: string;
  clauseRef: string;
  description: string;
  passDefinition: string;
  failDefinition: string;
  sourceExcerpt: string;
  layer: string;
  severity: string;
  modality: string;
  /** Something actually checks it. A card that is not wired never shows a rate. */
  wired: boolean;
  fails: number;
  rate: number | null;
}

const FILTERS = ['All evals', 'From scope of work', 'Added / imported', 'Seeded', 'Not wired'];



export function ScopeEvals() {
  const criteria = (seed as { criteria: SeedCriterion[] }).criteria;

  const [q, setQ] = useState('');
  const [filter, setFilter] = useState(FILTERS[0]);
  const [editingDoc, setEditingDoc] = useState(false);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [savingEval, setSavingEval] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);

  /**
   * Save a hand-written eval.
   *
   * It lands beside the generated ones and grades like them. The server marks
   * it manual, which is what keeps a regeneration from sweeping it away and an
   * edit to the scope of work from unbinding it — a criterion somebody wrote
   * themselves should not disappear because the contract was reworded.
   */
  async function saveEval(form: {
    title: string; description: string;
    passDefinition: string; failDefinition: string;
    severity: string; layer: string; modality: string;
  }) {
    setEvalError(null);
    setSavingEval(true);
    try {
      await api.saveCustomEval({ ...form, savedBy: 'this session' });
      setCreating(false);
      const current = await api.currentSow();
      setSow(current);
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEval(false);
    }
  }

  // The real scope of work, and the evals written from it. Pasted for now; the
  // fetch from agent 6208 is one function away — see fetchSowFromAgent.
  const [sow, setSow] = useState<Awaited<ReturnType<typeof api.currentSow>> | null>(null);
  const [versions, setVersions] = useState<Awaited<ReturnType<typeof api.sowVersions>>['items']>([]);
  const [sowBusy, setSowBusy] = useState<string | null>(null);
  const [sowNote, setSowNote] = useState<string | null>(null);
  const [sowError, setSowError] = useState<string | null>(null);

  const [deviations, setDeviations] = useState<DeviationWithEvidence[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [evaluatedCalls, setEvaluatedCalls] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [devs, convos, current, vers] = await Promise.all([
          api.listDeviations(''),
          api.listConversations(200),
          api.currentSow().catch(() => null),
          api.sowVersions().catch(() => ({ items: [] })),
        ]);
        if (cancelled) return;
        setDeviations(devs);
        setEvaluatedCalls(convos.filter((c) => c.evalStatus !== 'not_evaluated').length);
        if (current) {
          setSow(current);
          setDraft(current.sow?.body ?? '');
        }
        setVersions(vers.items);
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


  /**
   * Save the pasted scope of work, then write evals from it when it is new.
   *
   * Saving and generating are one action on purpose: a stored SOW with no
   * criteria grades nothing, and leaving that state reachable by a misclick is
   * how a screen ends up quietly measuring against an empty list.
   */
  async function saveAndGenerate(force = false) {
    setSowError(null);
    setSowNote(null);
    try {
      setSowBusy('Saving the scope of work…');
      const saved = await api.saveSow({
        body: draft,
        title: sow?.sow?.title || 'Scope of work',
        savedBy: 'this session',
      });

      // Unchanged text with criteria already written is a no-op, not a reason
      // to spend a model call rewriting the same list.
      if (!saved.changed && !saved.needsGeneration && !force) {
        setSowBusy(null);
        setSowNote('Unchanged — the saved evals already match this scope of work.');
        return;
      }

      setSowBusy(
        saved.changed
          ? 'The scope of work changed — rewriting the evals…'
          : 'Writing evals from the scope of work…',
      );
      const res = await generateEvals({
        fingerprint: saved.fingerprint,
        title: sow?.sow?.title || 'Scope of work',
        body: draft,
      });

      const parts = [`${res.saved} evals saved`];
      if (res.retired) parts.push(`${res.retired} retired`);
      // Never silent. A criterion the server refused is one this screen would
      // otherwise imply is grading calls.
      if (res.rejected.length) parts.push(`${res.rejected.length} rejected`);
      setSowNote(parts.join(' · '));

      const current = await api.currentSow();
      setSow(current);
      setDraft(current.sow?.body ?? draft);
      setVersions((await api.sowVersions().catch(() => ({ items: [] }))).items);
    } catch (err) {
      setSowError(err instanceof Error ? err.message : String(err));
    } finally {
      setSowBusy(null);
    }
  }

  const sowDirty = Boolean(draft.trim()) && draft.trim() !== (sow?.sow?.body ?? '').trim();
  const generated = sow?.evals ?? [];
  const runnableCount = generated.filter((e) => e.active && e.runnable).length;

  /** Failures per criterion, from the findings actually recorded. */
  const failures = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of deviations ?? []) m.set(d.criterionId, (m.get(d.criterionId) ?? 0) + 1);
    return m;
  }, [deviations]);


  /**
   * Every eval, from every source, in one shape.
   *
   * The two lists this screen used to stack answered the same question in two
   * formats. Merging them means picking a shape that fits all three sources and
   * letting each fill only what it really has — a seeded criterion has a
   * description rather than a pass/fail split, and saying so beats printing an
   * empty "Passes" row as though the definition were missing.
   */
  const allEvals = useMemo(() => {
    const rate = (id: string, wired: boolean) => {
      const fails = failures.get(id) ?? 0;
      return {
        fails,
        rate: wired && evaluatedCalls ? Math.round(((evaluatedCalls - fails) / evaluatedCalls) * 100) : null,
      };
    };

    const seeded = criteria.map((c) => {
      const wired = WIRED_CRITERIA.has(c.id);
      return {
        id: c.id,
        origin: 'seeded' as const,
        title: c.title,
        clauseRef: c.clauseRef,
        description: c.description,
        passDefinition: '',
        failDefinition: '',
        sourceExcerpt: '',
        layer: c.layer,
        severity: '',
        modality: 'any',
        wired,
        ...rate(c.id, wired),
      };
    });

    const written = (sow?.evals ?? [])
      .filter((e) => e.active)
      .map((e) => ({
        id: e.criterionId,
        origin: (e.generatedBy === 'manual' ? 'custom' : 'sow') as 'custom' | 'sow',
        title: e.title,
        clauseRef: e.clauseRef,
        description: e.description,
        passDefinition: e.passDefinition,
        failDefinition: e.failDefinition,
        sourceExcerpt: e.sourceExcerpt,
        layer: e.layer,
        severity: e.severity,
        modality: e.modality,
        // Only a semantic eval reaches a judge; a deterministic one has no code
        // behind it and is never reported as a criterion a call passed.
        wired: e.runnable,
        ...rate(e.criterionId, e.runnable),
      }));

    return [...written, ...seeded];
  }, [criteria, sow, failures, evaluatedCalls]);

  const evalRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return allEvals.filter((e) => {
      if (filter === 'From scope of work' && e.origin !== 'sow') return false;
      if (filter === 'Added / imported' && e.origin !== 'custom') return false;
      if (filter === 'Seeded' && e.origin !== 'seeded') return false;
      if (filter === 'Not wired' && e.wired) return false;
      if (!needle) return true;
      return [e.id, e.title, e.description, e.clauseRef, e.passDefinition, e.failDefinition]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [allEvals, q, filter]);


  const wired = criteria.filter((c) => WIRED_CRITERIA.has(c.id)).length;
  const coverage = criteria.length ? Math.round((wired / criteria.length) * 100) : 0;

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
            <select className="hue-field" disabled value="—" style={{ ...selectStyle, height: 34, width: 112, cursor: 'not-allowed', color: 'var(--ink-400)' }}>
              <option value="—">—</option>
            </select>
            <button className="hue-btn"
              onClick={() => {
                setEditingDoc(true);
                // Opens on what is stored, so editing is editing rather than
                // retyping — and so the diff that drives regeneration is real.
                setDraft(sow?.sow?.body ?? '');
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
            <textarea className="hue-field"
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
              <button className="hue-btn"
                onClick={() => saveAndGenerate()}
                disabled={Boolean(sowBusy) || draft.trim().length < 40}
                aria-busy={Boolean(sowBusy)}
                title={
                  draft.trim().length < 40
                    ? 'Paste the scope of work first'
                    : 'Store this scope of work and write evals from it'
                }
                style={{
                  height: 36,
                  padding: '0 16px',
                  borderRadius: 4,
                  border: `1px solid ${sowBusy || draft.trim().length < 40 ? 'var(--border-default)' : 'var(--blue-500)'}`,
                  background:
                    sowBusy || draft.trim().length < 40 ? 'var(--ink-100)' : 'var(--blue-500)',
                  color: sowBusy || draft.trim().length < 40 ? 'var(--ink-400)' : '#fff',
                  fontWeight: 500,
                  fontSize: 13,
                  cursor: sowBusy ? 'progress' : draft.trim().length < 40 ? 'not-allowed' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {sowBusy ? <span className="hue-spinner" aria-hidden="true" /> : null}
                {sowBusy ? 'Working…' : sowDirty ? 'Save and write evals' : 'Save'}
              </button>
              <button className="hue-btn"
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
                {draft.trim() ? draft.trim().split(/\s+/).length : 0} words
                {sowBusy ? ` · ${sowBusy}` : ''}
                {!sowBusy && sowNote ? ` · ${sowNote}` : ''}
              </span>
              {sowError ? (
                <span style={{ fontSize: 12, color: 'var(--danger-700)' }}>{sowError}</span>
              ) : null}
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
              {sow?.sow ? (
                <>
                  {/* The stored text, verbatim. This is what the evals below
                      were written from and what a new paste is diffed against. */}
                  <pre
                    style={{
                      margin: 0,
                      whiteSpace: 'pre-wrap',
                      fontFamily: 'var(--font-sans)',
                      fontSize: 14,
                      lineHeight: '24px',
                      color: 'var(--ink-900)',
                    }}
                  >
                    {sow.sow.body}
                  </pre>
                  <p style={{ margin: '14px 0 0', fontSize: 12, color: 'var(--ink-500)' }}>
                    {sow.sow.source === 'manual' ? 'Pasted' : `Fetched from ${sow.sow.sourceRef}`} ·{' '}
                    {generated.filter((e) => e.active).length} evals written from it,{' '}
                    {runnableCount} of them gradeable
                    {generated.filter((e) => e.active && !e.runnable).length
                      ? ` · ${generated.filter((e) => e.active && !e.runnable).length} need code and are not graded`
                      : ''}
                  </p>
                  {/* The seam, stated rather than hidden. */}
                  {!sow.upstreamReadable ? (
                    <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--ink-500)' }}>
                      The helpdesk agent's own prompt is not readable through any connection yet, so
                      this is pasted rather than pulled. See docs/platform-ask-agent-scope.md.
                    </p>
                  ) : null}
                  {sow.upstreamDrifted ? (
                    <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--warning-700)' }}>
                      The agent's configured scope has changed upstream. Re-save to rewrite the evals.
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <p style={{ margin: 0 }}>
                    No scope of work is stored yet. The {criteria.length} seeded evals below still
                    grade every call — they ship with the app — but nothing here was written from
                    your actual contract.
                  </p>
                  <p style={{ margin: '12px 0 0' }}>
                    Paste it with <b style={{ color: 'var(--ink-900)', fontWeight: 500 }}>Edit
                    document</b>. Hue stores it, writes evals from it, and grades every conversation
                    against those alongside the seeded ones.
                  </p>
                </>
              )}
            </div>
            <div style={{ borderLeft: '1px solid var(--ink-100)', paddingLeft: 20 }}>
              <div style={microLabel}>Version history</div>
              {/* Read from sow_documents. This panel used to be hardcoded — a
                  fake "seed" entry marked Current and "No earlier versions" —
                  written when there was no table to keep versions in. There is,
                  and it had five of them by the time anyone looked. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 10 }}>
                {versions.map((v) => (
                  <div
                    key={v.id}
                    style={{
                      padding: '9px 10px',
                      borderRadius: 6,
                      background: v.isCurrent ? 'var(--blue-025)' : 'transparent',
                      borderLeft: `2px solid ${v.isCurrent ? 'var(--blue-500)' : 'var(--ink-100)'}`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 12,
                          color: v.isCurrent ? 'var(--blue-600)' : 'var(--ink-600)',
                          fontWeight: 600,
                        }}
                        title={v.fingerprint}
                      >
                        {v.fingerprint.slice(0, 10)}
                      </span>
                      {v.isCurrent && (
                        <span
                          style={{
                            marginLeft: 'auto', fontSize: 10, fontWeight: 600,
                            letterSpacing: '.03em', textTransform: 'uppercase',
                            color: 'var(--success-700)',
                          }}
                        >
                          Current
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--ink-700)', marginTop: 3 }}>
                      {v.chars} characters · {v.evalCount} eval{v.evalCount === 1 ? '' : 's'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--ink-500)', marginTop: 3 }}>
                      {/* Where a version came from, because "approved fix" and
                          "pasted" are different events and the difference is
                          the whole audit trail. */}
                      {v.sourceRef.startsWith('correction:')
                        ? `From an approved fix · ${v.sourceRef.slice('correction:'.length)}`
                        : `Pasted by ${v.savedBy || 'someone'}`}
                    </div>
                  </div>
                ))}
                {versions.length === 0 && (
                  <div style={{ fontSize: 11, color: 'var(--ink-500)', padding: '9px 10px', lineHeight: '16px' }}>
                    No scope of work stored yet. The first paste becomes version one.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>


      {/* ---- evals: ONE list, every source ----
           Seeded criteria and evals written from the scope of work used to sit
           in two stacked sections with different shapes, which made the same
           question ("what is this call graded against?") have two answers. One
           card, and each source shows what it actually has rather than an
           invented field. */}
      <div
        style={{
          background: '#fff',
          border: '1px solid var(--border-default)',
          borderRadius: 8,
          marginTop: 16,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Evals</h3>
            <div style={{ fontSize: 12, color: 'var(--ink-500)', marginTop: 2 }}>
              {allEvals.length} in force · {allEvals.filter((e) => e.wired).length} with a check
              behind them · every call is graded against these
            </div>
          </div>

          <div style={{ position: 'relative' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-500)" strokeWidth="2" strokeLinecap="round" style={{ position: 'absolute', left: 10, top: 9 }}>
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              className="hue-field"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
              style={{
                width: 180, height: 32, border: '1px solid var(--border-default)',
                borderRadius: 6, padding: '0 10px 0 30px', fontSize: 13, outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          <select
            className="hue-field"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ ...selectStyle, height: 32, width: 168 }}
          >
            {FILTERS.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>

          <button
            className="hue-btn"
            onClick={() => setCreating((v) => !v)}
            aria-expanded={creating}
            style={{
              height: 32, padding: '0 14px', borderRadius: 6,
              border: '1px solid var(--blue-500)',
              background: creating ? '#fff' : 'var(--blue-500)',
              color: creating ? 'var(--blue-600)' : '#fff',
              fontWeight: 500, fontSize: 13, cursor: 'pointer',
            }}
          >
            {creating ? 'Cancel' : '+ New eval'}
          </button>
        </div>

        {/* Directly under the button that opens it. Mounted after the list,
            this sat ~2,200px below the fold with 23 evals on screen — the form
            opened and nothing appeared to happen, which is indistinguishable
            from a broken button. */}
        {creating && (
          <NewEval
            busy={savingEval}
            error={evalError}
            onCancel={() => {
              setCreating(false);
              setEvalError(null);
            }}
            onSave={saveEval}
          />
        )}

        {evalRows.map((e) => (
          <EvalCard key={e.id} e={e} />
        ))}

        {evalRows.length === 0 && (
          <div style={{ padding: '28px 20px', textAlign: 'center', fontSize: 13, color: 'var(--ink-500)' }}>
            No evals match.
          </div>
        )}

        <div
          style={{
            padding: '9px 20px',
            fontSize: 12,
            color: 'var(--ink-500)',
            borderTop: '1px solid var(--border-default)',
          }}
        >
          Showing {evalRows.length} of {allEvals.length} evals
        </div>
      </div>


    </div>
  );
}

/**
 * One eval, whatever produced it.
 *
 * Each source fills only what it has: an eval written from the scope of work
 * carries a pass/fail bar and the sentence it came from, a hand-written one
 * carries the bar, and a seeded one carries its description. Printing an empty
 * "Passes" row on a seeded criterion would read as a missing definition rather
 * than a different kind of criterion.
 */
function EvalCard({ e }: { e: UnifiedEval }) {
  const originTone =
    e.origin === 'sow'
      ? { bg: 'var(--brand-indigo-050)', fg: 'var(--brand-indigo)', label: 'Scope of work' }
      : e.origin === 'custom'
        ? { bg: 'var(--blue-025)', fg: 'var(--blue-600)', label: 'Custom' }
        : { bg: 'var(--ink-050)', fg: 'var(--ink-600)', label: 'Seeded' };

  return (
    <div
      style={{
        padding: '13px 20px',
        borderBottom: '1px solid var(--ink-100)',
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--ink-500)',
          flex: '0 0 132px',
          paddingTop: 2,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={e.id}
      >
        {e.id}
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{e.title}</span>
          <span
            style={{
              fontSize: 10, fontWeight: 600, letterSpacing: '.03em', textTransform: 'uppercase',
              padding: '1px 7px', borderRadius: 4, background: originTone.bg, color: originTone.fg,
            }}
          >
            {originTone.label}
          </span>
        </div>

        {e.passDefinition ? (
          <>
            <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 4, lineHeight: '18px' }}>
              <b style={{ fontWeight: 600, color: 'var(--success-700)' }}>Passes</b> {e.passDefinition}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 2, lineHeight: '18px' }}>
              <b style={{ fontWeight: 600, color: 'var(--danger-700)' }}>Fails</b> {e.failDefinition}
            </div>
          </>
        ) : e.description ? (
          <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 4, lineHeight: '18px' }}>
            {e.description}
          </div>
        ) : null}

        {e.sourceExcerpt ? (
          <div
            style={{
              fontSize: 11, color: 'var(--ink-500)', marginTop: 6, paddingLeft: 9,
              borderLeft: '2px solid var(--ink-100)', lineHeight: '17px',
            }}
          >
            {e.sourceExcerpt}
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flex: '0 0 auto' }}>
        <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>
          {e.clauseRef}
          {e.severity ? ` · ${e.severity}` : ''}
          {e.modality && e.modality !== 'any' ? ` · ${e.modality} only` : ''}
        </span>
        <span
          style={{
            fontSize: 10, fontWeight: 600, letterSpacing: '.03em', textTransform: 'uppercase',
            padding: '1px 7px', borderRadius: 4, whiteSpace: 'nowrap',
            background: e.wired ? 'var(--success-050)' : 'var(--ink-050)',
            color: e.wired ? 'var(--success-700)' : 'var(--ink-600)',
          }}
        >
          {e.wired ? 'Active' : 'Not wired'}
        </span>
        {/* Carried from the table this replaced: a criterion nothing checks has
            no pass rate, and "—" says that rather than implying 100%. */}
        <span style={{ fontSize: 11, color: 'var(--ink-500)', fontVariantNumeric: 'tabular-nums' }}>
          {e.rate === null ? '—' : `${e.rate}% pass`}
          {e.fails ? ` · ${e.fails} failed` : ''}
        </span>
      </div>
    </div>
  );
}

/**
 * Write an eval by hand.
 *
 * Both halves of the bar are required, exactly as they are for a generated
 * one: a criterion that states only what passes leaves whoever grades it to
 * invent the other half, and two runs then disagree about the same call.
 */
function NewEval({
  busy,
  error,
  onCancel,
  onSave,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (f: {
    title: string; description: string;
    passDefinition: string; failDefinition: string;
    severity: string; layer: string; modality: string;
  }) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [passDefinition, setPass] = useState('');
  const [failDefinition, setFail] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [layer, setLayer] = useState('semantic');
  const [modality, setModality] = useState('any');

  const ready = Boolean(title.trim() && passDefinition.trim() && failDefinition.trim());
  const field: React.CSSProperties = {
    width: '100%', border: '1px solid var(--border-default)', borderRadius: 6,
    padding: '8px 10px', fontSize: 13, fontFamily: 'var(--font-sans)', outline: 'none',
    boxSizing: 'border-box', color: 'var(--ink-900)',
  };
  const lbl: React.CSSProperties = {
    fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase',
    color: 'var(--ink-500)', fontWeight: 500, display: 'block', marginBottom: 5,
  };

  return (
    <div style={{ background: '#fff', borderBottom: '2px solid var(--blue-500)' }}>
      <div style={{ padding: '13px 20px', background: 'var(--blue-025)', borderBottom: '1px solid var(--blue-100)' }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>New eval</h3>
        <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 2 }}>
          Graded like every other eval. Kept through regenerations and scope-of-work edits.
        </div>
      </div>

      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={lbl}>Title</label>
          <input
            className="hue-field"
            style={field}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Callback promised is logged"
            autoFocus
          />
          {/* The id is this app's business, not something to ask for. A custom
              eval cites no clause of the scope of work, so asking for one
              invites a reference to a clause that does not exist. */}
          <div style={{ fontSize: 11, color: 'var(--ink-500)', marginTop: 5 }}>
            An id is assigned on save — GEN-CUS-001, GEN-CUS-002, and so on.
          </div>
        </div>

        <div>
          <label style={lbl}>What it requires</label>
          <input className="hue-field" style={field} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Where the agent promises a callback, a task must exist for it." />
        </div>

        <div>
          <label style={lbl}>Passes when</label>
          <textarea className="hue-field" style={{ ...field, minHeight: 62, resize: 'vertical', lineHeight: '19px' }} value={passDefinition} onChange={(e) => setPass(e.target.value)} placeholder="Written so two people reading the same call would agree." />
        </div>

        <div>
          <label style={lbl}>Fails when</label>
          <textarea className="hue-field" style={{ ...field, minHeight: 62, resize: 'vertical', lineHeight: '19px' }} value={failDefinition} onChange={(e) => setFail(e.target.value)} placeholder="The complement of the above, not a restatement of it." />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
          <div>
            <label style={lbl}>Severity</label>
            <select className="hue-field" style={field} value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {['critical', 'high', 'medium', 'low'].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div>
            <label style={lbl}>Layer</label>
            <select className="hue-field" style={field} value={layer} onChange={(e) => setLayer(e.target.value)}>
              <option value="semantic">semantic — a judge reads the call</option>
              <option value="deterministic">deterministic — needs code</option>
            </select>
          </div>
          <div>
            <label style={lbl}>Applies to</label>
            <select className="hue-field" style={field} value={modality} onChange={(e) => setModality(e.target.value)}>
              <option value="any">any channel</option>
              <option value="voice">voice only</option>
              <option value="text">text only</option>
            </select>
          </div>
        </div>

        {/* Said before saving, not discovered afterwards. */}
        {layer === 'deterministic' && (
          <div style={{ fontSize: 12, color: 'var(--warning-700)', background: 'var(--warning-050)', borderRadius: 6, padding: '8px 11px', lineHeight: '18px' }}>
            A deterministic eval has no code behind it, so nothing will run it. It is stored and shown
            as “Not wired” rather than reported as a criterion your calls passed.
          </div>
        )}

        {error && (
          <div style={{ fontSize: 12, color: 'var(--danger-700)', background: 'var(--danger-050)', borderRadius: 6, padding: '8px 11px' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', borderTop: '1px solid var(--ink-100)', paddingTop: 14, flexWrap: 'wrap' }}>
          <button
            className="hue-btn"
            disabled={!ready || busy}
            onClick={() => onSave({ title, description, passDefinition, failDefinition, severity, layer, modality })}
            style={{
              height: 36, padding: '0 16px', borderRadius: 6,
              border: `1px solid ${ready && !busy ? 'var(--blue-500)' : 'var(--border-default)'}`,
              background: ready && !busy ? 'var(--blue-500)' : 'var(--ink-100)',
              color: ready && !busy ? '#fff' : 'var(--ink-400)',
              fontWeight: 500, fontSize: 13, cursor: ready && !busy ? 'pointer' : 'not-allowed',
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}
          >
            {busy ? <span className="hue-spinner" aria-hidden="true" /> : null}
            {busy ? 'Saving…' : 'Add eval'}
          </button>
          <button className="hue-btn" onClick={onCancel} disabled={busy} style={{ height: 36, padding: '0 14px', borderRadius: 6, border: '1px solid var(--border-default)', background: '#fff', fontWeight: 500, fontSize: 13, cursor: 'pointer' }}>
            Cancel
          </button>
          <span style={{ fontSize: 12, color: 'var(--ink-500)' }}>
            {ready ? 'Graded from the next run onwards.' : 'A title and both definitions are required.'}
          </span>
        </div>
      </div>
    </div>
  );
}
