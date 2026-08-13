import { useEffect, useState } from 'react';
import {
  api,
  type ConversationView,
  type DeviationWithEvidence,
  type TurnWithToolIO,
} from '../lib/vibe';
import { runSemanticCriterion, SEMANTIC_CRITERIA } from '../lib/judges';
import { BootSkeleton } from './BootSkeleton';
import { LoadError } from '../components/Chrome';
import criteriaSeed from '../../evals/criteria.seed.json';
import { WIRED_CRITERIA, layerOf } from '../lib/criteria';

import { avatarColor, clock, duration, evalTone, initials, label, sentimentTone } from '../lib/tone';
import { page } from '../lib/layout';

/**
 * Call detail — the full CONVERSATION DETAIL block of the design
 * ("Helpdesk Governance.dc.html", lines 1791-1995): the recording bar, the
 * chat-bubble transcript with tool calls inline, the call summary, the CMMS
 * ground-truth panel that turns red when the promised record is not there, and
 * the tabbed quality card — Scorecard, Eval verdict, Sentiment.
 *
 * Every element of the design is present. Where the data behind one does not
 * exist, the element stays and says so — an empty meter and a "—" are honest,
 * where a fabricated number is not. Specifically:
 *
 *   - The recording bar renders, and reports whether a recording exists at all
 *     (live call logs carry a recordingFileId). Playback is not wired, so the
 *     transport is disabled rather than animating over silence.
 *   - The scorecard's four measures — latency, STT, TTS, response quality — are
 *     in the frozen contract but nothing populates them yet, so each row shows
 *     an empty meter and "not measured" instead of the design's hardcoded
 *     88 / 94 / 91.
 *   - The sentiment strip shows the ONE end-of-call sentiment we hold, as a
 *     single band. The design fabricates a ten-segment arc per sentiment; a
 *     shape implying we tracked sentiment over time would be a lie about what
 *     was measured.
 *   - Tool calls render inline exactly as designed, and a call whose channel
 *     records none says that in the same slot rather than leaving a gap.
 *
 * Everything else is read from the call: the transcript from the connection or
 * the app DB, and the service request fetched live from the CMMS at read time.
 */

interface Loaded {
  conversation: ConversationView;
  deviations: DeviationWithEvidence[];
  cmmsRecord: Record<string, unknown> | null;
  transcriptSource: string;
  recordingFileId: number | null;
  aiSummary: string | null;
  aiTags: string | null;
  satisfaction: string | null;
}

type QualityTab = 'score' | 'eval' | 'sentiment';

const TAB_LABEL: Record<QualityTab, string> = {
  score: 'Scorecard',
  eval: 'Eval verdict',
  sentiment: 'Sentiment',
};


const panel: React.CSSProperties = {
  background: '#fff',
  border: '1px solid var(--border-default)',
  borderRadius: 8,
};
const railHead: React.CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid var(--border-default)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};
const microLabel: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
  color: 'var(--ink-500)',
  fontWeight: 500,
};

/** A CMMS value that may arrive as a scalar or as an expanded {name} object. */
function readField(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const named = o.name ?? o.displayName ?? o.subject ?? o.id;
    return named === undefined || named === null ? null : String(named);
  }
  return String(v);
}

/**
 * Turn the channel's HTML summary into headed sections.
 *
 * The upstream value is a fragment like
 * `<div><b>Issue Reported</b><br><ul><li>User X reported …</li></ul>…</div>`.
 * It is NOT injected as HTML — it comes from outside this app, and rendering
 * foreign markup for the sake of a bold heading is not a trade worth making.
 * Tags are stripped, `<b>` runs become headings, `<li>` items become lines.
 */
function parseAiSummary(html: string | null): Array<{ heading: string; body: string }> {
  if (!html) return [];
  const decode = (t: string) =>
    t
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  const strip = (t: string) => decode(t.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

  const sections: Array<{ heading: string; body: string }> = [];

  // The channel uses <b> for two different jobs: section headings, and emphasis
  // INSIDE a list item ("reported a filter fault at <b>Skyline, unit 100</b>").
  // Splitting on every <b> turns each emphasised phrase into a bogus heading, so
  // inline markup inside <li> is flattened first and only the structural <b>
  // survives to be split on.
  const flattened = html.replace(
    /<li>([\s\S]*?)<\/li>/gi,
    (_m, inner: string) => `<li>${inner.replace(/<\/?[bi]>/gi, '')}</li>`,
  );

  const parts = flattened.split(/<b>(.*?)<\/b>/i);
  // parts[0] is anything before the first heading; ignore it if empty.
  for (let i = 1; i < parts.length; i += 2) {
    const heading = strip(parts[i]);
    const rest = parts[i + 1] ?? '';
    const items = Array.from(rest.matchAll(/<li>([\s\S]*?)<\/li>/gi))
      .map((m) => strip(m[1]))
      .filter(Boolean);
    const body = items.length ? items.join(' ') : strip(rest);
    if (heading && body) sections.push({ heading, body });
  }
  // No headings at all — show it as one block rather than losing it.
  if (!sections.length) {
    const flat = strip(html);
    if (flat) sections.push({ heading: 'Call summary', body: flat });
  }
  return sections;
}

/** CMMS timestamps arrive as epoch millis. */
function stamp(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  const d = new Date(Number.isFinite(n) && n > 1e11 ? n : String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString([], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function ConversationDetail({
  id,
  onBack,
  onOpenDeviation,
}: {
  id: string;
  onBack: () => void;
  onOpenDeviation: (deviationId: string) => void;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [tab, setTab] = useState<QualityTab>('score');
  const [grading, setGrading] = useState<string | null>(null);
  const [gradeSummary, setGradeSummary] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setData(null);
      setError(null);
      setGradeSummary(null);
      try {
        const res = await api.getConversation(id);
        if (cancelled) return;
        setData(res);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, nonce]);

  /**
   * Grade this call's semantic criteria — only when asked.
   *
   * This used to run automatically on open, which meant simply browsing the app
   * changed the finding count and the compliance score underneath you. Grading
   * is a real, model-driven write; it belongs behind an explicit action so the
   * numbers hold still between deliberate runs.
   *
   * The judges run in the browser because a Studio Function's fetch aborts at
   * ~10s and the conformance judge takes 15-20s on a real transcript. Only the
   * model call is here — the server supplies the context and re-validates every
   * verdict before it becomes a finding.
   */
  async function runEvals() {
    setGradeSummary(null);
    try {
      const runs = [];
      for (const criterionId of SEMANTIC_CRITERIA) {
        setGrading(criterionId);
        runs.push(await runSemanticCriterion(id, criterionId));
      }
      const failed = runs.filter((r) => r.verdict === 'fail').length;
      const retracted = runs.filter((r) => r.retracted).length;
      const unavailable = runs.filter((r) => r.verdict === 'unavailable').length;
      setGradeSummary(
        [
          `${runs.length - unavailable} of ${runs.length} criteria graded`,
          failed ? `${failed} failed` : 'none failed',
          retracted ? `${retracted} retracted` : null,
          // A judge that never answered is UNKNOWN, never a pass — say so.
          unavailable ? `${unavailable} could not be reached` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      );
      setNonce((n) => n + 1);
    } catch (err) {
      setGradeSummary(err instanceof Error ? err.message : String(err));
    } finally {
      setGrading(null);
    }
  }

  if (error) {
    return (
      <div style={page('24px 28px')}>
        <LoadError message={error} onRetry={() => setNonce((n) => n + 1)} />
      </div>
    );
  }
  if (!data) return <BootSkeleton label="Loading call…" />;

  const { conversation: c, deviations, cmmsRecord } = data;
  const ev = evalTone(c.evalStatus);
  const sent = sentimentTone(c.sentiment);
  // Live call logs usually have no caller name, so this is the phone number.
  const name = c.callerLabel;
  const firstFinding = deviations[0] ?? null;
  const textTurns = c.transcript.filter((t) => !t.toolCall);
  // The tool call that failed, if one did — the missing-record panel quotes it
  // rather than describing the failure in the abstract.
  const failedTool = c.transcript.find((t) => t.toolCall && t.toolCall.status !== 'success');
  const aiSections = parseAiSummary(data.aiSummary);
  // The channel's own topic tags, when it produced any.
  const channelTags = (data.aiTags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  return (
    <div style={page('22px 32px 40px')}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: 'var(--ink-600)',
          marginBottom: 12,
        }}
      >
        <span
          onClick={onBack}
          style={{ cursor: 'pointer', color: 'var(--blue-500)', fontWeight: 500 }}
        >
          Conversations
        </span>
        <span>/</span>
        <span>{c.callId}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
        <span
          style={{
            width: 40,
            height: 40,
            flex: '0 0 40px',
            borderRadius: 999,
            background: c.srRecordId ? avatarColor(name) : 'var(--danger-500)',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {initials(c.caller.name) !== '?' ? initials(c.caller.name) : '☎'}
        </span>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 22, lineHeight: '28px', fontWeight: 700, margin: 0 }}>{name}</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--ink-600)', fontSize: 13 }}>
            {c.site ?? 'Site not resolved'} · {clock(c.startedAt)} · {duration(c.durationSec)}
            {/* The phone is the heading when there is no name — don't repeat it. */}
            {c.caller.name && c.caller.phone ? ` · ${c.caller.phone}` : ''}
            {gradeSummary && (
              <span style={{ color: 'var(--blue-600)', fontWeight: 500 }}> · {gradeSummary}</span>
            )}
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: '4px 11px',
              borderRadius: 999,
              background: ev.bg,
              color: ev.fg,
            }}
          >
            {label(c.evalStatus)}
          </span>
          {/* Grading is a deliberate act, not a side effect of opening a call —
              the count and the compliance score must hold still while browsing. */}
          <button
            onClick={runEvals}
            disabled={Boolean(grading)}
            title="Run the semantic judges against this call"
            style={{
              height: 36,
              padding: '0 14px',
              borderRadius: 4,
              border: '1px solid var(--border-default)',
              background: '#fff',
              color: grading ? 'var(--ink-500)' : 'var(--ink-900)',
              fontWeight: 500,
              fontSize: 13,
              cursor: grading ? 'progress' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              whiteSpace: 'nowrap',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            {grading ? `Grading ${grading}…` : 'Run evals'}
          </button>
          {firstFinding && (
            <button
              onClick={() => onOpenDeviation(firstFinding.id)}
              style={{
                height: 36,
                padding: '0 14px',
                borderRadius: 4,
                border: '1px solid var(--blue-500)',
                background: 'var(--blue-500)',
                color: '#fff',
                fontWeight: 500,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Open intervention
            </button>
          )}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1.35fr) minmax(360px,0.95fr)',
          gap: 20,
          alignItems: 'start',
        }}
      >
        {/* transcript */}
        <div style={panel}>
          <RecordingBar
            durationLabel={duration(c.durationSec)}
            recordingFileId={data.recordingFileId}
          />
          <div
            style={{
              padding: '14px 18px',
              borderBottom: '1px solid var(--border-default)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Transcript</h3>
            <span style={{ fontSize: 12, color: 'var(--ink-600)' }}>
              {textTurns.length} turns · tool calls shown inline
              {data.transcriptSource === 'live' ? ' · read live' : ''}
            </span>
          </div>
          <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {c.transcript.map((t, i) => (
              <Turn key={i} t={t} />
            ))}
            {c.transcript.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--ink-600)' }}>
                No transcript stored for this call.
              </div>
            )}
            {/* The design renders tool calls inline between the turns. The
                helpdesk voice channel logs none — get-call-tool-calls cannot
                resolve a voice thread yet — so the slot says so rather than
                closing up as though the agent used no tools. */}
            {c.transcript.length > 0 && !c.transcript.some((t) => t.toolCall) && (
              <div
                style={{
                  border: '1px dashed var(--border-default)',
                  background: 'var(--ink-050)',
                  borderRadius: 8,
                  padding: '10px 13px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  color: 'var(--ink-600)',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                </svg>
                <span style={{ fontFamily: 'var(--font-mono)' }}>No tool calls recorded</span>
                <span style={{ marginLeft: 'auto' }}>
                  This channel does not log them — see docs/live-call-ingest.md
                </span>
              </div>
            )}
          </div>
        </div>

        {/* right rail */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* call summary */}
          <div style={{ ...panel, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Call summary</h3>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: sent.bg,
                  color: sent.fg,
                }}
              >
                {c.sentiment ? label(c.sentiment) : 'Unknown'}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {(channelTags.length
                ? channelTags
                : [
                    c.site,
                    c.srRecordId ? 'SR raised' : 'No SR',
                    deviations.length ? 'Deviation' : 'Within scope',
                    label(c.status),
                  ])
                .filter((t): t is string => !!t)
                .map((t) => (
                  <span
                    key={t}
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      padding: '2px 9px',
                      borderRadius: 999,
                      border: '1px solid var(--border-default)',
                      color: 'var(--ink-700)',
                    }}
                  >
                    {t}
                  </span>
                ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
              {/* The channel summarises every call with its own model once the
                  call ends. That is real AI output already produced upstream, so
                  it is shown as written rather than replaced by prose this
                  screen assembles from the same facts. Where the channel has
                  none — an older call, or one it could not summarise — the
                  composed sections below stand in, and say what they are. */}
              {aiSections.length > 0 ? (
                aiSections.map((s) => (
                  <Section key={s.heading} heading={s.heading}>
                    {s.body}
                  </Section>
                ))
              ) : (
                <>
                  <Section heading="What the caller reported">
                    {c.snippet ??
                      textTurns.find((t) => t.performer === 'caller')?.message ??
                      'No caller turn recorded.'}
                  </Section>
                  <Section heading="What the agent did">
                    {c.srRecordId
                      ? `Raised service request ${c.srRecordId} in the CMMS, resolved back to this call.`
                      : c.srCreated
                        ? 'Confirmed to the caller that the issue was logged. No service request reached the CMMS.'
                        : 'Did not claim a service request was raised, and none was found.'}
                  </Section>
                </>
              )}
              <Section
                heading="Where it stands"
                fg={deviations.length ? 'var(--danger-700)' : 'var(--success-700)'}
              >
                {deviations.length
                  ? `${deviations.length} ${deviations.length === 1 ? 'finding' : 'findings'} against ${deviations
                      .map((d) => d.clauseRef)
                      .join(', ')}. Open in interventions for the proposed fix.`
                  : c.evalStatus === 'not_evaluated'
                    ? 'Not evaluated yet.'
                    : 'Passed every active criterion. No action needed.'}
              </Section>
              {aiSections.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--ink-500)' }}>
                  Summary written by the call channel's own model.
                </div>
              )}
            </div>
          </div>

          {/* CMMS ground truth */}
          <CmmsPanel
            rec={cmmsRecord}
            conversation={c}
            failedTool={failedTool}
            onOpenIntervention={firstFinding ? () => onOpenDeviation(firstFinding.id) : null}
          />

          {/* call quality — tabbed, exactly as the design */}
          <QualityCard
            conversation={c}
            deviations={deviations}
            tab={tab}
            onTab={setTab}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The recording transport, at the design's measurements.
 *
 * Live call logs carry a `recordingFileId`, so whether a recording EXISTS is
 * real and is reported. Streaming its bytes into an <audio> element is not
 * wired, so the transport stays disabled: a progress bar that animates over
 * nothing would be the most misleading control on the screen.
 */
function RecordingBar({
  durationLabel,
  recordingFileId,
}: {
  durationLabel: string;
  recordingFileId: number | null;
}) {
  const has = recordingFileId !== null;
  return (
    <div
      style={{
        padding: '12px 18px',
        borderBottom: '1px solid var(--border-default)',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <button
        disabled
        title={has ? 'Playback is not wired yet' : 'No recording for this call'}
        aria-label="Play recording"
        style={{
          width: 36,
          height: 36,
          flex: '0 0 36px',
          borderRadius: 999,
          border: `1px solid ${has ? 'var(--blue-500)' : 'var(--border-default)'}`,
          background: has ? 'var(--blue-500)' : 'var(--ink-100)',
          color: has ? '#fff' : 'var(--ink-400)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'not-allowed',
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5.5v13l11-6.5z" />
        </svg>
      </button>
      <div style={{ flex: 1, height: 6, borderRadius: 999, background: 'var(--ink-100)' }}>
        <div style={{ height: '100%', borderRadius: 999, background: 'var(--blue-500)', width: '0%' }} />
      </div>
      <span
        style={{
          fontSize: 12,
          color: 'var(--ink-600)',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        {has ? `0:00 / ${durationLabel}` : 'No recording'}
      </span>
      <button
        disabled={!has}
        title={has ? `Recording file ${recordingFileId}` : 'No recording for this call'}
        aria-label="Download recording"
        style={{
          width: 34,
          height: 34,
          borderRadius: 4,
          border: '1px solid var(--border-default)',
          background: '#fff',
          color: has ? 'var(--ink-600)' : 'var(--ink-300)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: has ? 'pointer' : 'not-allowed',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <path d="M12 15V3" />
        </svg>
      </button>
    </div>
  );
}

/** The design's three-tab quality card. */
function QualityCard({
  conversation: c,
  deviations,
  tab,
  onTab,
}: {
  conversation: ConversationView;
  deviations: DeviationWithEvidence[];
  tab: QualityTab;
  onTab: (t: QualityTab) => void;
}) {
  const ev = evalTone(c.evalStatus);
  const failedBy = new Map(deviations.map((d) => [d.criterionId, d]));
  const notEvaluated = c.evalStatus === 'not_evaluated';

  return (
    <div style={panel}>
      <div
        style={{
          padding: '4px 8px',
          borderBottom: '1px solid var(--border-default)',
          display: 'flex',
          gap: 2,
        }}
      >
        {(Object.keys(TAB_LABEL) as QualityTab[]).map((k) => (
          <button
            key={k}
            onClick={() => onTab(k)}
            style={{
              flex: 1,
              height: 36,
              border: 'none',
              background: tab === k ? 'var(--blue-025)' : 'transparent',
              color: tab === k ? 'var(--blue-600)' : 'var(--ink-600)',
              fontWeight: 600,
              fontSize: 13,
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            {TAB_LABEL[k]}
          </button>
        ))}
      </div>

      {tab === 'score' && <ScoreTab conversation={c} />}
      {tab === 'eval' && (
        <EvalTab
          failedBy={failedBy}
          notEvaluated={notEvaluated}
          evalFg={ev.fg}
          failedCount={deviations.length}
        />
      )}
      {tab === 'sentiment' && <SentimentTab conversation={c} />}
    </div>
  );
}

/**
 * Scorecard.
 *
 * `Scorecard` in the frozen contract carries latencyMs, sttAccuracy, ttsQuality
 * and responseQuality, and nothing populates any of them — no scorecard row has
 * ever been written. The design hardcodes 88 / 94 / 91; those numbers describe
 * nothing, so each row keeps its meter and reports that it was not measured.
 */
function ScoreTab({ conversation: c }: { conversation: ConversationView }) {
  const rows = [
    { label: 'Latency', value: null as number | null, display: 'not measured' },
    { label: 'Speech-to-text accuracy', value: null as number | null, display: 'not measured' },
    { label: 'Text-to-speech quality', value: null as number | null, display: 'not measured' },
    {
      label: 'Response quality',
      value: c.qualityScore && c.qualityScore > 0 ? c.qualityScore : null,
      display: c.qualityScore && c.qualityScore > 0 ? `${c.qualityScore} / 100` : 'not scored',
    },
  ];

  const overall = c.qualityScore && c.qualityScore > 0 ? String(c.qualityScore) : '—';

  return (
    <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: 'var(--ink-600)' }}>Overall score</span>
        <span
          style={{
            fontWeight: 700,
            fontFamily: 'var(--font-display)',
            fontSize: 20,
            color: overall === '—' ? 'var(--ink-400)' : 'var(--ink-900)',
          }}
        >
          {overall}
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.label} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>{r.label}</span>
            <span
              style={{
                color: r.value === null ? 'var(--ink-400)' : 'var(--ink-600)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {r.display}
            </span>
          </div>
          <div
            style={{ height: 6, borderRadius: 999, background: 'var(--ink-100)', overflow: 'hidden' }}
          >
            <div
              style={{
                height: '100%',
                width: `${r.value ?? 0}%`,
                background:
                  r.value === null
                    ? 'transparent'
                    : r.value >= 85
                      ? 'var(--success-500)'
                      : r.value >= 65
                        ? 'var(--warning-500)'
                        : 'var(--danger-500)',
                borderRadius: 999,
              }}
            />
          </div>
        </div>
      ))}
      <p style={{ margin: 0, fontSize: 11, color: 'var(--ink-500)', lineHeight: '16px' }}>
        Latency, speech-to-text and text-to-speech are not captured by the call channel yet, so
        they are shown unmeasured rather than estimated.
      </p>
    </div>
  );
}

/**
 * Eval verdict — a row per criterion the engine actually grades, ticked or
 * crossed, with its clause and the finding's own words on a failure.
 *
 * Only criteria this engine runs are listed. A tick means "checked and did not
 * fail"; nothing is ticked that was never checked.
 */
function EvalTab({
  failedBy,
  notEvaluated,
  evalFg,
  failedCount,
}: {
  failedBy: Map<string, DeviationWithEvidence>;
  notEvaluated: boolean;
  evalFg: string;
  failedCount: number;
}) {
  const seed = (criteriaSeed as { criteria: Array<{ id: string; title: string; clauseRef: string }> })
    .criteria;
  const byId = new Map(seed.map((s) => [s.id, s]));

  return (
    <div>
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--ink-100)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {/* The SOW carries no version — criteria.seed.json has no such field —
            so the count of criteria stands in for it rather than a made-up
            "v4.2". */}
        <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>
          against SOW · {seed.length} criteria
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: evalFg }}>
          {notEvaluated
            ? 'awaiting evaluation'
            : `${failedCount} of ${WIRED_CRITERIA.size} failed`}
        </span>
      </div>

      {notEvaluated ? (
        <div style={{ padding: '14px 16px', fontSize: 13, color: 'var(--ink-600)' }}>
          This call has not been evaluated yet.
        </div>
      ) : (
        Array.from(WIRED_CRITERIA).map((id) => {
          const layer = layerOf(id);
          const failed = failedBy.get(id);
          const meta = byId.get(id);
          return (
            <div
              key={id}
              style={{
                padding: '11px 16px',
                borderBottom: '1px solid var(--ink-100)',
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 999,
                  background: failed ? 'var(--danger-500)' : 'var(--success-050)',
                  color: failed ? '#fff' : 'var(--success-700)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                  flex: '0 0 16px',
                  marginTop: 2,
                }}
              >
                {failed ? '✕' : '✓'}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: failed ? 'var(--danger-700)' : 'var(--ink-900)',
                  }}
                >
                  {meta?.title ?? id}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 2 }}>
                  Clause {failed?.clauseRef ?? meta?.clauseRef ?? '—'} · {layer}
                </div>
                {failed && (
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--danger-700)',
                      background: 'var(--danger-050)',
                      borderRadius: 6,
                      padding: '7px 9px',
                      marginTop: 6,
                      lineHeight: '17px',
                    }}
                  >
                    {failed.summary}
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

/**
 * Sentiment.
 *
 * The design draws a ten-segment arc from a per-sentiment pattern, implying
 * sentiment was tracked across the call. It was not: the channel reports one
 * satisfaction level for the whole call. The strip stays, as a single band of
 * that one real value, captioned for what it is.
 */
function SentimentTab({ conversation: c }: { conversation: ConversationView }) {
  const tone = sentimentTone(c.sentiment);
  const band = c.sentiment
    ? c.sentiment === 'happy'
      ? 'var(--success-500)'
      : c.sentiment === 'frustrated'
        ? 'var(--warning-500)'
        : c.sentiment === 'distressed'
          ? 'var(--danger-500)'
          : 'var(--ink-200)'
    : 'var(--ink-100)';

  return (
    <div style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: 'var(--ink-600)' }}>Caller sentiment</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 999,
            background: tone.bg,
            color: tone.fg,
          }}
        >
          {c.sentiment ? label(c.sentiment) : 'Unknown'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 3, marginTop: 12 }}>
        <div style={{ flex: 1, height: 10, borderRadius: 2, background: band }} />
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11,
          color: 'var(--ink-500)',
          marginTop: 6,
        }}
      >
        <span>0:00</span>
        <span>{duration(c.durationSec)}</span>
      </div>
      <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--ink-500)', lineHeight: '16px' }}>
        One reading for the whole call — the channel reports satisfaction at the end, not over
        time, so this is shown as a single band rather than a trend.
      </p>
    </div>
  );
}

function Section({
  heading,
  fg,
  children,
}: {
  heading: string;
  fg?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={microLabel}>{heading}</div>
      <p
        style={{
          margin: '3px 0 0',
          fontSize: 13,
          color: fg ?? 'var(--ink-900)',
          lineHeight: '19px',
          textWrap: 'pretty',
        }}
      >
        {children}
      </p>
    </div>
  );
}

/**
 * One transcript entry. Caller and agent are chat bubbles on opposite sides;
 * a tool call spans the full width so the record it did or did not create reads
 * as an event in the call rather than as something either party said.
 */
function Turn({ t }: { t: TurnWithToolIO }) {
  if (t.toolCall) {
    const ok = t.toolCall.status === 'success';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
        <div
          style={{
            width: '100%',
            border: `1px solid ${ok ? 'var(--border-default)' : 'var(--danger-500)'}`,
            background: ok ? 'var(--ink-050)' : 'var(--danger-050)',
            borderRadius: 8,
            padding: '10px 13px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                fontWeight: 500,
                color: ok ? 'var(--ink-700)' : 'var(--danger-700)',
              }}
            >
              {t.toolCall.name}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '1px 8px',
                borderRadius: 999,
                background: ok ? 'var(--success-050)' : 'rgba(182,25,25,0.12)',
                color: ok ? 'var(--success-700)' : 'var(--danger-700)',
              }}
            >
              {t.toolCall.status}
            </span>
            {t.at && (
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-500)' }}>
                {t.at}
              </span>
            )}
          </div>
          {t.toolArgs && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--ink-700)',
                fontFamily: 'var(--font-mono)',
                lineHeight: '18px',
                wordBreak: 'break-word',
              }}
            >
              {t.toolArgs}
            </div>
          )}
          {(t.toolResult || t.toolCall.error) && (
            <div
              style={{
                fontSize: 12,
                color: ok ? 'var(--ink-700)' : 'var(--danger-700)',
                fontWeight: 500,
                wordBreak: 'break-word',
              }}
            >
              {t.toolCall.error ?? t.toolResult}
            </div>
          )}
        </div>
      </div>
    );
  }

  const isAgent = t.performer === 'agent';
  const isSystem = t.performer === 'system';
  const align = isAgent || isSystem ? 'flex-start' : 'flex-end';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align, gap: 4 }}>
      <div
        style={{
          maxWidth: '76%',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          alignItems: align,
        }}
      >
        <span
          style={{
            fontSize: 11,
            letterSpacing: '.03em',
            textTransform: 'uppercase',
            color: 'var(--ink-500)',
            fontWeight: 500,
          }}
        >
          {isAgent ? 'Agent' : isSystem ? 'System' : 'Caller'}
          {t.at ? ` · ${t.at}` : ''}
        </span>
        <div
          style={{
            background: isAgent ? 'var(--blue-025)' : isSystem ? 'var(--ink-050)' : '#fff',
            color: 'var(--ink-900)',
            border: `1px solid ${
              isAgent ? 'var(--blue-050)' : isSystem ? 'var(--border-default)' : 'var(--border-default)'
            }`,
            borderRadius: 10,
            padding: '9px 13px',
            lineHeight: '20px',
          }}
        >
          {t.message}
        </div>
      </div>
    </div>
  );
}

/**
 * Ground truth. Green-bordered with the record's real fields when the join
 * resolved; the design's red panel when it did not — and in that case the
 * detail comes from the call itself: what the agent told the caller, and the
 * error the tool actually returned.
 */
function CmmsPanel({
  rec,
  conversation,
  failedTool,
  onOpenIntervention,
}: {
  rec: Record<string, unknown> | null;
  conversation: ConversationView;
  failedTool: TurnWithToolIO | undefined;
  onOpenIntervention: (() => void) | null;
}) {
  const found = !!rec;
  const accent = found ? 'var(--ink-900)' : 'var(--danger-700)';

  // The design's eight fields, in its order, followed by the ones this CMMS
  // actually returns that the design has no slot for. A field the record does
  // not carry keeps its label and shows "—": dropping the row would quietly
  // redesign the panel, and inventing a value would be worse.
  const fields = rec
    ? [
        { label: 'Category', value: readField(rec, 'category') },
        { label: 'Service group', value: readField(rec, 'serviceGroup') },
        { label: 'Site', value: readField(rec, 'site') },
        { label: 'Priority', value: readField(rec, 'urgency') },
        { label: 'Status', value: readField(rec, 'moduleState') },
        { label: 'Assignee', value: readField(rec, 'assignedTo') ?? readField(rec, 'assignee') },
        { label: 'Created', value: stamp(rec.sysCreatedTime) },
        { label: 'Requested window', value: readField(rec, 'requestedWindow') },
        // Real, and outside the design's eight — appended rather than dropped.
        {
          label: 'Request id',
          value:
            (readField(rec, 'localId') !== '0' ? readField(rec, 'localId') : null) ??
            readField(rec, 'id'),
        },
        { label: 'Requester', value: readField(rec, 'requester') },
        { label: 'Source', value: readField(rec, 'sourceType') },
        { label: 'Last modified', value: stamp(rec.sysModifiedTime) },
      ]
    : [];

  return (
    <div
      style={{
        background: '#fff',
        border: `1px solid ${found ? 'var(--border-default)' : 'var(--danger-500)'}`,
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div style={{ ...railHead, background: found ? '#fff' : 'var(--danger-050)' }}>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke={accent}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" />
          <path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" />
        </svg>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: accent }}>
          CMMS ground truth
        </h3>
        {/* The design says "Joined on call id"; this says how the join was
            really made, since that is what the panel is evidence of. */}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-500)' }}>
          {conversation.joinMethod === 'sr_number'
            ? 'Joined on SR number'
            : conversation.joinMethod === 'site_time'
              ? 'Joined on site + time'
              : 'No join resolved'}
        </span>
      </div>

      {found && rec ? (
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 14,
                fontWeight: 500,
                color: 'var(--blue-600)',
              }}
            >
              SR {conversation.srRecordId}
            </span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 999,
                background: 'var(--success-050)',
                color: 'var(--success-700)',
              }}
            >
              Record found
            </span>
          </div>
          {readField(rec, 'subject') && (
            <div style={{ fontWeight: 500 }}>{readField(rec, 'subject')}</div>
          )}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '10px 14px',
              fontSize: 13,
            }}
          >
            {fields.map((f) => (
              <div key={f.label} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>{f.label}</span>
                <span
                  style={{
                    wordBreak: 'break-word',
                    color: f.value === null ? 'var(--ink-400)' : 'var(--ink-900)',
                  }}
                >
                  {f.value ?? '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div
          style={{
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            background: 'var(--danger-050)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--danger-500)"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M15 9l-6 6M9 9l6 6" />
            </svg>
            <span style={{ fontWeight: 600, color: 'var(--danger-700)' }}>
              No matching record found
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--danger-700)', lineHeight: '19px' }}>
            {conversation.srCreated
              ? 'The agent confirmed a ticket to the caller, but no service request exists in the CMMS for this call.'
              : 'No service request exists in the CMMS for this call. The agent did not claim one was raised.'}
          </p>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 12,
              color: 'var(--danger-700)',
              background: 'rgba(182,25,25,0.06)',
              borderRadius: 6,
              padding: '10px 12px',
            }}
          >
            {failedTool?.toolCall && (
              <span>
                {failedTool.toolCall.name} returned{' '}
                <b>{failedTool.toolCall.error ?? failedTool.toolCall.status}</b>
              </span>
            )}
            {conversation.srNumberClaimed && (
              <span>
                Agent read back reference <b>{conversation.srNumberClaimed}</b>
              </span>
            )}
            <span>
              {conversation.srRecordId
                ? `Stored join points at ${conversation.srRecordId}, which the CMMS did not return.`
                : 'No service request id was ever returned to the agent.'}
            </span>
          </div>
          {onOpenIntervention && (
            <button
              onClick={onOpenIntervention}
              style={{
                height: 34,
                borderRadius: 4,
                border: '1px solid var(--danger-500)',
                background: 'var(--danger-500)',
                color: '#fff',
                fontWeight: 500,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Open intervention
            </button>
          )}
        </div>
      )}
    </div>
  );
}
