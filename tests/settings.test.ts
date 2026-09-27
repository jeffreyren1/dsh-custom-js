// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { installSettingsStyle, outlineOf, SETTINGS_CSS, starterFor } from '../src/client/settings.js'

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

  it('installs theme-token-only editor styles idempotently and disposes them', () => {
    expect(SETTINGS_CSS).toContain('var(--dsw-alias-bg-layer-1)')
    const dispose = installSettingsStyle()
    const secondDispose = installSettingsStyle()
    expect(document.head.querySelectorAll('style[data-plugin="dsh-custom-js"]')).toHaveLength(1)
    secondDispose()
    expect(document.head.querySelectorAll('style[data-plugin="dsh-custom-js"]')).toHaveLength(1)
    dispose()
    expect(document.head.querySelectorAll('style[data-plugin="dsh-custom-js"]')).toHaveLength(0)
  })
})
