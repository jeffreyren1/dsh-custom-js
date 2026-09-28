import type { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, directoryOpenCommand } from '../src/index.js'
import { HostScriptManager } from '../src/runtime/script-manager.js'

interface RegisteredRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface TestHarness {
  readonly origin: string
  readonly root: string
  readonly logs: { readonly error: ReturnType<typeof vi.fn> }
  dispose(): Promise<void>
}

const harnesses: TestHarness[] = []

function matches(route: RegisteredRoute, pathname: string): boolean {
  if (route.kind === 'exact') return pathname === route.path
  return pathname === route.path || pathname.startsWith(`${route.path}/`)
}

async function createHarness(connection: unknown = {
  requestRejection: () => undefined,
}): Promise<TestHarness> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-custom-js-routes-'))
  const routes: RegisteredRoute[] = []
  const disposers: Array<() => void | Promise<void>> = []
  const logs = {
    error: vi.fn(),
  }
  const context = {
    get(service: string) {
      return service === 'connection' ? connection : undefined
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error: logs.error,
    },
    webServer: {
      register(route: RegisteredRoute) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    effect(register: () => void | (() => void | Promise<void>)) {
      const disposer = register()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  } as unknown as Context

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    apply(context, { autoReload: false })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const route = routes.find((candidate) => matches(candidate, pathname))
    if (route === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    void Promise.resolve(route.handler(req, res)).catch((error) => {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  let disposed = false
  const harness: TestHarness = {
    origin: `http://127.0.0.1:${address.port}`,
    root,
    logs,
    async dispose() {
      if (disposed) return
      disposed = true
      for (const disposer of [...disposers].reverse()) await disposer()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
      })
      await rm(root, { recursive: true, force: true })
    },
  }
  harnesses.push(harness)
  return harness
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

async function postJson(harness: TestHarness, operation: string, payload: unknown): Promise<Response> {
  return await fetch(`${harness.origin}/api/custom-js/manage/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(harnesses.splice(0).map(async (harness) => await harness.dispose()))
})

describe('Host HTTP routes', () => {
  it('builds platform folder-opening commands without shell interpolation', () => {
    const windowsDirectory = 'C:\\Users\\Test & Data\\.dsh\\custom-js'
    expect(directoryOpenCommand(windowsDirectory, 'win32', 'C:\\Windows')).toEqual({
      command: 'C:\\Windows\\explorer.exe',
      args: [windowsDirectory],
    })
    expect(directoryOpenCommand('/Users/test/.dsh/custom-js', 'darwin')).toEqual({
      command: 'open',
      args: ['/Users/test/.dsh/custom-js'],
    })
    expect(directoryOpenCommand('/home/test/.dsh/custom-js', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['/home/test/.dsh/custom-js'],
    })
  })

  it('fails closed when the connection fence is absent, broken, or rejects a request', async () => {
    const absent = await createHarness(null)
    const absentResponse = await fetch(`${absent.origin}/api/custom-js/manifest`)
    expect(absentResponse.status).toBe(503)
    expect(await absentResponse.text()).toContain('connection fence unavailable')

    const broken = await createHarness({ requestRejection: () => { throw new Error('broken fence') } })
    const brokenResponse = await fetch(`${broken.origin}/api/custom-js/manifest`)
    expect(brokenResponse.status).toBe(503)
    expect(await brokenResponse.text()).toContain('connection fence failed')

    const unauthorized = await createHarness({ requestRejection: () => 401 })
    const unauthorizedResponse = await fetch(`${unauthorized.origin}/api/custom-js/manifest`)
    expect(unauthorizedResponse.status).toBe(401)
    expect(await unauthorizedResponse.text()).toBe('unauthorized')

    const forbidden = await createHarness({ requestRejection: () => 403 })
    const forbiddenResponse = await fetch(`${forbidden.origin}/api/custom-js/manifest`)
    expect(forbiddenResponse.status).toBe(403)
    expect(await forbiddenResponse.text()).toBe('forbidden')
  })

  it('rejects unsupported methods, unsafe names, encoded traversal, and oversized bodies', async () => {
    const harness = await createHarness()

    const wrongMethod = await fetch(`${harness.origin}/api/custom-js/manifest`, { method: 'POST' })
    expect(wrongMethod.status).toBe(405)
    expect(await body(wrongMethod)).toMatchObject({ ok: false, error: 'method-not-allowed' })

    const traversal = await fetch(`${harness.origin}/api/custom-js/scripts/%2E%2E%2Fevil.js`)
    expect(traversal.status).toBe(400)
    expect(await body(traversal)).toMatchObject({ ok: false, error: 'bad-name' })

    const backslash = await fetch(`${harness.origin}/api/custom-js/scripts/C%3A%5Cevil.js`)
    expect(backslash.status).toBe(400)
    expect(await body(backslash)).toMatchObject({ ok: false, error: 'bad-name' })

    const manageTraversal = await fetch(`${harness.origin}/api/custom-js/manage/read?name=..%2Fevil.js`)
    expect(manageTraversal.status).toBe(400)
    expect(await body(manageTraversal)).toMatchObject({ ok: false, error: 'bad-name' })

    const wrongManageMethod = await fetch(`${harness.origin}/api/custom-js/manage/read?name=safe.js`, { method: 'PUT' })
    expect(wrongManageMethod.status).toBe(405)
    expect(await body(wrongManageMethod)).toMatchObject({ ok: false, error: 'method-not-allowed' })

    const oversized = await postJson(harness, 'create', {
      name: 'large.js',
      content: 'x'.repeat(2 * 1024 * 1024),
    })
    expect(oversized.status).toBe(400)
    expect(await body(oversized)).toMatchObject({ ok: false, error: 'bad-body-or-too-large' })
  })

  it('uses stable error codes for conflicts and missing files without exposing paths', async () => {
    const harness = await createHarness()
    const createdResponse = await postJson(harness, 'create', {
      name: 'managed.js',
      content: 'export const value = 1\n',
    })
    expect(createdResponse.status).toBe(201)
    const created = await body(createdResponse) as {
      readonly entry: { readonly revision: string }
    }

    const staleResponse = await postJson(harness, 'write', {
      name: 'managed.js',
      content: 'export const value = 2\n',
      revision: 'stale-revision',
    })
    expect(staleResponse.status).toBe(409)
    const stale = await body(staleResponse)
    expect(stale).toMatchObject({ ok: false, error: 'revision-conflict' })
    expect(stale.currentRevision).toBe(created.entry.revision)

    const duplicateResponse = await postJson(harness, 'create', {
      name: 'managed.js',
      content: '',
    })
    expect(duplicateResponse.status).toBe(409)
    const duplicateText = await duplicateResponse.text()
    expect(JSON.parse(duplicateText)).toMatchObject({ ok: false, error: 'already-exists' })
    expect(duplicateText).not.toContain(harness.root)

    const disabledImportResponse = await postJson(harness, 'create', {
      name: 'imported.js',
      content: 'window.imported = true\n',
      enabled: false,
    })
    expect(disabledImportResponse.status).toBe(201)
    expect(await body(disabledImportResponse)).toMatchObject({ entry: { enabled: false } })
    expect((await fetch(`${harness.origin}/api/custom-js/scripts/imported.js`)).status).toBe(404)
    expect((await fetch(`${harness.origin}/api/custom-js/manage/read?name=imported.js`)).status).toBe(200)

    const unsafeOpenResponse = await postJson(harness, 'open', { name: 'managed.js' })
    expect(unsafeOpenResponse.status).toBe(404)
    expect(await body(unsafeOpenResponse)).toMatchObject({ ok: false, error: 'not-found' })

    const missingResponse = await postJson(harness, 'delete', { name: 'missing.js' })
    expect(missingResponse.status).toBe(404)
    const missingText = await missingResponse.text()
    expect(JSON.parse(missingText)).toMatchObject({ ok: false, error: 'not-found' })
    expect(missingText).not.toContain(harness.root)
  })

  it.skipIf(process.platform === 'win32')('rejects symbolic links through management routes', async () => {
    const harness = await createHarness()
    const target = path.join(harness.root, 'outside.js')
    const link = path.join(harness.root, 'custom-js', 'linked.js')
    await writeFile(target, 'export const outside = true\n')
    await symlink(target, link, 'file')

    const response = await postJson(harness, 'delete', { name: 'linked.js' })
    expect(response.status).toBe(400)
    expect(await body(response)).toMatchObject({ ok: false, error: 'symbolic-link-not-allowed' })
  })

  it('sanitizes unexpected internal errors while logging the original error', async () => {
    const secret = path.join(tmpdir(), 'private', 'token.txt')
    vi.spyOn(HostScriptManager.prototype, 'manifest').mockRejectedValueOnce(new Error(`cannot read ${secret}`))
    const harness = await createHarness()

    const response = await fetch(`${harness.origin}/api/custom-js/manifest`)
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({ ok: false, error: 'internal-error' })
    expect(text).not.toContain(secret)
    expect(harness.logs.error).toHaveBeenCalled()
  })

  it('ends open server-sent event streams when the plugin is disposed', async () => {
    const harness = await createHarness()
    const response = await fetch(`${harness.origin}/api/custom-js/events`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    let initialFrames = ''
    for (let attempt = 0; attempt < 5 && !initialFrames.includes('event: ready'); attempt += 1) {
      const chunk = await reader.read()
      expect(chunk.done).toBe(false)
      initialFrames += new TextDecoder().decode(chunk.value)
    }
    expect(initialFrames).toContain('event: ready')

    const pending = reader.read()
    await harness.dispose()
    await expect(pending).resolves.toMatchObject({ done: true })
  })
})
