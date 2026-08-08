import {
  parseThinkTags,
  getPartialTagLength,
  THINK_OPEN_TAG,
  THINK_CLOSE_TAG,
} from '../think-tag-parser'
import {
  createReasoningBlock,
  createTextBlock,
  isNativeReasoningBlock,
  isOpenThinkingBlock,
} from './primitive-blocks'
import { generateThinkingId } from './thinking-id'

import type { ContentBlock } from '../../types/chat'

/**
 * Shared logic for appending text with think tag parsing.
 * Used by both root stream and agent blocks.
 */
const appendTextWithThinkParsingToBlocks = (
  blocks: ContentBlock[],
  text: string,
): ContentBlock[] => {
  if (!text) {
    return blocks
  }

  const nextBlocks = [...blocks]
  const lastBlock = nextBlocks[nextBlocks.length - 1]
  const wasInsideThinking = isOpenThinkingBlock(lastBlock)

  let textToParse = text
  let lastBlockContent = ''

  if (wasInsideThinking && lastBlock?.type === 'text') {
    lastBlockContent = lastBlock.content

    const partialLen = getPartialTagLength(lastBlockContent)
    if (partialLen > 0) {
      const potentialTag = lastBlockContent.slice(-partialLen) + text
      if (potentialTag.startsWith(THINK_CLOSE_TAG)) {
        const newLastContent = lastBlockContent.slice(0, -partialLen)
        textToParse = lastBlockContent.slice(-partialLen) + text

        if (newLastContent) {
          nextBlocks[nextBlocks.length - 1] = {
            ...lastBlock,
            content: newLastContent,
          }
        } else {
          nextBlocks.pop()
        }
      }
    }
  } else if (
    !wasInsideThinking &&
    lastBlock?.type === 'text' &&
    lastBlock.textType === 'text'
  ) {
    lastBlockContent = lastBlock.content
    const partialLen = getPartialTagLength(lastBlockContent)
    if (partialLen > 0) {
      const potentialTag = lastBlockContent.slice(-partialLen) + text
      if (potentialTag.startsWith(THINK_OPEN_TAG)) {
        const newLastContent = lastBlockContent.slice(0, -partialLen)
        textToParse = lastBlockContent.slice(-partialLen) + text

        if (newLastContent) {
          nextBlocks[nextBlocks.length - 1] = {
            ...lastBlock,
            content: newLastContent,
          }
        } else {
          nextBlocks.pop()
        }
      }
    }
  }

  const currentLastBlock = nextBlocks[nextBlocks.length - 1]
  const insideThinking = isOpenThinkingBlock(currentLastBlock)

  if (insideThinking && !textToParse.includes('<')) {
    if (currentLastBlock?.type === 'text') {
      nextBlocks[nextBlocks.length - 1] = {
        ...currentLastBlock,
        content: currentLastBlock.content + textToParse,
      }
      return nextBlocks
    }
  }

  if (!insideThinking && !textToParse.includes('<')) {
    if (
      currentLastBlock?.type === 'text' &&
      currentLastBlock.textType === 'text'
    ) {
      nextBlocks[nextBlocks.length - 1] = {
        ...currentLastBlock,
        content: currentLastBlock.content + textToParse,
      }
      return nextBlocks
    }
    return [...nextBlocks, createTextBlock(textToParse)]
  }

  const fullText = insideThinking ? THINK_OPEN_TAG + textToParse : textToParse

  const segments = parseThinkTags(fullText)

  let segmentStartIdx = 0
  if (
    insideThinking &&
    segments.length > 0 &&
    segments[0].type === 'thinking'
  ) {
    const firstSegment = segments[0]
    if (currentLastBlock?.type === 'text') {
      const hasMoreSegments = segments.length > 1
      const thinkingOpen =
        !hasMoreSegments && !textToParse.includes(THINK_CLOSE_TAG)

      nextBlocks[nextBlocks.length - 1] = {
        ...currentLastBlock,
        content: currentLastBlock.content + firstSegment.content,
        thinkingOpen,
      }
    }
    segmentStartIdx = 1
  } else if (insideThinking && textToParse.includes(THINK_CLOSE_TAG)) {
    // Handle case where we're inside thinking and receive </think> with no content
    // (e.g., just "</think>" or "</think>text"). In this case parseThinkTags returns
    // empty or starts with text, but we still need to close the thinking block.
    if (currentLastBlock?.type === 'text') {
      nextBlocks[nextBlocks.length - 1] = {
        ...currentLastBlock,
        thinkingOpen: false,
      }
    }
  }

  for (let i = segmentStartIdx; i < segments.length; i++) {
    const segment = segments[i]
    const isLastSegment = i === segments.length - 1

    if (segment.type === 'thinking') {
      const thinkingOpen =
        isLastSegment && !textToParse.endsWith(THINK_CLOSE_TAG)
      if (thinkingOpen) {
        nextBlocks.push(
          createReasoningBlock(
            segment.content,
            thinkingOpen,
            generateThinkingId(),
          ),
        )
      }
    } else {
      const prevBlock = nextBlocks[nextBlocks.length - 1]
      if (
        prevBlock?.type === 'text' &&
        prevBlock.textType === 'text' &&
        !prevBlock.thinkingOpen
      ) {
        nextBlocks[nextBlocks.length - 1] = {
          ...prevBlock,
          content: prevBlock.content + segment.content,
        }
      } else {
        nextBlocks.push(createTextBlock(segment.content))
      }
    }
  }

  return nextBlocks
}

/**
 * Appends native reasoning content to blocks array (for agent blocks).
 * Similar to how appendTextToRootStream handles reasoning for root.
 */
const appendNativeReasoningToBlocks = (
  blocks: ContentBlock[],
  text: string,
): ContentBlock[] => {
  if (!text) {
    return blocks
  }

  const nextBlocks = [...blocks]
  const lastBlock = nextBlocks[nextBlocks.length - 1]

  // If last block is already an open native reasoning block, append to it
  // Only append if it's a native reasoning block (thinkingOpen === undefined),
  // not a closed one or a <think> tag block
  if (isNativeReasoningBlock(lastBlock) && lastBlock.type === 'text') {
    const updatedBlock: ContentBlock = {
      ...lastBlock,
      content: lastBlock.content + text,
    }
    nextBlocks[nextBlocks.length - 1] = updatedBlock
    return nextBlocks
  }

  // Create a new native reasoning block
  const newBlock: ContentBlock = {
    type: 'text',
    content: text,
    textType: 'reasoning',
    thinkingCollapseState: 'preview',
    thinkingId: generateThinkingId(),
  }

  return [...nextBlocks, newBlock]
}

/**
 * Marks the last native reasoning block as complete by setting thinkingOpen: false.
 * This triggers the UI to collapse the thinking block.
 *
 * Note: We search backwards through all blocks because agent/tool blocks may have
 * been added after the reasoning block but before text output starts.
 */
export const closeNativeReasoningBlock = (
  blocks: ContentBlock[],
): ContentBlock[] => {
  // Find the last native reasoning block (not just the last block)
  let lastReasoningIndex = -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (isNativeReasoningBlock(blocks[i])) {
      lastReasoningIndex = i
      break
    }
  }

  if (lastReasoningIndex === -1) {
    return blocks
  }

  const reasoningBlock = blocks[lastReasoningIndex]
  if (reasoningBlock.type !== 'text') {
    return blocks
  }

  const nextBlocks = [...blocks]
  nextBlocks[lastReasoningIndex] = {
    ...reasoningBlock,
    thinkingOpen: false,
  }
  return nextBlocks
}

export { appendNativeReasoningToBlocks, appendTextWithThinkParsingToBlocks }
