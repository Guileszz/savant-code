// FID-007 S2: sidebar tool list — hoisted (stable identity so RightSidebar's
// React.memo can skip) and cross-checked against
// common/src/tools/constants.ts. The previous inline list named tools that do
// NOT exist in the executor allowlist (read_file, search_files, bash).
export const SIDEBAR_TOOLS_AVAILABLE = [
  'read_files',
  'code_search',
  'apply_patch',
  'run_terminal_command',
]

// FID-007 D7: hoisted static style objects so the render loop stops
// allocating fresh style identities every render/tick.
export const CHAT_ROOT_STYLE = {
  flexDirection: 'row', // Horizontal split: chat + sidebar
  gap: 0,
  flexGrow: 1,
} as const

export const HEADER_BOX_STYLE = { flexDirection: 'column' } as const

export const SCROLLBOX_STYLE = {
  flexGrow: 1,
  rootOptions: {
    flexGrow: 1,
    padding: 0,
    gap: 0,
    flexDirection: 'row',
    shouldFill: true,
    backgroundColor: 'transparent',
  },
  wrapperOptions: {
    flexGrow: 1,
    border: false,
    shouldFill: true,
    backgroundColor: 'transparent',
    flexDirection: 'column',
  },
  contentOptions: {
    flexDirection: 'column',
    gap: 0,
    shouldFill: true,
    justifyContent: 'flex-end',
    backgroundColor: 'transparent',
    paddingLeft: 1,
    paddingRight: 2,
  },
} as const

export const BOTTOM_BOX_STYLE = {
  flexShrink: 0,
  backgroundColor: 'transparent',
} as const
