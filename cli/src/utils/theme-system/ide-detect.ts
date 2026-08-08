import { getCliEnv } from '../env'
import {
  collectExistingPaths,
  inferThemeFromName,
  resolveJetBrainsLafPaths,
  resolveVSCodeSettingsPaths,
  resolveZedSettingsPaths,
  safeReadFile,
  stripJsonStyleComments,
} from './ide-paths'
import { detectPlatformTheme } from './system-detect'

import type { CliEnv } from '../../types/env'
import type { ThemeName } from '../../types/theme-system'
import type { JSONValue } from '@savant-code/common/types/json'

const extractVSCodeTheme = (content: string): ThemeName | null => {
  // Try standard colorTheme setting
  const colorThemeMatch = content.match(
    /"workbench\.colorTheme"\s*:\s*"([^"]+)"/i,
  )
  if (colorThemeMatch) {
    const inferred = inferThemeFromName(colorThemeMatch[1])
    if (inferred) return inferred
  }

  // Check if auto-detect is enabled and try preferred themes
  const autoDetectMatch = content.match(
    /"window\.autoDetectColorScheme"\s*:\s*(true|false)/i,
  )
  const autoDetectEnabled = autoDetectMatch?.[1]?.toLowerCase() === 'true'

  if (autoDetectEnabled) {
    // Try to extract both preferred themes and infer from their names
    const preferredDarkMatch = content.match(
      /"workbench\.preferredDarkColorTheme"\s*:\s*"([^"]+)"/i,
    )
    if (preferredDarkMatch) {
      const inferred = inferThemeFromName(preferredDarkMatch[1])
      if (inferred) return inferred
    }

    const preferredLightMatch = content.match(
      /"workbench\.preferredLightColorTheme"\s*:\s*"([^"]+)"/i,
    )
    if (preferredLightMatch) {
      const inferred = inferThemeFromName(preferredLightMatch[1])
      if (inferred) return inferred
    }
  }

  return null
}

const extractJetBrainsTheme = (content: string): ThemeName | null => {
  // Check if autodetect is enabled (Sync with OS setting)
  const autodetectMatch = content.match(
    /<component[^>]+name="LafManager"[^>]+autodetect="(true|false)"/i,
  )
  if (autodetectMatch?.[1]?.toLowerCase() === 'true') {
    // When syncing with OS, return null to trigger platform detection
    return null
  }

  const normalized = content.toLowerCase()
  if (normalized.includes('darcula') || normalized.includes('dark')) {
    return 'dark'
  }

  if (normalized.includes('light')) {
    return 'light'
  }

  return null
}

export const isVSCodeFamilyTerminal = (env: CliEnv = getCliEnv()): boolean => {
  if (env.TERM_PROGRAM?.toLowerCase() === 'vscode') {
    return true
  }

  // Check VS Code family env keys
  if (
    env.VSCODE_GIT_IPC_HANDLE ||
    env.VSCODE_PID ||
    env.VSCODE_CWD ||
    env.VSCODE_NLS_CONFIG ||
    env.CURSOR_PORT ||
    env.CURSOR
  ) {
    return true
  }

  return false
}

export const isJetBrainsTerminal = (env: CliEnv = getCliEnv()): boolean => {
  if (env.TERMINAL_EMULATOR?.toLowerCase().includes('jetbrains')) {
    return true
  }

  // Check JetBrains env keys
  if (
    env.JETBRAINS_REMOTE_RUN ||
    env.IDEA_INITIAL_DIRECTORY ||
    env.IDE_CONFIG_DIR ||
    env.JB_IDE_CONFIG_DIR
  ) {
    return true
  }

  return false
}

export const isZedTerminal = (env: CliEnv = getCliEnv()): boolean => {
  const termProgram = env.TERM_PROGRAM?.toLowerCase()
  return termProgram === 'zed' || false
}

const detectVSCodeTheme = (env: CliEnv = getCliEnv()): ThemeName | null => {
  if (!isVSCodeFamilyTerminal(env)) {
    return null
  }

  const settingsPaths = collectExistingPaths(resolveVSCodeSettingsPaths(env))

  for (const settingsPath of settingsPaths) {
    const content = safeReadFile(settingsPath)
    if (!content) continue
    const theme = extractVSCodeTheme(content)
    if (theme) {
      return theme
    }

    // If extractVSCodeTheme returned null but auto-detect is enabled,
    // use platform theme as fallback
    const autoDetectMatch = content.match(
      /"window\.autoDetectColorScheme"\s*:\s*(true|false)/i,
    )
    if (autoDetectMatch?.[1]?.toLowerCase() === 'true') {
      return detectPlatformTheme()
    }
  }

  const themeKindEnv = env.VSCODE_THEME_KIND ?? env.VSCODE_COLOR_THEME_KIND
  if (themeKindEnv) {
    const normalized = themeKindEnv.trim().toLowerCase()
    if (normalized === 'dark' || normalized === 'hc') return 'dark'
    if (normalized === 'light') return 'light'
  }

  return null
}

const detectJetBrainsTheme = (env: CliEnv = getCliEnv()): ThemeName | null => {
  if (!isJetBrainsTerminal(env)) {
    return null
  }

  const lafPaths = collectExistingPaths(resolveJetBrainsLafPaths(env))

  for (const lafPath of lafPaths) {
    const content = safeReadFile(lafPath)
    if (!content) continue
    const theme = extractJetBrainsTheme(content)
    if (theme) {
      return theme
    }

    // If extractJetBrainsTheme returned null, check if autodetect is enabled
    // and fall back to platform detection
    const autodetectMatch = content.match(
      /<component[^>]+name="LafManager"[^>]+autodetect="(true|false)"/i,
    )
    if (autodetectMatch?.[1]?.toLowerCase() === 'true') {
      return detectPlatformTheme()
    }
  }

  return null
}

const extractZedTheme = (content: string): ThemeName | null => {
  try {
    const sanitized = stripJsonStyleComments(content)
    const parsed = JSON.parse(sanitized) as Record<string, JSONValue>
    const candidates: string[] = []

    const themeSetting = parsed.theme
    if (typeof themeSetting === 'string') {
      candidates.push(themeSetting)
    } else if (themeSetting && typeof themeSetting === 'object') {
      const themeConfig = themeSetting as Record<string, JSONValue>
      const modeRaw = themeConfig.mode
      if (typeof modeRaw === 'string') {
        const mode = modeRaw.toLowerCase()
        // If mode is 'system', return null to trigger platform detection
        if (mode === 'system') {
          return null
        }
        if (mode === 'dark' || mode === 'light') {
          candidates.push(mode)
          const modeTheme = themeConfig[mode]
          if (typeof modeTheme === 'string') {
            candidates.push(modeTheme)
          }
        }
      }

      const darkTheme = themeConfig.dark
      if (typeof darkTheme === 'string') {
        candidates.push(darkTheme)
      }

      const lightTheme = themeConfig.light
      if (typeof lightTheme === 'string') {
        candidates.push(lightTheme)
      }
    }

    const appearance = parsed.appearance
    if (appearance && typeof appearance === 'object') {
      const appearanceTheme = (appearance as Record<string, JSONValue>).theme
      if (typeof appearanceTheme === 'string') {
        candidates.push(appearanceTheme)
      }

      const preference = (appearance as Record<string, JSONValue>)
        .theme_preference
      if (typeof preference === 'string') {
        candidates.push(preference)
      }
    }

    const ui = parsed.ui
    if (ui && typeof ui === 'object') {
      const uiTheme = (ui as Record<string, JSONValue>).theme
      if (typeof uiTheme === 'string') {
        candidates.push(uiTheme)
      }
    }

    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue

      const inferred = inferThemeFromName(candidate)
      if (inferred) {
        return inferred
      }
    }
  } catch {
    // Ignore malformed or partially written files
  }

  return null
}

const detectZedTheme = (env: CliEnv = getCliEnv()): ThemeName | null => {
  if (!isZedTerminal(env)) {
    return null
  }

  const settingsPaths = collectExistingPaths(resolveZedSettingsPaths(env))
  for (const settingsPath of settingsPaths) {
    const content = safeReadFile(settingsPath)
    if (!content) continue

    const theme = extractZedTheme(content)
    if (theme) {
      return theme
    }

    // If extractZedTheme returned null, check if theme mode is 'system'
    // and fall back to platform detection
    try {
      const sanitized = stripJsonStyleComments(content)
      const parsed = JSON.parse(sanitized) as Record<string, JSONValue>
      const themeSetting = parsed.theme
      if (themeSetting && typeof themeSetting === 'object') {
        const themeConfig = themeSetting as Record<string, JSONValue>
        const modeRaw = themeConfig.mode
        if (typeof modeRaw === 'string' && modeRaw.toLowerCase() === 'system') {
          return detectPlatformTheme()
        }
      }
    } catch {
      // Ignore parsing errors
    }
  }

  return null
}

export const detectIDETheme = (env: CliEnv = getCliEnv()): ThemeName | null => {
  const theme = detectVSCodeTheme(env)
  if (theme) return theme

  const jbTheme = detectJetBrainsTheme(env)
  if (jbTheme) return jbTheme

  const zedTheme = detectZedTheme(env)
  if (zedTheme) return zedTheme

  return null
}

export const getIDEThemeConfigPaths = (env: CliEnv = getCliEnv()): string[] => {
  const paths = new Set<string>()
  for (const path of resolveVSCodeSettingsPaths(env)) {
    paths.add(path)
  }
  for (const path of resolveJetBrainsLafPaths(env)) {
    paths.add(path)
  }
  for (const path of resolveZedSettingsPaths(env)) {
    paths.add(path)
  }
  return [...paths]
}
