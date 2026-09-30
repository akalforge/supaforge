import { Args, Command, Flags, loadHelpClass } from '@oclif/core'

/**
 * `supaforge help [COMMAND]`.
 *
 * oclif's `helpClass` only styles the help that `--help` renders; the `help`
 * *command* comes from `@oclif/plugin-help`, which this CLI does not install.
 * So `supaforge help migrate create` — the form people reach for first, and the
 * one every other CLI accepts — answered:
 *
 *     ›   Error: command help:migrate:create not found
 *
 * which reads as "there is no such command" rather than "there is no help
 * command" (issue #97). Written here rather than added as a dependency because
 * the rendering is already ours: this hands straight to the same `helpClass`,
 * so `help X` and `X --help` produce identical output.
 */
export default class HelpCommand extends Command {
  static description = 'Display help for supaforge'

  static strict = false

  static args = {
    command: Args.string({
      description: 'Command to show help for, e.g. "diff" or "migrate create"',
      required: false,
    }),
  }

  static flags = {
    'nested-commands': Flags.boolean({
      char: 'n',
      description: 'Include all nested commands in the output',
    }),
  }

  static examples = [
    '$ supaforge help',
    '$ supaforge help diff',
    '$ supaforge help migrate create',
  ]

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(HelpCommand)

    const Help = await loadHelpClass(this.config)
    const help = new Help(this.config, {
      all: flags['nested-commands'],
      ...this.config.pjson.oclif.helpOptions,
    })

    // The whole argv, so a topic and its subcommand arrive together: oclif
    // addresses `migrate create` as one command, and passing only the first
    // argument would show the topic every time.
    await help.showHelp(argv as string[])
  }
}
