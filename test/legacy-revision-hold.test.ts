import assert from 'node:assert/strict';
import test from 'node:test';

import { __test__ } from '../src/supabase-worker';

test('held historical revisions fail before any provider or mutation path', () => {
  assert.doesNotThrow(() => {
    __test__.assertQueueRevisionNotHeld({
      id: 'queue-safe',
      legacy_revision_hold_id: null,
    });
  });

  assert.throws(
    () => {
      __test__.assertQueueRevisionNotHeld({
        id: 'queue-held',
        legacy_revision_hold_id: 'legacy-hold',
      });
    },
    (error: unknown) => {
      const candidate = error as {
        code?: string;
        message?: string;
        context?: Record<string, unknown>;
      };
      return candidate.code === 'legacy_queue_revision_held'
        && candidate.message?.includes('publication outcome cannot be proven safely') === true
        && candidate.context?.queueItemId === 'queue-held'
        && candidate.context?.next_action ===
          'Do not retry, edit, skip, release, or recreate this post. Preserve it for operator review.';
    }
  );
});
