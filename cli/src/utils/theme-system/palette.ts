import type {
  ChatTheme,
  MarkdownHeadingLevel,
  ThemeName,
} from '../../types/theme-system'
import type { MarkdownPalette } from '../markdown-renderer'

const DEFAULT_CHAT_THEMES: Record<ThemeName, ChatTheme> = {
  dark: {
    name: 'dark',
    // Core semantic colors — Savant Cyberpunk palette
    primary: '#18faf9', // Cyan — max contrast on near-black
    secondary: '#18faf9', // Cyan — unified with primary for Savant branding
    success: '#39ff14', // Neon green — high-energy completion
    error: '#ff2d55', // Neon red — Apple system red
    warning: '#ff9500', // Neon orange — warm alert, distinct from yellow
    info: '#18faf9', // Same as primary for consistency
    link: '#3B82F6',
    directory: '#9CA3AF',

    // Neutral scale
    foreground: '#e2e8f0', // Slate-200 — high contrast on dark
    background: '#050508', // Deep void — never inherit the host terminal canvas
    muted: '#94a3b8', // Slate-400 — readable muted text on deep void
    border: '#1e293b', // Slate-800 — subtle
    surface: '#0f172a', // Slate-900 — slightly lighter than bg
    surfaceHover: '#1e293b', // Slate-800

    // Context-specific
    aiLine: '#64748b', // Slate-500 — muted
    userLine: '#18faf9', // Cyan — user messages

    // Agent backgrounds
    agentToggleHeaderBg: '#f97316',
    agentToggleExpandedBg: '#1d4ed8',
    agentFocusedBg: '#1e293b', // Slate-800
    agentContentBg: '#020617', // Slate-950 — near-black
    inputFg: '#e2e8f0', // Slate-200
    inputFocusedFg: '#ffffff',

    // Mode toggles
    modeFastBg: '#f97316',
    modeFastText: '#f97316',
    modeMaxBg: '#dc2626',
    modeMaxText: '#dc2626',
    modePlanBg: '#1e40af',
    modePlanText: '#1e40af',

    // Image card
    imageCardBorder: '#64748b', // Slate-500

    // Diff colors (FID-033a) — preserved from prior diff-viewer DIFF_LINE_COLORS.dark
    diffAdded: '#7ACC35', // Soft green — was hardcoded in diff-viewer.tsx
    diffRemoved: '#BF6C69', // Muted red — was hardcoded in diff-viewer.tsx
    diffContext: '#e2e8f0', // Slate-200 — unchanged lines use foreground
    diffHunkHeader: '#18faf9', // Cyan — was 'cyan' literal in diff-viewer.tsx
    diffMeta: '#64748b', // Slate-500 — was theme.muted in diff-viewer.tsx

    // Syntax highlighting tokens (FID-033a) — fed to OpenTUI SyntaxStyle.
    // Mapping pattern adapted from opencode-dev generateSyntax (theme/index.ts:556).
    syntaxComment: '#64748b', // Slate-500 — muted, matches textMuted convention
    syntaxKeyword: '#ffb000', // Amber — readable non-violet keyword accent
    syntaxFunction: '#60a5fa', // Blue-400 — ansiColors.blue equivalent
    syntaxVariable: '#e2e8f0', // Slate-200 — foreground (variable = fg)
    syntaxString: '#4ade80', // Green-400 — ansiColors.green equivalent
    syntaxNumber: '#fbbf24', // Amber-400 — ansiColors.yellow equivalent
    syntaxType: '#22d3ee', // Cyan-400 — ansiColors.cyan equivalent
    syntaxOperator: '#22d3ee', // Cyan-400 — ansiColors.cyan equivalent

    // Markdown
    markdown: {
      codeBackground: '#1e293b', // Slate-800
      codeHeaderFg: '#64748b', // Slate-500
      inlineCodeFg: '#22d3ee', // Cyan — distinct but on-brand inline-code accent
      codeTextFg: '#e2e8f0', // Slate-200
      headingFg: {
        1: '#18faf9', // Cyan
        2: '#18faf9',
        3: '#18faf9',
        4: '#18faf9',
        5: '#18faf9',
        6: '#18faf9',
      },
      listBulletFg: '#39ff14', // Neon green — semantic, non-violet list accent
      blockquoteBorderFg: '#1e293b', // Slate-800
      blockquoteTextFg: '#e2e8f0', // Slate-200
      dividerFg: '#1e293b', // Slate-800
      codeMonochrome: false,
    },
  },
  light: {
    name: 'light',
    // Core semantic colors — Neon Slate light palette
    primary: '#0891b2', // Cyan-600 — readable on white
    secondary: '#0891b2', // Cyan-600 — unified with primary for Savant branding
    success: '#059669', // Keep existing
    error: '#dc2626', // Red-600 — readable on white
    warning: '#d97706', // Amber-600 — readable on white
    info: '#0891b2', // Same as primary
    link: '#2563EB',
    directory: '#6B7280',

    // Neutral scale
    foreground: '#0f172a', // Slate-900 — near-black
    background: '#ffffff', // Explicit light canvas; never inherit the host terminal
    muted: '#64748b', // Slate-500 — readable muted text on white
    border: '#cbd5e1', // Slate-300
    surface: '#f8fafc', // Slate-50
    surfaceHover: '#f1f5f9', // Slate-100

    // AI/User context
    aiLine: '#64748b', // Slate-500
    userLine: '#0891b2', // Cyan-600

    // Agent context
    agentToggleHeaderBg: '#ea580c',
    agentToggleExpandedBg: '#1d4ed8',
    agentFocusedBg: '#f1f5f9', // Slate-100
    agentContentBg: '#ffffff',
    inputFg: '#0f172a', // Slate-900
    inputFocusedFg: '#000000',

    // Mode toggles
    modeFastBg: '#f97316',
    modeFastText: '#f97316',
    modeMaxBg: '#dc2626',
    modeMaxText: '#dc2626',
    modePlanBg: '#1e40af',
    modePlanText: '#1e40af',

    // Image card
    imageCardBorder: '#64748b', // Slate-500

    // Diff colors (FID-033a) — preserved from prior diff-viewer DIFF_LINE_COLORS.light
    diffAdded: '#4A9E1C', // Readable green on white — was hardcoded in diff-viewer.tsx
    diffRemoved: '#C53030', // Readable red on white — was hardcoded in diff-viewer.tsx
    diffContext: '#0f172a', // Slate-900 — unchanged lines use foreground
    diffHunkHeader: '#0891b2', // Cyan-600 — light-mode primary
    diffMeta: '#64748b', // Slate-500 — muted

    // Syntax highlighting tokens (FID-033a) — light-mode readable equivalents.
    // Mapping pattern adapted from opencode-dev generateSyntax (theme/index.ts:556).
    syntaxComment: '#64748b', // Slate-500 — muted
    syntaxKeyword: '#b45309', // Amber-700 — readable non-violet keyword accent
    syntaxFunction: '#2563eb', // Blue-600 — readable blue on white
    syntaxVariable: '#0f172a', // Slate-900 — foreground
    syntaxString: '#059669', // Emerald-600 — readable green on white
    syntaxNumber: '#d97706', // Amber-600 — readable yellow on white
    syntaxType: '#0891b2', // Cyan-600 — readable cyan on white
    syntaxOperator: '#0891b2', // Cyan-600 — readable cyan on white

    // Markdown
    markdown: {
      codeBackground: '#f1f5f9', // Slate-100
      codeHeaderFg: '#64748b', // Slate-500
      inlineCodeFg: '#0e7490', // Cyan-700 — readable on white
      codeTextFg: '#0f172a', // Slate-900
      headingFg: {
        1: '#0891b2', // Cyan-600
        2: '#0891b2',
        3: '#0891b2',
        4: '#0891b2',
        5: '#0891b2',
        6: '#0891b2',
      },
      listBulletFg: '#047857', // Emerald-700 — readable semantic list accent
      blockquoteBorderFg: '#cbd5e1', // Slate-300
      blockquoteTextFg: '#334155', // Slate-700
      dividerFg: '#e2e8f0', // Slate-200
      codeMonochrome: false,
    },
  },
}

export const chatThemes = {
  dark: DEFAULT_CHAT_THEMES.dark,
  light: DEFAULT_CHAT_THEMES.light,
}

export const createMarkdownPalette = (theme: ChatTheme): MarkdownPalette => {
  const headingDefaults: Record<MarkdownHeadingLevel, string> = {
    1: theme.primary,
    2: theme.primary,
    3: theme.primary,
    4: theme.primary,
    5: theme.primary,
    6: theme.primary,
  }

  const overrides = theme.markdown?.headingFg ?? {}

  return {
    inlineCodeFg: theme.markdown?.inlineCodeFg ?? theme.foreground,
    codeBackground: theme.markdown?.codeBackground ?? theme.background,
    codeHeaderFg: theme.markdown?.codeHeaderFg ?? theme.secondary,
    headingFg: {
      ...headingDefaults,
      ...overrides,
    },
    listBulletFg: theme.markdown?.listBulletFg ?? theme.secondary,
    blockquoteBorderFg: theme.markdown?.blockquoteBorderFg ?? theme.secondary,
    blockquoteTextFg: theme.markdown?.blockquoteTextFg ?? theme.foreground,
    dividerFg: theme.markdown?.dividerFg ?? theme.secondary,
    codeTextFg: theme.markdown?.codeTextFg ?? theme.foreground,
    codeMonochrome: theme.markdown?.codeMonochrome ?? true,
    linkFg: theme.markdown?.linkFg ?? theme.link,
  }
}

/**
 * Clone a ChatTheme object to avoid mutations
 * Properly handles nested markdown configuration
 */
export const cloneChatTheme = (input: ChatTheme): ChatTheme => ({
  ...input,
  markdown: input.markdown
    ? {
        ...input.markdown,
        headingFg: input.markdown.headingFg
          ? { ...input.markdown.headingFg }
          : undefined,
      }
    : undefined,
})

/**
 * Resolve a theme color value with optional fallback
 * Returns undefined for 'default' values or empty strings
 */
export const resolveThemeColor = (
  color?: string,
  fallback?: string,
): string | undefined => {
  if (typeof color === 'string') {
    const normalized = color.trim().toLowerCase()
    if (normalized.length > 0 && normalized !== 'default') {
      return color
    }
  }

  if (fallback !== undefined) {
    return resolveThemeColor(fallback)
  }

  return undefined
}
