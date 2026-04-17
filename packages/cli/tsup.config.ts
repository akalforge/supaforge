import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/help.ts',
    'src/base-command.ts',
    'src/commands/init.ts',
    'src/commands/diff.ts',
    'src/commands/hukam.ts',
    'src/commands/snapshot.ts',
    'src/commands/clone.ts',
    'src/commands/restore.ts',
    'src/commands/sync.ts',
    'src/commands/migrate/run.ts',
    'src/commands/migrate/baseline.ts',
    'src/commands/migrate/create.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
  outDir: 'dist',
  splitting: true,
})
