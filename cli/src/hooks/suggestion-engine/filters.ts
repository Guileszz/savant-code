import {
  createHighlightIndices,
  createPushUnique,
  fuzzyMatch,
  getFileName,
  type MatchedAgentInfo,
  type MatchedFileInfo,
  type MatchedSlashCommand,
} from './matchers'

import type { SlashCommand } from '../../data/slash-commands'
import type { LocalAgentInfo } from '../../utils/local-agent-registry'
import type { PathInfo } from '@savant-code/common/project-file-tree'

export const filterSlashCommands = (
  commands: SlashCommand[],
  query: string,
): MatchedSlashCommand[] => {
  if (!query) {
    return commands
  }

  const normalized = query.toLowerCase()
  const matches: MatchedSlashCommand[] = []
  const seen = new Set<string>()
  const pushUnique = createPushUnique<MatchedSlashCommand, string>(
    (command) => command.id,
    seen,
  )
  // Prefix of ID
  for (const command of commands) {
    if (seen.has(command.id)) continue
    const id = command.id.toLowerCase()
    const aliasList = (command.aliases ?? []).map((alias) =>
      alias.toLowerCase(),
    )

    if (
      id.startsWith(normalized) ||
      aliasList.some((alias) => alias.startsWith(normalized))
    ) {
      const label = command.label.toLowerCase()
      const firstIndex = label.indexOf(normalized)
      const indices =
        firstIndex === -1
          ? null
          : createHighlightIndices(firstIndex, firstIndex + normalized.length)
      pushUnique(matches, {
        ...command,
        ...(indices && { labelHighlightIndices: indices }),
      })
    }
  }

  // Substring of ID
  for (const command of commands) {
    if (seen.has(command.id)) continue
    const id = command.id.toLowerCase()
    const aliasList = (command.aliases ?? []).map((alias) =>
      alias.toLowerCase(),
    )

    if (
      id.includes(normalized) ||
      aliasList.some((alias) => alias.includes(normalized))
    ) {
      const label = command.label.toLowerCase()
      const firstIndex = label.indexOf(normalized)
      const indices =
        firstIndex === -1
          ? null
          : createHighlightIndices(firstIndex, firstIndex + normalized.length)
      pushUnique(matches, {
        ...command,
        ...(indices && {
          labelHighlightIndices: indices,
        }),
      })
    }
  }

  // Substring of description
  for (const command of commands) {
    if (seen.has(command.id)) continue
    const description = command.description.toLowerCase()

    if (description.includes(normalized)) {
      const firstIndex = description.indexOf(normalized)
      const indices =
        firstIndex === -1
          ? null
          : createHighlightIndices(firstIndex, firstIndex + normalized.length)
      pushUnique(matches, {
        ...command,
        ...(indices && {
          descriptionHighlightIndices: indices,
        }),
      })
    }
  }

  return matches
}

export const filterFileMatches = (
  pathInfos: PathInfo[],
  query: string,
): MatchedFileInfo[] => {
  if (!query) {
    return []
  }

  const normalized = query.toLowerCase()
  const matches: MatchedFileInfo[] = []
  const seen = new Set<string>()

  const pushUnique = createPushUnique<MatchedFileInfo, string>(
    (file) => file.filePath,
    seen,
  )

  // Check if query contains slashes for path-segment matching
  const querySegments = normalized.split('/')
  const hasSlashes = querySegments.length > 1

  // Helper to match path segments (for queries with /)
  const matchPathSegments = (
    filePath: string,
  ): { indices: number[]; score: number } | null => {
    const pathLower = filePath.toLowerCase()
    const highlightIndices: number[] = []
    let searchStart = 0
    let totalGaps = 0

    for (const segment of querySegments) {
      if (!segment) continue

      const segmentIndex = pathLower.indexOf(segment, searchStart)
      if (segmentIndex === -1) {
        return null
      }

      // Count gaps between segments
      if (searchStart > 0) {
        totalGaps += segmentIndex - searchStart
      }

      for (let i = 0; i < segment.length; i++) {
        highlightIndices.push(segmentIndex + i)
      }

      searchStart = segmentIndex + segment.length
    }

    const score = totalGaps * 5 + filePath.length
    return { indices: highlightIndices, score }
  }

  for (const { path: filePath, isDirectory } of pathInfos) {
    if (seen.has(filePath)) continue

    const fileName = getFileName(filePath)
    const fileNameLower = fileName.toLowerCase()
    const pathLower = filePath.toLowerCase()

    let matchResult: { indices: number[]; score: number } | null = null

    if (hasSlashes) {
      // Try path segment matching first
      matchResult = matchPathSegments(filePath)
    }

    if (!matchResult) {
      // Try exact prefix of full path (highest priority)
      if (pathLower.startsWith(normalized)) {
        matchResult = {
          indices: createHighlightIndices(0, normalized.length),
          score: -1000 + filePath.length, // Very high priority
        }
      }
      // Try prefix of filename
      else if (fileNameLower.startsWith(normalized)) {
        const fileNameStart = filePath.lastIndexOf(fileName)
        matchResult = {
          indices: createHighlightIndices(
            fileNameStart,
            fileNameStart + normalized.length,
          ),
          score: -500 + filePath.length, // High priority
        }
      }
      // Try substring match in path
      else if (pathLower.includes(normalized)) {
        const idx = pathLower.indexOf(normalized)
        matchResult = {
          indices: createHighlightIndices(idx, idx + normalized.length),
          score: -100 + idx + filePath.length,
        }
      }
      // Try fuzzy match as fallback
      else {
        matchResult = fuzzyMatch(filePath, normalized)
      }
    }

    if (matchResult) {
      // Adjust score: prefer shorter paths
      const lengthPenalty = filePath.length * 2

      // Give bonus for exact directory matches (query matches the full path)
      // e.g. "cli" should prioritize "cli/" directory over "cli/package.json"
      const isExactMatch = pathLower === normalized
      const isExactDirMatch = isDirectory && isExactMatch
      const exactMatchBonus = isExactDirMatch ? -500 : 0

      // Only penalize directories when they're not an exact or prefix match
      // This ensures "cli/" appears before "cli/src/file.ts" when searching "cli"
      const isPrefixMatch = pathLower.startsWith(normalized)
      const dirPenalty = isDirectory && !isPrefixMatch ? 50 : 0

      const finalScore =
        matchResult.score + lengthPenalty + dirPenalty + exactMatchBonus

      pushUnique(matches, {
        filePath,
        isDirectory,
        pathHighlightIndices: matchResult.indices,
        matchScore: finalScore,
      })
    }
  }

  // Sort by score (lower is better)
  matches.sort((a, b) => (a.matchScore ?? 0) - (b.matchScore ?? 0))

  return matches
}

export const filterAgentMatches = (
  agents: LocalAgentInfo[],
  query: string,
): MatchedAgentInfo[] => {
  if (!query) {
    return agents
  }

  const normalized = query.toLowerCase()
  const matches: MatchedAgentInfo[] = []
  const seen = new Set<string>()
  const pushUnique = createPushUnique<MatchedAgentInfo, string>(
    (agent) => agent.id,
    seen,
  )
  // Prefix of ID or name
  for (const agent of agents) {
    const id = agent.id.toLowerCase()

    if (id.startsWith(normalized)) {
      pushUnique(matches, {
        ...agent,
        idHighlightIndices: createHighlightIndices(0, normalized.length),
      })
      continue
    }

    const name = agent.displayName.toLowerCase()
    if (name.startsWith(normalized)) {
      pushUnique(matches, {
        ...agent,
        nameHighlightIndices: createHighlightIndices(0, normalized.length),
      })
    }
  }

  // Substring of ID or name
  for (const agent of agents) {
    if (seen.has(agent.id)) continue
    const id = agent.id.toLowerCase()
    const idFirstIndex = id.indexOf(normalized)
    if (idFirstIndex !== -1) {
      pushUnique(matches, {
        ...agent,
        idHighlightIndices: createHighlightIndices(
          idFirstIndex,
          idFirstIndex + normalized.length,
        ),
      })
      continue
    }

    const name = agent.displayName.toLowerCase()

    const nameFirstIndex = name.indexOf(normalized)
    if (nameFirstIndex !== -1) {
      pushUnique(matches, {
        ...agent,
        nameHighlightIndices: createHighlightIndices(
          nameFirstIndex,
          nameFirstIndex + normalized.length,
        ),
      })
      continue
    }
  }

  return matches
}
