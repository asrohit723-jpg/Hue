import { useEffect, useState } from 'react';
import {
  api,
  type ConversationView,
  type DeviationWithEvidence,
  type TurnWithToolIO,
} from '../lib/vibe';
import { BootSkeleton } from './BootSkeleton';
import { LoadError } from '../components/Chrome';
import { avatarColor, clock, duration, evalTone, initials, label, sentimentTone } from '../lib/tone';

/**
 * Call detail — ported from the CONVERSATION DETAIL block of the design
 * ("Helpdesk Governance.dc.html", lines 1791-1995): the two-column split, the
 * chat-bubble transcript with tool calls inline, and the CMMS ground-truth
 * panel that turns red when the record the agent promised is not there.
 *
 * Three pieces of the design are not reproduced, because nothing behind them
 * is real:
 *
 *   - the audio player. No recording is stored, or referenced, anywhere. A
 *     transport with a moving progress bar over silence is the most misleading
 *     thing this screen could contain.
 *   - the score bars. The design hard-codes latency 88 / STT 94 / TTS 91;
 *     `quality_score` is 0 on every stored row and no scorecard rows exist. The
 *     panel says the call is not scored instead of drawing invented bars.
 *   - the ten-segment sentiment timeline, which the design fabricates from a
 *     per-sentiment pattern. One end-of-call sentiment is what we hold, so one
 *     is what is shown.
 *
 * Everything else on the screen is read from the call: the transcript and its
 * tool arguments, errors and results from the app DB, and the service request
 * fetched live from the CMMS at read time.
 */

interface Loaded {
  conversation: ConversationView;
  deviations: DeviationWithEvidence[];
  cmmsRecord: Record<string, unknown> | null;
}

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setData(null);
      setError(null);
      try {
        const res = await api.getConversation(id);
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, nonce]);

  if (error) {
    return (
      <div style={{ padding: '24px 28px', maxWidth: 1240 }}>
        <LoadError message={error} onRetry={() => setNonce((n) => n + 1)} />
      </div>
    );
  }
  if (!data) return <BootSkeleton label="Loading call…" />;

  const { conversation: c, deviations, cmmsRecord } = data;
  const ev = evalTone(c.evalStatus);
  const sent = sentimentTone(c.sentiment);
  const name = c.caller.name || 'Unknown caller';
  const firstFinding = deviations[0] ?? null;
  const textTurns = c.transcript.filter((t) => !t.toolCall);
  // The tool call that failed, if one did — the missing-record panel quotes it
  // rather than describing the failure in the abstract.
  const failedTool = c.transcript.find((t) => t.toolCall && t.toolCall.status !== 'success');

  return (
    <div style={{ padding: '22px 32px 40px' }}>
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
          {initials(c.caller.name)}
        </span>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 22, lineHeight: '28px', fontWeight: 700, margin: 0 }}>{name}</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--ink-600)', fontSize: 13 }}>
            {c.site ?? 'Unknown site'} · {clock(c.startedAt)} · {duration(c.durationSec)}
            {c.caller.phone ? ` · ${c.caller.phone}` : ''}
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
              {[
                c.site,
                c.srRecordId ? 'SR raised' : 'No SR',
                deviations.length ? 'Deviation' : 'Within scope',
                label(c.status),
              ]
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
            </div>
          </div>

          {/* CMMS ground truth */}
          <CmmsPanel
            rec={cmmsRecord}
            conversation={c}
            failedTool={failedTool}
            onOpenIntervention={firstFinding ? () => onOpenDeviation(firstFinding.id) : null}
          />

          {/* evaluation */}
          <div style={panel}>
            <div
              style={{
                padding: '10px 16px',
                borderBottom: '1px solid var(--ink-100)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>Evaluation</span>
              <span
                style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: ev.fg }}
              >
                {c.evalStatus === 'not_evaluated'
                  ? 'awaiting evaluation'
                  : deviations.length
                    ? `${deviations.length} failed`
                    : 'all criteria passed'}
              </span>
            </div>
            {deviations.map((d) => (
              <div
                key={d.id}
                onClick={() => onOpenDeviation(d.id)}
                style={{
                  padding: '11px 16px',
                  borderBottom: '1px solid var(--ink-100)',
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 999,
                    background: 'var(--danger-500)',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    fontWeight: 700,
                    flex: '0 0 16px',
                    marginTop: 2,
                  }}
                >
                  ✕
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--danger-700)' }}>
                    {d.criterionId}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-600)', marginTop: 2 }}>
                    Clause {d.clauseRef} · {d.severity} · detected by {d.detectedBy}
                  </div>
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
                    {d.summary}
                  </div>
                </div>
              </div>
            ))}
            {deviations.length === 0 && (
              <div style={{ padding: '14px 16px', fontSize: 13, color: 'var(--ink-600)' }}>
                {c.evalStatus === 'not_evaluated'
                  ? 'This call has not been evaluated yet.'
                  : 'No criterion failed on this call.'}
              </div>
            )}
            {/* The design scores every call on latency, STT and TTS. None of
                those are measured yet, so the panel reports the one score we do
                store — and says so when it is absent. */}
            <div
              style={{
                padding: '11px 16px',
                borderTop: '1px solid var(--ink-100)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--ink-600)' }}>Quality score</span>
              <span
                style={{
                  fontWeight: 700,
                  fontFamily: 'var(--font-display)',
                  fontSize: 20,
                  color: c.qualityScore ? 'var(--ink-900)' : 'var(--ink-400)',
                }}
              >
                {c.qualityScore ? `${c.qualityScore}` : 'Not scored'}
              </span>
            </div>
          </div>
        </div>
      </div>
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

  const fields = rec
    ? [
        // localId comes back as 0 on records created through the API, so it is
        // only used when it actually carries a number.
        {
          label: 'Request id',
          value: (readField(rec, 'localId') !== '0' ? readField(rec, 'localId') : null) ??
            readField(rec, 'id'),
        },
        { label: 'Status', value: readField(rec, 'moduleState') },
        { label: 'Urgency', value: readField(rec, 'urgency') },
        { label: 'Site', value: readField(rec, 'site') },
        { label: 'Requester', value: readField(rec, 'requester') },
        { label: 'Source', value: readField(rec, 'sourceType') },
        { label: 'Created', value: stamp(rec.sysCreatedTime) },
        { label: 'Last modified', value: stamp(rec.sysModifiedTime) },
      ].filter((f) => f.value !== null)
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
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-500)' }}>
          Read live
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
                <span style={{ wordBreak: 'break-word' }}>{f.value}</span>
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
