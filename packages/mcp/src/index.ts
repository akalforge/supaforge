import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

async function main(): Promise<void> {
  const server = createServer(process.cwd())
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('SupaForge MCP server running on stdio')
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
