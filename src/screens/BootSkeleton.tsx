/** Loading skeleton — ported from the LOADING block of the design. */

const CARDS = [0, 1, 2, 3];
const ROWS = [0, 1, 2, 3, 4, 5, 6];

export function BootSkeleton({ label = 'Loading calls from the CMMS connector…' }: { label?: string }) {
  return (
    <div
      style={{
        padding: '28px 32px 40px',
        maxWidth: 1360,
        fontFamily: 'var(--font-sans)',
        fontSize: 14,
        lineHeight: '20px',
        color: 'var(--ink-900)',
      }}
      aria-busy="true"
    >
      <div className="skq" style={{ width: 280, height: 26 }} />
      <div className="skq" style={{ width: 420, height: 14, marginTop: 10 }} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4,1fr)',
          gap: 16,
          marginTop: 24,
        }}
      >
        {CARDS.map((i) => (
          <div
            key={i}
            style={{
              background: '#fff',
              border: '1px solid var(--border-default)',
              borderRadius: 8,
              padding: 16,
            }}
          >
            <div className="skq" style={{ width: '70%', height: 11 }} />
            <div className="skq" style={{ width: '52%', height: 28, marginTop: 12 }} />
            <div className="skq" style={{ width: '84%', height: 10, marginTop: 12 }} />
          </div>
        ))}
      </div>

      <div
        style={{
          background: '#fff',
          border: '1px solid var(--border-default)',
          borderRadius: 8,
          marginTop: 20,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div className="skq" style={{ width: 180, height: 14 }} />
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink-500)' }}>{label}</span>
        </div>
        {ROWS.map((i) => (
          <div
            key={i}
            style={{
              display: 'grid',
              gridTemplateColumns: '90px 1.4fr 1.6fr 90px 110px 120px 80px',
              gap: 16,
              alignItems: 'center',
              padding: '0 18px',
              height: 52,
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <div className="skq" style={{ height: 10 }} />
            <div className="skq" style={{ height: 10 }} />
            <div className="skq" style={{ height: 10 }} />
            <div className="skq" style={{ height: 10 }} />
            <div className="skq" style={{ height: 18, borderRadius: 999 }} />
            <div className="skq" style={{ height: 18, borderRadius: 999 }} />
            <div className="skq" style={{ height: 10 }} />
          </div>
        ))}
      </div>
    </div>
  );
}
