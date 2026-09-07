import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function readExact(path, expected) {
  const text = readFileSync(path, 'utf8');
  const hash = createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
  if (hash !== expected) throw new Error(`Refusing changed source: ${path} (${hash})`);
  return text;
}
function once(text, from, to) {
  if (text.split(from).length !== 2) throw new Error(`Expected one anchor: ${from.slice(0, 100)}`);
  return text.replace(from, to);
}
function section(text, start, end, replacement) {
  if (text.split(start).length !== 2 || text.split(end).length !== 2) throw new Error('Ambiguous function boundary');
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  if (b < a) throw new Error('Invalid function order');
  return text.slice(0, a) + replacement + '\n\n' + text.slice(b);
}

let worker = readExact('src/supabase-worker.ts', 'bce06f919a63aeb9530125ce58c479906552dff5');
worker = once(worker, "import * as workerClaims from './worker-claims';", "import * as workerClaims from './worker-claims';\nimport { executePublication, reconcilePublication, recoverStalePublications, PublicationPreflightError } from './publication-executor';");
worker = section(worker, 'async function publishQueueRow(', 'async function handlePublishNow(', `async function publishQueueRow(job: AgentJobRow, row: QueueItemRow, _settings: UserSettingsRow): Promise<JsonMap> {
  if (row.user_id !== job.user_id) throw new WorkerJobError('publication_tenant_mismatch');
  // Reload per item. publish_all must not retain the first item's stale credentials/settings.
  const tenant = await loadTenantContext(job.user_id);
  return withTenantRuntime(tenant, async () => {
    const execution = await executePublication({
      userId: job.user_id, queueItemId: row.id, platform: row.platform,
    }, {
      prepare: async payload => {
        // Disabled hosted publishers are rejected before token refresh or paid media work.
        if (payload.platform === 'threads' || payload.platform === 'instagram') {
          throw new PublicationPreflightError('legacy_meta_publication_disabled');
        }
        if (payload.platform === 'facebook') throw new PublicationPreflightError('facebook_paused');
        let providerAccountRef: string;
        if (payload.platform === 'x') {
          if (payload.text.trim().length > 280) throw new PublicationPreflightError('x_text_too_long');
          const verification = await x.verifyCredentials();
          providerAccountRef = verification.accountId;
        } else {
          if (!config.LINKEDIN_TOKEN || !config.LINKEDIN_PERSON_URN) {
            throw new PublicationPreflightError('linkedin_not_connected');
          }
          await refreshLinkedInCredentialForPublish(job.user_id);
          providerAccountRef = config.LINKEDIN_PERSON_URN;
        }
        // Recheck entitlement/pause/enablement immediately before the dispatch boundary.
        const entitlement = await loadEntitlement(job.user_id);
        if (!entitlement.canWrite) throw new PublicationPreflightError('billing_inactive');
        const settings = (await supabaseSelect<UserSettingsRow>('user_settings', {
          filters: [{ column: 'user_id', operator: 'eq', value: job.user_id }], limit: 1,
        }))[0] || {};
        if (!activePlatformsFromSettings(settings).includes(payload.platform)) {
          throw new PublicationPreflightError('platform_disabled');
        }
        if (jobOrigin(job) === 'scheduled') {
          if (settings.automation_enabled !== true || settings.automation_publish_enabled !== true) {
            throw new PublicationPreflightError('publish_automation_disabled');
          }
          // Schedule is frozen by the claimed intent. Content still comes only from payload.
          const frozenQueue = (await supabaseSelect<QueueItemRow>('queue_items', {
            select: 'id,user_id,scheduled_for',
            filters: [{ column: 'id', operator: 'eq', value: row.id }, { column: 'user_id', operator: 'eq', value: job.user_id }],
            limit: 1,
          }))[0];
          if (!frozenQueue || !(Date.parse(frozenQueue.scheduled_for) <= Date.now())) {
            throw new PublicationPreflightError('publication_not_due');
          }
        }
        const frozenRow: QueueItemRow = {
          ...row, platform: payload.platform, draft_text: payload.text,
          instagram_image_url: payload.instagram_image_url || null,
          source_url: payload.source_url || null, source_title: payload.source_title || null,
          angle: payload.angle || null, angle_record_id: payload.angle_record_id || null,
        };
        return {
          providerAccountRef,
          send: async () => ({ externalPostId: await publishPlatform(frozenRow) }),
        };
      },
      afterAccepted: async (_attempt, payload) => {
        if (payload.angle_record_id) {
          await supabaseUpdate('angle_records', { status: 'published', last_used_at: nowIso() }, {
            filters: [{ column: 'id', operator: 'eq', value: payload.angle_record_id }, { column: 'user_id', operator: 'eq', value: job.user_id }],
          });
        }
      },
    });
    // Non-authoritative telemetry cannot change publication truth or trigger a resend.
    try {
      await writeWorkerLog(job.user_id, execution.outcome === 'accepted' || execution.outcome === 'verified' ? 'info' : 'warn',
        'publication_result', { jobId: job.id, ...execution });
    } catch { /* Durable ledger remains the source of truth. */ }
    return execution;
  });
}`);
worker = section(worker, 'async function handlePublishAll(', 'async function handleSkipSlot(', `async function handlePublishAll(job: AgentJobRow, tenant: TenantContext): Promise<JsonMap> {
  const rows = await supabaseSelect<QueueItemRow>('queue_items', {
    filters: [{ column: 'user_id', operator: 'eq', value: job.user_id }, { column: 'status', operator: 'in', value: ['pending', 'ready'] }],
    order: 'scheduled_for.asc', limit: 100,
  });
  const published: JsonMap[] = [];
  const failures: JsonMap[] = [];
  for (const row of rows) {
    try {
      const outcome = await publishQueueRow(job, row, tenant.settings);
      if (outcome.outcome === 'accepted' || outcome.outcome === 'verified') published.push(outcome);
      else failures.push(outcome);
    } catch {
      failures.push({ queueItemId: row.id, platform: row.platform, failureCode: 'publication_execution_interrupted', nextAction: 'Reconcile the exact publication before retrying.' });
    }
  }
  const outcome = failures.length ? (published.length ? 'completed_with_errors' : 'blocked') : 'accepted';
  return { published, failures, outcome,
    jobStatus: failures.length ? (published.length ? 'completed_with_errors' : 'failed') : 'completed',
    summary: { outcome, published, failures, errors: failures.map(item => item.failureCode) },
  };
}`);
worker = section(worker, 'async function findPublishHistoryForQueueItem(', 'function stalePublishResult(', '// Legacy source-URL/time history matching removed. Ledger recovery uses exact identities.');
worker = section(worker, 'async function stalePublishJobResult(', 'async function cleanupStaleRunningJobs(', `async function stalePublishJobResult(job: AgentJobRow, _logs: WorkerLogRow[]): Promise<JsonMap> {
  const queueItemId = queueItemIdFromPayload(job.payload);
  const row = queueItemId ? await loadQueueItemForStalePublish(job, queueItemId) : undefined;
  if (!row) return {
    outcome: 'unknown', jobStatus: 'failed', failureCode: 'publication_queue_identity_missing',
    summary: { outcome: 'unknown', failureCode: 'publication_queue_identity_missing', nextAction: 'Reconcile publication identity before retrying. Do not recreate the post.', errors: ['publication_queue_identity_missing'] },
  };
  return reconcilePublication({ userId: job.user_id, queueItemId: row.id, platform: row.platform });
}`);
worker = once(worker, '  await cleanupStaleRunningJobs(stats, now);', '  await recoverStalePublications(now.getTime());\n  await cleanupStaleRunningJobs(stats, now);');
worker = once(worker, "  'Check the platform account for a matching post. If it is not live, retry this queue item manually.';", "  'Do not retry or recreate this post. Reconcile the exact publication attempt first; absence from a search is not proof of rejection.';");
worker = once(worker, 'export const __test__ = {', 'export const __test__ = {\n  publishQueueRow,\n  stalePublishJobResult,\n  handlePublishAll,');
writeFileSync('src/supabase-worker.ts', worker);

let x = readExact('src/x.ts', 'b670c7e0e76dcca96f6dbefd0d81d9e59f5a8829');
x = once(x, "    && classifyXError(response.message) === 'auth'\n  ) {", "    && method === 'GET'\n    && response.status === 401\n  ) {");
x = once(x, "    throw new Error('X API: ' + response.message);", `    throw new PlatformPublishError({
      platform: 'x', stage: payload ? 'post' : 'credential_check',
      code: 'platform_api_error', status: response.status,
      userMessage: 'X returned a non-success response.',
      nextAction: 'Review the exact attempt before any further publish.',
    });`);
writeFileSync('src/x.ts', x);

let linkedin = readExact('src/linkedin.ts', 'f9f1822966a636597b4d75b867c7b1c9aa9535fc');
linkedin = once(linkedin, "      return data.id || 'posted';", `      const id = data.id || headers.get('x-restli-id');
      if (typeof id !== 'string' || !id.trim()) throw new Error('LinkedIn acceptance receipt missing');
      return id;`);
writeFileSync('src/linkedin.ts', linkedin);

let outcomeTest = readExact('test/publication-outcome.test.ts', '291da5b872f0477d865113f94d97bdd516cb7fdf');
outcomeTest = once(outcomeTest, "'network-layer 4xx is rejected but network/server failures are unknown'", "'generic HTTP errors are not evidence of provider rejection'");
outcomeTest = once(outcomeTest, "{ code: 'UPSTREAM_HTTP_ERROR' })).outcome,\n      'rejected'", "{ code: 'UPSTREAM_HTTP_ERROR' })).outcome,\n      'unknown'");
writeFileSync('test/publication-outcome.test.ts', outcomeTest);

const packageText = readExact('package.json', '92440c568447331feb566016af70933f9514f4c3');
const packageJson = JSON.parse(packageText);
packageJson.scripts.test += ' && node dist/test/publication-executor.test.js && node dist/test/provider-single-dispatch.test.js';
writeFileSync('package.json', JSON.stringify(packageJson, null, 2) + '\n');
console.log('Applied five hash-guarded source changes. No database or provider calls were made.');
