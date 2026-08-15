/**
 * Sign-in — ported from the SIGN IN / SIGN UP block of the design.
 *
 * Design deviation, deliberate: the mock has an email + password form with
 * demo-account shortcuts. Vibe auth is browser-cookie SSO via
 * `vibe.login()`, and the SDK docs are explicit that apps must not roll their
 * own login. Building the password form would mean shipping a control that
 * cannot work. Layout, type scale, spacing and the right-hand panel are
 * unchanged; the credential fields are replaced by the real sign-in action.
 */

const POINTS = [
  {
    title: 'Every call joined to its record',
    body: 'Each conversation is matched against the actual service request in your CMMS — so "logged it for you" is checked, not taken on trust.',
  },
  {
    title: 'Graded against your scope of work',
    body: 'Your SOW becomes eval criteria. Deterministic checks run as code; the judgement calls go to a model, and both show their evidence.',
  },
  {
    title: 'Deviations you can act on',
    body: 'Each finding carries the turns that caused it, a proposed fix, and — where a prompt change is not enough — the task a person needs to pick up.',
  },
];

export function SignIn({ onSignIn, error }: { onSignIn: () => void; error?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        overflow: 'hidden',
        fontFamily: 'var(--font-sans)',
        fontSize: 14,
        lineHeight: '20px',
        color: 'var(--ink-900)',
        background: 'var(--bg-app)',
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>
        {/* Left — identity + action */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '40px 32px',
            overflowY: 'auto',
          }}
        >
          <div style={{ width: '100%', maxWidth: 400 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--brand-indigo)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--surface-card)',
                  fontWeight: 700,
                  fontSize: 14,
                }}
              >
                A
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
                <span style={{ fontWeight: 600, fontSize: 15 }}>Vigil</span>
                <span style={{ fontSize: 12, color: 'var(--ink-500)' }}>Helpdesk voice agent</span>
              </div>
            </div>

            <h1
              style={{
                fontSize: 24,
                lineHeight: '30px',
                fontWeight: 700,
                margin: '28px 0 0',
                letterSpacing: '-.01em',
              }}
            >
              Sign in to Vigil
            </h1>
            <p style={{ margin: '8px 0 0', color: 'var(--ink-600)', textWrap: 'pretty' }}>
              Governance and evidence for your AI helpdesk agent. Sign in with the Facilio account
              that owns the CMMS you want to govern.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 24 }}>
              {error && (
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                    background: 'var(--danger-050)',
                    border: '1px solid var(--danger-500)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '10px 12px',
                  }}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--danger-500)"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flex: '0 0 16px', marginTop: 2 }}
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 8v5" />
                    <path d="M12 16h.01" />
                  </svg>
                  <span style={{ fontSize: 13, color: 'var(--danger-700)', lineHeight: '19px' }}>
                    {error}
                  </span>
                </div>
              )}

              <button className="hue-btn"
                onClick={onSignIn}
                style={{
                  height: 44,
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--blue-500)',
                  background: 'var(--blue-500)',
                  color: 'var(--surface-card)',
                  fontWeight: 500,
                  fontSize: 14,
                  cursor: 'pointer',
                }}
              >
                Sign in with Facilio
              </button>

              <p
                style={{
                  margin: 0,
                  fontSize: 12,
                  color: 'var(--ink-600)',
                  lineHeight: '18px',
                  textWrap: 'pretty',
                }}
              >
                You'll be redirected to Facilio to authenticate, then returned here. Vigil reads the
                sites and service requests your account already has access to — it never asks for
                CMMS credentials of its own.
              </p>
            </div>
          </div>
        </div>

        {/* Right — value panel, unchanged from the design */}
        <div
          style={{
            flex: '0 0 44%',
            maxWidth: 560,
            background: 'var(--surface-card)',
            borderLeft: '1px solid var(--border-default)',
            padding: '56px 48px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '.04em',
              textTransform: 'uppercase',
              color: 'var(--brand-indigo)',
            }}
          >
            Your account, your evidence
          </span>
          <h2
            style={{
              fontSize: 22,
              lineHeight: '30px',
              fontWeight: 700,
              margin: '12px 0 0',
              letterSpacing: '-.01em',
              textWrap: 'pretty',
            }}
          >
            Every call your agent takes, joined to the record it created in your CMMS
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 24 }}>
            {POINTS.map((p) => (
              <div key={p.title} style={{ display: 'flex', gap: 12 }}>
                <span
                  style={{
                    width: 24,
                    height: 24,
                    flex: '0 0 24px',
                    borderRadius: 'var(--radius-pill)',
                    background: 'var(--blue-050)',
                    color: 'var(--blue-600)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                <div>
                  <div style={{ fontWeight: 600 }}>{p.title}</div>
                  <p
                    style={{
                      margin: '4px 0 0',
                      fontSize: 13,
                      color: 'var(--ink-700)',
                      lineHeight: '20px',
                      textWrap: 'pretty',
                    }}
                  >
                    {p.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <p
            style={{
              margin: '28px 0 0',
              fontSize: 12,
              color: 'var(--ink-500)',
              lineHeight: '18px',
            }}
          >
            Data is scoped to your account. Sites, callers and service requests from other clients
            are never visible here.
          </p>
        </div>
      </div>
    </div>
  );
}
