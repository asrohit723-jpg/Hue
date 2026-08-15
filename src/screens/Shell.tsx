import { useEffect, useRef, useState } from 'react';
import { api, logout, type CurrentUser } from '../lib/vibe';
import { HEADER_H } from '../lib/layout';
import { useHashRoute, type ScreenId } from '../lib/route';
import { Logo } from '../components/Logo';
import { Overview } from './Overview';
import { Conversations } from './Conversations';
import { ConversationDetail } from './ConversationDetail';
import { Interventions } from './Interventions';
import { InterventionDetail } from './InterventionDetail';
import { ScopeEvals } from './ScopeEvals';
import { Patterns } from './Patterns';

/**
 * Screens, matching the design's `screen` state values. Defined with the router
 * now — the URL is what decides which one is showing, so the two cannot be
 * allowed to drift apart.
 */
export type { ScreenId };


/** What the bar calls each screen. The route decides; nothing is stored. */
const SECTION_TITLE: Record<ScreenId, string> = {
  overview: 'Overview',
  convos: 'Call logs',
  convo: 'Call',
  ints: 'Interventions',
  int: 'Intervention',
  patterns: 'Patterns',
  scope: 'Scope of work & evals',
};

/** Screens the search actually filters. Elsewhere, typing takes you to one. */
const SEARCHABLE = new Set<ScreenId>(['convos', 'ints', 'scope']);

/**
 * How long ago, in words, from a real stamp. Empty in, empty out — the bar
 * says nothing rather than guessing when nothing has been ingested yet.
 */
function ago(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const ACTIVE_BG = 'var(--blue-025)';
const ACTIVE_FG = 'var(--blue-600)';
const IDLE_FG = 'var(--ink-700)';

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
  mini = false,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  iconBg: string;
  icon: React.ReactNode;
  trailing?: React.ReactNode;
  /** Icon only. The label becomes the tooltip and the accessible name. */
  mini?: boolean;
}) {
  return (
    <div
      onClick={onClick}
      className="hue-nav"
      role="button"
      tabIndex={0}
      aria-current={active ? 'page' : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick();
      }}
      title={mini ? label : undefined}
      aria-label={mini ? label : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: mini ? 'center' : 'flex-start',
        gap: 10,
        padding: mini ? '8px 0' : '8px 10px',
        borderRadius: 'var(--radius-sm)',
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
          borderRadius: 'var(--radius-sm)',
          background: iconBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </span>
      {/* The label and its trailing count are what the rail sheds; the tooltip
          above carries the name so an icon is never unidentifiable. */}
      {!mini && <span>{label}</span>}
      {!mini && trailing}
    </div>
  );
}

function SectionLabel({
  children,
  top = 6,
  mini = false,
}: {
  children: React.ReactNode;
  top?: number;
  mini?: boolean;
}) {
  // A section heading over icons nobody can read is noise. The rail keeps the
  // grouping through spacing instead.
  if (mini) return <div style={{ height: top + 6 }} />;
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
  // The screen and the open record live in the URL, so a reload comes back to
  // where you were and a link to a call is a link to that call.
  const [route, navigate, setRail] = useHashRoute();
  const screen = route.screen;
  const callId = screen === 'convo' ? route.id : null;
  const deviationId = screen === 'int' ? route.id : null;
  const mini = route.rail === 'mini';
  // Reads the current state and asks for the other one — a toggle, rather than
  // a request that navigate could reinterpret.
  const toggleRail = () => setRail(!mini);

  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [sync, setSync] = useState<Awaited<ReturnType<typeof api.syncStatus>> | null>(null);
  const [openDeviations, setOpenDeviations] = useState<number | null>(null);
  const [callCount, setCallCount] = useState<number | null>(null);

  // Bumped when a refresh finishes, to make the screens that list calls re-read
  // rather than keep showing what was true before the pull.
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  /**
   * What the bar reports. Read once on load and again after a refresh — the
   * counts and the freshness stamp are the only things up here that claim to be
   * current, so they are the only things that re-read.
   */
  useEffect(() => {
    let cancelled = false;
    api
      .syncStatus()
      .then((s) => {
        if (!cancelled) setSync(s);
      })
      .catch(() => {
        // The bar degrades to saying nothing rather than to a guess.
        if (!cancelled) setSync(null);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshSignal]);

  /** Focus the search from anywhere. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Same shape the screens already call, now writing the address bar. */
  const setScreen = (next: ScreenId) => navigate({ screen: next, id: null });
  const openCall = (id: string) => navigate({ screen: 'convo', id });
  const openDeviation = (id: string) => navigate({ screen: 'int', id });

  /**
   * Pull in any calls that have arrived since the page loaded.
   *
   * The server claims an ingest lease before it pulls anything, so two people
   * pressing this at the same moment cannot both store the same call — one
   * ingests, the other is told it is already running. Nothing about that is
   * safe to assume from here, which is why the claim is not in this file.
   */
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const res = await api.refreshCalls();
      setRefreshNote(
        res.skipped
          ? 'Already refreshing'
          : res.ingested > 0
            ? `${res.ingested} new call${res.ingested === 1 ? '' : 's'}`
            : 'Up to date',
      );
      // Re-read even when nothing arrived: grading may have moved on since the
      // page loaded, and a button that says "up to date" over a stale list is
      // worse than one that says nothing.
      setRefreshSignal((n) => n + 1);
    } catch (err) {
      setRefreshNote(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

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
        className="hue-rail"
        style={{
          width: mini ? 64 : 236,
          flex: `0 0 ${mini ? 64 : 236}px`,
          background: 'var(--surface-card)',
          borderRight: '1px solid var(--border-default)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: HEADER_H,
            flex: `0 0 ${HEADER_H}px`,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            justifyContent: mini ? 'center' : 'flex-start',
            padding: mini ? '0 12px' : '0 16px',
            borderBottom: '1px solid var(--border-default)',
          }}
        >
          {/* The mark needs 32px and the toggle 28px, which will not both fit a
              64px rail. Collapsed, the row keeps the control and drops the
              decoration. */}
          {/* Collapsed, the mark IS the control: a 24px logo and a 28px button
              will not both fit 40px of usable rail, and dropping the logo would
              leave the app unidentifiable at exactly the width where a mark
              matters most. So it expands, and says so. */}
          {mini ? (
            <button
              className="hue-btn"
              onClick={toggleRail}
              aria-expanded={false}
              aria-label="Expand the sidebar"
              title="Hue · expand the sidebar"
              style={{
                border: 'none',
                background: 'transparent',
                padding: 0,
                cursor: 'pointer',
                display: 'flex',
              }}
            >
              <Logo size={30} />
            </button>
          ) : (
            <Logo size={30} />
          )}
          {!mini && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: 2,
                minWidth: 0,
              }}
            >
              <span style={{ fontWeight: 600, fontSize: 15, lineHeight: '18px' }}>Hue</span>
              <span style={{ fontSize: 12, color: 'var(--ink-500)', lineHeight: '14px' }}>
                Helpdesk governance
              </span>
            </div>
          )}

          {!mini && (
          <button
            className="hue-btn"
            onClick={toggleRail}
            aria-expanded
            aria-label="Collapse the sidebar"
            title="Collapse the sidebar"
            style={{
              marginLeft: 'auto',
              width: 28,
              height: 28,
              flex: '0 0 28px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-default)',
              background: 'var(--surface-card)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--ink-600)',
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          )}
        </div>

        <div
          style={{
            padding: mini ? '14px 8px' : '14px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <SectionLabel mini={mini}>Monitor</SectionLabel>

          <NavItem
            mini={mini}
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
            mini={mini}
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
            mini={mini}
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
                    borderRadius: 'var(--radius-pill)',
                  }}
                >
                  {openDeviations}
                </span>
              ) : undefined
            }
          />

          <NavItem
            mini={mini}
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

          <SectionLabel top={14} mini={mini}>Govern</SectionLabel>

          <NavItem
            mini={mini}
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

        </div>

        {/* ---- account, anchored to the bottom of the sidebar ----
             marginTop:auto rather than a fixed offset, so it sits at the foot
             of the rail whatever the nav above it grows to. */}
        <div
          style={{
            marginTop: 'auto',
            borderTop: '1px solid var(--border-default)',
            padding: mini ? '12px 8px 14px' : '12px 12px 14px',
          }}
        >
          {/* Collapsed, the account stacks: the avatar identifies who is signed
              in, the logout keeps its own tooltip. Both stay reachable. */}
          <div
            style={{
              display: 'flex',
              flexDirection: mini ? 'column' : 'row',
              alignItems: 'center',
              gap: mini ? 8 : 10,
              minWidth: 0,
            }}
          >
            <span
              style={{
                width: 32,
                height: 32,
                flex: '0 0 32px',
                borderRadius: 'var(--radius-pill)',
                background: 'var(--blue-050)',
                color: 'var(--blue-600)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                fontWeight: 600,
              }}
              title={mini ? `${me.user.name || me.user.username || me.user.email} · ${me.user.email}` : undefined}
            >
              {initials}
            </span>
            {!mini && (
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25, minWidth: 0 }}>
                <span
                  style={{
                    fontWeight: 600,
                    fontSize: 13,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={me.user.name || me.user.email}
                >
                  {me.user.name || me.user.username || me.user.email}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--ink-500)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={me.user.email}
                >
                  {me.user.email}
                </span>
              </div>
            )}
            <button
              className="hue-btn"
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
              style={{
                marginLeft: mini ? 0 : 'auto',
                width: 30,
                height: 30,
                flex: '0 0 30px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-default)',
                background: 'var(--surface-card)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: 'var(--ink-600)',
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ---------------- MAIN ---------------- */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* TOP BAR — three zones, each carrying something real:
             the section you are in, the search, and the state of the data. */}
        <div
          style={{
            height: HEADER_H,
            flex: `0 0 ${HEADER_H}px`,
            background: 'var(--surface-card)',
            borderBottom: '1px solid var(--border-default)',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '0 24px',
          }}
        >
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--ink-900)',
              whiteSpace: 'nowrap',
              flex: '0 0 auto',
            }}
          >
            {SECTION_TITLE[screen]}
          </span>

          {/* Capped, so it stops taking the whole middle of the bar. */}
          <div style={{ flex: 1, maxWidth: 420, position: 'relative', minWidth: 0 }}>
            <svg
              style={{ position: 'absolute', left: 12, top: 11, pointerEvents: 'none' }}
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
              ref={searchRef}
              className="hue-field"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                // Typing is what moves you, not focusing. Clicking the box used
                // to teleport you off whatever you were reading.
                if (e.target.value && !SEARCHABLE.has(screen)) setScreen('convos');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
              }}
              placeholder="Search callers, sites, SR numbers…"
              aria-label="Search"
              style={{
                width: '100%',
                height: 38,
                padding: '0 58px 0 36px',
                border: '1px solid transparent',
                borderRadius: 'var(--radius-pill)',
                fontSize: 13,
                color: 'var(--ink-900)',
                outline: 'none',
                background: 'var(--ink-050)',
                boxSizing: 'border-box',
              }}
            />
            {/* Hidden once there is text, since it is a hint, not a label. */}
            {!query && (
              <span
                style={{
                  position: 'absolute',
                  right: 10,
                  top: 9,
                  pointerEvents: 'none',
                  fontSize: 11,
                  fontWeight: 500,
                  color: 'var(--ink-500)',
                  background: 'var(--surface-card)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '2px 6px',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                ⌘K
              </span>
            )}
          </div>

          <div
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              flex: '0 0 auto',
            }}
          >
            {/* Counts and freshness, both from syncStatus. Absent rather than
                invented when the read failed. */}
            {sync && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.3 }}>
                <span style={{ fontSize: 12, color: 'var(--ink-700)', whiteSpace: 'nowrap' }}>
                  {sync.stored} call{sync.stored === 1 ? '' : 's'} ·{' '}
                  <b style={{ fontWeight: 600, color: sync.openDeviations ? 'var(--danger-500)' : 'var(--ink-700)' }}>
                    {sync.openDeviations}
                  </b>{' '}
                  open
                </span>
                <span style={{ fontSize: 11, color: 'var(--ink-500)', whiteSpace: 'nowrap' }}>
                  {!sync.reachable
                    ? 'Call channel unreachable'
                    : sync.awaitingIngest
                      ? `${sync.awaitingIngest} waiting to be pulled in`
                      : 'Up to date'}
                  {sync.lastIngestAt ? ` · last call ${ago(sync.lastIngestAt)}` : ''}
                </span>
              </div>
            )}

            {refreshNote ? (
              <span style={{ fontSize: 12, color: 'var(--ink-500)', whiteSpace: 'nowrap' }}>
                {refreshNote}
              </span>
            ) : null}

            <button
              className="hue-btn"
              onClick={refresh}
              disabled={refreshing}
              title="Pull in calls that have arrived since this page loaded"
              aria-label="Refresh calls"
              aria-busy={refreshing}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                height: 36,
                padding: '0 13px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-default)',
                background: 'var(--surface-card)',
                fontSize: 13,
                fontWeight: 500,
                color: refreshing ? 'var(--ink-500)' : 'var(--ink-700)',
                cursor: refreshing ? 'default' : 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {/* The app's own spinner, which stops spinning for anyone who
                  asked for reduced motion. An inline animation would not. */}
              {refreshing ? (
                <span className="hue-spinner" />
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <polyline points="21 3 21 9 15 9" />
                </svg>
              )}
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* SCROLL AREA */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {screen === 'overview' && (
            // Remounted by a refresh: Overview holds no typing or filters worth
            // preserving, and its counts are the first thing a pull changes.
            <Overview
              key={refreshSignal}
              onCounts={(calls, open) => {
                setCallCount(calls);
                setOpenDeviations(open);
              }}
              onOpenDeviation={openDeviation}
              onNavigate={setScreen}
            />
          )}
          {/* Given the signal rather than remounted — a refresh must not throw
              away a search or a filter the user typed. */}
          {screen === 'convos' && (
            <Conversations onOpen={openCall} refreshSignal={refreshSignal} search={query} />
          )}
          {screen === 'convo' && callId && (
            <ConversationDetail
              id={callId}
              onBack={() => setScreen('convos')}
              onOpenDeviation={openDeviation}
            />
          )}
          {screen === 'ints' && (
            <Interventions
              onOpen={openDeviation}
              onBrowseCalls={() => setScreen('convos')}
              search={query}
            />
          )}
          {screen === 'int' && deviationId && (
            <InterventionDetail
              deviationId={deviationId}
              onBack={() => setScreen('ints')}
              onOpenCall={openCall}
              onViewPattern={() => setScreen('patterns')}
            />
          )}
          {screen === 'patterns' && <Patterns onOpenDeviation={openDeviation} />}
          {screen === 'scope' && <ScopeEvals search={query} />}
        </div>
      </div>
    </div>
  );
}
