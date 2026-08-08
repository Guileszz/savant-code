import {
  FALLBACK_SAVANT_FREE_MODEL_ID,
  SAVANT_FREE_PREMIUM_SESSION_LIMIT,
  getSavantFreeDeploymentAvailabilityLabel,
  getSavantFreeModelsForAccessTier,
  getRecommendedSavantFreeModelId,
  isSavantFreeGlmV52ModelId,
  isSavantFreeModelAvailable,
  isSavantFreePremiumModelId,
} from '@savant-code/common/constants/savant-free-models'
import {
  getRateLimitsByModel,
  getReferralInfo,
} from '@savant-code/common/types/savant-free-session'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  TOGGLE_ID,
  computeSelectorLayout,
  estimateSelectorHeight,
} from './layout'
import { useModelSelectorKeyboard } from './use-keyboard-nav'
import { useNow } from '../../hooks/use-now'
import { startSavantFreeSession } from '../../hooks/use-savant-free-session'
import { useTerminalDimensions } from '../../hooks/use-terminal-dimensions'
import { useSavantFreeModelStore } from '../../state/savant-free-model-store'
import { useSavantFreeSessionStore } from '../../state/savant-free-session-store'
import {
  formatSavantFreePremiumResetCountdown,
  getSavantFreePremiumResetAt,
} from '../../utils/savant-free-premium-reset'

import type { Section } from './layout'
import type { SavantFreeReferralFocusTarget } from '../savant-free-referral-banner'
import type { BoxRenderable, ScrollBoxRenderable } from '@opentui/core'
import type {
  SavantFreeAccessTier,
  SavantFreeModel,
} from '@savant-code/common/constants/savant-free-models'

/** Everything the render path needs, computed from session state + the
 *  terminal's width budget. The picker component stays a thin presentational
 *  shell; all state, effects, and callbacks live here. */
export interface ModelSelectorState {
  accessTier: SavantFreeAccessTier
  deploymentAvailabilityLabel: string
  pending: string | null
  hoveredId: string | null
  setHoveredId: React.Dispatch<React.SetStateAction<string | null>>
  availableModels: readonly SavantFreeModel[]
  recommendedModel: SavantFreeModel
  canCollapse: boolean
  expanded: boolean
  focusedId: string
  setFocusedId: React.Dispatch<React.SetStateAction<string>>
  extraTargets: readonly SavantFreeReferralFocusTarget[]
  setExtraTargets: React.Dispatch<
    React.SetStateAction<SavantFreeReferralFocusTarget[]>
  >
  sections: readonly Section[]
  navIds: readonly string[]
  committedModelId: string | null
  referral: ReturnType<typeof getReferralInfo>
  premiumUsed: number
  premiumExhausted: boolean
  premiumResetCountdown: string | null
  wrapDetails: boolean
  buttonOuterWidth: number
  nameColumnWidth: number
  recommendedOneLineLen: number
  contentHeight: number
  needsScroll: boolean
  scrollViewportHeight: number
  scrollRef: React.MutableRefObject<ScrollBoxRenderable | null>
  contentRef: React.MutableRefObject<BoxRenderable | null>
  syncContentHeight: () => void
  isJoinable: (modelId: string) => boolean
  pick: (modelId: string) => void
  toggleExpanded: () => void
}

export function useModelSelectorState(opts: {
  maxHeight: number
  onExpandedChange?: (expanded: boolean) => void
}): ModelSelectorState {
  const { maxHeight, onExpandedChange } = opts
  // contentMaxWidth (capped at 80 cols by the landing screen) is the real
  // budget — not terminalWidth.
  const { contentMaxWidth } = useTerminalDimensions()
  const selectedModel = useSavantFreeModelStore((s) => s.selectedModel)
  const setSelectedModel = useSavantFreeModelStore((s) => s.setSelectedModel)
  const session = useSavantFreeSessionStore((s) => s.session)
  const accessTier: SavantFreeAccessTier =
    (session && 'accessTier' in session ? session.accessTier : undefined) ??
    'full'
  const now = useNow(60_000)
  const deploymentAvailabilityLabel = useMemo(
    () => getSavantFreeDeploymentAvailabilityLabel(new Date(now)),
    [now],
  )
  const [pending, setPending] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const availableModels = useMemo(
    // GLM 5.2 is a referral reward, not a freely-pickable model, so it's
    // surfaced by the separate SavantFreeReferralBanner rather than this grid.
    () =>
      getSavantFreeModelsForAccessTier(accessTier).filter(
        (m) => !isSavantFreeGlmV52ModelId(m.id),
      ),
    [accessTier],
  )
  const recommendedModel = useMemo(() => {
    const id = getRecommendedSavantFreeModelId(accessTier)
    return availableModels.find((m) => m.id === id) ?? availableModels[0]!
  }, [accessTier, availableModels])
  const otherModels = useMemo(
    () => availableModels.filter((m) => m.id !== recommendedModel.id),
    [availableModels, recommendedModel],
  )
  // Only worth collapsing when the toggle actually hides something. With a
  // single "other" model (limited tier) we just show both — a "see 1 more
  // model" toggle is noise.
  const canCollapse = otherModels.length >= 2

  // Collapsed by default only on the landing screen and only when the
  // saved/active selection IS the recommended model — a returning user with a
  // different preference gets the expanded list so their pick is visible.
  const isLanding = session?.status === 'none' || !session
  const [expanded, setExpanded] = useState(
    () => !canCollapse || !isLanding || selectedModel !== recommendedModel.id,
  )
  // Mirror expansion up to the landing screen (collapsed → full ASCII logo).
  useLayoutEffect(() => {
    onExpandedChange?.(expanded)
  }, [expanded, onExpandedChange])

  // Keyboard cursor — separate from the selected model so Tab/arrow can
  // preview without committing. Starts on the saved/active pick.
  const [focusedId, setFocusedId] = useState<string>(() => selectedModel)

  // The referral banner contributes its GLM/copy actions to the navigation
  // order; kept local to avoid a global focus bridge.
  const [extraTargets, setExtraTargets] = useState<
    SavantFreeReferralFocusTarget[]
  >([])
  const extraTargetIds = useMemo(
    () => extraTargets.map((t) => t.id),
    [extraTargets],
  )
  const contentRef = useRef<BoxRenderable | null>(null)
  const [measuredContentHeight, setMeasuredContentHeight] = useState<
    number | null
  >(null)
  const syncContentHeight = useCallback(() => {
    const nextHeight = contentRef.current?.height
    if (!nextHeight) return
    setMeasuredContentHeight((current) =>
      current === nextHeight ? current : nextHeight,
    )
  }, [])
  const sections = useMemo(() => {
    if (!expanded) return [] as readonly Section[]
    if (accessTier === 'limited') {
      return [
        { key: 'limited', label: '', models: otherModels },
      ] satisfies readonly Section[]
    }
    return (
      [
        {
          key: 'premium',
          label: 'PREMIUM',
          models: otherModels.filter((m) => isSavantFreePremiumModelId(m.id)),
        },
        {
          key: 'unlimited',
          label: 'UNLIMITED',
          models: otherModels.filter((m) => !isSavantFreePremiumModelId(m.id)),
        },
      ] satisfies readonly Section[]
    ).filter((section) => section.models.length > 0)
  }, [expanded, accessTier, otherModels])

  // Model rows in render order: recommended hero first, then the grouped rest.
  const renderedModelIds = useMemo(
    () => [
      recommendedModel.id,
      ...sections.flatMap((section) => section.models.map((m) => m.id)),
    ],
    [recommendedModel, sections],
  )
  // Keyboard-navigable ids: the model rows, then the toggle, then any focus
  // targets the referral banner registered (so arrowing down past "see all
  // models" reaches its buttons; nextSavantFreeModelId wraps back to the top).
  const navIds = useMemo(
    () => [
      ...renderedModelIds,
      ...(canCollapse ? [TOGGLE_ID] : []),
      ...extraTargetIds,
    ],
    [canCollapse, renderedModelIds, extraTargetIds],
  )

  // Keep focus valid as the list expands/collapses or the selection changes
  // server-side; only an out-of-range focus snaps back to the selection.
  useEffect(() => {
    setFocusedId((curr) =>
      navIds.includes(curr)
        ? curr
        : navIds.includes(selectedModel)
          ? selectedModel
          : navIds[0]!,
    )
  }, [navIds, selectedModel])

  useEffect(() => {
    // Landing-screen safety net: if the in-memory selection becomes
    // unavailable (e.g. deployment hours close while the picker is open),
    // swap to the always-available fallback so Enter doesn't POST a model
    // the server will immediately reject. In-memory only — the user's saved
    // preference (e.g. Kimi or DeepSeek) is preserved for the next launch.
    if (
      (session?.status === 'none' || !session) &&
      (!renderedModelIds.includes(selectedModel) ||
        !isSavantFreeModelAvailable(selectedModel, new Date(now)))
    ) {
      setSelectedModel(renderedModelIds[0] ?? FALLBACK_SAVANT_FREE_MODEL_ID)
    }
  }, [renderedModelIds, now, selectedModel, session, setSelectedModel])

  // Never a queued model: re-picking is always meaningful.
  const committedModelId: string | null = null
  const rateLimitsByModel = getRateLimitsByModel(session)
  const referral = getReferralInfo(session)

  // Premium quota surfaced on the PREMIUM header: "N of M used · resets in …".
  // All premium models share one pool; any entry has the right count. The pool
  // resets on a Pacific-day boundary, so the countdown shows even at zero used.
  const sharedRateLimit = rateLimitsByModel
    ? Object.values(rateLimitsByModel)[0]
    : undefined
  const premiumUsed = sharedRateLimit?.recentCount ?? 0
  const premiumExhausted = premiumUsed >= SAVANT_FREE_PREMIUM_SESSION_LIMIT
  const premiumResetCountdown = formatSavantFreePremiumResetCountdown(
    getSavantFreePremiumResetAt({ rateLimitsByModel, nowMs: now }),
    now,
  )

  const {
    wrapDetails,
    buttonOuterWidth,
    nameColumnWidth,
    recommendedOneLineLen,
  } = useMemo(
    () =>
      computeSelectorLayout({
        availableModels,
        contentMaxWidth,
        deploymentAvailabilityLabel,
        recommendedModel,
      }),
    [
      availableModels,
      contentMaxWidth,
      deploymentAvailabilityLabel,
      recommendedModel,
    ],
  )

  const estimatedModelHeight = useMemo(
    () =>
      estimateSelectorHeight({
        recommendedModel,
        sections,
        canCollapse,
        wrapDetails,
      }),
    [sections, wrapDetails, recommendedModel, canCollapse],
  )

  // With a referral, start at the full allowance until the wrapper reports
  // its intrinsic height (conservative, cannot clip wrapped copy).
  const contentHeight =
    measuredContentHeight ?? (referral ? maxHeight : estimatedModelHeight)

  const needsScroll = contentHeight > maxHeight
  const scrollViewportHeight = Math.max(1, Math.min(contentHeight, maxHeight))
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)

  // Keep the focused element inside the viewport while arrowing through a
  // taller list; reset stale offsets when a resize makes everything fit.
  useLayoutEffect(() => {
    const sb = scrollRef.current
    if (!sb) return
    if (!needsScroll) {
      sb.scrollTop = 0
      return
    }
    sb.scrollChildIntoView(focusedId)
    // When the final referral action is focused, reveal the measured bottom.
    if (focusedId === extraTargetIds.at(-1)) {
      sb.scrollTop = Math.max(0, sb.scrollHeight - sb.viewport.height)
    }
  }, [focusedId, contentHeight, needsScroll, extraTargetIds])

  const isJoinable = useCallback(
    (modelId: string) => {
      if (!isSavantFreeModelAvailable(modelId, new Date(now))) return false
      const rateLimit = rateLimitsByModel?.[modelId]
      return !rateLimit || rateLimit.recentCount < rateLimit.limit
    },
    [now, rateLimitsByModel],
  )

  const pick = useCallback(
    (modelId: string) => {
      if (pending) return
      if (modelId === committedModelId) return
      if (!isJoinable(modelId)) return
      setPending(modelId)
      startSavantFreeSession(modelId).finally(() => setPending(null))
    },
    [pending, committedModelId, isJoinable],
  )

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev
      // After revealing the list, drop focus onto the first newly-shown row so
      // the next arrow press walks into it; after collapsing, return to the
      // hero so Enter starts.
      setFocusedId(
        next
          ? (otherModels[0]?.id ?? recommendedModel.id)
          : recommendedModel.id,
      )
      return next
    })
  }, [otherModels, recommendedModel])

  // Tab/arrows move the highlight only; Enter/Space commits or fires toggle.
  useModelSelectorKeyboard({
    pending,
    focusedId,
    committedModelId,
    navIds,
    extraTargets,
    isJoinable,
    onPick: pick,
    onFocus: setFocusedId,
    onToggle: toggleExpanded,
  })

  return {
    accessTier,
    deploymentAvailabilityLabel,
    pending,
    hoveredId,
    setHoveredId,
    availableModels,
    recommendedModel,
    canCollapse,
    expanded,
    focusedId,
    setFocusedId,
    extraTargets,
    setExtraTargets,
    sections,
    navIds,
    committedModelId,
    referral,
    premiumUsed,
    premiumExhausted,
    premiumResetCountdown,
    wrapDetails,
    buttonOuterWidth,
    nameColumnWidth,
    recommendedOneLineLen,
    contentHeight,
    needsScroll,
    scrollViewportHeight,
    scrollRef,
    contentRef,
    syncContentHeight,
    isJoinable,
    pick,
    toggleExpanded,
  }
}
