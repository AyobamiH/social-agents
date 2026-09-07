import { recordPublicationAccepted, type PublicationAcceptedInput, type PublicationAttempt } from './publication-ledger';
import { SupabaseRestError, supabaseRpc } from './supabase-client';

/**
 * A delayed successful provider response is positive evidence for this exact
 * attempt. It may race the stale-attempt scanner, but it never authorises a resend.
 * A negative provider search is deliberately not an input to this operation.
 */
export async function recordObservedAcceptance(input: PublicationAcceptedInput): Promise<PublicationAttempt> {
  const observedAt = new Date().toISOString();
  try {
    return await recordPublicationAccepted(input);
  } catch (error) {
    if (!(error instanceof SupabaseRestError)
      || error.message !== 'publication_unknown_requires_reconciliation') throw error;
  }
  const rows = await supabaseRpc<PublicationAttempt[]>('resolve_publication_unknown_accepted', {
    p_user_id: input.userId,
    p_attempt_id: input.attempt.id,
    p_dispatch_operation_id: input.attempt.dispatch_operation_id,
    p_external_post_id: input.externalPostId,
    p_external_url: input.externalUrl ?? null,
    p_provider_published_at: input.providerPublishedAt ?? null,
    p_provider_receipt: input.providerReceipt ?? null,
    p_reconciliation_evidence: {
      kind: 'exact_attempt_provider_acceptance_response',
      attempt_id: input.attempt.id,
      dispatch_operation_id: input.attempt.dispatch_operation_id,
      external_post_id: input.externalPostId,
      observed_at: observedAt,
    },
  }, { retrySafe: true });
  const accepted = rows[0];
  if (!accepted) throw new Error('positive provider receipt reconciliation returned no attempt');
  return accepted;
}
