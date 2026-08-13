import { useMemo, useState } from 'react';
import seed from '../../evals/criteria.seed.json';
import { PageHead, Panel, Pill } from '../components/Chrome';
import { label } from '../lib/tone';

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

/**
 * Criteria are Hue's own configuration, derived from the SOW — not CMMS data,
 * so they load from the seed file rather than a live read. `layer` is the field
 * that matters: it decides whether a criterion is answered by a lookup or by a
 * model, and that distinction is what keeps the deterministic checks exact.
 */
export function ScopeEvals() {
  const criteria = (seed as { criteria: SeedCriterion[] }).criteria;
  const [layer, setLayer] = useState<'all' | 'deterministic' | 'semantic'>('all');

  const groups = useMemo(() => {
    const filtered = criteria.filter((c) => layer === 'all' || c.layer === layer);
    const byClause = new Map<string, SeedCriterion[]>();
    for (const c of filtered) {
      const k = c.clauseRef.split('.')[0];
      byClause.set(k, [...(byClause.get(k) ?? []), c]);
    }
    return Array.from(byClause.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [criteria, layer]);

  const det = criteria.filter((c) => c.layer === 'deterministic').length;
  const sem = criteria.length - det;

  return (
    <div style={{ padding: '24px 28px 40px', maxWidth: 1100 }}>
      <PageHead
        title="Scope & evals"
        sub={`${criteria.length} criteria derived from the scope of work — ${det} answered by code, ${sem} by a model.`}
        right={
          <div style={{ display: 'flex', gap: 6 }}>
            {(['all', 'deterministic', 'semantic'] as const).map((l) => {
              const on = layer === l;
              return (
                <button
                  key={l}
                  onClick={() => setLayer(l)}
                  style={{
                    height: 32, padding: '0 13px', borderRadius: 999, fontSize: 12, fontWeight: 500,
                    cursor: 'pointer',
                    border: `1px solid ${on ? 'var(--blue-500)' : 'var(--border-default)'}`,
                    background: on ? 'var(--blue-025)' : '#fff',
                    color: on ? 'var(--blue-600)' : 'var(--ink-700)',
                  }}
                >
                  {label(l)}
                </button>
              );
            })}
          </div>
        }
      />

      <Panel style={{ marginTop: 16, padding: 16, borderRadius: 8 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-700)', lineHeight: '20px', textWrap: 'pretty' }}>
          <strong>Deterministic</strong> criteria are answered from the CMMS record and the tool-call
          log by plain code — does the record exist, is the field null, did the escalation beat its
          clock. They are exact and reproducible, and no model is consulted.{' '}
          <strong>Semantic</strong> criteria need someone to read the call: whether two faults were
          genuinely distinct, whether a stated time window was honoured, whether the category matches
          what the caller actually described. Those go to a Claude judge, which must cite the turns
          that justify its verdict.
        </p>
      </Panel>

      {groups.map(([clause, list]) => (
        <div key={clause} style={{ marginTop: 20 }}>
          <div style={{ fontSize: 11, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--ink-500)', fontWeight: 500, marginBottom: 8 }}>
            Clause {clause}
          </div>
          <Panel>
            {list.map((c) => (
              <div key={c.id} style={{ padding: '14px 18px', borderBottom: '1px solid var(--ink-100)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Pill
                    bg={c.layer === 'semantic' ? 'var(--brand-indigo-050)' : 'var(--ink-050)'}
                    fg={c.layer === 'semantic' ? 'var(--brand-indigo)' : 'var(--ink-600)'}
                  >
                    {c.layer}
                  </Pill>
                  <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>{c.id} · {c.clauseRef} · {c.checkType}</span>
                  {!c.active && <Pill bg="var(--warning-050)" fg="var(--warning-700)">inactive</Pill>}
                </div>
                <div style={{ fontWeight: 600, marginTop: 6, textWrap: 'pretty' }}>{c.title}</div>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--ink-600)', lineHeight: '19px', textWrap: 'pretty' }}>
                  {c.description}
                </p>
              </div>
            ))}
          </Panel>
        </div>
      ))}
    </div>
  );
}
