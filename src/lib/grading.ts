/**
 * How a call's grading state is WORDED. The state itself is decided once, on
 * the server (`gradingStateOf`), and both screens render the same object — a
 * second derivation in the browser is a second thing to be wrong.
 *
 * There is no status column anywhere. Everything below is read off
 * `conversations.eval_status` and the call's `call_grades` row.
 */
export interface GradingState {
  /** 'awaiting' | 'grading' | 'graded' | 'unavailable' */
  status: string;
  /** The deterministic checks have run — eval_status is no longer 'not_evaluated'. */
  checksRun: boolean;
  /** The AI analysis has been stored. Most graded calls have NOT been analysed. */
  analysed: boolean;
  evalStatus: string;
  gradedAt: string;
  gradedBy: string;
  claimedAt: string;
  claimedBy: string;
  criteriaGraded: number;
  criteriaUnavailable: number;
  unavailableIds: string[];
}

/** Still moving, so the screens keep polling. Nothing else should. */
export function inFlight(g: GradingState | null | undefined): boolean {
  return g?.status === 'grading' || g?.status === 'awaiting';
}

export function gradingLabel(g: GradingState | null | undefined): string {
  switch (g?.status) {
    case 'grading':
      return 'Grading…';
    case 'graded':
      return 'Graded';
    case 'unavailable':
      return 'Grading unavailable';
    default:
      return 'Awaiting grading';
  }
}

export function gradingTone(g: GradingState | null | undefined): { bg: string; fg: string } {
  switch (g?.status) {
    case 'grading':
      return { bg: 'var(--blue-050)', fg: 'var(--blue-600)' };
    case 'graded':
      // A grade with judges that never answered is NOT a clean one. It keeps
      // the warning colour rather than reading as a completed pass.
      return g && g.criteriaUnavailable > 0
        ? { bg: 'var(--warning-050)', fg: 'var(--warning-700)' }
        : { bg: 'var(--success-050)', fg: 'var(--success-700)' };
    case 'unavailable':
      return { bg: 'var(--warning-050)', fg: 'var(--warning-700)' };
    default:
      return { bg: 'var(--ink-050)', fg: 'var(--ink-600)' };
  }
}

/** How long ago, in words. Empty when there is no stamp to speak of. */
export function since(iso: string): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * The line under the status, which is where the honesty lives.
 *
 * "Graded" covers two different amounts of work and this is what separates
 * them: the deterministic checks run automatically on every call, while the AI
 * analysis only ever runs when somebody presses Run evals. A call that says
 * "Graded" with no analysis has had its coded checks run against the live CMMS
 * — it has not been read by a model, and must not imply it was.
 */
export function gradingDetail(g: GradingState | null | undefined): string {
  if (!g) return '';

  if (g.status === 'awaiting') return 'not started';
  if (g.status === 'grading') return 'checks running';
  if (g.status === 'unavailable') {
    // A claim nothing ever finished. The run died; the call is grading-eligible
    // again and the next job or refresh picks it up.
    return 'a grading run stopped before it finished — it will be retried';
  }

  const parts: string[] = [];
  if (g.analysed) {
    parts.push(`analysed ${since(g.gradedAt)}`.trim());
    if (g.gradedBy) parts.push(g.gradedBy === 'manual' ? 'run by hand' : 'automatic');
    if (g.criteriaGraded) parts.push(`${g.criteriaGraded} criteria`);
  } else if (g.checksRun) {
    parts.push('checks run · not analysed');
  }
  // Never silently. A judge that did not answer is unknown, not a pass.
  if (g.criteriaUnavailable > 0) {
    parts.push(
      `${g.criteriaUnavailable} could not be reached`,
    );
  }
  return parts.join(' · ');
}
