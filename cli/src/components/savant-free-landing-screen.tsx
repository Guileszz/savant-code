import { TextAttributes } from '@opentui/core'
import { useRenderer } from '@opentui/react'
import {
  SAVANT_FREE_ENABLE_STREAK_IN_UI,
  SAVANT_FREE_LIMITED_SESSION_LIMIT,
  SAVANT_FREE_PREMIUM_SESSION_LIMIT,
} from '@savant-code/common/constants/savant-free-models'
import {
  getRateLimitsByModel,
  getReferralInfo,
} from '@savant-code/common/types/savant-free-session'
import React, { useEffect, useState } from 'react'

import { ChoiceAdBanner, AD_CARD_HEIGHT } from './ad-banner'
import { Button } from './button'
import { SavantFreeModelSelector } from './savant-free-model-selector'
import { useGravityAd } from '../hooks/use-gravity-ad'
import { useLogo } from '../hooks/use-logo'
import { useNow } from '../hooks/use-now'
import { useSavantFreeCtrlCExit } from '../hooks/use-savant-free-ctrl-c-exit'
import { refreshSavantFreeLandingMetadata } from '../hooks/use-savant-free-session'
import { useSavantFreeStreakQuery } from '../hooks/use-savant-free-streak-query'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { formatSessionUnits } from '../utils/format-session-units'
import { exitSavantFreeCleanly } from '../utils/savant-free-exit'
import {
  formatSavantFreePremiumResetCountdown,
  getSavantFreePremiumResetAt,
} from '../utils/savant-free-premium-reset'
import { getSavantFreeStreakBonusNote } from '../utils/savant-free-streak-line'
import { getLogoAccentColor, getLogoBlockColor } from '../utils/theme-system'
import {
  LANDING_HEADING,
  getLimitedModeNotice,
} from './savant-free-landing-screen/format'
import { computeLandingLayout } from './savant-free-landing-screen/layout'
import {
  BannedPanel,
  CountryBlockedPanel,
  RateLimitedPanel,
} from './savant-free-landing-screen/status-panels'
import { StreakInlineLine } from './savant-free-landing-screen/streak-line'
import { TakeoverPrompt } from './savant-free-landing-screen/takeover-prompt'

import type { SavantFreeSession } from '../types/savant-free-session'

interface SavantFreeLandingScreenProps {
  session: SavantFreeSession | null
  error: string | null
}

export const SavantFreeLandingScreen: React.FC<
  SavantFreeLandingScreenProps
> = ({ session, error }) => {
  const theme = useTheme()
  useRenderer()
  const { terminalWidth, terminalHeight, contentMaxWidth } =
    useTerminalDimensions()
  // Progressive disclosure as the terminal gets shorter (picker must always
  // fit): tall >=40 full 6-line ASCII logo, medium >=20 one-line wordmark,
  // short <20 no logo, tiny <18 also drop the ad banner. Exception: a
  // collapsed referral-free picker shrinks to ~5 rows, so on mid-height
  // windows the wordmark is promoted back to the full logo (fills dead space
  // above the card); a referral card or expanded list keeps the compact
  // wordmark and gives those rows back to the scrollable menu. The picker
  // owns this and reports it via onExpandedChange.
  const [selectorExpanded, setSelectorExpanded] = useState(false)
  const COLLAPSED_LOGO_MIN_HEIGHT = 26
  const hasReferralMenu =
    session?.status === 'none' && Boolean(getReferralInfo(session))
  const fullLogoFits =
    terminalHeight >= 40 ||
    (!selectorExpanded &&
      !hasReferralMenu &&
      terminalHeight >= COLLAPSED_LOGO_MIN_HEIGHT)
  const logoMode: 'full' | 'text' | 'none' = fullLogoFits
    ? 'full'
    : terminalHeight >= 20
      ? 'text'
      : 'none'
  const compact = terminalHeight < 22
  const showAds = terminalHeight >= 18
  const logoLines = logoMode === 'full' ? 6 : logoMode === 'text' ? 1 : 0
  const blockColor = getLogoBlockColor(theme.name)
  const accentColor = getLogoAccentColor(theme.name)
  const { component: logoComponent } = useLogo({
    availableWidth: contentMaxWidth,
    accentColor,
    blockColor,
    // No applySheenToChar — static logo, no animation
    // 'text' forces the one-line variant; 'none' is handled by not rendering.
    maxHeight: logoMode === 'full' ? undefined : 1,
  })
  // Ads always on here (monetization lives here); forceStart bypasses the
  // "wait for first user message" gate. Server tries Gravity first.
  const { ads, recordClick, recordImpression } = useGravityAd({
    enabled: true,
    forceStart: true,
    provider: 'gravity',
    // Legacy wire name for this surface — the ads API maps it to placements,
    // so it must not change with the component rename.
    surface: 'waiting_room',
  })
  useSavantFreeCtrlCExit()
  const [exitHover, setExitHover] = useState(false)
  const accessTier =
    session && 'accessTier' in session ? session.accessTier : 'full'
  // Hidden in compact terminals: the notice is nice-to-have context, and
  // below 22 rows every line competes with the picker itself.
  const limitedModeNotice =
    accessTier === 'limited' && !compact ? getLimitedModeNotice(session) : null
  // 'none' = user hasn't started a session yet. We're in the pre-chat landing
  // state: show the picker with a prompt. Picking a model triggers
  // startSavantFreeSession, which POSTs and transitions straight to 'active' (chat).
  const isLanding = session?.status === 'none'
  const streakQuery = useSavantFreeStreakQuery({
    enabled: SAVANT_FREE_ENABLE_STREAK_IN_UI && isLanding,
  })
  const streak = streakQuery.data?.streak ?? 0
  // Reserve the streak row whenever the feature could appear so the picker
  // doesn't jump when the query resolves or the user crosses from 0 → 1.
  // The component itself renders blank space when streak === 0.
  const reserveStreakSlot =
    SAVANT_FREE_ENABLE_STREAK_IN_UI && isLanding && !compact
  // Once a full week is earned, explain the recurring perk under the picker so
  // the streak reads as worth keeping. Accuracy lives in getSavantFreeStreakBonusNote
  // (daily session bonus, weekly GLM, GLM only for full access).
  const streakBonusNote = reserveStreakSlot
    ? getSavantFreeStreakBonusNote({
        streak,
        accessTier: accessTier === 'limited' ? 'limited' : 'full',
      })
    : null
  // On the landing screen the streak rides on the heading row, right-aligned.
  // Below ~50 cols the heading + dots get squashed together, so drop the streak
  // to its own line under the heading instead.
  const STREAK_INLINE_MIN_WIDTH = 50
  const streakOnHeadingRow =
    reserveStreakSlot && isLanding && contentMaxWidth >= STREAK_INLINE_MIN_WIDTH
  // On the landing picker we tick once a minute so the session reset countdown
  // stays fresh.
  const now = useNow(60000, isLanding)
  // Free-session quota counter for the title line. All free models share one
  // pool; the server replicates the same snapshot under each free model
  // id, so any entry has the right count. Renders amber when exhausted so
  // the limit reads as "you've hit it" rather than just another count.
  const rateLimitsByModel = getRateLimitsByModel(session)
  const sessionRateLimit = rateLimitsByModel
    ? Object.values(rateLimitsByModel)[0]
    : undefined
  const sharedSessionUsed = sessionRateLimit?.recentCount ?? 0
  // Hide the "0 of N used" line for a fresh user — noise on the landing
  // screen. Regular tiers carry the quota inline in the PREMIUM section header,
  // so the below-picker line survives only for the limited tier.
  const showSessionCounter = sharedSessionUsed > 0
  const showBelowPickerCounter = showSessionCounter && accessTier === 'limited'
  const isSessionExhausted =
    sharedSessionUsed >=
    (accessTier === 'limited'
      ? SAVANT_FREE_LIMITED_SESSION_LIMIT
      : SAVANT_FREE_PREMIUM_SESSION_LIMIT)
  const sessionUsedColor = isSessionExhausted ? theme.secondary : theme.muted
  const sessionLimit =
    accessTier === 'limited'
      ? SAVANT_FREE_LIMITED_SESSION_LIMIT
      : SAVANT_FREE_PREMIUM_SESSION_LIMIT
  const sessionLabel =
    accessTier === 'limited' ? 'sessions' : 'premium sessions'
  const formattedSharedSessionUsed = formatSessionUnits(sharedSessionUsed)
  const sessionResetAt = getSavantFreePremiumResetAt({
    rateLimitsByModel,
    nowMs: now,
  })
  const sessionResetAtMs = sessionResetAt.getTime()
  const sessionResetCountdown = formatSavantFreePremiumResetCountdown(
    sessionResetAt,
    now,
  )
  const counterText =
    `${formattedSharedSessionUsed} of ${sessionLimit} ${sessionLabel} used, ` +
    `resets in ${sessionResetCountdown}`
  const { selectorMaxHeight } = computeLandingLayout({
    terminalHeight,
    contentMaxWidth,
    logoMode,
    logoLines,
    showAds,
    showBelowPickerCounter,
    counterText,
    limitedModeNotice,
    streakBonusNote,
    reserveStreakSlot,
    streakOnHeadingRow,
  })
  useEffect(() => {
    if (!isLanding || !sessionRateLimit) return
    const delayMs = Math.max(0, sessionResetAtMs - Date.now() + 1000)
    const timer = setTimeout(() => {
      refreshSavantFreeLandingMetadata().catch(() => {})
    }, delayMs)
    return () => clearTimeout(timer)
  }, [isLanding, sessionRateLimit, sessionResetAtMs])
  return (
    <box
      style={{
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        backgroundColor: theme.background,
      }}
    >
      {/* Top-right exit affordance for mouse users; width '100%' is required
            for justifyContent to push the X right. */}
      <box
        style={{
          width: '100%',
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingTop: 1,
          paddingLeft: 2,
          paddingRight: 2,
          flexShrink: 0,
        }}
      >
        {/* Empty spacer: justifyContent space-between needs a left sibling to
            keep the ✕ pushed to the right. */}
        <box />
        <Button
          onClick={exitSavantFreeCleanly}
          onMouseOver={() => setExitHover(true)}
          onMouseOut={() => setExitHover(false)}
          style={{ paddingLeft: 1, paddingRight: 1 }}
        >
          <text
            style={{ fg: exitHover ? theme.foreground : theme.muted }}
            attributes={TextAttributes.BOLD}
          >
            ✕
          </text>
        </Button>
      </box>

      <box
        style={{
          flexGrow: 1,
          flexDirection: 'column',
          alignItems: 'center',
          // Full logo: anchor the clump low (flex-end), matching how chat pins
          // its header/messages to the input bar. Text wordmark: center the
          // clump so a short (collapsed) picker reads as a balanced card instead
          // of leaving a void above the ad. No logo (tiny terminals): hug the
          // top, since the content nearly fills the height anyway and centering
          // would just shave rows off the top.
          justifyContent:
            logoMode === 'full'
              ? 'flex-end'
              : logoMode === 'text'
                ? 'center'
                : 'flex-start',
          paddingLeft: 2,
          paddingRight: 2,
          // A row of breathing room under the top bar for the text logo; the
          // full logo brings its own spacing and the tiniest (no-logo) screens
          // can't spare the row.
          paddingTop: logoMode === 'text' ? 1 : 0,
          paddingBottom: 1,
          gap: logoMode === 'full' ? 1 : 0,
        }}
      >
        {logoMode !== 'none' && (
          <box style={{ marginBottom: 1, flexShrink: 0 }}>{logoComponent}</box>
        )}

        <box
          style={{
            flexDirection: 'column',
            alignItems: 'center',
            gap: 0,
            maxWidth: contentMaxWidth,
          }}
        >
          {error && (!session || session.status === 'none') && (
            <text style={{ fg: theme.secondary, wrapMode: 'word' }}>
              ⚠ {error}
            </text>
          )}

          {!session && !error && (
            <text style={{ fg: theme.muted }}>Connecting...</text>
          )}

          {isLanding && (
            <box
              style={{
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 0,
              }}
            >
              <box
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  alignSelf: 'stretch',
                  marginBottom: 1,
                }}
              >
                <text style={{ wrapMode: 'word' }}>
                  <span fg={theme.foreground} attributes={TextAttributes.BOLD}>
                    {LANDING_HEADING}
                  </span>
                </text>
                {streakOnHeadingRow && (
                  <StreakInlineLine streak={streak} marginTop={0} />
                )}
              </box>
              {reserveStreakSlot && !streakOnHeadingRow && (
                <StreakInlineLine streak={streak} marginTop={0} />
              )}
              <SavantFreeModelSelector
                maxHeight={selectorMaxHeight}
                onExpandedChange={setSelectorExpanded}
              />
              {showBelowPickerCounter && (
                <text
                  style={{
                    fg: theme.muted,
                    marginTop: 1,
                    wrapMode: 'word',
                  }}
                >
                  <span fg={sessionUsedColor}>
                    {formattedSharedSessionUsed} of {sessionLimit}{' '}
                    {sessionLabel} used
                  </span>
                  <span fg={theme.muted}>
                    {', '}
                    resets in {sessionResetCountdown}
                  </span>
                </text>
              )}
              {limitedModeNotice && (
                <text
                  style={{ fg: theme.muted, wrapMode: 'word', marginTop: 1 }}
                >
                  {limitedModeNotice}
                </text>
              )}
              {streakBonusNote && (
                <text
                  style={{ fg: theme.primary, wrapMode: 'word', marginTop: 1 }}
                >
                  {streakBonusNote}
                </text>
              )}
            </box>
          )}

          {session?.status === 'takeover_prompt' && <TakeoverPrompt />}

          {session?.status === 'country_blocked' && (
            <CountryBlockedPanel session={session} />
          )}

          {session?.status === 'banned' && <BannedPanel />}

          {session?.status === 'rate_limited' && (
            <RateLimitedPanel session={session} />
          )}
        </box>
      </box>

      {/* Reserve the ad slot before the async fetch resolves so content does
            not jump when the banner fills; dropped on very short terminals. */}
      {showAds && (
        <box
          style={{
            width: '100%',
            flexShrink: 0,
            height: AD_CARD_HEIGHT,
          }}
        >
          {ads ? (
            <ChoiceAdBanner
              ads={ads}
              onClick={recordClick}
              onImpression={recordImpression}
            />
          ) : (
            <text style={{ fg: theme.muted }}>{'─'.repeat(terminalWidth)}</text>
          )}
        </box>
      )}
    </box>
  )
}
