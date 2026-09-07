import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// One-shot guarded cleanup: source and migrated tests must pass together before commit.
const path = 'src/supabase-worker.ts';
const source = readFileSync(path, 'utf8');
const blobSha = createHash('sha1')
  .update(`blob ${Buffer.byteLength(source)}\0`)
  .update(source)
  .digest('hex');

if (blobSha !== '87680f50f157a88a01bd920196139fd3de68da21') {
  throw new Error(`Refusing moved supabase-worker.ts: ${blobSha}`);
}

function removeBetween(text, start, end) {
  const first = text.indexOf(start);
  const second = text.indexOf(end, first + start.length);
  if (first < 0 || second < 0) throw new Error(`Missing boundary: ${start}`);
  if (text.indexOf(start, first + 1) >= 0) throw new Error(`Ambiguous start boundary: ${start}`);
  return text.slice(0, first) + text.slice(second);
}

function removeExact(text, exact) {
  if (text.split(exact).length !== 2) throw new Error(`Expected exactly one: ${exact.trim()}`);
  return text.replace(exact, '');
}

let next = source;
next = removeBetween(
  next,
  'function publishStageStarted(logs: WorkerLogRow[], queueItemId: string): boolean {',
  'async function loadQueueItemForStalePublish('
);
next = removeBetween(
  next,
  'function stalePublishResult(',
  'async function stalePublishJobResult('
);
next = removeExact(next, '  stalePublishResult,\n');

for (const forbidden of [
  'publishStageStarted',
  'stalePublishResult',
  'findPublishHistoryForQueueItem',
]) {
  if (next.includes(forbidden)) throw new Error(`Legacy recovery symbol remains: ${forbidden}`);
}
if (!next.includes('return reconcilePublication({ userId: job.user_id, queueItemId: row.id, platform: row.platform });')) {
  throw new Error('Exact ledger stale reconciliation is missing');
}
if (!next.includes('await recoverStalePublications(now.getTime());')) {
  throw new Error('Orphan ledger recovery is missing');
}

writeFileSync(path, next);
console.log('Removed dead log/status publication reconciliation. Exact ledger recovery remains.');
