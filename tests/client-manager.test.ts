// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientScriptManager } from '../src/client/index.js'
import { compileTypeScript } from '../src/runtime/compiler.js'
import { RUNTIME_STATUS_EVENT, type CustomJsManifest, type RuntimeScriptState, type ScriptManifestEntry, type UserScriptModule } from '../src/shared/types.js'

function entry(name: string, order: number, revision = 'r1', overrides: Partial<ScriptManifestEntry> = {}): ScriptManifestEntry {
  return {
    name,
    kind: name.endsWith('.ts') ? 'typescript' : 'javascript',
    mtime: 1,
    bytes: 1,
    order,
    enabled: true,
    ready: true,
    revision,
    url: `/api/custom-js/scripts/${name}?v=${revision}`,
    ...overrides,
  }
}

function manifest(scripts: ScriptManifestEntry[], revision = scripts.map((item) => item.revision).join('-')): CustomJsManifest {
  return {
    plugin: 'dsh-custom-js',
    version: '0.3.2',
    enabled: true,
    autoReload: true,
    devLogs: false,
    directory: '/tmp/custom-js',
    revision,
    generatedAt: Date.now(),
    scripts,
  }
}

const managers: ClientScriptManager[] = []

beforeEach(() => {
  const values = new Map<string, string>()
  const storage: Storage = {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(String(key), String(value)) },
  }
  vi.stubGlobal('localStorage', storage)
})

afterEach(async () => {
  await Promise.all(managers.splice(0).map(async (manager) => await manager.dispose()))
  document.body.replaceChildren()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ClientScriptManager', () => {
  it('loads in manifest order and runs cleanup before reload and disposal', async () => {
    const events: string[] = []
    let current = manifest([entry('base.js', 0), entry('sidebar.ts', 1)])
    const modules = new Map<string, UserScriptModule>([
      ['base.js', { default: () => { events.push('base:init'); return () => events.push('base:cleanup') } }],
      ['sidebar.ts', { default: () => { events.push('sidebar:init'); return () => events.push('sidebar:cleanup') } }],
    ])
    const manager = new ClientScriptManager({
      fetchManifest: async () => current,
      importModule: async (url) => modules.get(url.match(/scripts\/([^?]+)/)?.[1] ?? '') ?? {},
      createEventSource: () => undefined,
      window,
    })
    managers.push(manager)
    await manager.start()
    expect(events).toEqual(['base:init', 'sidebar:init'])
    expect(window.dshCustomJs?.scripts.map((state) => state.status)).toEqual(['loaded', 'loaded'])

    await window.dshCustomJs?.sync()
    expect(events).toEqual(['base:init', 'sidebar:init'])

    current = manifest([entry('base.js', 0), entry('sidebar.ts', 1, 'r2')], 'next')
    await window.dshCustomJs?.sync()
    expect(events).toEqual(['base:init', 'sidebar:init', 'sidebar:cleanup', 'sidebar:init'])

    await window.dshCustomJs?.reload('sidebar.ts')
    expect(events).toEqual(['base:init', 'sidebar:init', 'sidebar:cleanup', 'sidebar:init', 'sidebar:cleanup', 'sidebar:init'])

    await manager.dispose()
    expect(events.slice(-2)).toEqual(['sidebar:cleanup', 'base:cleanup'])
    expect(window.dshCustomJs).toBeUndefined()
  })

  it('isolates a failed module, emits its runtime state, and continues loading later scripts', async () => {
    const events: string[] = []
    const states: RuntimeScriptState[] = []
    const onState = (event: Event) => states.push((event as CustomEvent<RuntimeScriptState>).detail)
    window.addEventListener(RUNTIME_STATUS_EVENT, onState)
    const manager = new ClientScriptManager({
      fetchManifest: async () => manifest([entry('bad.js', 0), entry('good.mjs', 1)]),
      importModule: async (url) => {
        if (url.includes('bad.js')) throw new SyntaxError('Unexpected token')
        return { default: () => { events.push('good') } }
      },
      createEventSource: () => undefined,
      window,
      logger: { ...console, error: vi.fn() } as Console,
    })
    managers.push(manager)
    await manager.start()

    expect(events).toEqual(['good'])
    expect(manager.api.getStatus('bad.js')?.error?.message).toContain('Unexpected token')
    expect(manager.api.getStatus('good.mjs')?.status).toBe('loaded')
    expect(states.some((state) => state.name === 'bad.js' && state.status === 'error')).toBe(true)
    window.removeEventListener(RUNTIME_STATUS_EVENT, onState)
  })

  it('allows ordinary browser code to use DOM, localStorage, and fetch', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const manager = new ClientScriptManager({
      fetchManifest: async () => manifest([entry('ordinary.js', 0)]),
      importModule: async () => {
        const button = document.createElement('button')
        button.id = 'custom-button'
        document.body.append(button)
        localStorage.setItem('custom-js-test', 'loaded')
        await fetch('/custom-js-probe')
        return {}
      },
      createEventSource: () => undefined,
      window,
    })
    managers.push(manager)
    await manager.start()

    expect(document.querySelector('#custom-button')).not.toBeNull()
    expect(localStorage.getItem('custom-js-test')).toBe('loaded')
    expect(fetchMock).toHaveBeenCalledWith('/custom-js-probe')
  })

  it('executes TypeScript output as an ES module with lifecycle exports', async () => {
    const source = `
      export default function apply() {
        const node: HTMLDivElement = document.createElement('div')
        node.id = 'compiled-ts'
        document.body.append(node)
        return () => node.remove()
      }
    `
    const compiled = compileTypeScript('compiled.ts', source)
    expect(compiled.error).toBeUndefined()
    const module = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(compiled.code!)}`) as UserScriptModule
    const manager = new ClientScriptManager({
      fetchManifest: async () => manifest([entry('compiled.ts', 0)]),
      importModule: async () => module,
      createEventSource: () => undefined,
      window,
    })
    managers.push(manager)
    await manager.start()
    expect(document.querySelector('#compiled-ts')).not.toBeNull()
    await manager.dispose()
    expect(document.querySelector('#compiled-ts')).toBeNull()
  })

  it('cleans up everything when the plugin manifest is disabled', async () => {
    let current = manifest([entry('enabled.js', 0)])
    let cleaned = 0
    const manager = new ClientScriptManager({
      fetchManifest: async () => current,
      importModule: async () => ({ default: () => () => { cleaned += 1 } }),
      createEventSource: () => undefined,
      window,
    })
    managers.push(manager)
    await manager.start()
    current = { ...manifest([entry('enabled.js', 0, 'r1', { enabled: false, url: undefined })], 'disabled'), enabled: false }
    await manager.api.reload()
    expect(cleaned).toBe(1)
    expect(manager.api.getStatus('enabled.js')?.status).toBe('disabled')
  })
})
