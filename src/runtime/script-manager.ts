import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, lstat, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compileTypeScript } from './compiler.js'
import {
  configuredEnabled,
  deterministicNames,
  isScriptName,
  MAX_SCRIPTS,
  scriptKind,
  type ScriptStateConfig,
} from './manifest.js'
import {
  API_ROOT,
  PLUGIN_ID,
  PLUGIN_VERSION,
  type CustomJsManifest,
  type ScriptErrorInfo,
  type ScriptManifestEntry,
} from '../shared/types.js'

export interface ScriptManagerLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string, error?: unknown): void
  error(message: string, error?: unknown): void
}

export interface ScriptManagerOptions {
  readonly directory: string
  readonly enabled: boolean
  readonly autoReload: boolean
  readonly scripts: readonly string[]
  readonly scriptStates: readonly ScriptStateConfig[]
  readonly devLogs: boolean
  readonly logger: ScriptManagerLogger
  readonly pollIntervalMs?: number
}

interface CachedScript {
  readonly manifest: ScriptManifestEntry
  readonly source?: string
  readonly original?: string
}

export interface EditableScript {
  readonly entry: ScriptManifestEntry
  readonly content: string
}

export class ScriptRevisionConflictError extends Error {
  readonly code = 'revision-conflict'

  constructor(readonly currentRevision: string) {
    super(`script changed on disk; current revision is ${currentRevision}`)
    this.name = 'ScriptRevisionConflictError'
  }
}

export interface ServedScript {
  readonly entry: ScriptManifestEntry
  readonly source: string
}

export interface ScriptChangeEvent {
  readonly revision: string
  readonly changed: readonly string[]
}

type ChangeListener = (event: ScriptChangeEvent) => void

const EDITOR_STATE_FILE = '.dsh-custom-js.json'

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20)
}

function sameManifest(left: CustomJsManifest | undefined, right: CustomJsManifest): boolean {
  return left?.revision === right.revision
}

function readableError(name: string, error: unknown): ScriptErrorInfo {
  const value = error instanceof Error ? error : new Error(String(error))
  return {
    phase: 'compile',
    message: `${name}: ${value.message}`,
    ...(value.stack === undefined ? {} : { stack: value.stack }),
  }
}

export class HostScriptManager {
  readonly directory: string

  private readonly listeners = new Set<ChangeListener>()
  private readonly cache = new Map<string, CachedScript>()
  private readonly stateOverrides = new Map<string, boolean>()
  private stateWriteQueue: Promise<void> = Promise.resolve()
  private manifestValue: CustomJsManifest | undefined
  private refreshQueue: Promise<CustomJsManifest> = Promise.resolve(undefined as never)
  private watcher: FSWatcher | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private readonly pendingNames = new Set<string>()
  private disposed = false

  constructor(private readonly options: ScriptManagerOptions) {
    this.directory = options.directory
  }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    await this.loadEditorState()
    await this.refresh()
    if (!this.options.autoReload || this.disposed) return

    try {
      this.watcher = watch(this.directory, { persistent: false }, (_event, fileName) => {
        this.schedule(fileName?.toString())
      })
      this.watcher.on('error', (error) => {
        this.options.logger.warn(`[${PLUGIN_ID}] filesystem watcher failed; polling remains active`, error)
        this.watcher?.close()
        this.watcher = undefined
      })
    } catch (error) {
      this.options.logger.warn(`[${PLUGIN_ID}] filesystem watcher unavailable; polling remains active`, error)
    }

    this.pollTimer = setInterval(() => {
      void this.refresh().catch((error) => {
        this.options.logger.warn(`[${PLUGIN_ID}] polling refresh failed`, error)
      })
    }, this.options.pollIntervalMs ?? 2_000)
    this.pollTimer.unref?.()
  }

  async manifest(refresh = false): Promise<CustomJsManifest> {
    if (refresh || this.manifestValue === undefined) return this.refresh()
    return this.manifestValue
  }

  async refresh(forceNames: ReadonlySet<string> = new Set()): Promise<CustomJsManifest> {
    const operation = this.refreshQueue.then(
      () => this.performRefresh(forceNames),
      () => this.performRefresh(forceNames),
    )
    this.refreshQueue = operation
    return operation
  }

  private async performRefresh(forceNames: ReadonlySet<string>): Promise<CustomJsManifest> {
    if (this.disposed) {
      if (this.manifestValue !== undefined) return this.manifestValue
      throw new Error('script manager is disposed')
    }

    await mkdir(this.directory, { recursive: true })
    const directoryEntries = await readdir(this.directory, { withFileTypes: true })
    const names = directoryEntries
      .filter((entry) => entry.isFile() && isScriptName(entry.name))
      .map((entry) => entry.name)
    const ordered = deterministicNames(names, this.options.scripts).slice(0, MAX_SCRIPTS)
    const nextCache = new Map<string, CachedScript>()

    for (let order = 0; order < ordered.length; order += 1) {
      const name = ordered[order]!
      const fullPath = path.join(this.directory, name)
      const info = await stat(fullPath).catch(() => undefined)
      if (info === undefined || !info.isFile()) continue
      const mtime = Math.round(info.mtimeMs)
      const previous = this.cache.get(name)
      const configured = this.stateOverrides.get(name)
        ?? configuredEnabled(name, this.options.scriptStates)
      const enabled = this.options.enabled && configured

      if (
        !forceNames.has(name)
        && previous !== undefined
        && previous.manifest.mtime === mtime
        && previous.manifest.bytes === info.size
        && previous.manifest.order === order
        && previous.manifest.enabled === enabled
      ) {
        nextCache.set(name, previous)
        continue
      }

      let source: string | undefined
      let error: ScriptErrorInfo | undefined
      try {
        const input = await readFile(fullPath, 'utf8')
        const kind = scriptKind(name)!
        if (kind === 'typescript') {
          const compiled = compileTypeScript(name, input)
          source = compiled.code
          error = compiled.error
        } else {
          source = input
        }

        const revision = digest(`${kind}\0${input}`)
        const entry: ScriptManifestEntry = {
          name,
          kind,
          mtime,
          bytes: info.size,
          order,
          enabled,
          ready: error === undefined && source !== undefined,
          revision,
          ...(enabled && error === undefined
            ? { url: `${API_ROOT}/scripts/${encodeURIComponent(name)}?v=${revision}` }
            : {}),
          ...(error === undefined ? {} : { error }),
        }
        nextCache.set(name, {
          manifest: entry,
          original: input,
          ...(source === undefined ? {} : { source }),
        })
      } catch (caught) {
        const kind = scriptKind(name)!
        error = readableError(name, caught)
        const revision = digest(`${kind}\0${mtime}\0${info.size}\0${error.message}`)
        nextCache.set(name, {
          manifest: {
            name,
            kind,
            mtime,
            bytes: info.size,
            order,
            enabled,
            ready: false,
            revision,
            error,
          },
        })
      }
    }

    const scripts = [...nextCache.values()].map((entry) => entry.manifest)
    const revision = digest(JSON.stringify(scripts.map((entry) => ({
      name: entry.name,
      order: entry.order,
      enabled: entry.enabled,
      ready: entry.ready,
      revision: entry.revision,
      error: entry.error?.message,
    }))))
    const nextManifest: CustomJsManifest = {
      plugin: PLUGIN_ID,
      version: PLUGIN_VERSION,
      enabled: this.options.enabled,
      autoReload: this.options.autoReload,
      devLogs: this.options.devLogs,
      directory: this.directory,
      revision,
      generatedAt: Date.now(),
      scripts,
    }

    const previousManifest = this.manifestValue
    this.cache.clear()
    for (const [name, item] of nextCache) this.cache.set(name, item)
    this.manifestValue = nextManifest

    if (!sameManifest(previousManifest, nextManifest)) {
      const previousRevisions = new Map(previousManifest?.scripts.map((entry) => [entry.name, entry.revision]))
      const changed = scripts
        .filter((entry) => previousRevisions.get(entry.name) !== entry.revision)
        .map((entry) => entry.name)
      for (const entry of previousManifest?.scripts ?? []) {
        if (!nextCache.has(entry.name)) changed.push(entry.name)
      }
      if (this.options.devLogs) {
        this.options.logger.debug(`[${PLUGIN_ID}] manifest ${revision}; changed: ${changed.join(', ') || '(configuration)'}`)
      }
      const event = { revision, changed }
      for (const listener of this.listeners) listener(event)
    }

    return nextManifest
  }

  async script(name: string): Promise<ServedScript | undefined> {
    if (!isScriptName(name)) return undefined
    await this.refresh()
    const cached = this.cache.get(name)
    if (
      cached === undefined
      || !cached.manifest.enabled
      || !cached.manifest.ready
      || cached.source === undefined
    ) return undefined
    return { entry: cached.manifest, source: cached.source }
  }

  async editable(name: string): Promise<EditableScript | undefined> {
    if (!isScriptName(name)) return undefined
    await this.refresh()
    const cached = this.cache.get(name)
    if (cached === undefined || cached.original === undefined) return undefined
    return { entry: cached.manifest, content: cached.original }
  }

  async writeOriginal(name: string, content: string, expectedRevision?: string): Promise<EditableScript> {
    const fullPath = await this.safeEditablePath(name, true)
    await this.refresh()
    const current = this.cache.get(name)
    if (current === undefined) throw new Error(`script not found: ${name}`)
    if (expectedRevision !== undefined && current.manifest.revision !== expectedRevision) {
      throw new ScriptRevisionConflictError(current.manifest.revision)
    }
    await writeFile(fullPath, content, 'utf8')
    await this.refresh(new Set([name]))
    return (await this.editable(name))!
  }

  async createScript(name: string, content = ''): Promise<EditableScript> {
    const fullPath = await this.safeEditablePath(name, false)
    await mkdir(this.directory, { recursive: true })
    await writeFile(fullPath, content, { encoding: 'utf8', flag: 'wx' })
    await this.refresh(new Set([name]))
    return (await this.editable(name))!
  }

  async deleteScript(name: string): Promise<void> {
    const fullPath = await this.safeEditablePath(name, true)
    await rm(fullPath)
    await this.refresh(new Set([name]))
  }

  async setEnabled(name: string, enabled: boolean): Promise<ScriptManifestEntry> {
    if (!isScriptName(name)) throw new Error(`invalid script name: ${name}`)
    await this.refresh()
    if (!this.cache.has(name)) throw new Error(`script not found: ${name}`)
    this.stateOverrides.set(name, enabled)
    await this.persistEditorState()
    const manifest = await this.refresh(new Set([name]))
    return manifest.scripts.find((entry) => entry.name === name)!
  }

  private async safeEditablePath(name: string, mustExist: boolean): Promise<string> {
    if (!isScriptName(name)) throw new Error(`invalid script name: ${name}`)
    const fullPath = path.join(this.directory, name)
    if (path.dirname(fullPath) !== this.directory) throw new Error(`invalid script path: ${name}`)
    const info = await lstat(fullPath).catch(() => undefined)
    if (info?.isSymbolicLink()) throw new Error(`symbolic links are not editable: ${name}`)
    if (mustExist && (info === undefined || !info.isFile())) throw new Error(`script not found: ${name}`)
    if (!mustExist && info !== undefined) throw new Error(`script already exists: ${name}`)
    return fullPath
  }

  private async loadEditorState(): Promise<void> {
    const raw = await readFile(path.join(this.directory, EDITOR_STATE_FILE), 'utf8').catch(() => undefined)
    if (raw === undefined) return
    try {
      const parsed = JSON.parse(raw) as { scriptStates?: Record<string, unknown> }
      for (const [name, enabled] of Object.entries(parsed.scriptStates ?? {})) {
        if (isScriptName(name) && typeof enabled === 'boolean') this.stateOverrides.set(name, enabled)
      }
    } catch (error) {
      this.options.logger.warn(`[${PLUGIN_ID}] ignoring unreadable ${EDITOR_STATE_FILE}`, error)
    }
  }

  private async persistEditorState(): Promise<void> {
    const operation = this.stateWriteQueue.then(async () => {
      const target = path.join(this.directory, EDITOR_STATE_FILE)
      const temporary = `${target}.tmp`
      const scriptStates = Object.fromEntries(
        [...this.stateOverrides.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
      )
      await writeFile(temporary, `${JSON.stringify({ scriptStates }, null, 2)}\n`, 'utf8')
      try {
        await rename(temporary, target)
      } catch {
        await rm(target, { force: true })
        await rename(temporary, target)
      }
    })
    this.stateWriteQueue = operation.catch(() => undefined)
    return await operation
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private schedule(name: string | undefined): void {
    if (name !== undefined && isScriptName(name)) this.pendingNames.add(name)
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      const changed = new Set(this.pendingNames)
      this.pendingNames.clear()
      void this.refresh(changed).catch((error) => {
        this.options.logger.error(`[${PLUGIN_ID}] watched refresh failed`, error)
      })
    }, 120)
    this.debounceTimer.unref?.()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer)
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.watcher?.close()
    this.listeners.clear()
    this.pendingNames.clear()
  }
}
