/**
 * Slash/mention suggestion engine wiring + menu handlers for the chat screen
 * (FID-2026-0805-003). Extracted from chat.tsx verbatim.
 */

import { AnalyticsEvent } from '@savant-code/common/constants/analytics-events'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getSlashCommandsWithSkills } from '../data/slash-commands'
import { useSuggestionEngine } from '../hooks/use-suggestion-engine'
import { trackEvent } from '../utils/analytics'
import { showClipboardMessage } from '../utils/clipboard'
import { logger } from '../utils/logger'
import { getLoadedSkills } from '../utils/skill-registry'

import type { OnSubmitPrompt } from './types'
import type { CommandResult } from '../commands/command-registry'
import type { SuggestionItem } from '../components/suggestion-menu'
import type {
  MatchedAgentInfo,
  MatchedFileInfo,
  MatchedSlashCommand,
  TriggerContext,
} from '../hooks/use-suggestion-engine'
import type { InputValue } from '../types/store'
import type { AgentMode } from '../utils/constants'
import type { InputMode } from '../utils/input-modes'
import type { LocalAgentInfo } from '../utils/local-agent-registry'
import type { FileTreeNode } from '@savant-code/common/util/file'

export interface UseChatSuggestionsArgs {
  inputValue: string
  cursorPosition: number
  inputMode: InputMode
  agentMode: AgentMode
  fileTree: FileTreeNode[]
  localAgents: LocalAgentInfo[]
  adsEnabled: boolean
  hasSubscription: boolean
  setInputValue: (
    value: InputValue | ((prev: InputValue) => InputValue),
  ) => void
  slashSelectedIndex: number
  setSlashSelectedIndex: (value: number | ((prev: number) => number)) => void
  agentSelectedIndex: number
  setAgentSelectedIndex: (value: number | ((prev: number) => number)) => void
  onSubmitPrompt: OnSubmitPrompt
  handleCommandResult: (result?: CommandResult) => void
}

export interface UseChatSuggestionsReturn {
  slashContext: TriggerContext
  mentionContext: TriggerContext
  slashMatches: MatchedSlashCommand[]
  agentMatches: MatchedAgentInfo[]
  fileMatches: MatchedFileInfo[]
  slashSuggestionItems: SuggestionItem[]
  agentSuggestionItems: SuggestionItem[]
  fileSuggestionItems: SuggestionItem[]
  openFileMenuWithTab: () => boolean
  handleMentionItemClick: (index: number) => void
  handleSlashItemClick: (index: number) => void
  executeSlashCommand: (
    selected: MatchedSlashCommand | undefined,
  ) => Promise<void>
  applySlashInsertText: (selected: MatchedSlashCommand) => boolean
  selectMentionAt: (index: number) => boolean
}

export function useChatSuggestions({
  inputValue,
  cursorPosition,
  inputMode,
  agentMode,
  fileTree,
  localAgents,
  adsEnabled,
  hasSubscription,
  setInputValue,
  slashSelectedIndex,
  setSlashSelectedIndex,
  agentSelectedIndex,
  setAgentSelectedIndex,
  onSubmitPrompt,
  handleCommandResult,
}: UseChatSuggestionsArgs): UseChatSuggestionsReturn {
  const [forceFileOnlyMentions, setForceFileOnlyMentions] = useState(false)

  // Get loaded skills for slash commands
  const loadedSkills = useMemo(() => getLoadedSkills(), [])

  // Filter slash commands based on current ads state - only show the option that changes state
  // Hide both ads commands entirely for subscribers
  // Also merge in skill commands
  const filteredSlashCommands = useMemo(() => {
    const allCommands = getSlashCommandsWithSkills(loadedSkills)
    return allCommands.filter((cmd) => {
      if (cmd.id === 'ads:enable') return !hasSubscription && !adsEnabled
      if (cmd.id === 'ads:disable') return !hasSubscription && adsEnabled
      return true
    })
    // FID-007 P1: deps are the reactive ads store slice (updated by the ads
    // commands) — NOT inputValue, whose only effect was to rebuild the command
    // list and clear the suggestion-engine cache on every keystroke.
  }, [loadedSkills, hasSubscription, adsEnabled])

  const {
    slashContext,
    mentionContext,
    slashMatches,
    agentMatches,
    fileMatches,
    slashSuggestionItems,
    agentSuggestionItems,
    fileSuggestionItems,
  } = useSuggestionEngine({
    disableAgentSuggestions: forceFileOnlyMentions || inputMode !== 'default',
    inputValue: inputMode === 'bash' ? '' : inputValue,
    cursorPosition,
    slashCommands: filteredSlashCommands,
    localAgents,
    fileTree,
    currentAgentMode: agentMode,
  })

  useEffect(() => {
    if (!mentionContext.active) {
      setForceFileOnlyMentions(false)
    }
  }, [mentionContext.active])

  // Track when slash menu is activated
  const prevSlashActiveRef = useRef(false)
  useEffect(() => {
    if (slashContext.active && !prevSlashActiveRef.current) {
      trackEvent(AnalyticsEvent.SLASH_MENU_ACTIVATED, {
        queryLength: slashContext.query.length,
        matchCount: slashMatches.length,
        inputLength: inputValue.length,
      })
    }
    prevSlashActiveRef.current = slashContext.active
  }, [
    slashContext.active,
    slashContext.query,
    slashMatches.length,
    inputValue.length,
  ])

  // Reset suggestion menu indexes when context changes
  useEffect(() => {
    if (!slashContext.active) {
      setSlashSelectedIndex(0)
      return
    }
    setSlashSelectedIndex(0)
  }, [slashContext.active, slashContext.query, setSlashSelectedIndex])

  useEffect(() => {
    if (slashMatches.length > 0 && slashSelectedIndex >= slashMatches.length) {
      setSlashSelectedIndex(slashMatches.length - 1)
    }
    if (slashMatches.length === 0 && slashSelectedIndex !== 0) {
      setSlashSelectedIndex(0)
    }
  }, [slashMatches.length, slashSelectedIndex, setSlashSelectedIndex])

  useEffect(() => {
    if (!mentionContext.active) {
      setAgentSelectedIndex(0)
      return
    }
    setAgentSelectedIndex(0)
  }, [mentionContext.active, mentionContext.query, setAgentSelectedIndex])

  useEffect(() => {
    const totalMatches = agentMatches.length + fileMatches.length
    if (totalMatches > 0 && agentSelectedIndex >= totalMatches) {
      setAgentSelectedIndex(totalMatches - 1)
    }
    if (totalMatches === 0 && agentSelectedIndex !== 0) {
      setAgentSelectedIndex(0)
    }
  }, [
    agentMatches.length,
    fileMatches.length,
    agentSelectedIndex,
    setAgentSelectedIndex,
  ])

  const openFileMenuWithTab = useCallback((): boolean => {
    const safeCursor = Math.max(0, Math.min(cursorPosition, inputValue.length))

    let wordStart = safeCursor
    while (wordStart > 0 && !/\s/.test(inputValue[wordStart - 1]!)) {
      wordStart--
    }
    // FID-007 D4: report whether a word precedes the cursor so the keyboard
    // handler can fall through when there is nothing to complete (previously
    // this scan was duplicated inline in onOpenFileMenuWithTab).
    if (wordStart >= safeCursor) return false

    const before = inputValue.slice(0, wordStart)
    const wordAtCursor = inputValue.slice(wordStart, safeCursor)
    const after = inputValue.slice(safeCursor)
    const mentionWord = wordAtCursor.startsWith('@')
      ? wordAtCursor
      : `@${wordAtCursor}`

    const text = `${before}${mentionWord}${after}`
    const nextCursor = before.length + mentionWord.length

    setInputValue({
      text,
      cursorPosition: nextCursor,
      lastEditDueToNav: false,
    })
    setForceFileOnlyMentions(true)
    return true
  }, [cursorPosition, inputValue, setInputValue])

  // FID-007 D3: single mention select-and-replace helper shared by the click
  // handler and the two keyboard menu handlers (previously 3 copies).
  const selectMentionAt = useCallback(
    (index: number): boolean => {
      if (mentionContext.startIndex < 0) return false

      let replacement: string
      if (index < agentMatches.length) {
        const selected = agentMatches[index]
        if (!selected) return false
        replacement = `@${selected.id} `
      } else {
        const fileIndex = index - agentMatches.length
        const selectedFile = fileMatches[fileIndex]
        if (!selectedFile) return false
        replacement = `@${selectedFile.filePath} `
      }
      const before = inputValue.slice(0, mentionContext.startIndex)
      const after = inputValue.slice(
        mentionContext.startIndex + 1 + mentionContext.query.length,
      )
      setInputValue({
        text: before + replacement + after,
        cursorPosition: before.length + replacement.length,
        lastEditDueToNav: false,
      })
      setAgentSelectedIndex(0)
      return true
    },
    [
      mentionContext,
      agentMatches,
      fileMatches,
      inputValue,
      setInputValue,
      setAgentSelectedIndex,
    ],
  )

  const handleMentionItemClick = useCallback(
    (index: number) => {
      selectMentionAt(index)
    },
    [selectMentionAt],
  )

  // Helper to apply insertText for slash commands - returns true if handled
  const applySlashInsertText = useCallback(
    (selected: MatchedSlashCommand): boolean => {
      if (selected.insertText != null && slashContext.startIndex >= 0) {
        const before = inputValue.slice(0, slashContext.startIndex)
        const after = inputValue.slice(
          slashContext.startIndex + 1 + slashContext.query.length,
        )
        setInputValue({
          text: before + selected.insertText + after,
          cursorPosition: before.length + selected.insertText.length,
          lastEditDueToNav: false,
        })
        setSlashSelectedIndex(0)
        return true
      }
      return false
    },
    [slashContext, inputValue, setInputValue, setSlashSelectedIndex],
  )

  // Click handler for slash menu items - executes command or inserts text
  // FID-007 D3/E1: single slash execute helper (insertText handling, selection
  // reset, and error surfacing) shared by the click handler and keyboard menu.
  const executeSlashCommand = useCallback(
    async (selected: MatchedSlashCommand | undefined): Promise<void> => {
      if (!selected) return

      // If the command has insertText, insert it instead of executing
      if (applySlashInsertText(selected)) return

      setSlashSelectedIndex(0)
      try {
        const result = await onSubmitPrompt(`/${selected.id}`, agentMode)
        handleCommandResult(result)
      } catch (error) {
        logger.error({ error }, '[slash] Failed to execute command')
        showClipboardMessage('Failed to execute command', { durationMs: 3000 })
      }
    },
    [
      applySlashInsertText,
      setSlashSelectedIndex,
      onSubmitPrompt,
      agentMode,
      handleCommandResult,
    ],
  )

  const handleSlashItemClick = useCallback(
    async (index: number) => {
      await executeSlashCommand(slashMatches[index])
    },
    [slashMatches, executeSlashCommand],
  )

  return {
    slashContext,
    mentionContext,
    slashMatches,
    agentMatches,
    fileMatches,
    slashSuggestionItems,
    agentSuggestionItems,
    fileSuggestionItems,
    openFileMenuWithTab,
    handleMentionItemClick,
    handleSlashItemClick,
    executeSlashCommand,
    applySlashInsertText,
    selectMentionAt,
  }
}
