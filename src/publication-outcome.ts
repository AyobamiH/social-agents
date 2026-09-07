import { isPlatformPublishError } from './platform-errors';

export type PostDispatchOutcome = 'rejected' | 'unknown';

export interface PublicationErrorClassification {
  outcome: PostDispatchOutcome;
  code: string;
  message: string;
  providerReceipt: Record<string, unknown>;
}

// A conflict may describe an existing post; a timeout is never proof of absence.
const DEFINITIVE_REJECTION_STATUSES = new Set([400, 401, 403, 404, 413, 415, 422, 429]);

export function classifyPostDispatchError(error: unknown): PublicationErrorClassification {
  const providerError = isPlatformPublishError(error) ? error : undefined;
  const rejected = Boolean(providerError?.stage === 'post'
    && DEFINITIVE_REJECTION_STATUSES.has(providerError.status || 0));
  const safeCode = providerError && /^[a-z0-9_]{1,80}$/.test(providerError.code)
    ? providerError.code : 'unclassified_error';
  const outcome = rejected ? 'rejected' : 'unknown';
  return {
    outcome,
    code: `provider_${rejected ? 'rejected' : 'outcome_unknown'}_${safeCode}`,
    message: rejected
      ? 'The provider rejected this publication attempt.'
      : 'The provider outcome is uncertain. Reconcile the exact attempt before retrying.',
    // Deliberate allowlist: never persist raw errors, headers, URLs, or response snippets.
    providerReceipt: {
      ...(providerError ? { platform: providerError.platform, http_status: providerError.status ?? null } : {}),
      outcome_classification: rejected ? 'known_rejected' : 'ambiguous_unknown',
    },
  };
}
