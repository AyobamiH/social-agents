import assert from 'node:assert/strict';
import { test } from 'node:test';
import config from '../config';
import { requestJson } from '../src/http-client';
import { extractSourceBank, setOpenAIUsageRecorder, type OpenAIUsageEvent } from '../src/ai';
import { __test__ } from '../src/supabase-worker';

const post = {
  id: 'post-1', title: 'Reliable queues', selftext: 'A real source body.',
  url: 'https://reddit.example/post-1', score: 1, comments: 0,
  subreddit: 'example', author: 'example', created: 1,
};

test('cancellation reaches transport, response reads and retry delays', async t => {
  const originalFetch = globalThis.fetch;
  try {
    await t.test('already cancelled operations make no request', async () => {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response('{}'); };
      const reason = new Error('cancelled');
      await assert.rejects(requestJson('https://example.test', {
        signal: AbortSignal.abort(reason), retryCount: 3,
      }), error => error === reason);
      assert.equal(calls, 0);
    });

    await t.test('caller cancellation aborts a pending request without retrying', async () => {
      let calls = 0;
      let transportAborted = false;
      const controller = new AbortController();
      const reason = new Error('cancelled by job');
      globalThis.fetch = async (_url, options) => {
        calls++;
        return new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => {
            transportAborted = true;
            reject(options!.signal!.reason);
          }, { once: true });
        });
      };
      const result = requestJson('https://example.test', { signal: controller.signal, retryCount: 3 });
      controller.abort(reason);
      await assert.rejects(result, error => error === reason);
      assert.equal(transportAborted, true);
      assert.equal(calls, 1);
    });

    await t.test('an abort during body reading cannot be returned as success', async () => {
      const controller = new AbortController();
      globalThis.fetch = async () => ({
        ok: true, status: 200, headers: new Headers(),
        text: async () => { controller.abort(new Error('body cancelled')); return '{}'; },
      }) as Response;
      await assert.rejects(requestJson('https://example.test', { signal: controller.signal }), /body cancelled/);
    });

    await t.test('an abort interrupts backoff without another request', async () => {
      let calls = 0;
      const controller = new AbortController();
      globalThis.fetch = async () => {
        calls++;
        return new Response('{}', { status: 429 });
      };
      const result = requestJson('https://example.test', {
        signal: controller.signal, retryCount: 3, retryDelayMs: 10_000,
      });
      const timer = setTimeout(() => controller.abort(new Error('backoff cancelled')), 10);
      try { await assert.rejects(result, /backoff cancelled/); }
      finally { clearTimeout(timer); }
      assert.equal(calls, 1);
    });

    await t.test('ordinary request timeout retains its typed error', async () => {
      globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error('runtime-specific abort')), { once: true });
      });
      await assert.rejects(requestJson('https://example.test', { timeoutMs: 5 }),
        (error: any) => error.code === 'UPSTREAM_TIMEOUT');
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('extraction deadline cancels paid work before returning the source claim', async () => {
  const originalFetch = globalThis.fetch;
  const previousTimeout = config.HTTP_TIMEOUT_MS;
  const events: OpenAIUsageEvent[] = [];
  let transportSettled = false;
  let calls = 0;
  setOpenAIUsageRecorder(event => { events.push(event); });
  config.HTTP_TIMEOUT_MS = 6_000; // worker deadline is 5 seconds, before the HTTP timeout
  globalThis.fetch = async (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => {
        queueMicrotask(() => {
          transportSettled = true;
          reject(options!.signal!.reason);
        });
      }, { once: true });
    });
  };
  try {
    await assert.rejects(__test__.extractSourceBankWithJobTimeout(post), /OpenAI angle extraction timed out/);
    assert.equal(transportSettled, true);
    assert.equal(calls, 1);
    assert.deepEqual(events.map(event => event.call_status), ['started', 'failed']);
    assert.equal(events[1].stage, 'angle_extraction');

    const eventCount = events.length;
    await assert.rejects(extractSourceBank(post, { signal: AbortSignal.abort(new Error('job finished')) }), /job finished/);
    assert.equal(calls, 1);
    assert.equal(events.length, eventCount);
  } finally {
    globalThis.fetch = originalFetch;
    config.HTTP_TIMEOUT_MS = previousTimeout;
    setOpenAIUsageRecorder(undefined);
  }
});
