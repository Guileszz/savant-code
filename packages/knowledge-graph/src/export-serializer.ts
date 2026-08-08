import fs from 'fs'
import path from 'path'

import type { EdgeType } from './types'
import type { Database } from 'bun:sqlite'

/**
 * Serialize the graph database into the renderer-neutral Code Universe
 * payload (FID-2026-0807-002). Legacy `elements` are retained as a typed
 * compatibility/data-inspection view; the browser renderer consumes `universe`.
 *
 * FID-2026-0806-006: file nodes optionally carry a capped first-20-line code
 * preview (2,000 chars) so the offline export can render a sidebar preview.
 * Previews are read from disk at export time when a `projectRoot` is passed;
 * the strict metadata-only posture can be forced with
 * `SAVANT_GRAPH_EXPORT_NO_PREVIEW=1`. Document text is unlimited by default;
 * positive caller-supplied limits remain available, while validated raster
 * images stay within explicit media budgets.
 *
 * FID-2026-0807-002: the export is precomputed at export time. The caller
 * passes positions and region/container metadata back in; the browser only
 * renders immutable coordinates and camera states. Previews are OFF by default
 * (opt in with `SAVANT_GRAPH_EXPORT_PREVIEWS=1`); the hard-off flag remains.
 */

export interface GraphPosition {
  x: number
  y: number
}

export interface UniverseRegion {
  id: string
  label: string
  path: string
  fileCount: number
  edgeCount: number
  position: GraphPosition
  size: number
  color: string
  cluster: number | null
  disconnected: boolean
}

export interface UniverseFile {
  id: string
  label: string
  path: string
  regionId: string
  cluster: number | null
  position: GraphPosition
  size: number
  importance: number
  /** Optional sidebar preview, present only when previews are explicitly enabled. */
  preview?: string
}

export interface UniverseFolder {
  id: string
  label: string
  path: string
  parentId: string | null
  childIds: string[]
}

export interface UniverseTextDocument {
  kind: 'text'
  text: string
  lineCount: number
  byteCount: number
  truncated: boolean
  /** True when an explicit positive document option capped the text. */
  explicitlyCapped?: boolean
  /** @deprecated Retained for consumers compiled against the preview-era shape. */
  preview?: boolean
}

export interface UniverseImageDocument {
  kind: 'image'
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  dataUri: string
  byteCount: number
  truncated: false
}

export interface UniverseUnavailableDocument {
  kind: 'unavailable'
  // A null byte count means containment/readability prevented a safe stat/read.
  byteCount: number | null
  unavailableReason:
    | 'binary'
    | 'unsupported-image'
    | 'malformed-image'
    | 'oversized'
    | 'unreadable'
    | 'outside-root'
}

export type UniverseDocument =
  UniverseTextDocument | UniverseImageDocument | UniverseUnavailableDocument

export interface UniverseDocumentPolicy {
  enabled: boolean
  /** `null` means unlimited by default; positive values are explicit caps. */
  maxTextLines: number | null
  maxTextBytes: number | null
  maxImageBytes: number
  maxTotalTextBytes: number | null
  maxTotalMediaBytes: number
  /** @deprecated Head previews were removed from the default text path. */
  headBytes: number | null
  /** @deprecated Head previews were removed from the default text path. */
  headTotalBytes: number | null
}

export interface UniverseEdge {
  id: string
  source: string
  target: string
  type: string
  weight: number
}

export interface UniverseCorridor {
  id: string
  source: string
  target: string
  edgeCount: number
  totalWeight: number
  typeCounts: Record<string, number>
  underlyingEdgeIds: string[]
}

export interface GraphUniverse {
  regions: UniverseRegion[]
  files: UniverseFile[]
  edges: UniverseEdge[]
  corridors: UniverseCorridor[]
  folders: UniverseFolder[]
  rootFolderId: string
  documents: Record<string, UniverseDocument>
  documentPolicy: UniverseDocumentPolicy
  /**
   * Precomputed search index (FID-2026-0807-020): systems, folders, and files
   * with scored metadata. Built at export time so the browser performs zero
   * index construction on load.
   */
  searchIndex: Array<{
    id: string
    kind: 'system' | 'folder' | 'file'
    label: string
    path: string
  }>
}

export interface GraphExportElement {
  data: {
    id: string
    label: string
    path?: string
    type?: string
    cluster?: number | null
    weight?: number
    source?: string
    target?: string
    preview?: string
    containerId?: string
    parent?: string
    container?: boolean
    /**
     * FID-2026-0806-018: compact overview center for container atoms and
     * ungrouped root files (the initially visible set). Present only on
     * overview-level elements; child nodes instead carry `childOffset`.
     */
    overviewPosition?: GraphPosition
    /**
     * FID-2026-0806-018: stable expansion anchor for a container — its compact
     * overview center (the same point as its collapsed position). The browser
     * positions children at `anchor + childOffset` on expand so they center on
     * the container, and never trusts the live parent position (compound
     * bounds shift when children become visible).
     */
    overviewAnchor?: GraphPosition
    /**
     * FID-2026-0806-018: center-frame offset of this child relative to its
     * container's `overviewAnchor`. Present only on container child nodes.
     */
    childOffset?: GraphPosition
  }
  /** Export-time precomputed position (FID-2026-0806-017); absent for edges. */
  position?: GraphPosition
}

export interface GraphExport {
  /** ISO timestamp of serialization. */
  generatedAt: string
  /** Top-level dirs count (for the meta grid). */
  meta: {
    files: number
    nodes: number
    edges: number
    clusters: number
  }
  /**
   * Internal layout view consumed by `computeGraphLayout` at export time only
   * (FID-2026-0807-020). Not part of the serialized artifact payload — the
   * template strips it before embedding so the shipped HTML carries only
   * `universe`.
   */
  elements: GraphExportElement[]
  /** Renderer-neutral Code Universe payload. */
  universe: GraphUniverse
}

export interface GraphExportOptions {
  /** Project root used to resolve relative file paths for previews. */
  projectRoot?: string
  /** Max preview lines per file (default 20). */
  previewLines?: number
  /** Max preview characters per file (default 2,000). */
  previewChars?: number
  /** Enable document bodies in the offline browser. */
  documents?: boolean
  /** Positive cap; omitted/invalid values leave text unlimited. */
  documentLines?: number
  /** Positive cap; omitted/invalid values leave text unlimited. */
  documentBytes?: number
  /** Max source bytes for a single embedded raster image (default 2 MiB). */
  documentImageBytes?: number
  /** Positive aggregate cap; omitted/invalid values leave text unlimited. */
  documentTotalTextBytes?: number
  /** Max aggregate embedded raster bytes (default 16 MiB). */
  documentTotalMediaBytes?: number
  /** @deprecated Accepted for source compatibility; no default head pool remains. */
  documentHeadBytes?: number
  /** @deprecated Accepted for source compatibility; no default head pool remains. */
  documentHeadTotalBytes?: number
  /**
   * Export-time precomputed positions, keyed by node element id
   * (FID-2026-0806-017). When provided, each node carries a `position` so the
   * browser runs Cytoscape's zero-math `preset` layout.
   */
  positions?: Record<string, GraphPosition>
  /**
   * Export-time container assignments, keyed by node element id
   * (FID-2026-0806-017, container-based drill-down).
   */
  containerIds?: Record<string, string>
  /**
   * Container atoms to emit as compound parent nodes (drill-down). Carries
   * id + label; `position` is read from `positions` like file nodes.
   */
  containers?: Array<{ id: string; label: string }>
  /**
   * FID-2026-0806-018: compact overview centers keyed by element id
   * (container atoms + ungrouped root files). Emitted as `overviewPosition`
   * on the overview-level elements so the collapsed overview is compact by
   * construction.
   */
  overviewPositions?: Record<string, GraphPosition>
  /**
   * FID-2026-0806-018: stable container expansion anchors keyed by container
   * element id; emitted as `overviewAnchor` on container atoms.
   */
  overviewAnchors?: Record<string, GraphPosition>
  /**
   * FID-2026-0806-018: per-container child center-frame offsets keyed by
   * container id then child element id; emitted as `childOffset` on children.
   */
  childOffsets?: Record<string, Record<string, GraphPosition>>
}

const PREVIEW_MAX_BYTES = 1024 * 1024
const DEFAULT_DOCUMENT_IMAGE_BYTES = 2 * 1024 * 1024
const DEFAULT_DOCUMENT_TOTAL_MEDIA_BYTES = 16 * 1024 * 1024
const IMAGE_TYPES: Record<string, UniverseImageDocument['mime']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
const UNSUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.heic',
  '.heif',
  '.ico',
  '.svg',
  '.tif',
  '.tiff',
])
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const REGION_COLORS = [
  '#18faf9',
  '#4fa8ff',
  '#a78bfa',
  '#f472b6',
  '#f59e0b',
  '#34d399',
  '#fb7185',
  '#22d3ee',
]

function stableHash(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function regionPath(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean)
  if (parts.length === 0) return 'root'
  // Root-level files are files, not systems. Grouping them into the ROOT
  // region keeps the systems list honest: a root file must never appear as
  // its own 1-file "system" (clicking one opened the root directory instead
  // of the file's document).
  if (parts.length === 1) return 'root'
  if (parts[0] === 'packages' && parts[1]) {
    // packages/<file> directly (e.g. packages/package.json) belongs to the
    // packages system; only a real nested subtree (packages/<sub>/…) is its
    // own system.
    return parts.length === 2 ? 'packages' : `packages/${parts[1]}`
  }
  return parts[0]
}

function regionId(region: string): string {
  return `region-${region.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

function folderId(folderPath: string): string {
  return folderPath
    ? `folder-${stableHash(folderPath).toString(16)}`
    : 'folder-root'
}

function resolveContainedPath(
  projectRoot: string,
  relativePath: string,
): { path?: string; outside: boolean } {
  const root = path.resolve(projectRoot)
  const requested = path.resolve(root, relativePath)
  if (requested === root || !requested.startsWith(root + path.sep)) {
    return { outside: true }
  }
  try {
    const realRoot = fs.realpathSync(root)
    const realPath = fs.realpathSync(requested)
    if (realPath === realRoot || !realPath.startsWith(realRoot + path.sep)) {
      return { outside: true }
    }
    return { path: realPath, outside: false }
  } catch {
    return { outside: false }
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.byteLength <= maxBytes) return text
  // Decode only a valid UTF-8 prefix. The boundary is at most four bytes away
  // from the requested cap, so this remains bounded while avoiding U+FFFD.
  for (
    let end = Math.min(maxBytes, encoded.byteLength);
    end >= Math.max(0, maxBytes - 4);
    end--
  ) {
    const bytes = encoded.subarray(0, end)
    const decoded = bytes.toString('utf8')
    if (Buffer.from(decoded, 'utf8').equals(bytes)) return decoded
  }
  return ''
}

interface DocumentBudget {
  textBytes: number
  mediaBytes: number
  maxTotalTextBytes?: number
  maxTotalMediaBytes: number
}

/**
 * Bounded head read (FID-2026-0807-015): never loads more than the head cap
 * (+1 byte to detect truncation), so multi-hundred-MB sources stay cheap.
 */
function readProbeBytes(containedPath: string): Buffer | undefined {
  let fd: number | undefined
  try {
    fd = fs.openSync(containedPath, 'r')
    const buffer = Buffer.allocUnsafe(8192)
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // Best-effort probe cleanup.
      }
    }
  }
}

function readBinarySignature(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 8192)
  if (head.includes(0)) return true
  const signatures = [
    [0x25, 0x50, 0x44, 0x46], // PDF
    [0x50, 0x4b, 0x03, 0x04], // ZIP/JAR
    [0x7f, 0x45, 0x4c, 0x46], // ELF
    [0x4d, 0x5a], // PE
  ]
  return signatures.some((signature) =>
    signature.every((byte, index) => head[index] === byte),
  )
}

function positiveLimit(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function countLines(text: string): number {
  if (!text) return 0
  let count = 1
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) count += 1
  }
  return count
}

function unavailableDocument(
  unavailableReason: UniverseUnavailableDocument['unavailableReason'],
  byteCount: number | null,
): UniverseUnavailableDocument {
  return { kind: 'unavailable', byteCount, unavailableReason }
}

function hasSignature(
  buffer: Buffer,
  mime: UniverseImageDocument['mime'],
): boolean {
  const startsWith = (bytes: number[]): boolean =>
    bytes.every((byte, index) => buffer[index] === byte)
  if (mime === 'image/png') {
    return (
      buffer.length >= 33 &&
      startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
      buffer.subarray(12, 16).toString('ascii') === 'IHDR' &&
      buffer.readUInt32BE(16) > 0 &&
      buffer.readUInt32BE(20) > 0
    )
  }
  if (mime === 'image/jpeg') {
    return (
      buffer.length >= 4 &&
      startsWith([0xff, 0xd8, 0xff]) &&
      buffer[buffer.length - 2] === 0xff &&
      buffer[buffer.length - 1] === 0xd9
    )
  }
  if (mime === 'image/gif') {
    return (
      buffer.length >= 10 &&
      (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
        buffer.subarray(0, 6).toString('ascii') === 'GIF89a') &&
      buffer.readUInt16LE(6) > 0 &&
      buffer.readUInt16LE(8) > 0
    )
  }
  return (
    buffer.length >= 30 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP' &&
    buffer.readUInt32LE(4) + 8 <= buffer.length
  )
}

function fileDocument(
  projectRoot: string,
  relativePath: string,
  maxLines: number | undefined,
  maxBytes: number | undefined,
  maxImageBytes: number,
  budget: DocumentBudget,
): UniverseDocument {
  const contained = resolveContainedPath(projectRoot, relativePath)
  if (contained.outside) return unavailableDocument('outside-root', null)
  if (!contained.path) return unavailableDocument('unreadable', null)

  let stat: fs.Stats
  try {
    stat = fs.statSync(contained.path)
  } catch {
    return unavailableDocument('unreadable', null)
  }
  if (!stat.isFile()) return unavailableDocument('unreadable', null)

  const extension = path.extname(relativePath).toLowerCase()
  const mime = IMAGE_TYPES[extension]
  if (mime && stat.size > maxImageBytes) {
    return unavailableDocument('oversized', stat.size)
  }

  if (!mime && UNSUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    return unavailableDocument('unsupported-image', stat.size)
  }
  const probe = readProbeBytes(contained.path)
  if (!probe) return unavailableDocument('unreadable', null)
  if (!mime && readBinarySignature(probe)) {
    return unavailableDocument('binary', stat.size)
  }

  let buffer: Buffer
  try {
    buffer = fs.readFileSync(contained.path)
  } catch {
    return unavailableDocument('unreadable', null)
  }
  if (mime) {
    if (!hasSignature(buffer, mime))
      return unavailableDocument('malformed-image', stat.size)
    if (budget.mediaBytes + buffer.byteLength > budget.maxTotalMediaBytes) {
      return unavailableDocument('oversized', stat.size)
    }
    budget.mediaBytes += buffer.byteLength
    return {
      kind: 'image',
      mime,
      dataUri: `data:${mime};base64,${buffer.toString('base64')}`,
      byteCount: stat.size,
      truncated: false,
    }
  }
  const source = buffer.toString('utf8')
  let text = source
  let truncated = false
  const hasExplicitTextCap =
    maxLines !== undefined ||
    maxBytes !== undefined ||
    budget.maxTotalTextBytes !== undefined
  if (maxLines !== undefined) {
    const sourceLines = source.split(/\r?\n/)
    const selectedLines = sourceLines.slice(0, maxLines)
    text = selectedLines.join('\n')
    truncated = selectedLines.length < sourceLines.length
  }
  if (maxBytes !== undefined && Buffer.byteLength(text, 'utf8') > maxBytes) {
    text = truncateUtf8(text, maxBytes)
    truncated = true
  }
  const embeddedBytes = Buffer.byteLength(text, 'utf8')
  if (
    budget.maxTotalTextBytes !== undefined &&
    budget.textBytes + embeddedBytes > budget.maxTotalTextBytes
  ) {
    const remaining = Math.max(0, budget.maxTotalTextBytes - budget.textBytes)
    text = truncateUtf8(text, remaining)
    truncated = true
  }
  const finalBytes = Buffer.byteLength(text, 'utf8')
  budget.textBytes += finalBytes
  return {
    kind: 'text',
    text,
    lineCount: countLines(text),
    byteCount: stat.size,
    truncated,
    explicitlyCapped: truncated && hasExplicitTextCap,
  }
}

function buildHierarchy(
  fileRows: Array<{ id: number; path: string }>,
): UniverseFolder[] {
  const folders = new Map<string, Set<string>>()
  folders.set('', new Set())
  for (const file of fileRows) {
    const parts = file.path.split('/').filter(Boolean)
    const fileId = `file-${file.id}`
    const folderParts = parts.slice(0, -1)
    for (let index = 0; index <= folderParts.length; index++) {
      const currentPath = folderParts.slice(0, index).join('/')
      const parentPath = folderParts.slice(0, index - 1).join('/')
      if (!folders.has(currentPath)) folders.set(currentPath, new Set())
      if (index > 0) folders.get(parentPath)?.add(folderId(currentPath))
    }
    folders.get(folderParts.join('/'))?.add(fileId)
  }
  return [...folders.keys()].sort().map((currentPath) => {
    const parts = currentPath.split('/').filter(Boolean)
    const parentPath = parts.slice(0, -1).join('/')
    const children = [...(folders.get(currentPath) ?? [])].sort((a, b) => {
      const aFolder = a.startsWith('folder-')
      const bFolder = b.startsWith('folder-')
      if (aFolder !== bFolder) return aFolder ? -1 : 1
      return a.localeCompare(b)
    })
    return {
      id: folderId(currentPath),
      label: currentPath ? parts[parts.length - 1] : 'ROOT / repository',
      path: currentPath,
      parentId: currentPath ? folderId(parentPath) : null,
      childIds: children,
    }
  })
}

function buildUniverse(
  fileRows: Array<{ id: number; path: string; cluster_id: number | null }>,
  edgeRows: Array<{
    source_id: number
    target_id: number
    type: EdgeType
    weight: number
  }>,
  projectRoot?: string,
  documentsEnabled = false,
  documentLines: number | undefined = undefined,
  documentBytes: number | undefined = undefined,
  documentImageBytes = DEFAULT_DOCUMENT_IMAGE_BYTES,
  documentTotalTextBytes: number | undefined = undefined,
  documentTotalMediaBytes = DEFAULT_DOCUMENT_TOTAL_MEDIA_BYTES,
  previewsEnabled = false,
  previewLines = 20,
  previewChars = 2000,
): GraphUniverse {
  const regionByFile = new Map<number, string>()
  const regionFiles = new Map<string, typeof fileRows>()
  for (const file of fileRows) {
    const key = regionPath(file.path)
    regionByFile.set(file.id, key)
    const files = regionFiles.get(key) ?? []
    files.push(file)
    regionFiles.set(key, files)
  }

  const regionKeyById = new Map(
    [...regionFiles.keys()].map((key) => [regionId(key), key]),
  )
  const regionEdgeCounts = new Map<string, number>()
  const degreeByFile = new Map<number, number>()
  for (const edge of edgeRows) {
    degreeByFile.set(
      edge.source_id,
      (degreeByFile.get(edge.source_id) ?? 0) + 1,
    )
    degreeByFile.set(
      edge.target_id,
      (degreeByFile.get(edge.target_id) ?? 0) + 1,
    )
    const sourceRegion = regionByFile.get(edge.source_id)
    const targetRegion = regionByFile.get(edge.target_id)
    if (sourceRegion)
      regionEdgeCounts.set(
        sourceRegion,
        (regionEdgeCounts.get(sourceRegion) ?? 0) + 1,
      )
    if (targetRegion && targetRegion !== sourceRegion)
      regionEdgeCounts.set(
        targetRegion,
        (regionEdgeCounts.get(targetRegion) ?? 0) + 1,
      )
  }

  const corridorMap = new Map<string, UniverseCorridor>()
  const universeEdges: UniverseEdge[] = edgeRows.map((edge) => ({
    id: `edge-${edge.source_id}-${edge.target_id}-${edge.type}`,
    source: `file-${edge.source_id}`,
    target: `file-${edge.target_id}`,
    type: edge.type,
    weight: edge.weight,
  }))
  for (const edge of edgeRows) {
    const sourceRegion = regionByFile.get(edge.source_id)
    const targetRegion = regionByFile.get(edge.target_id)
    if (!sourceRegion || !targetRegion || sourceRegion === targetRegion)
      continue
    const key = `${sourceRegion}->${targetRegion}`
    const current = corridorMap.get(key) ?? {
      id: `corridor-${stableHash(key).toString(16)}`,
      source: regionId(sourceRegion),
      target: regionId(targetRegion),
      edgeCount: 0,
      totalWeight: 0,
      typeCounts: {},
      underlyingEdgeIds: [],
    }
    current.edgeCount += 1
    current.totalWeight += edge.weight
    current.typeCounts[edge.type] = (current.typeCounts[edge.type] ?? 0) + 1
    current.underlyingEdgeIds.push(
      `edge-${edge.source_id}-${edge.target_id}-${edge.type}`,
    )
    corridorMap.set(key, current)
  }

  // ROOT first (the repository-level system), then deterministic path order.
  const regionKeys = [...regionFiles.keys()].sort((a, b) =>
    a === 'root' ? -1 : b === 'root' ? 1 : a.localeCompare(b),
  )
  const regionPositions = new Map<string, GraphPosition>()
  const regionCount = Math.max(1, regionKeys.length)
  const radius = Math.max(520, regionCount * 95)
  for (let i = 0; i < regionKeys.length; i++) {
    const angle = (i / regionCount) * Math.PI * 2 - Math.PI / 2
    regionPositions.set(regionKeys[i], {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    })
  }

  // Bounded export-time relaxation: aggregate corridors pull systems together,
  // while repulsion keeps the universe spatially legible.
  for (let iteration = 0; iteration < 90; iteration++) {
    const delta = new Map(regionKeys.map((key) => [key, { x: 0, y: 0 }]))
    for (let i = 0; i < regionKeys.length; i++) {
      for (let j = i + 1; j < regionKeys.length; j++) {
        const a = regionKeys[i]
        const b = regionKeys[j]
        const pa = regionPositions.get(a) as GraphPosition
        const pb = regionPositions.get(b) as GraphPosition
        const dx = pa.x - pb.x
        const dy = pa.y - pb.y
        const distance = Math.max(80, Math.hypot(dx, dy))
        const force = 18000 / (distance * distance)
        const ax = (dx / distance) * force
        const ay = (dy / distance) * force
        delta.get(a)!.x += ax
        delta.get(a)!.y += ay
        delta.get(b)!.x -= ax
        delta.get(b)!.y -= ay
      }
    }
    for (const corridor of corridorMap.values()) {
      const source = regionKeyById.get(corridor.source)
      const target = regionKeyById.get(corridor.target)
      if (!source || !target) continue
      const a = regionPositions.get(source) as GraphPosition
      const b = regionPositions.get(target) as GraphPosition
      const dx = b.x - a.x
      const dy = b.y - a.y
      const distance = Math.max(1, Math.hypot(dx, dy))
      const force = Math.min(18, corridor.totalWeight / distance)
      delta.get(source)!.x += (dx / distance) * force
      delta.get(source)!.y += (dy / distance) * force
      delta.get(target)!.x -= (dx / distance) * force
      delta.get(target)!.y -= (dy / distance) * force
    }
    for (const key of regionKeys) {
      const position = regionPositions.get(key) as GraphPosition
      const movement = delta.get(key)!
      position.x += movement.x * 0.8
      position.y += movement.y * 0.8
    }
  }

  const regions: UniverseRegion[] = regionKeys.map((key, index) => {
    const files = regionFiles.get(key) ?? []
    const edgeCount = regionEdgeCounts.get(key) ?? 0
    const clusters = files
      .map((file) => file.cluster_id)
      .filter((cluster): cluster is number => cluster !== null)
    const cluster =
      clusters.length > 0 ? clusters.sort((a, b) => a - b)[0] : null
    return {
      id: regionId(key),
      label: key === 'root' ? 'ROOT / repository' : key,
      path: key,
      fileCount: files.length,
      edgeCount,
      position: regionPositions.get(key) as GraphPosition,
      size: 18 + Math.sqrt(files.length) * 5,
      color: REGION_COLORS[index % REGION_COLORS.length],
      cluster,
      // The ROOT region aggregates the repository itself; it is never
      // "isolated" even when its root-level files carry no edges.
      disconnected: edgeCount === 0 && key !== 'root',
    }
  })

  const files: UniverseFile[] = []
  for (const key of regionKeys) {
    const entries = regionFiles.get(key) ?? []
    const center = regionPositions.get(key) as GraphPosition
    const maxDegree = Math.max(
      1,
      ...entries.map((file) => degreeByFile.get(file.id) ?? 0),
    )
    const localRadius = Math.max(90, Math.sqrt(entries.length) * 28)
    entries
      .sort((a, b) => a.path.localeCompare(b.path))
      .forEach((file, index) => {
        const degree = degreeByFile.get(file.id) ?? 0
        const angle = index * GOLDEN_ANGLE + (stableHash(file.path) % 37) / 37
        const distance = Math.min(
          localRadius,
          18 +
            Math.sqrt(index + 1) *
              (localRadius / Math.sqrt(Math.max(1, entries.length))),
        )
        const universeFile: UniverseFile = {
          id: `file-${file.id}`,
          label: file.path.split('/').pop() ?? file.path,
          path: file.path,
          regionId: regionId(key),
          cluster: file.cluster_id,
          position: {
            x: center.x + Math.cos(angle) * distance,
            y: center.y + Math.sin(angle) * distance,
          },
          size: 3 + (degree / maxDegree) * 6,
          importance: degree / maxDegree,
        }
        if (previewsEnabled && projectRoot) {
          const preview = readFilePreview(
            projectRoot,
            file.path,
            previewLines,
            previewChars,
          )
          if (preview !== undefined) universeFile.preview = preview
        }
        files.push(universeFile)
      })
  }

  const folders = buildHierarchy(fileRows)
  const documents: Record<string, UniverseDocument> = {}
  if (documentsEnabled && projectRoot) {
    const budget: DocumentBudget = {
      textBytes: 0,
      mediaBytes: 0,
      maxTotalTextBytes: documentTotalTextBytes,
      maxTotalMediaBytes: documentTotalMediaBytes,
    }
    for (const file of fileRows) {
      documents[`file-${file.id}`] = fileDocument(
        projectRoot,
        file.path,
        documentLines,
        documentBytes,
        documentImageBytes,
        budget,
      )
    }
  }
  const searchIndex: GraphUniverse['searchIndex'] = [
    ...regionKeys.map((key) => ({
      id: regionId(key),
      kind: 'system' as const,
      label: key === 'root' ? 'ROOT / repository' : key,
      path: key,
    })),
    ...buildHierarchy(fileRows).map((folder) => ({
      id: folder.id,
      kind: 'folder' as const,
      label: folder.label,
      path: folder.path,
    })),
    ...fileRows.map((file) => ({
      id: `file-${file.id}`,
      kind: 'file' as const,
      label: file.path.split('/').pop() ?? file.path,
      path: file.path,
    })),
  ]
  return {
    regions,
    files,
    edges: universeEdges,
    corridors: [...corridorMap.values()].map((corridor) => ({
      ...corridor,
      underlyingEdgeIds: corridor.underlyingEdgeIds.sort(),
    })),
    folders,
    rootFolderId: folderId(''),
    documents,
    searchIndex,
    documentPolicy: {
      enabled: documentsEnabled,
      maxTextLines: documentLines ?? null,
      maxTextBytes: documentBytes ?? null,
      maxImageBytes: documentImageBytes,
      maxTotalTextBytes: documentTotalTextBytes ?? null,
      maxTotalMediaBytes: documentTotalMediaBytes,
      headBytes: null,
      headTotalBytes: null,
    },
  }
}

/**
 * Read a capped code preview for a file. Returns undefined for binary files,
 * unreadable files, paths escaping the project root, or when previews are
 * disabled via SAVANT_GRAPH_EXPORT_NO_PREVIEW=1.
 */
export function readFilePreview(
  projectRoot: string,
  relativePath: string,
  maxLines: number,
  maxChars: number,
): string | undefined {
  // A hostile relative path (.., drive letter, or symlink) must never escape
  // the project root or read arbitrary files from disk.
  const contained = resolveContainedPath(projectRoot, relativePath)
  if (contained.outside || !contained.path) return undefined
  let stat: fs.Stats
  try {
    stat = fs.statSync(contained.path)
  } catch {
    return undefined
  }
  if (!stat.isFile() || stat.size > PREVIEW_MAX_BYTES) return undefined
  let buf: Buffer
  try {
    buf = fs.readFileSync(contained.path)
  } catch {
    return undefined
  }
  if (buf.length > PREVIEW_MAX_BYTES) return undefined
  // Binary probe: a NUL byte inside the first 8 KiB marks non-text content.
  if (buf.subarray(0, 8192).includes(0)) return undefined
  const lines = buf.toString('utf8').split(/\r?\n/)
  const slice = lines.slice(0, maxLines).join('\n')
  const capped =
    slice.length > maxChars ? slice.slice(0, maxChars) + '\n…' : slice
  return capped.length > 0 ? capped : undefined
}

export function serializeGraphForExport(
  db: Database,
  options: GraphExportOptions = {},
): GraphExport {
  const {
    projectRoot,
    previewLines = 20,
    previewChars = 2000,
    documentLines,
    documentBytes,
    documentImageBytes = DEFAULT_DOCUMENT_IMAGE_BYTES,
    documentTotalTextBytes,
    documentTotalMediaBytes = DEFAULT_DOCUMENT_TOTAL_MEDIA_BYTES,
  } = options
  const normalizedDocumentLines = positiveLimit(documentLines)
  const normalizedDocumentBytes = positiveLimit(documentBytes)
  const normalizedDocumentTotalTextBytes = positiveLimit(documentTotalTextBytes)
  // FID-2026-0806-017: previews are OFF by default (inverted opt-in). The old
  // hard-off flag is still honored as a final gate so the strict
  // metadata-only posture is impossible to accidentally weaken.
  const previewsEnabled =
    process.env.SAVANT_GRAPH_EXPORT_PREVIEWS === '1' &&
    process.env.SAVANT_GRAPH_EXPORT_NO_PREVIEW !== '1'
  const documentsEnabled =
    options.documents === true &&
    Boolean(projectRoot) &&
    process.env.SAVANT_GRAPH_EXPORT_DOCUMENTS !== '0' &&
    process.env.SAVANT_GRAPH_EXPORT_NO_PREVIEW !== '1'

  const fileRows = db
    .query(
      `SELECT f.id, f.path, n.cluster_id
       FROM files f
       LEFT JOIN nodes n ON n.file_id = f.id AND n.type = 'file'
       ORDER BY f.path`,
    )
    .all() as Array<{ id: number; path: string; cluster_id: number | null }>

  const symbolCount = (
    db.query(`SELECT COUNT(*) AS c FROM nodes WHERE type = 'symbol'`).get() as {
      c: number
    }
  ).c
  const edgeRows = db
    .query('SELECT source_id, target_id, type, weight FROM edges')
    .all() as Array<{
    source_id: number
    target_id: number
    type: EdgeType
    weight: number
  }>

  const clusterSet = new Set<number>()
  for (const row of fileRows) {
    if (row.cluster_id !== null) clusterSet.add(row.cluster_id)
  }

  const elements: GraphExportElement[] = []

  // FID-2026-0806-017: container atoms become compound parent nodes so the
  // browser can render them collapsed with children hidden (drill-down).
  // FID-2026-0806-018: containers carry the compact overview center as their
  // preset position plus the stable expansion anchor (both center frame).
  for (const container of options.containers ?? []) {
    elements.push({
      data: {
        id: container.id,
        label: container.label,
        type: 'container',
        container: true,
        cluster: null,
        overviewPosition: options.overviewPositions?.[container.id],
        overviewAnchor: options.overviewAnchors?.[container.id],
      },
      position: options.overviewPositions?.[container.id],
    })
  }

  for (const file of fileRows) {
    const elementId = `file-${file.id}`
    const element: GraphExportElement = {
      data: {
        id: elementId,
        label: file.path.split('/').pop() ?? file.path,
        path: file.path,
        type: 'file',
        cluster: file.cluster_id,
      },
    }
    const containerId = options.containerIds?.[elementId]
    if (containerId) {
      element.data.containerId = containerId
      // Compound parent linkage — Cytoscape renders the container atom as a
      // parent node that encloses its children (collapsed drill-down).
      element.data.parent = containerId
      // FID-2026-0806-018: children never receive an absolute preset position;
      // they stay hidden while the container is collapsed, and expansion
      // positions them at `overviewAnchor + childOffset` (no browser layout).
      element.data.childOffset =
        options.childOffsets?.[containerId]?.[elementId]
    } else if (
      options.overviewPositions &&
      options.overviewPositions[elementId]
    ) {
      // Ungrouped root file — part of the compact overview; carries its
      // overview center as the preset position.
      element.position = options.overviewPositions[elementId]
    } else if (options.positions && options.positions[elementId]) {
      element.position = options.positions[elementId]
    }
    if (projectRoot && previewsEnabled) {
      const preview = readFilePreview(
        projectRoot,
        file.path,
        previewLines,
        previewChars,
      )
      if (preview !== undefined) element.data.preview = preview
    }
    elements.push(element)
  }

  for (const edge of edgeRows) {
    elements.push({
      data: {
        id: `edge-${edge.source_id}-${edge.target_id}-${edge.type}`,
        source: `file-${edge.source_id}`,
        target: `file-${edge.target_id}`,
        label: edge.type,
        type: edge.type,
        weight: edge.weight,
      },
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    meta: {
      files: fileRows.length,
      nodes: fileRows.length + symbolCount,
      edges: edgeRows.length,
      clusters: clusterSet.size,
    },
    elements,
    universe: buildUniverse(
      fileRows,
      edgeRows,
      projectRoot,
      documentsEnabled,
      normalizedDocumentLines,
      normalizedDocumentBytes,
      documentImageBytes,
      normalizedDocumentTotalTextBytes,
      documentTotalMediaBytes,
      previewsEnabled,
      previewLines,
      previewChars,
    ),
  }
}
