/**
 * First run — ported from the FIRST RUN block of the design.
 *
 * Shown when the org is connected but has no conversations yet. The step
 * states are derived from what actually exists, not hard-coded: the CMMS
 * connection is proven by the fact that we could list sites at all.
 */
export function FirstRun({ sites }: { sites: string[] }) {
  const steps = [
    {
      n: 1,
      title: 'Connect your CMMS',
      status: sites.length > 0 ? 'Done' : 'Pending',
      done: sites.length > 0,
      detail:
        sites.length > 0
          ? `Reading ground truth from ${sites.length} ${sites.length === 1 ? 'site' : 'sites'}: ${sites.slice(0, 3).join(', ')}${sites.length > 3 ? '…' : ''}.`
          : 'Vigil reads service requests and sites from your CMMS to check what the agent actually did.',
      cta: sites.length > 0 ? 'Connected' : 'Connect',
    },
    {
      n: 2,
      title: 'Add your scope of work',
      status: 'Pending',
      done: false,
      detail:
        'Paste the SOW. Vigil derives eval criteria from its clauses — deterministic checks run as code, judgement calls go to a model. You can edit every criterion before it grades anything.',
      cta: 'Add SOW',
    },
    {
      n: 3,
      title: 'Run the first evaluation',
      status: 'Pending',
      done: false,
      detail:
        'Once the SOW is in, Vigil grades your recorded calls against it and joins each one to its CMMS record.',
      cta: 'Run',
    },
  ];

  return (
    <div style={{ minHeight: 'calc(100vh - 60px)', display: 'flex', alignItems: 'center', padding: '40px 32px 48px' }}>
      <div style={{ maxWidth: 820, width: '100%' }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: 'var(--brand-indigo)',
            background: 'var(--brand-indigo-050)',
            borderRadius: 'var(--radius-pill)',
            padding: '3px 9px',
          }}
        >
          New account
        </span>
        <h1 style={{ fontSize: 26, lineHeight: '32px', fontWeight: 700, margin: '14px 0 0', letterSpacing: '-.01em' }}>
          Set up governance for your helpdesk agent
        </h1>
        <p style={{ margin: '8px 0 0', color: 'var(--ink-600)', maxWidth: '60ch', textWrap: 'pretty' }}>
          Three steps. Nothing is evaluated until your scope of work is in — defaults are pre-filled
          so you can accept and adjust later.
        </p>

        <div
          style={{
            background: 'var(--surface-card)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-lg)',
            marginTop: 24,
            overflow: 'hidden',
          }}
        >
          {steps.map((s) => (
            <div
              key={s.n}
              style={{
                display: 'flex',
                gap: 14,
                padding: '18px 20px',
                borderBottom: '1px solid var(--border-subtle)',
                alignItems: 'flex-start',
              }}
            >
              <span
                style={{
                  width: 26,
                  height: 26,
                  flex: '0 0 26px',
                  borderRadius: 'var(--radius-pill)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                  background: s.done ? 'var(--success-050)' : 'var(--ink-050)',
                  color: s.done ? 'var(--success-700)' : 'var(--ink-600)',
                  border: `1px solid ${s.done ? 'var(--success-400)' : 'var(--border-default)'}`,
                }}
              >
                {s.n}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 600 }}>{s.title}</span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: '.03em',
                      textTransform: 'uppercase',
                      color: s.done ? 'var(--success-700)' : 'var(--ink-500)',
                      background: s.done ? 'var(--success-050)' : 'var(--ink-050)',
                      borderRadius: 'var(--radius-pill)',
                      padding: '2px 8px',
                    }}
                  >
                    {s.status}
                  </span>
                </div>
                <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--ink-700)', lineHeight: '20px', textWrap: 'pretty' }}>
                  {s.detail}
                </p>
              </div>
              <button className="hue-btn"
                disabled={s.done}
                style={{
                  height: 36,
                  padding: '0 14px',
                  borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${s.done ? 'var(--border-default)' : 'var(--blue-500)'}`,
                  background: s.done ? 'var(--surface-card)' : 'var(--blue-500)',
                  color: s.done ? 'var(--ink-500)' : 'var(--surface-card)',
                  fontWeight: 500,
                  fontSize: 13,
                  cursor: s.done ? 'default' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.cta}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
