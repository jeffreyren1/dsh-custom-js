import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { API_ROOT, PLUGIN_ID, RUNTIME_STATUS_EVENT, type CustomJsManifest, type RuntimeScriptState, type ScriptKind, type ScriptManifestEntry } from '../shared/types.js'
import { CodeEditor, type CodeEditorHandle } from './code-editor.js'
import type { CustomJsLocaleKey } from './locales.js'

interface EditableResponse {
  readonly ok: true
  readonly entry: ScriptManifestEntry
  readonly content: string
}

interface MutationResponse {
  readonly ok: true
  readonly entry?: ScriptManifestEntry
  readonly name?: string
}

interface ApiFailure {
  readonly ok: false
  readonly error: string
  readonly currentRevision?: string
}

interface OutlineEntry {
  readonly label: string
  readonly offset: number
}

export interface TextMatch {
  readonly from: number
  readonly to: number
}

const SUPPORTED_NAME = /^[A-Za-z0-9._\u4e00-\u9fff-]+\.(?:js|mjs|ts)$/i
const MAX_IMPORT_BYTES = 2 * 1024 * 1024

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...init,
    headers: init?.body === undefined
      ? init?.headers
      : { 'content-type': 'application/json', ...init.headers },
  })
  const payload = await response.json() as T | ApiFailure
  if (!response.ok || (payload as ApiFailure).ok === false) {
    const failure = payload as ApiFailure
    const error = new Error(failure.error || `HTTP ${response.status}`) as Error & { status?: number; currentRevision?: string }
    error.status = response.status
    error.currentRevision = failure.currentRevision
    throw error
  }
  return payload as T
}

export function outlineOf(source: string): OutlineEntry[] {
  const results: OutlineEntry[] = []
  const pattern = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    results.push({ label: match[1] ?? match[2] ?? 'anonymous', offset: match.index })
  }
  return results
}

export function findLiteralMatches(source: string, query: string): TextMatch[] {
  if (query === '') return []
  const haystack = source.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  const matches: TextMatch[] = []
  let from = 0
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) break
    matches.push({ from: index, to: index + query.length })
    from = index + Math.max(query.length, 1)
  }
  return matches
}

export function replaceAllLiteral(source: string, query: string, replacement: string): { readonly content: string; readonly count: number } {
  const matches = findLiteralMatches(source, query)
  if (matches.length === 0) return { content: source, count: 0 }
  let result = ''
  let cursor = 0
  for (const match of matches) {
    result += source.slice(cursor, match.from)
    result += replacement
    cursor = match.to
  }
  result += source.slice(cursor)
  return { content: result, count: matches.length }
}

export function starterFor(name: string): string {
  if (name.toLowerCase().endsWith('.ts')) {
    return `export default function apply(context: { name: string }) {\n  console.log('loaded', context.name)\n\n  return () => {\n    console.log('cleanup', context.name)\n  }\n}\n`
  }
  return `export default function apply(context) {\n  console.log('loaded', context.name)\n\n  return () => {\n    console.log('cleanup', context.name)\n  }\n}\n`
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText !== undefined) {
    await navigator.clipboard.writeText(value)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('clipboard-unavailable')
}

export const SETTINGS_CSS = `
.dshCj-row{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:16px 0;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary)}
.dshCj-head,.dshCj-toolbar,.dshCj-toolbarGroup,.dshCj-actions,.dshCj-statusbar,.dshCj-create,.dshCj-directory,.dshCj-findReplace{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshCj-head,.dshCj-toolbar,.dshCj-statusbar{justify-content:space-between}.dshCj-toolbarGroup{min-width:0}
.dshCj-title{font-size:14px;line-height:22px;font-weight:500}.dshCj-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshCj-directory{padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2)}.dshCj-directory code{min-width:110px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font:11px/16px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
.dshCj-select,.dshCj-input,.dshCj-search,.dshCj-replace{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;font:inherit;font-size:12px;line-height:18px;outline:none;height:29px;padding:0 8px}
.dshCj-select{min-width:180px;max-width:300px}.dshCj-input{min-width:180px}.dshCj-search,.dshCj-replace{min-width:135px;flex:1}
.dshCj-select:focus,.dshCj-input:focus,.dshCj-search:focus,.dshCj-replace:focus,.dshCj-codeEditor:focus-within{border-color:var(--dsw-alias-brand-primary)}
.dshCj-button{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:7px;min-height:27px;padding:3px 8px;font:inherit;font-size:12px;line-height:17px;cursor:pointer;white-space:nowrap}
.dshCj-button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}.dshCj-button:disabled{opacity:.5;cursor:not-allowed}.dshCj-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-brand,#fff)}.dshCj-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent)}
.dshCj-toggle{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.dshCj-toggle input{accent-color:var(--dsw-alias-brand-primary);width:13px;height:13px}
.dshCj-unsaved{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);vertical-align:middle;margin-left:3px}.dshCj-shortcut{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshCj-findReplace{padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}.dshCj-matchCount{min-width:42px;text-align:center;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshCj-runtimeError{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.dshCj-workspace{display:grid;grid-template-columns:minmax(0,1fr) 165px;height:350px;min-height:350px;max-height:350px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dshCj-codeEditor{min-width:0;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dshCj-outline{height:100%;min-height:0;box-sizing:border-box;border-left:1px solid var(--dsw-alias-border-l1);padding:8px;background:var(--dsw-alias-bg-layer-2);overflow:auto}.dshCj-outlineTitle{font-size:11px;font-weight:600;margin-bottom:6px}.dshCj-outlineItem{display:block;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-secondary);text-align:left;padding:4px 5px;border-radius:5px;font-size:11px;cursor:pointer;overflow:hidden;text-overflow:ellipsis}.dshCj-outlineItem:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.dshCj-statusbar{font-size:12px;color:var(--dsw-alias-label-secondary)}.dshCj-error{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}.dshCj-warn{color:var(--dsw-alias-state-warn-primary)}.dshCj-ok{color:var(--dsw-alias-state-success-primary)}
.dshCj-empty{min-height:180px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;color:var(--dsw-alias-label-secondary)}
@media(max-width:900px){.dshCj-workspace{grid-template-columns:1fr}.dshCj-outline{display:none}.dshCj-findReplace>*{flex:1 1 140px}}
`

interface CustomJsManagerProps {
  readonly t: Translate<CustomJsLocaleKey>
}

export function CustomJsManagerRow({ t }: CustomJsManagerProps): React.ReactElement {
  const [manifest, setManifest] = useState<CustomJsManifest | null>(null)
  const [selected, setSelected] = useState('')
  const [content, setContent] = useState('')
  const [baseline, setBaseline] = useState('')
  const [revision, setRevision] = useState('')
  const [message, setMessage] = useState(() => t('status.readingManifest'))
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [replacement, setReplacement] = useState('')
  const [activeMatch, setActiveMatch] = useState(-1)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [runtimeState, setRuntimeState] = useState<RuntimeScriptState | undefined>()
  const editorRef = useRef<CodeEditorHandle>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef(selected)
  const dirtyRef = useRef(false)
  selectedRef.current = selected
  dirtyRef.current = content !== baseline

  const selectedEntry = manifest?.scripts.find((entry) => entry.name === selected)
  const selectedKind: ScriptKind = selectedEntry?.kind ?? (selected.toLowerCase().endsWith('.ts') ? 'typescript' : 'javascript')
  const dirty = content !== baseline
  const outline = useMemo(() => outlineOf(content), [content])
  const matches = useMemo(() => findLiteralMatches(content, search), [content, search])

  useEffect(() => {
    const update = () => setRuntimeState(window.dshCustomJs?.getStatus(selected))
    update()
    const onRuntimeStatus = (event: Event) => {
      const state = (event as CustomEvent<RuntimeScriptState>).detail
      if (state.name === selected) setRuntimeState(state)
    }
    window.addEventListener(RUNTIME_STATUS_EVENT, onRuntimeStatus)
    return () => window.removeEventListener(RUNTIME_STATUS_EVENT, onRuntimeStatus)
  }, [selected])

  useEffect(() => setActiveMatch(-1), [content, search])
  useEffect(() => {
    if (!deleteArmed) return
    const timer = window.setTimeout(() => setDeleteArmed(false), 5000)
    return () => window.clearTimeout(timer)
  }, [deleteArmed])

  const readScript = useCallback(async (name: string) => {
    if (name === '') return
    setBusy(true)
    setProblem(null)
    try {
      const result = await api<EditableResponse>(`${API_ROOT}/manage/read?name=${encodeURIComponent(name)}`)
      setSelected(name)
      setContent(result.content)
      setBaseline(result.content)
      setRevision(result.entry.revision)
      setMessage(t('status.read', { lines: result.content.split('\n').length }))
      setDeleteArmed(false)
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [])

  const refreshManifest = useCallback(async (reloadCleanSelection = false) => {
    try {
      const next = await api<CustomJsManifest>(`${API_ROOT}/manifest`)
      setManifest(next)
      const current = selectedRef.current
      const nextName = next.scripts.some((entry) => entry.name === current)
        ? current
        : next.scripts[0]?.name ?? ''
      if (nextName !== current || current === '') {
        if (!dirtyRef.current && nextName !== '') await readScript(nextName)
        if (nextName === '') {
          setSelected('')
          setContent('')
          setBaseline('')
          setRevision('')
          setMessage(t('status.directoryEmpty'))
        }
      } else if (reloadCleanSelection && !dirtyRef.current) {
        const entry = next.scripts.find((item) => item.name === current)
        if (entry !== undefined && entry.revision !== revision) await readScript(current)
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    }
  }, [readScript, revision])

  useEffect(() => {
    void refreshManifest()
    const source = new EventSource(`${API_ROOT}/events`)
    const onChange = () => { void refreshManifest(true) }
    source.addEventListener('change', onChange)
    return () => source.close()
  }, [refreshManifest])

  const save = useCallback(async () => {
    if (selected === '' || !dirty) return
    setBusy(true)
    setProblem(null)
    setDeleteArmed(false)
    try {
      const result = await api<EditableResponse>(`${API_ROOT}/manage/write`, {
        method: 'POST',
        body: JSON.stringify({ name: selected, content, revision }),
      })
      setBaseline(result.content)
      setRevision(result.entry.revision)
      await refreshManifest()
      if (result.entry.enabled) await window.dshCustomJs?.sync()
      setMessage(result.entry.enabled
        ? t('status.savedAndApplied', { lines: result.content.split('\n').length, characters: result.content.length })
        : t('status.saved', { lines: result.content.split('\n').length, characters: result.content.length }))
    } catch (error) {
      const value = error as Error & { status?: number }
      setProblem(value.status === 409 ? t('status.externalConflict') : value.message)
    } finally {
      setBusy(false)
    }
  }, [content, dirty, refreshManifest, revision, selected])

  const post = useCallback(async (operation: string, body: Record<string, unknown>) => {
    return await api<MutationResponse>(`${API_ROOT}/manage/${operation}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }, [])

  const createScript = useCallback(async () => {
    const name = newName.trim()
    if (!SUPPORTED_NAME.test(name)) {
      setProblem(t('status.invalidName'))
      return
    }
    setBusy(true)
    setProblem(null)
    setDeleteArmed(false)
    try {
      await post('create', { name, content: starterFor(name), enabled: true })
      setCreating(false)
      setNewName('')
      await refreshManifest()
      await readScript(name)
      await window.dshCustomJs?.sync()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [newName, post, readScript, refreshManifest])

  const toggle = useCallback(async (enabled: boolean) => {
    if (selected === '') return
    setBusy(true)
    setProblem(null)
    setDeleteArmed(false)
    try {
      await post('toggle', { name: selected, enabled })
      await refreshManifest()
      await window.dshCustomJs?.sync()
      setMessage(enabled ? t('status.enabled') : t('status.disabled'))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [post, refreshManifest, selected])

  const deleteScript = useCallback(async () => {
    if (selected === '') return
    if (!deleteArmed) {
      setDeleteArmed(true)
      setMessage(t('status.confirmDelete'))
      return
    }
    setBusy(true)
    try {
      await post('delete', { name: selected })
      await window.dshCustomJs?.sync()
      setSelected('')
      setContent('')
      setBaseline('')
      setRevision('')
      setDeleteArmed(false)
      await refreshManifest()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [deleteArmed, post, refreshManifest, selected])

  const importFile = useCallback(async (file: File) => {
    if (!SUPPORTED_NAME.test(file.name)) {
      setProblem(t('status.invalidImport'))
      return
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setProblem(t('status.importTooLarge'))
      return
    }
    if (dirty && selected !== file.name) {
      setProblem(t('status.unsavedSwitch'))
      return
    }
    const imported = await file.text()
    const exists = manifest?.scripts.some((entry) => entry.name === file.name) === true
    if (exists) {
      if (selected !== file.name) await readScript(file.name)
      setSelected(file.name)
      setContent(imported)
      setMessage(t('status.importExisting'))
      setDeleteArmed(false)
      return
    }
    setBusy(true)
    setProblem(null)
    setDeleteArmed(false)
    try {
      await post('create', { name: file.name, content: imported, enabled: false })
      await refreshManifest()
      await readScript(file.name)
      setMessage(t('status.importSuccessDisabled'))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [dirty, manifest, post, readScript, refreshManifest, selected])

  const exportFile = useCallback(() => {
    if (selected === '') return
    const blob = new Blob([content], { type: 'text/javascript;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = selected
    anchor.click()
    URL.revokeObjectURL(url)
  }, [content, selected])

  const openDirectory = useCallback(async () => {
    setProblem(null)
    try {
      await post('open-directory', {})
      setMessage(t('status.directoryOpened'))
    } catch {
      setProblem(t('status.openDirectoryFailed'))
    }
  }, [post])

  const copyDirectory = useCallback(async () => {
    const directory = manifest?.directory
    if (directory === undefined) return
    try {
      await copyText(directory)
      setMessage(t('status.pathCopied'))
    } catch {
      setProblem(t('status.copyFailed'))
    }
  }, [manifest?.directory])

  const retry = useCallback(async () => {
    if (selected === '' || dirty) return
    setBusy(true)
    setProblem(null)
    setDeleteArmed(false)
    try {
      await window.dshCustomJs?.reload(selected)
      setRuntimeState(window.dshCustomJs?.getStatus(selected))
      setMessage(t('status.retrySucceeded'))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [dirty, selected])

  const selectMatch = useCallback((index: number) => {
    const match = matches[index]
    if (match === undefined) return
    setActiveMatch(index)
    editorRef.current?.select(match.from, match.to)
  }, [matches])

  const findNext = useCallback((direction: 1 | -1 = 1) => {
    if (matches.length === 0) {
      setMessage(t('status.noMatches'))
      return
    }
    let index = activeMatch
    if (index < 0 || index >= matches.length) {
      const selection = editorRef.current?.selection() ?? { from: 0, to: 0 }
      if (direction === 1) {
        index = matches.findIndex((match) => match.from >= selection.to)
        if (index < 0) index = 0
      } else {
        index = matches.length - 1
        while (index >= 0 && matches[index]!.to > selection.from) index -= 1
        if (index < 0) index = matches.length - 1
      }
    } else {
      index = (index + direction + matches.length) % matches.length
    }
    selectMatch(index)
  }, [activeMatch, matches, selectMatch])

  const replaceCurrent = useCallback(() => {
    if (matches.length === 0) {
      setMessage(t('status.noMatches'))
      return
    }
    if (activeMatch < 0 || matches[activeMatch] === undefined) {
      findNext(1)
      return
    }
    const match = matches[activeMatch]!
    const next = `${content.slice(0, match.from)}${replacement}${content.slice(match.to)}`
    setContent(next)
    setMessage(t('status.replacedOne'))
    setActiveMatch(-1)
    requestAnimationFrame(() => editorRef.current?.select(match.from, match.from + replacement.length))
  }, [activeMatch, content, findNext, matches, replacement])

  const replaceAll = useCallback(() => {
    const result = replaceAllLiteral(content, search, replacement)
    if (result.count === 0) {
      setMessage(t('status.noMatches'))
      return
    }
    setContent(result.content)
    setMessage(t('status.replacedAll', { count: result.count }))
    setActiveMatch(-1)
    requestAnimationFrame(() => editorRef.current?.focus())
  }, [content, replacement, search])

  const jumpTo = useCallback((offset: number) => {
    editorRef.current?.select(offset)
  }, [])

  const discard = useCallback(() => {
    setContent(baseline)
    setProblem(null)
    setMessage(t('status.restored'))
    setDeleteArmed(false)
  }, [baseline])

  const statusClass = problem === null ? (dirty ? 'dshCj-warn' : 'dshCj-ok') : 'dshCj-error'
  const directory = manifest?.directory ?? '$DSH_HOME/custom-js/'
  const saveApplies = selectedEntry?.enabled === true
  const retryAvailable = runtimeState?.status === 'error'

  return React.createElement('div', { className: 'dshCj-row' },
    React.createElement('div', { className: 'dshCj-head' },
      React.createElement('div', null,
        React.createElement('div', { className: 'dshCj-title' }, t('title')),
        React.createElement('div', { className: 'dshCj-desc' }, t('description')),
      ),
    ),
    React.createElement('div', { className: 'dshCj-directory' },
      React.createElement('span', { className: 'dshCj-desc' }, t('directory.label')),
      React.createElement('code', { title: directory }, directory),
      React.createElement('button', { className: 'dshCj-button', type: 'button', disabled: manifest === null, onClick: () => { void copyDirectory() } }, t('action.copyPath')),
      React.createElement('button', { className: 'dshCj-button', type: 'button', disabled: manifest === null, onClick: () => { void openDirectory() } }, t('action.openDirectory')),
    ),
    React.createElement('div', { className: 'dshCj-toolbar' },
      React.createElement('div', { className: 'dshCj-toolbarGroup' },
        React.createElement('select', {
          className: 'dshCj-select',
          'aria-label': t('script.selectLabel'),
          value: selected,
          disabled: busy || manifest?.scripts.length === 0,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
            const name = event.currentTarget.value
            if (dirty) {
              setProblem(t('status.unsavedSwitch'))
              return
            }
            void readScript(name)
          },
        },
        (manifest?.scripts ?? []).map((entry) => React.createElement('option', { key: entry.name, value: entry.name }, `${entry.name}${entry.enabled ? '' : t('script.disabledSuffix')}`))),
        dirty ? React.createElement('span', { className: 'dshCj-unsaved', title: t('status.unsaved') }) : null,
        React.createElement('label', { className: 'dshCj-toggle' },
          React.createElement('input', {
            type: 'checkbox',
            checked: selectedEntry?.enabled ?? false,
            disabled: selectedEntry === undefined || busy || dirty,
            onChange: (event) => { void toggle(event.currentTarget.checked) },
          }),
          t('script.enableCurrent'),
        ),
      ),
      React.createElement('div', { className: 'dshCj-toolbarGroup' },
        React.createElement('button', { className: 'dshCj-button', type: 'button', onClick: () => { setCreating((value) => !value); setDeleteArmed(false) } }, creating ? t('action.cancelCreate') : t('action.create')),
        React.createElement('button', { className: 'dshCj-button', type: 'button', onClick: () => { setDeleteArmed(false); fileRef.current?.click() } }, t('action.import')),
        React.createElement('button', { className: 'dshCj-button', type: 'button', disabled: selected === '', onClick: exportFile }, t('action.export')),
        React.createElement('button', { className: 'dshCj-button dshCj-danger', type: 'button', disabled: selected === '' || busy, onClick: () => { void deleteScript() } }, deleteArmed ? t('action.confirmDelete') : t('action.delete')),
      ),
    ),
    creating ? React.createElement('div', { className: 'dshCj-create' },
      React.createElement('input', { className: 'dshCj-input', value: newName, autoFocus: true, placeholder: t('create.placeholder'), onChange: (event) => setNewName(event.currentTarget.value), onKeyDown: (event) => { if (event.key === 'Enter') void createScript(); if (event.key === 'Escape') setCreating(false) } }),
      React.createElement('button', { className: 'dshCj-button dshCj-primary', type: 'button', disabled: busy, onClick: () => { void createScript() } }, t('action.createScript')),
    ) : null,
    selected === '' ? React.createElement('div', { className: 'dshCj-empty' }, t('empty.description')) : React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'dshCj-findReplace' },
        React.createElement('input', {
          ref: searchRef,
          className: 'dshCj-search',
          value: search,
          placeholder: t('search.placeholder'),
          'aria-label': t('search.placeholder'),
          onChange: (event) => setSearch(event.currentTarget.value),
          onKeyDown: (event) => { if (event.key === 'Enter') findNext(event.shiftKey ? -1 : 1) },
        }),
        React.createElement('input', {
          className: 'dshCj-replace',
          value: replacement,
          placeholder: t('search.replacePlaceholder'),
          'aria-label': t('search.replacePlaceholder'),
          onChange: (event) => setReplacement(event.currentTarget.value),
          onKeyDown: (event) => { if (event.key === 'Enter') replaceCurrent() },
        }),
        React.createElement('span', { className: 'dshCj-matchCount' }, t('search.matchCount', { current: activeMatch < 0 ? 0 : activeMatch + 1, total: matches.length })),
        React.createElement('button', { className: 'dshCj-button', type: 'button', disabled: matches.length === 0, onClick: () => findNext(-1) }, t('action.findPrevious')),
        React.createElement('button', { className: 'dshCj-button', type: 'button', disabled: matches.length === 0, onClick: () => findNext(1) }, t('action.findNext')),
        React.createElement('button', { className: 'dshCj-button', type: 'button', disabled: matches.length === 0, onClick: replaceCurrent }, t('action.replace')),
        React.createElement('button', { className: 'dshCj-button', type: 'button', disabled: matches.length === 0, onClick: replaceAll }, t('action.replaceAll')),
      ),
      React.createElement('div', { className: 'dshCj-actions' },
        React.createElement('span', { className: 'dshCj-desc' }, saveApplies ? t('save.applyHint') : t('save.saveHint')),
        React.createElement('span', { style: { flex: 1 } }),
        React.createElement('button', { className: 'dshCj-button', type: 'button', disabled: !dirty || busy, onClick: discard }, t('action.discard')),
        React.createElement('button', { className: 'dshCj-button dshCj-primary', type: 'button', disabled: !dirty || busy, onClick: () => { void save() } }, busy ? t('action.processing') : saveApplies ? t('action.saveAndApply') : t('action.save')),
        React.createElement('span', { className: 'dshCj-shortcut' }, t('shortcut.save')),
      ),
      React.createElement('div', { className: 'dshCj-workspace' },
        React.createElement(CodeEditor, {
          ref: editorRef,
          value: content,
          kind: selectedKind,
          ariaLabel: t('editor.label'),
          onChange: setContent,
          onSave: () => { void save() },
          onFind: () => { searchRef.current?.focus(); searchRef.current?.select() },
        }),
        React.createElement('aside', { className: 'dshCj-outline' },
          React.createElement('div', { className: 'dshCj-outlineTitle' }, t('outline.title', { count: outline.length })),
          outline.length === 0 ? React.createElement('div', { className: 'dshCj-desc' }, t('outline.empty')) : outline.map((item, index) => React.createElement('button', { key: `${item.label}-${index}`, className: 'dshCj-outlineItem', type: 'button', onClick: () => jumpTo(item.offset) }, item.label)),
        ),
      ),
    ),
    React.createElement('div', { className: 'dshCj-statusbar' },
      React.createElement('span', { className: statusClass }, problem ?? (dirty ? t('status.unsaved') : message)),
      React.createElement('span', null, selected === '' ? '' : t('script.metrics', {
        kind: selectedEntry?.kind === 'typescript' ? 'TypeScript' : 'JavaScript',
        lines: content.split('\n').length,
        characters: content.length,
      })),
    ),
    selectedEntry?.error !== undefined || retryAvailable ? React.createElement('div', { className: 'dshCj-error dshCj-runtimeError' },
      React.createElement('span', null, selectedEntry?.error?.message ?? runtimeState?.error?.message ?? t('status.runtimeFailed')),
      retryAvailable ? React.createElement('button', {
        className: 'dshCj-button',
        type: 'button',
        disabled: busy || dirty || selected === '',
        title: dirty ? t('status.retryRequiresSaved') : undefined,
        onClick: () => { void retry() },
      }, t('action.retry')) : null,
    ) : null,
    React.createElement('input', {
      ref: fileRef,
      type: 'file',
      accept: '.js,.mjs,.ts,text/javascript,application/javascript',
      style: { display: 'none' },
      onChange: (event) => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (file !== undefined) void importFile(file)
      },
    }),
  )
}

export function installSettingsStyle(): () => void {
  const id = `${PLUGIN_ID}-settings-style`
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${id}"]`)
  if (existing !== null) return () => undefined
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = id
  tag.textContent = SETTINGS_CSS
  document.head.append(tag)
  return () => tag.remove()
}
