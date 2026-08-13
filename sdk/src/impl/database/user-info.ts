import { getErrorObject } from '@savant-code/common/util/error'

import { fetchWithRetry } from './fetch-with-retry'
import { userInfoCache } from './state'
import { getWebsiteUrl } from '../../constants'
import { isDirectProviderMode } from '../../env'
import {
  createNetworkError,
  createServerError,
  createHttpError,
} from '../../error-utils'

import type { CachedUserInfo } from './state'
import type {
  GetUserInfoFromApiKeyInput,
  GetUserInfoFromApiKeyOutput,
  UserColumn,
} from '@savant-code/common/types/contracts/database'

/**
 * Redacts an API key for logs (Law 12: never expose sensitive data).
 * Keeps a short prefix + last-4 for debuggability; never the full key.
 */
export function redactApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return '***'
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`
}

export async function getUserInfoFromApiKey<T extends UserColumn>(
  params: GetUserInfoFromApiKeyInput<T>,
): GetUserInfoFromApiKeyOutput<T> {
  const { apiKey, fields, logger } = params

  // Dev-mode bypass: when DIRECT_PROVIDER or INFERENCE_BASE_URL is set (no
  // SavantCode backend), return stub user info instead of a network request.
  if (isDirectProviderMode()) {
    // FID-2026-0802-008 D5: expected in BYOK mode, not a warning.
    logger.debug('getUserInfoFromApiKey: no-backend mode, returning stub user')
    const stubUser: Record<string, string> = {
      id: 'dev',
      email: 'dev@localhost',
      name: 'Dev User',
    }
    return Object.fromEntries(
      fields.map((field) => [field, stubUser[field] ?? null]),
    ) as Awaited<GetUserInfoFromApiKeyOutput<T>>
  }

  const cached = userInfoCache[apiKey]
  if (
    cached &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(cached, field))
  ) {
    return Object.fromEntries(
      fields.map((field) => [field, cached[field]]),
    ) as {
      [K in T]: CachedUserInfo[K]
    } as Awaited<GetUserInfoFromApiKeyOutput<T>>
  }

  const fieldsToFetch = cached
    ? fields.filter(
        (field) => !Object.prototype.hasOwnProperty.call(cached, field),
      )
    : fields

  const urlParams = new URLSearchParams({
    fields: fieldsToFetch.join(','),
  })
  const url = new URL(`/api/v1/me?${urlParams}`, getWebsiteUrl())

  let response: Response
  try {
    response = await fetchWithRetry(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
      logger,
    )
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), apiKey: redactApiKey(apiKey), fields },
      'getUserInfoFromApiKey network error',
    )
    // Network-level failure: DNS, connection refused, timeout, etc.
    throw createNetworkError('Network request failed')
  }

  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    logger.error(
      { apiKey: redactApiKey(apiKey), fields, status: response.status },
      'getUserInfoFromApiKey authentication failed',
    )
    // Don't cache auth failures - allow retry with potentially updated credentials
    delete userInfoCache[apiKey]
    // If the server returns 404 for invalid credentials, surface as 401 to callers
    const normalizedStatus = response.status === 404 ? 401 : response.status
    throw createHttpError('Authentication failed', normalizedStatus)
  }

  if (response.status >= 500 && response.status <= 599) {
    logger.error(
      { apiKey: redactApiKey(apiKey), fields, status: response.status },
      'getUserInfoFromApiKey server error',
    )
    throw createServerError('Server error', response.status)
  }

  if (!response.ok) {
    logger.error(
      { apiKey: redactApiKey(apiKey), fields, status: response.status },
      'getUserInfoFromApiKey request failed',
    )
    throw createHttpError('Request failed', response.status)
  }

  const cachedBeforeMerge = userInfoCache[apiKey]
  try {
    const responseBody = await response.json()
    const fetchedFields = responseBody as CachedUserInfo
    userInfoCache[apiKey] = {
      ...(cachedBeforeMerge ?? {}),
      ...fetchedFields,
    }
  } catch (error) {
    logger.error(
      { error: getErrorObject(error), apiKey: redactApiKey(apiKey), fields },
      'getUserInfoFromApiKey JSON parse error',
    )
    throw createHttpError('Failed to parse response', response.status)
  }

  const userInfo = userInfoCache[apiKey]
  if (
    !userInfo ||
    !fields.every((field) =>
      Object.prototype.hasOwnProperty.call(userInfo, field),
    )
  ) {
    logger.error(
      { apiKey: redactApiKey(apiKey), fields },
      'getUserInfoFromApiKey: response missing required fields',
    )
    throw createHttpError('Request failed', response.status)
  }
  return Object.fromEntries(
    fields.map((field) => [field, userInfo[field]]),
  ) as Awaited<GetUserInfoFromApiKeyOutput<T>>
}
