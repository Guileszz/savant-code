import type { CustomToolDefinitions } from '@savant-code/common/util/file'

const trustedDefinitions = new WeakSet<object>()

/** Mark a definition set produced by the runtime's host/MCP loading boundary. */
export function markTrustedCustomToolDefinitions(
  definitions: CustomToolDefinitions,
): CustomToolDefinitions {
  trustedDefinitions.add(definitions)
  return definitions
}

/** Check whether a definition set came from the runtime loading boundary. */
export function isTrustedCustomToolDefinitions(
  definitions: CustomToolDefinitions | undefined,
): definitions is CustomToolDefinitions {
  return definitions !== undefined && trustedDefinitions.has(definitions)
}
