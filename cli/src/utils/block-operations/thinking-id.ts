let thinkingIdCounter = 0
const generateThinkingId = (): string => {
  thinkingIdCounter++
  return `thinking-${thinkingIdCounter}`
}

export { generateThinkingId }
