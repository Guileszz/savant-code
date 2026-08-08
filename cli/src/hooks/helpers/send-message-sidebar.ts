import { useChatStore } from '../../state/chat-store'
import { isCoveredBySubscription } from '../../utils/subscription'

import type { SubscriptionResponse } from '../use-subscription-query'

/**
 * Builds the sidebar-wiring callbacks passed into createEventHandlerState:
 * session cost, tool usage, and the subagent stack. `onCost` receives every
 * reported cost (used by the caller to capture actualCredits for completion
 * metadata) before subscription-aware credit accounting.
 */
export const createSidebarEventCallbacks = (params: {
  subscriptionData?: SubscriptionResponse | null
  addSessionCredits: (credits: number) => void
  onCost: (cost: number) => void
}) => {
  const { subscriptionData, addSessionCredits, onCost } = params
  return {
    onTotalCost: (cost: number) => {
      onCost(cost)
      // Only add to session credits if not covered by subscription
      // (subscription credits are shown separately in the UI)
      if (!isCoveredBySubscription(subscriptionData)) {
        addSessionCredits(cost)
      }
      // Wire sidebar: update session cost
      useChatStore.getState().updateSessionCost(cost)
    },
    onToolCall: (toolName: string) => {
      // Wire sidebar: track tool usage and history
      useChatStore.getState().addToolUsed(toolName)
      useChatStore.getState().addToolHistory(toolName)
    },
    onSubagentStart: (agentId: string, displayName: string) => {
      // Wire sidebar: add agent to stack. Store both the stable agentId
      // (used by onSubagentFinish) and the readable displayName (rendered
      // in the sidebar) so generated compact IDs don't pollute the UI.
      const current = useChatStore.getState().agentStack
      useChatStore
        .getState()
        .updateAgentStack([
          ...current,
          { id: agentId, displayName, isActive: true },
        ])
    },
    onSubagentFinish: (agentId: string) => {
      // Wire sidebar: mark agent as inactive
      const current = useChatStore.getState().agentStack
      useChatStore
        .getState()
        .updateAgentStack(
          current.map((a) =>
            a.id === agentId ? { ...a, isActive: false } : a,
          ),
        )
    },
  }
}
