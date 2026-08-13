import fs from 'fs'
import path from 'path'

import { getConfigDir } from '../auth'
import { logger } from '../logger'
import { DEFAULT_SETTINGS } from './constants'
import { validateSettings } from './validation'
import { writeFileAtomic } from '../write-file-atomic'

import type { Settings } from './types'
import type { JSONValue } from '@savant-code/common/types/json'

/** Get the settings file path. */
export const getSettingsPath = (): string => {
  return path.join(getConfigDir(), 'settings.json')
}

/** Ensure the config directory exists, creating it if necessary. */
const ensureConfigDirExists = (): void => {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
}

/** Load all settings from disk, validating and dropping unknown values. */
export const loadSettings = (): Settings => {
  const settingsPath = getSettingsPath()

  if (!fs.existsSync(settingsPath)) {
    ensureConfigDirExists()
    const defaults = { ...DEFAULT_SETTINGS }
    writeFileAtomic(settingsPath, JSON.stringify(defaults, null, 2))
    return defaults
  }

  try {
    const settingsFile = fs.readFileSync(settingsPath, 'utf8')
    const parsed = JSON.parse(settingsFile) as JSONValue
    return validateSettings(parsed)
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Error reading settings',
    )
    return {}
  }
}

/**
 * Save settings to disk. An `undefined` value explicitly removes a persisted
 * key; this is required by reset-style preferences and avoids stale selection
 * state surviving a reset command.
 */
export const saveSettings = (newSettings: Partial<Settings>): void => {
  const settingsPath = getSettingsPath()

  try {
    ensureConfigDirExists()
    const existingSettings = loadSettings()
    const mergedSettings = { ...existingSettings }
    for (const [key, value] of Object.entries(newSettings) as Array<
      [keyof Settings, Settings[keyof Settings] | undefined]
    >) {
      if (value === undefined) {
        delete mergedSettings[key]
      } else {
        mergedSettings[key] = value as never
      }
    }
    writeFileAtomic(settingsPath, JSON.stringify(mergedSettings, null, 2))
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Error saving settings',
    )
    throw error
  }
}
