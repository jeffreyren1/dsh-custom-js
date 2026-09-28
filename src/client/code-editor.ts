import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { Compartment, EditorState } from '@codemirror/state'
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import React, { useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import type { ScriptKind } from '../shared/types.js'

export interface CodeEditorHandle {
  focus(): void
  selection(): { readonly from: number; readonly to: number }
  select(from: number, to?: number): void
}

interface CodeEditorProps {
  readonly value: string
  readonly kind: ScriptKind
  readonly ariaLabel: string
  readonly onChange: (value: string) => void
  readonly onSave: () => void
  readonly onFind: () => void
}

const languageTheme = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.operatorKeyword], color: 'var(--dsw-alias-brand-primary)' },
  { tag: [tags.string, tags.regexp], color: 'var(--dsw-alias-state-success-primary)' },
  { tag: [tags.number, tags.bool, tags.null, tags.typeName, tags.className], color: 'var(--dsw-alias-state-warn-primary)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--dsw-alias-label-tertiary, #7f848e)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: 'var(--dsw-alias-link-default, #61afef)' },
  { tag: tags.propertyName, color: 'var(--dsw-alias-label-secondary)' },
  { tag: tags.operator, color: 'var(--dsw-alias-label-primary)' },
])

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    minHeight: '0',
    backgroundColor: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    height: '100%',
    minHeight: '0',
    overflow: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
    fontSize: '12px',
    lineHeight: '19px',
  },
  '.cm-content': {
    minHeight: '100%',
    padding: '10px 0',
    caretColor: 'var(--dsw-alias-brand-primary)',
  },
  '.cm-line': { padding: '0 16px' },
  '.cm-gutters': {
    backgroundColor: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-secondary)',
    borderRight: '1px solid var(--dsw-alias-border-l1)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent) !important',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--dsw-alias-brand-primary)',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent)',
    outline: '1px solid var(--dsw-alias-brand-primary)',
  },
})

export const CodeEditor = React.forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor({
  value,
  kind,
  ariaLabel,
  onChange,
  onSave,
  onFind,
}, forwardedRef): React.ReactElement {
  const mountRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onFindRef = useRef(onFind)
  const applyingExternalRef = useRef(false)
  const languageCompartmentRef = useRef(new Compartment())

  valueRef.current = value
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onFindRef.current = onFind

  useImperativeHandle(forwardedRef, () => ({
    focus() {
      viewRef.current?.focus()
    },
    selection() {
      const range = viewRef.current?.state.selection.main
      return { from: range?.from ?? 0, to: range?.to ?? 0 }
    },
    select(from: number, to = from) {
      const view = viewRef.current
      if (view === null) return
      const length = view.state.doc.length
      const anchor = Math.max(0, Math.min(from, length))
      const head = Math.max(anchor, Math.min(to, length))
      view.dispatch({
        selection: { anchor, head },
        scrollIntoView: true,
      })
      view.focus()
    },
  }), [])

  useLayoutEffect(() => {
    if (mountRef.current === null) return
    const languageCompartment = languageCompartmentRef.current
    const view = new EditorView({
      parent: mountRef.current,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          rectangularSelection(),
          syntaxHighlighting(languageTheme),
          editorTheme,
          languageCompartment.of(javascript({ typescript: kind === 'typescript' })),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || applyingExternalRef.current) return
            const next = update.state.doc.toString()
            valueRef.current = next
            onChangeRef.current(next)
          }),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                onSaveRef.current()
                return true
              },
            },
            {
              key: 'Mod-f',
              preventDefault: true,
              run: () => {
                onFindRef.current()
                return true
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [ariaLabel])

  useEffect(() => {
    const view = viewRef.current
    if (view === null || view.state.doc.toString() === value) return
    applyingExternalRef.current = true
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    } finally {
      applyingExternalRef.current = false
    }
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    view.dispatch({
      effects: languageCompartmentRef.current.reconfigure(javascript({ typescript: kind === 'typescript' })),
    })
  }, [kind])

  return React.createElement('div', { className: 'dshCj-codeEditor', ref: mountRef })
})
