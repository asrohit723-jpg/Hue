import { useState } from 'react';
import { logout, type CurrentUser } from '../lib/vibe';
import { Overview } from './Overview';
import { Conversations } from './Conversations';
import { ConversationDetail } from './ConversationDetail';
import { Interventions } from './Interventions';
import { InterventionDetail } from './InterventionDetail';
import { ScopeEvals } from './ScopeEvals';
import { Patterns } from './Patterns';
import { Notifications } from './Notifications';

/** Screens, matching the design's `screen` state values. */
export type ScreenId =
  | 'overview'
  | 'convos'
  | 'convo'
  | 'ints'
  | 'int'
  | 'patterns'
  | 'scope'
  | 'notify';

const ACTIVE_BG = 'var(--blue-025)';
const ACTIVE_FG = 'var(--blue-600)';
const IDLE_FG = 'var(--ink-700)';

/** Agents governance will cover later. Present but inert, as in the design. */
const COMING_SOON = ['Procurement agent', 'Inspection agent', 'Tenant billing agent'];

function navTone(active: boolean) {
  return { background: active ? ACTIVE_BG : 'transparent', color: active ? ACTIVE_FG : IDLE_FG };
}

function NavItem({
  label,
  active,
  onClick,
  iconBg,
  icon,
  trailing,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  iconBg: string;
  icon: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick();
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        fontWeight: 500,
        ...navTone(active),
      }}
    >
      <span
        style={{
          width: 26,
          height: 26,
          flex: '0 0 26px',
          borderRadius: 6,
          background: iconBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </span>
      <span>{label}</span>
      {trailing}
    </div>
  );
}

function SectionLabel({ children, top = 6 }: { children: React.ReactNode; top?: number }) {
  return (
    <div
      style={{
        fontSize: 11,
        letterSpacing: '.04em',
        textTransform: 'uppercase',
        color: 'var(--ink-500)',
        fontWeight: 500,
        padding: `${top}px 8px 6px`,
      }}
    >
      {children}
    </div>
  );
}

export function Shell({ me }: { me: CurrentUser }) {
  const [screen, setScreen] = useState<ScreenId>('overview');
  const [query, setQuery] = useState('');
  const [openDeviations, setOpenDeviations] = useState<number | null>(null);
  const [callCount, setCallCount] = useState<number | null>(null);
  // Selection for the two detail screens.
  const [callId, setCallId] = useState<string | null>(null);
  const [deviationId, setDeviationId] = useState<string | null>(null);

  const openCall = (id: string) => { setCallId(id); setScreen('convo'); };
  const openDeviation = (id: string) => { setDeviationId(id); setScreen('int'); };

  const initials =
    (me.user.name || me.user.email)
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? '')
      .join('') || '?';

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
      {/* ---------------- SIDEBAR ---------------- */}
      <div
        style={{
          width: 236,
          flex: '0 0 236px',
          background: '#FFFFFF',
          borderRight: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            height: 64,
            flex: '0 0 64px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '0 16px',
            borderBottom: '1px solid var(--border-default)',
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              flex: '0 0 32px',
              borderRadius: 6,
              background: 'var(--brand-indigo)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            A
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: 2,
              minWidth: 0,
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 14, lineHeight: '17px' }}>
              Atom Governance
            </span>
            <span style={{ fontSize: 12, color: 'var(--ink-500)', lineHeight: '14px' }}>
              Helpdesk voice agent
            </span>
          </div>
        </div>

        <div style={{ padding: '14px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SectionLabel>Monitor</SectionLabel>

          <NavItem
            label="Overview"
            active={screen === 'overview'}
            onClick={() => setScreen('overview')}
            iconBg="var(--blue-050)"
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--blue-500)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
              </svg>
            }
          />

          <NavItem
            label="Conversations"
            active={screen === 'convos' || screen === 'convo'}
            onClick={() => setScreen('convos')}
            iconBg="var(--brand-indigo-050)"
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--brand-indigo)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            }
            trailing={
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 11,
                  color: 'var(--ink-500)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {callCount ?? '—'}
              </span>
            }
          />

          <NavItem
            label="Interventions"
            active={screen === 'ints' || screen === 'int'}
            onClick={() => setScreen('ints')}
            iconBg="var(--danger-050)"
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--danger-500)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
            }
            trailing={
              openDeviations !== null && openDeviations > 0 ? (
                <span
                  style={{
                    marginLeft: 'auto',
                    background: 'var(--danger-050)',
                    color: 'var(--danger-500)',
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '1px 7px',
                    borderRadius: 999,
                  }}
                >
                  {openDeviations}
                </span>
              ) : undefined
            }
          />

          <NavItem
            label="Patterns"
            active={screen === 'patterns'}
            onClick={() => setScreen('patterns')}
            iconBg="var(--warning-050)"
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--warning-700)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
                <polyline points="16 7 22 7 22 13" />
              </svg>
            }
          />

          <SectionLabel top={14}>Govern</SectionLabel>

          <NavItem
            label="Scope & evals"
            active={screen === 'scope'}
            onClick={() => setScreen('scope')}
            iconBg="var(--success-050)"
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success-700)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
                <polyline points="14 2 14 8 20 8" />
                <path d="m9 15 2 2 4-4" />
              </svg>
            }
          />

          <NavItem
            label="Notifications"
            active={screen === 'notify'}
            onClick={() => setScreen('notify')}
            iconBg="var(--ink-100)"
            icon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ink-600)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
            }
          />

          <SectionLabel top={14}>Other agents</SectionLabel>
          {COMING_SOON.map((name) => (
            <div
              key={name}
              title="Coming soon — governance for this agent is not part of this release"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                borderRadius: 6,
                fontWeight: 500,
                color: 'var(--ink-400)',
                cursor: 'not-allowed',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {name}
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: '.03em',
                  textTransform: 'uppercase',
                  color: 'var(--ink-500)',
                  background: 'var(--ink-050)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 999,
                  padding: '1px 6px',
                }}
              >
                Soon
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ---------------- MAIN ---------------- */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* TOP BAR */}
        <div
          style={{
            height: 60,
            flex: '0 0 60px',
            background: '#fff',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '0 24px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            <span
              style={{
                width: 28,
                height: 28,
                flex: '0 0 28px',
                borderRadius: 6,
                background: 'var(--brand-indigo-050)',
                color: 'var(--brand-indigo)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {initials}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2, minWidth: 0 }}>
              <span
                style={{
                  fontWeight: 600,
                  fontSize: 14,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {me.user.name || me.user.email}
              </span>
              <span style={{ fontSize: 11, color: 'var(--ink-500)', whiteSpace: 'nowrap' }}>
                org {me.org.orgId}
              </span>
            </div>
          </div>

          <div style={{ flex: 1, maxWidth: 460, position: 'relative', marginLeft: 8 }}>
            <svg
              style={{ position: 'absolute', left: 12, top: 11 }}
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--ink-500)"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setScreen('convos')}
              placeholder="Search callers, sites, SR numbers"
              style={{
                width: '100%',
                height: 38,
                padding: '0 14px 0 36px',
                border: '1px solid transparent',
                borderRadius: 999,
                fontSize: 13,
                color: 'var(--ink-900)',
                outline: 'none',
                background: 'var(--ink-050)',
              }}
            />
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ width: 1, height: 24, background: 'var(--border-default)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 999,
                  background: 'var(--blue-050)',
                  color: 'var(--blue-600)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {initials}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{me.user.name || me.user.username}</span>
                <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>{me.user.email}</span>
              </div>
            </div>
            <button
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
              style={{
                width: 36,
                height: 36,
                borderRadius: 6,
                border: '1px solid var(--border-default)',
                background: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: 'var(--ink-600)',
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </div>

        {/* SCROLL AREA */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {screen === 'overview' && (
            <Overview
              onCounts={(calls, open) => {
                setCallCount(calls);
                setOpenDeviations(open);
              }}
              onOpenDeviation={openDeviation}
              onNavigate={setScreen}
            />
          )}
          {screen === 'convos' && <Conversations onOpen={openCall} />}
          {screen === 'convo' && callId && (
            <ConversationDetail
              id={callId}
              onBack={() => setScreen('convos')}
              onOpenDeviation={openDeviation}
            />
          )}
          {screen === 'ints' && <Interventions onOpen={openDeviation} />}
          {screen === 'int' && deviationId && (
            <InterventionDetail
              deviationId={deviationId}
              onBack={() => setScreen('ints')}
              onOpenCall={openCall}
            />
          )}
          {screen === 'patterns' && <Patterns onOpenCriterion={() => setScreen('ints')} />}
          {screen === 'scope' && <ScopeEvals />}
          {screen === 'notify' && <Notifications onOpen={openDeviation} />}
        </div>
      </div>
    </div>
  );
}
