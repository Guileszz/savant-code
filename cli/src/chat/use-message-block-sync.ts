/**
 * Message-block store sync for the chat screen (FID-2026-0805-003). Extracted
 * from chat.tsx verbatim: pushes the render context (theme, message tree,
 * ads) and the stable callback set into the message-block zustand store.
 */

import { useEffect, useLayoutEffect } from 'react'

import { useMessageBlockStore } from '../state/message-block-store'

import type { useChatMessages } from '../hooks/use-chat-messages'
import type { useChatUI } from '../hooks/use-chat-ui'
import type { AdResponse } from '../hooks/use-gravity-ad'
import type { ChatTheme } from '../types/theme-system'
import type { FeedbackCategory } from '@savant-code/common/constants/feedback'

export interface UseMessageBlockSyncArgs {
  theme: ChatTheme
  markdownPalette: ReturnType<typeof useChatUI>['markdownPalette']
  messageTree: ReturnType<typeof useChatMessages>['messageTree']
  isWaitingForResponse: boolean
  timerStartTime: number | null
  messageAvailableWidth: number
  responseAds: Record<string, AdResponse[]>
  showInlineAds: boolean
  handleCollapseToggle: (messageId: string) => void
  handleBuildFast: () => void
  handleBuildMax: () => void
  handleBuildLite: () => void
  handleMessageFeedback: (
    id: string,
    options?: {
      category?: FeedbackCategory
      footerMessage?: string
      errors?: Array<{ id: string; message: string }>
    },
  ) => void
  handleCloseFeedback: () => void
  handleAdClick: (ad: AdResponse) => void
  handleAdImpression: (ad: AdResponse) => void
  handleResponseAdsNeeded: (messageId: string, count: number) => void
}

export function useMessageBlockSync({
  theme,
  markdownPalette,
  messageTree,
  isWaitingForResponse,
  timerStartTime,
  messageAvailableWidth,
  responseAds,
  showInlineAds,
  handleCollapseToggle,
  handleBuildFast,
  handleBuildMax,
  handleBuildLite,
  handleMessageFeedback,
  handleCloseFeedback,
  handleAdClick,
  handleAdImpression,
  handleResponseAdsNeeded,
}: UseMessageBlockSyncArgs): void {
  const setMessageBlockContext = useMessageBlockStore(
    (state) => state.setContext,
  )
  const setMessageBlockCallbacks = useMessageBlockStore(
    (state) => state.setCallbacks,
  )

  // Update context when values change - useLayoutEffect ensures synchronous updates
  // to prevent message loss during rapid streaming (race condition fix)
  useLayoutEffect(() => {
    setMessageBlockContext({
      theme,
      markdownPalette,
      messageTree,
      isWaitingForResponse,
      timerStartTime,
      availableWidth: messageAvailableWidth,
      responseAds: showInlineAds ? responseAds : {},
    })
  }, [
    theme,
    markdownPalette,
    messageTree,
    isWaitingForResponse,
    timerStartTime,
    messageAvailableWidth,
    responseAds,
    showInlineAds,
    setMessageBlockContext,
  ])

  // Update callbacks once (they're stable)
  useEffect(() => {
    setMessageBlockCallbacks({
      onToggleCollapsed: handleCollapseToggle,
      onBuildFast: handleBuildFast,
      onBuildMax: handleBuildMax,
      onBuildLite: handleBuildLite,
      onFeedback: handleMessageFeedback,
      onCloseFeedback: handleCloseFeedback,
      onAdClick: handleAdClick,
      onAdImpression: handleAdImpression,
      onResponseAdsNeeded: handleResponseAdsNeeded,
    })
  }, [
    handleCollapseToggle,
    handleBuildFast,
    handleBuildMax,
    handleBuildLite,
    handleMessageFeedback,
    handleCloseFeedback,
    handleAdClick,
    handleAdImpression,
    handleResponseAdsNeeded,
    setMessageBlockCallbacks,
  ])
}
