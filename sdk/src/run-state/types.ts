import type { CustomToolDefinition } from '../custom-tool'
import type { AgentDefinition } from '@savant-code/common/templates/initial-agents-dir/types/agent-definition'
import type { Logger } from '@savant-code/common/types/contracts/logger'
import type { SavantCodeFileSystem } from '@savant-code/common/types/filesystem'
import type {
  AgentOutput,
  SessionState,
} from '@savant-code/common/types/session-state'
import type { SavantCodeSpawn } from '@savant-code/common/types/spawn'

export type RunState = {
  sessionState?: SessionState
  output: AgentOutput
  traceSessionId: string
}

export type InitialSessionStateOptions = {
  cwd?: string
  /** Optional directory path to load skills from. When provided, skills are loaded from this directory instead of the default locations. */
  skillsDir?: string
  projectFiles?: Record<string, string>
  knowledgeFiles?: Record<string, string>
  /** User-provided knowledge files that will be merged with home directory files */
  userKnowledgeFiles?: Record<string, string>
  agentDefinitions?: AgentDefinition[]
  customToolDefinitions?: CustomToolDefinition[]
  maxAgentSteps?: number
  /** Dev override flag — bypasses all FSM tool gating and agent tool restrictions. */
  devMode?: boolean
  fs?: SavantCodeFileSystem
  spawn?: SavantCodeSpawn
  logger?: Logger
}
