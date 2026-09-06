import fs from 'node:fs';

const path = 'src/supabase-worker.ts';
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`codemod marker missing: ${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`codemod marker is not unique: ${label}`);
  }
  source = source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function replaceFunction(startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`function start missing: ${label}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`function end marker missing: ${label}`);
  source = source.slice(0, start) + replacement.trimEnd() + '\n\n' + source.slice(end);
}

replaceOnce(
  "import { activePlatformsFromSettings } from './platform-settings';\n",
  "import { activePlatformsFromSettings } from './platform-settings';\nimport * as workerClaims from './worker-claims';\n",
  'worker claims import'
);

replaceOnce(
  "const DEFAULT_OPENAI_IMAGE_DAILY_CALL_LIMIT = 4;\n",
  `const DEFAULT_OPENAI_IMAGE_DAILY_CALL_LIMIT = 4;
const SOURCE_CLAIM_LEASE_SECONDS = 300;
const ANGLE_CLAIM_LEASE_SECONDS = 900;
const WORKER_CLAIMS_SCHEMA_UNAVAILABLE_CODE = 'worker_claims_schema_unavailable';
const WORKER_CLAIMS_SCHEMA_UNAVAILABLE_MESSAGE =
  'Generation is paused because the database worker-claim contract is not applied.';
const WORKER_CLAIMS_SCHEMA_UNAVAILABLE_NEXT_ACTION =
  'Apply the reviewed worker-claims-v1 database migrations before resuming source extraction or drafting.';
`,
  'claim constants'
);

replaceOnce(
  "async function loadTenantContext(userId: string): Promise<TenantContext> {",
  `async function ensureWorkerClaimsReady(job: AgentJobRow, summary: PipelineSummary): Promise<boolean> {
  try {
    await workerClaims.assertWorkerClaimsContract();
    return true;
  } catch (error) {
    summary.drafts.skipped++;
    incrementCounter(summary.drafts.skipReasons, WORKER_CLAIMS_SCHEMA_UNAVAILABLE_CODE);
    summary.failedStage ||= 'database_claim_contract';
    summary.failureCode ||= WORKER_CLAIMS_SCHEMA_UNAVAILABLE_CODE;
    if (!summary.errors.includes(WORKER_CLAIMS_SCHEMA_UNAVAILABLE_MESSAGE)) {
      summary.errors.push(WORKER_CLAIMS_SCHEMA_UNAVAILABLE_MESSAGE);
    }
    await writeWorkerLog(job.user_id, 'warn', WORKER_CLAIMS_SCHEMA_UNAVAILABLE_CODE, {
      jobId: job.id,
      kind: job.kind,
      expected_contract: workerClaims.WORKER_SCHEMA_CONTRACT,
      expected_capabilities: [...workerClaims.REQUIRED_WORKER_CLAIM_CAPABILITIES],
      error_type: error instanceof Error ? error.name : 'unknown',
      next_action: WORKER_CLAIMS_SCHEMA_UNAVAILABLE_NEXT_ACTION,
    });
    return false;
  }
}

async function releaseSourceClaimBestEffort(
  job: AgentJobRow,
  record: workerClaims.SourceRecordClaim,
  reason: string
): Promise<void> {
  try {
    const released = await workerClaims.releaseSourceRecordClaim(job.user_id, record);
    if (!released) {
      await writeWorkerLog(job.user_id, 'warn', 'source_claim_release_not_confirmed', {
        jobId: job.id,
        sourceRecordId: record.id,
        claimVersion: record.claim_version,
        reason,
      });
    }
  } catch (error) {
    await writeWorkerLog(job.user_id, 'warn', 'source_claim_release_uncertain', {
      jobId: job.id,
      sourceRecordId: record.id,
      claimVersion: record.claim_version,
      reason,
      error: publicError(error),
    });
  }
}

async function releaseAngleClaimBestEffort(
  job: AgentJobRow,
  record: workerClaims.AngleRecordClaim,
  reason: string
): Promise<void> {
  try {
    const released = await workerClaims.releaseAngleRecordClaim(job.user_id, record);
    if (!released) {
      await writeWorkerLog(job.user_id, 'warn', 'angle_claim_release_not_confirmed', {
        jobId: job.id,
        angleId: record.id,
        claimVersion: record.claim_version,
        reason,
      });
    }
  } catch (error) {
    await writeWorkerLog(job.user_id, 'warn', 'angle_claim_release_uncertain', {
      jobId: job.id,
      angleId: record.id,
      claimVersion: record.claim_version,
      reason,
      error: publicError(error),
    });
  }
}

async function exhaustAngleClaimBestEffort(
  job: AgentJobRow,
  record: workerClaims.AngleRecordClaim,
  reason: string
): Promise<boolean> {
  try {
    const exhausted = await workerClaims.exhaustAngleRecordClaim(job.user_id, record);
    if (!exhausted) {
      await writeWorkerLog(job.user_id, 'warn', 'angle_claim_exhaust_not_confirmed', {
        jobId: job.id,
        angleId: record.id,
        claimVersion: record.claim_version,
        reason,
      });
    }
    return exhausted;
  } catch (error) {
    await writeWorkerLog(job.user_id, 'warn', 'angle_claim_exhaust_uncertain', {
      jobId: job.id,
      angleId: record.id,
      claimVersion: record.claim_version,
      reason,
      error: publicError(error),
    });
    return false;
  }
}

async function loadTenantContext(userId: string): Promise<TenantContext> {`,
  'claim helpers'
);

replaceOnce(
  `  if (!summary.platforms.enabled.length) {
    summary.outcome = 'blocked';
    summary.message = 'No publishing platforms are enabled.';
    summary.nextAction = 'Enable at least one platform in Settings before drafting.';
    return;
  }

  if (summary.queue.openSlotsAtStart === 0) {`,
  `  if (!summary.platforms.enabled.length) {
    summary.outcome = 'blocked';
    summary.message = 'No publishing platforms are enabled.';
    summary.nextAction = 'Enable at least one platform in Settings before drafting.';
    return;
  }

  if (summary.failureCode === WORKER_CLAIMS_SCHEMA_UNAVAILABLE_CODE) {
    summary.outcome = 'blocked';
    summary.message = WORKER_CLAIMS_SCHEMA_UNAVAILABLE_MESSAGE;
    summary.nextAction = WORKER_CLAIMS_SCHEMA_UNAVAILABLE_NEXT_ACTION;
    return;
  }

  if (summary.queue.openSlotsAtStart === 0) {`,
  'claim readiness finalization'
);

replaceFunction(
  'async function processBankedSourceRecords(',
  'async function hasActiveBankedAngles',
  `async function processBankedSourceRecords(
  job: AgentJobRow,
  tenant: TenantContext,
  occupiedSlots: PlatformSlotOccupancy,
  timeZone: string,
  summary: PipelineSummary,
  openAIActivityLogsToday: WorkerLogRow[],
  sourceUrlsWithAngles: Set<string>
): Promise<{ banked: number; queued: number }> {
  const records = await supabaseSelect<SourceRecordRow>('source_records', {
    select: 'id,user_id,url,title,origin,score,used,fetched_at,created_at,updated_at,reddit_post_id,subreddit,reddit_author,content_hash,status,source_text',
    filters: [
      { column: 'user_id', operator: 'eq', value: job.user_id },
      { column: 'origin', operator: 'in', value: [...PROCESSABLE_SOURCE_RECORD_ORIGINS] },
      { column: 'status', operator: 'eq', value: 'banked' },
      { column: 'used', operator: 'eq', value: false },
    ],
    order: 'created_at.asc',
    limit: 10,
  });

  let banked = 0;
  let queued = 0;

  for (const candidate of records) {
    if (!isProcessableSourceRecordForAngleExtraction(candidate, sourceUrlsWithAngles)) continue;

    let record: workerClaims.SourceRecordClaim | undefined;
    try {
      record = (await workerClaims.claimSourceRecordById(
        job.user_id,
        candidate.id,
        workerClaims.createClaimToken(),
        SOURCE_CLAIM_LEASE_SECONDS
      )).record;
    } catch (error) {
      addSummaryError(summary, error);
      summary.failedStage ||= 'source_claim';
      summary.failureCode ||= 'source_claim_failed';
      await writeWorkerLog(job.user_id, 'warn', 'source_record_claim_failed', {
        jobId: job.id,
        sourceRecordId: candidate.id,
        error: publicError(error),
      });
      break;
    }
    if (!record) continue;

    const sourceText = String(record.source_text || '').trim();
    const fallbackSourceLabel = record.origin === 'authenticated_browser'
      ? 'browser_collector'
      : 'manual';

    summary.sources.postsFetched++;
    summary.sources.postsAccepted++;
    summary.sources.accepted++;

    const post: RedditPost = {
      id: record.reddit_post_id || record.id,
      title: record.title || (record.origin === 'authenticated_browser' ? 'Browser collector source' : 'Manual source'),
      selftext: sourceText,
      url: record.url,
      score: Number(record.score || 0),
      comments: 0,
      subreddit: record.subreddit || fallbackSourceLabel,
      author: record.reddit_author || fallbackSourceLabel,
      created: Date.parse(record.created_at || '') / 1000 || Date.now() / 1000,
    };

    await writeWorkerLog(job.user_id, 'info', 'source_record_selected_for_angle_extraction', {
      jobId: job.id,
      sourceRecordId: record.id,
      origin: record.origin || null,
      source_url_host: safeUrlHost(record.url),
      claimVersion: record.claim_version,
    });

    const extractionGuardRequest: OpenAIGenerationGuardRequest = {
      sourceRecordId: record.id,
      stage: ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE,
      type: 'text',
    };
    const extractionGuard = preflightOpenAIGeneration(
      tenant.settings,
      summary.openaiUsageToday,
      openAIActivityLogsToday,
      extractionGuardRequest
    );
    if (!extractionGuard.allowed) {
      summary.sources.withoutAngles++;
      summary.angles.extractionFailures++;
      incrementCounter(summary.angles.failureReasons, extractionGuard.code || 'openai_generation_preflight_blocked');
      if (extractionGuard.code?.startsWith('openai_')) {
        setSummaryGenerationPaused(summary, extractionGuard);
        summary.failedStage ||= extractionGuard.stage;
        summary.failureCode ||= extractionGuard.code;
      }
      await writeOpenAIPreflightSkip(job, extractionGuard, extractionGuardRequest);
      await releaseSourceClaimBestEffort(job, record, 'generation_preflight_blocked');
      break;
    }

    let extraction: Awaited<ReturnType<typeof ai.extractSourceBank>>;
    try {
      extraction = await extractSourceBankWithJobTimeout(
        post,
        openAIUsageContext(job, summary, ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE, {
          sourceRecordId: record.id,
        }),
        contentStrategyPromptOptions(tenant.settings)
      );
    } catch (error) {
      const textError = ai.openAITextErrorDetails(error, ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE);
      const failureCode = textError?.code || 'angle_extraction_failed';
      summary.sources.withoutAngles++;
      summary.angles.extractionFailures++;
      incrementCounter(summary.angles.failureReasons, failureCode);
      if (textError) {
        if (!summary.errors.includes(textError.userMessage)) summary.errors.push(textError.userMessage);
        summary.failedStage ||= textError.stage;
        summary.failureCode ||= textError.code;
      } else {
        addSummaryError(summary, error);
        summary.failedStage ||= ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE;
        summary.failureCode ||= failureCode;
      }
      await writeWorkerLog(job.user_id, 'warn', 'source_record_angle_extraction_failed', {
        jobId: job.id,
        sourceRecordId: record.id,
        origin: record.origin || null,
        source_url_host: safeUrlHost(record.url),
        error: textError?.userMessage || publicError(error),
        normalized_error_code: failureCode,
        stage: ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE,
        next_action: textError?.nextAction || 'Review the fallback import text, then retry source-record processing.',
        systemic: textError?.systemic === true,
        claimVersion: record.claim_version,
      });
      await releaseSourceClaimBestEffort(job, record, 'angle_extraction_failed');
      if (textError?.systemic) break;
      continue;
    }

    const angles = extraction.angles.slice(0, 5);
    const angleRows: workerClaims.SourceAngleCommitInput[] = angles.flatMap(angle => tenant.activePlatforms.map(platform => ({
      angle: \\`${'${angle.label}: ${angle.thesis}'}\\`,
      angle_title: angle.label,
      angle_summary: angle.thesis,
      intended_platform: platform,
      priority: angle.strength || null,
      topic: extraction.summary.topic || record.title || null,
    })));

    let committed: workerClaims.SourceAngleCommitResult;
    try {
      committed = await workerClaims.commitSourceAngleExtraction(job.user_id, record, angleRows);
    } catch (error) {
      addSummaryError(summary, error);
      summary.failedStage ||= 'source_angle_commit';
      summary.failureCode ||= 'source_claim_commit_failed';
      await writeWorkerLog(job.user_id, 'error', 'source_record_angle_commit_failed', {
        jobId: job.id,
        sourceRecordId: record.id,
        claimVersion: record.claim_version,
        requestedAngleCount: angleRows.length,
        error: publicError(error),
        next_action: 'Do not repeat paid extraction automatically. Reconcile the source claim and durable angle rows first.',
      });
      break;
    }

    const committedCount = Math.max(0, Number(committed.total_count || 0));
    banked += committedCount;
    summary.angles.created += committedCount;
    summary.angles.alreadyExisting += Math.max(0, angleRows.length - committedCount);
    if (!committedCount) summary.sources.withoutAngles++;
    sourceUrlsWithAngles.add(record.url);

    await writeWorkerLog(job.user_id, 'info', 'source_record_banked_angles', {
      jobId: job.id,
      sourceRecordId: record.id,
      origin: record.origin || null,
      angleCount: committedCount,
      claimVersion: record.claim_version,
    });

    if (!committedCount) continue;

    const queuedFromAngles = await queueFromBankedAngles(job, tenant, occupiedSlots, timeZone, summary, openAIActivityLogsToday);
    queued += queuedFromAngles.queued;
    if (queued > 0 || await hasActiveBankedAngles(job.user_id)) break;
  }

  return { banked, queued };
}`,
  'source claim pipeline'
);

replaceFunction(
  'async function queueFromBankedAngles(',
  'async function handleRefreshQueue',
  `async function queueFromBankedAngles(
  job: AgentJobRow,
  tenant: TenantContext,
  occupiedSlots: PlatformSlotOccupancy,
  timeZone: string,
  summary?: PipelineSummary,
  openAIActivityLogsToday: WorkerLogRow[] = []
): Promise<QueueFromAnglesResult> {
  const result: QueueFromAnglesResult = {
    queued: 0,
    draftableSeen: 0,
    failures: 0,
    rejected: 0,
  };
  let instagramImageGenerationBlocked = false;
  const plannedLocalDate = typeof job.payload?.target_local_date === 'string'
    && /^\\d{4}-\\d{2}-\\d{2}$/.test(job.payload.target_local_date)
    ? job.payload.target_local_date
    : undefined;
  const plannedPlatforms = plannedLocalDate
    ? tenant.activePlatforms.filter(platform => hasOpenActiveSlotForPlatform(
      platform,
      occupiedSlots,
      plannedLocalDate
    ))
    : tenant.activePlatforms;
  if (plannedLocalDate && !plannedPlatforms.length) return result;

  const angles = await supabaseSelect<AngleRecordRow>('angle_records', {
    select: '*',
    filters: [
      { column: 'user_id', operator: 'eq', value: job.user_id },
      { column: 'status', operator: 'in', value: ACTIVE_ANGLE_STATUSES },
      ...(plannedLocalDate
        ? [{ column: 'intended_platform', operator: 'in' as const, value: plannedPlatforms }]
        : []),
    ],
    order: 'created_at.asc',
    limit: 20,
  });
  const queuedAnglePlatformKeys = await loadQueuedAnglePlatformKeys(
    job.user_id,
    angles.map(angle => angle.id)
  );

  for (const angleRow of angles) {
    const platform = anglePlatform(angleRow, tenant);
    if (!platform || !isDraftableAngle(angleRow)) {
      const reason = !platform ? 'disabled_or_missing_platform' : 'missing_source_metadata';
      const rejectedRows = await supabaseUpdate<AngleRecordRow>('angle_records', {
        status: 'rejected',
      }, {
        filters: [
          { column: 'id', operator: 'eq', value: angleRow.id },
          { column: 'user_id', operator: 'eq', value: job.user_id },
          { column: 'status', operator: 'eq', value: 'unused' },
        ],
        returning: true,
      });
      if (!rejectedRows.length) continue;
      result.rejected++;
      if (summary) {
        summary.angles.legacyRejected++;
        if (!platform) summary.angles.disabledPlatformRejected++;
        else summary.angles.missingMetadataRejected++;
        incrementCounter(summary.angles.rejectionReasons, reason);
      }
      await writeWorkerLog(job.user_id, 'warn', 'legacy_angle_quarantined', {
        jobId: job.id,
        angleId: angleRow.id,
        reason,
      });
      continue;
    }

    result.draftableSeen++;
    if (platform === 'instagram' && instagramImageGenerationBlocked) {
      if (summary) {
        summary.drafts.skipped++;
        incrementCounter(summary.drafts.skipReasons, 'instagram_image_generation_unavailable');
      }
      await writeWorkerLog(job.user_id, 'warn', 'banked_angle_draft_skipped', {
        jobId: job.id,
        angleId: angleRow.id,
        platform,
        reason: 'instagram_image_generation_unavailable',
        next_action: ai.OPENAI_IMAGE_GENERATION_ABORTED_NEXT_ACTION,
      });
      continue;
    }

    const draftPreflight = draftCreationPreflightForAngle({
      angleId: angleRow.id,
      occupiedSlots,
      platform,
      queuedAnglePlatformKeys,
      targetLocalDate: plannedLocalDate,
    });
    if (!draftPreflight.allowed) {
      if (draftPreflight.code === 'angle_platform_draft_already_queued') {
        await supabaseUpdate('angle_records', {
          status: 'drafted',
        }, {
          filters: [
            { column: 'id', operator: 'eq', value: angleRow.id },
            { column: 'user_id', operator: 'eq', value: job.user_id },
            { column: 'status', operator: 'eq', value: 'unused' },
          ],
        });
      }
      applyDraftPreflightSkip(summary, draftPreflight, platform);
      await writeWorkerLog(job.user_id, 'info', 'banked_angle_draft_skipped', {
        jobId: job.id,
        angleId: angleRow.id,
        platform,
        reason: draftPreflight.code || 'generation_preflight_blocked',
        message: draftPreflight.message,
        next_action: draftPreflight.nextAction,
      });
      continue;
    }

    const imageGuardRequest: OpenAIGenerationGuardRequest | undefined = platform === 'instagram'
      ? {
        angleId: angleRow.id,
        platform,
        sourceRecordId: angleRow.source_record_id || undefined,
        stage: ai.OPENAI_IMAGE_GENERATION_STAGE,
        type: 'image',
      }
      : undefined;
    const imageGuard = imageGuardRequest
      ? preflightOpenAIGeneration(tenant.settings, summary?.openaiUsageToday || emptyOpenAIUsageDailySummary(tenant.settings), openAIActivityLogsToday, imageGuardRequest)
      : allowedOpenAIGuard();
    if (!imageGuard.allowed && imageGuardRequest) {
      applyDraftPreflightSkip(summary, imageGuard, platform);
      await writeOpenAIPreflightSkip(job, imageGuard, imageGuardRequest);
      instagramImageGenerationBlocked = true;
      continue;
    }

    const textGuardRequest: OpenAIGenerationGuardRequest = {
      angleId: angleRow.id,
      platform,
      sourceRecordId: angleRow.source_record_id || undefined,
      stage: 'platform_draft',
      type: 'text',
    };
    const textGuard = preflightOpenAIGeneration(
      tenant.settings,
      summary?.openaiUsageToday || emptyOpenAIUsageDailySummary(tenant.settings),
      openAIActivityLogsToday,
      textGuardRequest
    );
    if (!textGuard.allowed) {
      applyDraftPreflightSkip(summary, textGuard, platform);
      await writeOpenAIPreflightSkip(job, textGuard, textGuardRequest);
      continue;
    }

    const slot = plannedLocalDate
      ? nextOpenPlatformSlotForLocalDate(platform, occupiedSlots, timeZone, plannedLocalDate)
      : nextOpenPlatformSlot(platform, occupiedSlots, timeZone);
    if (!slot) {
      if (summary) {
        summary.drafts.skipped++;
        incrementCounter(summary.drafts.skipReasons, 'planned_local_date_has_no_open_slot');
      }
      continue;
    }

    let currentAngle: workerClaims.AngleRecordClaim | undefined;
    try {
      currentAngle = (await workerClaims.claimAngleRecordById(
        job.user_id,
        angleRow.id,
        [platform],
        workerClaims.createClaimToken(),
        ANGLE_CLAIM_LEASE_SECONDS
      )).record;
    } catch (error) {
      result.failures++;
      if (summary) {
        summary.drafts.failures++;
        incrementCounter(summary.drafts.failureReasons, 'angle_claim_failed');
        summary.failedStage ||= 'angle_claim';
        summary.failureCode ||= 'angle_claim_failed';
        addSummaryError(summary, error);
      }
      await writeWorkerLog(job.user_id, 'warn', 'angle_record_claim_failed', {
        jobId: job.id,
        angleId: angleRow.id,
        platform,
        error: publicError(error),
      });
      return result;
    }
    if (!currentAngle) {
      if (summary) {
        summary.drafts.skipped++;
        incrementCounter(summary.drafts.skipReasons, 'angle_claim_not_acquired');
      }
      continue;
    }
    if (summary) summary.drafts.attempted++;

    const selectedAngle = toAngleCandidateFromRecord(currentAngle as AngleRecordRow);
    const post: RedditPost = {
      id: currentAngle.source_reddit_post_id || currentAngle.id,
      title: currentAngle.topic || selectedAngle.label,
      selftext: selectedAngle.thesis,
      url: currentAngle.source_url || '',
      score: 0,
      comments: 0,
      subreddit: currentAngle.subreddit || 'banked',
      author: currentAngle.reddit_author || '',
      created: Date.parse(currentAngle.created_at || '') / 1000 || Date.now() / 1000,
    };
    const sourceSummary: SourceSummary = {
      source_type: 'reddit_post',
      topic: currentAngle.topic || selectedAngle.label,
      core_claim: selectedAngle.thesis,
      surface_problem: selectedAngle.thesis,
      deeper_problem: selectedAngle.practicalConsequence || selectedAngle.thesis,
      practical_consequence: selectedAngle.practicalConsequence || selectedAngle.thesis,
      specific_example: selectedAngle.specificExample || '',
      best_line: selectedAngle.hook || selectedAngle.thesis,
      audience_fit: selectedAngle.audienceFit || 'builders',
      tone_source: '',
      cta_goal: '',
    };

    let draft: Awaited<ReturnType<typeof ai.draftPlatforms>>;
    try {
      draft = await ai.draftPlatforms(
        post,
        sourceSummary,
        selectedAngle,
        [platform],
        {
          disableLearningMemory: true,
          disableImageGeneration: platform !== 'instagram',
          ...contentStrategyPromptOptions(tenant.settings),
          usageContext: openAIUsageContext(job, summary, 'platform_draft', {
            angleId: currentAngle.id,
            platform,
            sourceRecordId: currentAngle.source_record_id || undefined,
          }),
        }
      );
      if (platform === 'instagram' && !cloudinary.isCloudinaryUrl(draft.imageUrl)) {
        throw new WorkerJobError('instagram_image_not_persisted', 'instagram_image_not_persisted');
      }
    } catch (error) {
      result.failures++;
      const imageError = ai.openAIImageErrorDetails(error);
      const textError = imageError ? undefined : ai.openAITextErrorDetails(error, ai.OPENAI_TEXT_ANGLE_EXTRACTION_STAGE);
      if (summary) {
        summary.drafts.failures++;
        incrementCounter(summary.drafts.failuresByPlatform, platform);
        incrementCounter(summary.drafts.failureReasons, imageError?.code || textError?.code || errorFailureReason(error));
        if (imageError) {
          instagramImageGenerationBlocked = platform === 'instagram';
          if (!summary.errors.includes(imageError.userMessage)) summary.errors.push(imageError.userMessage);
          summary.failedStage ||= imageError.stage;
          summary.failureCode ||= imageError.code;
        } else if (textError) {
          if (!summary.errors.includes(textError.userMessage)) summary.errors.push(textError.userMessage);
          summary.failedStage ||= textError.stage;
          summary.failureCode ||= textError.code;
        } else {
          addSummaryError(summary, error);
        }
      }
      await releaseAngleClaimBestEffort(job, currentAngle, 'platform_draft_failed');
      const draftErrorContext = safeErrorContext(error);
      await writeWorkerLog(job.user_id, 'warn', 'banked_angle_draft_failed', {
        jobId: job.id,
        angleId: currentAngle.id,
        platform,
        claimVersion: currentAngle.claim_version,
        error: publicError(error),
        ...(draftErrorContext || {}),
      });
      if (textError?.systemic) {
        await writeWorkerLog(job.user_id, 'warn', 'banked_angle_draft_stopped', {
          jobId: job.id,
          angleId: currentAngle.id,
          normalized_error_code: textError.code,
          stage: textError.stage,
          next_action: textError.nextAction,
        });
        return result;
      }
      if (refreshQueueJobCapacityReached(result.queued, result.failures)) break;
      continue;
    }

    const draftText = getPlatformDraftText(draft, platform).trim();
    if (!draftText) {
      const exhausted = await exhaustAngleClaimBestEffort(job, currentAngle, 'no_draft_text_created');
      if (summary) {
        summary.drafts.skipped++;
        incrementCounter(summary.drafts.skipReasons, exhausted ? 'no_draft_text_created' : 'angle_claim_exhaust_not_confirmed');
      }
      continue;
    }

    let queueRow: workerClaims.QueueItemCommitResult;
    try {
      queueRow = await workerClaims.commitClaimedAngleDraft({
        userId: job.user_id,
        angleRecordId: currentAngle.id,
        claimToken: currentAngle.claim_token,
        claimVersion: currentAngle.claim_version,
        platform,
        slotIndex: slot.slotIndex,
        scheduledFor: slot.scheduledFor,
        scheduledLocalDate: slot.localDate,
        scheduledTimezone: timeZone,
        draftText,
        instagramImageUrl: platform === 'instagram' ? draft.imageUrl || null : null,
        instagramImagePrompt: platform === 'instagram' ? draft.imagePrompt || null : null,
        sourceUrl: currentAngle.source_url || \\`banked-angle:${'${currentAngle.id}'}\\`,
        sourceTitle: post.title,
        angle: selectedAngle.thesis,
      });
    } catch (error) {
      result.failures++;
      if (summary) {
        summary.drafts.failures++;
        incrementCounter(summary.drafts.failuresByPlatform, platform);
        incrementCounter(summary.drafts.failureReasons, 'angle_claim_commit_failed');
        summary.failedStage ||= 'angle_draft_commit';
        summary.failureCode ||= 'angle_claim_commit_failed';
        addSummaryError(summary, error);
      }
      await exhaustAngleClaimBestEffort(job, currentAngle, 'angle_claim_commit_failed');
      await writeWorkerLog(job.user_id, 'error', 'angle_claim_commit_failed', {
        jobId: job.id,
        angleId: currentAngle.id,
        platform,
        claimVersion: currentAngle.claim_version,
        error: publicError(error),
        next_action: 'Do not regenerate automatically. Reconcile the queue row and claim outcome first.',
      });
      return result;
    }

    occupiedSlots.add(platformSlotOccupancyKey(platform, slot.localDate, slot.slotIndex));
    queuedAnglePlatformKeys.add(anglePlatformDraftKey(currentAngle.id, platform));
    result.queued++;
    if (summary) {
      summary.queue.created++;
      summary.drafts.created++;
      summary.openaiUsageToday.platformDraftsCreatedToday++;
      incrementCounter(summary.queue.createdByPlatform, platform);
    }
    await writeWorkerLog(job.user_id, 'info', 'queued_banked_angle', {
      jobId: job.id,
      queueItemId: queueRow.id,
      slotIndex: slot.slotIndex,
      localDate: slot.localDate,
      localHour: slot.localHour,
      scheduledFor: slot.scheduledFor,
      timeZone,
      angleId: currentAngle.id,
      claimVersion: currentAngle.claim_version,
      platforms: [platform],
    });
    if (refreshQueueJobCapacityReached(result.queued)) {
      await writeWorkerLog(job.user_id, 'info', 'refresh_queue_job_yielded', {
        jobId: job.id,
        queuedRows: result.queued,
        reason: 'bounded_rows_per_worker_invocation',
      });
      break;
    }
  }

  return result;
}`,
  'angle claim pipeline'
);

replaceOnce(
  `  if (!tenant.activePlatforms.length) {
    summary.drafts.skipped++;
    incrementCounter(summary.drafts.skipReasons, 'no_enabled_platforms');
    return finishRefreshResult(job, summary, { fetched: 0, banked: 0, queued: 0 });
  }

  let queued = 0;`,
  `  if (!tenant.activePlatforms.length) {
    summary.drafts.skipped++;
    incrementCounter(summary.drafts.skipReasons, 'no_enabled_platforms');
    return finishRefreshResult(job, summary, { fetched: 0, banked: 0, queued: 0 });
  }
  if (!(await ensureWorkerClaimsReady(job, summary))) {
    return finishRefreshResult(job, summary, { fetched: 0, banked: 0, queued: 0 });
  }

  let queued = 0;`,
  'refresh queue schema gate'
);

replaceFunction(
  'async function releaseStaleRefreshAngleLocks(',
  'function reconstructStaleSummary',
  `async function releaseStaleRefreshAngleLocks(job: AgentJobRow, logs: WorkerLogRow[]): Promise<number> {
  if (job.kind !== 'refresh_queue') return 0;
  try {
    await workerClaims.assertWorkerClaimsContract();
  } catch {
    // During expand-first rollout, do not let missing claim columns block publishing
    // or let legacy stale recovery mutate rows it cannot fence safely.
    return 0;
  }

  let released = 0;
  for (const angleId of staleAngleIdsFromLogs(logs)) {
    const rows = await supabaseUpdate<AngleRecordRow>('angle_records', {
      status: 'unused',
    }, {
      filters: [
        { column: 'id', operator: 'eq', value: angleId },
        { column: 'user_id', operator: 'eq', value: job.user_id },
        { column: 'status', operator: 'eq', value: 'in_progress' },
        { column: 'claim_token', operator: 'is', value: null },
      ],
      returning: true,
    });
    released += rows.length;
  }
  return released;
}`,
  'stale legacy lock recovery'
);

fs.writeFileSync(path, source);
console.log('worker claim codemod applied');
