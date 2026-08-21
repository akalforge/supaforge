import { Help, type Command, type Interfaces } from '@oclif/core'

/**
 * Environment variables a command reads, rendered as their own help section.
 *
 * These were documented only in the README, and `--help` is where users look
 * first — especially for `diff`, whose behaviour they change (issue #40).
 * Declared as a static on the command so the list sits next to the flags it
 * complements rather than in a table someone has to remember to update.
 */
export interface CommandWithEnvVars {
  envVars?: ReadonlyArray<{ name: string; description: string }>
}

function envVarsOf(command: Command.Loadable): CommandWithEnvVars['envVars'] {
  const declared = (command as unknown as CommandWithEnvVars).envVars
  return Array.isArray(declared) && declared.length > 0 ? declared : undefined
}

/**
 * Desired command order — matches the natural workflow:
 * setup → detect → snapshot → clone → restore → easter egg
 */
const ORDER = [
  'init',
  'diff',
  'sync',
  'snapshot',
  'clone',
  'restore',
  'hukam',
]

export default class CustomHelp extends Help {
  /** Append an ENVIRONMENT VARIABLES section to commands that declare one. */
  protected override formatCommand(command: Command.Loadable): string {
    const base = super.formatCommand(command)
    const envVars = envVarsOf(command)
    if (!envVars) return base

    const width = Math.max(...envVars.map(v => v.name.length))
    const rows = envVars.map(v => `  ${v.name.padEnd(width)}  ${v.description}`)
    return [base, '', 'ENVIRONMENT VARIABLES', ...rows].join('\n')
  }

  protected override get sortedCommands(): Command.Loadable[] {
    const sorted = super.sortedCommands
    const ordered = ORDER
      .map((id) => sorted.find((c) => c.id === id))
      .filter((c): c is Command.Loadable => c !== undefined)
    const rest = sorted.filter((c) => !ORDER.includes(c.id))
    return [...ordered, ...rest]
  }

  /**
   * Render only COMMANDS (no separate TOPICS section).
   * Render only COMMANDS (no separate TOPICS section).
   */
  protected override async showRootHelp(): Promise<void> {
    const state = this.config.pjson?.oclif?.state as string | undefined
    if (state) {
      this.log(state === 'deprecated' ? `${this.config.bin} is deprecated` : `${this.config.bin} is in ${state}.\n`)
    }

    this.log(this.formatRoot())
    this.log('')

    // Merge topics into the commands list so everything appears in one section.
    const rootCommands = this.sortedCommands.filter((c) => c.id && !c.id.includes(':'))
    const rootTopics = this.sortedTopics.filter((t) => !t.name.includes(':'))

    // Build topic entries that look like commands (id + description).
    const topicAsCommand = rootTopics
      .filter((t) => !rootCommands.some((c) => c.id === t.name))
      .map((t) => ({ id: t.name, summary: t.description ?? '' }) as unknown as Command.Loadable)

    // Merge and re-sort by ORDER
    const all = [...rootCommands, ...topicAsCommand]
    const ordered = ORDER
      .map((id) => all.find((c) => c.id === id))
      .filter((c): c is Command.Loadable => c !== undefined)
    const rest = all.filter((c) => !ORDER.includes(c.id))
    const merged = [...ordered, ...rest]

    if (merged.length > 0) {
      this.log(this.formatCommands(merged))
      this.log('')
    }
  }
}
