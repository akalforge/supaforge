import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/commands/scan.ts',
    'src/commands/diff.ts',
    'src/commands/hukam.ts',
    'src/commands/promote.ts',
    'src/commands/branch/create.ts',
    'src/commands/branch/list.ts',
    'src/commands/branch/delete.ts',
    'src/commands/branch/diff.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
  outDir: 'dist',
  splitting: true,
})
