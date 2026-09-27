import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { en, NS, zh, type CustomJsLocaleKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.custom-js': CustomJsLocaleKey
  }
}

export { NS }
export type { CustomJsLocaleKey }

export function installCustomJsLocale(ctx: Context): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'dsh-custom-js: dictionaries',
  )
}
