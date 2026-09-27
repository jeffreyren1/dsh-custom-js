import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { HostScriptManager, ScriptRevisionConflictError } from './runtime/script-manager.js'
import {
  DEFAULT_SCRIPT_DIRECTORY,
  isScriptName,
  resolveScriptDirectory,
  type ScriptStateConfig,
} from './runtime/manifest.js'
import { API_ROOT, PLUGIN_ID } from './shared/types.js'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'custom-js'
export const inject = ['webServer']

export interface Config {
  readonly enabled?: boolean
  readonly autoReload?: boolean
  readonly scriptDirectory?: string
  readonly scripts?: readonly string[]
  readonly scriptStates?: readonly ScriptStateConfig[]
  readonly devLogs?: boolean
}

const ScriptStateSchema = z.object({
  name: z.string().description('脚本文件名，例如 sidebar.ts。'),
  enabled: z.boolean().default(true).description('是否加载此脚本。'),
})

export const Config: any = z.object({
  enabled: z.boolean().default(true).description('总开关；关闭时 Client 会清理并卸载全部用户脚本。'),
  autoReload: z.boolean().default(true).description('监听脚本目录；修改、添加或删除文件后自动重新加载。'),
  scriptDirectory: z.string().default(DEFAULT_SCRIPT_DIRECTORY).description('相对于 $DSH_HOME 的脚本目录；默认 custom-js。'),
  scripts: z.array(z.string()).default([]).description('优先加载顺序；未列出的脚本按文件名稳定排序。'),
  scriptStates: z.array(ScriptStateSchema).default([]).description('逐脚本启用状态；未列出的脚本默认启用。'),
  devLogs: z.boolean().default(false).description('在 Host 与浏览器控制台输出详细的扫描和重载日志。'),
})

const MANIFEST_PATH = `${API_ROOT}/manifest`
const SCRIPT_PATH = `${API_ROOT}/scripts`
const EVENTS_PATH = `${API_ROOT}/events`
const MANAGE_PATH = `${API_ROOT}/manage`
const MAX_EDITOR_BODY_BYTES = 2 * 1024 * 1024

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function requestPath(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://dsh.internal').pathname
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_EDITOR_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function openFileWithSystem(filePath: string): void {
  const [command, args] = process.platform === 'win32'
    ? ['explorer.exe', [filePath]]
    : process.platform === 'darwin'
      ? ['open', [filePath]]
      : ['xdg-open', [filePath]]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}

function badRequest(res: ServerResponse, error: string): void {
  json(res, 400, { ok: false, error })
}

function guarded(
  ctx: Context,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const connection = ctx.get('connection') as {
      requestRejection?: (request: IncomingMessage) => number | undefined
    } | undefined
    if (typeof connection?.requestRejection !== 'function') {
      text(res, 503, `${PLUGIN_ID}: connection fence unavailable`)
      return
    }

    let rejection: number | undefined
    try {
      rejection = connection.requestRejection(req)
    } catch {
      text(res, 503, `${PLUGIN_ID}: connection fence failed`)
      return
    }
    if (rejection !== undefined) {
      text(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }

    try {
      await handler(req, res)
    } catch (error) {
      ctx.logger.error(`[${PLUGIN_ID}] route failed`, error)
      if (!res.headersSent) json(res, 500, { ok: false, error: String(error) })
      else res.end()
    }
  }
}

function configured<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback
}

export function apply(ctx: Context, config: Config = {}): void {
  let directory: string
  try {
    directory = resolveScriptDirectory(config.scriptDirectory)
  } catch (error) {
    ctx.logger.error(`[${PLUGIN_ID}] invalid scriptDirectory; falling back to ${DEFAULT_SCRIPT_DIRECTORY}`, error)
    directory = resolveScriptDirectory(DEFAULT_SCRIPT_DIRECTORY)
  }

  const manager = new HostScriptManager({
    directory,
    enabled: configured(config.enabled, true),
    autoReload: configured(config.autoReload, true),
    scripts: configured(config.scripts, []),
    scriptStates: configured(config.scriptStates, []),
    devLogs: configured(config.devLogs, false),
    logger: {
      debug: (message) => ctx.logger.debug(message),
      info: (message) => ctx.logger.info(message),
      warn: (message, error) => ctx.logger.warn(message, error),
      error: (message, error) => ctx.logger.error(message, error),
    },
  })

  ctx.effect(() => {
    void manager.start().then(() => {
      ctx.logger.info(`[${PLUGIN_ID}] serving trusted user scripts from ${directory}`)
    }).catch((error) => {
      ctx.logger.error(`[${PLUGIN_ID}] initial scan failed; routes remain available for retry`, error)
    })
    return () => manager.dispose()
  }, `${PLUGIN_ID}: script manager`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MANIFEST_PATH,
    handler: guarded(ctx, async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      json(res, 200, await manager.manifest(true))
    }),
  }), `${PLUGIN_ID}: manifest route`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: SCRIPT_PATH,
    handler: guarded(ctx, async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const pathname = requestPath(req)
      const encodedName = pathname.startsWith(`${SCRIPT_PATH}/`)
        ? pathname.slice(SCRIPT_PATH.length + 1)
        : ''
      let name = ''
      try {
        name = decodeURIComponent(encodedName)
      } catch {
        json(res, 400, { ok: false, error: 'bad-name' })
        return
      }
      if (!isScriptName(name) || name.includes('/')) {
        json(res, 400, { ok: false, error: 'bad-name' })
        return
      }
      const script = await manager.script(name)
      if (script === undefined) {
        json(res, 404, { ok: false, error: 'not-found-disabled-or-not-compilable', name })
        return
      }
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        etag: `"${script.entry.revision}"`,
        'x-content-type-options': 'nosniff',
      })
      res.end(script.source)
    }),
  }), `${PLUGIN_ID}: script route`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: MANAGE_PATH,
    handler: guarded(ctx, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const operation = url.pathname.slice(MANAGE_PATH.length) || '/'

      if (req.method === 'GET' && operation === '/read') {
        const name = url.searchParams.get('name') ?? ''
        if (!isScriptName(name)) {
          badRequest(res, 'bad-name')
          return
        }
        const editable = await manager.editable(name)
        if (editable === undefined) {
          json(res, 404, { ok: false, error: 'not-found' })
          return
        }
        if (Buffer.byteLength(editable.content, 'utf8') > MAX_EDITOR_BODY_BYTES) {
          json(res, 413, { ok: false, error: 'file-too-large' })
          return
        }
        json(res, 200, { ok: true, ...editable })
        return
      }

      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        badRequest(res, 'bad-body-or-too-large')
        return
      }
      const name = typeof body.name === 'string' ? body.name : ''
      if (!isScriptName(name)) {
        badRequest(res, 'bad-name')
        return
      }

      try {
        if (operation === '/write') {
          if (typeof body.content !== 'string') {
            badRequest(res, 'bad-content')
            return
          }
          const editable = await manager.writeOriginal(
            name,
            body.content,
            typeof body.revision === 'string' ? body.revision : undefined,
          )
          json(res, 200, { ok: true, ...editable })
          return
        }
        if (operation === '/create') {
          const editable = await manager.createScript(
            name,
            typeof body.content === 'string' ? body.content : '',
          )
          json(res, 201, { ok: true, ...editable })
          return
        }
        if (operation === '/toggle') {
          if (typeof body.enabled !== 'boolean') {
            badRequest(res, 'bad-enabled')
            return
          }
          const entry = await manager.setEnabled(name, body.enabled)
          json(res, 200, { ok: true, entry })
          return
        }
        if (operation === '/delete') {
          await manager.deleteScript(name)
          json(res, 200, { ok: true, name })
          return
        }
        if (operation === '/open') {
          const editable = await manager.editable(name)
          if (editable === undefined) {
            json(res, 404, { ok: false, error: 'not-found' })
            return
          }
          openFileWithSystem(path.join(directory, name))
          json(res, 200, { ok: true, name })
          return
        }
        json(res, 404, { ok: false, error: 'not-found' })
      } catch (error) {
        if (error instanceof ScriptRevisionConflictError) {
          json(res, 409, {
            ok: false,
            error: error.code,
            currentRevision: error.currentRevision,
          })
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        const status = message.includes('not found') ? 404 : message.includes('already exists') ? 409 : 400
        json(res, status, { ok: false, error: message })
      }
    }),
  }), `${PLUGIN_ID}: script management route`)

  ctx.effect(() => {
    const clients = new Set<ServerResponse>()
    const disposeSubscription = manager.subscribe((event) => {
      const frame = `event: change\ndata: ${JSON.stringify(event)}\n\n`
      for (const client of clients) {
        try {
          client.write(frame)
        } catch {
          clients.delete(client)
        }
      }
    })

    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: EVENTS_PATH,
      handler: guarded(ctx, async (req, res) => {
        if (req.method !== 'GET') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        clients.add(res)
        const manifest = await manager.manifest()
        res.write(`event: ready\ndata: ${JSON.stringify({ revision: manifest.revision })}\n\n`)
        const remove = () => clients.delete(res)
        req.once('close', remove)
        res.once('close', remove)
      }),
    })

    return () => {
      disposeSubscription()
      disposeRoute()
      for (const client of clients) client.end()
      clients.clear()
    }
  }, `${PLUGIN_ID}: reload event route`)
}
