/**
 * How a conversation reached the agent.
 *
 * Wording only — the channel itself is recorded at ingest and derived once on
 * the server (`channelOf`), so nothing here decides anything.
 *
 * Vigil called every conversation "a call" until now, which was wrong in a way
 * you could see: a WEB conversation's email address sat under a heading that
 * said phone number.
 */
export interface Channel {
  /** PHONE | WEB | WHATSAPP | CHAT | EMAIL */
  channel: string;
  channelId: number;
  /** 'voice' | 'text' — what may be checked, not merely how it looks. */
  modality: string;
  isVoice: boolean;
  /** 'phone' | 'email' | 'handle' — what the identity field actually holds. */
  identityKind: string;
}

/** A criterion that cannot be answered on this conversation, and why. */
export interface NotApplicable {
  criterionId: string;
  /** 'channel' — voice-only check. 'no_join' — no CMMS record resolved yet. */
  reason: string;
  detail: string;
}

const LABEL: Record<string, string> = {
  PHONE: 'Phone',
  WEB: 'Web call',
  WHATSAPP: 'WhatsApp',
  CHAT: 'Chat',
  EMAIL: 'Email',
};

export function channelLabel(c: Channel | null | undefined): string {
  if (!c) return 'Phone';
  return LABEL[c.channel] ?? c.channel;
}

/**
 * Voice channels share one tone and text channels another, because the split
 * that matters when reading a list is what can be GRADED on it — not which
 * logo the conversation arrived under.
 */
export function channelTone(c: Channel | null | undefined): { bg: string; fg: string } {
  if (c && !c.isVoice) return { bg: 'var(--brand-indigo-050)', fg: 'var(--brand-indigo)' };
  return { bg: 'var(--ink-050)', fg: 'var(--ink-600)' };
}

/** What to call the identity we hold, so an email is never labelled a phone. */
export function identityLabel(c: Channel | null | undefined): string {
  switch (c?.identityKind) {
    case 'email':
      return 'Email';
    case 'handle':
      return 'Handle';
    default:
      return 'Phone';
  }
}

/**
 * The two reasons a check can be skipped, in words.
 *
 * They resolve differently and must not be blurred: one never will (a WhatsApp
 * thread cannot drop), the other resolves the day the text reference parser is
 * wired. Neither is a pass.
 */
export function skipHeading(reason: string): string {
  return reason === 'channel' ? 'Not applicable on this channel' : 'Not checked on this channel';
}
