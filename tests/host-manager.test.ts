import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostScriptManager, ScriptRevisionConflictError } from '../src/runtime/script-manager.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-custom-js-'))
  roots.push(root)
  return root
}

describe('HostScriptManager', () => {
  it('scans only supported files with configured and deterministic ordering', async () => {
    const directory = await temporaryDirectory()
    await Promise.all([
      writeFile(path.join(directory, 'z.js'), `window.z = true\n`),
      writeFile(path.join(directory, 'base.ts'), `export const base: number = 1\n`),
      writeFile(path.join(directory, 'alpha.mjs'), `export const alpha = true\n`),
      writeFile(path.join(directory, 'ignored.txt'), 'no'),
    ])

    const manager = new HostScriptManager({
      directory,
      enabled: true,
      autoReload: false,
      scripts: ['base.ts'],
      scriptStates: [{ name: 'z.js', enabled: false }],
      devLogs: false,
      logger,
    })
    await manager.start()
    const manifest = await manager.manifest()

    expect(manifest.scripts.map((entry) => entry.name)).toEqual(['base.ts', 'alpha.mjs', 'z.js'])
    expect(manifest.scripts.map((entry) => entry.order)).toEqual([0, 1, 2])
    expect(manifest.scripts.find((entry) => entry.name === 'z.js')?.enabled).toBe(false)
    expect(await manager.script('z.js')).toBeUndefined()
    expect((await manager.script('base.ts'))?.source).toContain('export const base = 1')
    expect(manifest.scripts.every((entry) => entry.kind === (entry.name.endsWith('.ts') ? 'typescript' : 'javascript'))).toBe(true)
    manager.dispose()
  })

  it('isolates compile errors and announces a repaired file', async () => {
    const directory = await temporaryDirectory()
    const file = path.join(directory, 'broken.ts')
    await writeFile(file, `const value = "unterminated\n`)
    const events: string[][] = []
    const manager = new HostScriptManager({
      directory,
      enabled: true,
      autoReload: false,
      scripts: [],
      scriptStates: [],
      devLogs: false,
      logger,
    })
    manager.subscribe((event) => events.push([...event.changed]))
    await manager.start()

    const broken = (await manager.manifest()).scripts[0]
    expect(broken?.ready).toBe(false)
    expect(broken?.error?.line).toBe(1)
    expect(await manager.script('broken.ts')).toBeUndefined()

    await writeFile(file, `export default () => () => undefined\n`)
    const repaired = await manager.refresh(new Set(['broken.ts']))
    expect(repaired.scripts[0]?.ready).toBe(true)
    expect(events.at(-1)).toContain('broken.ts')
    manager.dispose()
  })

  it('keeps JavaScript bytes unchanged', async () => {
    const directory = await temporaryDirectory()
    const source = `console.log('custom js loaded');\n\ndocument.addEventListener('click', event => console.log(event.target));\n`
    await writeFile(path.join(directory, 'user.js'), source)
    const manager = new HostScriptManager({
      directory,
      enabled: true,
      autoReload: false,
      scripts: [],
      scriptStates: [],
      devLogs: false,
      logger,
    })
    await manager.start()
    expect((await manager.script('user.js'))?.source).toBe(source)
    manager.dispose()
  })

  it('supports safe editor mutations and persists enable overrides', async () => {
    const directory = await temporaryDirectory()
    const options = {
      directory,
      enabled: true,
      autoReload: false,
      scripts: [] as string[],
      scriptStates: [] as { name: string; enabled: boolean }[],
      devLogs: false,
      logger,
    }
    const manager = new HostScriptManager(options)
    await manager.start()

    const created = await manager.createScript('managed.ts', 'export const value: number = 1\n')
    expect(created.content).toContain('value: number')
    expect((await manager.script('managed.ts'))?.source).toContain('value = 1')

    const saved = await manager.writeOriginal('managed.ts', 'export const value: number = 2\n', created.entry.revision)
    expect(saved.entry.revision).not.toBe(created.entry.revision)
    await expect(manager.writeOriginal('managed.ts', 'stale', created.entry.revision))
      .rejects.toBeInstanceOf(ScriptRevisionConflictError)

    const disabled = await manager.setEnabled('managed.ts', false)
    expect(disabled.enabled).toBe(false)
    expect(await manager.script('managed.ts')).toBeUndefined()
    manager.dispose()

    const restarted = new HostScriptManager(options)
    await restarted.start()
    expect((await restarted.manifest()).scripts[0]?.enabled).toBe(false)
    await restarted.deleteScript('managed.ts')
    expect((await restarted.manifest()).scripts).toHaveLength(0)
    restarted.dispose()
  })

  it('creates imported scripts disabled before their first manifest and persists that state', async () => {
    const directory = await temporaryDirectory()
    const options = {
      directory,
      enabled: true,
      autoReload: true,
      scripts: [] as string[],
      scriptStates: [] as { name: string; enabled: boolean }[],
      devLogs: false,
      logger,
    }
    const manager = new HostScriptManager(options)
    await manager.start()

    const imported = await manager.createScript('imported.js', 'window.imported = true\n', false)
    expect(imported.entry.enabled).toBe(false)
    expect(await manager.script('imported.js')).toBeUndefined()
    expect((await manager.editable('imported.js'))?.content).toContain('window.imported')
    manager.dispose()

    const restarted = new HostScriptManager(options)
    await restarted.start()
    expect((await restarted.manifest()).scripts[0]?.enabled).toBe(false)
    expect(await restarted.script('imported.js')).toBeUndefined()
    restarted.dispose()
  })

  it('recreates the same manifest and compiled source after a Host restart', async () => {
    const directory = await temporaryDirectory()
    await writeFile(path.join(directory, 'restart.ts'), `export const restarted: boolean = true\n`)
    const options = {
      directory,
      enabled: true,
      autoReload: false,
      scripts: [] as string[],
      scriptStates: [] as { name: string; enabled: boolean }[],
      devLogs: false,
      logger,
    }

    const before = new HostScriptManager(options)
    await before.start()
    const firstManifest = await before.manifest()
    before.dispose()

    const after = new HostScriptManager(options)
    await after.start()
    const secondManifest = await after.manifest()
    expect(secondManifest.revision).toBe(firstManifest.revision)
    expect((await after.script('restart.ts'))?.source).toContain('export const restarted = true')
    after.dispose()
  })
})
