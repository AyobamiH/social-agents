import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __test__ } from '../src/supabase-worker';

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test('legacy success summary still preserves exact recorded receipt identifiers', () => {
  const result = __test__.publishSuccessResult(
    {
      id: 'job-1',
      user_id: 'tenant-1',
      kind: 'publish_now',
      status: 'running',
      created_at: '2026-05-17T15:00:46.000Z',
      started_at: '2026-05-17T15:00:47.000Z',
      payload: {
        source: 'scheduled',
        scheduler: 'cloudflare_cron',
        due_at: '2026-05-17T15:00:00.000Z',
        queue_item_id: 'queue-1',
      },
    },
    {
      id: 'queue-1',
      user_id: 'tenant-1',
      platform: 'threads',
      status: 'publishing',
      slot_index: 3,
      scheduled_for: '2026-05-17T15:00:00.000Z',
    },
    {
      id: 'history-1',
      user_id: 'tenant-1',
      platform: 'threads',
      external_post_id: 'external-1',
      published_at: '2026-05-17T15:00:58.000Z',
    },
    'external-1',
    '2026-05-17T15:00:59.000Z'
  ) as any;

  assert.equal(result.queueItemId, 'queue-1');
  assert.equal(result.publishHistoryId, 'history-1');
  assert.equal(result.externalPostId, 'external-1');
});

test('production stale publication recovery has no log/status reconciliation fallback', () => {
  const worker = readFileSync('src/supabase-worker.ts', 'utf8');
  assert.ok(!worker.includes('function stalePublishResult('));
  assert.ok(!worker.includes('function publishStageStarted('));
  assert.ok(!worker.includes('findPublishHistoryForQueueItem'));
  assert.ok(worker.includes(
    'return reconcilePublication({ userId: job.user_id, queueItemId: row.id, platform: row.platform });'
  ));
  assert.ok(worker.includes('recoverStalePublications(now.getTime(), rolloutAllowedUserIds())'));
});

test('unknown publication guidance never authorises a blind retry', () => {
  const worker = readFileSync('src/supabase-worker.ts', 'utf8');
  assert.ok(worker.includes('Reconcile publication identity before retrying. Do not recreate the post.'));
  assert.ok(!worker.includes('If it is not live, retry this queue item manually.'));
});
