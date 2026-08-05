/**
 * useFids Hook (FID-2026-0720-033c Phase C)
 *
 * React hook that loads the full FID inventory — active FIDs from `dev/fids/`
 * plus archived FIDs from `dev/fids/archive/` — and keeps it live via a
 * filesystem watcher. Fully harness-driven: the panel updates as the Recorder
 * creates/archives FID files, with no agent involvement in the display path.
 *
 * Usage:
 *   const { fids, archived, isLoading, refresh } = useFids()
 *   <FidList fids={fids} onSelect={...} />
 *
 * Law 14: `loadFidInventory` never throws (returns empty lists on fs errors)
 * and watcher errors are swallowed — so this hook has no error state; the
 * worst case is an empty inventory.
 */

import { join } from 'node:path'

import { useCallback, useEffect, useState } from 'react'

import { loadFidInventory } from '../utils/fid-loader'
import { startFidWatcher } from '../utils/fid-watcher'

import type { FidData } from '../components/savant-ui/echo/fid-list'

const DEFAULT_FIDS_DIR = join('dev', 'fids')

export interface UseFidsResult {
  /** Active FIDs in `dev/fids/` (sorted by severity). */
  fids: FidData[]
  /** Archived FIDs in `dev/fids/archive/` (sorted by severity). */
  archived: FidData[]
  isLoading: boolean
  refresh: () => void
}

/**
 * Load the FID inventory on mount, then keep it live via fs.watch on
 * `dev/fids/`, `dev/fids/archive/`, and a surviving ancestor (so FID
 * directories created mid-session are picked up).
 *
 * @param fidsDir - Optional override for the FIDs directory (used by tests
 *   to point at a fixture directory). Defaults to `cwd/dev/fids`.
 */
export function useFids(fidsDir?: string): UseFidsResult {
  const resolvedDir = fidsDir ?? join(process.cwd(), DEFAULT_FIDS_DIR)
  const [fids, setFids] = useState<FidData[]>([])
  const [archived, setArchived] = useState<FidData[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refresh = useCallback(() => {
    const inventory = loadFidInventory(resolvedDir)
    setFids(inventory.active)
    setArchived(inventory.archived)
    setIsLoading(false)
  }, [resolvedDir])

  useEffect(() => {
    refresh()
    const watcher = startFidWatcher({ fidsDir: resolvedDir, onChange: refresh })
    return () => watcher.close()
  }, [refresh, resolvedDir])

  return { fids, archived, isLoading, refresh }
}
