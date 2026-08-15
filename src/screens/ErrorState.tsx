/** Error state — ported from the ERROR block of the design. */
export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={{ padding: '40px 32px', maxWidth: 640 }}>
      <div
        style={{
          background: 'var(--surface-card)',
          border: '1px solid var(--danger-500)',
          borderRadius: 'var(--radius-lg)',
          padding: 24,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5" />
            <path d="M12 16h.01" />
          </svg>
          <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>
            Couldn't load calls — CMMS connector unreachable
          </h2>
        </div>
        <p style={{ margin: '10px 0 0', color: 'var(--ink-700)', lineHeight: '20px', textWrap: 'pretty' }}>
          The governance layer reads ground truth from your CMMS. Until the connector responds,
          evaluations are paused and no data is lost — calls keep recording and will be evaluated on
          reconnect.
        </p>
        <div
          style={{
            marginTop: 14,
            background: 'var(--ink-050)',
            borderRadius: 'var(--radius-sm)',
            padding: '12px 14px',
            fontSize: 12,
            color: 'var(--ink-600)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontFamily: 'var(--font-mono)',
            wordBreak: 'break-word',
          }}
        >
          {/* The real error, not a placeholder — this is what makes the state debuggable. */}
          <span>{message}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="hue-btn"
            onClick={onRetry}
            style={{
              height: 38,
              padding: '0 16px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--blue-500)',
              background: 'var(--blue-500)',
              color: 'var(--surface-card)',
              fontWeight: 500,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Retry connection
          </button>
        </div>
      </div>
    </div>
  );
}
