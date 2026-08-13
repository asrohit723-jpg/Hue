import { useEffect, useMemo, useState } from 'react';
import type { Conversation } from '@shared/contract';
import { api } from '../lib/vibe';
import { BootSkeleton } from './BootSkeleton';
import { Button, Empty, LoadError, PageHead, Panel, Pill } from '../components/Chrome';
import { avatarColor, clock, duration, evalTone, initials, label, sentimentTone } from '../lib/tone';

const FILTERS = ['All calls', 'Flagged', 'Passed', 'Not evaluated'] as const;
type Filter = (typeof FILTERS)[number];

const COLS = '104px minmax(240px,2fr) 130px 104px 74px 24px';

export function Conversations({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('All calls');
  const [site, setSite] = useState('All sites');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setItems(null);
      setError(null);
      try {
        const rows = await api.listConversations(200);
        if (!cancelled) setItems(rows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const sites = useMemo(
    () => ['All sites', ...Array.from(new Set((items ?? []).map((c) => c.site).filter(Boolean) as string[]))],
    [items],
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter((c) => {
      if (filter === 'Flagged' && c.evalStatus !== 'flagged') return false;
      if (filter === 'Passed' && c.evalStatus !== 'passed') return false;
      if (filter === 'Not evaluated' && c.evalStatus !== 'not_evaluated') return false;
      if (site !== 'All sites' && c.site !== site) return false;
      if (!needle) return true;
      return [c.caller.name, c.site, c.srRecordId, c.callId]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [items, q, filter, site]);

  if (error) return <div style={{ padding: '24px 28px', maxWidth: 1240 }}><LoadError message={error} onRetry={() => setNonce((n) => n + 1)} /></div>;
  if (!items) return <BootSkeleton label="Loading calls…" />;

  return (
    <div style={{ padding: '24px 28px 40px', maxWidth: 1240 }}>
      <PageHead
        title="Call logs"
        sub="Every call the agent took. Open one to read the full record."
        right={
          <>
            <div style={{ position: 'relative' }}>
              <svg style={{ position: 'absolute', left: 11, top: 11 }} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ink-500)" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search caller, site or SR"
                style={{
                  width: 240,
                  height: 36,
                  padding: '0 12px 0 34px',
                  border: '1px solid var(--border-default)',
                  borderRadius: 6,
                  fontSize: 13,
                  outline: 'none',
                }}
              />
            </div>
            <select
              value={site}
              onChange={(e) => setSite(e.target.value)}
              style={{
                height: 36,
                width: 160,
                border: '1px solid var(--border-default)',
                borderRadius: 6,
                padding: '0 10px',
                fontSize: 13,
                background: '#fff',
                color: 'var(--ink-900)',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              {sites.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </>
        }
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 0', flexWrap: 'wrap' }}>
        {FILTERS.map((f) => {
          const on = filter === f;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                height: 32,
                fontSize: 12,
                fontWeight: 500,
                padding: '0 13px',
                borderRadius: 999,
                cursor: 'pointer',
                border: `1px solid ${on ? 'var(--blue-500)' : 'var(--border-default)'}`,
                background: on ? 'var(--blue-025)' : '#fff',
                color: on ? 'var(--blue-600)' : 'var(--ink-700)',
              }}
            >
              {f}
            </button>
          );
        })}
        <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--ink-600)' }}>
          {rows.length} of {items.length} calls
        </span>
      </div>

      <Panel style={{ marginTop: 12 }}>
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
            <span>Result</span><span>Caller</span><span>Outcome</span><span>Sentiment</span><span>Time</span><span />
          </div>

          {rows.map((c) => {
            const ev = evalTone(c.evalStatus);
            const sent = sentimentTone(c.sentiment);
            // Outcome states the ground truth, not the agent's claim: a record
            // id when the join resolved, "No record" when it did not.
            const joined = Boolean(c.srRecordId);
            return (
              <div
                key={c.id}
                onClick={() => onOpen(c.id)}
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') onOpen(c.id); }}
                style={{
                  display: 'grid',
                  minWidth: 880,
                  gridTemplateColumns: COLS,
                  gap: 14,
                  alignItems: 'center',
                  padding: '12px 16px',
                  borderBottom: '1px solid var(--ink-100)',
                  cursor: 'pointer',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em', color: ev.fg }}>
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: ev.fg, flex: '0 0 7px' }} />
                  {label(c.evalStatus)}
                </span>

                <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
                  <span
                    style={{
                      width: 32, height: 32, flex: '0 0 32px', borderRadius: 999,
                      background: avatarColor(c.caller.name ?? c.callId),
                      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 12, fontWeight: 600,
                    }}
                  >
                    {initials(c.caller.name)}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                      <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{c.caller.name || 'Unknown caller'}</span>
                      <span style={{ fontSize: 12, color: 'var(--ink-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.site}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.transcript.find((t) => t.performer === 'caller')?.message ?? `Call ${c.callId}`}
                    </div>
                  </div>
                </div>

                <Pill bg={joined ? 'var(--success-050)' : 'var(--danger-050)'} fg={joined ? 'var(--success-700)' : 'var(--danger-500)'} mono>
                  {joined ? `SR ${c.srRecordId}` : 'No record'}
                </Pill>

                <Pill bg={sent.bg} fg={sent.fg}>{label(c.sentiment ?? 'unknown')}</Pill>

                <div>
                  <div style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{clock(c.startedAt)}</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-500)', fontVariantNumeric: 'tabular-nums' }}>{duration(c.durationSec)}</div>
                </div>

                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </div>
            );
          })}
        </div>

        {rows.length === 0 && (
          <Empty
            title="No calls match"
            body="Nothing matches this search and filter."
            action={
              <Button onClick={() => { setQ(''); setFilter('All calls'); setSite('All sites'); }}>
                Clear search and filters
              </Button>
            }
          />
        )}
      </Panel>
    </div>
  );
}
