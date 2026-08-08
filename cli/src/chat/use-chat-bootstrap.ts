/**
 * One-time bootstrap effects for the chat screen (FID-2026-0805-003).
 * Extracted from chat.tsx verbatim: provider-setup guidance, sidebar
 * context-token cap sync, and the CLI-flag initial mode/permission wiring.
 */

import { useEffect, useRef } from 'react'

import { useChatStore } from '../state/chat-store'
import { useGatewayCatalogStore } from '../state/gateway-catalog-store'
import { IS_SAVANT_FREE } from '../utils/constants'
import { getSystemMessage } from '../utils/message-history'
import { resolveContextWindowForModel } from '../utils/openrouter-models'
import {
  getMissingProviderSetup,
  getProviderSetupGuidance,
} from '../utils/provider-setup'

import type { ChatMessage } from '../types/chat'
import type { AgentMode } from '../utils/constants'
import type { PermissionMode } from '../utils/settings'

export interface UseChatBootstrapArgs {
  messages: ChatMessage[]
  setMessages: (
    value: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
  ) => void
  sidebarModel: string | null | undefined
  updateContextTokensMax: (maxTokens: number) => void
  initialMode?: AgentMode
  setAgentMode: (mode: AgentMode) => void
  initialPermissionMode?: PermissionMode
}

export function useChatBootstrap({
  messages,
  setMessages,
  sidebarModel,
  updateContextTokensMax,
  initialMode,
  setAgentMode,
  initialPermissionMode,
}: UseChatBootstrapArgs): void {
  const providerGuidanceShownRef = useRef(false)
  useEffect(() => {
    // FID-007 U1: provider guidance is non-free builds only — SavantFree
    // reaches inference via its own gateway, `/provider` is not registered
    // there, and instructing free users to run it would produce
    // "Command not found".
    if (IS_SAVANT_FREE) return
    if (providerGuidanceShownRef.current || messages.length !== 0) return

    const missingProvider = getMissingProviderSetup()
    if (!missingProvider) return

    providerGuidanceShownRef.current = true
    setMessages((prev) => [
      ...prev,
      getSystemMessage(getProviderSetupGuidance(missingProvider)),
    ])
  }, [messages.length, setMessages])

  // FID-2026-0723-062: keep the sidebar context-token cap in sync with the
  // active model. This fires on initial render (restored preference), when the
  // model changes, and when the gateway catalog finishes loading asynchronously.
  const gatewayCatalogLoadedAt = useGatewayCatalogStore((s) => s.lastLoadedAt)
  useEffect(() => {
    if (sidebarModel) {
      const maxTokens = resolveContextWindowForModel(sidebarModel)
      updateContextTokensMax(maxTokens)
    }
  }, [sidebarModel, updateContextTokensMax, gatewayCatalogLoadedAt])

  // Set initial mode from CLI flag on mount
  useEffect(() => {
    if (initialMode) {
      setAgentMode(initialMode)
    }
  }, [initialMode, setAgentMode])

  // Set initial permission mode from CLI flag on mount (CLI takes precedence
  // over saved setting because it is an explicit per-launch override).
  useEffect(() => {
    if (initialPermissionMode) {
      useChatStore.getState().setPermissionMode(initialPermissionMode)
    }
  }, [initialPermissionMode])
}
