/**
 * Detects the error shapes emitted by native/client tool handlers.
 * Unknown object shapes are not treated as errors unless they carry an
 * explicit error field; this keeps successful JSON results valid while making
 * all known failure receipts fail closed.
 */
export function hasToolResultError(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some((part: unknown) => {
    if (!part || typeof part !== 'object' || !('value' in part)) return false
    const value = part.value
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return false
    const record = value as Record<string, unknown>
    return (
      (typeof record.errorMessage === 'string' &&
        record.errorMessage.length > 0) ||
      (typeof record.error === 'string' && record.error.length > 0) ||
      (typeof record.errorCode === 'string' && record.errorCode.length > 0)
    )
  })
}
