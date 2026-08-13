import { assertUrlAllowed, type HostLookup } from '../ssrf'
import {
  DEFAULT_MAX_CHARS,
  FETCH_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  REDIRECT_STATUSES,
  USER_AGENT,
  type FetchLike,
  type ReadUrlOutput,
} from './constants'
import {
  extractTextByContentType,
  isSupportedContentType,
  truncateText,
} from './extract'

/**
 * read-url — fetch orchestration with SSRF re-validation on every redirect.
 * (FID-2026-0809-016: extracted from `read-url.ts`.)
 */

function errorResult(
  url: string | undefined,
  errorMessage: string,
): ReadUrlOutput {
  return [{ type: 'json', value: { ...(url ? { url } : {}), errorMessage } }]
}

function getHeader(headers: Headers, name: string): string | undefined {
  return headers.get(name) ?? undefined
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = getHeader(response.headers, 'content-length')
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`Response is too large (${contentLength} bytes)`)
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Response is too large (${buffer.byteLength} bytes)`)
    }
    return new TextDecoder().decode(buffer)
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue

    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      throw new Error(`Response exceeded ${maxBytes} bytes`)
    }
    chunks.push(value)
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(body)
}

export async function readUrl({
  url,
  max_chars = DEFAULT_MAX_CHARS,
  fetch: fetchImpl = globalThis.fetch,
  lookupHost,
  resolveDns = fetchImpl === globalThis.fetch,
  signal,
}: {
  url: string
  max_chars?: number
  fetch?: FetchLike
  /** Override hostname resolution (defaults to node:dns). */
  lookupHost?: HostLookup
  /**
   * Whether to DNS-resolve hostnames for SSRF checks. Defaults to true only
   * when using the real global fetch; a caller-supplied fetch (e.g. a test
   * stub) skips resolution but IP-literal hosts are still rejected.
   */
  resolveDns?: boolean
  /** External abort (e.g. user interrupt); cancels the fetch mid-flight. */
  signal?: AbortSignal
}): Promise<ReadUrlOutput> {
  if (signal?.aborted) {
    return errorResult(url, 'Cancelled: the run was aborted by the user.')
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return errorResult(url, 'Invalid URL')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const onExternalAbort = () => controller.abort()
  signal?.addEventListener('abort', onExternalAbort, { once: true })

  try {
    // Follow redirects manually so every hop is re-validated against the SSRF
    // policy — a public URL must not be able to 30x its way to an internal one.
    let currentUrl = parsedUrl
    let response: Response
    for (let redirects = 0; ; redirects++) {
      try {
        // NOTE: this resolves the hostname for validation; `fetch` resolves it
        // again independently, so a short-TTL attacker domain could rebind
        // between the two (DNS-rebinding TOCTOU). Fully closing that needs
        // IP-pinning (an undici dispatcher), which Bun's fetch ignores, so it's
        // an accepted residual gap — the common literal/internal-host vectors
        // are still blocked.
        await assertUrlAllowed(currentUrl, { lookupHost, resolveDns })
      } catch (error) {
        return errorResult(
          url,
          error instanceof Error ? error.message : 'Blocked URL',
        )
      }

      response = await fetchImpl(currentUrl.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept:
            'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': USER_AGENT,
        },
      })

      if (!REDIRECT_STATUSES.has(response.status)) {
        break
      }

      const location = getHeader(response.headers, 'location')
      if (!location) {
        break
      }
      if (redirects >= MAX_REDIRECTS) {
        return errorResult(url, `Too many redirects (>${MAX_REDIRECTS})`)
      }
      try {
        currentUrl = new URL(location, currentUrl)
      } catch {
        return errorResult(url, `Invalid redirect location: ${location}`)
      }
    }

    if (!response.ok) {
      return errorResult(
        url,
        `Failed to fetch URL: ${response.status} ${response.statusText}`,
      )
    }

    const contentType = getHeader(response.headers, 'content-type') ?? ''
    if (contentType && !isSupportedContentType(contentType)) {
      return errorResult(
        url,
        `Unsupported content type: ${contentType || 'unknown'}`,
      )
    }

    const body = await readResponseBody(response, MAX_RESPONSE_BYTES)
    const extracted = extractTextByContentType(contentType, body)
    const truncated = truncateText(extracted.text, max_chars)

    if (!truncated.text) {
      return errorResult(url, 'No readable text found at URL')
    }

    return [
      {
        type: 'json',
        value: {
          url,
          finalUrl: response.url || currentUrl.toString(),
          status: response.status,
          ...(contentType ? { contentType } : {}),
          ...(extracted.title ? { title: extracted.title } : {}),
          ...(extracted.description
            ? { description: extracted.description }
            : {}),
          text: truncated.text,
          truncated: truncated.truncated,
        },
      },
    ]
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError'
    return errorResult(
      url,
      isAbort
        ? signal?.aborted
          ? 'Cancelled: the run was aborted by the user.'
          : `Timed out after ${FETCH_TIMEOUT_MS} ms`
        : error instanceof Error
          ? error.message
          : 'Unknown error',
    )
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onExternalAbort)
  }
}
