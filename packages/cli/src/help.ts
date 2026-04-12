import { Help, type Command, type Interfaces } from '@oclif/core'

/**
 * Desired command order — matches the natural workflow:
 * setup → detect → snapshot → clone → restore → easter egg
 */
const ORDER = [
  'init',
  'diff',
  'snapshot',
  'clone',
  'restore',
  'hukam',
]

export default class CustomHelp extends Help {
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
