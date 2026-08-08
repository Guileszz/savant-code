import {
  FETCH_IDLE_TIMEOUT_USER_MESSAGE,
  TRANSIENT_NETWORK_ERROR_USER_MESSAGE,
  extractApiErrorDetails,
  isFetchIdleTimeoutError,
  isTransientNetworkError,
} from '@savant-code/common/util/error'

/**
 * Maps a loop failure into the error status / message / output shape used by
 * the catch block. Behavior identical to the inline block it was extracted
 * from — payment-required (402) propagation and finishAgentRun stay in the
 * caller.
 */
export function buildLoopErrorOutput(params: {
  error: unknown
  signal: AbortSignal
}): {
  status: 'cancelled' | 'failed'
  errorMessage: string
  statusCode: number | undefined
  output: {
    type: 'error'
    message: string
    statusCode?: number
    error?: string
    countryCode?: string
    countryBlockReason?: string
    ipPrivacySignals?: string[]
  }
} {
  const { error, signal } = params

  const apiErrorDetails = extractApiErrorDetails(error)
  const isIdleTimeout = isFetchIdleTimeoutError(error)
  const isNetworkError = !isIdleTimeout && isTransientNetworkError(error)
  const hasServerMessage = apiErrorDetails.message !== undefined
  let fallbackMessage: string
  if (isIdleTimeout) {
    fallbackMessage = FETCH_IDLE_TIMEOUT_USER_MESSAGE
  } else if (isNetworkError) {
    fallbackMessage = TRANSIENT_NETWORK_ERROR_USER_MESSAGE
  } else if (error instanceof Error) {
    const includeStack = apiErrorDetails.statusCode === undefined && error.stack
    fallbackMessage = error.message + (includeStack ? `\n\n${error.stack}` : '')
  } else {
    fallbackMessage = String(error)
  }
  const errorMessage = apiErrorDetails.message ?? fallbackMessage
  const statusCode = apiErrorDetails.statusCode

  const status = signal.aborted ? 'cancelled' : 'failed'

  return {
    status,
    errorMessage,
    statusCode,
    output: {
      type: 'error',
      message:
        hasServerMessage || isIdleTimeout || isNetworkError
          ? errorMessage
          : 'Agent run error: ' + errorMessage,
      ...(statusCode !== undefined && { statusCode }),
      ...(apiErrorDetails.errorCode !== undefined && {
        error: apiErrorDetails.errorCode,
      }),
      ...(apiErrorDetails.countryCode !== undefined && {
        countryCode: apiErrorDetails.countryCode,
      }),
      ...(apiErrorDetails.countryBlockReason !== undefined && {
        countryBlockReason: apiErrorDetails.countryBlockReason,
      }),
      ...(apiErrorDetails.ipPrivacySignals !== undefined && {
        ipPrivacySignals: apiErrorDetails.ipPrivacySignals,
      }),
    },
  }
}
