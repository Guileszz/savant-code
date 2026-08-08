import { useMemo } from 'react'

import { useTheme } from '../../hooks/use-theme'
import {
  blendHex,
  DIFF_ADD_FOREGROUND,
  DIFF_REMOVE_FOREGROUND,
  NEON_GREEN,
  NEON_RED,
  parseDiffLines,
} from '../../utils/diff-stats'

interface DiffViewerProps {
  diffText: string
}

/**
 * DiffViewer — line-by-line diff renderer (FID-2026-0804-010).
 *
 * Replaces the previous single `<code filetype="diff">` element (which had no
 * diff token styles in the syntax theme and rendered every row on the
 * transparent background). Each row is a full-width `<box>` (OpenTUI boxes own
 * `backgroundColor`; text elements do not) containing the line text:
 *   - added rows   → 50%-opacity neon green background (blend with theme bg)
 *   - removed rows → 50%-opacity neon red background
 *   - hunk/header  → muted comment foreground, transparent background
 *   - context rows → theme foreground, transparent background
 * The `+`/`-` marker is the first character of each row's text (as in the
 * source unified diff), so the left marker column is preserved.
 */
export const DiffViewer = ({ diffText }: DiffViewerProps) => {
  const theme = useTheme()
  const { lines } = useMemo(() => parseDiffLines(diffText), [diffText])
  const addBackground = useMemo(
    () => blendHex(NEON_GREEN, theme.background, 0.5),
    [theme.background],
  )
  const removeBackground = useMemo(
    () => blendHex(NEON_RED, theme.background, 0.5),
    [theme.background],
  )

  return (
    <box
      style={{ flexDirection: 'column', gap: 0, width: '100%', flexGrow: 1 }}
    >
      {lines.map((line, index) => {
        const isAdd = line.kind === 'add'
        const isRemove = line.kind === 'remove'
        // Hunk/header rows use the muted comment foreground (dim by color).
        const foreground =
          line.kind === 'context'
            ? theme.foreground
            : isAdd
              ? DIFF_ADD_FOREGROUND
              : isRemove
                ? DIFF_REMOVE_FOREGROUND
                : theme.syntaxComment
        return (
          <box
            key={index}
            style={{
              width: '100%',
              backgroundColor: isAdd
                ? addBackground
                : isRemove
                  ? removeBackground
                  : undefined,
            }}
          >
            <text>
              <span fg={foreground}>{line.text || ' '}</span>
            </text>
          </box>
        )
      })}
    </box>
  )
}

interface DiffStatsBarProps {
  removed: number
  added: number
}

/**
 * DiffStatsBar — the `[-N/+M]` add/remove counter (FID-2026-0804-010).
 *
 * Rendered in the CopyableBlock footer row, immediately left of the copy
 * button, so the edit section's bottom-right shows the change magnitude at a
 * glance. Muted comment foreground to match the edit-header styling.
 */
export const DiffStatsBar = ({ removed, added }: DiffStatsBarProps) => {
  const theme = useTheme()
  return (
    <text>
      <span fg={theme.syntaxComment}>
        [-{removed}/+{added}]
      </span>
    </text>
  )
}
