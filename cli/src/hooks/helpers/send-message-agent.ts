import { getAgentIdForMode } from '../../utils/savant-free-agent-selection'
import { loadSavantCodeModelPreference } from '../../utils/settings'

import type { AgentMode } from '../../utils/constants'
import type { AgentDefinition, MessageContent } from '@savant-code/sdk'

// Choose the agent definition by explicit selection or mode-based fallback.
export const resolveAgent = (
  agentMode: AgentMode,
  agentId: string | undefined,
  agentDefinitions: AgentDefinition[],
): AgentDefinition | string => {
  const selectedAgentDefinition =
    agentId && agentDefinitions.length > 0
      ? agentDefinitions.find((definition) => definition.id === agentId)
      : undefined

  return selectedAgentDefinition ?? agentId ?? getAgentIdForMode(agentMode)
}

// Apply the user's savant-code model override if one is set.
export const applySavantCodeModelOverride = (
  agent: AgentDefinition | string,
  agentDefinitions: AgentDefinition[],
): AgentDefinition | string => {
  const modelOverride = loadSavantCodeModelPreference()
  if (!modelOverride) return agent

  // If agent is a string (agent ID), look it up
  const agentDef =
    typeof agent === 'string'
      ? agentDefinitions.find((def) => def.id === agent)
      : agent

  if (!agentDef) return agent

  // Only override if the model is actually different
  if (agentDef.model !== modelOverride) {
    return {
      ...agentDef,
      model: modelOverride,
    }
  }

  return agent
}

// Respect bash context, but avoid sending empty prompts when only images are attached.
export const buildPromptWithContext = (
  promptWithBashContext: string,
  messageContent: MessageContent[] | undefined,
) => {
  const trimmedPrompt = promptWithBashContext.trim()
  if (trimmedPrompt.length > 0) {
    return promptWithBashContext
  }

  if (messageContent && messageContent.length > 0) {
    return 'See attached image(s)'
  }

  return ''
}
