import type { ReactNode } from 'react';

/** Card surface used by every screen — matches the design's panel treatment. */
export function Panel({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        overflow: 'hidden',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function PageHead({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
      <div>
        <h1 style={{ fontSize: 24, lineHeight: '30px', fontWeight: 700, margin: 0, letterSpacing: '-.01em' }}>
          {title}
        </h1>
        {sub && <p style={{ margin: '5px 0 0', color: 'var(--ink-600)' }}>{sub}</p>}
      </div>
      {right && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>{right}</div>}
    </div>
  );
}

export function Pill({
  children,
  bg,
  fg,
  mono,
}: {
  children: ReactNode;
  bg: string;
  fg: string;
  mono?: boolean;
}) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 999,
        background: bg,
        color: fg,
        justifySelf: 'start',
        whiteSpace: 'nowrap',
        fontVariantNumeric: mono ? 'tabular-nums' : undefined,
      }}
    >
      {children}
    </span>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div style={{ padding: '44px 24px', textAlign: 'center' }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      <p style={{ margin: '6px 0 14px', fontSize: 13, color: 'var(--ink-600)' }}>{body}</p>
      {action}
    </div>
  );
}

export function Button({
  children,
  onClick,
  primary,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button className="hue-btn"
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 38,
        padding: '0 16px',
        borderRadius: 4,
        border: `1px solid ${primary && !disabled ? 'var(--blue-500)' : 'var(--border-default)'}`,
        background: disabled ? 'var(--ink-050)' : primary ? 'var(--blue-500)' : '#fff',
        color: disabled ? 'var(--ink-500)' : primary ? '#fff' : 'var(--ink-900)',
        fontWeight: 500,
        fontSize: 13,
        cursor: disabled ? 'not-allowed' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

export function BackLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button className="hue-btn"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'none',
        border: 'none',
        padding: 0,
        color: 'var(--blue-500)',
        fontWeight: 500,
        fontSize: 13,
        cursor: 'pointer',
        marginBottom: 12,
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m15 18-6-6 6-6" />
      </svg>
      {children}
    </button>
  );
}

/** Inline error surface for a screen that failed to load. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Panel style={{ border: '1px solid var(--danger-500)' }}>
      <div style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5" />
            <path d="M12 16h.01" />
          </svg>
          <span style={{ fontWeight: 600 }}>Couldn't load this view</span>
        </div>
        <p
          style={{
            margin: '10px 0 0',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--ink-600)',
            wordBreak: 'break-word',
          }}
        >
          {message}
        </p>
        <div style={{ marginTop: 14 }}>
          <Button primary onClick={onRetry}>
            Retry
          </Button>
        </div>
      </div>
    </Panel>
  );
}
