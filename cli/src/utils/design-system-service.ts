import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  BUILT_IN_DESIGN_SYSTEM_COUNT,
  getDefaultDesignSystemResource,
  loadDesignManifest,
  normalizeDesignSystemSource,
  resolveActiveDesignSystem,
  resolveEmbeddedDesignSystem,
  listDesignDrafts,
  getDesignDraft,
  discardDesignDraft,
  saveDesignDraft,
  clearDesignDraft,
  toDesignContract,
  validateDesignAuthoringInput,
  designSystemProvenanceSchema,
  type ActiveDesignSystem,
  type DesignAuthoringInputV1,
  type DesignSystemResource,
} from '@savant-code/design-systems'

import { getProjectRoot } from '../project-files'
import { loadSettings, saveSettings } from './settings'
import { writeFileAtomic } from './write-file-atomic'

const DESIGN_SYSTEM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CUSTOM_MANIFEST_VERSION = 1
const CUSTOM_MANIFEST_FILE = 'manifest.json'
const CUSTOM_JOURNAL_FILE = 'manifest.commit.json'

function projectRootOrCwd(): string {
  try {
    return getProjectRoot()
  } catch {
    return process.cwd()
  }
}

function candidateSkillRoots(): string[] {
  const executableDir = path.dirname(process.execPath)
  const sourceRoot = path.resolve(
    import.meta.dir,
    '../../../.agents/skills/savant-design-systems',
  )
  const projectRoot = projectRootOrCwd()
  const home = process.env.HOME ?? process.env.USERPROFILE
  return [
    sourceRoot,
    path.join(projectRoot, '.agents', 'skills', 'savant-design-systems'),
    path.join(executableDir, 'savant-design-systems'),
    path.join(executableDir, 'resources', 'savant-design-systems'),
    ...(home
      ? [path.join(home, '.agents', 'skills', 'savant-design-systems')]
      : []),
  ]
}

function findSkillRoot(): string {
  const root = candidateSkillRoots().find((candidate) =>
    fs.existsSync(path.join(candidate, 'manifest.json')),
  )
  if (!root) {
    throw new Error(
      'The savant-design-systems skill is unavailable. Reinstall the CLI or restore its packaged resources.',
    )
  }
  return root
}

function manifest() {
  return loadDesignManifest(path.join(findSkillRoot(), 'manifest.json'))
}

function resolveBuiltIn(id: string): DesignSystemResource | undefined {
  if (!DESIGN_SYSTEM_ID.test(id)) return undefined
  const currentManifest = manifest()
  if (!currentManifest.resources.some((item) => item.id === id))
    return undefined
  return resolveEmbeddedDesignSystem({
    skillRoot: findSkillRoot(),
    manifest: currentManifest,
    id,
  })
}

function customRoot(scope: 'project' | 'user'): string {
  if (scope === 'project') {
    return path.join(projectRootOrCwd(), '.savant', 'design-systems')
  }
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (!home) throw new Error('Cannot resolve the user design-system directory.')
  return path.join(home, '.savant', 'design-systems')
}

function customManifestPath(scope: 'project' | 'user'): string {
  return path.join(customRoot(scope), CUSTOM_MANIFEST_FILE)
}

function customJournalPath(scope: 'project' | 'user'): string {
  return path.join(customRoot(scope), CUSTOM_JOURNAL_FILE)
}

const VERSION_FILE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-f0-9]{64}\.design\.md$/

interface PendingCommit {
  id: string
  versionPath: string
  sourceContentHash: string
  manifestHash: string
  createdVersion: boolean
}

function isPendingCommit(value: unknown): value is PendingCommit {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PendingCommit>
  return (
    typeof candidate.id === 'string' &&
    DESIGN_SYSTEM_ID.test(candidate.id) &&
    typeof candidate.versionPath === 'string' &&
    VERSION_FILE.test(candidate.versionPath) &&
    typeof candidate.sourceContentHash === 'string' &&
    /^[a-f0-9]{64}$/.test(candidate.sourceContentHash) &&
    typeof candidate.manifestHash === 'string' &&
    /^[a-f0-9]{64}$/.test(candidate.manifestHash) &&
    typeof candidate.createdVersion === 'boolean' &&
    candidate.versionPath ===
      `${candidate.id}.${candidate.sourceContentHash}.design.md`
  )
}

function safeVersionPath(
  root: string,
  versionPath: string,
): string | undefined {
  if (!VERSION_FILE.test(versionPath)) return undefined
  const candidate = path.resolve(root, versionPath)
  const relative = path.relative(path.resolve(root), candidate)
  return relative.startsWith('..') || path.isAbsolute(relative)
    ? undefined
    : candidate
}

function reconcilePendingCommit(scope: 'project' | 'user'): void {
  const journalPath = customJournalPath(scope)
  if (!fs.existsSync(journalPath)) return

  let journal: PendingCommit
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    if (!isPendingCommit(parsed)) throw new Error('journal schema is invalid')
    journal = parsed
  } catch (error) {
    // Preserve malformed evidence under a non-authoritative name and surface a
    // repairable error instead of deleting it or silently ignoring corruption.
    const quarantined = `${journalPath}.corrupt.${Date.now()}`
    fs.renameSync(journalPath, quarantined)
    throw new Error(
      `Design-system commit journal is corrupt and was quarantined at ${quarantined}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const manifestPath = customManifestPath(scope)
  const manifestCommitted =
    fs.existsSync(manifestPath) &&
    sha256(fs.readFileSync(manifestPath, 'utf8')) === journal.manifestHash
  if (manifestCommitted) {
    let committed = false
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        const entries = (parsed as { entries?: unknown }).entries
        if (Array.isArray(entries)) {
          committed = entries.some((entry) => {
            if (!entry || typeof entry !== 'object') return false
            const candidate = entry as Partial<CustomManifestEntry>
            return (
              candidate.id === journal.id &&
              candidate.versionPath === journal.versionPath &&
              candidate.sourceContentHash === journal.sourceContentHash
            )
          })
        }
      }
    } catch {
      committed = false
    }
    // The manifest is the commit point only when its bytes and matching entry
    // both prove this exact journaled transaction completed.
    if (committed) {
      fs.rmSync(journalPath, { force: true })
      return
    }
  }

  // The manifest is still the last known-good state. Retain every orphaned
  // version for explicit repair: a journal is not sufficient authority to
  // delete any user-authored revision, even when its fields are internally
  // consistent. Clearing the marker cannot activate an invalid file.
  fs.rmSync(journalPath, { force: true })
}

function canonicalExistingPath(filePath: string): string {
  const resolved = path.resolve(filePath)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function canonicalContainedPath(root: string, candidate: string): string {
  const canonicalRoot = canonicalExistingPath(root)
  const canonicalCandidate = canonicalExistingPath(candidate)
  const relative = path.relative(canonicalRoot, canonicalCandidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Design-system source escapes its approved root: ${candidate}`,
    )
  }
  return canonicalCandidate
}

function ensureRegularFile(filePath: string): void {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Design-system source must be a regular file: ${filePath}`)
  }
}

interface CustomManifestEntry {
  id: string
  versionPath: string
  sourceContentHash: string
  normalizedContentHash: string
  provenance: DesignSystemResource['provenance']
}

export interface DesignSystemRevision {
  id: string
  scope: 'project' | 'user'
  previousSourceContentHash?: string
  sourceContentHash: string
  normalizedContentHash: string
  valid: true
  timestamp: string
}

interface CustomManifest {
  version: 1
  entries: CustomManifestEntry[]
  revisions: DesignSystemRevision[]
}

function reconcileCustomArtifacts(
  scope: 'project' | 'user',
  manifest: CustomManifest,
): void {
  const root = customRoot(scope)
  const retained = new Set([
    ...manifest.entries.map((entry) => entry.versionPath),
    ...manifest.revisions
      .filter((revision) =>
        VERSION_FILE.test(
          `${revision.id}.${revision.sourceContentHash}.design.md`,
        ),
      )
      .map(
        (revision) => `${revision.id}.${revision.sourceContentHash}.design.md`,
      ),
  ])
  for (const name of fs.readdirSync(root, { withFileTypes: true })) {
    if (name.isDirectory()) continue
    if (name.name.endsWith('.tmp')) {
      fs.rmSync(path.join(root, name.name), { force: true })
      continue
    }
    // Unreferenced version files are retained for explicit repair. Automatic
    // startup cleanup must never delete a user-authored revision merely
    // because a manifest or journal is incomplete.
    if (
      /^.+\.[a-f0-9]{64}\.design\.md$/i.test(name.name) &&
      !retained.has(name.name)
    ) {
      continue
    }
  }
}

function readCustomManifest(scope: 'project' | 'user'): CustomManifest {
  fs.mkdirSync(customRoot(scope), { recursive: true })
  reconcilePendingCommit(scope)
  const manifestPath = customManifestPath(scope)
  if (!fs.existsSync(manifestPath))
    return { version: CUSTOM_MANIFEST_VERSION, entries: [], revisions: [] }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as Partial<CustomManifest>
    if (
      parsed.version !== CUSTOM_MANIFEST_VERSION ||
      !Array.isArray(parsed.entries)
    ) {
      throw new Error(
        'Invalid custom design-system manifest version or entries.',
      )
    }
    const revisions = Array.isArray(parsed.revisions)
      ? parsed.revisions.filter(
          (revision): revision is DesignSystemRevision =>
            Boolean(revision) &&
            typeof revision.id === 'string' &&
            (revision.scope === 'project' || revision.scope === 'user') &&
            typeof revision.sourceContentHash === 'string' &&
            typeof revision.normalizedContentHash === 'string' &&
            revision.valid === true &&
            typeof revision.timestamp === 'string',
        )
      : []
    const entries = parsed.entries.flatMap((entry): CustomManifestEntry[] => {
      if (
        !entry ||
        typeof entry.id !== 'string' ||
        !DESIGN_SYSTEM_ID.test(entry.id) ||
        typeof entry.versionPath !== 'string' ||
        !safeVersionPath(customRoot(scope), entry.versionPath) ||
        typeof entry.sourceContentHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.sourceContentHash) ||
        typeof entry.normalizedContentHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.normalizedContentHash)
      ) {
        throw new Error('Custom manifest contains an invalid resource entry.')
      }
      const provenance = designSystemProvenanceSchema.safeParse(
        entry.provenance,
      )
      if (!provenance.success) {
        throw new Error(
          `Custom manifest provenance is invalid for ${entry.id}.`,
        )
      }
      return [
        {
          id: entry.id,
          versionPath: entry.versionPath,
          sourceContentHash: entry.sourceContentHash,
          normalizedContentHash: entry.normalizedContentHash,
          provenance: provenance.data,
        },
      ]
    })
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      throw new Error('Custom manifest contains duplicate design-system IDs.')
    }
    const result: CustomManifest = {
      version: CUSTOM_MANIFEST_VERSION,
      entries,
      revisions,
    }
    reconcileCustomArtifacts(scope, result)
    return result
  } catch (error) {
    throw new Error(
      `Invalid ${scope} design-system manifest: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sourcePathFor(scope: 'project' | 'user', id: string): string {
  return `custom/${scope}/${id}.design.md`
}

function resolveManifestCustom(
  scope: 'project' | 'user',
  id: string,
): DesignSystemResource | undefined {
  const root = customRoot(scope)
  const entry = readCustomManifest(scope).entries.find((item) => item.id === id)
  if (!entry) return undefined
  const versionPath = safeVersionPath(root, entry.versionPath)
  if (!versionPath) {
    throw new Error(
      `Custom design-system version escapes its approved root: ${id}`,
    )
  }
  const rootCanonical = canonicalExistingPath(root)
  const versionCanonical = canonicalExistingPath(versionPath)
  const relative = path.relative(rootCanonical, versionCanonical)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Custom design-system version escapes its approved root: ${id}`,
    )
  }
  if (!fs.existsSync(versionCanonical)) {
    throw new Error(`Custom design-system version is missing: ${id}`)
  }
  ensureRegularFile(versionCanonical)
  const verifiedVersionPath = safeVersionPath(rootCanonical, entry.versionPath)
  if (!verifiedVersionPath) {
    throw new Error(
      `Custom design-system version escapes its approved root: ${id}`,
    )
  }
  const verifiedCanonicalPath = canonicalContainedPath(
    rootCanonical,
    verifiedVersionPath,
  )
  ensureRegularFile(verifiedCanonicalPath)
  // Re-canonicalize immediately before reading so a junction/reparse-point
  // swap between validation and the read cannot redirect the source.
  const readPath = canonicalContainedPath(rootCanonical, verifiedCanonicalPath)
  ensureRegularFile(readPath)
  const sourceContent = fs.readFileSync(readPath, 'utf8')
  const resource = normalizeDesignSystemSource({
    sourceContent,
    sourcePath: sourcePathFor(scope, id),
    sourceRepository: entry.provenance.sourceRepository,
    sourceRevision: entry.provenance.sourceRevision,
    license: entry.provenance.license,
  })
  if (
    resource.sourceContentHash !== entry.sourceContentHash ||
    resource.normalizedContentHash !== entry.normalizedContentHash
  ) {
    throw new Error(`Custom design-system hash mismatch: ${id}`)
  }
  return {
    ...resource,
    contentPath: readPath,
    source: scope,
    status: 'custom',
    provenance: entry.provenance,
  }
}

function resolveLegacyCustom(
  scope: 'project' | 'user',
  id: string,
): DesignSystemResource | undefined {
  if (!DESIGN_SYSTEM_ID.test(id)) return undefined
  const root = customRoot(scope)
  const legacyPath = canonicalContainedPath(
    root,
    path.join(root, `${id}.design.md`),
  )
  if (!fs.existsSync(legacyPath)) return undefined
  ensureRegularFile(legacyPath)
  const readPath = canonicalContainedPath(root, legacyPath)
  ensureRegularFile(readPath)
  const resource = normalizeDesignSystemSource({
    sourceContent: fs.readFileSync(readPath, 'utf8'),
    sourcePath: sourcePathFor(scope, id),
    sourceRepository: 'local-custom',
    sourceRevision: 'legacy-working-tree',
    license: 'user-authored',
  })
  return {
    ...resource,
    contentPath: readPath,
    source: scope,
    status: 'custom',
  }
}

function resolveCustomInScope(
  scope: 'project' | 'user',
  id: string,
): DesignSystemResource | undefined {
  return resolveManifestCustom(scope, id) ?? resolveLegacyCustom(scope, id)
}

function listCustomDesignSystems(): DesignSystemResource[] {
  const resources: DesignSystemResource[] = []
  for (const scope of ['project', 'user'] as const) {
    const root = customRoot(scope)
    if (!fs.existsSync(root)) continue
    const ids = new Set(
      readCustomManifest(scope).entries.map((entry) => entry.id),
    )
    for (const file of fs.readdirSync(root)) {
      if (file.endsWith('.design.md'))
        ids.add(file.slice(0, -'.design.md'.length))
    }
    for (const id of [...ids].sort()) {
      try {
        const resource = resolveCustomInScope(scope, id)
        if (resource && !resources.some((item) => item.id === resource.id))
          resources.push(resource)
      } catch {
        // Corrupt custom resources are intentionally not selectable or listed as valid.
      }
    }
  }
  return resources
}

export function listDesignSystems(): DesignSystemResource[] {
  const builtIns = manifest()
    .resources.map((entry) => resolveBuiltIn(entry.id))
    .filter((item): item is DesignSystemResource => Boolean(item))
  return [
    getDefaultDesignSystemResource(),
    ...builtIns.filter((item) => item.id !== 'savant-cyberpunk'),
    ...listCustomDesignSystems(),
  ]
}

export function resolveDesignSystem(
  id: string,
): DesignSystemResource | undefined {
  if (id === 'savant-cyberpunk') return getDefaultDesignSystemResource()
  return (
    resolveDesignSystemInScope('project', id) ??
    resolveDesignSystemInScope('user', id)
  )
}

export function resolveDesignSystemReference(
  value: string,
  scope: 'project' | 'user' = 'project',
): DesignSystemResource | undefined {
  const byId = resolveDesignSystemInScope(scope, value) ?? resolveBuiltIn(value)
  if (byId) return byId
  const root = customRoot(scope)
  const candidate = canonicalContainedPath(root, value)
  if (!fs.existsSync(candidate)) return undefined
  ensureRegularFile(candidate)
  // Path references are restricted to the approved custom root and checked
  // again immediately before reading to resist reparse-point replacement.
  const readPath = canonicalContainedPath(root, candidate)
  ensureRegularFile(readPath)
  const parsed = normalizeDesignSystemSource({
    sourceContent: fs.readFileSync(readPath, 'utf8'),
    sourcePath: `references/${path.basename(readPath)}`,
    sourceRepository: 'path-reference',
    sourceRevision: 'working-tree',
    license: 'user-provided',
  })
  return {
    ...parsed,
    source: scope,
    status: 'custom',
    contentPath: readPath,
    provenance: {
      ...parsed.provenance,
      sourcePath: readPath,
    },
  }
}

export function resolveDesignSystemInScope(
  scope: 'project' | 'user' | 'embedded',
  id: string,
): DesignSystemResource | undefined {
  if (scope === 'embedded') {
    return id === 'savant-cyberpunk'
      ? getDefaultDesignSystemResource()
      : resolveBuiltIn(id)
  }
  return resolveCustomInScope(scope, id)
}

export function getDesignSystemSelection(): {
  project?: string
  user?: string
} {
  const settings = loadSettings()
  const projectSelectionPath = path.join(
    customRoot('project'),
    'selection.json',
  )
  let project: string | undefined
  if (fs.existsSync(projectSelectionPath)) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(projectSelectionPath, 'utf8'),
      ) as { id?: unknown }
      if (typeof parsed.id === 'string' && DESIGN_SYSTEM_ID.test(parsed.id))
        project = parsed.id
    } catch {
      throw new Error(
        'Project design-system selection is corrupt; run /design reset --project.',
      )
    }
  }
  return { project, user: settings.designSystemUser }
}

function setProjectSelection(id: string | undefined): void {
  const root = customRoot('project')
  if (id === undefined) {
    const selectionPath = path.join(root, 'selection.json')
    if (fs.existsSync(selectionPath)) fs.rmSync(selectionPath)
    return
  }
  fs.mkdirSync(root, { recursive: true })
  writeFileAtomic(
    path.join(root, 'selection.json'),
    `${JSON.stringify({ id }, null, 2)}\n`,
  )
}

export function setDesignSystemSelection(
  scope: 'project' | 'user',
  id: string,
): void {
  const resource =
    scope === 'project' || scope === 'user'
      ? (resolveDesignSystemInScope(scope, id) ?? resolveBuiltIn(id))
      : resolveDesignSystem(id)
  if (!resource)
    throw new Error(`Cannot activate unavailable design system: ${id}`)
  if (scope === 'project') {
    setProjectSelection(resource.id)
  } else {
    saveSettings({ designSystemUser: resource.id })
  }
}

export function resetDesignSystemSelection(
  scope: 'project' | 'user' | 'all' = 'all',
): void {
  if (scope === 'project' || scope === 'all') setProjectSelection(undefined)
  if (scope === 'user' || scope === 'all')
    saveSettings({ designSystemUser: undefined })
}

export function resolveCurrentDesignSystem(
  session?: string,
): ActiveDesignSystem {
  const selection = getDesignSystemSelection()
  return resolveActiveDesignSystem({
    selection: { session, project: selection.project, user: selection.user },
    resolve: resolveDesignSystem,
    resolveScoped: (scope, id) =>
      scope === 'session'
        ? resolveDesignSystem(id)
        : scope === 'project' || scope === 'user'
          ? (resolveDesignSystemInScope(scope, id) ??
            (scope === 'project' || scope === 'user'
              ? resolveBuiltIn(id)
              : undefined))
          : resolveDesignSystem(id),
  })
}

export function getActiveDesignContract() {
  return toDesignContract(resolveCurrentDesignSystem())
}

export function validateDesignInput(input: unknown) {
  return validateDesignAuthoringInput(input)
}

export function designDraftRoot(scope: 'project' | 'user'): string {
  return customRoot(scope)
}

export function listCustomDesignDrafts(scope: 'project' | 'user') {
  return listDesignDrafts(designDraftRoot(scope))
}

export function saveCustomDesignDraft(
  scope: 'project' | 'user',
  input: DesignAuthoringInputV1,
  draftId?: string,
) {
  return saveDesignDraft(designDraftRoot(scope), input, draftId)
}

export function getCustomDesignDraft(
  scope: 'project' | 'user',
  draftId: string,
) {
  return getDesignDraft(designDraftRoot(scope), draftId)
}

export function discardCustomDesignDraft(
  scope: 'project' | 'user',
  draftId: string,
): boolean {
  return discardDesignDraft(designDraftRoot(scope), draftId)
}

export function clearCustomDesignDraft(
  scope: 'project' | 'user',
  draftId: string,
): void {
  clearDesignDraft(designDraftRoot(scope), draftId)
}

export function importCustomDesignSystem(
  sourcePath: string,
  scope: 'project' | 'user',
  activate: boolean,
): DesignSystemResource {
  const resolved = canonicalExistingPath(sourcePath)
  if (!fs.existsSync(resolved)) {
    throw new Error(`Design-system source file not found: ${sourcePath}`)
  }
  ensureRegularFile(resolved)
  const source = fs.readFileSync(resolved, 'utf8')
  const normalized = normalizeDesignSystemSource({
    sourceContent: source,
    sourcePath: `imports/${path.basename(resolved)}`,
    sourceRepository: 'user-import',
    sourceRevision: 'imported-working-tree',
    license: 'user-provided',
  })
  const input: DesignAuthoringInputV1 = {
    schemaVersion: '1',
    id: normalized.id,
    displayName: normalized.displayName,
    description: normalized.description,
    scope,
    targets: normalized.targets,
    colors: normalized.tokens.colors,
    typography: normalized.tokens.typography,
    spacing: normalized.tokens.spacing,
    radius: normalized.tokens.radius,
    components: normalized.tokens.components,
    accessibility: {},
    activate,
    provenance: {
      ...normalized.provenance,
      sourcePath: resolved,
    },
  }
  return saveCustomDesignSystem(input)
}

export function saveCustomDesignSystem(
  input: DesignAuthoringInputV1,
): DesignSystemResource {
  const result = validateDesignAuthoringInput(input)
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
  const root = customRoot(input.scope)
  fs.mkdirSync(root, { recursive: true })
  const sourceHash = result.resource.sourceContentHash
  const versionPath = `${input.id}.${sourceHash}.design.md`
  const destination = path.join(root, versionPath)
  const current = readCustomManifest(input.scope)
  const previous = current.entries.find((entry) => entry.id === input.id)
  const createdVersion = !fs.existsSync(destination)
  const entries = current.entries.filter((entry) => entry.id !== input.id)
  entries.push({
    id: input.id,
    versionPath,
    sourceContentHash: result.resource.sourceContentHash,
    normalizedContentHash: result.resource.normalizedContentHash,
    provenance: result.resource.provenance,
  })
  entries.sort((left, right) => left.id.localeCompare(right.id))
  const revisions = [
    ...current.revisions,
    {
      id: input.id,
      scope: input.scope,
      ...(previous
        ? { previousSourceContentHash: previous.sourceContentHash }
        : {}),
      sourceContentHash: result.resource.sourceContentHash,
      normalizedContentHash: result.resource.normalizedContentHash,
      valid: true as const,
      timestamp: new Date().toISOString(),
    },
  ]
  const manifestContent = `${JSON.stringify({ version: CUSTOM_MANIFEST_VERSION, entries, revisions }, null, 2)}\n`
  // Journal the intended commit before writing either artifact. The manifest
  // hash lets startup distinguish a committed transaction from an interrupted
  // one; createdVersion prevents cleanup from deleting a pre-existing revision.
  writeFileAtomic(
    customJournalPath(input.scope),
    `${JSON.stringify(
      {
        id: input.id,
        versionPath,
        sourceContentHash: result.resource.sourceContentHash,
        manifestHash: sha256(manifestContent),
        createdVersion,
      },
      null,
      2,
    )}\n`,
  )
  try {
    if (createdVersion) writeFileAtomic(destination, result.source)
    writeFileAtomic(customManifestPath(input.scope), manifestContent)
    // The manifest rename is the commit point. The journal is intentionally
    // cleared only after that durable rename succeeds.
  } catch (error) {
    reconcilePendingCommit(input.scope)
    throw error
  }
  fs.rmSync(customJournalPath(input.scope), { force: true })
  const resource = {
    ...result.resource,
    contentPath: destination,
    source: input.scope,
    status: 'custom' as const,
  }
  if (input.activate) setDesignSystemSelection(input.scope, input.id)
  return resource
}

export const DESIGN_SYSTEM_BUILT_IN_COUNT = BUILT_IN_DESIGN_SYSTEM_COUNT
