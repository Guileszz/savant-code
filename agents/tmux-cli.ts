import { createTmuxCliHandleSteps } from './tmux-cli/handle-steps'
import { outputSchema } from './tmux-cli/output-schema'
import {
  inputSchema,
  instructionsPrompt,
  spawnerPrompt,
  systemPrompt,
} from './tmux-cli/prompts'

import type { AgentDefinition } from './types/agent-definition'

const definition: AgentDefinition = {
  id: 'tmux-cli',
  displayName: 'Tmux CLI Agent',
  model: 'minimax/minimax-m3',
  // Provider options are tightly coupled to the model choice above.
  // If you change the model, update these accordingly.
  providerOptions: {
    data_collection: 'deny',
  },

  spawnerPrompt,

  inputSchema,

  outputMode: 'structured_output',
  outputSchema,
  includeMessageHistory: false,

  toolNames: [
    'run_terminal_command',
    'read_files',
    'set_output',
    'add_message',
  ],

  systemPrompt,

  instructionsPrompt,

  handleSteps: createTmuxCliHandleSteps(),
}

export default definition
