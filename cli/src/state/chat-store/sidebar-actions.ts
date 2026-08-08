import { castDraft } from 'immer'

import { generateSessionId, initialState } from './initial-state'

import type { ChatSidebarActions, ChatStoreSet } from './types'

type SetState = ChatStoreSet

/**
 * Sidebar data + FSM/activity/stream-lifecycle actions for the zustand store.
 * Extracted from chat-store.ts (FID-2026-0805-003); the immer-wrapped `set`
 * is injected so the action bodies stay verbatim.
 */
export const createSidebarActions = (set: SetState): ChatSidebarActions => ({
  // Sidebar data actions
  updateContextTokens: (used) =>
    set((state) => {
      state.contextTokensUsed = used
    }),

  updateContextTokensMax: (max) =>
    set((state) => {
      state.contextTokensMax = max
    }),

  addToolUsed: (toolName) =>
    set((state) => {
      if (!state.toolsUsed.includes(toolName)) {
        state.toolsUsed.push(toolName)
      }
    }),

  addToolHistory: (toolName) =>
    set((state) => {
      state.toolHistory.push({ name: toolName, timestamp: Date.now() })
      // Keep only last 5 entries
      if (state.toolHistory.length > 5) {
        state.toolHistory = state.toolHistory.slice(-5)
      }
    }),

  incrementFilesChanged: (type) =>
    set((state) => {
      if (type === 'modified') state.filesChanged.modified++
      else if (type === 'created') state.filesChanged.created++
      else if (type === 'added') state.filesChanged.added++
      else if (type === 'deleted') state.filesChanged.deleted++
    }),

  updateAgentStack: (stack) =>
    set((state) => {
      state.agentStack = stack
    }),

  updateSessionCost: (cost) =>
    set((state) => {
      state.sessionCost = cost
    }),

  resetSidebarData: () =>
    set((state) => {
      state.contextTokensUsed = 0
      // contextTokensMax is intentionally NOT reset here. It is derived
      // from the currently selected model and updated reactively by the
      // chat screen (FID-2026-0723-062). Resetting it to 200k would make
      // the sidebar lie after a sidebar reset mid-session.
      state.toolsUsed = []
      state.toolHistory = []
      state.filesChanged = { modified: 0, created: 0, added: 0, deleted: 0 }
      state.agentStack = []
      state.sessionCost = 0
      state.fsmPhase = initialState.fsmPhase
      state.activity = initialState.activity
    }),

  setFsmPhase: (phase) =>
    set((state) => {
      state.fsmPhase = phase
    }),

  setActivity: (activity) =>
    set((state) => {
      state.activity = activity
    }),

  onNewUserMessage: () =>
    set((state) => {
      // Reset FSM phase + activity when the user sends a new message.
      // Unlike onStreamEnded (which guards against isRetrying / anti-thrash),
      // this is the canonical pre-run-zeroing path so it's always safe to
      // fire — even when the run that just ended was mid-retry.
      state.fsmPhase = 'idle'
      state.activity = { kind: 'idle', since: Date.now() }
      state.lastResetAt = Date.now()
    }),

  /**
   * FID-2026-0718-010 (F2): single canonical end-of-stream reset. Called from
   * finally block, abort handler, slash-command bridges, and stalled detector.
   * Idempotent — multiple gates can fire within the 100ms anti-thrash window.
   */
  onStreamEnded: (reason: string) =>
    set((state) => {
      // Guard 1: skip reset during retry (Q15) — retry path will signal
      // its own reset when it terminates.
      if (state.isRetrying) return
      // Guard 2: anti-thrash window (Q17) — first caller within 100ms wins.
      if (Date.now() - state.lastResetAt < 100) return

      state.fsmPhase = 'idle'
      state.activity = { kind: 'idle', since: Date.now() }
      state.streamingAgents = new Set<string>()
      state.activeSubagents = new Set<string>()
      state.isChainInProgress = false
      state.lastResetAt = Date.now()
      // Bump the chunk-seen watermark so the stalled detector sees
      // "freshly reset" and won't immediately retrigger.
      state._lastChunkAtMs = Date.now()
      // The reason parameter is intentionally not stored. Logging handled
      // by finish-logic.resetUiToIdle. Tracing via dev/LEARNINGS.
      void reason
    }),

  /**
   * FID-2026-0718-010 (F3/D5): stamp the last chunk timestamp. Called via
   * markChunkSeen() from finish-logic on every SDK chunk handler.
   * O(1) write.
   */
  markChunkSeen: () =>
    set((state) => {
      state._lastChunkAtMs = Date.now()
    }),

  setDevMode: (active) =>
    set((state) => {
      state.devMode = active
    }),

  setPermissionMode: (mode) =>
    set((state) => {
      state.permissionMode = mode
    }),

  reset: () =>
    set((state) => {
      state.chatSessionId = generateSessionId()
      state.messages = initialState.messages.slice()
      state.streamingAgents = new Set(initialState.streamingAgents)
      state.focusedAgentId = initialState.focusedAgentId
      state.inputValue = initialState.inputValue
      state.cursorPosition = initialState.cursorPosition
      state.lastEditDueToNav = initialState.lastEditDueToNav
      // Terminal capabilities and focus outlive a chat. Resetting these can
      // re-enable animation while the app is still unfocused, and focus
      // support would stay false because the mounted detector only reports
      // support once per subscription.
      state.activeSubagents = new Set(initialState.activeSubagents)
      state.isChainInProgress = initialState.isChainInProgress
      state.slashSelectedIndex = initialState.slashSelectedIndex
      state.agentSelectedIndex = initialState.agentSelectedIndex
      state.agentMode = initialState.agentMode
      state.hasReceivedPlanResponse = initialState.hasReceivedPlanResponse
      state.lastMessageMode = initialState.lastMessageMode
      state.sessionCreditsUsed = initialState.sessionCreditsUsed
      state.runState = initialState.runState
        ? castDraft(initialState.runState)
        : null
      state.activeTopBanner = initialState.activeTopBanner
      state.inputMode = initialState.inputMode
      state.adsEnabled = initialState.adsEnabled
      state.isRetrying = initialState.isRetrying
      state.askUserState = initialState.askUserState
      state.pendingAttachments = []
      state.pendingBashMessages = []
      state.suggestedFollowups = null
      state.clickedFollowupsMap = new Map<string, Set<number>>()

      // Reset sidebar data. contextTokensMax is derived from the active
      // model, so leave it alone — the chat screen effect keeps it correct.
      state.contextTokensUsed = 0
      state.toolsUsed = []
      state.toolHistory = []
      state.filesChanged = { modified: 0, created: 0, added: 0, deleted: 0 }
      state.agentStack = []
      state.sessionCost = 0
      state.fsmPhase = initialState.fsmPhase
      state.activity = initialState.activity
      state.devMode = initialState.devMode
      state.permissionMode = initialState.permissionMode
    }),
})
