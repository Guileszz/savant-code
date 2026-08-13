import { getErrorObject } from '@savant-code/common/util/error'

import { isRetryableStatusCode } from '../../error-utils'
import {
  MAX_RETRIES_PER_MESSAGE,
  RETRY_BACKOFF_BASE_DELAY_MS,
  RETRY_BACKOFF_MAX_DELAY_MS,
} from '../../retry-config'

/**
 * Fetch with retry logic for transient errors (502, 503, etc.)
 * Implements exponential backoff between retries.
 */
export async function fetchWithRetry(
  url: URL | string,
  options: RequestInit,
  logger?: { warn: (obj: object, msg: string) => void },
): Promise<Response> {
  let lastError: Error | null = null
  let backoffDelay = RETRY_BACKOFF_BASE_DELAY_MS

  for (let attempt = 0; attempt <= MAX_RETRIES_PER_MESSAGE; attempt++) {
    try {
      const response = await fetch(url, options)

      // If response is OK or not retryable, return it
      if (response.ok || !isRetryableStatusCode(response.status)) {
        return response
      }

      // Retryable error - log and continue to retry
      if (attempt < MAX_RETRIES_PER_MESSAGE) {
        logger?.warn(
          { status: response.status, attempt: attempt + 1, url: String(url) },
          `Retryable HTTP error, retrying in ${backoffDelay}ms`,
        )
        await new Promise((resolve) => setTimeout(resolve, backoffDelay))
        backoffDelay = Math.min(backoffDelay * 2, RETRY_BACKOFF_MAX_DELAY_MS)
      } else {
        // Last attempt, return the response even if it's an error
        return response
      }
    } catch (error) {
      // Network-level error (DNS, connection refused, etc.)
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < MAX_RETRIES_PER_MESSAGE) {
        logger?.warn(
          {
            error: getErrorObject(lastError),
            attempt: attempt + 1,
            url: String(url),
          },
          `Network error, retrying in ${backoffDelay}ms`,
        )
        await new Promise((resolve) => setTimeout(resolve, backoffDelay))
        backoffDelay = Math.min(backoffDelay * 2, RETRY_BACKOFF_MAX_DELAY_MS)
      }
    }
  }

  // All retries exhausted - throw the last error
  throw lastError ?? new Error('Request failed after retries')
}
