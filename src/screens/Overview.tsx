import { useEffect, useState } from 'react';
import { api, type OverviewMetrics } from '../lib/vibe';
import { BootSkeleton } from './BootSkeleton';
import { ErrorState } from './ErrorState';
import { FirstRun } from './FirstRun';

type Load =
  | { phase: 'loading' }
  | { phase: 'ready'; data: OverviewMetrics }
  | { phase: 'error'; message: string };

export function Overview({ onCounts }: { onCounts?: (calls: number, open: number) => void }) {
  const [state, setState] = useState<Load>({ phase: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setState({ phase: 'loading' });
      try {
        const data = await api.overview();
        if (cancelled) return;
        setState({ phase: 'ready', data });
        onCounts?.(data.callsToday, data.missedSr);
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

  if (state.phase === 'loading') return <BootSkeleton />;
  if (state.phase === 'error') {
    return <ErrorState message={state.message} onRetry={() => setNonce((n) => n + 1)} />;
  }

  const d = state.data;
  if (d.isFirstRun) return <FirstRun sites={d.sites} />;

  return (
    <div style={{ padding: '28px 32px 40px', maxWidth: 1360 }}>
      <h1 style={{ fontSize: 22, lineHeight: '28px', fontWeight: 700, margin: 0, letterSpacing: '-.01em' }}>
        Helpdesk governance
      </h1>
      <p style={{ margin: '6px 0 0', color: 'var(--ink-600)' }}>
        {d.callsToday} {d.callsToday === 1 ? 'conversation' : 'conversations'} joined to your CMMS
        across {d.sites.length} {d.sites.length === 1 ? 'site' : 'sites'}.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginTop: 24 }}>
        <Metric label="Calls evaluated" value={String(d.callsToday)} foot={d.deltaCalls} />
        <Metric label="Eval coverage" value={`${d.coverage}%`} foot={`${d.unchecked} not yet evaluated`} />
        <Metric
          label="Confirmed but unlogged"
          value={String(d.missedSr)}
          foot="Agent claimed a record the CMMS does not have"
          tone={d.missedSr > 0 ? 'var(--danger-500)' : undefined}
        />
        <Metric label="SOW compliance" value={`${d.compliance}%`} foot={d.trend} />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  foot,
  tone,
}: {
  label: string;
  value: string;
  foot: string;
  tone?: string;
}) {
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        padding: 16,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: '.04em',
          textTransform: 'uppercase',
          color: 'var(--ink-500)',
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 28,
          lineHeight: '34px',
          fontWeight: 700,
          marginTop: 10,
          color: tone ?? 'var(--ink-900)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 10, lineHeight: '17px' }}>
        {foot}
      </div>
    </div>
  );
}
