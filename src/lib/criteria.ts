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

/**
 * The clause each wired criterion cites.
 *
 * Mirrors governance.ts: the `clauseRef` on every entry of SEMANTIC_CRITERIA,
 * and the four literals the deterministic checks push with their findings.
 * It is here for the same reason the two lists above are — the screens need it
 * and must not each keep their own copy. criteria.seed.json carries clause refs
 * too, but it is the SEEDED set: it is missing CR-CAT-01, which grades, and
 * includes four criteria that do not.
 *
 * A criterion is only listed here if something actually runs it. An inert
 * criterion citing a missing clause is not a governance gap, because it was
 * never going to cite anything.
 */
export const CLAUSE_REFS: Record<string, string> = {
  // deterministic — the literals in `evaluate`
  'CR-LOG-01': 'S-2.1',
  'CR-LOG-02': 'S-2.1',
  'CR-ESC-04': 'S-2.5',
  'CR-CALL-01': 'S-6.1',
  // semantic — the keys of SEMANTIC_CRITERIA
  'CR-LOG-04': 'S-2.1',
  'CR-LOG-06': 'S-2.4',
  'CR-CAT-01': 'S-3.4',
  'CR-SCOPE-01': 'S-1.3',
  'CR-SCOPE-02': 'S-1.4',
  'CR-ESC-02': 'S-5.2',
  'CR-CALL-02': 'S-6.2',
  'CR-CALL-03': 'S-6.3',
  'CR-SCHED-01': 'S-4.2',
  'CR-SCHED-02': 'S-7.2',
};

/**
 * Whether a scope of work actually contains the clause a criterion cites.
 *
 * The anchor rule is the server's, in clauseTextIn: a clause is a reference at
 * the START of a line, not the same characters appearing mid-sentence, so a
 * clause discussed in prose is not mistaken for the clause itself. This only
 * asks whether it is there; the server does the extracting.
 */
export function sowHasClause(body: string, clauseRef: string): boolean {
  const ref = String(clauseRef ?? '').trim();
  if (!ref || !body) return false;
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[ \\t]*${escaped}\\b`, 'm').test(body);
}

/**
 * The wired criteria whose clause is not in the scope of work on file.
 *
 * An empty list is the healthy state: every rule Vigil enforces can be traced to
 * a line of the contract. A non-empty one is a real finding about the CONTRACT,
 * not about the app — the criteria were written against a fuller document than
 * the one that was pasted.
 */
export function unanchoredCriteria(body: string): Array<{ id: string; clauseRef: string }> {
  return Object.entries(CLAUSE_REFS)
    .filter(([, ref]) => !sowHasClause(body, ref))
    .map(([id, clauseRef]) => ({ id, clauseRef }))
    .sort((a, b) => a.clauseRef.localeCompare(b.clauseRef));
}
