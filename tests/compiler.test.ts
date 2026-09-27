import { describe, expect, it } from 'vitest'
import { compileTypeScript } from '../src/runtime/compiler.js'

describe('compileTypeScript', () => {
  it('emits browser ESM from TypeScript', () => {
    const result = compileTypeScript('sidebar.ts', `
      export default function apply(context: { name: string }) {
        const node: HTMLDivElement = document.createElement('div')
        node.dataset.script = context.name
        document.body.append(node)
        return () => node.remove()
      }
    `)

    expect(result.error).toBeUndefined()
    expect(result.code).toContain('export default function apply')
    expect(result.code).not.toContain(': HTMLDivElement')
    expect(result.code).toContain('sourceMappingURL=data:application/json')
  })

  it('reports file, line, column, and TypeScript error code', () => {
    const result = compileTypeScript('broken.ts', `const ok = 1\nconst value = "unterminated\n`)

    expect(result.code).toBeUndefined()
    expect(result.error?.phase).toBe('compile')
    expect(result.error?.message).toMatch(/broken\.ts:2:\d+ TS\d+:/)
    expect(result.error?.line).toBe(2)
  })
})
