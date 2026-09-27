import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ComponentType } from 'react'
import { installCustomJsLocale, NS, type CustomJsLocaleKey } from './i18n.js'
import { CustomJsManagerRow, installSettingsStyle } from './settings.js'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import {
  API_ROOT,
  PLUGIN_ID,
  PLUGIN_VERSION,
  type CustomJsManifest,
  type DshCustomJsApi,
  type RuntimeScriptState,
  type ScriptErrorInfo,
  type ScriptManifestEntry,
  type UserScriptCleanup,
  type UserScriptContext,
  type UserScriptInitializer,
  type UserScriptModule,
} from '../shared/types.js'

interface LoadedScript {
  readonly entry: ScriptManifestEntry
  readonly cleanups: readonly UserScriptCleanup[]
}

interface SlotsFace {
  inject(key: string, callback: () => (() => void)): () => void
  register(
    options: { name: string; id: string; order?: number; registrant?: string; locale?: typeof NS },
    component: ComponentType<{ t: Translate<CustomJsLocaleKey> }>,
  ): () => void
}

interface ClientDependencies {
  readonly fetchManifest?: () => Promise<CustomJsManifest>
  readonly importModule?: (url: string) => Promise<UserScriptModule>
  readonly createEventSource?: (url: string) => EventSource | undefined
  readonly window?: Window
  readonly logger?: Console
  readonly now?: () => number
}

function errorInfo(phase: ScriptErrorInfo['phase'], error: unknown): ScriptErrorInfo {
  const value = error instanceof Error ? error : new Error(String(error))
  return {
    phase,
    message: value.message,
    ...(value.stack === undefined ? {} : { stack: value.stack }),
  }
}

function initializer(module: UserScriptModule): UserScriptInitializer | undefined {
  if (typeof module.default === 'function') return module.default
  if (typeof module.apply === 'function') return module.apply
  if (typeof module.init === 'function') return module.init
  return undefined
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

export class ClientScriptManager {
  readonly api: DshCustomJsApi

  private readonly loaded = new Map<string, LoadedScript>()
  private readonly states = new Map<string, RuntimeScriptState>()
  private readonly targetWindow: Window
  private readonly logger: Console
  private readonly now: () => number
  private readonly fetchManifest: () => Promise<CustomJsManifest>
  private readonly importModule: (url: string) => Promise<UserScriptModule>
  private readonly createEventSource: (url: string) => EventSource | undefined
  private currentManifest: CustomJsManifest | undefined
  private eventSource: EventSource | undefined
  private queue: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(dependencies: ClientDependencies = {}) {
    this.targetWindow = dependencies.window ?? window
    this.logger = dependencies.logger ?? console
    this.now = dependencies.now ?? Date.now
    this.fetchManifest = dependencies.fetchManifest ?? (async () => {
      const response = await fetch(`${API_ROOT}/manifest`, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`manifest request failed: HTTP ${response.status}`)
      return await response.json() as CustomJsManifest
    })
    this.importModule = dependencies.importModule ?? (async (url) => await import(url) as UserScriptModule)
    this.createEventSource = dependencies.createEventSource ?? ((url) => new EventSource(url))

    const owner = this
    this.api = {
      version: PLUGIN_VERSION,
      get scripts() {
        return owner.snapshot()
      },
      reload: async (name?: string) => await owner.reload(name),
      getStatus: (name: string) => owner.states.get(name),
    }
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('script manager is disposed')
    this.targetWindow.addEventListener('error', this.onWindowError)
    this.targetWindow.addEventListener('unhandledrejection', this.onUnhandledRejection)
    this.targetWindow.dshCustomJs = this.api
    await this.synchronize(true)
    this.connectEvents()
  }

  private connectEvents(): void {
    if (this.disposed || this.eventSource !== undefined) return
    try {
      const source = this.createEventSource(`${API_ROOT}/events`)
      if (source === undefined) return
      this.eventSource = source
      const onSignal = () => {
        if (this.currentManifest?.autoReload === false) return
        this.enqueue(async () => await this.synchronize())
      }
      source.addEventListener('ready', onSignal)
      source.addEventListener('change', onSignal)
      source.addEventListener('error', () => {
        if (this.currentManifest?.autoReload !== false) {
          this.debug('reload event connection interrupted; browser will reconnect')
        }
      })
    } catch (error) {
      this.logger.warn(`[${PLUGIN_ID}] EventSource unavailable; use window.dshCustomJs.reload()`, error)
    }
  }

  async reload(name?: string): Promise<void> {
    return await this.enqueue(async () => {
      if (name === undefined) {
        await this.cleanupAll()
        this.currentManifest = undefined
        await this.synchronize(true, undefined, true)
        return
      }

      const manifest = await this.fetchManifest()
      const entry = manifest.scripts.find((candidate) => candidate.name === name)
      this.currentManifest = manifest
      await this.cleanupOne(name)
      if (entry === undefined) throw new Error(`unknown custom script: ${name}`)
      this.recordUnavailable(entry)
      if (entry.enabled && entry.ready && entry.url !== undefined) {
        await this.load(entry, true)
      }
    })
  }

  private async synchronize(force = false, changed?: ReadonlySet<string>, bustCache = false): Promise<void> {
    if (this.disposed) return
    const manifest = await this.fetchManifest()
    if (!force && manifest.revision === this.currentManifest?.revision) return

    const previousDesired = (this.currentManifest?.scripts ?? [])
      .filter((entry) => entry.enabled && entry.ready && entry.url !== undefined)
      .map((entry) => entry.name)
    const desiredEntries = manifest.scripts
      .filter((entry) => entry.enabled && entry.ready && entry.url !== undefined)
    const desiredNames = desiredEntries.map((entry) => entry.name)
    const orderChanged = !sameOrder(previousDesired, desiredNames)

    this.currentManifest = manifest
    for (const entry of manifest.scripts) this.recordUnavailable(entry)

    if (orderChanged && this.loaded.size > 0) {
      await this.cleanupAll()
    } else {
      const desired = new Map(desiredEntries.map((entry) => [entry.name, entry]))
      for (const [name, loaded] of [...this.loaded]) {
        const next = desired.get(name)
        if (
          next === undefined
          || next.revision !== loaded.entry.revision
          || changed?.has(name) === true
        ) await this.cleanupOne(name)
      }
    }

    for (const entry of desiredEntries) {
      if (!this.loaded.has(entry.name)) await this.load(entry, bustCache)
    }
  }

  private recordUnavailable(entry: ScriptManifestEntry): void {
    if (entry.enabled && entry.ready && entry.url !== undefined) return
    const status = entry.error?.phase === 'compile' ? 'compile-error' : 'disabled'
    this.states.set(entry.name, {
      name: entry.name,
      kind: entry.kind,
      order: entry.order,
      enabled: entry.enabled,
      revision: entry.revision,
      status,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    })
    if (entry.error !== undefined) {
      this.logger.error(`[${PLUGIN_ID}] ${entry.name}: ${entry.error.message}`)
    }
  }

  private async load(entry: ScriptManifestEntry, bustCache: boolean): Promise<void> {
    const url = new URL(entry.url!, this.targetWindow.location.href)
    if (bustCache) url.searchParams.set('_reload', String(this.now()))
    const publicUrl = `${url.pathname}${url.search}`
    this.states.set(entry.name, {
      name: entry.name,
      kind: entry.kind,
      order: entry.order,
      enabled: true,
      revision: entry.revision,
      status: 'loading',
    })

    let module: UserScriptModule
    try {
      module = await this.importModule(publicUrl)
    } catch (error) {
      const detail = errorInfo('load', error)
      this.states.set(entry.name, {
        name: entry.name,
        kind: entry.kind,
        order: entry.order,
        enabled: true,
        revision: entry.revision,
        status: 'error',
        error: detail,
      })
      this.logger.error(`[${PLUGIN_ID}] failed to load ${entry.name}: ${detail.message}`, error)
      return
    }

    const cleanups: UserScriptCleanup[] = []
    if (typeof module.cleanup === 'function') cleanups.push(module.cleanup)
    const context: UserScriptContext = {
      name: entry.name,
      kind: entry.kind,
      revision: entry.revision,
      url: publicUrl,
      plugin: this.api,
      logger: this.logger,
    }

    try {
      const init = initializer(module)
      const returned = init === undefined ? undefined : await init(context)
      if (typeof returned === 'function' && !cleanups.includes(returned)) cleanups.unshift(returned)
      this.loaded.set(entry.name, { entry, cleanups })
      this.states.set(entry.name, {
        name: entry.name,
        kind: entry.kind,
        order: entry.order,
        enabled: true,
        revision: entry.revision,
        status: 'loaded',
        loadedAt: this.now(),
      })
      this.debug(`loaded ${entry.name}`)
    } catch (error) {
      await this.runCleanups(entry.name, cleanups)
      const detail = errorInfo('initialize', error)
      this.states.set(entry.name, {
        name: entry.name,
        kind: entry.kind,
        order: entry.order,
        enabled: true,
        revision: entry.revision,
        status: 'error',
        error: detail,
      })
      this.logger.error(`[${PLUGIN_ID}] initializer failed for ${entry.name}: ${detail.message}`, error)
    }
  }

  private async cleanupOne(name: string): Promise<void> {
    const loaded = this.loaded.get(name)
    if (loaded === undefined) return
    this.loaded.delete(name)
    await this.runCleanups(name, loaded.cleanups)
    this.states.set(name, {
      name,
      kind: loaded.entry.kind,
      order: loaded.entry.order,
      enabled: loaded.entry.enabled,
      revision: loaded.entry.revision,
      status: 'unloaded',
    })
    this.debug(`unloaded ${name}`)
  }

  private async runCleanups(name: string, cleanups: readonly UserScriptCleanup[]): Promise<void> {
    for (const cleanup of cleanups) {
      try {
        await cleanup()
      } catch (error) {
        const detail = errorInfo('cleanup', error)
        this.logger.error(`[${PLUGIN_ID}] cleanup failed for ${name}: ${detail.message}`, error)
        const state = this.states.get(name)
        if (state !== undefined) this.states.set(name, { ...state, status: 'error', error: detail })
      }
    }
  }

  private async cleanupAll(): Promise<void> {
    const names = [...this.loaded.values()]
      .sort((left, right) => right.entry.order - left.entry.order)
      .map((entry) => entry.entry.name)
    for (const name of names) await this.cleanupOne(name)
  }

  private snapshot(): readonly RuntimeScriptState[] {
    const order = new Map(this.currentManifest?.scripts.map((entry) => [entry.name, entry.order]) ?? [])
    return [...this.states.values()].sort((left, right) => {
      const leftOrder = order.get(left.name) ?? Number.MAX_SAFE_INTEGER
      const rightOrder = order.get(right.name) ?? Number.MAX_SAFE_INTEGER
      return leftOrder - rightOrder || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => undefined)
    return next
  }

  private scriptFromDiagnostic(value: string): string | undefined {
    for (const entry of this.currentManifest?.scripts ?? []) {
      const encoded = `${API_ROOT}/scripts/${encodeURIComponent(entry.name)}`
      const plain = `${API_ROOT}/scripts/${entry.name}`
      if (value.includes(encoded) || value.includes(plain)) return entry.name
    }
    return undefined
  }

  private recordRuntimeError(name: string, error: unknown): void {
    const current = this.states.get(name)
    if (current === undefined) return
    const detail = errorInfo('runtime', error)
    this.states.set(name, { ...current, status: 'error', error: detail })
    this.logger.error(`[${PLUGIN_ID}] runtime error in ${name}: ${detail.message}`, error)
  }

  private readonly onWindowError = (event: ErrorEvent): void => {
    const source = `${event.filename ?? ''}\n${event.error instanceof Error ? event.error.stack ?? '' : ''}`
    const name = this.scriptFromDiagnostic(source)
    if (name !== undefined) this.recordRuntimeError(name, event.error ?? event.message)
  }

  private readonly onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason
    const source = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason)
    const name = this.scriptFromDiagnostic(source)
    if (name !== undefined) this.recordRuntimeError(name, reason)
  }

  private debug(message: string): void {
    if (this.currentManifest?.devLogs !== true) return
    this.logger.debug(`[${PLUGIN_ID}] ${message}`)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.eventSource?.close()
    this.eventSource = undefined
    this.targetWindow.removeEventListener('error', this.onWindowError)
    this.targetWindow.removeEventListener('unhandledrejection', this.onUnhandledRejection)
    await this.cleanupAll()
    if (this.targetWindow.dshCustomJs === this.api) delete this.targetWindow.dshCustomJs
  }
}

export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  installCustomJsLocale(ctx)
  const manager = new ClientScriptManager()
  ctx.effect(() => {
    void manager.start().catch((error) => {
      console.error(`[${PLUGIN_ID}] client startup failed`, error)
    })
    return () => manager.dispose()
  }, `${PLUGIN_ID}: client script manager`)

  ctx.effect(() => installSettingsStyle(), `${PLUGIN_ID}: settings style`)
  const slots = ctx.get('slots') as SlotsFace | undefined
  if (slots === undefined) {
    console.error(`[${PLUGIN_ID}] slots service unavailable; settings manager not mounted`)
    return
  }
  slots.inject('settings.general.item', () => slots.register({
    name: 'settings.general.item',
    id: 'custom-js',
    order: 12.5,
    registrant: PLUGIN_ID,
    locale: NS,
  }, CustomJsManagerRow))
}
