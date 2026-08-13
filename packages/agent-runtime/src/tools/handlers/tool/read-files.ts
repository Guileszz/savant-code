import { partitionEmbeddedGroundingReads } from '@savant-code/common/util/embedded-protocol'
import { jsonToolResult } from '@savant-code/common/util/messages'

import { getFileReadingUpdates } from '../../../get-file-reading-updates'
import { renderReadFilesResult } from '../../../util/render-read-files-result'

import type { SavantCodeToolHandlerFunction } from '../handler-function-type'
import type {
  SavantCodeToolCall,
  SavantCodeToolOutput,
} from '@savant-code/common/tools/list'
import type { ParamsExcluding } from '@savant-code/common/types/function-params'
import type { AgentState } from '@savant-code/common/types/session-state'
import type { ProjectFileContext } from '@savant-code/common/util/file'

type ToolName = 'read_files'
export const handleReadFiles = (async (
  params: {
    previousToolCallFinished: Promise<void>
    toolCall: SavantCodeToolCall<ToolName>

    agentState: AgentState
    fileContext: ProjectFileContext
  } & ParamsExcluding<typeof getFileReadingUpdates, 'requestedFiles'>,
): Promise<{ output: SavantCodeToolOutput<ToolName> }> => {
  const {
    previousToolCallFinished,
    toolCall,

    agentState,
    fileContext,
  } = params
  const { paths } = toolCall.input

  await previousToolCallFinished

  // FID-2026-0810-002 Change 2: synthetic read — when the boot contract
  // resolved from the embedded bundle (npm install, no local protocol files),
  // grounding-set paths are served from the bundle through the SAME read
  // path; everything else reads from the filesystem as usual. Local mode
  // never consults the bundle (project files win).
  const { embedded, remaining } = partitionEmbeddedGroundingReads({
    protocolSource: agentState.protocolSource,
    requestedFiles: paths,
  })

  let addedFiles: { path: string; content: string }[] = embedded
  if (remaining.length > 0) {
    const fromFs = await getFileReadingUpdates({
      ...params,
      requestedFiles: remaining,
    })
    addedFiles = [...embedded, ...fromFs]
  }

  return {
    output: jsonToolResult(
      renderReadFilesResult(addedFiles, fileContext.tokenCallers ?? {}),
    ),
  }
}) satisfies SavantCodeToolHandlerFunction<ToolName>
