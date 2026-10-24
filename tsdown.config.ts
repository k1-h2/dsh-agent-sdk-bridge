import { defineConfig } from 'tsdown'

/**
 * Bundle the host half into `lib/index.js`. Declaration files come from the
 * `tsc` step that runs first (see `package.json` → `build`).
 *
 * The dsh peer packages and both Qoder SDKs stay external: the harness
 * supplies the former at runtime, and the SDKs must remain real node_modules
 * packages because their `postinstall` downloads the CLI worker runtime. The
 * international SDK is loaded through a variable dynamic import (`src/sdk.ts`),
 * which the bundler cannot resolve anyway; the rule keeps it that way.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  // The package's `exports` map names `lib/index.js`, so pin the extension
  // rather than letting tsdown pick `.mjs` from the module format.
  outExtensions: () => ({ js: '.js' }),
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: false,
  deps: {
    neverBundle: [
      /^@deepseek-ai\//,
      /^@qodercn-ai\//,
      /^@qoder-ai\//,
      'zod',
    ],
  },
})
