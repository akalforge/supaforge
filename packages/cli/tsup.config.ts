import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/commands/scan.ts', 'src/commands/diff.ts', 'src/commands/hukam.ts', 'src/commands/promote.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
  outDir: 'dist',
  splitting: true,
})
