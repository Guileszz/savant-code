import type { Logger } from '@savant-code/common/types/contracts/logger'

/**
 * Parse the `flags` parameter into a ripgrep argv fragment plus any stray
 * non-flag arguments. Do NOT deduplicate flags: deduplicating would break up
 * flag-argument pairs like `-g *.ts`. Surrounding quotes are stripped since
 * spawn() passes args directly without shell interpretation.
 *
 * FID-076: agents sometimes misuse `flags` for directory filtering
 * (e.g. "cli/src -g '*.ts'"). Non-flag arguments (not starting with '-') break
 * ripgrep's argument structure on Windows, causing patterns to be treated as
 * filenames — so they are moved to `extraSearchPaths` instead.
 */
export function parseSearchFlags(
  flags: string | undefined,
  logger?: Logger,
): { flagsArray: string[]; extraSearchPaths: string[] } {
  const rawFlagsArray = (flags || '')
    .split(' ')
    .filter(Boolean)
    .map((token) => token.replace(/^['"]|['"]$/g, ''))

  const flagsArray: string[] = []
  const extraSearchPaths: string[] = []
  let prevWasFlag = false
  for (const token of rawFlagsArray) {
    if (prevWasFlag) {
      // Previous token was a flag — this token is its value (e.g., -g *.ts, -A 2)
      // Defensive: treat any non-"-" token after a flag as its value,
      // regardless of whether the flag is in a known list.
      flagsArray.push(token)
      prevWasFlag = false
      continue
    }
    if (token.startsWith('-')) {
      flagsArray.push(token)
      // Heuristic: flags that are NOT boolean (i.e., take a value argument)
      // typically have a longer form or are followed by a non-"-" token.
      // We conservatively assume the next token is a value if the flag is
      // single-char with a value or a long flag without '='.
      const isBooleanFlag = [
        '--no-config',
        '-n',
        '--json',
        '-i',
        '-l',
        '-c',
        '--count',
        '--files-with-matches',
        '--files-without-match',
        '-h',
        '--help',
        '--version',
        '-v',
        '--invert-match',
        '--no-filename',
        '--no-line-number',
        '--no-messages',
        '--no-heading',
        '--with-filename',
        '--heading',
        '--hidden',
        '--no-ignore',
        '-u',
        '--unrestricted',
        '--binary',
        '--crlf',
        '--no-unicode',
      ].includes(token)
      prevWasFlag = !isBooleanFlag && !token.includes('=')
    } else {
      // Non-flag argument — likely a directory path misuse. Move to search paths.
      extraSearchPaths.push(token)
      if (logger) {
        logger.warn(
          { token, flags },
          'code-search: Non-flag argument in flags parameter moved to search paths. Use the cwd parameter instead for directory filtering.',
        )
      }
    }
  }
  return { flagsArray, extraSearchPaths }
}
