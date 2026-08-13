/**
 * Tone helpers, ported from the design's sentTone / evalTone / sevTone / rcTone
 * / scoreTone functions. Colours are the design's, unchanged.
 */

export interface Tone {
  bg: string;
  fg: string;
  dot?: string;
}

export function sentimentTone(s: string | null): Tone {
  switch ((s ?? '').toLowerCase()) {
    case 'happy':
      return { bg: 'var(--success-050)', fg: 'var(--success-700)' };
    case 'angry':
    case 'distressed':
      return { bg: 'var(--danger-050)', fg: 'var(--danger-500)' };
    case 'frustrated':
      return { bg: 'var(--warning-050)', fg: 'var(--warning-700)' };
    default:
      return { bg: 'var(--ink-050)', fg: 'var(--ink-600)' };
  }
}

export function evalTone(s: string): Tone {
  switch (s) {
    case 'passed':
      return { bg: 'var(--success-050)', fg: 'var(--success-700)' };
    case 'flagged':
      return { bg: 'var(--danger-050)', fg: 'var(--danger-500)' };
    default:
      return { bg: 'var(--ink-050)', fg: 'var(--ink-600)' };
  }
}

export function severityTone(s: string): Tone {
  switch (s) {
    case 'critical':
      return { bg: 'var(--danger-050)', fg: 'var(--danger-500)', dot: 'var(--danger-500)' };
    case 'high':
      return { bg: 'var(--danger-050)', fg: 'var(--danger-700)', dot: 'var(--danger-700)' };
    case 'medium':
      return { bg: 'var(--warning-050)', fg: 'var(--warning-700)', dot: 'var(--warning-500)' };
    default:
      return { bg: 'var(--ink-050)', fg: 'var(--ink-600)', dot: 'var(--ink-400)' };
  }
}

export function rootCauseTone(r: string): Tone {
  switch (r) {
    case 'agent':
      return { bg: 'var(--brand-indigo-050)', fg: 'var(--brand-indigo)' };
    case 'data':
      return { bg: 'var(--blue-025)', fg: 'var(--blue-600)' };
    default:
      return { bg: 'var(--warning-050)', fg: 'var(--warning-700)' };
  }
}

/** Stable avatar colour per caller, so the same person keeps the same swatch. */
const AVATARS = [
  'var(--brand-indigo)',
  'var(--blue-500)',
  'var(--success-700)',
  'var(--warning-700)',
  'var(--danger-700)',
  'var(--brand-indigo-600)',
];
export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

export function initials(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

/** ISO -> HH:MM in the viewer's locale. */
export function clock(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function duration(sec: number | null): string {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Title-case a machine value for display without inventing new vocabulary. */
export function label(v: string): string {
  return v ? v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ') : '';
}
