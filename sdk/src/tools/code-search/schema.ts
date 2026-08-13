import { z } from 'zod/v4'

import type { JSONValue } from '@savant-code/common/types/json'

export const ripgrepEventSchema = z.object({
  type: z.enum(['match', 'context']),
  data: z.object({
    path: z
      .object({
        text: z.string().optional(),
        bytes: z.string().optional(),
      })
      .optional(),
    line_number: z.number().optional(),
    lines: z
      .object({
        text: z.string().optional(),
      })
      .optional(),
  }),
})

export type RipgrepEvent = z.infer<typeof ripgrepEventSchema>

export function parseRipgrepEventLine(line: string): RipgrepEvent | null {
  let parsed: JSONValue
  try {
    parsed = JSON.parse(line) as JSONValue
  } catch {
    return null
  }
  const result = ripgrepEventSchema.safeParse(parsed)
  return result.success ? result.data : null
}

// Hidden directories to include in code search by default.
// These are searched in addition to '.' to ensure important config/workflow files are discoverable.
export const INCLUDED_HIDDEN_DIRS = [
  '.agents', // SavantCode agent definitions
  '.claude', // Claude settings
  '.github', // GitHub Actions, workflows, issue templates
  '.gitlab', // GitLab CI configuration
  '.circleci', // CircleCI configuration
  '.husky', // Git hooks
]
