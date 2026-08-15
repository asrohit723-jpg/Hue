import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ConversationView } from '../lib/vibe';
import { BootSkeleton } from './BootSkeleton';
import { LoadError } from '../components/Chrome';
import { clock, duration, evalTone, initials, label, sentimentTone } from '../lib/tone';
// `inFlight` only — the grading STAGE is shown on the conversation record, not
// here. It still drives the poll below, which refreshes the result cell when a
// call finishes grading.
import { inFlight } from '../lib/grading';
import { runCallAnalysis } from '../lib/judges';
import { channelLabel, channelTone } from '../lib/channel';
import { FilterBar, FilterSelect } from '../components/Filters';
import { page } from '../lib/layout';

/**
 * Call logs — ported from the CONVERSATIONS block of the design
 * ("Helpdesk Governance.dc.html", lines 1722-1786). Column widths, the 880px
 * minimum table width, the header band and every type size are the design's.
 *
 * The design's rows carry invented issue text and outcome labels. Here each
 * row is one stored conversation: the eval status the checks produced, the
 * service request the join actually resolved, and a snippet that is the
 * caller's own opening line read from the transcript rather than a summary.
 */

const FILTERS = ['All calls', 'Flagged', 'Passed', 'No SR created'] as const;
type Filter = (typeof FILTERS)[number];

const COLS = '104px minmax(240px,2fr) 130px 104px 74px 24px';

const headCell: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: 'var(--ink-600)',
  fontWeight: 500,
};

const truncate: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

type Sync = {
  awaitingIngest: number | null;
  awaitingGrading: number;
  reachable: boolean;
  intervalSeconds: number;
};

export function Conversations({
  onOpen,
  refreshSignal = 0,
  search = '',
}: {
  onOpen: (id: string) => void;
  /** Bumped by the header's Refresh once a pull has finished. */
  refreshSignal?: number;
  /** The one search box, in the top bar. This screen no longer has its own. */
  search?: string;
}) {
  const [sync, setSync] = useState<Sync | null>(null);
  // Every site the account has, not just those that reached a conversation.
  // Live calls carry no site, so deriving the filter from the list showed
  // whichever sites a CMMS join had happened to resolve — usually one.
  const [cmmsSites, setCmmsSites] = useState<string[]>([]);
  const [items, setItems] = useState<ConversationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [nudging, setNudging] = useState(false);
  // Calls this tab won the claim for and still owes a scorecard. Held in state
  // rather than inside the fetch effect: bumping the nonce tears that effect
  // down, and an analysis running inside it would be cancelled halfway.
  const [toScore, setToScore] = useState<string[]>([]);
  const [scoring, setScoring] = useState<{ at: number; of: number } | null>(null);
  const [filter, setFilter] = useState<Filter>('All calls');
  const [site, setSite] = useState('All sites');

  // One nudge per mount. Without this the refresh a nudge triggers would nudge
  // again on the way back, and a page that grades on every render is exactly
  // the runaway this whole claim mechanism is meant to prevent.
  const nudged = useRef(false);

  // A refresh that pulls in new calls should get them graded, not leave them at
  // "awaiting grading" for up to fifteen minutes. Re-arming the guard lets the
  // fetch below nudge once for what just arrived — still one nudge per refresh.
  //
  // Declared BEFORE that effect on purpose: effects run in declaration order,
  // so re-arming here happens before the fetch reads the guard. Below it, the
  // nudge would always be one refresh behind.
  useEffect(() => {
    if (refreshSignal > 0) nudged.current = false;
  }, [refreshSignal]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setItems(null);
      setError(null);
      try {
        const rows = await api.listConversations(200);
        if (!cancelled) setItems(rows);
        // A light read — one list-sites call, not the whole overview. If it
        // fails the filter falls back to the sites seen on conversations, so it
        // is never empty, just shorter.
        api
          .sites(200)
          .then((r) => {
            if (!cancelled) setCmmsSites(r.sites.map((x) => x.name).filter(Boolean));
          })
          .catch(() => {});
        // Read-only: reports how far behind the channel we are and how much is
        // waiting on the grading job. Ingest never happens from here — that
        // path has no claim and two reloads would race to write the same call.
        try {
          const st = await api.syncStatus();
          if (cancelled) return;
          setSync(st);

          // Grading, unlike ingest, is claimed per call on the server — so it
          // IS safe to ask for from a page load. Rather than leaving someone
          // looking at a backlog for up to fifteen minutes, take a bite out of
          // it now. Whoever else has this page open at the same moment gets a
          // different call, or nothing; never this one.
          if (st.awaitingGrading > 0 && !nudged.current) {
            nudged.current = true;
            setNudging(true);
            try {
              const res = await api.nudgeGrading();
              if (!cancelled && res.graded > 0) {
                // These ids are the claim, in the only form the browser needs:
                // the server hands back exactly what THIS nudge claimed and
                // graded. Another tab's nudge gets a different set, or none.
                setToScore(res.details.map((d) => d.id));
                setNonce((n) => n + 1);
              }
            } catch {
              // The job still owns the backlog. A nudge that fails changes
              // nothing and must not be reported as a broken call list.
            } finally {
              if (!cancelled) setNudging(false);
            }
          }
        } catch {
          // A sync read failing must not take the call list down with it.
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce, refreshSignal]);


  /**
   * Fill the scorecard for the calls this tab just claimed.
   *
   * GRADE-ONCE-PER-CLAIM, not grade-on-every-open. The list is not consulted
   * for what to score — only the ids the server handed back from our own
   * nudge, which is the claim it granted us. A call nobody claimed here is
   * never touched, and a call already graded is never re-graded, because the
   * nudge only ever claims one whose eval_status is still 'not_evaluated'.
   *
   * ONLY THE CALL ANALYST RUNS HERE, deliberately. It writes the scorecard —
   * quality_score and the grade row — and creates no deviations and no change
   * to eval_status, so it cannot move the finding count or the compliance
   * score while somebody browses. The semantic judges DO write deviations, and
   * running those automatically is exactly the drift that was removed when
   * grading stopped happening on open. They stay behind Run evals.
   *
   * Sequential on purpose: these are model calls, and firing a page-load's
   * worth of them at once helps nobody.
   *
   * Cancelled only on unmount. A nonce bump must not kill work in flight.
   */
  useEffect(() => {
    if (!toScore.length) return;
    let unmounted = false;
    const queue = toScore;

    (async () => {
      for (let i = 0; i < queue.length; i++) {
        if (unmounted) return;
        setScoring({ at: i + 1, of: queue.length });
        try {
          await runCallAnalysis(queue[i]);
        } catch {
          // A call that could not be analysed keeps its checks and reports
          // "checks run · not analysed". It is not retried — that would be
          // re-grading a graded call — and Run evals remains the way back.
        }
      }
      if (unmounted) return;
      setScoring(null);
      setToScore([]);
      // Now the scores exist, so the rows can show them.
      setNonce((n) => n + 1);
    })();

    return () => {
      unmounted = true;
    };
  }, [toScore]);

  // Is anything still moving? Drives the poll below, and stops it dead once
  // every call has settled — a quiet app should make no requests at all.
  const pending = (items ?? []).some((c) => inFlight(c.grading));

  /**
   * Keep the grading column honest without a manual reload.
   *
   * Polls the LIGHT status handler — no CMMS read, no transcript, no findings —
   * and merges it into the rows already on screen. When a call settles, the
   * full list is re-read once, because the verdict and the finding count come
   * from a query this one deliberately does not run.
   */
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;

    const id = window.setInterval(async () => {
      try {
        const { items: states } = await api.gradingStatus();
        if (cancelled) return;
        const byId = new Map(states.map((s) => [s.id, s]));

        let settled = false;
        setItems((prev) =>
          (prev ?? []).map((c) => {
            const next = byId.get(c.id);
            if (!next || next.status === c.grading?.status) return c;
            if (!inFlight(next)) settled = true;
            return { ...c, grading: next };
          }),
        );
        if (settled) setNonce((n) => n + 1);
      } catch {
        // A poll that fails is not an error worth showing — the next one is
        // four seconds away, and the list on screen is still real.
      }
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pending]);

  const sites = useMemo(
    () => [
      'All sites',
      ...Array.from(
        new Set([
          ...cmmsSites,
          // Unioned, so a site somehow absent from the account list is still
          // filterable rather than unreachable.
          ...(items ?? []).map((c) => c.site).filter((s): s is string => !!s),
        ]),
      ).sort(),
    ],
    [items, cmmsSites],
  );

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (items ?? []).filter((c) => {
      if (filter === 'Flagged' && c.evalStatus !== 'flagged') return false;
      if (filter === 'Passed' && c.evalStatus !== 'passed') return false;
      // "No SR created" is about ground truth, not about what the agent claimed.
      if (filter === 'No SR created' && c.srRecordId) return false;
      if (site !== 'All sites' && c.site !== site) return false;
      if (!needle) return true;
      return [c.caller.name, c.caller.phone, c.site, c.srRecordId, c.callId, c.snippet]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [items, search, filter, site]);

  if (error) {
    return (
      <div style={page('24px 28px')}>
        <LoadError message={error} onRetry={() => setNonce((n) => n + 1)} />
      </div>
    );
  }
  if (!items) return <BootSkeleton label="Loading calls…" />;

  const clearAll = () => {
    setFilter('All calls');
    setSite('All sites');
  };

  return (
    <div style={page('24px 28px 40px')}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1
            style={{
              fontSize: 24,
              lineHeight: '30px',
              fontWeight: 700,
              margin: 0,
              letterSpacing: '-.01em',
            }}
          >
            Call logs
          </h1>
          <p style={{ margin: '5px 0 0', color: 'var(--ink-600)' }}>
            Every call the agent took. Open one to read the full record.
          </p>
        </div>
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
        </div>
      </div>

      {/* The one filter control, same as every other screen. */}
      <div style={{ margin: '14px 0 0' }}>
        <FilterBar
          dirty={filter !== 'All calls' || site !== 'All sites'}
          onClear={clearAll}
        >
          <FilterSelect
            label="Result"
            allLabel="All calls"
            options={FILTERS.filter((f) => f !== 'All calls').map((f) => ({ value: f, label: f }))}
            values={filter === 'All calls' ? [] : [filter]}
            onChange={(next) => setFilter((next[0] as Filter) ?? 'All calls')}
          />
          <FilterSelect
            label="Site"
            allLabel="All sites"
            options={sites.filter((x) => x !== 'All sites').map((x) => ({ value: x, label: x }))}
            values={site === 'All sites' ? [] : [site]}
            onChange={(next) => setSite(next[0] ?? 'All sites')}
          />
        </FilterBar>
      </div>

      {/* `scoring` is in the condition because the scorecards are still being
          filled after awaitingGrading has already dropped to zero — without it
          the banner vanishes mid-work and the app looks idle while it is not. */}
      {sync && (sync.awaitingIngest || sync.awaitingGrading || scoring || !sync.reachable) ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            marginTop: 12,
            padding: '9px 14px',
            borderRadius: 'var(--radius-sm)',
            background: sync.reachable ? 'var(--blue-025)' : 'var(--warning-050)',
            border: `1px solid ${sync.reachable ? 'var(--blue-100)' : 'var(--warning-500)'}`,
            fontSize: 12,
            color: sync.reachable ? 'var(--blue-600)' : 'var(--warning-700)',
            lineHeight: '18px',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          {!sync.reachable ? (
            <span>
              The call channel is unreachable, so this list may be behind. The calls shown are
              still real.
            </span>
          ) : (
            <>
              {sync.awaitingIngest ? (
                <span>
                  <b style={{ fontWeight: 600 }}>{sync.awaitingIngest}</b>{' '}
                  {sync.awaitingIngest === 1 ? 'call has' : 'calls have'} arrived on the channel and
                  {sync.awaitingIngest === 1 ? ' is' : ' are'} not stored yet.
                </span>
              ) : null}
              {sync.awaitingGrading ? (
                <span>
                  <b style={{ fontWeight: 600 }}>{sync.awaitingGrading}</b>{' '}
                  {nudging ? 'awaiting grading — grading now…' : 'awaiting grading.'}
                </span>
              ) : null}
              {/* The scorecard half, which outlives the grading half: the
                  checks finish in seconds and the analyst takes tens of them. */}
              {scoring ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span className="hue-spinner" aria-hidden="true" />
                  Scoring {scoring.at} of {scoring.of} — this finishes on its own
                </span>
              ) : null}
              {/* The interval, not a countdown — the app cannot see when the job
                  last fired, and inventing a number would be worse than none.
                  While a nudge is in flight this would be actively misleading:
                  the wait is seconds, not the interval, so it stands down. */}
              {!nudging && !scoring ? (
                <span style={{ marginLeft: 'auto', color: 'var(--ink-600)' }}>
                  Syncs automatically every {Math.round(sync.intervalSeconds / 60)} minutes
                </span>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <div
        style={{
          background: 'var(--surface-card)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)',
          marginTop: 12,
          overflow: 'hidden',
        }}
      >
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
              ...headCell,
            }}
          >
            <span>Result</span>
            <span>Caller</span>
            <span>Outcome</span>
            <span>Sentiment</span>
            <span>Time</span>
            <span />
          </div>
          {rows.map((c) => (
            <CallRow key={c.id} c={c} onOpen={() => onOpen(c.id)} />
          ))}
        </div>
        {rows.length === 0 && (
          <div style={{ padding: '44px 24px', textAlign: 'center' }}>
            <div style={{ fontWeight: 600 }}>No calls match</div>
            <p style={{ margin: '6px 0 14px', fontSize: 13, color: 'var(--ink-600)' }}>
              Nothing matches this search and filter.
            </p>
            <button className="hue-btn"
              onClick={clearAll}
              style={{
                height: 38,
                padding: '0 16px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-default)',
                background: 'var(--surface-card)',
                fontWeight: 500,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Clear search and filters
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function CallRow({ c, onOpen }: { c: ConversationView; onOpen: () => void }) {
  const ev = evalTone(c.evalStatus);
  const ct = channelTone(c.channel);
  const sent = sentimentTone(c.sentiment);
  // Live call logs usually have no caller name, so this is the phone number.
  const name = c.callerLabel;
  // The design tints the avatar by whether a record exists — the same red that
  // marks a missing service request everywhere else in the app.
  // Neutral: an identity glyph, not a status light. A call whose record is
  // missing is reported by the Result column, which is what checked.
  const avatarBg = 'var(--ink-100)';

  return (
    <div
      onClick={onOpen}
      className="hue-row"
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      tabIndex={0}
      style={{
        display: 'grid',
        minWidth: 880,
        gridTemplateColumns: COLS,
        gap: 14,
        alignItems: 'center',
        padding: '12px 16px',
        borderBottom: '1px solid var(--ink-100)',
        cursor: 'pointer',
        background: 'var(--surface-card)',
      }}
    >
      {/* The RESULT, and only the result. Where a call is in grading belongs
          on the record itself, not on every row of the list — the stage is
          transient and the list is for scanning outcomes. The poll above still
          refreshes this cell the moment a call finishes grading. */}
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '.03em',
          color: ev.fg,
        }}
      >
        <span
          style={{ width: 7, height: 7, borderRadius: 'var(--radius-pill)', background: ev.fg, flex: '0 0 7px' }}
        />
        {c.evalStatus === 'not_evaluated' ? 'Awaiting grading' : label(c.evalStatus)}
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
        <span
          style={{
            width: 32,
            height: 32,
            flex: '0 0 32px',
            borderRadius: 'var(--radius-pill)',
            background: avatarBg,
            color: 'var(--ink-700)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {initials(c.caller.name) !== '?' ? initials(c.caller.name) : '☎'}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
            <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{name}</span>
            {/* How it arrived. Shown on every row, not only the unusual ones —
                a channel that appears only sometimes reads as an exception
                rather than as a fact about every conversation. */}
            <span
              style={{
                flex: '0 0 auto',
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '.03em',
                textTransform: 'uppercase',
                padding: '1px 6px',
                borderRadius: 'var(--radius-sm)',
                background: ct.bg,
                color: ct.fg,
              }}
            >
              {channelLabel(c.channel)}
            </span>
            <span title={c.site ?? ''} style={{ fontSize: 12, color: 'var(--ink-500)', ...truncate }}>
              {c.site ?? '—'}
            </span>
          </div>
          <div
            title={c.snippet ?? ''}
            style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 2, ...truncate }}
          >
            {c.snippet ?? 'No caller turn recorded'}
          </div>
        </div>
      </div>

      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          padding: '2px 8px',
          borderRadius: 'var(--radius-pill)',
          justifySelf: 'start',
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
          background: c.srRecordId ? 'var(--success-050)' : 'var(--danger-050)',
          color: c.srRecordId ? 'var(--success-700)' : 'var(--danger-500)',
        }}
      >
        {c.srRecordId ? `SR ${c.srRecordId}` : 'No SR created'}
      </span>

      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          padding: '2px 8px',
          borderRadius: 'var(--radius-pill)',
          background: sent.bg,
          color: sent.fg,
          justifySelf: 'start',
          whiteSpace: 'nowrap',
        }}
      >
        {c.sentiment ? label(c.sentiment) : 'Unknown'}
      </span>

      <div>
        <div style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{clock(c.startedAt)}</div>
        <div
          style={{ fontSize: 11, color: 'var(--ink-500)', fontVariantNumeric: 'tabular-nums' }}
        >
          {duration(c.durationSec)}
        </div>
      </div>

      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--ink-400)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
    </div>
  );
}
