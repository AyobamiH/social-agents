import assert from 'node:assert/strict';
import config from '../config';
import { recordObservedAcceptance } from '../src/publication-receipts';

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const previous = { SUPABASE_URL: config.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: config.SUPABASE_SERVICE_ROLE_KEY, CREDENTIAL_ENCRYPTION_KEY: config.CREDENTIAL_ENCRYPTION_KEY };
  Object.assign(config, { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role', CREDENTIAL_ENCRYPTION_KEY: 'fixture-key' });
  const input = { userId: 'owner', attempt: { id: 'attempt', dispatch_operation_id: 'dispatch' }, externalPostId: '12345' };
  try {
    const paths: string[] = [];
    let evidence: Record<string, unknown> = {};
    globalThis.fetch = (async (url, init) => {
      paths.push(String(url));
      if (String(url).endsWith('/record_publication_accepted')) {
        return Response.json({ message: 'publication_unknown_requires_reconciliation', code: 'P0001' }, { status: 400 });
      }
      const body = JSON.parse(String(init?.body));
      evidence = body.p_reconciliation_evidence;
      assert.equal(body.p_external_post_id, '12345');
      assert.equal(body.p_user_id, 'owner');
      assert.equal(body.p_attempt_id, 'attempt');
      assert.equal(body.p_dispatch_operation_id, 'dispatch');
      return Response.json([{ id: 'attempt', state: 'accepted', external_post_id: '12345' }]);
    }) as typeof fetch;
    assert.equal((await recordObservedAcceptance(input)).state, 'accepted');
    assert.equal(paths.length, 2);
    assert.ok(paths[1].endsWith('/resolve_publication_unknown_accepted'));
    assert.equal(evidence.kind, 'exact_attempt_provider_acceptance_response');
    assert.equal(evidence.attempt_id, 'attempt');
    assert.equal(evidence.dispatch_operation_id, 'dispatch');
    console.log('ok - exact delayed provider acceptance resolves its own unknown attempt with positive evidence');

    paths.length = 0;
    globalThis.fetch = (async url => {
      paths.push(String(url));
      return Response.json({ message: 'unrelated validation error', code: 'P0001' }, { status: 400 });
    }) as typeof fetch;
    await assert.rejects(() => recordObservedAcceptance(input));
    assert.equal(paths.length, 1);
    console.log('ok - arbitrary database failures do not trigger an evidence-resolution shortcut');
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config, previous);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
