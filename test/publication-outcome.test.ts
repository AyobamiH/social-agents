import assert from 'node:assert/strict';

import { HttpError } from '../src/errors';
import { PlatformPublishError } from '../src/platform-errors';
import { classifyPostDispatchError } from '../src/publication-outcome';

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
  await test('explicit provider 4xx post response is a known rejection', async () => {
    const result = classifyPostDispatchError(new PlatformPublishError({
      platform: 'linkedin',
      stage: 'post',
      code: 'provider_http_error',
      userMessage: 'Provider rejected the post.',
      nextAction: 'Fix the request and retry.',
      status: 422,
    }));
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.providerReceipt.http_status, 422);
  });

  await test('408 remains unknown because the external effect may have happened', async () => {
    const result = classifyPostDispatchError(new PlatformPublishError({
      platform: 'x',
      stage: 'post',
      code: 'provider_timeout',
      userMessage: 'Provider timed out.',
      nextAction: 'Reconcile the exact attempt.',
      status: 408,
    }));
    assert.equal(result.outcome, 'unknown');
  });

  await test('provider 5xx remains unknown after the dispatch boundary', async () => {
    const result = classifyPostDispatchError(new PlatformPublishError({
      platform: 'linkedin',
      stage: 'post',
      code: 'provider_http_error',
      userMessage: 'Provider failed after receiving the request.',
      nextAction: 'Reconcile the exact attempt.',
      status: 503,
    }));
    assert.equal(result.outcome, 'unknown');
  });

  await test('generic HTTP errors are not evidence of provider rejection', async () => {
    assert.equal(
      classifyPostDispatchError(new HttpError(400, 'bad request', { code: 'UPSTREAM_HTTP_ERROR' })).outcome,
      'unknown'
    );
    assert.equal(
      classifyPostDispatchError(new HttpError(504, 'timeout', { code: 'UPSTREAM_TIMEOUT' })).outcome,
      'unknown'
    );
    assert.equal(
      classifyPostDispatchError(new HttpError(502, 'network failed', { code: 'UPSTREAM_REQUEST_FAILED' })).outcome,
      'unknown'
    );
  });

  await test('unclassified post-dispatch exceptions fail conservative to unknown', async () => {
    const result = classifyPostDispatchError(new Error('missing provider receipt'));
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.providerReceipt.outcome_classification, 'ambiguous_unknown');
  });
}

void main();
