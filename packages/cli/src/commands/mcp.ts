import { Command, Flags } from '@oclif/core'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from '../mcp/server.js'

export default class Mcp extends Command {
  static override description =
    'Start the SupaForge MCP stdio server for use with Claude Desktop, Cursor, or any MCP-compatible AI client'

  static override examples = [
    '<%= config.bin %> mcp',
    '<%= config.bin %> mcp --allow-config-path',
    '# Claude Desktop / Cursor config:\n# { "mcpServers": { "supaforge": { "command": "supaforge", "args": ["mcp"] } } }',
  ]

  static override flags = {
    'allow-config-path': Flags.boolean({
      description:
        'Let a client choose which supaforge.config.json to load. Off by default: '
        + 'a tool call, or a prompt injected into one, could otherwise point the '
        + 'server at any config on disk — including one holding production '
        + 'credentials — bypassing the one it was started with.',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Mcp)
    const server = createServer(process.cwd(), {
      allowConfigPath: flags['allow-config-path'],
    })
    const transport = new StdioServerTransport()
    await server.connect(transport)
    // Log to stderr so it doesn't pollute MCP stdio communication
    this.warn('SupaForge MCP server running on stdio')
  }
}
