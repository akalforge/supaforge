import { colorize } from '@oclif/core/ux'

type Style = Parameters<typeof colorize>[0]

/** Apply an oclif color/style to text. */
export const c = (style: Style, text: string): string => colorize(style, text)

/** Green text for success messages. */
export const ok = (text: string): string => c('green', text)

/** Yellow text for warnings. */
export const warn = (text: string): string => c('yellow', text)

/** Dim text for hints and secondary info. */
export const dim = (text: string): string => c('dim', text)

/** Cyan text for commands and URIs. */
export const cmd = (text: string): string => c('cyan', text)

/** Bold text for headings and emphasis. */
export const bold = (text: string): string => c('bold', text)

/** Log an array of hint lines in dim. */
export function printHints(lines: readonly string[], log: (msg: string) => void): void {
  for (const line of lines) {
    log(dim(line))
  }
}

const BANNER = `
  ███████╗██╗   ██╗██████╗  █████╗ ███████╗ ██████╗ ██████╗  ██████╗ ███████╗
  ██╔════╝██║   ██║██╔══██╗██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝
  ███████╗██║   ██║██████╔╝███████║█████╗  ██║   ██║██████╔╝██║  ███╗█████╗
  ╚════██║██║   ██║██╔═══╝ ██╔══██║██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝
  ███████║╚██████╔╝██║     ██║  ██║██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗
  ╚══════╝ ╚═════╝ ╚═╝     ╚═╝  ╚═╝╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝`

const TAGLINE = '  precision developer tools, forged to last'
const CREDIT = 'by Akal Forge'

/** Print the SupaForge ASCII banner. */
export function printBanner(log: (msg: string) => void): void {
  log(c('greenBright', BANNER))
  log(`  ${dim(TAGLINE)}  ${dim('·')}  ${dim(CREDIT)}\n`)
}
