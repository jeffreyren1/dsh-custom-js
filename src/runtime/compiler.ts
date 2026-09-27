import ts from 'typescript'
import type { ScriptErrorInfo } from '../shared/types.js'

export interface CompileResult {
  readonly code?: string
  readonly error?: ScriptErrorInfo
}

function diagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
}

function diagnosticError(
  fileName: string,
  diagnostic: ts.Diagnostic,
): ScriptErrorInfo {
  let line: number | undefined
  let column: number | undefined
  if (diagnostic.file !== undefined && diagnostic.start !== undefined) {
    const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    line = location.line + 1
    column = location.character + 1
  }
  const location = line === undefined ? '' : `:${line}:${column ?? 1}`
  return {
    phase: 'compile',
    message: `${fileName}${location} TS${diagnostic.code}: ${diagnosticMessage(diagnostic)}`,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    code: diagnostic.code,
  }
}

/** Transpile one browser-side TypeScript module with the official compiler. */
export function compileTypeScript(fileName: string, source: string): CompileResult {
  const result = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      isolatedModules: true,
      verbatimModuleSyntax: true,
      sourceMap: false,
      inlineSourceMap: true,
      inlineSources: true,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
    },
  })

  const blocking = result.diagnostics?.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  if (blocking !== undefined) return { error: diagnosticError(fileName, blocking) }

  return { code: result.outputText }
}
