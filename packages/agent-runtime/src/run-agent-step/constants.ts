export const NATIVE_TOOL_CALL_RECOVERY_EXHAUSTED_MESSAGE =
  'Native tool-call recovery failed twice consecutively; ending the agent run without executing the incomplete tool call.'

export const STEP_WARNING_MESSAGE = [
  "I've made quite a few responses in a row.",
  "Let me pause here to make sure we're still on the right track.",
  "Please let me know if you'd like me to continue or if you'd like to guide me in a different direction.",
].join(' ')
