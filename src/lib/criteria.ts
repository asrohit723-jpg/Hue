/**
 * Which criteria the engine actually grades, and how.
 *
 * This list mirrors two things in functions/governance.ts: the deterministic
 * checks written into `evaluate`, and the keys of `SEMANTIC_CRITERIA`. It lives
 * in one place because three screens need it — Scope & Evals to report coverage
 * and mark a criterion "Not wired", Conversation Detail to tick a criterion that
 * was checked and did not fail, and the browser-side judge runner to know what
 * to grade. Two copies of this list drifted once already.
 *
 * A criterion NOT in here is configured but inert: nothing checks it, so
 * nothing may claim it passed.
 */

/** Answered by plain code against the CMMS record and the tool-call log. */
export const DETERMINISTIC_CRITERIA = [
  'CR-LOG-01',
  'CR-LOG-02',
  'CR-ESC-04',
  'CR-CALL-01',
] as const;

/**
 * Answered by the conformance judge reading the transcript against the record.
 *
 * CR-LOG-01 appears in both lists deliberately: the deterministic half catches
 * the agent claiming a record that does not exist, and the semantic half catches
 * the caller's fault going unlogged when the agent made no false claim. They
 * cannot both fire — the judge stands down where the deterministic check spoke.
 */
export const SEMANTIC_CRITERIA = [
  'CR-LOG-01',
  'CR-LOG-04',
  'CR-LOG-06',
  'CR-SCOPE-01',
  'CR-SCOPE-02',
  'CR-ESC-02',
  'CR-CALL-02',
  'CR-CALL-03',
  'CR-SCHED-01',
  'CR-SCHED-02',
  'CR-CAT-01',
] as const;

/** Every criterion something actually checks. */
export const WIRED_CRITERIA = new Set<string>([
  ...DETERMINISTIC_CRITERIA,
  ...SEMANTIC_CRITERIA,
]);

/** How a given criterion is graded, for the screens that show the split. */
export function layerOf(id: string): 'deterministic' | 'semantic' | null {
  const det = (DETERMINISTIC_CRITERIA as readonly string[]).includes(id);
  const sem = (SEMANTIC_CRITERIA as readonly string[]).includes(id);
  // CR-LOG-01 is both; the deterministic half is the one that speaks first.
  if (det) return 'deterministic';
  if (sem) return 'semantic';
  return null;
}
