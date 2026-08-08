/**
 * Standard error message for aborted requests.
 * Use this constant when throwing abort errors to ensure consistency.
 */
export const ABORT_ERROR_MESSAGE = 'Request aborted'

/**
 * Custom error class for abort errors.
 * Use this class instead of generic Error for abort errors to ensure
 * robust detection via isAbortError() (checks error.name === 'AbortError').
 */
export class AbortError extends Error {
  constructor(reason?: string) {
    super(reason ? `${ABORT_ERROR_MESSAGE}: ${reason}` : ABORT_ERROR_MESSAGE)
    this.name = 'AbortError'
  }
}

/**
 * Check if an error is an abort error.
 * Use this helper to detect abort errors in catch blocks.
 *
 * Detects both:
 * - Errors with message starting with 'Request aborted' (thrown by our code via AbortError)
 * - Native AbortError (thrown by fetch/AI SDK when AbortSignal is triggered)
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  // Check for our custom abort error message:
  // - Exact match: 'Request aborted'
  // - With reason: 'Request aborted: <reason>' (from AbortError class)
  if (
    error.message === ABORT_ERROR_MESSAGE ||
    error.message.startsWith(`${ABORT_ERROR_MESSAGE}: `)
  ) {
    return true
  }
  // Check for native AbortError (DOMException or Error with name 'AbortError')
  // This is thrown by fetch, AI SDK, and other web APIs when AbortSignal is triggered
  if (error.name === 'AbortError') {
    return true
  }
  return false
}
