export const PLUGIN_ID = 'dsh-custom-js'
export const PLUGIN_VERSION = '0.4.0'
export const API_ROOT = '/api/custom-js'
export const RUNTIME_STATUS_EVENT = `${PLUGIN_ID}:runtime-status`

export type ScriptKind = 'javascript' | 'typescript'
export type ScriptPhase = 'compile' | 'load' | 'initialize' | 'runtime' | 'cleanup'

export interface ScriptErrorInfo {
  readonly phase: ScriptPhase
  readonly message: string
  readonly line?: number
  readonly column?: number
  readonly code?: number
  readonly stack?: string
}

export interface ScriptManifestEntry {
  readonly name: string
  readonly kind: ScriptKind
  readonly mtime: number
  readonly bytes: number
  readonly order: number
  readonly enabled: boolean
  readonly ready: boolean
  readonly revision: string
  readonly url?: string
  readonly error?: ScriptErrorInfo
}

export interface CustomJsManifest {
  readonly plugin: typeof PLUGIN_ID
  readonly version: string
  readonly enabled: boolean
  readonly autoReload: boolean
  readonly devLogs: boolean
  readonly directory: string
  readonly revision: string
  readonly generatedAt: number
  readonly scripts: readonly ScriptManifestEntry[]
}

export type RuntimeScriptStatus =
  | 'disabled'
  | 'compile-error'
  | 'loading'
  | 'loaded'
  | 'error'
  | 'unloaded'

export interface RuntimeScriptState {
  readonly name: string
  readonly kind: ScriptKind
  readonly order: number
  readonly enabled: boolean
  readonly revision: string
  readonly status: RuntimeScriptStatus
  readonly loadedAt?: number
  readonly error?: ScriptErrorInfo
}

export interface DshCustomJsApi {
  readonly version: string
  readonly scripts: readonly RuntimeScriptState[]
  sync(): Promise<void>
  reload(name?: string): Promise<void>
  getStatus(name: string): RuntimeScriptState | undefined
}

export interface UserScriptContext {
  readonly name: string
  readonly kind: ScriptKind
  readonly revision: string
  readonly url: string
  readonly plugin: DshCustomJsApi
  readonly logger: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'>
}

export type UserScriptCleanup = () => void | Promise<void>
export type UserScriptInitializer = (
  context: UserScriptContext,
) => void | UserScriptCleanup | Promise<void | UserScriptCleanup>

export interface UserScriptModule {
  readonly default?: UserScriptInitializer
  readonly apply?: UserScriptInitializer
  readonly init?: UserScriptInitializer
  readonly cleanup?: UserScriptCleanup
}

declare global {
  interface Window {
    dshCustomJs?: DshCustomJsApi
    __ModuleLoader__: {
      load(definition: {
        id: string
        factory: (require: (id: string) => unknown) => unknown
      }): void
    }
  }
}
