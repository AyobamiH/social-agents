import { randomUUID } from 'node:crypto';

import {
  SupabaseRestError,
  supabaseRpc,
  supabaseSelect,
} from './supabase-client';
import type { PlatformKey } from './types';

export const PUBLICATION_SCHEMA_CONTRACT = 'publication-ledger-v1';
export const PUBLICATION_SCHEMA_MIGRATION = '20260907054000';
export const REQUIRED_PUBLICATION_CAPABILITIES = [
  'publication-intent-claim-v1',
  'publication-dispatch-boundary-v1',
  'publication-attempt-outcome-v1',
  'publication-unknown-reconciliation-v1',
  'publication-exact-history-receipt-v1',
  'publication-queue-compatibility-fence-v1',
  'publication-provenance-snapshot-v1',
] as const;

export interface PublicationSchemaContract {
  contract: string;
  migration: string;
  capabilities: string[];
}

export interface PublicationPayload {
  platform: PlatformKey;
  text: string;
  instagram_image_url?: string;
  source_url?: string;
  source_title?: string;
  angle?: string;
  angle_record_id?: string;
}

export type PublicationIntentState =
  | 'scheduled'
  | 'claimed'
  | 'dispatching'
  | 'accepted'
  | 'rejected'
  | 'unknown'
  | 'verified';

export type PublicationAttemptState =
  | 'dispatching'
  | 'accepted'
  | 'rejected'
  | 'unknown'
  | 'verified';

export interface PublicationIntent {
  id: string;
  user_id: string;
  queue_item_id: string;
  platform: PlatformKey;
  queue_status_before_claim: string;
  queue_revision_updated_at: string;
  payload: PublicationPayload;
  state: PublicationIntentState;
  claim_token?: string | null;
  claim_version: number;
  claim_expires_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicationAttempt {
  id: string;
  intent_id: string;
  user_id: string;
  queue_item_id: string;
  platform: PlatformKey;
  attempt_no: number;
  dispatch_operation_id: string;
  state: PublicationAttemptState;
  provider_account_ref?: string | null;
  provider_idempotency_key?: string | null;
  provider_idempotency_supported: boolean;
  external_post_id?: string | null;
  external_url?: string | null;
  provider_published_at?: string | null;
  provider_receipt?: Record<string, unknown> | null;
  error_code?: string | null;
  error_message?: string | null;
  reconciliation_evidence?: Record<string, unknown> | null;
  verification_evidence?: Record<string, unknown> | null;
  dispatch_started_at: string;
  outcome_recorded_at?: string | null;
  reconciled_at?: string | null;
  verified_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicationHistoryReceipt {
  id: string;
  user_id: string;
  platform: PlatformKey;
  post_text?: string | null;
  external_post_id?: string | null;
  external_url?: string | null;
  source_url?: string | null;
  published_at: string;
  queue_item_id?: string | null;
  publication_intent_id?: string | null;
  publication_attempt_id?: string | null;
}

export interface PublicationStateSnapshot {
  intent?: PublicationIntent;
  attempt?: PublicationAttempt;
  history?: PublicationHistoryReceipt;
}

export class PublicationLedgerContractError extends Error {
  readonly code = 'publication_ledger_schema_unavailable';

  constructor(message: string, public readonly causeDetails?: string) {
    super(message);
  }
}

export function createPublicationClaimToken(): string {
  return randomUUID();
}

export function createDispatchOperationId(): string {
  return randomUUID();
}

export async function getPublicationSchemaContract(): Promise<PublicationSchemaContract> {
  return supabaseRpc<PublicationSchemaContract>('get_publication_schema_contract', {}, { retrySafe: true });
}

export async function assertPublicationLedgerContract(): Promise<PublicationSchemaContract> {
  try {
    const contract = await getPublicationSchemaContract();
    if (contract?.contract !== PUBLICATION_SCHEMA_CONTRACT) {
      throw new PublicationLedgerContractError(
        `Expected ${PUBLICATION_SCHEMA_CONTRACT}, received ${String(contract?.contract || 'missing')}`
      );
    }
    if (contract.migration !== PUBLICATION_SCHEMA_MIGRATION) {
      throw new PublicationLedgerContractError(
        `Expected ${PUBLICATION_SCHEMA_CONTRACT} migration ${PUBLICATION_SCHEMA_MIGRATION}, received ${String(contract.migration || 'missing')}`
      );
    }
    const capabilities = new Set(contract.capabilities || []);
    const missing = REQUIRED_PUBLICATION_CAPABILITIES.filter(capability => !capabilities.has(capability));
    if (missing.length) {
      throw new PublicationLedgerContractError(
        `${PUBLICATION_SCHEMA_CONTRACT} is missing required capabilities: ${missing.join(', ')}`
      );
    }
    return contract;
  } catch (error) {
    if (error instanceof PublicationLedgerContractError) throw error;
    const detail = error instanceof SupabaseRestError
      ? `HTTP ${error.status}`
      : error instanceof Error
        ? error.name
        : 'unknown';
    throw new PublicationLedgerContractError(
      `${PUBLICATION_SCHEMA_CONTRACT} is not available on the configured Supabase project`,
      detail
    );
  }
}

export function isPublicationLedgerSchemaUnavailable(error: unknown): boolean {
  return error instanceof PublicationLedgerContractError;
}

export async function claimPublicationIntent(
  userId: string,
  queueItemId: string,
  claimToken = createPublicationClaimToken(),
  leaseSeconds = 120
): Promise<PublicationIntent> {
  const rows = await supabaseRpc<PublicationIntent[]>('claim_publication_intent', {
    p_user_id: userId,
    p_queue_item_id: queueItemId,
    p_claim_token: claimToken,
    p_lease_seconds: leaseSeconds,
  }, { retrySafe: true });
  const intent = rows[0];
  if (!intent) throw new Error('claim_publication_intent returned no intent');
  return intent;
}

export async function releasePublicationClaim(
  userId: string,
  intent: Pick<PublicationIntent, 'id' | 'claim_token' | 'claim_version'>,
  reason: string
): Promise<PublicationIntent> {
  if (!intent.claim_token) throw new Error('publication claim token missing');
  const rows = await supabaseRpc<PublicationIntent[]>('release_publication_claim', {
    p_user_id: userId,
    p_intent_id: intent.id,
    p_claim_token: intent.claim_token,
    p_claim_version: intent.claim_version,
    p_reason: reason,
  }, { retrySafe: true });
  const released = rows[0];
  if (!released) throw new Error('release_publication_claim returned no intent');
  return released;
}

export interface BeginDispatchInput {
  userId: string;
  intent: Pick<PublicationIntent, 'id' | 'claim_token' | 'claim_version'>;
  dispatchOperationId?: string;
  providerAccountRef?: string | null;
  providerIdempotencyKey?: string | null;
  providerIdempotencySupported?: boolean;
}

export async function beginPublicationDispatch(input: BeginDispatchInput): Promise<PublicationAttempt> {
  if (!input.intent.claim_token) throw new Error('publication claim token missing');
  const dispatchOperationId = input.dispatchOperationId || createDispatchOperationId();
  const rows = await supabaseRpc<PublicationAttempt[]>('begin_publication_dispatch', {
    p_user_id: input.userId,
    p_intent_id: input.intent.id,
    p_claim_token: input.intent.claim_token,
    p_claim_version: input.intent.claim_version,
    p_dispatch_operation_id: dispatchOperationId,
    p_provider_account_ref: input.providerAccountRef ?? null,
    p_provider_idempotency_key: input.providerIdempotencyKey ?? null,
    p_provider_idempotency_supported: input.providerIdempotencySupported === true,
  }, { retrySafe: true });
  const attempt = rows[0];
  if (!attempt) throw new Error('begin_publication_dispatch returned no attempt');
  return attempt;
}

export interface PublicationAcceptedInput {
  userId: string;
  attempt: Pick<PublicationAttempt, 'id' | 'dispatch_operation_id'>;
  externalPostId: string;
  externalUrl?: string | null;
  providerPublishedAt?: string | null;
  providerReceipt?: Record<string, unknown> | null;
}

export async function recordPublicationAccepted(input: PublicationAcceptedInput): Promise<PublicationAttempt> {
  const rows = await supabaseRpc<PublicationAttempt[]>('record_publication_accepted', {
    p_user_id: input.userId,
    p_attempt_id: input.attempt.id,
    p_dispatch_operation_id: input.attempt.dispatch_operation_id,
    p_external_post_id: input.externalPostId,
    p_external_url: input.externalUrl ?? null,
    p_provider_published_at: input.providerPublishedAt ?? null,
    p_provider_receipt: input.providerReceipt ?? null,
  }, { retrySafe: true });
  const attempt = rows[0];
  if (!attempt) throw new Error('record_publication_accepted returned no attempt');
  return attempt;
}

export interface PublicationFailureInput {
  userId: string;
  attempt: Pick<PublicationAttempt, 'id' | 'dispatch_operation_id'>;
  errorCode?: string | null;
  errorMessage?: string | null;
  providerReceipt?: Record<string, unknown> | null;
}

export async function recordPublicationRejected(input: PublicationFailureInput): Promise<PublicationAttempt> {
  const rows = await supabaseRpc<PublicationAttempt[]>('record_publication_rejected', {
    p_user_id: input.userId,
    p_attempt_id: input.attempt.id,
    p_dispatch_operation_id: input.attempt.dispatch_operation_id,
    p_error_code: input.errorCode ?? null,
    p_error_message: input.errorMessage ?? null,
    p_provider_receipt: input.providerReceipt ?? null,
  }, { retrySafe: true });
  const attempt = rows[0];
  if (!attempt) throw new Error('record_publication_rejected returned no attempt');
  return attempt;
}

export async function recordPublicationUnknown(input: PublicationFailureInput): Promise<PublicationAttempt> {
  const rows = await supabaseRpc<PublicationAttempt[]>('record_publication_unknown', {
    p_user_id: input.userId,
    p_attempt_id: input.attempt.id,
    p_dispatch_operation_id: input.attempt.dispatch_operation_id,
    p_error_code: input.errorCode ?? null,
    p_error_message: input.errorMessage ?? null,
    p_provider_receipt: input.providerReceipt ?? null,
  }, { retrySafe: true });
  const attempt = rows[0];
  if (!attempt) throw new Error('record_publication_unknown returned no attempt');
  return attempt;
}

export async function loadPublicationStateForQueueItem(
  userId: string,
  queueItemId: string
): Promise<PublicationStateSnapshot> {
  const intent = (await supabaseSelect<PublicationIntent>('publication_intents', {
    select: '*',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'queue_item_id', operator: 'eq', value: queueItemId },
    ],
    limit: 1,
  }))[0];
  if (!intent) return {};

  const attempt = (await supabaseSelect<PublicationAttempt>('publication_attempts', {
    select: '*',
    filters: [
      { column: 'user_id', operator: 'eq', value: userId },
      { column: 'intent_id', operator: 'eq', value: intent.id },
    ],
    order: 'attempt_no.desc',
    limit: 1,
  }))[0];

  const history = attempt
    ? (await supabaseSelect<PublicationHistoryReceipt>('publish_history', {
      select: 'id,user_id,platform,post_text,external_post_id,external_url,source_url,published_at,queue_item_id,publication_intent_id,publication_attempt_id',
      filters: [
        { column: 'user_id', operator: 'eq', value: userId },
        { column: 'publication_attempt_id', operator: 'eq', value: attempt.id },
      ],
      limit: 1,
    }))[0]
    : undefined;

  return { intent, attempt, history };
}
