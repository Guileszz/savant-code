/**
 * Main orchestration for the context-pruner handleSteps generator (extracted
 * verbatim from the original in-body implementation). Calls the extracted
 * Phase 1 (summarizeMessages) and Phase 2+3 (applyBudgets) modules.
 * Embedded via .toString() at factory time; the constants/helpers it
 * references are baked/embedded into the same generated scope.
 */
import { applyBudgets } from './apply-budgets'
import {
  ASSISTANT_TOOL_BUDGET,
  CHARS_PER_TOKEN,
  FIXED_TAIL_BUDGET_TOKENS,
  SUMMARY_DISCLAIMER,
  SUMMARY_HEADER,
  TOKEN_COUNT_FUDGE_FACTOR,
  USER_BUDGET,
} from './constants'
import { asNumber, getTextContent } from './helpers'
import {
  buildPreservedState,
  extractPreservedState,
  mergePreservedState,
  serializePreservedState,
} from './preserved-state'
import {
  buildStructuredSummary,
  findFirstUserTurnText,
} from './structured-summary'
import { summarizeMessages } from './summarize-messages'
import {
  extractSummaryContent,
  isConversationSummary,
  parseSummaryIntoEntries,
  shouldExcludeMessage,
} from './summary-parsing'
import {
  buildFoldTelemetryBase,
  logCompletion,
  logFoldCompleted,
  logFoldNoop,
  logPostCompact,
} from './telemetry'

import type { SummaryEntry } from './summarize-messages'
import type { AgentState, ToolCall } from '../types/agent-definition'
import type {
  FilePart,
  ImagePart,
  JSONValue,
  Logger,
  Message,
  TextPart,
  UserMessage,
} from '../types/util-types'

export function* runContextPrunerMain(
  agentState: AgentState,
  params: Record<string, JSONValue> | undefined,
  logger: Logger,
) {
  const p = params ?? {}

  /** Prompt cache expiry time (Anthropic caches for 5 minutes by default) */
  const CACHE_EXPIRY_MS: number = asNumber(p.cacheExpiryMs) ?? 5 * 60 * 1000

  const messages = agentState.messageHistory
  const maxContextLength: number = asNumber(p.maxContextLength) ?? 200_000

  // STEP 0: Always remove the last INSTRUCTIONS_PROMPT and SUBAGENT_SPAWN
  // (these are inserted for the context-pruner subagent itself)
  let currentMessages = [...messages]
  const lastInstructionsPromptIndex = currentMessages.findLastIndex((message) =>
    message.tags?.includes('INSTRUCTIONS_PROMPT'),
  )
  if (lastInstructionsPromptIndex !== -1) {
    currentMessages.splice(lastInstructionsPromptIndex, 1)
  }
  const lastSubagentSpawnIndex = currentMessages.findLastIndex((message) =>
    message.tags?.includes('SUBAGENT_SPAWN'),
  )
  if (lastSubagentSpawnIndex !== -1) {
    currentMessages.splice(lastSubagentSpawnIndex, 1)
  }

  // Also remove the params USER_PROMPT if params were provided to this agent
  // (this is the message like <user_message>{"cacheExpiryMs": 600000}</user_message>)
  if (params && Object.keys(params).length > 0) {
    const lastUserPromptIndex = currentMessages.findLastIndex((message) =>
      message.tags?.includes('USER_PROMPT'),
    )
    if (lastUserPromptIndex !== -1) {
      currentMessages.splice(lastUserPromptIndex, 1)
    }
  }

  // Check for prompt cache miss (>5 min gap before the USER_PROMPT message)
  // The USER_PROMPT is the actual user message; INSTRUCTIONS_PROMPT comes after it
  // We need to find the USER_PROMPT and check the gap between it and the last assistant message
  let cacheWillMiss = false
  let cacheGapMs: number | null = null
  const userPromptIndex = currentMessages.findLastIndex((message) =>
    message.tags?.includes('USER_PROMPT'),
  )
  if (userPromptIndex > 0) {
    const userPromptMsg = currentMessages[userPromptIndex]
    // Find the last assistant message before USER_PROMPT (tool messages don't have sentAt)
    let lastAssistantMsg: Message | undefined
    for (let i = userPromptIndex - 1; i >= 0; i--) {
      if (currentMessages[i].role === 'assistant') {
        lastAssistantMsg = currentMessages[i]
        break
      }
    }
    if (
      userPromptMsg !== undefined &&
      typeof userPromptMsg.sentAt === 'number' &&
      lastAssistantMsg !== undefined &&
      typeof lastAssistantMsg.sentAt === 'number'
    ) {
      const gap = userPromptMsg.sentAt - lastAssistantMsg.sentAt
      cacheGapMs = gap
      cacheWillMiss = gap > CACHE_EXPIRY_MS
    }
  }

  const contextLimitExceeded =
    agentState.contextTokenCount + TOKEN_COUNT_FUDGE_FACTOR > maxContextLength

  // P3a: amortized fold mode — fold exactly ONE oldest un-absorbed exchange
  // into the running summary and keep everything else verbatim (Hermes
  // micro-compaction pattern; off by default in the trigger, opt-in).
  const foldOldestExchange: boolean = p.foldOldestExchange === true
  // P3d: force ratio — proceed even for low-value folds rather than risking
  // a hard overflow. Bypasses the cache-will-miss/context-limit gates below.
  const forceCompact: boolean = p.force === true

  // Check if we need to prune at all:
  // - Prune when context exceeds max, OR
  // - Prune when prompt cache will miss (>5 min gap) to take advantage of fresh context
  // - P3a/P3d: an explicit fold or force request always proceeds.
  // If not, return messages with just the subagent-specific tags removed
  if (
    !contextLimitExceeded &&
    !cacheWillMiss &&
    !foldOldestExchange &&
    !forceCompact
  ) {
    yield {
      toolName: 'set_messages',
      input: { messages: currentMessages },
      includeToolCall: false,
    }
    return
  }

  // === SUMMARIZATION MODE ===
  // Find and extract the last remaining INSTRUCTIONS_PROMPT message (for the parent agent)
  // to be preserved as the second message after the summary
  let instructionsPromptMessage: Message | null = null
  const lastRemainingInstructionsIndex = currentMessages.findLastIndex(
    (message) => message.tags?.includes('INSTRUCTIONS_PROMPT'),
  )
  if (lastRemainingInstructionsIndex !== -1) {
    instructionsPromptMessage = currentMessages[lastRemainingInstructionsIndex]
    currentMessages.splice(lastRemainingInstructionsIndex, 1)
  }

  // === SUMMARIZATION STRATEGY ===
  // 1. Summarize ALL messages (apply transformations: truncation, tool summaries, etc.)
  // 2. Walk backwards through summarized parts to apply token budgets
  // 3. Older summarized parts beyond the budgets are dropped

  const assistantToolBudget: number =
    asNumber(p.assistantToolBudget) ?? ASSISTANT_TOOL_BUDGET
  const userBudget: number = asNumber(p.userBudget) ?? USER_BUDGET
  // P2a: fixed verbatim recent-tail token budget (DeepSeek 16 384 default).
  const keepRecentTokens: number =
    asNumber(p.keepRecentTokens) ?? FIXED_TAIL_BUDGET_TOKENS

  // Extract previous summary content from all messages
  let previousSummaryContent = ''
  for (const message of currentMessages) {
    if (isConversationSummary(message)) {
      previousSummaryContent = extractSummaryContent(message)
    }
  }

  // Parse the previous summary into role-tagged entries up front — both the
  // full path and the P3a fold path merge them with new entries (Continue
  // re-distill rule).
  const previousSummaryEntries = parseSummaryIntoEntries(previousSummaryContent)

  // If pruning happens before the assistant has started responding to the
  // current user prompt, preserve that prompt as a real message after the
  // memory artifact. If pruning happens mid-turn, keep the prompt in the
  // historical memory with the assistant/tool progress that followed it and
  // append a synthetic continuation prompt instead.
  const latestLiveUserPromptIndex = currentMessages.findLastIndex((message) =>
    message.tags?.includes('USER_PROMPT'),
  )
  const latestLiveUserPromptMessage =
    latestLiveUserPromptIndex !== -1
      ? currentMessages[latestLiveUserPromptIndex]
      : null
  const isMidTurnPrune =
    latestLiveUserPromptIndex !== -1 &&
    currentMessages
      .slice(latestLiveUserPromptIndex + 1)
      .some(
        (message) =>
          !shouldExcludeMessage(message) && !isConversationSummary(message),
      )

  // === P3a FOLD MODE (amortized, Hermes pattern) ===
  // Fold exactly ONE oldest un-absorbed exchange (user message + following
  // assistant/tool messages, bounded by the next user message) into the
  // running summary. Everything after the folded exchange is kept verbatim —
  // the summary grows by one exchange per fold instead of a full rewrite.
  if (foldOldestExchange) {
    // Locate the last prior <conversation_summary> (the already-absorbed
    // prefix). The oldest un-absorbed exchange starts at the first real user
    // message after it.
    let lastSummaryIndex = -1
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      if (isConversationSummary(currentMessages[i])) {
        lastSummaryIndex = i
        break
      }
    }

    let exchangeStart = -1
    for (let i = lastSummaryIndex + 1; i < currentMessages.length; i++) {
      const m = currentMessages[i]
      if (shouldExcludeMessage(m)) continue
      if (m.role === 'user') {
        exchangeStart = i
        break
      }
    }

    const nothingToFold =
      exchangeStart === -1 || exchangeStart >= currentMessages.length - 1

    // Telemetry fields shared with the full path below.
    const nowFold = Date.now()
    const foldTelemetryBase = buildFoldTelemetryBase({
      agentState,
      maxContextLength,
      cacheExpiryMs: CACHE_EXPIRY_MS,
      previousSummaryEntryCount: previousSummaryEntries.length,
      userBudget,
      assistantToolBudget,
      keepRecentTokens,
      forceCompact,
      isMidTurnPrune,
      liveUserPromptFound: latestLiveUserPromptMessage !== null,
    })

    if (nothingToFold) {
      logFoldNoop(logger, foldTelemetryBase, currentMessages.length)
      yield {
        toolName: 'set_messages',
        input: { messages: currentMessages },
        includeToolCall: false,
      }
      return
    }

    let exchangeEnd = currentMessages.length
    for (let i = exchangeStart + 1; i < currentMessages.length; i++) {
      if (currentMessages[i].role === 'user') {
        exchangeEnd = i
        break
      }
    }

    const exchangeMessages = currentMessages.slice(exchangeStart, exchangeEnd)
    const remainingMessages = currentMessages.slice(exchangeEnd)

    // Summarize ONLY the folded exchange; merge with the prior summary's
    // entries (Continue re-distill rule — the absorbed prefix stays absorbed).
    const { entries: foldEntries } = summarizeMessages(exchangeMessages, null)
    // Mid-turn parity with the full path: when the live user prompt is NOT the
    // oldest un-absorbed exchange (it sits after the folded exchange), keep its
    // [USER] entry in the historical record so its text is never dropped — the
    // Goal section already carries it verbatim for the current turn.
    let foldEntriesAll = foldEntries
    if (
      isMidTurnPrune &&
      latestLiveUserPromptMessage &&
      !exchangeMessages.includes(latestLiveUserPromptMessage)
    ) {
      const liveEntry = summarizeMessages(
        [latestLiveUserPromptMessage],
        latestLiveUserPromptMessage,
      ).entries
      foldEntriesAll = [...foldEntries, ...liveEntry]
    }
    const allFoldEntries: SummaryEntry[] = [
      ...previousSummaryEntries,
      ...foldEntriesAll,
    ]
    const foldBudgetResult = applyBudgets(
      allFoldEntries,
      assistantToolBudget,
      userBudget,
      keepRecentTokens,
    )

    // P1 structured block + preserved state (accumulates across folds — the
    // preserved-state JSON is built from the FULL current history, and prior
    // state is merged in, so todos/files/skills never regress).
    const foldPreservedState = buildPreservedState(currentMessages)
    const foldPreviousPreservedState = extractPreservedState(
      previousSummaryContent,
    )
    const foldMergedPreservedState = mergePreservedState(
      foldPreviousPreservedState,
      foldPreservedState,
    )
    const foldPreservedStateJson = serializePreservedState(
      foldMergedPreservedState,
    )
    const foldFirstUserTurnPinned =
      findFirstUserTurnText(currentMessages) !== null
    const foldStructuredBlock = buildStructuredSummary({
      messages: currentMessages,
      goalText: latestLiveUserPromptMessage
        ? getTextContent(latestLiveUserPromptMessage).trim()
        : null,
      preservedState: foldMergedPreservedState,
    })
    const foldStructuredSummaryText = `${foldStructuredBlock}\n\n---\n\n${foldBudgetResult.summaryText}`
    const foldTaggedSummaryText = `<compaction-summary>\n${foldStructuredSummaryText}\n</compaction-summary>`

    const foldTextPart: TextPart = {
      type: 'text',
      text: `<conversation_summary>\n${SUMMARY_HEADER}\n\n<historical_memory>\n${foldTaggedSummaryText}\n</historical_memory>\n</conversation_summary>\n\n${SUMMARY_DISCLAIMER}`,
    }

    // Preserve images from the last user message in the REMAINING history (a
    // folded exchange's images are summarized away; the model still needs the
    // ones attached to turns it hasn't seen summarized).
    const foldImageParts: Array<ImagePart | FilePart> = []
    for (let i = remainingMessages.length - 1; i >= 0; i--) {
      const msg = remainingMessages[i]
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const imageParts = msg.content.filter(
          (part): part is ImagePart | FilePart =>
            part.type === 'image' || part.type === 'file',
        )
        if (imageParts.length > 0) {
          foldImageParts.push(...imageParts)
          break
        }
      }
    }
    const foldSummaryMessage: UserMessage = {
      role: 'user',
      content: [foldTextPart, ...foldImageParts],
      sentAt: nowFold,
    }

    // Final assembly: new summary first, then the verbatim remaining history
    // (with the live user prompt guaranteed last, exactly like the full path).
    const foldFinalMessages: Message[] = [foldSummaryMessage]
    if (instructionsPromptMessage) {
      foldFinalMessages.push({
        ...instructionsPromptMessage,
        sentAt: nowFold,
      })
    }
    for (const message of remainingMessages) {
      if (shouldExcludeMessage(message)) continue
      if (isConversationSummary(message)) continue
      if (message === latestLiveUserPromptMessage) continue
      foldFinalMessages.push(message)
    }
    if (isMidTurnPrune) {
      // The live user prompt is mid-turn; keep it in the remaining verbatim
      // history and append the same continuation prompt the full path uses.
      foldFinalMessages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Continue the existing assistant turn from the historical memory above. The original user request and completed assistant/tool work are recorded there. Do not restart completed work; resume with the next necessary real tool call or final response.',
          },
        ],
        sentAt: nowFold,
      })
    } else if (latestLiveUserPromptMessage) {
      foldFinalMessages.push({
        ...latestLiveUserPromptMessage,
        sentAt: nowFold,
      })
    }

    logFoldCompleted(logger, foldTelemetryBase, {
      foldedExchangeMessageCount: exchangeMessages.length,
      remainingMessageCount: remainingMessages.length,
      firstUserTurnPinned: foldFirstUserTurnPinned,
      structuredBlockChars: foldStructuredBlock.length,
      preservedStateJsonChars: foldPreservedStateJson.length,
      newestEntryForced: foldBudgetResult.newestEntryForced,
      taggedSummaryText: foldTaggedSummaryText,
    })

    yield {
      toolName: 'set_messages',
      input: { messages: foldFinalMessages },
      includeToolCall: false,
    }
    return
  }

  // Filter out excluded, conversation summary, and live-prompt messages for summarization
  const messagesToSummarize = currentMessages
    .filter(
      (_message, index) =>
        isMidTurnPrune || index !== latestLiveUserPromptIndex,
    )
    .filter(
      (message) =>
        !shouldExcludeMessage(message) && !isConversationSummary(message),
    )

  // Find the last user message with images to preserve in the final output
  let lastUserImageParts: Array<ImagePart | FilePart> = []
  for (let i = messagesToSummarize.length - 1; i >= 0; i--) {
    const msg = messagesToSummarize[i]
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const imageParts = msg.content.filter(
        (part): part is ImagePart | FilePart =>
          part.type === 'image' || part.type === 'file',
      )
      if (imageParts.length > 0) {
        lastUserImageParts = imageParts
        break
      }
    }
  }

  const { entries: summarizedEntries, liveUserPromptEntry } = summarizeMessages(
    messagesToSummarize,
    latestLiveUserPromptMessage,
  )

  // Combine with new entries (previousSummaryEntries computed above — shared
  // with the P3a fold path).
  const allEntries: SummaryEntry[] = [
    ...previousSummaryEntries,
    ...summarizedEntries,
  ]

  const { includedEntries, newestEntryForced, summaryText } = applyBudgets(
    allEntries,
    assistantToolBudget,
    userBudget,
    keepRecentTokens,
  )

  // === P1 STRUCTURED STATE (FID-2026-0806-003 Phase 1) ===
  // Build the <structured_state> block (P1a required sections) carrying the
  // preserved-state JSON (P1b), merged with any state carried by a prior
  // summary (Continue re-distill rule), and pin the first user turn verbatim
  // (P1c). The block leads the condensed memory; the budgeted role-tagged
  // entries follow as the historical record.
  const preservedState = buildPreservedState(currentMessages)
  const previousPreservedState = extractPreservedState(previousSummaryContent)
  const mergedPreservedState = mergePreservedState(
    previousPreservedState,
    preservedState,
  )
  const preservedStateJson = serializePreservedState(mergedPreservedState)
  const firstUserTurnPinned = findFirstUserTurnText(currentMessages) !== null
  const structuredBlock = buildStructuredSummary({
    messages: currentMessages,
    goalText: latestLiveUserPromptMessage
      ? getTextContent(latestLiveUserPromptMessage).trim()
      : null,
    preservedState: mergedPreservedState,
  })
  // Deliberate duplication (P1c guarantee, FID-2026-0806-003): user intent
  // appears twice — verbatim in Standing facts (≤12k tokens) AND in the
  // budgeted [USER] historical entries (≤50k tokens). This is the tested
  // invariant that user messages are never paraphrased or dropped; do not
  // "dedupe" it away without re-testing the user-message guarantee.
  const structuredSummaryText = `${structuredBlock}\n\n---\n\n${summaryText}`

  // P2d: <compaction-summary> tags (DeepSeek pattern) so the model can
  // distinguish the condensed memory from live input and skip it when
  // reasoning about the current turn. Wrapped inside <historical_memory> so
  // the existing summary parsers (extractSummaryContent / parseSummaryIntoEntries
  // / extractPreservedState) keep working unchanged.
  const taggedSummaryText = `<compaction-summary>\n${structuredSummaryText}\n</compaction-summary>`

  // Create the summarized message with fresh sentAt timestamp
  // Include any images from the last user message that had images
  const now = Date.now()
  const textPart: TextPart = {
    type: 'text',
    text: `<conversation_summary>
${SUMMARY_HEADER}

<historical_memory>
${taggedSummaryText}
</historical_memory>
</conversation_summary>

${SUMMARY_DISCLAIMER}`,
  }
  // Build content array with text and any preserved images
  const summaryContentParts: (TextPart | ImagePart | FilePart)[] = [textPart]
  // Append image parts (they're already typed correctly from the original message)
  for (const part of lastUserImageParts) {
    summaryContentParts.push(part)
  }
  const summarizedMessage: UserMessage = {
    role: 'user',
    content: summaryContentParts,
    sentAt: now,
  }

  const continuationMessage: UserMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'Continue the existing assistant turn from the historical memory above. The original user request and completed assistant/tool work are recorded there. Do not restart completed work; resume with the next necessary real tool call or final response.',
      },
    ],
    sentAt: now,
  }

  // Build final messages array: summary first, then INSTRUCTIONS_PROMPT if it
  // exists, then either the live user prompt or a mid-turn continuation prompt.
  // Keeping a real user message last makes the next model step continue from
  // normal user input instead of the condensed memory format.
  const finalMessages: Message[] = [summarizedMessage]
  if (instructionsPromptMessage) {
    // Update sentAt to current time so future cache miss checks use fresh timestamps
    finalMessages.push({ ...instructionsPromptMessage, sentAt: now })
  }
  if (isMidTurnPrune) {
    finalMessages.push(continuationMessage)
  } else if (latestLiveUserPromptMessage) {
    finalMessages.push({ ...latestLiveUserPromptMessage, sentAt: now })
  }

  const userEntryCount = allEntries.filter(
    (entry) => entry.role === 'user',
  ).length
  const assistantToolEntryCount = allEntries.length - userEntryCount
  const liveUserPromptHasText = latestLiveUserPromptMessage
    ? getTextContent(latestLiveUserPromptMessage).trim().length > 0
    : false
  const liveUserPromptTextPreserved = latestLiveUserPromptMessage
    ? !isMidTurnPrune ||
      !liveUserPromptHasText ||
      (liveUserPromptEntry !== undefined &&
        includedEntries.includes(liveUserPromptEntry))
    : false
  const includedUserEntryCount = includedEntries.filter(
    (entry) => entry.role === 'user',
  ).length
  const includedAssistantToolEntryCount =
    includedEntries.length - includedUserEntryCount
  const triggerReason = contextLimitExceeded
    ? cacheWillMiss
      ? 'context_limit_and_cache_expiry'
      : 'context_limit'
    : 'cache_expiry'

  // P4c (FID-2026-0806-003): PostCompact event with ratio metrics (Axon
  // pattern) — the proactive-pruner counterpart to the reactive emit in
  // loop.ts. Best-effort; never blocks set_messages.
  const prunerSummaryTokens = Math.ceil(
    taggedSummaryText.length / CHARS_PER_TOKEN,
  )
  logPostCompact(logger, {
    agentState,
    compressedTokens: prunerSummaryTokens,
    summaryPreview: structuredSummaryText,
  })

  // Telemetry is best-effort and must never block the actual pruning update.
  logCompletion(logger, {
    agentState,
    triggerReason,
    maxContextLength,
    cacheGapMs,
    cacheExpiryMs: CACHE_EXPIRY_MS,
    previousSummaryEntryCount: previousSummaryEntries.length,
    userBudget,
    userEntryCount,
    droppedUserEntryCount: userEntryCount - includedUserEntryCount,
    assistantToolBudget,
    assistantToolEntryCount,
    droppedAssistantToolEntryCount:
      assistantToolEntryCount - includedAssistantToolEntryCount,
    isMidTurnPrune,
    liveUserPromptFound: latestLiveUserPromptMessage !== null,
    liveUserPromptTextPreserved,
    newestEntryForced,
    firstUserTurnPinned,
    structuredBlockChars: structuredBlock.length,
    preservedStateJsonChars: preservedStateJson.length,
    keepRecentTokens,
    forceCompact,
    taggedSummaryText,
  })

  yield {
    toolName: 'set_messages',
    input: {
      messages: finalMessages,
    },
    includeToolCall: false,
  } satisfies ToolCall<'set_messages'>
}
