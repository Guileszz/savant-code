#!/usr/bin/env bun

/**
 * Prebuild script that scans the agents/ directory and generates a TypeScript
 * module with all agent definitions embedded as static data.
 *
 * This allows agent definitions to be bundled into the CLI binary without
 * requiring runtime filesystem access to the agents/ directory.
 *
 * Note: The agents/ directory (without dot) contains official bundled agents.
 * The .agents/ directory is for user/project-specific agents loaded at runtime.
 *
 * Run this before building the binary:
 *   bun run scripts/prebuild-agents.ts
 */

import * as fs from 'fs'
import * as path from 'path'

import {
  format as formatWithPrettier,
  resolveConfig as resolvePrettierConfig,
} from 'prettier'

import { writeFileAtomic } from '../src/utils/write-file-atomic'

import type { AgentDefinition } from '@savant-code/common/templates/initial-agents-dir/types/agent-definition'

// FID-2026-0810-001: load repo-root .env.local before importing agent files.
// The boot chain runs with `--cwd cli`, so Bun's auto-loader looks for
// cli/.env.local (absent) instead of the repo-root file. This explicit import
// walks up from cli/scripts/ via findUp() to find and apply .env.local.
import '../src/pre-init/load-dev-env'

const AGENTS_DIR = path.join(import.meta.dir, '../../agents')
const OUTPUT_FILE = path.join(
  import.meta.dir,
  '../src/agents/bundled-agents.generated.ts',
)

type BundledAgentDefinition = Omit<AgentDefinition, 'handleSteps'> & {
  handleSteps?: string
  [key: string]: unknown
}

type AgentLoadResult =
  | { definition: BundledAgentDefinition; failed: false }
  | { definition: null; failed: false }
  | { definition: null; failed: true }

/**
 * Recursively get all TypeScript files from a directory
 */
function getAllTsFiles(dir: string): string[] {
  const files: string[] = []

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        // Skip __tests__ and node_modules directories
        if (
          entry.name === '__tests__' ||
          entry.name === 'node_modules' ||
          entry.name === 'types'
        ) {
          continue
        }
        files.push(...getAllTsFiles(fullPath))
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.d.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('manual-e2e.ts')
      ) {
        files.push(fullPath)
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`Error reading directory ${dir}: ${errorMessage}`)
  }

  return files
}

/**
 * Load and process an agent definition from a TypeScript file
 */
async function loadAgentDefinition(filePath: string): Promise<AgentLoadResult> {
  try {
    // Use dynamic import to load the module
    const module = await import(filePath)
    const definition = module.default

    if (!definition) {
      // Helper modules (prompts, handle-steps, system-prompt, output-schema,
      // …) legitimately export named helpers and no default agent definition.
      // They are expected in the agents/ tree and are silently skipped. Only
      // warn when a file exports neither a default nor any named symbol — a
      // genuinely unexpected empty module.
      const namedExports = Object.keys(module).filter(
        (key) => key !== 'default',
      )
      if (namedExports.length === 0) {
        console.warn(
          `⚠️  Skipped ${filePath}: no default export and no named exports found`,
        )
      }
      return { definition: null, failed: false }
    }

    if (!definition.id) {
      console.warn(`⚠️  Skipped ${filePath}: missing required 'id' field`)
      return { definition: null, failed: false }
    }

    if (!definition.model) {
      console.warn(
        `⚠️  Skipped ${filePath} (agent '${definition.id}'): missing required 'model' field`,
      )
      return { definition: null, failed: false }
    }

    // Process the definition - convert handleSteps function to string.
    // Inspect the source union before assigning to the serialized bundle type;
    // checking after assignment would narrow a string-only field to never.
    const processed: BundledAgentDefinition = {
      ...definition,
      ...(typeof definition.handleSteps === 'function'
        ? { handleSteps: definition.handleSteps.toString() }
        : definition.handleSteps === undefined
          ? {}
          : { handleSteps: definition.handleSteps }),
    }

    return { definition: processed, failed: false }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`❌ Failed to load agent from ${filePath}: ${errorMsg}`)
    return { definition: null, failed: true }
  }
}

/**
 * Generate the bundled agents TypeScript file
 */
function generateBundledAgentsFile(
  agents: Record<string, BundledAgentDefinition>,
): string {
  const agentCount = Object.keys(agents).length

  return `/**
 * AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
 * 
 * This file is generated by scripts/prebuild-agents.ts
 * It contains all bundled agent definitions from the agents/ directory.
 * 
 * Agent count: ${agentCount}
 */

import type { AgentDefinition } from '@savant-code/common/templates/initial-agents-dir/types/agent-definition'
import type { LocalAgentInfo } from '../utils/local-agent-registry'

export type BundledAgentDefinition = Omit<AgentDefinition, 'handleSteps'> & {
  handleSteps?: string
  [key: string]: unknown
}

/**
 * All bundled agent definitions keyed by their ID.
 * These are the default SavantCode agents that ship with the CLI binary.
 */
export const bundledAgents: Record<string, BundledAgentDefinition> = ${JSON.stringify(agents, null, 2)};

/**
 * Get bundled agents as LocalAgentInfo format for the CLI
 */
export function getBundledAgentsAsLocalInfo(): LocalAgentInfo[] {
  return Object.values(bundledAgents).map((agent) => ({
    id: agent.id,
    displayName: agent.displayName || agent.id,
    filePath: '[bundled]',
    isBundled: true,
  }));
}

/**
 * Get all bundled agent IDs
 */
export function getBundledAgentIds(): string[] {
  return Object.keys(bundledAgents);
}

/**
 * Check if an agent ID is a bundled agent
 */
export function isBundledAgent(agentId: string): boolean {
  return agentId in bundledAgents;
}
`
}

async function main() {
  const DEBUG = false
  if (DEBUG) {
    console.log('🔍 DEBUG: Scanning agents/ directory...')
  }

  if (!fs.existsSync(AGENTS_DIR)) {
    console.error(`Error: agents/ directory not found at ${AGENTS_DIR}`)
    process.exitCode = 1
    return
  }

  const tsFiles = getAllTsFiles(AGENTS_DIR)
  if (DEBUG) {
    console.log(`📁 DEBUG: Found ${tsFiles.length} TypeScript files`)
  }

  const agents: Record<string, BundledAgentDefinition> = {}
  let loadedCount = 0
  let skippedCount = 0
  let failedCount = 0

  for (const filePath of tsFiles) {
    const relativePath = path.relative(AGENTS_DIR, filePath)
    const result = await loadAgentDefinition(filePath)

    if (result.definition) {
      agents[result.definition.id] = result.definition
      loadedCount++
      if (DEBUG) {
        console.log(`  ✅ DEBUG: ${result.definition.id} (${relativePath})`)
      }
    } else if (result.failed) {
      failedCount++
    } else {
      skippedCount++
      if (DEBUG) {
        console.log(
          `  ⏭️ DEBUG: Skipped: ${relativePath} (no valid default export)`,
        )
      }
    }
  }

  if (failedCount > 0) {
    console.error(
      `❌ Agent prebuild aborted: ${failedCount} agent definition(s) failed to load; existing bundle was not replaced.`,
    )
    process.exitCode = 1
    return
  }

  if (DEBUG) {
    console.log(
      `\n📦 DEBUG: Loaded ${loadedCount} agents, skipped ${skippedCount} files`,
    )
  }

  // Generate the output file
  const output = generateBundledAgentsFile(agents)

  // Format with prettier so the regenerated bundle stays compliant with the
  // declared format gate (protocol.config.yaml `commands.format`), matching the
  // repo .prettierrc (semi: false, singleQuote: true, trailingComma: all).
  // FID-2026-0805-00X hardening session.
  const prettierConfig = await resolvePrettierConfig(import.meta.dir).catch(
    () => null,
  )
  const formatted = await formatWithPrettier(output, {
    parser: 'typescript',
    ...(prettierConfig ?? {}),
  })

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_FILE)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  writeFileAtomic(OUTPUT_FILE, formatted)
  if (DEBUG) {
    console.log(`\n✨ DEBUG: Generated ${OUTPUT_FILE}`)
    console.log(`   DEBUG: ${Object.keys(agents).length} agents bundled`)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
