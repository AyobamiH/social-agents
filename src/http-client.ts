import { upstreamFailure } from './errors';

export interface HttpJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  /** Cancels the complete operation, including response reads and retry delays. */
  signal?: AbortSignal;
}

export interface HttpJsonResponse<T> {
  status: number;
  headers: Headers;
  data: T;
  rawText: string;
}

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.HTTP_TIMEOUT_MS || '15000', 10);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function requestJson<T>(url: string, options: HttpJsonOptions = {}): Promise<HttpJsonResponse<T>> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryCount = 0,
    retryDelayMs = 250,
    signal,
  } = options;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort(signal!.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      const text = await response.text();
      signal?.throwIfAborted();
      let data: T;

      try {
        data = (text ? JSON.parse(text) : {}) as T;
      } catch (error) {
        upstreamFailure(`Upstream response parse failed: ${String(error)}`, 'UPSTREAM_PARSE_ERROR', {
          status: response.status,
          contentType: response.headers.get('content-type'),
          bodySnippet: text.slice(0, 500),
        });
      }

      if (!response.ok && attempt < retryCount && isRetryable(response.status)) {
        await sleep(retryDelayMs * (attempt + 1), signal);
        continue;
      }

      return {
        status: response.status,
        headers: response.headers,
        data,
        rawText: text,
      };
    } catch (error) {
      // Caller cancellation is terminal even when this request normally retries.
      signal?.throwIfAborted();
      if (attempt < retryCount) {
        await sleep(retryDelayMs * (attempt + 1), signal);
        continue;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        upstreamFailure('Upstream request timed out', 'UPSTREAM_TIMEOUT');
      }
      upstreamFailure(`Upstream request failed: ${message}`, 'UPSTREAM_REQUEST_FAILED');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  upstreamFailure();
}
