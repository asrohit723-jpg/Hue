#!/usr/bin/env node
/**
 * Ingest the demo transcripts, then run the governance engine over each one.
 *
 * Transcripts are the only thing Hue stores of its own. Everything the engine
 * checks them against — the service request, its site, urgency and status — is
 * read live from the CMMS by the `evaluate` handler.
 *
 * Idempotent: `ingestTranscript` upserts on callId, so re-running replaces the
 * turns rather than duplicating them.
 *
 * Usage: node demo/seed.mjs [--skip-evaluate]
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const skipEvaluate = process.argv.includes('--skip-evaluate');
const { transcripts } = JSON.parse(readFileSync(new URL('./transcripts.json', import.meta.url)));

function run(handler, args) {
  const out = execFileSync(
    'facilio',
    ['vibe', 'function', 'run', 'governance', handler, '--args', JSON.stringify(args)],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 },
  );
  // The CLI prints a progress line before the JSON body; take from the first brace.
  const brace = out.indexOf('{');
  if (brace < 0) throw new Error(`No JSON in output for ${handler}: ${out.slice(0, 300)}`);
  return JSON.parse(out.slice(brace));
}

let ingested = 0;
for (const t of transcripts) {
  const res = run('ingestTranscript', {
    callId: t.callId,
    startedAt: t.startedAt,
    durationSec: t.durationSec,
    callerName: t.callerName,
    callerPhone: t.callerPhone,
    siteHint: t.siteHint,
    status: t.status,
    sentiment: t.sentiment,
    srClaimed: t.srClaimed,
    srNumberClaimed: t.srNumberClaimed,
    turnsJson: JSON.stringify(t.turns),
  });
  ingested++;
  console.log(
    `ingested ${res.conversationId}  turns=${res.turns}  ${res.replaced ? '(replaced)' : '(new)'}`,
  );
}
console.log(`\n${ingested} transcripts ingested.\n`);

if (skipEvaluate) process.exit(0);

let totalFindings = 0;
for (const t of transcripts) {
  const id = `C-${t.callId}`;
  try {
    const res = run('evaluate', { conversationId: id });
    totalFindings += res.deviationsFound;
    const join = res.join.cmmsSrId
      ? `SR ${res.join.cmmsSrId} via ${res.join.method} (${res.join.confidence})`
      : 'NO CMMS RECORD';
    console.log(`${id}  ${join}  findings=${res.deviationsFound}`);
    for (const f of res.findings) console.log(`      ${f.severity.padEnd(8)} ${f.criterionId}  ${f.summary}`);
  } catch (err) {
    console.error(`${id}  EVALUATE FAILED: ${err.message.split('\n')[0]}`);
  }
}
console.log(`\n${totalFindings} deviations recorded.`);
