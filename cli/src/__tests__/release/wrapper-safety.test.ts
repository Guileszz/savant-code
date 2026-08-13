import { EventEmitter } from 'node:events'
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'bun:test'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const require = createRequire(import.meta.url)

const wrappers = [
  {
    name: 'savant-code',
    directory: 'cli/release',
    expectedConfig: {
      packageName: 'savant-code',
      displayName: 'SavantCode',
      tempDownloadDirName: '.download-temp',
    },
  },
  {
    name: 'codecane',
    directory: 'cli/release-staging',
    expectedConfig: {
      packageName: 'savant-code-staging',
      displayName: 'Codecane',
      includeTreeSitterWasm: false,
      telemetryProperties: { isStaging: true },
      tempDownloadDirName: '.download-temp-staging',
    },
  },
  {
    name: 'savant-free',
    directory: 'savant-free/cli/release',
    expectedConfig: {
      packageName: 'savant-free',
      displayName: 'SavantFree',
      telemetryEvent: 'cli.update_savant_free_failed',
    },
  },
]

for (const wrapper of wrappers) {
  describe(`${wrapper.name} release wrapper`, () => {
    test('contains only product configuration and package loading', () => {
      const wrapperModule = require(
        join(repoRoot, wrapper.directory, 'index.js'),
      )
      expect(wrapperModule.config).toMatchObject(wrapper.expectedConfig)
    })

    test('has package-only lifecycle scripts', () => {
      const packageJson = JSON.parse(
        readFileSync(join(repoRoot, wrapper.directory, 'package.json'), 'utf8'),
      )
      expect(packageJson.scripts?.preinstall).toBeUndefined()
      expect(packageJson.scripts?.install).toBeUndefined()
      expect(packageJson.scripts?.postinstall).toBeUndefined()
      expect(packageJson.scripts?.preuninstall).toBeUndefined()
      expect(packageJson.scripts?.prepack).toContain('prepare-package.js')
      expect(packageJson.scripts?.postpack).toContain('prepare-package.js')
      expect(packageJson.files).toContain('launcher.js')
      expect(packageJson.files).toContain('http.js')
      expect(packageJson.files).toContain('savant-design-systems')
    })

    test('prefers its bundled launcher over a source-path collision', () => {
      const fixtureRoot = mkdtempSync(
        join(tmpdir(), `${wrapper.name}-wrapper-`),
      )
      const fixtureWrapperDir = join(fixtureRoot, wrapper.directory)
      const fixtureSourceDir = join(fixtureRoot, 'cli/release-core')

      try {
        mkdirSync(fixtureWrapperDir, { recursive: true })
        mkdirSync(fixtureSourceDir, { recursive: true })
        copyFileSync(
          join(repoRoot, wrapper.directory, 'index.js'),
          join(fixtureWrapperDir, 'index.js'),
        )

        const fakeLauncher = (origin: string) => `
          module.exports = {
            createLauncher(config) {
              return { config, main: async () => {}, origin: '${origin}' }
            },
          }
        `
        writeFileSync(
          join(fixtureWrapperDir, 'launcher.js'),
          fakeLauncher('packaged'),
        )
        writeFileSync(
          join(fixtureSourceDir, 'launcher.js'),
          fakeLauncher('source'),
        )

        const wrapperModule = require(join(fixtureWrapperDir, 'index.js'))
        expect(wrapperModule.origin).toBe('packaged')
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true })
      }
    })
  })
}

describe('shared release launcher safety', () => {
  const launcherPath = join(repoRoot, 'cli/release-core/launcher.js')
  const { createLauncher, validateDesignSystemCatalog } = require(launcherPath)

  test('validates an extracted 74-resource release catalog', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'design-catalog-'))
    const catalogRoot = join(fixtureRoot, 'savant-design-systems')
    try {
      cpSync(
        join(repoRoot, '.agents/skills/savant-design-systems'),
        catalogRoot,
        { recursive: true },
      )
      expect(validateDesignSystemCatalog(catalogRoot)).toEqual({ count: 74 })

      const resourcePath = join(
        catalogRoot,
        'resources',
        'airbnb-design-analysis.json',
      )
      const original = readFileSync(resourcePath, 'utf8')
      writeFileSync(resourcePath, `${original}\\n tampered`)
      try {
        validateDesignSystemCatalog(catalogRoot)
        throw new Error('expected catalog validation to fail')
      } catch (error) {
        expect((error as { code?: string }).code).toBe(
          'DESIGN_SYSTEM_CATALOG_INVALID',
        )
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  test('preserves the catalog across an npm-pack boundary', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'design-catalog-pack-'))
    const tempRepo = join(fixtureRoot, 'repo')
    const packageRoot = join(tempRepo, 'cli', 'release')
    const packedRoot = join(fixtureRoot, 'packed')
    try {
      mkdirSync(join(tempRepo, 'cli', 'release-core'), { recursive: true })
      mkdirSync(packageRoot, { recursive: true })
      cpSync(
        join(repoRoot, 'cli/release/package.json'),
        join(packageRoot, 'package.json'),
      )
      cpSync(
        join(repoRoot, 'cli/release/index.js'),
        join(packageRoot, 'index.js'),
      )
      cpSync(
        join(repoRoot, 'cli/release/README.md'),
        join(packageRoot, 'README.md'),
      )
      cpSync(
        join(repoRoot, 'cli/release-core/launcher.js'),
        join(packageRoot, 'launcher.js'),
      )
      cpSync(
        join(repoRoot, 'cli/release-core/http.js'),
        join(packageRoot, 'http.js'),
      )
      cpSync(
        join(repoRoot, 'cli/release-core/prepare-package.js'),
        join(tempRepo, 'cli', 'release-core', 'prepare-package.js'),
      )
      cpSync(
        join(repoRoot, 'cli/release-core/launcher.js'),
        join(tempRepo, 'cli', 'release-core', 'launcher.js'),
      )
      cpSync(
        join(repoRoot, 'cli/release-core/http.js'),
        join(tempRepo, 'cli', 'release-core', 'http.js'),
      )
      cpSync(join(repoRoot, '.agents'), join(tempRepo, '.agents'), {
        recursive: true,
      })
      const prepare = require('node:child_process').execFileSync
      prepare(
        process.platform === 'win32' ? 'node.exe' : 'node',
        [join(tempRepo, 'cli', 'release-core', 'prepare-package.js')],
        { cwd: packageRoot },
      )
      const output = prepare(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['pack', '--json'],
        { cwd: packageRoot, encoding: 'utf8' },
      )
      const [packed] = JSON.parse(output) as Array<{
        filename: string
        files: Array<{ path: string }>
      }>
      expect(
        packed.files.some(
          (file) => file.path === 'savant-design-systems/manifest.json',
        ),
      ).toBe(true)
      expect(
        packed.files.filter((file) =>
          file.path.startsWith('savant-design-systems/resources/'),
        ),
      ).toHaveLength(74)
      mkdirSync(packedRoot, { recursive: true })
      await require('tar').x({
        file: join(packageRoot, packed.filename),
        cwd: packedRoot,
        strip: 1,
      })
      expect(
        validateDesignSystemCatalog(join(packedRoot, 'savant-design-systems')),
      ).toEqual({ count: 74 })
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  test('validates the catalog after tar extraction', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'design-catalog-tar-'))
    const archivePath = join(fixtureRoot, 'catalog.tar.gz')
    const extractRoot = join(fixtureRoot, 'extract')
    const catalogRoot = join(extractRoot, 'savant-design-systems')
    try {
      cpSync(
        join(repoRoot, '.agents/skills/savant-design-systems'),
        join(fixtureRoot, 'savant-design-systems'),
        { recursive: true },
      )
      await require('tar').c(
        { gzip: true, file: archivePath, cwd: fixtureRoot },
        ['savant-design-systems'],
      )
      mkdirSync(extractRoot, { recursive: true })
      await require('tar').x({ file: archivePath, cwd: extractRoot })
      expect(validateDesignSystemCatalog(catalogRoot)).toEqual({ count: 74 })
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  // FID-2026-0806-014: consent before apply. An update is staged in the
  // background and recorded as pending; the running session is never stopped
  // and the binary is never replaced mid-session. The install happens only on
  // the next launch, after a y/N prompt in main() (applyPendingUpdateIfApproved).
  test('stages an update and defers install to next launch with consent', () => {
    const source = readFileSync(launcherPath, 'utf8')
    const updateFunction = source.slice(
      source.indexOf('async function checkForUpdates'),
    )
    const stageIndex = updateFunction.indexOf(
      'const stagedBinary = await stageBinary',
    )
    const writeMarkerIndex = updateFunction.indexOf(
      'writePendingUpdateMarker(stagedBinary)',
    )
    const stopIndex = updateFunction.indexOf(
      'await stopRunningProcess(runningProcess)',
    )
    const installIndex = updateFunction.indexOf(
      'installStagedBinary(stagedBinary)',
    )

    // The background check stages the download and records the pending marker...
    expect(stageIndex).toBeGreaterThan(-1)
    expect(writeMarkerIndex).toBeGreaterThan(stageIndex)
    // ...but the mid-session stop + install are gone from checkForUpdates.
    expect(stopIndex).toBe(-1)
    expect(installIndex).toBe(-1)
    // The consent prompt + opt-out exist in the launcher.
    expect(source.indexOf('SAVANT_CODE_NO_AUTO_UPDATE')).toBeGreaterThan(-1)
    expect(source.indexOf('askYesNo')).toBeGreaterThan(-1)
    expect(source.indexOf('applyPendingUpdateIfApproved')).toBeGreaterThan(-1)
  })

  test('cleans up process-stop listeners and timers', async () => {
    const { stopRunningProcess } = createLauncher({
      packageName: 'test',
      displayName: 'Test',
    })
    const runningProcess = new EventEmitter() as EventEmitter & {
      kill(signal: string): boolean
    }
    const signals: string[] = []
    runningProcess.kill = (signal) => {
      signals.push(signal)
      runningProcess.emit('exit', 0, null)
      return true
    }

    await stopRunningProcess(runningProcess)

    expect(signals).toEqual(['SIGTERM'])
    expect(runningProcess.listenerCount('exit')).toBe(0)
  })

  test('cleans up when stopping the process throws', async () => {
    const { stopRunningProcess } = createLauncher({
      packageName: 'test',
      displayName: 'Test',
    })
    const runningProcess = new EventEmitter() as EventEmitter & {
      kill(signal: string): boolean
    }
    runningProcess.kill = () => {
      throw new Error('kill failed')
    }

    await expect(stopRunningProcess(runningProcess)).rejects.toThrow(
      'kill failed',
    )
    expect(runningProcess.listenerCount('exit')).toBe(0)
  })
})
