import { HttpError } from './errors';
import { isPlatformPublishError, platformErrorContext } from './platform-errors';

export type PostDispatchOutcome = 'rejected' | 'unknown';

export interface PublicationErrorClassification {
  outcome: PostDispatchOutcome;
  code: string;
  message: string;
  providerReceipt: Record<string, unknown>;
}

function isKnownRequestRejectionStatus(status: number | undefined): boolean {
  if (!status) return false;
  return status >= 400 && status < 500 && status !== 408;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'publication failed');
}

export function classifyPostDispatchError(error: unknown): PublicationErrorClassification {
  if (isPlatformPublishError(error)) {
    const knownRequestRejection = error.stage === 'post'
      && isKnownRequestRejectionStatus(error.status);
    return {
      outcome: knownRequestRejection ? 'rejected' : 'unknown',
      code: knownRequestRejection
        ? `provider_rejected_${error.code}`
        : `provider_outcome_unknown_${error.code}`,
      message: error.userMessage,
      providerReceipt: {
        ...platformErrorContext(error),
        outcome_classification: knownRequestRejection ? 'known_rejected' : 'ambiguous_unknown',
      },
    };
  }

  if (error instanceof HttpError) {
    const knownRequestRejection = isKnownRequestRejectionStatus(error.status);
    return {
      outcome: knownRequestRejection ? 'rejected' : 'unknown',
      code: knownRequestRejection
        ? `provider_rejected_${error.code}`
        : `provider_outcome_unknown_${error.code}`,
      message: error.message,
      providerReceipt: {
        error_type: error.name,
        normalized_error_code: error.code,
        http_status: error.status ?? null,
        outcome_classification: knownRequestRejection ? 'known_rejected' : 'ambiguous_unknown',
      },
    };
  }

  return {
    outcome: 'unknown',
    code: 'provider_outcome_unknown_unclassified_error',
    message: errorMessage(error),
    providerReceipt: {
      error_type: error instanceof Error ? error.name : 'unknown',
      outcome_classification: 'ambiguous_unknown',
    },
  };
}
