import fs from 'fs'
import vm from 'node:vm'
import os from 'os'
import path from 'path'

import {
  openGraphDatabase,
  serializeGraphForExport,
  updateKnowledgeGraph,
} from '@savant-code/knowledge-graph'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { setProjectRoot } from '../../project-files'
import { useChatStore } from '../../state/chat-store'
import { handleGraphExportCommand } from '../graph-export'
import {
  GRAPH_AUDIO_CUE_COUNT,
  GRAPH_AUDIO_MAX_REGISTRY_BYTES,
  getGraphAudioCues,
} from '../graph-export/audio'
import { GRAPH_AUDIO_MANIFEST } from '../graph-export/audio/manifest'
import { UniverseAudioManager } from '../graph-export/audio-manager'
import { CHARACTER_LOGO_DATA_URI } from '../graph-export/character'
import { computeGraphLayout } from '../graph-export/layout'
import { handleGraphRefreshCommand } from '../graph-refresh'

import type { ChatMessage } from '../../types/chat'
import type { RouterParams } from '../command-registry'

describe('knowledge-graph commands', () => {
  let tempDir: string
  let renderedMessages: ChatMessage[]
  let messageSnapshots: ChatMessage[][]

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'savant-graph-cmd-'))
    setProjectRoot(tempDir)
    renderedMessages = []
    messageSnapshots = []
    useChatStore.setState({
      messages: [],
      chatSessionId: 'test-session-1234',
    })
  })

  afterEach(() => {
    useChatStore.setState({ messages: [], chatSessionId: '' })
    // Windows can briefly hold SQLite file locks after a handle closes (WAL
    // sidecars). Retry the recursive delete so a transient EBUSY doesn't
    // fail unrelated cleanup.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
        break
      } catch {
        Bun.sleepSync(50)
      }
    }
  })

  function renderedText(): string {
    return renderedMessages.map((m) => m.content ?? '').join('\n')
  }

  /** Extract the gzip/plain docs payload from a generated artifact and decode it. */
  function decodeDocsPayload(html: string): Record<string, unknown> {
    const anchor = '<script type="text/plain" id="savant-docs-payload">'
    const start = html.indexOf(anchor)
    const open = html.indexOf('>', start)
    const end = html.indexOf('</script>', open)
    const meta = JSON.parse(html.slice(open + 1, end)) as {
      mode: 'gzip' | 'plain'
      payload: string
    }
    if (meta.mode === 'plain') return JSON.parse(meta.payload)
    return JSON.parse(
      Buffer.from(Bun.gunzipSync(Buffer.from(meta.payload, 'base64'))).toString(
        'utf8',
      ),
    ) as Record<string, unknown>
  }

  function makeParams(inputValue = '/graph refresh'): RouterParams {
    return {
      inputRef: { current: null },
      setMessages: mock(
        (update: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
          renderedMessages =
            typeof update === 'function' ? update(renderedMessages) : update
          messageSnapshots.push([...renderedMessages])
        },
      ),
      saveToHistory: mock(() => {}),
      setInputValue: mock(() => {}),
      setInputFocused: mock(() => {}),
      setIsAuthenticated: mock(() => {}),
      setUser: mock(() => {}),
      addToQueue: mock(() => {}),
      clearMessages: mock(() => {}),
      scrollToLatest: mock(() => {}),
      sendMessage: mock(async () => {}),
      setCanProcessQueue: mock(() => {}),
      setStreamStatus: mock(() => {}),
      inputValue,
      agentMode: 'HYBRID',
      isChainInProgressRef: { current: false },
      isStreaming: false,
      streamMessageIdRef: { current: null },
      abortControllerRef: { current: null },
      logoutMutation: {} as RouterParams['logoutMutation'],
    } as unknown as RouterParams
  }

  /** Build a tiny real graph index in tempDir (src/a.ts imports src/b.ts). */
  async function buildGraphFixture() {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(tempDir, 'src/a.ts'),
      "import { b } from './b'\nclass A { call() { return b() } }\n",
    )
    fs.writeFileSync(path.join(tempDir, 'src/b.ts'), 'export function b() {}\n')
    const db = openGraphDatabase(tempDir)
    try {
      return await updateKnowledgeGraph({
        projectRoot: tempDir,
        db,
        fullRebuild: true,
      })
    } finally {
      db.close()
    }
  }

  /**
   * Build a multi-directory fixture (src/ + lib/) so folder derivation emits
   * drill-down containers (a single src/ bucket degenerates and the cluster
   * fallback would otherwise be needed).
   */
  async function buildMultiDirFixture() {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true })
    fs.mkdirSync(path.join(tempDir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'export function a() {}\n')
    fs.writeFileSync(
      path.join(tempDir, 'src/b.ts'),
      "import { a } from './a'\nexport const b = a()\n",
    )
    fs.writeFileSync(path.join(tempDir, 'lib/c.ts'), 'export const c = 1\n')
    fs.writeFileSync(
      path.join(tempDir, 'lib/d.ts'),
      "import { c } from './c'\nexport const d = c\n",
    )
    const db = openGraphDatabase(tempDir)
    try {
      return await updateKnowledgeGraph({
        projectRoot: tempDir,
        db,
        fullRebuild: true,
      })
    } finally {
      db.close()
    }
  }

  test('graph-export audio manager handles unlock, mute, decode failure, and voice cap', async () => {
    let resumeCalls = 0
    let decodeCalls = 0
    let sourceStarts = 0
    let sourceStops = 0
    const sources: Array<{ onended: (() => void) | null }> = []
    const context = {
      state: 'suspended' as const,
      currentTime: 0,
      destination: {},
      resume: async () => {
        resumeCalls += 1
      },
      decodeAudioData: async () => {
        decodeCalls += 1
        return {}
      },
      createGain: () => ({ gain: { value: 0 }, connect: () => {} }),
      createBufferSource: () => {
        const source = {
          buffer: null,
          onended: null as (() => void) | null,
          connect: () => {},
          disconnect: () => {},
          start: () => {
            sourceStarts += 1
          },
          stop: () => {
            sourceStops += 1
          },
        }
        sources.push(source)
        return source
      },
    }
    const manager = new UniverseAudioManager({
      createContext: () => context,
      decode: async () => new ArrayBuffer(4),
      maxVoices: 4,
    })
    expect(await manager.play('click')).toBe(false)
    expect(await manager.unlock()).toBe(true)
    expect(manager.getState()).toMatchObject({
      enabled: true,
      unlocked: true,
      volume: 0.4,
    })
    expect(await manager.play('click')).toBe(true)
    expect(resumeCalls).toBe(1)
    expect(decodeCalls).toBe(1)
    expect(sourceStarts).toBe(1)

    const cappedResults = await Promise.all([
      manager.play('voice-1'),
      manager.play('voice-2'),
      manager.play('voice-3'),
      manager.play('voice-4'),
      manager.play('voice-5'),
    ])
    expect(cappedResults.filter(Boolean)).toHaveLength(3)
    expect(sourceStarts).toBe(4)

    manager.setVolume(2)
    expect(manager.getState().volume).toBe(1)
    manager.setEnabled(false)
    expect(sourceStops).toBe(4)
    expect(await manager.play('click')).toBe(false)
    manager.setEnabled(true)
    context.decodeAudioData = async () => {
      throw new Error('decode failed')
    }
    expect(await manager.play('warning')).toBe(false)
    manager.dispose()
  })

  test('graph-export audio unlock failure remains silent and usable', async () => {
    const context = {
      state: 'suspended' as const,
      currentTime: 0,
      destination: {},
      resume: async () => {
        throw new Error('gesture rejected')
      },
      decodeAudioData: async () => ({}),
      createGain: () => ({ gain: { value: 0 }, connect: () => {} }),
      createBufferSource: () => ({
        buffer: null,
        onended: null,
        connect: () => {},
        disconnect: () => {},
        start: () => {},
        stop: () => {},
      }),
    }
    const manager = new UniverseAudioManager({
      createContext: () => context,
      decode: async () => new ArrayBuffer(0),
    })

    expect(await manager.unlock()).toBe(false)
    expect(manager.getState()).toMatchObject({
      enabled: false,
      unlocked: false,
    })
    expect(await manager.play('click')).toBe(false)
    manager.setVolume(Number.NaN)
    expect(manager.getState().volume).toBe(0)
    manager.dispose()
  })

  test('graph-export audio manifest is license-linked and budgeted', () => {
    const cues = getGraphAudioCues()
    expect(cues).toHaveLength(GRAPH_AUDIO_CUE_COUNT)
    expect(GRAPH_AUDIO_CUE_COUNT).toBe(6)
    expect(cues.map((cue) => cue.cue)).toEqual(
      GRAPH_AUDIO_MANIFEST.map((entry) => entry.cue),
    )
    expect(
      GRAPH_AUDIO_MANIFEST.every((entry) => entry.license === 'CC0-1.0'),
    ).toBe(true)
    expect(
      GRAPH_AUDIO_MANIFEST.every((entry) =>
        entry.sourceUrl.startsWith('https://kenney.nl/'),
      ),
    ).toBe(true)
    expect(cues.every((cue) => cue.mime === 'audio/ogg')).toBe(true)
    expect(
      cues.every((cue) => cue.dataUri.startsWith('data:audio/ogg;base64,')),
    ).toBe(true)
    expect(cues.every((cue) => cue.byteCount <= 100 * 1024)).toBe(true)
    expect(cues.every((cue) => cue.durationSeconds <= 2)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(cues), 'utf8')).toBeLessThanOrEqual(
      GRAPH_AUDIO_MAX_REGISTRY_BYTES,
    )
  })

  test('graph-export runtime audio registry excludes provenance metadata', async () => {
    await buildGraphFixture()
    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')
    const start = html.indexOf(
      '<script type="application/json" id="savant-audio-data">',
    )
    const openEnd = html.indexOf('>', start)
    const end = html.indexOf('</script>', openEnd)
    const payload = JSON.parse(html.slice(openEnd + 1, end)) as {
      cues: Array<Record<string, unknown>>
    }
    expect(payload.cues).toHaveLength(6)
    expect(payload.cues.every((cue) => !('sourceUrl' in cue))).toBe(true)
    expect(payload.cues.every((cue) => !('license' in cue))).toBe(true)
  })

  test('graph refresh builds the index and reports stats', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(tempDir, 'src/a.ts'), "import './b'\n")
    fs.writeFileSync(path.join(tempDir, 'src/b.ts'), 'export const b = 1\n')

    await handleGraphRefreshCommand(makeParams('/graph refresh'), '')

    const text = renderedText()
    expect(text).toContain('Knowledge graph refreshed')
    expect(text).toMatch(/\*\*Files:\*\* 2 on disk/)
    expect(text).toMatch(/\*\*Graph:\*\* \d+ nodes · \d+ edges/)
    // The graph DB actually exists on disk
    expect(fs.existsSync(path.join(tempDir, '.savant', 'graph.db'))).toBe(true)
  })

  test('graph refresh --full forces a full reindex', async () => {
    await handleGraphRefreshCommand(
      makeParams('/graph refresh --full'),
      '--full',
    )
    expect(renderedText()).toContain('Knowledge graph rebuilt')
  })

  test('graph refresh surfaces indexer errors', async () => {
    // Point the graph DB at a path whose parent is a regular file, forcing
    // openGraphDatabase to fail loudly (mkdirSync under a file → ENOTDIR).
    const filePath = path.join(tempDir, 'blocker.txt')
    fs.writeFileSync(filePath, 'x')
    process.env.SAVANT_CODE_GRAPH_DB_PATH = path.join(filePath, 'graph.db')
    try {
      await handleGraphRefreshCommand(makeParams('/graph refresh'), '')
      expect(renderedText()).toContain('Graph refresh failed')
    } finally {
      delete process.env.SAVANT_CODE_GRAPH_DB_PATH
    }
  })

  test('graph-export writes a branded offline HTML report', async () => {
    // Multi-directory fixture so folder derivation emits real drill-down
    // containers (a single src/ bucket degenerates to no containers).
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    // Same /export design system: real logo, offline, tokens
    expect(html).toContain('data:image/png;base64,')
    expect(html).toContain('<img class="logo"')
    expect(html).not.toContain('cdn.jsdelivr.net')
    // FID-2026-0806-017: no 1.2 MB Font Awesome block — inline SVG sprite
    // with the exact glyphs instead; /export (chat) keeps the fonts.
    expect(html).not.toContain('url(data:font/woff2;base64,')
    expect(html).not.toContain('Font Awesome 6 Free')
    expect(html).toContain('<symbol id="icon-search"')
    expect(html).toContain('<symbol id="icon-expand"')
    expect(html).toContain('<symbol id="icon-palette"')
    expect(html).toContain('<symbol id="icon-route"')
    expect(html).toContain('--cyan:#18faf9')
    expect(html).toContain('--blue:#4fa8ff')
    expect(html).toContain('class="universe-shell"')
    expect(html).toContain('class="space-stars"')
    expect(html).toContain('class="shooting-star')
    expect(html).toContain('class="planet-effects"')
    expect(html).toContain('star-drift')
    expect(html).toContain('shooting-star')
    expect(html).toContain(
      'scrollbar-color:var(--scroll-thumb) var(--scroll-track-alt)',
    )
    expect(html).toContain('class="brand-lockup"')
    expect(html).toContain('id="savant-audio-data"')
    expect(html).toContain('id="sound-control"')
    expect(html).toContain('id="sound-toggle"')
    expect(html).toContain('id="sound-volume"')
    expect(html).toContain('function unlockAudio()')
    expect(html).toContain('function playSound(cue)')
    expect(html).toContain('function playProcedural(cue)')
    expect(html).not.toContain('fetch(asset.dataUri)')
    expect(html).toContain('decodeAudioData(bytes.buffer)')

    // Sigma.js + Graphology are inlined for the offline WebGL renderer. Graph
    // data is inert application/json and parsed only at runtime.
    expect(html).toContain('Sigma')
    expect(html).toContain('Graphology')
    expect(html).toContain('type="application/json" id="savant-graph-data"')
    expect(html).toContain(
      "JSON.parse(document.getElementById('savant-graph-data')",
    )
    expect(html).not.toContain('var GRAPH_DATA = {')
    // Coordinates are export-time data; the browser receives no layout engine.
    expect(html).toContain('"position":')
    expect(html).toContain("new Graphology({ multi: true, type: 'mixed' })")
    expect(html).toContain(
      "new Sigma(graph, document.getElementById('sigma-container')",
    )
    expect(html).toContain('function fitUniverse()')
    expect(html).toContain('function fitUniverseSilently()')
    expect(html).toContain('function updateZoomState()')
    expect(html).toContain('function toggleMotion()')
    expect(html).toContain('doc.text.split(String.fromCharCode(10))')
    const appScripts: string[] = []
    let scriptCursor = 0
    while (true) {
      const scriptStart = html.indexOf('<script', scriptCursor)
      if (scriptStart < 0) break
      const scriptOpenEnd = html.indexOf('>', scriptStart)
      const scriptClose = html.indexOf('</script>', scriptOpenEnd)
      if (scriptOpenEnd < 0 || scriptClose < 0) break
      appScripts.push(html.slice(scriptOpenEnd + 1, scriptClose))
      scriptCursor = scriptClose + '</script>'.length
    }
    expect(appScripts.length).toBeGreaterThanOrEqual(3)
    const matchingAppScripts = appScripts.filter((script) =>
      script.includes('function buildGraph()'),
    )
    expect(matchingAppScripts).toHaveLength(1)
    const appScript = matchingAppScripts[0]
    expect(
      () => new vm.Script(appScript ?? '', { filename: 'graph-app.js' }),
    ).not.toThrow()
    expect(html).toContain('function hideGraphLoading()')
    expect(html).toContain('id="universe-tooltip" class="universe-tooltip"')
    expect(html).toContain('role="tooltip" aria-hidden="true"')
    expect(html).toContain('.universe-tooltip{position:absolute;z-index:7')
    expect(html).toContain(
      'background:linear-gradient(145deg,#0a2340f5,#061226f5)',
    )
    expect(html).toContain('border:1px solid var(--cyan)')
    expect(html).toContain('box-shadow:0 0 9px #18faf988')
    expect(html).toContain('pointer-events:none')
    expect(html).toContain('function showUniverseTooltip(node, nodeId)')
    expect(html).toContain('function positionUniverseTooltip()')
    expect(html).toContain('function hideUniverseTooltip()')
    expect(html).toContain('labelRenderedSizeThreshold: 18')
    expect(html).toContain('defaultDrawNodeHover: function () {}')
    expect(html).toContain('positionUniverseTooltip();')
    expect(html).toContain('showUniverseTooltip(n, event.node)')
    expect(html).toContain('hideUniverseTooltip(); setStatus')
    expect(html).toContain("tooltip.style.left = left + 'px'")
    expect(html).toContain("tooltip.style.top = top + 'px'")
    expect(html).toContain('overflow-wrap:anywhere')
    expect(html).toContain('function showGraphFailure(message)')
    expect(html).toContain(
      '@keyframes orbit{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
    )
    expect(html).toContain('function isContextNode(id)')
    expect(html).toContain('function isContextEdge(ext)')
    expect(html).toContain('id="center-focus"')
    expect(html).toContain('function renderFocusView(n, kind)')
    expect(html).toContain('function clearFocusView()')
    expect(html).toContain('function selectionNodes(id)')
    expect(html).toContain('function fitSelection(id)')
    expect(html).toContain('center-browser')
    expect(html).toContain('browser-grid')
    expect(html).toContain('function renderCenterBrowser()')
    expect(html).toContain('function renderDocument(file)')
    expect(html).toContain('document-surface')
    expect(html).toContain('document-line-number')
    expect(html).toContain("doc.kind === 'image'")
    expect(html).toContain('image.src = doc.dataUri')
    expect(html).toContain('image.onerror = function ()')
    expect(html).toContain("strong.textContent = 'DOCUMENT UNAVAILABLE'")
    expect(html).toContain('browser-up')
    expect(html).toContain('browserPage')
    expect(html).toContain('result.hidden = false')
    expect(html).toContain('Selection preserved')
    expect(html).toContain('z-index:6;pointer-events:auto')
    expect(html).toContain('--travel-x:')
    expect(html).toContain('--travel-y:')
    expect(html).toContain('--angle:')
    expect(html).toContain('--tail:')
    expect(html).not.toContain('rotate(-28deg)')
    expect(html).toContain(
      '.shooting-star{animation:none!important;opacity:1!important;transform:rotate(var(--angle))!important}',
    )
    expect(html).toContain('updateZoomState(); drawPlanetEffects();')
    expect(html).toContain('visibilitychange')
    expect(html).toContain('cancelAnimationFrame(motionFrame)')
    expect(html).toContain('Code Universe')
    // Both fixture files appear as nodes
    expect(html).toContain('src/a.ts')
    expect(html).toContain('src/b.ts')
    // Edge layer: the a→b import edge
    expect(html).toContain('IMPORTS')

    // Sidebar (FID-2026-0806-006): drawer markup; previews are OFF by default
    // (FID-2026-0806-017 opt-in), so the preview slot carries the fallback.
    expect(html).toContain('graph-sidebar')
    expect(html).toContain('sidebar-preview')
    expect(html).toContain('previews are opt-in at export time')

    // Meta grid shows real counts (4 files across src/ + lib/)
    expect(html).toContain('<b>4</b><span>FILES</span>')

    // Drill-down: containers derived from folder structure; the fixture's
    // files live under src/ and lib/, so folder containers are emitted with
    // children hidden by default.
    expect(html).toContain('SYSTEMS / REGIONS')
    expect(html).toContain('region-list')
    expect(html).toContain('regionId')

    // Success message names the output path
    expect(renderedText()).toContain('Exported the knowledge graph')
    expect(renderedText()).toContain(outputPath)
  })

  test('graph-export shows ordered staged progress and replaces it with one final message', async () => {
    await buildGraphFixture()

    const outputPath = path.join(tempDir, 'graph-progress.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)

    const stages = messageSnapshots
      .map((snapshot) => snapshot.at(-1)?.content ?? '')
      .filter((content) => content.includes('Exporting knowledge graph'))
      .map((content) => content.split('\n\n')[1])
    expect(stages).toEqual([
      'Preparing the graph export…',
      'Refreshing the project index…',
      'Serializing the graph…',
      'Laying out the universe…',
      'Embedding document contents…',
      'Compressing the offline payload…',
      'Assembling the HTML report…',
      'Writing the HTML file…',
    ])
    expect(renderedMessages).toHaveLength(1)
    expect(renderedMessages[0]?.content).toContain(
      'Exported the knowledge graph',
    )
    expect(renderedMessages[0]?.content).not.toContain(
      'Exporting knowledge graph',
    )
    expect(fs.existsSync(outputPath)).toBe(true)
  })

  test('graph-export refreshes stale rows before embedding current FID documents', async () => {
    await buildGraphFixture()
    fs.rmSync(path.join(tempDir, 'src/b.ts'))
    fs.mkdirSync(path.join(tempDir, 'dev', 'fids'), { recursive: true })
    fs.writeFileSync(
      path.join(tempDir, 'dev', 'fids', 'FID-current.md'),
      '# Current FID\\n\\nDocument freshness regression.\\n',
    )

    const outputPath = path.join(tempDir, 'graph-fresh.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')
    const docs = decodeDocsPayload(html)
    const current = Object.values(docs).find(
      (doc) =>
        typeof doc === 'object' &&
        doc !== null &&
        (doc as { text?: string }).text?.includes(
          'Document freshness regression.',
        ),
    )

    expect(html).not.toContain('src/b.ts')
    expect(current).toBeDefined()
    expect(renderedText()).toContain('Exported the knowledge graph')
  })

  test('graph-export keeps exporting when a progress update throws', async () => {
    await buildGraphFixture()
    const outputPath = path.join(tempDir, 'graph-progress-ui-error.html')
    const params = makeParams('/graph-export')
    const originalSetMessages = params.setMessages
    let updateCount = 0
    params.setMessages = ((update) => {
      updateCount += 1
      if (updateCount === 2) throw new Error('UI unavailable')
      originalSetMessages(update)
    }) as RouterParams['setMessages']

    await handleGraphExportCommand(params, outputPath)

    expect(fs.existsSync(outputPath)).toBe(true)
    expect(renderedMessages.at(-1)?.content).toContain(
      'Exported the knowledge graph',
    )
  })

  test('graph-export replaces progress with a failure without leaving a spinner', async () => {
    await buildGraphFixture()
    const blocker = path.join(tempDir, 'blocked-output')
    fs.writeFileSync(blocker, 'not a directory')

    await handleGraphExportCommand(
      makeParams('/graph-export'),
      path.join(blocker, 'graph.html'),
    )

    expect(renderedMessages).toHaveLength(1)
    expect(renderedMessages[0]?.content).toContain('Failed to export graph')
    expect(renderedMessages[0]?.content).not.toContain(
      'Exporting knowledge graph',
    )
  })

  test('graph-export ships the FID-020 lean payload contract', async () => {
    // FID-2026-0807-020: no duplicated title, no legacy elements array in the
    // payload, a precomputed search index, and documents moved into a separate
    // gzip+base64 block (lazy-decoded in the browser).
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    expect(html).toContain('<title>Savant Code Universe</title>')
    expect(html).not.toContain('<title>Savant Code Code Universe</title>')

    const dataAnchor = 'type="application/json" id="savant-graph-data"'
    const dataStart = html.indexOf(dataAnchor)
    const dataOpen = html.indexOf('>', dataStart)
    const dataEnd = html.indexOf('</script>', dataOpen)
    const payload: {
      elements?: unknown
      universe: {
        searchIndex?: Array<{ kind: string }>
        documents?: unknown
      }
    } = JSON.parse(html.slice(dataOpen + 1, dataEnd).replace(/\\u003c/g, '<'))
    // Legacy layout view is stripped from the shipped payload.
    expect(payload.elements).toBeUndefined()
    expect(payload.universe.documents).toBeUndefined()
    // Search index is precomputed and ships in the payload.
    expect(payload.universe.searchIndex?.length).toBeGreaterThan(0)
    expect(new Set(payload.universe.searchIndex?.map((e) => e.kind))).toEqual(
      new Set(['system', 'folder', 'file']),
    )

    // Documents live in the gzip payload block and decode to text documents.
    const docs = decodeDocsPayload(html)
    const textDocs = Object.values(docs).filter(
      (doc) => (doc as { kind?: string }).kind === 'text',
    )
    expect(textDocs.length).toBeGreaterThan(0)
    expect(html).toContain('id="savant-docs-payload"')
    expect(html).toContain('"mode":"gzip"')
  })

  test('graph-export is byte-deterministic (double export → identical SHA-256)', async () => {
    // FID-2026-0807-020 D1: the same repository state must yield an
    // identical artifact. generatedAt is the only volatile field; normalize
    // ISO timestamps before hashing so the gate asserts structural
    // determinism (the CI gate runs this same double-export comparison).
    await buildMultiDirFixture()

    const firstPath = path.join(tempDir, 'graph-det-a.html')
    const secondPath = path.join(tempDir, 'graph-det-b.html')
    await handleGraphExportCommand(makeParams('/graph-export'), firstPath)
    await handleGraphExportCommand(makeParams('/graph-export'), secondPath)

    const normalize = (html: string) =>
      html.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<TS>')
    const sha256 = (html: string) =>
      Bun.CryptoHasher.hash('sha256', normalize(html), 'hex')

    expect(sha256(fs.readFileSync(firstPath, 'utf8'))).toBe(
      sha256(fs.readFileSync(secondPath, 'utf8')),
    )
  })

  test('graph-export emits the FID-018 compact overview coordinate contract', async () => {
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    // The emitted app script uses Sigma camera states and the renderer-neutral payload.
    // the serialized stable anchor when expanding (never a live parent pos).
    expect(html).toContain('function navigateToObject(id)')
    expect(html).toContain('navigateToObject(event.node)')
    expect(html).toContain('navigateToObject(r.id)')
    expect(html).toContain('function updateZoomState()')
    expect(html).toContain('function reduceEdge(id, attrs)')
    expect(html).toContain('function fitUniverse()')
    expect(html).toContain('function fitUniverseSilently()')
    expect(html).toContain('function toggleMotion()')
    expect(html).toContain('fitSelection(id)')
    expect(html).toContain('clearFocusView()')

    // Overview elements (containers + ungrouped roots) carry compact center
    // positions; children carry parent linkage + childOffset and no position.
    // The inert block is JSON with every < escaped to \u003c; decode before
    // parsing so the escaped payload round-trips.
    const dataAnchor = 'type="application/json" id="savant-graph-data"'
    const dataStart = html.indexOf(dataAnchor)
    const dataOpen = html.indexOf('>', dataStart)
    const dataEnd = html.indexOf('</script>', dataOpen)
    const payload: {
      elements: Array<{
        data: { source?: string; target?: string }
        position?: { x: number; y: number }
      }>
      universe: {
        regions: Array<{ id: string; position: { x: number; y: number } }>
        files: Array<{
          id: string
          regionId: string
          position: { x: number; y: number }
        }>
        edges: Array<{ source: string; target: string }>
        corridors: Array<{ source: string; target: string }>
      }
    } = JSON.parse(html.slice(dataOpen + 1, dataEnd).replace(/\\u003c/g, '<'))
    expect(payload.universe.regions.length).toBeGreaterThan(0)
    expect(payload.universe.files.length).toBe(4)
    expect(payload.universe.edges.length).toBeGreaterThan(0)
    expect(
      payload.universe.regions.every(
        (r) => Number.isFinite(r.position.x) && Number.isFinite(r.position.y),
      ),
    ).toBe(true)
    expect(
      payload.universe.files.every((f) =>
        payload.universe.regions.some((r) => r.id === f.regionId),
      ),
    ).toBe(true)
    expect(payload.universe.corridors.every((c) => c.source !== c.target)).toBe(
      true,
    )

    // Repeated export-time layout remains deterministic and finite.
    const db = openGraphDatabase(tempDir)
    try {
      const graph = serializeGraphForExport(db, { projectRoot: tempDir })
      const a = await computeGraphLayout(graph.elements)
      const b = await computeGraphLayout(graph.elements)
      expect(a.positions).toEqual(b.positions)
      expect(a.overviewPositions).toEqual(b.overviewPositions)
      expect(a.childOffsets).toEqual(b.childOffsets)
      expect(
        Object.values(a.positions).every(
          (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
        ),
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  test('graph-export groups root-level files into the ROOT system (no fake file regions)', async () => {
    // Root file + a nested file + a packages/<file>: the root and
    // packages-level files must land in their parent system regions and must
    // never be emitted as their own 1-file "systems" (the left-nav quirk
    // where clicking a root file opened the ROOT directory instead of the
    // file's document).
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# readme\n')
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'export const a = 1\n')
    fs.mkdirSync(path.join(tempDir, 'packages'), { recursive: true })
    fs.writeFileSync(
      path.join(tempDir, 'packages/package.json'),
      '{"name":"pkg"}\n',
    )
    const db = openGraphDatabase(tempDir)
    try {
      await updateKnowledgeGraph({
        projectRoot: tempDir,
        db,
        fullRebuild: true,
      })
    } finally {
      db.close()
    }

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    const dataAnchor = 'type="application/json" id="savant-graph-data"'
    const dataStart = html.indexOf(dataAnchor)
    const dataOpen = html.indexOf('>', dataStart)
    const dataEnd = html.indexOf('</script>', dataOpen)
    const payload: {
      universe: {
        regions: Array<{
          id: string
          path: string
          fileCount: number
          disconnected: boolean
        }>
        files: Array<{ id: string; path: string; regionId: string }>
      }
    } = JSON.parse(html.slice(dataOpen + 1, dataEnd).replace(/\\u003c/g, '<'))

    // ROOT is the first system in the list.
    expect(payload.universe.regions[0]?.path).toBe('root')
    const rootRegion = payload.universe.regions.find((r) => r.path === 'root')
    expect(rootRegion).toBeDefined()
    // The root file belongs to the ROOT region, not a region named after it.
    const readme = payload.universe.files.find((f) => f.path === 'README.md')
    expect(readme?.regionId).toBe(rootRegion?.id)
    expect(payload.universe.regions.some((r) => r.path === 'README.md')).toBe(
      false,
    )
    expect(rootRegion?.fileCount).toBe(1)
    // The ROOT system is never flagged isolated.
    expect(rootRegion?.disconnected).toBe(false)
    // packages/<file> belongs to the packages system, not a file-named one.
    const packagesRegion = payload.universe.regions.find(
      (r) => r.path === 'packages',
    )
    expect(packagesRegion).toBeDefined()
    expect(
      payload.universe.files.find((f) => f.path === 'packages/package.json')
        ?.regionId,
    ).toBe(packagesRegion?.id)
    expect(
      payload.universe.regions.some((r) => r.path === 'packages/package.json'),
    ).toBe(false)
    // The nested file keeps its own real system.
    const srcRegion = payload.universe.regions.find((r) => r.path === 'src')
    expect(srcRegion).toBeDefined()
    expect(
      payload.universe.files.find((f) => f.path === 'src/a.ts')?.regionId,
    ).toBe(srcRegion?.id)
  })

  test('graph-export uses the character logo in the header + ROOT planet backdrop', async () => {
    // The Savant logo IS the character (assets/logo.png) — the header `<img
    // class="logo">` and the ROOT planet emblem (drawn from the header logo's
    // data URI) must use the character, not the legacy circular emblem.
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    expect(html).toContain(`<img class="logo" src="${CHARACTER_LOGO_DATA_URI}"`)
    // The ROOT planet still reads the header logo's data URI from the DOM.
    expect(html).toContain("headerLogo.getAttribute('src')")
  })

  test('graph-export renders the character watermark behind documents at 25% opacity', async () => {
    // FID-2026-0807-009 F1: the document backdrop is the character art from
    // assets/logo.png (CHARACTER_WATERMARK_DATA_URI) at opacity .25 with a
    // radial fade mask, replacing the decorative circle ring.
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    // The data URI is interpolated at export time; assert the CSS surface it
    // lands in (the constant name itself never appears in the HTML).
    expect(html).not.toContain('CHARACTER_WATERMARK_DATA_URI')
    expect(html).toContain(
      '.center-focus::after{inset:0;z-index:0;background-image:url(',
    )
    expect(html).toContain('background-position:center center')
    expect(html).toContain('background-size:min(72%,720px) min(72%,720px)')
    expect(html).toContain(
      '.center-focus-grid{position:absolute;inset:0;z-index:1',
    )
    expect(html).toContain('background-repeat:no-repeat')
    expect(html).toContain('opacity:.06')
    expect(html).toContain(
      'mask-image:radial-gradient(circle,#000 36%,transparent 74%)',
    )
    // The document surface is translucent so the watermark shows through.
    expect(html).toContain(
      '.document-surface{margin-top:12px;overflow-y:auto;overflow-x:auto;',
    )
    // The data URI is inlined exactly once (no duplicated 1.2 MB payload).
    const dataUris = html.match(/data:image\/png;base64,/g) ?? []
    expect(dataUris.length).toBeGreaterThanOrEqual(1)
  })

  test('graph-export document toolbar has copy + back, and OS-style window controls', async () => {
    // FID-2026-0807-012: the document header keeps its COPY/back toolbar, and
    // both panels get a 3-button window-control cluster (min/max/close) flush
    // to the top-right corner, with taskbar-style minimize + near-fullscreen
    // maximize states.
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    expect(html).toContain('function copyDocumentContent(file, doc)')
    expect(html).toContain("copy.textContent = '⧉ COPY CONTENT'")
    expect(html).toContain('document-toolbar')
    expect(html).toContain('browser-back')
    // Window-control cluster markup + handlers on both panels.
    expect(html).toContain('class="window-controls" role="group"')
    expect(html).toContain('class="window-btn window-btn-min"')
    expect(html).toContain('class="window-btn window-btn-max"')
    expect(html).toContain('class="window-btn window-btn-close"')
    expect(html).toContain('onclick="windowMinimize(this)"')
    expect(html).toContain('onclick="windowMaximize(this)"')
    expect(html).toContain('onclick="windowClose(this)"')
    expect(html).toContain('function windowMinimize(btn)')
    expect(html).toContain('function windowMaximize(btn)')
    expect(html).toContain('function windowClose(btn)')
    expect(html).toContain('function windowRestore(btn)')
    expect(html).toContain('function updateWindowTitle(panel)')
    // Flush corner chrome (not floating), taskbar minimize + maximize CSS.
    expect(html).toContain('.window-controls{position:absolute;top:0;right:0')
    expect(html).toContain('.window-btn-close:hover')
    expect(html).toContain('.center-focus.window-minimized')
    expect(html).toContain('.graph-sidebar.window-minimized')
    expect(html).toContain('.center-focus.window-maximized')
    expect(html).toContain('.window-title-bar')
    // Old single close chips are gone.
    expect(html).not.toContain('center-focus-close')
    expect(html).not.toContain('sidebar-close')
    // The old in-flow rule (which dropped the × into the top-left corner) is
    // gone; controls + title bar are excluded from the positioning rule.
    expect(html).not.toContain(
      '.center-focus>*:not(.center-focus-grid){position:relative}',
    )
    expect(html).toContain(
      '.center-focus>*:not(.center-focus-grid):not(.window-controls):not(.window-title-bar):not(.center-focus-actions){position:relative}',
    )
    expect(html).toContain(
      '.document-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding-right:96px}',
    )
    // Reachability: the handlers are exported on window for the inline onclick.
    expect(html).toContain('window.windowMinimize = windowMinimize')
    expect(html).toContain('window.windowRestore = windowRestore')
  })

  test('graph-export ships the FID-2026-0807-014 QC polish contracts', async () => {
    // FID-2026-0807-014: staged Escape (first press only dismisses the top
    // panel, keeping the document), per-window close (sidebar × keeps the
    // center doc), docked taskbar stacking, fitUniverse sound, tree keyboard
    // nav, collapse/expand all, font-size + wrap toggles, breadcrumbs, and
    // the '/' + Ctrl/Cmd+K search shortcut.
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    // F1 staged Escape — escDismiss restores taskbars, then closes panels
    // one at a time, and only falls through to resetUniverse when nothing is
    // open.
    expect(html).toContain('function escDismiss()')
    expect(html).toContain("sidebar.classList.add('hidden')")
    expect(html).toContain('function syncDockedTaskbars()')

    // F2 per-window close — the × resolves its own panel and closes only it.
    expect(html).toContain("panel.classList.contains('graph-sidebar')")
    expect(html).toContain("panel.classList.add('hidden')")
    expect(html).toContain('clearFocusView()')

    // F3 docked taskbar stacking — the sidebar (DOM order index 1, the only
    // panel that can hold docked-sibling) rises above the center bar so the
    // two taskbars never overlap.
    expect(html).toContain('.graph-sidebar.window-minimized.docked-sibling')
    expect(html).toContain(
      "panel.classList.toggle('docked-sibling', index > 0)",
    )

    // F4 fitUniverse sound — the button path plays (silent=false); only init
    // uses silent.
    expect(html).toContain('function fitUniverse() {')
    expect(html).toContain('fitUniverseInternal(false)')
    expect(html).toContain('fitUniverseInternal(true)')

    // F5 tree keyboard navigation — region-list is focusable and rows track
    // a visible focus class + aria-activedescendant.
    expect(html).toContain('id="region-list" tabindex="0"')
    expect(html).toContain('function regionNavRows()')
    expect(html).toContain('function navKeyFocusRow(row)')
    expect(html).toContain("list.setAttribute('aria-activedescendant'")
    expect(html).toContain('region-row.nav-key-focus')
    expect(html).toContain('region-tree-folder.nav-key-focus')

    // F6 collapse-all / expand-all buttons + handlers.
    expect(html).toContain('onclick="collapseAllRegions()"')
    expect(html).toContain('onclick="expandAllRegions()"')
    expect(html).toContain('function expandAllRegions()')
    expect(html).toContain('function collapseAllRegions()')
    expect(html).toContain('window.collapseAllRegions = collapseAllRegions')
    expect(html).toContain('window.expandAllRegions = expandAllRegions')

    // F7 word-wrap toggle retained; F8 font-size buttons removed
    // (FID-2026-0807-021) — no A−/A+ chrome, no font-scale classes.
    expect(html).toContain('function toggleDocWrap(btn)')
    expect(html).toContain("wrap.className = 'document-wrap-btn'")
    expect(html).not.toContain("wrap.className = 'document-font-btn'")
    expect(html).toContain(
      "wrap.textContent = docWrapOff ? '⤼ NO WRAP' : '⤺ WRAP'",
    )
    expect(html).toContain(
      '.document-surface.wrap-off .document-line code{white-space:pre',
    )
    expect(html).not.toContain('cycleDocFontScale')
    expect(html).not.toContain("fontSmall.textContent = 'A−'")
    expect(html).not.toContain("fontLarge.textContent = 'A+'")
    expect(html).not.toContain('font-scale-s')

    // FID-2026-0807-021: word wrap survives long unbreakable lines (grid
    // min-content blowout fix), copy button pinned in the corner action slot
    // under the window controls, and the line/byte meta sits in the header
    // next to the file name as a bracketed badge.
    expect(html).toContain(
      '.document-line{display:grid;grid-template-columns:54px minmax(0,1fr)',
    )
    expect(html).toContain(
      'white-space:pre-wrap;overflow-wrap:anywhere;min-width:0',
    )
    expect(html).toContain(
      'id="center-focus-actions" class="center-focus-actions"',
    )
    expect(html).toContain(
      '.center-focus-actions{position:absolute;top:30px;right:0',
    )
    expect(html).toContain(
      "var actionsSlot = document.getElementById('center-focus-actions')",
    )
    expect(html).toContain(
      'copy.onclick = function () { copyDocumentContent(file, doc) }',
    )
    expect(html).toContain("metaBadge.className = 'document-file-meta'")
    expect(html).toContain(
      "metaBadge.textContent = '[' + doc.lineCount + ' lines'",
    )
    expect(html).toContain('function updateWindowTitle(panel)')
    expect(html).toContain("heading.querySelector('.document-file-meta')")
    expect(html).toContain('width:min(1120px,calc(100% - 320px))')
    expect(html).toContain(
      'body{overflow:hidden}.universe-shell{display:flex;flex-direction:column;height:100vh;min-height:100vh',
    )
    expect(html).toContain(
      '.universe-main{position:relative;flex:1 1 auto;min-height:0;height:auto',
    )
    expect(html).toContain(
      '.center-focus{left:50%;width:calc(100% - 20px);min-width:0;height:calc(100% - 20px)',
    )
    expect(html).toContain('.center-focus-actions{right:6px;min-width:104px}')
    expect(html).toContain(
      '@media(max-width:1100px){.universe-header{flex-wrap:wrap',
    )
    expect(html).toContain(
      '.universe-actions{flex:1 1 100%;flex-wrap:wrap;justify-content:flex-end}',
    )

    // F9 document breadcrumbs under the header.
    expect(html).toContain("crumbs.className = 'document-breadcrumb'")
    expect(html).toContain('document-breadcrumb-folder')
    expect(html).toContain('document-breadcrumb-leaf')

    // F10 search shortcut — '/' or Ctrl/Cmd+K focuses the search input.
    expect(html).toContain("event.key === '/'")
    expect(html).toContain('event.ctrlKey || event.metaKey')
    expect(html).toContain('searchInputEl.focus(); searchInputEl.select()')
  })

  test('graph-export styles unavailable/oversized documents with a designed card', async () => {
    // FID-2026-0807-009 F6: oversized documents render a glyph + title + hint
    // card instead of a bare pink text line.
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    expect(html).toContain(
      "strong.textContent = reason === 'binary' ? 'BINARY CONTENT NOT EXPORTED' : reason === 'disabled' ? 'DOCUMENT NOT EXPORTED' : 'DOCUMENT UNAVAILABLE'",
    )
    expect(html).toContain('document-unavailable-glyph')
    expect(html).toContain('.document-unavailable strong{font-size:12px')
    // Explicit caps are rendered as text documents; unavailable cards do not
    // advertise retired aggregate/head-preview rerun knobs.
    expect(html).not.toContain('HEAD PREVIEW')
    expect(html).not.toContain('FILE TOO LARGE FOR EXPORT')
    expect(html).not.toContain('SAVANT_GRAPH_EXPORT_HEAD_TOTAL_BYTES=8388608')
    expect(html).toContain('function formatBytes(n)')
    expect(html).toContain(
      "size.textContent = 'Source file: ' + formatBytes(doc.byteCount)",
    )
    expect(html).toContain('document-size-note')
  })

  test('graph-export honors SAVANT_GRAPH_EXPORT_DOCUMENT_LINES env cap', async () => {
    // FID-2026-0807-011 A3: the env knobs wire into the serializer — the
    // fixture's two-line files (src/b.ts, lib/d.ts) must truncate to one
    // embedded line when the cap is 1.
    await buildMultiDirFixture()

    process.env.SAVANT_GRAPH_EXPORT_DOCUMENT_LINES = '1'
    try {
      const cappedPath = path.join(tempDir, 'graph-report-capped.html')
      await handleGraphExportCommand(makeParams('/graph-export'), cappedPath)
      const capped = fs.readFileSync(cappedPath, 'utf8')
      const cappedDocs = decodeDocsPayload(capped)
      const cappedLineCounts = Object.values(cappedDocs)
        .filter(
          (doc): doc is { kind: string; lineCount: number } =>
            typeof doc === 'object' &&
            doc !== null &&
            (doc as { kind?: string }).kind === 'text',
        )
        .map((doc) => doc.lineCount)
      expect(cappedLineCounts).not.toContain(2)
      expect(cappedLineCounts).toContain(1)
    } finally {
      delete process.env.SAVANT_GRAPH_EXPORT_DOCUMENT_LINES
    }

    const defaultPath = path.join(tempDir, 'graph-report-default.html')
    await handleGraphExportCommand(makeParams('/graph-export'), defaultPath)
    const def = fs.readFileSync(defaultPath, 'utf8')
    // Baseline: without the cap the two-line files embed both lines.
    const defDocs = decodeDocsPayload(def)
    expect(
      Object.values(defDocs)
        .filter(
          (doc): doc is { kind: string; lineCount: number } =>
            typeof doc === 'object' &&
            doc !== null &&
            (doc as { kind?: string }).kind === 'text',
        )
        .map((doc) => doc.lineCount),
    ).toContain(2)
  })

  test('graph-export aligns search results under the input and styles shared scrollbars', async () => {
    // FID-2026-0807-009 F4/F7: the dropdown anchors to the form's left edge
    // (the search input) instead of the header's right edge, and the content
    // areas share the sidebar's themed scrollbar.
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    expect(html).toContain(
      '.universe-search{display:flex;gap:4px;margin-left:auto;position:relative}',
    )
    expect(html).toContain(
      '.search-results{position:absolute;left:0;right:auto;top:calc(100% + 6px)',
    )
    expect(html).toContain('.center-browser::-webkit-scrollbar')
    expect(html).toContain('.document-surface::-webkit-scrollbar')
    expect(html).toContain('.browser-grid::-webkit-scrollbar')
  })

  test('graph-export left nav drills down into nested folder trees', async () => {
    // FID-2026-0807-010 F1/F2/F3: the systems list is a nested tree — region
    // rows expand into folder rows that expand into file rows; file rows
    // navigate directly and the selected row is highlighted + revealed.
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    expect(html).toContain('function buildRegionNav()')
    expect(html).toContain('function regionRootTree(region)')
    expect(html).toContain('function buildRegionTree(files, skipSegments)')
    expect(html).toContain("row.className = 'region-row'")
    expect(html).toContain('function toggleRegionFiles(item, region)')
    expect(html).toContain("list.className = 'region-files hidden'")
    expect(html).toContain("row.setAttribute('aria-expanded', 'false')")
    expect(html).toContain("row.setAttribute('aria-controls', list.id)")
    expect(html).toContain(
      "row.setAttribute('aria-expanded', open ? 'false' : 'true')",
    )
    expect(html).toContain('function renderTreeLevel(container, node)')
    expect(html).toContain("row.className = 'region-tree-folder'")
    expect(html).toContain('function toggleFolderRow(row, node)')
    expect(html).toContain("button.className = 'region-file'")
    expect(html).toContain(
      "button.onclick = function () { navigateToObjectWithCue(file.id, 'open'); navKeyFocusRow(button) }",
    )
    expect(html).toContain("chevron.textContent = hasChildren ? '▸' : ''")
    expect(html).toContain("chevron.textContent = open ? '▸' : '▾'")
    expect(html).toContain('.region-files.hidden{display:none}')
    expect(html).toContain('.region-tree-folder.nav-active')
    expect(html).toContain('function revealInNav(id)')
    expect(html).toContain("target.scrollIntoView({ block: 'nearest' })")
    expect(html).toContain('function navigateToFolder(folder)')
    expect(html).toContain(
      "setStatus('Exploring ' + (folder.path || folder.label))",
    )
  })

  test('graph-export document toolbar pages through sibling files', async () => {
    // FID-2026-0807-010 F4: renderDocument gains prev/next sibling paging so
    // files can be browsed without returning to the folder grid.
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    expect(html).toContain('function siblingFiles()')
    expect(html).toContain(
      "var prev = browserButton('← PREV FILE', 'browser-back', 'doc-prev', '')",
    )
    expect(html).toContain('prev.disabled = sibIndex <= 0')
    expect(html).toContain(
      "var next = browserButton('NEXT FILE →', 'browser-back', 'doc-next', '')",
    )
    expect(html).toContain(
      'next.disabled = sibIndex < 0 || sibIndex >= sibs.length - 1',
    )
    expect(html).toContain(
      '.browser-back:disabled,.document-copy:disabled{opacity:.35;cursor:default;transform:none;box-shadow:none}',
    )
  })

  test('graph-export dims the ROOT sigma node so the emblem reads as backdrop', async () => {
    // FID-2026-0807-009 F9: the ROOT region node renders as a small dim dot
    // (no label) when not selected so the logo planet behind it is the focal
    // point; the logo draw is enlarged and rim-ringed.
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    expect(html).toContain(
      "if (data.kind === 'region' && data.path === 'root' && selected !== id",
    )
    expect(html).toContain(
      "result.size = 4; result.label = ''; result.alpha = 0.32; result.zIndex = 1;",
    )
    expect(html).toContain('var logoSize = radius * 1.32;')
    expect(html).toContain("ctx.filter = 'brightness(1.35) saturate(1.15)'")
  })

  test('graph-export composes the Savant brand logo into the ROOT planet backdrop', async () => {
    // FID-2026-0807-008 F2: the ROOT region's background emblem is the
    // Savant logo (embedded data URI), not a generic planet body.
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    // The brand image is loaded once (reusing the header logo's data URI so
    // the multi-line base64 constant never lands inside a JS string literal)
    // and drawn inside drawPlanetEffects for the ROOT region only, with a
    // procedural fallback while decoding.
    expect(html).toContain('var brandLogo = null;')
    expect(html).toContain("headerLogo.getAttribute('src')")
    expect(html).toContain("region.path === 'root'")
    expect(html).toContain('brandLogo.complete && brandLogo.naturalWidth > 0')
    expect(html).toContain('ctx.drawImage(brandLogo')
    expect(html).toContain('drawPlanetBody(ctx, point, radius, color, pulse)')
  })

  test('graph-export builds a ranked kind-aware search with keyboard navigation', async () => {
    // FID-2026-0807-008 F3: search covers files, folders, and systems with
    // scored ranking, a live results panel, and arrow/Enter/Escape wiring.
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    // Panel + combobox ARIA surface.
    expect(html).toContain('id="search-results"')
    expect(html).toContain('class="search-results hidden"')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('role="listbox"')
    // Index is precomputed at export time and shipped in the payload; the
    // browser consumes it without building anything at load.
    expect(html).toContain('searchIndex')
    expect(html).toContain(
      'var searchIndex = (DATA.universe.searchIndex || []).slice();',
    )
    expect(html).not.toContain('function buildSearchIndex()')
    expect(html).toContain('function renderSearchResults(query)')
    expect(html).toContain('function searchScore(entry, query)')
    // Ranking rules + highlighting + navigation.
    expect(html).toContain('function highlightMatch(text, query)')
    expect(html).toContain("createElement('mark')")
    expect(html).toContain('function selectSearchRow(index)')
    expect(html).toContain('function closeSearchPanel()')
    expect(html).toContain("row.setAttribute('role', 'option')")
    expect(html).toContain('search-row')
    expect(html).toContain('ArrowDown')
    expect(html).toContain('ArrowUp')
    expect(html).toContain("event.key === 'Enter'")
    expect(html).toContain('NO MATCHES FOR')
    // Combobox aria-expanded is toggled with panel visibility.
    expect(html).toContain("inputEl.setAttribute('aria-expanded', 'true')")
    expect(html).toContain("input.setAttribute('aria-expanded', 'false')")
    // Folder results route through the center browser, not the node navigator.
    expect(html).toContain('browserFolderId = folder.id')
    expect(html).toContain('renderCenterBrowser()')
  })

  test('graph-export plain-mode docs payload escapes script breakouts (NO_COMPRESS)', async () => {
    // FID-2026-0807-020: the docs payload block gets the same `<` → `\u003c`
    // escaping as the graph block. With SAVANT_GRAPH_EXPORT_NO_COMPRESS=1 the
    // documents are raw JSON inside <script type="text/plain">, so a hostile
    // source file containing `</script>` must not close the block early.
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(tempDir, 'src/hostile.ts'),
      '</script><script>alert(1)</script>\n',
    )
    const db = openGraphDatabase(tempDir)
    try {
      db.query('INSERT INTO files (path, hash) VALUES (?, ?)').run(
        'src/hostile.ts',
        'xyz789',
      )
      db.query(
        "INSERT INTO nodes (file_id, type, name) VALUES (1, 'symbol', 'x')",
      ).run()
    } finally {
      db.close()
    }

    process.env.SAVANT_GRAPH_EXPORT_NO_COMPRESS = '1'
    try {
      const outputPath = path.join(tempDir, 'graph-report-plain.html')
      await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
      const html = fs.readFileSync(outputPath, 'utf8')
      expect(html).toContain('"mode":"plain"')
      // The raw breakout sequence must never appear anywhere in the artifact.
      expect(html).toContain('\\u003c/script>')
      // The docs block content (between its own tags) has no `</script>` in it.
      const anchor = '<script type="text/plain" id="savant-docs-payload">'
      const start = html.indexOf(anchor)
      const open = html.indexOf('>', start)
      const end = html.indexOf('</script>', open)
      expect(html.slice(open + 1, end)).not.toContain('</script>')
      // The hostile text still round-trips through the decoder intact.
      const docs = decodeDocsPayload(html)
      const hostile = Object.values(docs).find(
        (doc) =>
          typeof doc === 'object' &&
          doc !== null &&
          (doc as { kind?: string }).kind === 'text' &&
          (doc as { text?: string }).text?.includes('alert(1)'),
      )
      expect(hostile).toBeDefined()
    } finally {
      delete process.env.SAVANT_GRAPH_EXPORT_NO_COMPRESS
    }
  })

  test('graph-export serializer retains hostile paths for the HTML-boundary test', () => {
    // Windows forbids < > in filenames, so keep the synthetic path at the
    // direct serializer boundary. Command-level export refresh removes
    // database-only rows that do not exist on disk.
    const db = openGraphDatabase(tempDir)
    try {
      db.exec(
        "INSERT INTO files (path, hash) VALUES ('<script>alert(1)</script>.ts', 'abc123')",
      )
      db.exec(
        "INSERT INTO nodes (file_id, type, name) VALUES (1, 'symbol', 'x')",
      )
      const exportData = serializeGraphForExport(db, { projectRoot: tempDir })
      expect(exportData.universe.files).toContainEqual(
        expect.objectContaining({ path: '<script>alert(1)</script>.ts' }),
      )
    } finally {
      db.close()
    }

    // The raw `<script>` tag must never appear — the graph JSON is escaped
    // with \u003c before being inlined into the inert application/json block
    // (a literal `</script>` inside the block would close it early).
  })

  test('graph-export omits previews by default (opt-in SAVANT_GRAPH_EXPORT_PREVIEWS=1)', async () => {
    await buildGraphFixture()

    // Default: no preview content embedded (FID-2026-0806-017 scale-down).
    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')
    // Documents are now enabled for the product export; verify the preview
    // field itself remains absent rather than confusing document text with a
    // sidebar preview.
    expect(html).not.toContain('"preview":"import { b } from')
    expect(html).toContain('src/a.ts')

    // Opt-in: the same export embeds the capped first-20-line preview.
    process.env.SAVANT_GRAPH_EXPORT_PREVIEWS = '1'
    try {
      const optInPath = path.join(tempDir, 'graph-report-optin.html')
      await handleGraphExportCommand(makeParams('/graph-export'), optInPath)
      const optInHtml = fs.readFileSync(optInPath, 'utf8')
      expect(optInHtml).toContain("import { b } from './b'")
    } finally {
      delete process.env.SAVANT_GRAPH_EXPORT_PREVIEWS
    }
  })

  test('graph-export SAVANT_GRAPH_EXPORT_NO_PREVIEW=1 hard-off beats opt-in', async () => {
    await buildGraphFixture()
    process.env.SAVANT_GRAPH_EXPORT_PREVIEWS = '1'
    process.env.SAVANT_GRAPH_EXPORT_NO_PREVIEW = '1'
    try {
      const outputPath = path.join(tempDir, 'graph-report.html')
      await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
      const html = fs.readFileSync(outputPath, 'utf8')
      expect(html).not.toContain("import { b } from './b'")
      // Structural data still present
      expect(html).toContain('src/a.ts')
    } finally {
      delete process.env.SAVANT_GRAPH_EXPORT_PREVIEWS
      delete process.env.SAVANT_GRAPH_EXPORT_NO_PREVIEW
    }
  })

  test('graph-export keeps text containing non-NUL control characters and rejects binary signatures', async () => {
    // Seed a binary file directly in the DB (indexer would skip it anyway).
    const db = openGraphDatabase(tempDir)
    try {
      db.exec("INSERT INTO files (path, hash) VALUES ('src/blob.ts', 'abc123')")
      db.exec(
        "INSERT INTO files (path, hash) VALUES ('src/control.ts', 'def456')",
      )
      db.exec(
        "INSERT INTO nodes (file_id, type, name) VALUES (1, 'symbol', 'x')",
      )
    } finally {
      db.close()
    }
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(tempDir, 'src/blob.ts'),
      Buffer.from([0x00, 0x01, 0x02]),
    )
    fs.writeFileSync(
      path.join(tempDir, 'src/control.ts'),
      Buffer.from('line\x01with control\n', 'utf8'),
    )

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    // Node is present but no binary content can leak into the HTML
    expect(html).toContain('src/blob.ts')
    expect(html).toContain('src/control.ts')
    expect(html).not.toContain('\\u0000')
  })

  test('graph-export enables capped documents explicitly and preserves metadata-only defaults', async () => {
    await buildGraphFixture()
    const db = openGraphDatabase(tempDir)
    try {
      const metadataOnly = serializeGraphForExport(db, { projectRoot: tempDir })
      expect(metadataOnly.universe.documentPolicy.enabled).toBe(false)
      expect(Object.keys(metadataOnly.universe.documents)).toHaveLength(0)

      process.env.SAVANT_GRAPH_EXPORT_DOCUMENTS = '1'
      const legacyWithoutOption = serializeGraphForExport(db, {
        projectRoot: tempDir,
      })
      expect(legacyWithoutOption.universe.documentPolicy.enabled).toBe(false)

      delete process.env.SAVANT_GRAPH_EXPORT_DOCUMENTS
      const documentExport = serializeGraphForExport(db, {
        projectRoot: tempDir,
        documents: true,
        documentLines: 1,
        documentBytes: 64,
      })
      expect(documentExport.universe.documentPolicy).toEqual({
        enabled: true,
        maxTextLines: 1,
        maxTextBytes: 64,
        maxImageBytes: 2 * 1024 * 1024,
        maxTotalTextBytes: null,
        maxTotalMediaBytes: 16 * 1024 * 1024,
        headBytes: null,
        headTotalBytes: null,
      })
      expect(documentExport.universe.documents['file-1']).toMatchObject({
        kind: 'text',
      })
      const textDocument = Object.values(
        documentExport.universe.documents,
      ).find(
        (
          doc,
        ): doc is {
          kind: 'text'
          text: string
          lineCount: number
          byteCount: number
          truncated: boolean
        } => doc.kind === 'text',
      )
      expect(textDocument).toBeDefined()
      expect(Object.prototype.hasOwnProperty.call(textDocument, 'text')).toBe(
        true,
      )
      expect(
        Object.prototype.hasOwnProperty.call(textDocument, 'truncated'),
      ).toBe(true)
    } finally {
      delete process.env.SAVANT_GRAPH_EXPORT_DOCUMENTS
      db.close()
    }
  })

  test('graph-export embeds validated raster images and rejects unsafe media', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true })
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    fs.writeFileSync(path.join(tempDir, 'src/image.png'), png)
    fs.writeFileSync(path.join(tempDir, 'src/vector.svg'), '<svg></svg>')
    fs.writeFileSync(path.join(tempDir, 'src/fake.jpg'), 'not an image')
    const db = openGraphDatabase(tempDir)
    try {
      for (const file of ['src/image.png', 'src/vector.svg', 'src/fake.jpg']) {
        db.query('INSERT INTO files (path, hash) VALUES (?, ?)').run(file, file)
      }
      const exportData = serializeGraphForExport(db, {
        projectRoot: tempDir,
        documents: true,
      })
      const image = Object.values(exportData.universe.documents).find(
        (doc) => doc.kind === 'image',
      )
      expect(image).toMatchObject({ kind: 'image', mime: 'image/png' })
      expect((image as { dataUri: string }).dataUri).toStartWith(
        'data:image/png;base64,',
      )
      expect(exportData.universe.documents['file-2']).toMatchObject({
        kind: 'unavailable',
        unavailableReason: 'unsupported-image',
      })
      expect(exportData.universe.documents['file-3']).toMatchObject({
        kind: 'unavailable',
        unavailableReason: 'malformed-image',
      })

      process.env.SAVANT_GRAPH_EXPORT_DOCUMENTS = '0'
      const hardDisabled = serializeGraphForExport(db, {
        projectRoot: tempDir,
        documents: true,
      })
      expect(hardDisabled.universe.documentPolicy.enabled).toBe(false)
      delete process.env.SAVANT_GRAPH_EXPORT_DOCUMENTS
    } finally {
      db.close()
    }
  })

  test('graph-export enforces aggregate text and media budgets', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(tempDir, 'src/first.ts'), '1234567890')
    fs.writeFileSync(path.join(tempDir, 'src/second.ts'), 'abcdefghij')
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    fs.writeFileSync(path.join(tempDir, 'src/one.png'), tinyPng)
    fs.writeFileSync(path.join(tempDir, 'src/two.png'), tinyPng)
    const db = openGraphDatabase(tempDir)
    try {
      for (const file of [
        'src/first.ts',
        'src/second.ts',
        'src/one.png',
        'src/two.png',
      ]) {
        db.query('INSERT INTO files (path, hash) VALUES (?, ?)').run(file, file)
      }
      const exportData = serializeGraphForExport(db, {
        projectRoot: tempDir,
        documents: true,
        documentTotalTextBytes: 10,
        documentTotalMediaBytes: tinyPng.byteLength,
      })
      const docs = Object.values(exportData.universe.documents)
      // Explicit aggregate limits truncate text in-place without preview or
      // unavailable fallback. Binary media remains independently bounded.
      expect(docs.filter((doc) => doc.kind === 'text')).toHaveLength(2)
      expect(
        docs.filter((doc) => doc.kind === 'text' && doc.explicitlyCapped),
      ).toHaveLength(1)
      expect(
        docs.filter(
          (doc) =>
            doc.kind === 'unavailable' && doc.unavailableReason === 'oversized',
        ),
      ).toHaveLength(1)
      expect(docs.filter((doc) => doc.kind === 'image')).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  test('graph-export hard-off disables explicit documents', async () => {
    await buildGraphFixture()
    const db = openGraphDatabase(tempDir)
    process.env.SAVANT_GRAPH_EXPORT_NO_PREVIEW = '1'
    try {
      const exportData = serializeGraphForExport(db, {
        projectRoot: tempDir,
        documents: true,
      })
      expect(exportData.universe.documentPolicy.enabled).toBe(false)
      expect(Object.keys(exportData.universe.documents)).toHaveLength(0)
    } finally {
      delete process.env.SAVANT_GRAPH_EXPORT_NO_PREVIEW
      db.close()
    }
  })

  test('graph-export embeds >1 MiB sources without a default cap', async () => {
    fs.mkdirSync(path.join(tempDir, 'big'), { recursive: true })
    const huge = 'B'.repeat(Math.ceil(1.1 * 1024 * 1024))
    fs.writeFileSync(path.join(tempDir, 'big/huge.ts'), huge)
    const db = openGraphDatabase(tempDir)
    try {
      db.query('INSERT INTO files (path, hash) VALUES (?, ?)').run(
        'big/huge.ts',
        'big/huge.ts',
      )
      const exportData = serializeGraphForExport(db, {
        projectRoot: tempDir,
        documents: true,
      })
      const doc = Object.values(exportData.universe.documents)[0]
      expect(doc && doc.kind).toBe('text')
      if (doc && doc.kind === 'text') {
        expect(doc.explicitlyCapped).toBe(false)
        expect(doc.text.length).toBe(huge.length)
        expect(doc.byteCount).toBeGreaterThan(1024 * 1024)
        expect(doc.truncated).toBe(false)
      }
    } finally {
      db.close()
    }
  })

  test('graph-export ships explicit-cap messaging and draggable title bars', async () => {
    // FID-2026-0807-015 F1 (UI): preview docs render a banner + head lines;
    // F2 (UI): the title bar is always-visible chrome with pointer-drag
    // handlers and a grab cursor.
    await buildMultiDirFixture()

    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)
    const html = fs.readFileSync(outputPath, 'utf8')

    // Explicit caps have a deliberate message; retired preview/head-pool copy is gone.
    expect(html).toContain('document-preview-banner')
    expect(html).toContain('TEXT CAPPED BY EXPLICIT EXPORT LIMIT')
    expect(html).not.toContain('HEAD PREVIEW')
    expect(html).not.toContain('FILE TOO LARGE FOR EXPORT')
    expect(html).not.toContain('SAVANT_GRAPH_EXPORT_HEAD_BYTES')
    expect(html).not.toContain('SAVANT_GRAPH_EXPORT_HEAD_TOTAL_BYTES')

    // F2 drag handlers + exports + title-bar chrome.
    expect(html).toContain('onpointerdown="windowDragStart(this, event)"')
    expect(html).toContain('function windowDragStart(bar, event)')
    expect(html).toContain('function windowDragMove(event)')
    expect(html).toContain('function windowDragEnd(event)')
    expect(html).toContain('function windowTitleBarClick(bar)')
    expect(html).toContain('window.windowDragStart = windowDragStart')
    expect(html).toContain(
      '.window-title-bar{position:absolute;left:0;right:96px;top:0;bottom:auto;height:24px',
    )
    expect(html).toContain('.window-dragging{')
  })

  test('graph-export reports when no index exists yet', async () => {
    const outputPath = path.join(tempDir, 'graph-report.html')
    await handleGraphExportCommand(makeParams('/graph-export'), outputPath)

    expect(fs.existsSync(outputPath)).toBe(false)
    expect(renderedText()).toContain('Run **/graph refresh**')
  })

  test('graph-export honors a custom output path argument', async () => {
    await buildGraphFixture()

    const customPath = path.join(tempDir, 'custom', 'deep', 'graph.html')
    await handleGraphExportCommand(
      makeParams('/graph-export custom/deep/graph.html'),
      customPath,
    )

    expect(fs.existsSync(customPath)).toBe(true)
    expect(renderedText()).toContain(customPath)
  })
})
