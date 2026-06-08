import { Command } from '@oclif/core'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from '../mcp/server.js'

export default class Mcp extends Command {
  static override description =
    'Start the SupaForge MCP stdio server for use with Claude Desktop, Cursor, or any MCP-compatible AI client'

  static override examples = [
    '<%= config.bin %> mcp',
    '# Claude Desktop / Cursor config:\n# { "mcpServers": { "supaforge": { "command": "supaforge", "args": ["mcp"] } } }',
  ]

  async run(): Promise<void> {
    const server = createServer(process.cwd())
    const transport = new StdioServerTransport()
    await server.connect(transport)
    // Log to stderr so it doesn't pollute MCP stdio communication
    this.warn('SupaForge MCP server running on stdio')
  }
}
