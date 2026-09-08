import assert from 'node:assert/strict';

import config from '../config';
import {
  SupabaseNetworkError,
  supabaseDelete,
  supabaseInsert,
  supabaseRpc,
  supabaseSelect,
  supabaseUpdate,
  supabaseUpsert,
} from '../src/supabase-client';

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalConfig = {
    url: config.SUPABASE_URL,
    role: config.SUPABASE_SERVICE_ROLE_KEY,
    encryption: config.CREDENTIAL_ENCRYPTION_KEY,
    timeout: config.HTTP_TIMEOUT_MS,
  };

  config.SUPABASE_URL = 'https://example.supabase.co';
  config.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  config.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key';
  config.HTTP_TIMEOUT_MS = 5_000;

  try {
    await test('ordinary Supabase writes never retry ambiguous network failures', async () => {
      const operations: Array<() => Promise<unknown>> = [
        () => supabaseInsert('queue_items', { id: 'one' }),
        () => supabaseUpsert('queue_items', { id: 'one' }, 'id'),
        () => supabaseUpdate('queue_items', { status: 'ready' }),
        () => supabaseDelete('queue_items'),
      ];

      for (const operation of operations) {
        let calls = 0;
        globalThis.fetch = (async () => {
          calls++;
          throw new TypeError('simulated network ambiguity');
        }) as typeof fetch;

        await assert.rejects(operation, SupabaseNetworkError);
        assert.equal(calls, 1);
      }
    });

    await test('Supabase reads retry transient network failures', async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (calls < 3) throw new TypeError('transient read failure');
        return new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;

      const rows = await supabaseSelect('queue_items', { limit: 1 });
      assert.deepEqual(rows, []);
      assert.equal(calls, 3);
    });

    await test('RPC calls do not retry unless the caller declares the contract retry-safe', async () => {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        throw new TypeError('ambiguous RPC failure');
      }) as typeof fetch;

      await assert.rejects(
        () => supabaseRpc('unsafe_write', { operation_id: 'one' }),
        SupabaseNetworkError
      );
      assert.equal(calls, 1);
    });

    await test('retry-safe RPC retries preserve the exact request identity and body', async () => {
      let calls = 0;
      const bodies: string[] = [];
      globalThis.fetch = (async (_input, init) => {
        calls++;
        bodies.push(String(init?.body || ''));
        if (calls === 1) throw new TypeError('transient RPC failure');
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;

      const body = {
        p_user_id: '11111111-1111-1111-1111-111111111111',
        p_claim_token: '22222222-2222-2222-2222-222222222222',
      };
      const result = await supabaseRpc<{ ok: boolean }>('claim_source_record_for_extraction', body, {
        retrySafe: true,
      });

      assert.deepEqual(result, { ok: true });
      assert.equal(calls, 2);
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0], JSON.stringify(body));
      assert.equal(bodies[1], JSON.stringify(body));
    });
  } finally {
    globalThis.fetch = originalFetch;
    config.SUPABASE_URL = originalConfig.url;
    config.SUPABASE_SERVICE_ROLE_KEY = originalConfig.role;
    config.CREDENTIAL_ENCRYPTION_KEY = originalConfig.encryption;
    config.HTTP_TIMEOUT_MS = originalConfig.timeout;
  }
}

void main();
