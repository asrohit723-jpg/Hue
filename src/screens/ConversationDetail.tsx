import { useEffect, useRef, useState } from 'react';
import {
  api,
  type CallGrade,
  type ConversationView,
  type DeviationWithEvidence,
  type TurnWithToolIO,
} from '../lib/vibe';
import { runSemanticCriterion, runCallAnalysis, SEMANTIC_CRITERIA, type CallAnalysis } from '../lib/judges';
import { BootSkeleton } from './BootSkeleton';
import { BackLink, LoadError } from '../components/Chrome';
import criteriaSeed from '../../evals/criteria.seed.json';
import { WIRED_CRITERIA, layerOf } from '../lib/criteria';

import { clock, duration, evalTone, initials, label, sentimentTone } from '../lib/tone';
import { gradingDetail, gradingLabel, gradingTone, inFlight } from '../lib/grading';
import {
  channelLabel,
  channelTone,
  identityLabel,
  skipHeading,
  type Channel,
  type NotApplicable,
} from '../lib/channel';
import { page } from '../lib/layout';

/**
 * Call detail — the full CONVERSATION DETAIL block of the design
 * ("Helpdesk Governance.dc.html", lines 1791-1995): the recording bar, the
 * chat-bubble transcript, the call summary, the CMMS
 * ground-truth panel that turns red when the promised record is not there, and
 * the tabbed quality card — Scorecard, Eval verdict, Sentiment.
 *
 * Every element of the design is present. Where the data behind one does not
 * exist, the element stays and says so — an empty meter and a "—" are honest,
 * where a fabricated number is not. Specifically:
 *
 *   - The recording bar plays the real recording, fetched on press. A call with
 *     none says so and the transport stays disabled.
 *   - The scorecard shows the ONE measure that exists, response quality. The
 *     design's other three — latency, STT, TTS — are in the frozen contract and
 *     nothing populates them, so they are a footnote rather than three empty
 *     meters reading "not measured", which looked broken while telling the
 *     truth.
 *   - The sentiment strip shows the ONE end-of-call sentiment we hold, as a
 *     single band. The design fabricates a ten-segment arc per sentiment; a
 *     shape implying we tracked sentiment over time would be a lie about what
 *     was measured.
 *   - Tool calls are not shown at all. Nothing imports them, so there is no
 *     slot and no empty state announcing their absence.
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
  /** Where the call is in grading. Present even when there is no grade yet. */
  grading: import('../lib/vibe').ConversationView['grading'];
  /** How the conversation arrived, and what that rules out checking on it. */
  channel: Channel | null;
  notApplicable: NotApplicable[];
}

type QualityTab = 'score' | 'eval' | 'sentiment';

const TAB_LABEL: Record<QualityTab, string> = {
  score: 'Scorecard',
  eval: 'Eval verdict',
  sentiment: 'Sentiment',
};


const panel: React.CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-lg)',
};
const railHead: React.CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid var(--border-default)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};
/**
 * One shape for every pill in the header.
 *
 * Fixed height and no shrinking: the pills used to size themselves off their
 * own text next to 36px buttons, so "Grading unavailable" and "Flagged" sat at
 * different heights and the row read as broken.
 */
const statusPill: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 26,
  padding: '0 11px',
  borderRadius: 'var(--radius-pill)',
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  flex: '0 0 auto',
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

/**
 * A stored grade, in the shape the tabs already read.
 *
 * Mapping into `CallAnalysis` rather than teaching the tabs a second shape is
 * the point: a grade loaded from the database and one just produced by Run
 * evals render through exactly the same code, so they cannot drift apart.
 *
 * `sentiment` falls back to 'unknown' — the tabs treat that as "the analyst
 * declined to say", which is what an empty column means.
 */
function storedAnalysis(g: CallGrade): CallAnalysis {
  return {
    applicable: g.applicable,
    responseQuality: g.responseQuality,
    responseQualityJustification: g.justification,
    sentiment: (g.sentiment || 'unknown') as CallAnalysis['sentiment'],
    sentimentReason: g.sentimentReason,
    overallAssessment: g.overallAssessment,
    criteriaSatisfied: g.criteriaSatisfied,
    criteriaBreached: g.criteriaBreached,
  };
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
  // How many criteria this run has attempted. Real, because the loop below
  // walks a known list — not a guess at how far a server-side pass has got.
  const [gradedSoFar, setGradedSoFar] = useState(0);
  // How many criteria this run will attempt — the seeded set plus whatever the
  // scope of work produced, so the progress count is real rather than assumed.
  const [gradeTotal, setGradeTotal] = useState<number>(SEMANTIC_CRITERIA.length);
  const [gradeSummary, setGradeSummary] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<CallAnalysis | null>(null);
  const [analysisChannelSentiment, setAnalysisChannelSentiment] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setData(null);
      setError(null);
      setGradeSummary(null);
      setAnalysis(null);
      try {
        const res = await api.getConversation(id);
        if (cancelled) return;
        setData(res);
        // The stored grade, shown on load. Its prose used to live only in the
        // state above, so a reload left the score with nothing explaining it.
        setAnalysis(res.grade ? storedAnalysis(res.grade) : null);
        setAnalysisChannelSentiment(res.grade?.sentimentChannel || null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, nonce]);

  /**
   * Watch this one call while its grading is still moving.
   *
   * Polls the light status handler, not `getConversation` — that one reads the
   * CMMS and the call-log channel live on every call, which is far too much to
   * repeat every four seconds just to learn whether a pass has finished.
   *
   * A run happening in THIS tab is excluded: the local progress counter is
   * better information than a poll, and the reload at the end of it picks up
   * everything the run produced.
   */
  const pending = inFlight(data?.grading) && !grading;
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;

    const timer = window.setInterval(async () => {
      try {
        const { items } = await api.gradingStatus(id);
        const next = items[0];
        if (cancelled || !next) return;
        // Settled — re-read in full, because the verdict, the findings and the
        // grade's prose all come from queries the status handler does not run.
        if (!inFlight(next)) setNonce((n) => n + 1);
        else setData((prev) => (prev ? { ...prev, grading: next } : prev));
      } catch {
        // The next poll is four seconds away; a blip is not worth a message.
      }
    }, 4000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pending, id]);

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
      // The criteria come from the SERVER now: the seeded CR-* set plus every
      // active eval written from the scope of work. A criterion added to the
      // SOW therefore starts grading calls without a line changing here.
      //
      // It falls back to the seeded list if that read fails — a grading run
      // that silently checks nothing would be worse than one that checks the
      // set this app has always checked.
      let toGrade: string[] = [...SEMANTIC_CRITERIA];
      try {
        const set = await api.gradingCriteria();
        if (set.items.length) toGrade = set.items.map((c) => c.id);
      } catch {
        // Keep the seeded list.
      }

      setGradeTotal(toGrade.length);
      const runs = [];
      for (const criterionId of toGrade) {
        setGrading(criterionId);
        setGradedSoFar(runs.length + 1);
        runs.push(await runSemanticCriterion(id, criterionId));
      }
      // The call analysis is the last step of the same deliberate action, so a
      // score and its reasoning arrive with the verdicts rather than on open.
      // It carries what this run attempted and what never answered, so the
      // stored grade keeps an unreachable judge distinct from a passing one.
      setGrading('call analysis');
      const an = await runCallAnalysis(id, {
        // Only what was actually ATTEMPTED. A criterion skipped because this
        // channel cannot answer it was never graded, and recording it as graded
        // would be the same fake pass in the stored grade.
        graded: runs.filter((r) => r.verdict !== 'skipped').map((r) => r.criterionId),
        unavailable: runs.filter((r) => r.verdict === 'unavailable').map((r) => r.criterionId),
      });
      if (an.ok && an.analysis) {
        setAnalysis(an.analysis);
        setAnalysisChannelSentiment(an.channelSentiment ?? null);
      }

      const failed = runs.filter((r) => r.verdict === 'fail').length;
      const retracted = runs.filter((r) => r.retracted).length;
      const unavailable = runs.filter((r) => r.verdict === 'unavailable').length;
      const skipped = runs.filter((r) => r.verdict === 'skipped').length;
      setGradeSummary(
        [
          `${runs.length - unavailable - skipped} of ${runs.length - skipped} criteria graded`,
          failed ? `${failed} failed` : 'none failed',
          retracted ? `${retracted} retracted` : null,
          an.ok
            ? an.analysis?.applicable
              ? `quality ${an.analysis.responseQuality}`
              : 'not scorable'
            : 'analysis unavailable',
          // A judge that never answered is UNKNOWN, never a pass — say so.
          unavailable ? `${unavailable} could not be reached` : null,
          // And a check this channel cannot answer is neither.
          skipped ? `${skipped} not applicable on this channel` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      );
      setNonce((n) => n + 1);
    } catch (err) {
      setGradeSummary(err instanceof Error ? err.message : String(err));
    } finally {
      setGrading(null);
      setGradedSoFar(0);
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
  const channel = data.channel;
  const notApplicable = data.notApplicable;
  const cht = channelTone(channel);
  const ev = evalTone(c.evalStatus);
  // A run in this tab is the live truth; otherwise the polled state is.
  const gt = grading ? { bg: 'var(--blue-050)', fg: 'var(--blue-600)' } : gradingTone(data.grading);
  const sent = sentimentTone(c.sentiment);
  // Live call logs usually have no caller name, so this is the phone number.
  const name = c.callerLabel;
  const firstFinding = deviations[0] ?? null;
  // Tool rows are dropped rather than drawn. Nothing imports tool calls, but
  // ingestTranscript can still store one, and a tool turn rendered through the
  // speech bubble would be an empty bubble — exactly the kind of element that
  // looks broken.
  const textTurns = c.transcript.filter((t) => !t.toolCall);
  const aiSections = parseAiSummary(data.aiSummary);
  // The channel's own topic tags, when it produced any.
  const channelTags = (data.aiTags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  return (
    <div style={page('22px 32px 40px')}>
      {/* Getting out of a record should not require noticing that a word in a
          breadcrumb happens to be clickable. This is a button, it looks like
          one, and it says where it goes. The id stays beside it as context. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 13,
          color: 'var(--ink-600)',
          marginBottom: 14,
        }}
      >
        <BackLink onClick={onBack}>Back to conversations</BackLink>
        <span style={{ color: 'var(--ink-500)' }}>{c.callId}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
        <span
          style={{
            width: 40,
            height: 40,
            flex: '0 0 40px',
            borderRadius: 'var(--radius-pill)',
            // Neutral. This is an identity glyph, and colouring it red made
            // every call with no resolved record look like an incident before
            // anyone had read a word of it. The missing record is reported by
            // the panel that checked for it.
            background: 'var(--ink-100)',
            color: 'var(--ink-700)',
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            <h1 style={{ fontSize: 22, lineHeight: '28px', fontWeight: 700, margin: 0 }}>{name}</h1>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '.03em',
                textTransform: 'uppercase',
                padding: '2px 8px',
                borderRadius: 'var(--radius-pill)',
                background: cht.bg,
                color: cht.fg,
                whiteSpace: 'nowrap',
              }}
            >
              {channelLabel(channel)}
            </span>
          </div>
          <p style={{ margin: '4px 0 0', color: 'var(--ink-600)', fontSize: 13 }}>
            {c.site ?? 'Site not resolved'} · {clock(c.startedAt)} · {duration(c.durationSec)}
            {/* The identity is the heading when there is no name — don't repeat
                it. When it IS repeated, it is labelled for what it actually is:
                a WEB conversation's handle is an email address, and calling it
                a phone number was simply wrong. */}
            {c.caller.name && c.caller.phone
              ? ` · ${identityLabel(channel)} ${c.caller.phone}`
              : ''}
            {gradeSummary && (
              <span style={{ color: 'var(--blue-600)', fontWeight: 500 }}> · {gradeSummary}</span>
            )}
            {/* Short on purpose. The status pill and its detail line to the
                right now say where the call is; a second, longer telling of it
                here was what pushed that cluster into the corner. */}
            {!gradeSummary && c.evalStatus === 'not_evaluated' && (
              <span style={{ color: 'var(--ink-500)' }}>
                {' '}·{' '}
                {data.grading?.status === 'grading'
                  ? 'updating on its own'
                  : 'Run evals adds the AI analysis'}
              </span>
            )}
          </p>
        </div>
        {/* Two rows, not one.
            The status detail is variable-length prose; sitting it BETWEEN
            fixed-width pills and 36px buttons is what made this area cramp and
            read as broken. It now has its own line underneath, and everything
            on the top row is a fixed-height, non-shrinking element. */}
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 8,
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            {/* Stage first, verdict second. A call that has never been graded
                and one whose grading run died are different situations, and the
                old single badge said "Awaiting grading" for both. */}
            <span style={{ ...statusPill, background: gt.bg, color: gt.fg }}>
              {grading || data.grading?.status === 'grading' ? (
                <span
                  className="hue-spinner"
                  aria-hidden="true"
                  style={{ width: 10, height: 10, flex: '0 0 10px', borderWidth: 1.5 }}
                />
              ) : null}
              {/* A run happening in THIS tab is the most accurate thing we
                  know — it beats a status polled a moment ago. */}
              {grading
                ? `Grading ${gradedSoFar} of ${gradeTotal}…`
                : gradingLabel(data.grading)}
            </span>
            {c.evalStatus !== 'not_evaluated' ? (
              <span style={{ ...statusPill, background: ev.bg, color: ev.fg }}>
                {label(c.evalStatus)}
              </span>
            ) : null}
          {/* Grading is a deliberate act, not a side effect of opening a call —
              the count and the compliance score must hold still while browsing. */}
          <button className="hue-btn"
            onClick={runEvals}
            disabled={Boolean(grading)}
            aria-busy={Boolean(grading)}
            title="Run the semantic judges and the call analyst against this call"
            style={{
              height: 36,
              padding: '0 14px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-default)',
              background: 'var(--surface-card)',
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
            {grading ? (
              <>
                <span className="hue-spinner" aria-hidden="true" />
                Grading {grading}…
              </>
            ) : (
              'Run evals'
            )}
          </button>
          {firstFinding && (
            <button className="hue-btn"
              onClick={() => onOpenDeviation(firstFinding.id)}
              style={{
                height: 36,
                padding: '0 14px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--blue-500)',
                background: 'var(--blue-500)',
                color: 'var(--surface-card)',
                fontWeight: 500,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Open intervention
            </button>
          )}
          </div>

          {/* The status detail, on its own line. Right-aligned under the pill
              it describes, capped so a long reason wraps instead of stretching
              the header, and simply absent when there is nothing to say. */}
          {(grading ? grading : gradingDetail(data.grading)) ? (
            <span
              style={{
                fontSize: 11,
                color: 'var(--ink-500)',
                textAlign: 'right',
                maxWidth: 460,
                lineHeight: '16px',
              }}
            >
              {grading ? grading : gradingDetail(data.grading)}
            </span>
          ) : null}
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
            conversationId={c.id}
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
              {textTurns.length} turns
              {data.transcriptSource === 'live' ? ' · read live' : ''}
            </span>
          </div>
          <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {textTurns.map((t, i) => (
              <Turn key={i} t={t} />
            ))}
            {textTurns.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--ink-600)' }}>
                No transcript stored for this call.
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
                  borderRadius: 'var(--radius-pill)',
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
                      borderRadius: 'var(--radius-pill)',
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
            onOpenIntervention={firstFinding ? () => onOpenDeviation(firstFinding.id) : null}
          />

          {/* call quality — tabbed, exactly as the design */}
          <QualityCard
            conversation={c}
            deviations={deviations}
            tab={tab}
            onTab={setTab}
            analysis={analysis}
            analysisChannelSentiment={analysisChannelSentiment}
            notApplicable={notApplicable}
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
 * real and is reported. The URL is fetched on press and never stored, since the
 * channel signs it and it expires; a call with no recording keeps the transport
 * disabled rather than animating a progress bar over nothing.
 */
function RecordingBar({
  durationLabel,
  recordingFileId,
  conversationId,
}: {
  durationLabel: string;
  recordingFileId: number | null;
  conversationId: string;
}) {
  const has = recordingFileId !== null;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState(0);
  const [total, setTotal] = useState(0);

  // A new call means a new recording. Without this the player would keep the
  // previous call's audio when you move between records.
  useEffect(() => {
    audioRef.current?.pause();
    setUrl(null);
    setPlaying(false);
    setError(null);
    setAt(0);
    setTotal(0);
  }, [conversationId]);

  /**
   * Fetch on press, never before and never cached.
   *
   * The channel returns a pre-signed URL that expires, so asking for it at the
   * moment of playing is the only way the button keeps working. It also means
   * opening a call costs nothing until someone actually wants to listen.
   */
  async function toggle() {
    setError(null);
    const el = audioRef.current;
    if (playing && el) {
      el.pause();
      return;
    }
    if (url && el) {
      await el.play().catch((e) => setError(e instanceof Error ? e.message : String(e)));
      return;
    }
    setLoading(true);
    try {
      const res = await api.callRecording(conversationId);
      if (!res.available || !res.url) {
        setError(res.reason || 'No recording available for this call.');
        return;
      }
      setUrl(res.url);
      // Wait for the element to take the src before asking it to play.
      window.setTimeout(() => {
        audioRef.current
          ?.play()
          .catch((e) => setError(e instanceof Error ? e.message : String(e)));
      }, 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const clock2 = (sec: number) =>
    `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

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
      {url ? (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setTotal(e.currentTarget.duration || 0)}
          onError={() => setError('The recording could not be played.')}
          style={{ display: 'none' }}
        />
      ) : null}

      <button
        className="hue-btn"
        onClick={toggle}
        disabled={!has || loading}
        title={
          has
            ? playing
              ? 'Pause'
              : 'Play the call recording'
            : 'No recording for this call'
        }
        aria-label={playing ? 'Pause recording' : 'Play recording'}
        style={{
          width: 36,
          height: 36,
          flex: '0 0 36px',
          borderRadius: 'var(--radius-pill)',
          border: `1px solid ${has ? 'var(--blue-500)' : 'var(--border-default)'}`,
          background: has ? 'var(--blue-500)' : 'var(--ink-100)',
          color: has ? 'var(--surface-card)' : 'var(--ink-400)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: has && !loading ? 'pointer' : 'not-allowed',
        }}
      >
        {loading ? (
          <span className="hue-spinner" aria-hidden="true" />
        ) : playing ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.5v13l11-6.5z" />
          </svg>
        )}
      </button>

      {/* Seekable once loaded — the channel's URL supports range requests, so
          scrubbing genuinely works rather than restarting the file. */}
      <input
        type="range"
        min={0}
        max={total > 0 ? total : 1}
        step={0.1}
        value={at}
        disabled={!url || total <= 0}
        onChange={(e) => {
          const next = Number(e.target.value);
          setAt(next);
          if (audioRef.current) audioRef.current.currentTime = next;
        }}
        aria-label="Seek within the recording"
        style={{
          flex: 1,
          height: 6,
          accentColor: 'var(--blue-500)',
          cursor: url && total > 0 ? 'pointer' : 'default',
          opacity: url ? 1 : 0.55,
        }}
      />

      <span
        style={{
          fontSize: 12,
          color: error ? 'var(--danger-700)' : 'var(--ink-600)',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          maxWidth: 260,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={error ?? undefined}
      >
        {error
          ? error
          : !has
            ? 'No recording'
            : url
              ? `${clock2(at)} / ${total > 0 ? clock2(total) : durationLabel}`
              : `0:00 / ${durationLabel}`}
      </span>

      <a
        className="hue-btn"
        href={url ?? undefined}
        download={url ? `call-${conversationId}.wav` : undefined}
        title={
          has
            ? url
              ? 'Download this recording'
              : 'Press play first — the download link is fetched with the audio'
            : 'No recording for this call'
        }
        aria-label="Download recording"
        aria-disabled={!url}
        style={{
          width: 34,
          height: 34,
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-default)',
          background: 'var(--surface-card)',
          color: url ? 'var(--ink-600)' : 'var(--ink-300)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: url ? 'pointer' : 'not-allowed',
          pointerEvents: url ? 'auto' : 'none',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </a>
    </div>
  );
}

function QualityCard({
  conversation: c,
  deviations,
  tab,
  onTab,
  analysis,
  analysisChannelSentiment,
  notApplicable,
}: {
  conversation: ConversationView;
  deviations: DeviationWithEvidence[];
  tab: QualityTab;
  onTab: (t: QualityTab) => void;
  analysis: CallAnalysis | null;
  analysisChannelSentiment: string | null;
  /** Criteria this channel cannot answer. Passed straight to the eval tab. */
  notApplicable: NotApplicable[];
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
            className="hue-btn hue-tab"
            role="tab"
            aria-selected={tab === k}
            style={{
              flex: 1,
              height: 36,
              border: 'none',
              borderBottom: `2px solid ${tab === k ? 'var(--blue-500)' : 'transparent'}`,
              borderRadius: 0,
              background: 'transparent',
              color: tab === k ? 'var(--blue-600)' : 'var(--ink-600)',
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {TAB_LABEL[k]}
          </button>
        ))}
      </div>

      {tab === 'score' && <ScoreTab conversation={c} analysis={analysis} />}
      {tab === 'eval' && (
        <EvalTab
          failedBy={failedBy}
          notEvaluated={notEvaluated}
          evalFg={ev.fg}
          failedCount={deviations.length}
          notApplicable={notApplicable}
        />
      )}
      {tab === 'sentiment' && (
        <SentimentTab conversation={c} analysis={analysis} channelSentiment={analysisChannelSentiment} />
      )}
    </div>
  );
}

/**
 * Scorecard.
 *
 * `Scorecard` in the frozen contract carries latencyMs, sttAccuracy, ttsQuality
 * and responseQuality. Only the last is ever populated — the other three are
 * properties of audio nothing has listened to. They were three rows of "not
 * measured" over three empty meters; the fact is now stated once as a footnote,
 * which says the same thing without looking like a broken panel.
 */
function ScoreTab({
  conversation: c,
  analysis,
}: {
  conversation: ConversationView;
  analysis: CallAnalysis | null;
}) {
  // A score just produced by Run evals beats the stored one, which is a run old.
  const live = analysis?.applicable ? (analysis.responseQuality ?? null) : null;
  const score = live ?? (c.qualityScore && c.qualityScore > 0 ? c.qualityScore : null);
  // Only what is measured. Latency, speech-to-text and text-to-speech are in
  // the frozen contract and nothing populates any of them, so they were three
  // rows of "not measured" over three empty meters — a scorecard that looked
  // broken while telling the truth. The fact is stated once, in a footnote.
  const rows = [
    {
      label: 'Response quality',
      value: score,
      display: score !== null ? `${score} / 100` : analysis && !analysis.applicable ? 'not applicable' : 'not scored',
    },
  ];

  const overall = score !== null ? String(score) : '—';

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
            style={{ height: 6, borderRadius: 'var(--radius-pill)', background: 'var(--ink-100)', overflow: 'hidden' }}
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
                borderRadius: 'var(--radius-pill)',
              }}
            />
          </div>
        </div>
      ))}

      {/* The three audio measures, said once instead of as three empty rows. */}
      <p style={{ margin: 0, fontSize: 11, color: 'var(--ink-500)', lineHeight: '16px' }}>
        Latency, speech-to-text and text-to-speech are properties of the audio, and nothing
        measures them — so they are not scored here rather than shown as empty.
      </p>

      {analysis && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 }}>
          {analysis.responseQualityJustification && (
            <div style={{ fontSize: 12, color: 'var(--ink-700)', lineHeight: '18px' }}>
              {analysis.responseQualityJustification}
            </div>
          )}
          {analysis.overallAssessment && (
            <div>
              <div style={microLabel}>Overall assessment</div>
              <p
                style={{
                  margin: '4px 0 0',
                  fontSize: 13,
                  color: 'var(--ink-900)',
                  lineHeight: '19px',
                  textWrap: 'pretty',
                }}
              >
                {analysis.overallAssessment}
              </p>
            </div>
          )}
          {(analysis.criteriaSatisfied?.length || analysis.criteriaBreached?.length) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {(analysis.criteriaBreached ?? []).map((id) => (
                <span
                  key={'b' + id}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-pill)',
                    background: 'var(--danger-050)',
                    color: 'var(--danger-700)',
                  }}
                >
                  ✕ {id}
                </span>
              ))}
              {(analysis.criteriaSatisfied ?? []).map((id) => (
                <span
                  key={'s' + id}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-pill)',
                    background: 'var(--success-050)',
                    color: 'var(--success-700)',
                  }}
                >
                  ✓ {id}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <p style={{ margin: 0, fontSize: 11, color: 'var(--ink-500)', lineHeight: '16px' }}>
        {/* These three describe the audio pipeline, which no transcript can show.
            The analyst is instructed to refuse them rather than estimate. */}
        Latency, speech-to-text and text-to-speech are properties of the audio, which Vigil never
        hears — they stay unmeasured rather than estimated.
        {!analysis && ' Run evals to score response quality.'}
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
  notApplicable,
}: {
  failedBy: Map<string, DeviationWithEvidence>;
  notEvaluated: boolean;
  evalFg: string;
  failedCount: number;
  /** Criteria that cannot be answered on this conversation, with the reason. */
  notApplicable: NotApplicable[];
}) {
  // Without this, every criterion that is not failing renders a green tick —
  // so a check that never ran on this channel would read as one the call
  // passed. That is the fake pass this app refuses everywhere else, and on a
  // text conversation it would be most of the list.
  const skippedBy = new Map(notApplicable.map((n) => [n.criterionId, n]));
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
            : `${failedCount} of ${WIRED_CRITERIA.size - skippedBy.size} failed` +
              (skippedBy.size ? ` · ${skippedBy.size} not applicable` : '')}
        </span>
      </div>

      {notEvaluated ? (
        <div style={{ padding: '14px 16px', fontSize: 13, color: 'var(--ink-600)' }}>
          This call has not been evaluated yet.
        </div>
      ) : (
        Array.from(WIRED_CRITERIA).map((id) => {
          const layer = layerOf(id);
          const skip = skippedBy.get(id);
          // A skipped criterion is never also a failure — the check did not run.
          const failed = skip ? undefined : failedBy.get(id);
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
                  borderRadius: 'var(--radius-pill)',
                  background: skip
                    ? 'var(--ink-050)'
                    : failed
                      ? 'var(--danger-500)'
                      : 'var(--success-050)',
                  color: skip ? 'var(--ink-500)' : failed ? 'var(--surface-card)' : 'var(--success-700)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                  flex: '0 0 16px',
                  marginTop: 2,
                }}
              >
                {skip ? '–' : failed ? '✕' : '✓'}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: skip
                      ? 'var(--ink-500)'
                      : failed
                        ? 'var(--danger-700)'
                        : 'var(--ink-900)',
                  }}
                >
                  {meta?.title ?? id}
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 2 }}>
                  Clause {failed?.clauseRef ?? meta?.clauseRef ?? '—'} · {layer}
                  {skip ? ` · ${skipHeading(skip.reason)}` : ''}
                </div>
                {skip && (
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--ink-600)',
                      background: 'var(--ink-050)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '7px 9px',
                      marginTop: 6,
                      lineHeight: '17px',
                    }}
                  >
                    {skip.detail}
                  </div>
                )}
                {failed && (
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--danger-700)',
                      background: 'var(--danger-050)',
                      borderRadius: 'var(--radius-sm)',
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
function SentimentTab({
  conversation: c,
  analysis,
  channelSentiment,
}: {
  conversation: ConversationView;
  analysis: CallAnalysis | null;
  channelSentiment: string | null;
}) {
  // The channel's reading is authoritative for the badge. The analyst explains,
  // and where the two disagree BOTH are shown — a contradiction between the
  // upstream signal and the transcript is a finding, not something to smooth over.
  const channel = channelSentiment ?? c.sentiment ?? null;
  const read = analysis?.sentiment && analysis.sentiment !== 'unknown' ? analysis.sentiment : null;
  const disagree = Boolean(channel && read && channel !== read);
  const tone = sentimentTone(c.sentiment);

  return (
    <div style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: 'var(--ink-600)' }}>Caller sentiment</span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: 'var(--radius-pill)',
            background: tone.bg,
            color: tone.fg,
          }}
        >
          {c.sentiment ? label(c.sentiment) : 'Unknown'}
        </span>
      </div>
      {analysis && read && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {disagree ? (
            <div
              style={{
                background: 'var(--warning-050)',
                border: '1px solid var(--warning-500)',
                borderRadius: 'var(--radius-sm)',
                padding: '9px 11px',
                fontSize: 12,
                color: 'var(--warning-700)',
                lineHeight: '18px',
              }}
            >
              <b style={{ fontWeight: 600 }}>These disagree.</b> The channel recorded{' '}
              <b style={{ fontWeight: 600 }}>{label(channel ?? '')}</b>; reading the transcript
              gives <b style={{ fontWeight: 600 }}>{label(read)}</b>. The badge above keeps the
              channel's value.
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--ink-600)' }}>
              Transcript reading agrees: <b style={{ fontWeight: 600 }}>{label(read)}</b>
              {!channel && ' — no channel signal for this call, so this fills the gap.'}
            </div>
          )}
          {analysis.sentimentReason && (
            <div style={{ fontSize: 13, color: 'var(--ink-900)', lineHeight: '19px', textWrap: 'pretty' }}>
              {analysis.sentimentReason}
            </div>
          )}
        </div>
      )}
      <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--ink-500)', lineHeight: '16px' }}>
        One reading for the whole call — the channel reports satisfaction at the end, not over
        time, so there is no trend to show.
        {!analysis && ' Run evals to read the caller\'s emotion from the transcript.'}
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
 * One transcript entry. Caller and agent are chat bubbles on opposite sides.
 *
 * Tool calls are not rendered. The columns are still on transcript_turns and
 * the handler that would read them is still there, dormant — but nothing in
 * this app imports them, so there is nothing to draw and no empty slot
 * announcing their absence.
 */
function Turn({ t }: { t: TurnWithToolIO }) {

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
            background: isAgent ? 'var(--blue-025)' : isSystem ? 'var(--ink-050)' : 'var(--surface-card)',
            color: 'var(--ink-900)',
            border: `1px solid ${
              isAgent ? 'var(--blue-050)' : isSystem ? 'var(--border-default)' : 'var(--border-default)'
            }`,
            borderRadius: 'var(--radius-lg)',
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
  onOpenIntervention,
}: {
  rec: Record<string, unknown> | null;
  conversation: ConversationView;
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
        background: 'var(--surface-card)',
        border: `1px solid ${found ? 'var(--border-default)' : 'var(--danger-500)'}`,
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
      }}
    >
      <div style={{ ...railHead, background: found ? 'var(--surface-card)' : 'var(--danger-050)' }}>
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
                borderRadius: 'var(--radius-pill)',
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
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
            }}
          >
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
            <button className="hue-btn"
              onClick={onOpenIntervention}
              style={{
                height: 34,
                borderRadius: 'var(--radius-sm)',
                // Navigation, not destruction: this opens a screen, it does not
                // act on the CMMS. Red said "careful" about a link.
                border: '1px solid var(--border-default)',
                background: 'var(--surface-card)',
                color: 'var(--ink-900)',
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
