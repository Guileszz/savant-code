import { SAVANT_FREE_MINIMAX_M3_MODEL_ID } from '@savant-code/common/constants/savant-free-models'
import { buildArray } from '@savant-code/common/util/array'

import { publisher } from '../constants'
import {
  getSavantContextPrunerMaxContextLength,
  getSavantHandleSteps,
} from './handle-steps'
import {
  buildAnalyzeInstructionsPrompt,
  buildAnalyzeStepPrompt,
  buildImplementationInstructionsPrompt,
  buildImplementationStepPrompt,
  buildPlanOnlyInstructionsPrompt,
  buildPlanOnlyStepPrompt,
  buildScaffoldInstructionsPrompt,
  buildScaffoldStepPrompt,
  buildStrictInstructionsPrompt,
  buildStrictStepPrompt,
} from './prompts'
import { buildSystemPrompt } from './system-prompt'
import {
  type SecretAgentDefinition,
  type AllToolNames,
} from '../types/secret-agent-definition'

// FID-2026-0802-005 L18: `ENABLE_COMPOSIO_TOOLS = false` made the Composio
// toolNames branch and the system-prompt addendum dead code (Law 4) — the
// constant, its import chain, and both usages were removed.

export function createSavant(
  mode: 'default' | 'free' | 'lite' | 'max' | 'fast',
  options?: {
    hasNoValidation?: boolean
    planOnly?: boolean
    noAskUser?: boolean
    noReview?: boolean
    noGravityIndex?: boolean
    analyzeOnly?: boolean
    scaffoldMode?: boolean
    strictMode?: boolean
    noFIDPerChange?: boolean
    model?: SecretAgentDefinition['model']
    providerOptions?: SecretAgentDefinition['providerOptions']
  },
): Omit<SecretAgentDefinition, 'id'> {
  const {
    hasNoValidation = mode === 'fast',
    planOnly = false,
    noAskUser = false,
    noReview = false,
    noGravityIndex = false,
    analyzeOnly = false,
    scaffoldMode = false,
    strictMode = false,
    noFIDPerChange = false,
    model: modelOverride,
    providerOptions,
  } = options ?? {}
  const isDefault = mode === 'default'
  const isFast = mode === 'fast'
  const isMax = mode === 'max'
  const isFree = mode === 'free' || mode === 'lite'

  // Lite and free modes run MiniMax M3 (routed through the Fireworks AI API).
  // New SavantFree clients select explicit free variants from the model picker;
  // the unqualified savant-free agent covers legacy callers.
  const model =
    modelOverride ??
    (mode === 'lite' || mode === 'free'
      ? SAVANT_FREE_MINIMAX_M3_MODEL_ID
      : 'openrouter/free')
  // After FID-2026-0718-006: all reviewer variants consolidated into Verifier.
  // Verifier inherits parent model via withParentModel().
  const contextPrunerMaxContextLength =
    getSavantContextPrunerMaxContextLength(model)
  const defaultProviderOptions = isFree
    ? {
        data_collection: 'deny' as const,
      }
    : {}

  return {
    publisher,
    model,
    providerOptions: providerOptions ?? defaultProviderOptions,
    reasoningOptions: { effort: 'high' },
    analyzeOnly,
    scaffoldMode,
    noFIDPerChange,
    displayName: 'Savant the Orchestrator',
    spawnerPrompt:
      'Advanced base agent that orchestrates planning, editing, and reviewing for complex coding tasks',
    inputSchema: {
      prompt: {
        type: 'string',
        description: 'A coding task to complete',
      },
      params: {
        type: 'object',
        properties: {
          maxContextLength: {
            type: 'number',
          },
        },
        required: [],
      },
    },
    outputMode: 'last_message',
    includeMessageHistory: true,
    // Orchestrator has write tools for scratchpad/FID/Nova paths (FSM-gated for source code).
    // Code writing to source files is delegated to Forge (GREEN phase).
    toolNames: buildArray(
      'spawn_agents',
      'read_files',
      'read_subtree',
      'run_readonly_command',
      !isFast && 'write_todos',
      !noAskUser && 'suggest_followups',
      !noAskUser && 'ask_user',
      'read_url',
      'skill',
      'set_output',
      'list_directory',
      'glob',
      'render_ui',
      !noGravityIndex && 'gravity_index',
      !analyzeOnly && 'transition_phase',
      !analyzeOnly && 'write_file',
      !analyzeOnly && 'str_replace',
      !analyzeOnly && !scaffoldMode && 'apply_patch',
      scaffoldMode && 'set_scaffold_complete',
    ) as AllToolNames[],
    // Savant agent roster — 10 specialized agents + infrastructure.
    // SavantCode agent variants removed in FID-2026-0718-006.
    // Adversary added FID-2026-0805-004 (POST-AUDIT meta-verification).
    spawnableAgents: buildArray(
      'detective',
      'scout',
      'researcher-web',
      'researcher-docs',
      'basher',
      'thinker',
      'forge',
      'verifier',
      'adversary',
      'tmux-cli',
      'browser-use',
      'database',
      'github',
      'context-pruner',
      'recorder',
      'scribe',
    ),

    systemPrompt: buildSystemPrompt(
      analyzeOnly
        ? 'analyze'
        : planOnly
          ? 'plan'
          : scaffoldMode
            ? 'scaffold'
            : strictMode
              ? 'strict'
              : isFree
                ? 'free'
                : 'default',
      {
        isFree,
        noGravityIndex,
        noAskUser,
        noFIDPerChange,
      },
    ),

    instructionsPrompt: planOnly
      ? buildPlanOnlyInstructionsPrompt({})
      : analyzeOnly
        ? buildAnalyzeInstructionsPrompt({ noAskUser })
        : scaffoldMode
          ? buildScaffoldInstructionsPrompt({ noAskUser })
          : strictMode
            ? buildStrictInstructionsPrompt({ noAskUser })
            : buildImplementationInstructionsPrompt({
                isFast,
                isDefault,
                isMax,
                isFree,
                hasNoValidation,
                noAskUser,
                noReview,
              }),
    stepPrompt: planOnly
      ? buildPlanOnlyStepPrompt({})
      : analyzeOnly
        ? buildAnalyzeStepPrompt({})
        : scaffoldMode
          ? buildScaffoldStepPrompt({})
          : strictMode
            ? buildStrictStepPrompt({})
            : buildImplementationStepPrompt({
                isDefault,
                isFast,
                isMax,
                hasNoValidation,
                isFree,
                noAskUser,
                noReview,
              }),

    // handleSteps is serialized via .toString() and re-eval'd, so closure
    // variables like `isFree` are not in scope at runtime. Pick the right
    // literal-baked function here instead.
    handleSteps: getSavantHandleSteps({
      isFree: mode === 'free',
      maxContextLength: contextPrunerMaxContextLength,
    }),
  }
}

const definition = { ...createSavant('default'), id: 'savant' }
export default definition
