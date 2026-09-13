import assert from 'node:assert/strict';

import config from '../config';
import {
  PUBLICATION_SCHEMA_CONTRACT,
  PUBLICATION_SCHEMA_MIGRATION,
  REQUIRED_PUBLICATION_CAPABILITIES,
  PublicationLedgerContractError,
  assertPublicationLedgerContract,
  beginPublicationDispatch,
  claimPublicationIntent,
  createDispatchOperationId,
  createPublicationClaimToken,
  recordPublicationAccepted,
  recordPublicationUnknown,
  releasePublicationClaim,
} from '../src/publication-ledger';

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
  };

  config.SUPABASE_URL = 'https://example.supabase.co';
  config.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
  config.CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key';

  try {
    await test('publication claim and dispatch identities are caller-owned UUIDs', async () => {
      assert.match(
        createPublicationClaimToken(),
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      assert.match(
        createDispatchOperationId(),
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    await test('schema probe requires the exact complete publication-ledger-v1 head', async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        contract: PUBLICATION_SCHEMA_CONTRACT,
        migration: PUBLICATION_SCHEMA_MIGRATION,
        capabilities: [...REQUIRED_PUBLICATION_CAPABILITIES],
      }), { status: 200 })) as typeof fetch;

      const contract = await assertPublicationLedgerContract();
      assert.equal(contract.contract, PUBLICATION_SCHEMA_CONTRACT);
      assert.equal(contract.migration, PUBLICATION_SCHEMA_MIGRATION);

      globalThis.fetch = (async () => new Response(JSON.stringify({
        contract: PUBLICATION_SCHEMA_CONTRACT,
        migration: '20260907053000',
        capabilities: REQUIRED_PUBLICATION_CAPABILITIES.filter(
          capability => capability !== 'publication-provenance-snapshot-v1'
        ),
      }), { status: 200 })) as typeof fetch;

      await assert.rejects(
        () => assertPublicationLedgerContract(),
        (error: unknown) => error instanceof PublicationLedgerContractError
          && error.code === 'publication_ledger_schema_unavailable'
          && error.message.includes(PUBLICATION_SCHEMA_MIGRATION)
      );
    });

    await test('publication dispatch requires the queue lock-order migration capability', async () => {
      globalThis.fetch = (async () => Response.json({
        contract: PUBLICATION_SCHEMA_CONTRACT,
        migration: PUBLICATION_SCHEMA_MIGRATION,
        capabilities: REQUIRED_PUBLICATION_CAPABILITIES.filter(
          capability => capability !== 'publication-queue-lock-order-v1'
        ),
      })) as typeof fetch;
      await assert.rejects(
        () => assertPublicationLedgerContract(),
        (error: unknown) => error instanceof PublicationLedgerContractError
          && error.code === 'publication_ledger_schema_unavailable'
          && error.message.includes('publication-queue-lock-order-v1')
      );
    });

    await test('claim, release, and dispatch preserve exact fencing identities', async () => {
      const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
      const claimToken = '61000000-0000-4000-8000-000000000001';
      const dispatchOperationId = '62000000-0000-4000-8000-000000000001';
      let claimVersion = 7;

      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        bodies.push({ url, body });

        if (url.endsWith('/rpc/claim_publication_intent')) {
          return new Response(JSON.stringify([{
            id: 'intent-1',
            user_id: 'user-1',
            queue_item_id: 'queue-1',
            platform: 'linkedin',
            queue_status_before_claim: 'ready',
            queue_revision_updated_at: '2026-09-07T00:00:00Z',
            payload: {
              platform: 'linkedin',
              text: 'exact snapshot',
              source_url: 'https://example.com/source',
            },
            state: 'claimed',
            claim_token: claimToken,
            claim_version: claimVersion,
            claim_expires_at: '2026-09-07T00:02:00Z',
            created_at: '2026-09-07T00:00:00Z',
            updated_at: '2026-09-07T00:00:00Z',
          }]), { status: 200 });
        }

        if (url.endsWith('/rpc/release_publication_claim')) {
          return new Response(JSON.stringify([{
            id: 'intent-1',
            user_id: 'user-1',
            queue_item_id: 'queue-1',
            platform: 'linkedin',
            queue_status_before_claim: 'ready',
            queue_revision_updated_at: '2026-09-07T00:00:00Z',
            payload: { platform: 'linkedin', text: 'exact snapshot' },
            state: 'scheduled',
            claim_token: null,
            claim_version: claimVersion,
            claim_expires_at: null,
            created_at: '2026-09-07T00:00:00Z',
            updated_at: '2026-09-07T00:00:01Z',
          }]), { status: 200 });
        }

        if (url.endsWith('/rpc/begin_publication_dispatch')) {
          return new Response(JSON.stringify([{
            id: 'attempt-1',
            intent_id: 'intent-1',
            user_id: 'user-1',
            queue_item_id: 'queue-1',
            platform: 'linkedin',
            attempt_no: 1,
            dispatch_operation_id: dispatchOperationId,
            state: 'dispatching',
            provider_account_ref: 'linkedin:member-1',
            provider_idempotency_key: null,
            provider_idempotency_supported: false,
            dispatch_started_at: '2026-09-07T00:00:02Z',
            created_at: '2026-09-07T00:00:02Z',
            updated_at: '2026-09-07T00:00:02Z',
          }]), { status: 200 });
        }

        throw new Error(`unexpected request: ${url}`);
      }) as typeof fetch;

      const intent = await claimPublicationIntent('user-1', 'queue-1', claimToken, 120);
      assert.equal(intent.claim_token, claimToken);
      assert.equal(intent.claim_version, claimVersion);
      assert.equal(intent.payload.text, 'exact snapshot');

      await releasePublicationClaim('user-1', intent, 'safe pre-dispatch release');
      claimVersion += 1;
      const reclaimed = { ...intent, claim_version: claimVersion };
      const attempt = await beginPublicationDispatch({
        userId: 'user-1',
        intent: reclaimed,
        dispatchOperationId,
        providerAccountRef: 'linkedin:member-1',
      });

      assert.equal(attempt.dispatch_operation_id, dispatchOperationId);
      assert.equal(bodies[0].body.p_claim_token, claimToken);
      assert.equal(bodies[1].body.p_claim_version, 7);
      assert.equal(bodies[2].body.p_claim_version, 8);
      assert.equal(bodies[2].body.p_dispatch_operation_id, dispatchOperationId);
      assert.equal(bodies[2].body.p_provider_idempotency_supported, false);
    });

    await test('accepted and unknown outcome writes carry exact attempt operation identity', async () => {
      const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
        bodies.push({ url, body });
        const state = url.endsWith('/rpc/record_publication_unknown') ? 'unknown' : 'accepted';
        return new Response(JSON.stringify([{
          id: 'attempt-1',
          intent_id: 'intent-1',
          user_id: 'user-1',
          queue_item_id: 'queue-1',
          platform: 'linkedin',
          attempt_no: 1,
          dispatch_operation_id: '62000000-0000-4000-8000-000000000001',
          state,
          provider_idempotency_supported: false,
          external_post_id: state === 'accepted' ? 'post-1' : null,
          dispatch_started_at: '2026-09-07T00:00:02Z',
          outcome_recorded_at: '2026-09-07T00:00:03Z',
          created_at: '2026-09-07T00:00:02Z',
          updated_at: '2026-09-07T00:00:03Z',
        }]), { status: 200 });
      }) as typeof fetch;

      const attempt = {
        id: 'attempt-1',
        dispatch_operation_id: '62000000-0000-4000-8000-000000000001',
      };
      await recordPublicationAccepted({
        userId: 'user-1',
        attempt,
        externalPostId: 'post-1',
        providerPublishedAt: '2026-09-07T00:00:03Z',
        providerReceipt: { status: 201 },
      });
      await recordPublicationUnknown({
        userId: 'user-1',
        attempt,
        errorCode: 'network_timeout_after_dispatch',
        errorMessage: 'provider outcome could not be observed',
        providerReceipt: { network: 'timeout' },
      });

      assert.equal(bodies[0].body.p_attempt_id, 'attempt-1');
      assert.equal(
        bodies[0].body.p_dispatch_operation_id,
        '62000000-0000-4000-8000-000000000001'
      );
      assert.equal(bodies[0].body.p_external_post_id, 'post-1');
      assert.equal(bodies[1].body.p_error_code, 'network_timeout_after_dispatch');
      assert.equal(
        bodies[1].body.p_dispatch_operation_id,
        '62000000-0000-4000-8000-000000000001'
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
    config.SUPABASE_URL = originalConfig.url;
    config.SUPABASE_SERVICE_ROLE_KEY = originalConfig.role;
    config.CREDENTIAL_ENCRYPTION_KEY = originalConfig.encryption;
  }
}

void main();
