import { Command } from '@oclif/core'
import { listBranches } from '../../branch'

export default class BranchList extends Command {
  static override description = 'List all tracked database branches'

  static override examples = ['<%= config.bin %> branch list']

  async run(): Promise<void> {
    const branches = await listBranches()

    if (branches.length === 0) {
      this.log('\nNo branches found. Create one with: supaforge branch create <name>\n')
      return
    }

    this.log(`\n🌿 ${branches.length} branch(es):\n`)
    for (const b of branches) {
      this.log(`  ${b.name}`)
      this.log(`    Database: ${b.dbName}`)
      this.log(`    From: ${b.createdFrom}`)
      this.log(`    Created: ${b.createdAt}`)
      this.log(`    Schema only: ${b.schemaOnly}`)
      this.log('')
    }
  }
}
