import { defineConfig } from 'tsdown'

/**
 * Bundle the plugin runtime to lib/. Harness packages stay external bare imports and resolve
 * from the host at load time; only the plugin's own modules are bundled.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
