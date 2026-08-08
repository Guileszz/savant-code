/**
 * Pure formatting helpers shared by the HTML renderers and the copy-text
 * builders of the `/export` command.
 */

/** Title-case an agent id/type into a display name, e.g. `code-searcher` → `Code Searcher`. */
export function formatAgentName(agentName: string): string {
  const cleaned = agentName.replace(/[-_]/g, ' ').trim()
  if (!cleaned) return 'Agent'
  return cleaned.replace(/\b\w/g, (l) => l.toUpperCase())
}

/** Format a timestamp as `MM-DD-YYYY h:mm AM/PM EST` (America/New_York). */
export function formatExportTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date)
  const values: Record<string, string> = {}
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value
  }
  return `${values.month}-${values.day}-${values.year} ${values.hour}:${values.minute} ${values.dayPeriod ?? ''} EST`
}

/** Human-friendly tool label, e.g. `read_files` → `Read Files`. */
export function toolDisplayName(toolName: string): string {
  if (toolName === 'list_directory') return 'List Directories'
  return toolName.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderToolInput(input: unknown): string {
  if (input == null) return ''
  if (
    (Array.isArray(input) && input.length === 0) ||
    (typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.keys(input as Record<string, unknown>).length === 0)
  ) {
    return ''
  }
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

export function renderToolOutput(output: string): {
  body: string
  lang: string
} {
  const trimmed = output.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return {
        body: JSON.stringify(JSON.parse(trimmed), null, 2),
        lang: 'json',
      }
    } catch {
      // Not valid JSON — fall through to raw.
    }
  }
  return { body: output, lang: '' }
}
