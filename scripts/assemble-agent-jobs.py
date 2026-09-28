from pathlib import Path
p=Path('src/supabase-worker.ts')
s=p.read_text()
a=s.index('interface AgentJobRow {'); b=s.index('\ninterface ProfileRow',a)
s=s[:a]+s[b:]
s="import { AgentJobOwnershipLostError, assertAgentJobsContract, assertActiveAgentJob, claimAgentJob, enqueueScheduledAgentJob, finishAgentJob, scheduledOperationKey, withAgentJobLease, type AgentJobRow } from './agent-jobs';\n"+s
a=s.index('async function claimJob('); b=s.index('\nfunction resultSummary',a)
s=s[:a]+'''async function claimJob(job: AgentJobRow): Promise<AgentJobRow | null> {
  return claimAgentJob(job);
}
'''+s[b:]
a=s.index('async function completeJob('); b=s.index('\nfunction hashId',a)
s=s[:a]+'''async function completeJob(job: AgentJobRow, result: JsonMap): Promise<string> {
  const status = terminalStatusForResult(result);
  await finishAgentJob(job, status, result, resultErrorMessage(result, status),
    isScheduledJob(job) ? automationResultPayload(job, status, result) : null);
  return status;
}

async function failJob(job: AgentJobRow, error: unknown): Promise<void> {
  const message = publicError(error);
  const result = { outcome: 'blocked', message, nextAction: errorNextAction(error), error: message, context: safeErrorContext(error) };
  await finishAgentJob(job, 'failed', result, message,
    isScheduledJob(job) ? automationResultPayload(job, 'failed', result) : null);
}
'''+s[b:]
a=s.index('async function recordScheduledAutomationResult('); b=s.index('\nasync function extractSourceBankWithJobTimeout',a)
s=s[:a]+s[b:]
a=s.index("      const dueAt = settings.next_fetch_at || now.toISOString();")
b=s.index('      stats.fetchJobsEnqueued++;',a)
s=s[:a]+'''      const dueAt = settings.next_fetch_at || '1970-01-01T00:00:00.000Z';
      const job = await enqueueScheduledAgentJob(settings.user_id, 'fetch_sources', {
        source: SCHEDULED_SOURCE, scheduler: SCHEDULER_NAME, due_at: dueAt,
      }, scheduledOperationKey('fetch', dueAt));
      if (!job) { incrementSchedulerSkip(stats, 'fetch_identity_replayed'); continue; }
      const nextFetchAt = 'database-owned';
'''+s[b:]
a=s.index("        const inserted = await supabaseInsert<AgentJobRow>('agent_jobs'")
b=s.index('        stats.slotFillJobsEnqueued++;',a)
s=s[:a]+'''        const revision = inventoryJobRevision(activeRows, tenant.activePlatforms);
        const job = await enqueueScheduledAgentJob(settings.user_id, 'refresh_queue', {
          source: SCHEDULED_SOURCE, scheduler: SCHEDULER_NAME, mode: 'next_day_inventory',
          fill_existing_angles_only: hasAngles, target_local_date: targetLocalDate,
          due_at: `${targetLocalDate}T00:00:00.000Z`,
        }, scheduledOperationKey('inventory', [targetLocalDate, timeZone, hasAngles, revision]));
        if (!job) { incrementSchedulerSkip(stats, 'fill_identity_replayed'); continue; }
'''+s[b:]
a=s.index("      const inserted = await supabaseInsert<AgentJobRow>('agent_jobs'")
b=s.index('      stats.slotFillJobsEnqueued++;',a)
s=s[:a]+'''      const fillDate = tenantLocalDatePlusDays(now, timeZone, 0);
      const job = await enqueueScheduledAgentJob(settings.user_id, 'refresh_queue', {
        source: SCHEDULED_SOURCE, scheduler: SCHEDULER_NAME, mode: 'fill_existing_angles',
        fill_existing_angles_only: true, due_at: `${fillDate}T00:00:00.000Z`,
      }, scheduledOperationKey('fill', [fillDate, timeZone, inventoryJobRevision(activeRows, tenant.activePlatforms)]));
      if (!job) { incrementSchedulerSkip(stats, 'fill_identity_replayed'); continue; }
'''+s[b:]
a=s.index("      const inserted = await supabaseInsert<AgentJobRow>('agent_jobs'")
b=s.index('      stats.publishJobsEnqueued++;',a)
s=s[:a]+'''      const job = await enqueueScheduledAgentJob(row.user_id, 'publish_now', {
        source: SCHEDULED_SOURCE, scheduler: SCHEDULER_NAME, queue_item_id: row.id, due_at: row.scheduled_for,
      }, scheduledOperationKey('publish', [row.id, row.scheduled_for]));
      if (!job) { incrementSchedulerSkip(stats, 'publish_identity_replayed'); continue; }
'''+s[b:]
a=s.index('async function cleanupStaleRunningJobs('); b=s.index('\nexport async function runSupabaseAutomationScheduler',a)
s=s[:a]+'''async function cleanupStaleRunningJobs(stats: SchedulerStats, now: Date): Promise<void> {
  const allowedUserIds = rolloutAllowedUserIds();
  if (allowedUserIds?.length === 0) return;
  const jobs = await supabaseSelect<AgentJobRow>('agent_jobs', {
    select: '*', filters: [
      { column: 'status', operator: 'eq', value: 'running' },
      { column: 'claim_expires_at', operator: 'lte', value: now.toISOString() },
      ...(allowedUserIds ? [{ column: 'user_id', operator: 'in' as const, value: allowedUserIds }] : []),
    ], order: 'claim_expires_at.asc', limit: 50,
  });
  for (const expired of jobs) {
    try {
      const job = await claimAgentJob(expired, true);
      if (!job) { incrementSchedulerSkip(stats, 'recovery_owner_changed'); continue; }
      const result = await withAgentJobLease(job, async () => {
        const logs = await staleJobLogs(job);
        return job.kind === 'publish_now' ? stalePublishJobResult(job, logs)
          : staleJobResult(job, logs, staleFailureFromLogs(logs));
      });
      // No log-derived angle release or blind execute/re-enqueue. The independent
      // source/angle/publication ledgers retain their own recovery authority.
      await completeJob(job, result);
      stats.staleJobsFailed++;
    } catch (error) {
      await recordSchedulerFailure(stats, 'job_recovery', error, expired.user_id);
    }
  }
}
'''+s[b:]
s=s.replace('  const now = new Date();\n  const stages:', '  await assertAgentJobsContract();\n  const now = new Date();\n  const stages:')
a=s.index('export async function processPendingSupabaseJobs('); b=s.index('\nexport function startSupabaseWorkerLoop',a)
s=s[:a]+'''export async function processPendingSupabaseJobs(): Promise<WorkerStats> {
  const stats: WorkerStats = { claimed: 0, completed: 0, failed: 0 };
  await assertAgentJobsContract();
  const jobs = await listPendingJobs();
  for (const pendingJob of jobs) {
    let job: AgentJobRow | null = null;
    try {
      job = await claimJob(pendingJob);
      if (!job) continue;
      stats.claimed++;
      const result = await withAgentJobLease(job, () => handleClaimedJob(job!));
      const status = await completeJob(job, result);
      if (status === 'failed') stats.failed++; else stats.completed++;
    } catch (error) {
      if (job && !(error instanceof AgentJobOwnershipLostError)) {
        try { await failJob(job, error); stats.failed++; }
        catch { logger.warn('Job finalisation unconfirmed; fenced reconciliation required.'); }
      } else logger.warn('Job ownership unconfirmed; no handler retry or unfenced completion.');
    }
  }
  return stats;
}
'''+s[b:]
s=s.replace('    const extraction = await ai.extractSourceBank(', '    await assertActiveAgentJob();\n    const extraction = await ai.extractSourceBank(')
s=s.replace('      draft = await ai.draftPlatforms(', '      await assertActiveAgentJob();\n      draft = await ai.draftPlatforms(')
s=s.replace('send: async () => ({ externalPostId: await publishPlatform(frozenRow) }),', "send: async () => { await assertActiveAgentJob(); return { externalPostId: await publishPlatform(frozenRow) }; },")
s=s.replace('  assertSupportedJobKind(job.kind);\n', '  await assertActiveAgentJob();\n  assertSupportedJobKind(job.kind);\n')
pos=s.index('async function hasPendingOrRunningFetch')
s=s[:pos]+'''function inventoryJobRevision(rows: QueueItemRow[], platforms: PlatformKey[]): unknown {
  return [platforms.slice().sort(), rows.map(row => [row.id, row.platform, row.status, row.scheduled_for])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))];
}

'''+s[pos:]
p.write_text(s)
p=Path('test/scheduler-isolation.test.ts');s=p.read_text();s=s.replace("          if (url.pathname.includes('/rpc/'))", """          if (table === 'get_agent_jobs_contract') return json({ contract: 'agent-jobs-v1', capabilities: ['durable-enqueue-v1', 'fenced-terminal-v1', 'reconciliation-only-recovery-v1', 'rpc-only-job-writes-v1'] });
          if (table === 'enqueue_worker_agent_job') {
            const args = JSON.parse(String(init?.body));
            const job = { user_id: args.p_user_id, kind: args.p_kind, payload: args.p_payload, id: `job-${enqueued.length + 1}` };
            enqueued.push(job);
            return json({ created: true, job });
          }
          if (url.pathname.includes('/rpc/'))""");s=s.replace("url.searchParams.has('started_at')", "url.searchParams.has('claim_expires_at')")
a=s.index("          if (table === 'agent_jobs' && method === 'POST')");b=s.index("          if (table === 'queue_items'",a);s=s[:a]+s[b:];p.write_text(s)
p=Path('package.json');s=p.read_text().replace('node dist/test/scheduler-isolation.test.js"', 'node dist/test/scheduler-isolation.test.js && node dist/test/agent-jobs.test.js"');p.write_text(s)
