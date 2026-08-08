import React, { useCallback, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { getAllPublishAgentIds } from './publish-confirmation'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import { useChatStore } from '../state/chat-store'
import { usePublishStore } from '../state/publish-store'
import {
  loadLocalAgents,
  loadAgentDefinitions,
} from '../utils/local-agent-registry'
import { isPlainEnterKey } from '../utils/terminal-enter-detection'
import { BORDER_CHARS } from '../utils/ui-constants'
import { ConfirmationStep } from './publish-container/confirmation-step'
import { ErrorStep } from './publish-container/error-step'
import { PublishHeader } from './publish-container/header'
import { EmptyStatePanel, TooSmallPanel } from './publish-container/panels'
import { SelectionStep } from './publish-container/selection-step'
import { SuccessStep } from './publish-container/success-step'

import type { MultilineInputHandle } from './multiline-input'

interface PublishContainerProps {
  inputRef: React.MutableRefObject<MultilineInputHandle | null>
  onExitPublish?: () => void
  onPublish: (agentIds: string[]) => Promise<void>
  width: number
}

export const PublishContainer: React.FC<PublishContainerProps> = ({
  inputRef,
  onExitPublish,
  onPublish,
  width,
}) => {
  const theme = useTheme()
  const { width: widthLayout, height: heightLayout } = useTerminalLayout()
  const isTooSmall = widthLayout.atMost('xs') || heightLayout.atMost('xs')

  const {
    publishMode,
    selectedAgentIds,
    searchQuery,
    currentStep,
    focusedIndex,
    isPublishing,
    successResult,
    errorResult,
    includeDependents,
    toggleAgentSelection,
    setSearchQuery,
    goToConfirmation,
    goBackToSelection,
    setFocusedIndex,
    closePublish,
    setIncludeDependents,
  } = usePublishStore(
    useShallow((state) => ({
      publishMode: state.publishMode,
      selectedAgentIds: state.selectedAgentIds,
      searchQuery: state.searchQuery,
      currentStep: state.currentStep,
      focusedIndex: state.focusedIndex,
      isPublishing: state.isPublishing,
      successResult: state.successResult,
      errorResult: state.errorResult,
      includeDependents: state.includeDependents,
      toggleAgentSelection: state.toggleAgentSelection,
      setSearchQuery: state.setSearchQuery,
      goToConfirmation: state.goToConfirmation,
      goBackToSelection: state.goBackToSelection,
      setFocusedIndex: state.setFocusedIndex,
      closePublish: state.closePublish,
      setIncludeDependents: state.setIncludeDependents,
    })),
  )

  const inputFocused = useChatStore((state) => state.inputFocused)

  // Load agents data - filter out bundled agents (they shouldn't be publishable by users)
  const agents = useMemo(
    () => loadLocalAgents().filter((a) => !a.isBundled),
    [],
  )
  const agentDefinitions = useMemo(() => {
    const defs = loadAgentDefinitions()
    const map = new Map<string, { spawnableAgents?: string[] }>()
    for (const def of defs) {
      map.set(def.id, { spawnableAgents: def.spawnableAgents })
    }
    return map
  }, [])

  // Filter agents based on search
  const filteredAgents = useMemo(() => {
    if (!searchQuery.trim()) return agents
    const query = searchQuery.toLowerCase()
    return agents.filter(
      (agent) =>
        agent.displayName.toLowerCase().includes(query) ||
        agent.id.toLowerCase().includes(query),
    )
  }, [agents, searchQuery])

  // Get selected agents as LocalAgentInfo[]
  const selectedAgents = useMemo(() => {
    return agents.filter((a) => selectedAgentIds.has(a.id))
  }, [agents, selectedAgentIds])

  const canProceed = selectedAgentIds.size > 0

  // Handle keyboard navigation in checklist
  const handleSearchKeyIntercept = useCallback(
    (key: {
      name?: string
      sequence?: string
      shift?: boolean
      ctrl?: boolean
      meta?: boolean
      option?: boolean
    }) => {
      if (key.name === 'escape') {
        // Escape: clear input if there is any, otherwise exit publish mode
        if (searchQuery.length > 0) {
          setSearchQuery('')
        } else {
          closePublish()
          onExitPublish?.()
        }
        return true
      }
      if (key.name === 'up') {
        setFocusedIndex(Math.max(0, focusedIndex - 1))
        return true
      }
      if (key.name === 'down') {
        setFocusedIndex(Math.min(filteredAgents.length - 1, focusedIndex + 1))
        return true
      }
      if (isPlainEnterKey(key)) {
        // Enter: toggle selection
        const agent = filteredAgents[focusedIndex]
        if (agent) {
          toggleAgentSelection(agent.id)
        }
        return true
      }
      if (key.name === 'tab' && !key.shift) {
        // Tab: move to next button
        if (canProceed) {
          goToConfirmation()
        }
        return true
      }
      return false
    },
    [
      focusedIndex,
      filteredAgents,
      canProceed,
      searchQuery,
      setFocusedIndex,
      toggleAgentSelection,
      goToConfirmation,
      setSearchQuery,
      closePublish,
      onExitPublish,
    ],
  )

  const handleCancel = useCallback(() => {
    closePublish()
    onExitPublish?.()
  }, [closePublish, onExitPublish])

  const handleNext = useCallback(() => {
    if (canProceed) {
      goToConfirmation()
    }
  }, [canProceed, goToConfirmation])

  const handleBack = useCallback(() => {
    goBackToSelection()
  }, [goBackToSelection])

  // Compute the total count of agents to publish (for button label)
  const publishAgentIds = useMemo(
    () =>
      getAllPublishAgentIds(
        selectedAgents,
        agents,
        agentDefinitions,
        includeDependents,
      ),
    [selectedAgents, agents, agentDefinitions, includeDependents],
  )

  const handlePublish = useCallback(async () => {
    await onPublish(publishAgentIds)
  }, [publishAgentIds, onPublish])

  useEffect(() => {
    if (publishMode && inputRef.current && currentStep === 'selection') {
      inputRef.current.focus()
    }
  }, [publishMode, inputRef, currentStep])

  // Handle escape key on non-selection screens
  useEffect(() => {
    if (!publishMode || currentStep === 'selection') return

    // Use process.stdin for terminal key handling
    if (typeof process !== 'undefined' && process.stdin) {
      const stdin = process.stdin
      const onData = (data: Buffer) => {
        // ESC key is 0x1b
        if (data[0] === 0x1b && data.length === 1) {
          handleCancel()
        }
      }
      stdin.on('data', onData)
      return () => {
        stdin.off('data', onData)
      }
    }
    return undefined
  }, [publishMode, currentStep, handleCancel])

  if (!publishMode) {
    return null
  }

  // Terminal too small - show placeholder
  if (isTooSmall) {
    return <TooSmallPanel onCancel={handleCancel} />
  }

  // Empty state - no agents found
  if (agents.length === 0) {
    return <EmptyStatePanel onCancel={handleCancel} />
  }

  return (
    <box
      border
      borderStyle="single"
      borderColor={theme.info}
      customBorderChars={BORDER_CHARS}
      style={{
        flexDirection: 'column',
        gap: 0,
        paddingLeft: 1,
        paddingRight: 1,
        paddingTop: 0,
        paddingBottom: 0,
      }}
    >
      <PublishHeader
        currentStep={currentStep}
        selectedAgentCount={selectedAgents.length}
        onCancel={handleCancel}
      />

      {currentStep === 'selection' && (
        <SelectionStep
          width={width}
          inputRef={inputRef}
          inputFocused={inputFocused}
          agents={agents}
          filteredAgents={filteredAgents}
          selectedIds={selectedAgentIds}
          selectedAgents={selectedAgents}
          agentDefinitions={agentDefinitions}
          focusedIndex={focusedIndex}
          canProceed={canProceed}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onToggleAgent={toggleAgentSelection}
          onFocusChange={setFocusedIndex}
          onKeyIntercept={handleSearchKeyIntercept}
          onNext={handleNext}
        />
      )}

      {currentStep === 'confirmation' && (
        <ConfirmationStep
          width={width}
          selectedAgents={selectedAgents}
          agents={agents}
          agentDefinitions={agentDefinitions}
          includeDependents={includeDependents}
          isPublishing={isPublishing}
          publishAgentCount={publishAgentIds.length}
          onToggleDependents={() => setIncludeDependents(!includeDependents)}
          onBack={handleBack}
          onPublish={handlePublish}
        />
      )}

      {currentStep === 'success' && successResult && (
        <SuccessStep
          width={width}
          successResult={successResult}
          onDone={handleCancel}
        />
      )}

      {currentStep === 'error' && errorResult && (
        <ErrorStep
          width={width}
          errorResult={errorResult}
          onBack={handleBack}
          onClose={handleCancel}
        />
      )}
    </box>
  )
}
