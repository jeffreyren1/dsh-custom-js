import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { API_ROOT, PLUGIN_ID, type CustomJsManifest, type ScriptManifestEntry } from '../shared/types.js'
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

const SUPPORTED_NAME = /^[A-Za-z0-9._\u4e00-\u9fff-]+\.(?:js|mjs|ts)$/i

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

export function starterFor(name: string): string {
  if (name.toLowerCase().endsWith('.ts')) {
    return `export default function apply(context: { name: string }) {\n  console.log('loaded', context.name)\n\n  return () => {\n    console.log('cleanup', context.name)\n  }\n}\n`
  }
  return `export default function apply(context) {\n  console.log('loaded', context.name)\n\n  return () => {\n    console.log('cleanup', context.name)\n  }\n}\n`
}

export const SETTINGS_CSS = `
.dshCj-row{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:16px 0;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary)}
.dshCj-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dshCj-title{font-size:14px;line-height:22px;font-weight:500}.dshCj-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshCj-toolbar,.dshCj-actions,.dshCj-statusbar,.dshCj-create{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshCj-select,.dshCj-input,.dshCj-search,.dshCj-editor{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;font:inherit;outline:none}
.dshCj-select,.dshCj-input,.dshCj-search{height:34px;padding:0 10px}.dshCj-select{min-width:180px;max-width:280px}.dshCj-input{min-width:210px}.dshCj-search{min-width:150px;flex:1}
.dshCj-select:focus,.dshCj-input:focus,.dshCj-search:focus,.dshCj-editor:focus{border-color:var(--dsw-alias-brand-primary)}
.dshCj-button{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;min-height:32px;padding:5px 11px;font:inherit;cursor:pointer}
.dshCj-button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}.dshCj-button:disabled{opacity:.5;cursor:not-allowed}.dshCj-primary{border-color:var(--dsw-alias-brand-primary)}
.dshCj-toggle{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshCj-workspace{display:grid;grid-template-columns:minmax(0,1fr) 180px;min-height:420px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dshCj-editor{width:100%;height:100%;min-height:420px;resize:vertical;border:none;border-radius:0;padding:14px 16px;box-sizing:border-box;font:12px/19px ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;tab-size:2;white-space:pre;overflow:auto}
.dshCj-outline{border-left:1px solid var(--dsw-alias-border-l1);padding:10px;background:var(--dsw-alias-bg-layer-2);overflow:auto}.dshCj-outlineTitle{font-size:12px;font-weight:600;margin-bottom:8px}.dshCj-outlineItem{display:block;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-secondary);text-align:left;padding:5px 6px;border-radius:6px;cursor:pointer;overflow:hidden;text-overflow:ellipsis}.dshCj-outlineItem:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.dshCj-statusbar{font-size:12px;color:var(--dsw-alias-label-secondary);justify-content:space-between}.dshCj-error{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}.dshCj-warn{color:var(--dsw-alias-state-warn-primary)}.dshCj-ok{color:var(--dsw-alias-state-success-primary)}
.dshCj-empty{min-height:180px;display:flex;align-items:center;justify-content:center;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;color:var(--dsw-alias-label-secondary)}
@media(max-width:900px){.dshCj-workspace{grid-template-columns:1fr}.dshCj-outline{display:none}}
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
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [deleteArmed, setDeleteArmed] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef(selected)
  const dirtyRef = useRef(false)
  selectedRef.current = selected
  dirtyRef.current = content !== baseline

  const selectedEntry = manifest?.scripts.find((entry) => entry.name === selected)
  const dirty = content !== baseline
  const outline = useMemo(() => outlineOf(content), [content])
  const matchCount = useMemo(() => {
    if (search === '') return 0
    return content.toLocaleLowerCase().split(search.toLocaleLowerCase()).length - 1
  }, [content, search])

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
    try {
      const result = await api<EditableResponse>(`${API_ROOT}/manage/write`, {
        method: 'POST',
        body: JSON.stringify({ name: selected, content, revision }),
      })
      setBaseline(result.content)
      setRevision(result.entry.revision)
      setMessage(t('status.saved', { lines: result.content.split('\n').length, characters: result.content.length }))
      await refreshManifest()
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
    try {
      await post('create', { name, content: starterFor(name) })
      setCreating(false)
      setNewName('')
      await refreshManifest()
      await readScript(name)
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
    try {
      await post('toggle', { name: selected, enabled })
      setMessage(enabled ? t('status.enabled') : t('status.disabled'))
      await refreshManifest()
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
    const imported = await file.text()
    const exists = manifest?.scripts.some((entry) => entry.name === file.name) === true
    if (exists) {
      if (selected !== file.name) await readScript(file.name)
      setSelected(file.name)
      setContent(imported)
      setMessage(t('status.importExisting'))
      return
    }
    setBusy(true)
    try {
      await post('create', { name: file.name, content: imported })
      await refreshManifest()
      await readScript(file.name)
      setMessage(t('status.importSuccess'))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [manifest, post, readScript, refreshManifest, selected])

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

  const findNext = useCallback(() => {
    if (search === '' || editorRef.current === null) return
    const editor = editorRef.current
    const from = editor.selectionEnd
    const haystack = content.toLocaleLowerCase()
    const needle = search.toLocaleLowerCase()
    let index = haystack.indexOf(needle, from)
    if (index < 0) index = haystack.indexOf(needle)
    if (index < 0) return
    editor.focus()
    editor.setSelectionRange(index, index + search.length)
  }, [content, search])

  const jumpTo = useCallback((offset: number) => {
    const editor = editorRef.current
    if (editor === null) return
    editor.focus()
    editor.setSelectionRange(offset, offset)
  }, [])

  const onEditorKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 's') {
      event.preventDefault()
      void save()
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const editor = event.currentTarget
      const start = editor.selectionStart
      const end = editor.selectionEnd
      const next = `${content.slice(0, start)}  ${content.slice(end)}`
      setContent(next)
      requestAnimationFrame(() => editor.setSelectionRange(start + 2, start + 2))
    }
  }, [content, save])

  const statusClass = problem === null ? (dirty ? 'dshCj-warn' : 'dshCj-ok') : 'dshCj-error'

  return React.createElement('div', { className: 'dshCj-row' },
    React.createElement('div', { className: 'dshCj-head' },
      React.createElement('div', null,
        React.createElement('div', { className: 'dshCj-title' }, t('title')),
        React.createElement('div', { className: 'dshCj-desc' }, t('description', { directory: manifest?.directory ?? '$DSH_HOME/custom-js/' })),
      ),
      React.createElement('label', { className: 'dshCj-toggle' },
        React.createElement('input', {
          type: 'checkbox',
          checked: selectedEntry?.enabled ?? false,
          disabled: selectedEntry === undefined || busy,
          onChange: (event) => { void toggle(event.currentTarget.checked) },
        }),
        selectedEntry?.enabled ? t('script.enabled') : t('script.disabled'),
      ),
    ),
    React.createElement('div', { className: 'dshCj-toolbar' },
      React.createElement('select', {
        className: 'dshCj-select',
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
      React.createElement('button', { className: 'dshCj-button', type: 'button', onClick: () => setCreating((value) => !value) }, creating ? t('action.cancelCreate') : t('action.create')),
      React.createElement('button', { className: 'dshCj-button', type: 'button', disabled: selected === '' || busy, onClick: () => { void post('open', { name: selected }).catch((error) => setProblem(String(error))) } }, t('action.open')),
      React.createElement('button', { className: 'dshCj-button', type: 'button', onClick: () => fileRef.current?.click() }, t('action.import')),
      React.createElement('button', { className: 'dshCj-button', type: 'button', disabled: selected === '', onClick: exportFile }, t('action.export')),
      React.createElement('button', { className: 'dshCj-button', type: 'button', disabled: selected === '' || busy, onClick: () => { void window.dshCustomJs?.reload(selected).then(() => setMessage(t('status.manualReload'))).catch((error) => setProblem(String(error))) } }, t('action.reload')),
      React.createElement('button', { className: 'dshCj-button', type: 'button', disabled: selected === '' || busy, onClick: () => { void deleteScript() } }, deleteArmed ? t('action.confirmDelete') : t('action.delete')),
    ),
    creating ? React.createElement('div', { className: 'dshCj-create' },
      React.createElement('input', { className: 'dshCj-input', value: newName, placeholder: t('create.placeholder'), onChange: (event) => setNewName(event.currentTarget.value), onKeyDown: (event) => { if (event.key === 'Enter') void createScript() } }),
      React.createElement('button', { className: 'dshCj-button dshCj-primary', type: 'button', disabled: busy, onClick: () => { void createScript() } }, t('action.createScript')),
    ) : null,
    selected === '' ? React.createElement('div', { className: 'dshCj-empty' }, t('empty.description')) : React.createElement(React.Fragment, null,
      React.createElement('div', { className: 'dshCj-actions' },
        React.createElement('input', { className: 'dshCj-search', value: search, placeholder: t('search.placeholder'), onChange: (event) => setSearch(event.currentTarget.value), onKeyDown: (event) => { if (event.key === 'Enter') findNext() } }),
        React.createElement('button', { className: 'dshCj-button', type: 'button', disabled: search === '', onClick: findNext }, search === '' ? t('action.find') : t('action.findMatches', { count: matchCount })),
        React.createElement('button', { className: 'dshCj-button dshCj-primary', type: 'button', disabled: !dirty || busy, onClick: () => { void save() } }, busy ? t('action.processing') : t('action.save')),
        React.createElement('button', { className: 'dshCj-button', type: 'button', disabled: !dirty || busy, onClick: () => { setContent(baseline); setProblem(null); setMessage(t('status.restored')) } }, t('action.discard')),
      ),
      React.createElement('div', { className: 'dshCj-workspace' },
        React.createElement('textarea', { ref: editorRef, className: 'dshCj-editor', spellCheck: false, value: content, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setContent(event.currentTarget.value), onKeyDown: onEditorKeyDown }),
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
    selectedEntry?.error !== undefined ? React.createElement('div', { className: 'dshCj-error' }, selectedEntry.error.message) : null,
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
