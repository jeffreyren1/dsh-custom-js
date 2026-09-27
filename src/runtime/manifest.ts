import { homedir } from 'node:os'
import path from 'node:path'
import type { ScriptKind } from '../shared/types.js'

export const DEFAULT_SCRIPT_DIRECTORY = 'custom-js'
export const SCRIPT_NAME_PATTERN = /^[A-Za-z0-9._\u4e00-\u9fff-]+\.(?:js|mjs|ts)$/i
export const MAX_SCRIPT_NAME_LENGTH = 160
export const MAX_SCRIPTS = 500

export interface ScriptStateConfig {
  readonly name: string
  readonly enabled: boolean
}

export interface ManifestOrderingConfig {
  readonly scripts: readonly string[]
  readonly scriptStates: readonly ScriptStateConfig[]
}

export function dshHome(): string {
  return path.resolve(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'))
}

export function resolveScriptDirectory(configured = DEFAULT_SCRIPT_DIRECTORY): string {
  const home = dshHome()
  const candidate = path.resolve(home, configured || DEFAULT_SCRIPT_DIRECTORY)
  const relative = path.relative(home, candidate)
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`scriptDirectory must resolve below DSH_HOME: ${configured}`)
  }
  return candidate
}

export function scriptKind(name: string): ScriptKind | undefined {
  const lower = name.toLowerCase()
  if (lower.endsWith('.ts')) return 'typescript'
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'javascript'
  return undefined
}

export function isScriptName(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= MAX_SCRIPT_NAME_LENGTH
    && !name.includes('..')
    && SCRIPT_NAME_PATTERN.test(name)
    && scriptKind(name) !== undefined
}

export function deterministicNames(
  names: readonly string[],
  configured: readonly string[],
): string[] {
  const available = new Set(names)
  const seen = new Set<string>()
  const ordered: string[] = []

  for (const name of configured) {
    if (!available.has(name) || seen.has(name)) continue
    seen.add(name)
    ordered.push(name)
  }

  const remaining = names.filter((name) => !seen.has(name))
  remaining.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  ordered.push(...remaining)
  return ordered
}

export function configuredEnabled(
  name: string,
  states: readonly ScriptStateConfig[],
): boolean {
  for (let index = states.length - 1; index >= 0; index -= 1) {
    const state = states[index]
    if (state?.name === name) return state.enabled
  }
  return true
}
