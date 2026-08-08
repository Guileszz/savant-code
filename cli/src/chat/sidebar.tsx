import { SIDEBAR_TOOLS_AVAILABLE } from './styles'
import { RightSidebar } from '../components/right-sidebar'

import type { ChatSidebarProps } from './types'

/**
 * Right sidebar — session info, tools, history (FID-2026-0805-003).
 * Hidden on narrow terminals so the chat column remains usable.
 */
export function ChatSidebar(props: ChatSidebarProps) {
  const {
    showSidebar,
    contextTokensUsed,
    contextTokensMax,
    sessionCost,
    sidebarModel,
    agentId,
    toolsUsed,
    filesChanged,
    agentStack,
    toolHistory,
    isStreaming,
    isWaitingForResponse,
    fsmPhase,
    agentMode,
  } = props

  if (!showSidebar) return null

  return (
    <RightSidebar
      tokensUsed={contextTokensUsed}
      tokensMax={contextTokensMax}
      cost={sessionCost}
      model={sidebarModel || 'unknown'}
      mode={agentMode}
      agent={agentId ?? 'Savant'}
      toolsUsed={toolsUsed}
      toolsAvailable={SIDEBAR_TOOLS_AVAILABLE}
      filesChanged={filesChanged}
      agentStack={agentStack}
      toolHistory={toolHistory}
      isStreaming={isStreaming}
      isWaitingForResponse={isWaitingForResponse}
      fsmPhase={fsmPhase}
    />
  )
}
