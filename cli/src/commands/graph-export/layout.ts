/**
 * Export-time layout engine (FID-2026-0806-017, source-exact ELK).
 *
 * FID-2026-0807-020: all emitted coordinates are rounded to integers (integer
 * rounding is deterministic across runs and cheaper to parse/render than
 * 1-decimal floats); `roundCoord` replaces the old 1-decimal `round1`.
 *
 * Runs the Eclipse Layout Kernel (elkjs) in Bun at export time, never in the
 * browser: Stage 1 lays out region atoms + ungrouped nodes; Stage 2 lays out
 * each region's local files, offset by the region position. The resulting
 * coordinates are embedded in the renderer-neutral Code Universe payload; the
 * browser performs no layout math and elkjs remains export-time-only — its
 * GWT bundle never ships to the client.
 *
 * ## elkjs-under-Bun (spike, 2026-08-06)
 *
 * elkjs's CJS entry (`lib/main.js`) requires the GWT-compiled
 * `elk-worker.min.js` bundle and reads `module.exports.Worker`. Under Bun that
 * interop silently returns `{}` because Bun defines a global `self` — the
 * bundle takes its *web-worker* branch (`self.onmessage = …`) and skips the
 * CJS export guard. The workaround, verified end-to-end in the spike
 * (FID Step 1): read the worker bundle text, evaluate it in a `Function`
 * scope with `self` / `document` / `window` shadowed as `undefined` (so it
 * takes the CJS branch), and hand the extracted in-process fake `Worker` to
 * elkjs via `workerFactory`. No threads, no WASM download — pure JS layout.
 *
 * Sandboxing notes (audited 2026-08-06): `vm.runInNewContext` was tried
 * first and FAILS under Bun — the GWT bootstrap reads `$wnd.goog` off the
 * host global shape, so a fresh vm context (or shadowing `process` /
 * `globalThis`) breaks layout entirely. The executed source is a pinned,
 * vendored npm dep (`elkjs` 0.12.0 exact) with a stub `require`; no
 * user-controlled data ever reaches the eval.
 */

import fs from 'fs'
import { createRequire } from 'module'
import path from 'path'

import ELK from 'elkjs/lib/elk-api.js'

import { deriveContainers } from './containers'

import type { GraphContainer } from './containers'
import type {
  GraphExportElement,
  GraphPosition,
} from '@savant-code/knowledge-graph'
import type {
  ElkExtendedEdge,
  ElkNode,
  LayoutOptions,
} from 'elkjs/lib/elk-api.js'

/**
 * Mirror the source project's ELK configuration
 * (`graph-layout-scaling-design.md` §3): layered algorithm, top-down, sweep
 * crossing minimization, orthogonal edge routing, generous spacing so
 * containers read as distinct regions.
 */
const ELK_OPTIONS: LayoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '80',
  'elk.spacing.nodeNode': '60',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.padding': '[30]',
}

const FILE_NODE_W = 40
const FILE_NODE_H = 24

// FID-2026-0806-018: fixed container atom size for the compact overview ELK
// pass (the CSS container node size is 120 × 36 in template.ts).
const CONTAINER_OVERVIEW_W = 120
const CONTAINER_OVERVIEW_H = 36

// ---------------------------------------------------------------------------
// elkjs worker loading (Bun interop workaround — see header comment)
// ---------------------------------------------------------------------------

interface GwtWorkerLike {
  postMessage: (msg: unknown) => void
  onmessage: ((ev: { data: unknown }) => void) | null
}

let workerClassPromise: Promise<new () => GwtWorkerLike> | null = null

/** Resolve the GWT worker bundle path (sibling file next to a compiled binary). */
function resolveElkWorkerPath(): string {
  // Compiled binaries cannot read node_modules at runtime (bun --compile);
  // build-binary.ts ships `elk-worker.min.js` as a sibling of the binary, the
  // same pattern used for tree-sitter.wasm.
  if (process.env.SAVANT_CODE_IS_BINARY === 'true') {
    const sibling = path.join(
      path.dirname(process.execPath),
      'elk-worker.min.js',
    )
    if (fs.existsSync(sibling)) return sibling
  }
  // Resolve relative to this module so it works regardless of the CLI's cwd
  // (the CLI runs with `--cwd ..` from the cli/ workspace in dev).
  const cliRequire = createRequire(import.meta.url)
  return cliRequire.resolve('elkjs/lib/elk-worker.min.js')
}

/**
 * Evaluate the GWT worker bundle and extract the in-process fake `Worker`
 * class. `self`/`document`/`window` are shadowed as undefined so the bundle
 * takes its CJS export branch instead of the web-worker branch (see header).
 * Memoized per process — one evaluation, reused across exports.
 */
export function getElkWorkerClass(): Promise<new () => GwtWorkerLike> {
  if (workerClassPromise) return workerClassPromise
  workerClassPromise = (async () => {
    const bundle = resolveElkWorkerPath()
    const src = fs.readFileSync(bundle, 'utf8')
    const fakeModule: { exports: Record<string, unknown> } = { exports: {} }

    const fn = new Function(
      'module',
      'exports',
      'require',
      '__filename',
      '__dirname',
      'self',
      'document',
      'window',
      src,
    )
    fn(
      fakeModule,
      fakeModule.exports,
      (id: string) => id, // the GWT bundle never requires at runtime
      bundle,
      path.dirname(bundle),
      undefined,
      undefined,
      undefined,
    )
    const Worker = fakeModule.exports.Worker
    if (typeof Worker !== 'function') {
      throw new Error(
        'elkjs worker bundle did not export a Worker class under Bun ' +
          '(SAVANT_CODE_IS_BINARY=' +
          process.env.SAVANT_CODE_IS_BINARY +
          '). Layout fallback is d3-force.',
      )
    }
    return Worker as new () => GwtWorkerLike
  })()
  return workerClassPromise
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface GraphLayoutResult {
  /** Element id → precomputed position (file nodes only). */
  positions: Record<string, GraphPosition>
  /** Element id → container id (drill-down). */
  containerIds: Record<string, string>
  /** Derived containers (id + label) for the serializer to emit as atoms. */
  containers: GraphContainer[]
  /**
   * FID-2026-0806-018: compact center positions for every initially visible
   * overview element — container atoms + ungrouped root files. Computed by a
   * fixed-size ELK pass so the collapsed overview is spatially compact
   * (the Stage-1 bbox-derived positions span tens of thousands of units).
   */
  overviewPositions: Record<string, GraphPosition>
  /**
   * FID-2026-0806-018: stable expansion anchor per container — the container's
   * compact overview center (same point as its collapsed position). The browser
   * positions children at `anchor + childOffsets[c][id]` on expand so they
   * center on the container; it must never derive the anchor from the live
   * parent position (compound bounds shift when children become visible).
   */
  overviewAnchors: Record<string, GraphPosition>
  /**
   * FID-2026-0806-018: per-container child offsets in the same center frame
   * as the anchors (container id → child element id → center-frame offset).
   */
  childOffsets: Record<string, Record<string, GraphPosition>>
}

interface Stage1Node {
  id: string
  width: number
  height: number
  isContainer?: boolean
}

interface Stage1Result {
  /** Atom (container + ungrouped) positions from the Stage-1 ELK run. */
  positions: Record<string, GraphPosition>
  /**
   * FID-2026-0806-018: compact overview centers for the same atoms, from a
   * fixed-size ELK pass — container atoms use the overview atom size
   * (CONTAINER_OVERVIEW_W × CONTAINER_OVERVIEW_H) instead of child bboxes.
   */
  overviewPositions: Record<string, GraphPosition>
  /** The atoms used by both ELK passes (id + isContainer). */
  atoms: Stage1Node[]
  containerBboxes: Record<string, { width: number; height: number }>
  /**
   * Container child layouts computed while sizing the atoms (Stage-1 pass).
   * Reused for the final positions — never run ELK twice on the same children.
   */
  childPositions: Record<string, Record<string, GraphPosition>>
}

/**
 * Compute the export-time layout for the serialized elements.
 *
 * 1. Derive containers (folder-LCP with cluster fallback).
 * 2. Stage 2 first — layout each container's children so the container atom
 *    size matches its real content extent.
 * 3. Stage 1 — ELK over container atoms + ungrouped nodes.
 * 4. Compose final absolute positions: ungrouped nodes from Stage 1, children
 *    from Stage 2 offset by their container's Stage-1 origin.
 */
export async function computeGraphLayout(
  elements: GraphExportElement[],
): Promise<GraphLayoutResult> {
  const containers = deriveContainers(elements)
  const nodeIds = new Set(
    elements
      .filter((el) => !el.data.source && !el.data.target)
      .map((el) => el.data.id),
  )

  const containerOf = new Map<string, string>()
  for (const c of containers) {
    for (const nodeId of c.nodeIds) containerOf.set(nodeId, c.id)
  }
  const containerIds: Record<string, string> = Object.fromEntries(containerOf)

  const edges: ElkExtendedEdge[] = elements
    .filter((el) => el.data.source && el.data.target)
    .map((el, i) => ({
      id: `e${i}`,
      sources: [el.data.source as string],
      targets: [el.data.target as string],
    }))

  const stage1 = await layoutStage1(elements, containers, edges)
  const positions: Record<string, GraphPosition> = { ...stage1.positions }

  // Stage 2 is a pure composition: the child layouts were already computed
  // during Stage 1's atom sizing, so just offset them by the container origin.
  // (Running ELK twice on the same children would double the export wall time.)
  for (const container of containers) {
    const bbox = stage1.containerBboxes[container.id]
    if (!bbox) continue
    const children = container.nodeIds.filter((id) => nodeIds.has(id))
    if (children.length === 0) continue
    const childPositions = stage1.childPositions[container.id] ?? {}
    const origin = stage1.positions[container.id] ?? { x: 0, y: 0 }
    for (const childId of children) {
      const rel = childPositions[childId]
      if (!rel) continue
      positions[childId] = {
        x: roundCoord(origin.x + rel.x),
        y: roundCoord(origin.y + rel.y),
      }
    }
  }

  // FID-2026-0806-018: derive the compact overview + drill-down coordinate
  // contract in one consistent center frame. ELK returns top-left coordinates;
  // Sigma node positions are centers. The anchor for each container is its
  // compact overview center; every child offset is measured from the center of
  // that container's child-layout bbox, so `anchor + offset` reconstructs the
  // child layout centered on the collapsed container.
  const overviewPositions: Record<string, GraphPosition> = {}
  const overviewAnchors: Record<string, GraphPosition> = {}
  const childOffsets: Record<string, Record<string, GraphPosition>> = {}
  for (const atom of stage1.atoms) {
    const pos = stage1.overviewPositions[atom.id]
    if (pos) overviewPositions[atom.id] = pos
    if (atom.isContainer) {
      const bbox = stage1.containerBboxes[atom.id]
      const childPositions = stage1.childPositions[atom.id] ?? {}
      // The expansion anchor is the container's compact overview center so
      // expanded children center on the container atom itself (anchor + offset
      // reconstructs the child layout centered on the collapsed container).
      const anchor = pos
      if (bbox && bbox.width > 0 && bbox.height > 0 && anchor) {
        overviewAnchors[atom.id] = anchor
        const offsets: Record<string, GraphPosition> = {}
        for (const [childId, childPos] of Object.entries(childPositions)) {
          offsets[childId] = {
            x: roundCoord(childPos.x + FILE_NODE_W / 2 - bbox.width / 2),
            y: roundCoord(childPos.y + FILE_NODE_H / 2 - bbox.height / 2),
          }
        }
        childOffsets[atom.id] = offsets
      }
    }
  }

  return {
    positions,
    containerIds,
    containers,
    overviewPositions,
    overviewAnchors,
    childOffsets,
  }
}

/** ELK over container atoms + ungrouped nodes. */
async function layoutStage1(
  elements: GraphExportElement[],
  containers: GraphContainer[],
  allEdges: ElkExtendedEdge[],
): Promise<Stage1Result> {
  const inContainer = new Set(containers.flatMap((c) => c.nodeIds))

  // Ungrouped file nodes act as first-class Stage-1 atoms (the base
  // serialization contains only file nodes + edges; containers are derived).
  const ungrouped = elements.filter(
    (el) => !el.data.source && !el.data.target && !inContainer.has(el.data.id),
  )

  // Children first, so container atoms are sized by their real content AND
  // the child layouts are captured for reuse in the final composition.
  const containerBboxes: Record<string, { width: number; height: number }> = {}
  const childPositions: Record<string, Record<string, GraphPosition>> = {}
  for (const container of containers) {
    const childIds = container.nodeIds
    const childEdges = allEdges.filter(
      (e) =>
        e.sources.every((s) => childIds.includes(s)) &&
        e.targets.every((t) => childIds.includes(t)),
    )
    const childPos = await runElk(childIds, childEdges)
    childPositions[container.id] = childPos
    containerBboxes[container.id] = measureBbox(childPos)
  }

  const atoms: Stage1Node[] = [
    ...containers.map((c) => {
      const bbox = containerBboxes[c.id]
      return {
        id: c.id,
        width: Math.max(60, Math.round(bbox.width) + 40),
        height: Math.max(40, Math.round(bbox.height) + 40),
        isContainer: true,
      }
    }),
    ...ungrouped.map((el) => ({
      id: el.data.id,
      width: FILE_NODE_W,
      height: FILE_NODE_H,
    })),
  ]

  // Aggregate edges between atoms (dedupe; drop intra-atom edges).
  const atomOf = new Map<string, string>()
  for (const c of containers) for (const n of c.nodeIds) atomOf.set(n, c.id)
  for (const el of ungrouped) atomOf.set(el.data.id, el.data.id)

  const seen = new Set<string>()
  const atomEdges: ElkExtendedEdge[] = []
  for (const e of allEdges) {
    const src = atomOf.get(e.sources[0])
    const tgt = atomOf.get(e.targets[0])
    if (!src || !tgt || src === tgt) continue
    const key = src < tgt ? `${src}->${tgt}` : `${tgt}->${src}`
    if (seen.has(key)) continue
    seen.add(key)
    atomEdges.push({
      id: `atom-e${atomEdges.length}`,
      sources: [src],
      targets: [tgt],
    })
  }

  const atomPositions = await runElk(
    atoms.map((a) => a.id),
    atomEdges,
    atoms.map((a) => ({ id: a.id, width: a.width, height: a.height })),
  )

  // FID-2026-0806-018: a second deterministic ELK pass over the same atom set
  // with fixed sizes. Container atoms are sized CONTAINER_OVERVIEW_W/H (not
  // the child-derived bbox) so the collapsed overview is compact; ungrouped
  // files keep their normal size. The atom set and edges are identical to the
  // sizing pass, so the two runs produce consistent, deterministic layouts.
  const overviewIds = atoms.map((a) => a.id)
  const overviewSizes = atoms.map((a) =>
    a.isContainer
      ? {
          id: a.id,
          width: CONTAINER_OVERVIEW_W,
          height: CONTAINER_OVERVIEW_H,
        }
      : { id: a.id, width: FILE_NODE_W, height: FILE_NODE_H },
  )
  const overviewTopLeft = await runElk(overviewIds, atomEdges, overviewSizes)
  // ELK returns top-left coordinates; convert to center coordinates.
  const overviewPositions: Record<string, GraphPosition> = {}
  const sizeById = new Map(overviewSizes.map((s) => [s.id, s]))
  for (const [id, tl] of Object.entries(overviewTopLeft)) {
    const size = sizeById.get(id)
    if (!size) continue
    overviewPositions[id] = {
      x: roundCoord(tl.x + size.width / 2),
      y: roundCoord(tl.y + size.height / 2),
    }
  }

  return {
    positions: atomPositions,
    overviewPositions,
    atoms,
    containerBboxes,
    childPositions,
  }
}

function measureBbox(positions: Record<string, GraphPosition>): {
  width: number
  height: number
} {
  let maxX = 0
  let maxY = 0
  for (const pos of Object.values(positions)) {
    maxX = Math.max(maxX, pos.x + FILE_NODE_W)
    maxY = Math.max(maxY, pos.y + FILE_NODE_H)
  }
  return { width: maxX, height: maxY }
}

/** One ELK invocation over the given node ids (+ optional explicit sizes). */
async function runElk(
  nodeIds: string[],
  edges: ElkExtendedEdge[],
  sizes?: Array<{ id: string; width: number; height: number }>,
): Promise<Record<string, GraphPosition>> {
  if (nodeIds.length === 0) return {}
  const sizeById = new Map((sizes ?? []).map((s) => [s.id, s]))
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: ELK_OPTIONS,
    children: nodeIds.map((id) => {
      const size = sizeById.get(id) ?? {
        width: FILE_NODE_W,
        height: FILE_NODE_H,
      }
      return { id, width: size.width, height: size.height }
    }),
    edges,
  }

  const elk = await createElk()
  const laid = await elk.layout(graph)

  const positions: Record<string, GraphPosition> = {}
  for (const child of laid.children ?? []) {
    if (child.x !== undefined && child.y !== undefined) {
      positions[child.id] = { x: roundCoord(child.x), y: roundCoord(child.y) }
    }
  }
  return positions
}

async function createElk(): Promise<InstanceType<typeof ELK>> {
  const WorkerClass = await getElkWorkerClass()
  // The GWT fake worker satisfies elkjs's Worker protocol (postMessage +
  // onmessage) without any thread — cast through unknown because it does not
  // implement the full DOM Worker interface.
  return new ELK({
    workerFactory: () => new WorkerClass() as unknown as Worker,
  })
}

function roundCoord(n: number): number {
  return Math.round(n)
}
