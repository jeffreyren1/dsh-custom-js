// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { findLiteralMatches, installSettingsStyle, outlineOf, replaceAllLiteral, SETTINGS_CSS, starterFor } from '../src/client/settings.js'
import { en, zh } from '../src/client/locales.js'

afterEach(() => {
  document.head.querySelectorAll('style[data-plugin="dsh-custom-js"]').forEach((node) => node.remove())
})

describe('generic Settings manager helpers', () => {
  it('builds lifecycle-aware JavaScript and TypeScript starters', () => {
    expect(starterFor('shortcuts.js')).toContain('export default function apply(context)')
    expect(starterFor('sidebar.ts')).toContain('context: { name: string }')
    expect(starterFor('sidebar.ts')).toContain("console.log('cleanup', context.name)")
  })

  it('extracts a compact function, class, and arrow-function outline', () => {
    const outline = outlineOf(`
export default function apply() {}
class Controller {}
export const reload = async () => {}
    `)
    expect(outline.map((entry) => entry.label)).toEqual(['apply', 'Controller', 'reload'])
    expect(outline.every((entry) => entry.offset >= 0)).toBe(true)
  })

  it('finds literal text case-insensitively and replaces every non-overlapping match', () => {
    expect(findLiteralMatches('Alpha alpha ALPHA', 'alpha')).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
      { from: 12, to: 17 },
    ])
    expect(findLiteralMatches('aaaa', 'aa')).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
    ])
    expect(replaceAllLiteral('const foo = foo', 'foo', 'bar')).toEqual({
      content: 'const bar = bar',
      count: 2,
    })
    expect(replaceAllLiteral('unchanged', '', 'x')).toEqual({ content: 'unchanged', count: 0 })
  })

  it('keeps the Chinese and English dictionaries aligned for the new editor controls', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(zh['action.replaceAll']).toBe('全部替换')
    expect(en['action.replaceAll']).toBe('Replace all')
    expect(zh['script.enableCurrent']).toBe('启用当前脚本')
  })

  it('installs theme-token-only editor styles idempotently and disposes them', () => {
    expect(SETTINGS_CSS).toContain('var(--dsw-alias-bg-layer-1)')
    expect(SETTINGS_CSS).toContain('.dshCj-codeEditor')
    expect(SETTINGS_CSS).toContain('height:350px')
    expect(SETTINGS_CSS).toContain('min-height:27px')
    expect(SETTINGS_CSS).toContain('font-size:12px')
    const dispose = installSettingsStyle()
    const secondDispose = installSettingsStyle()
    expect(document.head.querySelectorAll('style[data-plugin="dsh-custom-js"]')).toHaveLength(1)
    secondDispose()
    expect(document.head.querySelectorAll('style[data-plugin="dsh-custom-js"]')).toHaveLength(1)
    dispose()
    expect(document.head.querySelectorAll('style[data-plugin="dsh-custom-js"]')).toHaveLength(0)
  })
})
