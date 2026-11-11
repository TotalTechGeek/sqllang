/**
 * Produces the published build in `dist/`:
 *
 *   dist/esm/index.js   ES module
 *   dist/cjs/index.js   CommonJS
 *   dist/types/*.d.ts   hand-written type declarations (copied from ./types)
 *
 * `json-logic-engine` stays external so it resolves to whatever version the
 * consumer installed. `grammatik` never appears in the output as a dependency:
 * it is a build-time tool that generates `src/parser.js`, and the small runtime
 * that file imports (`grammatik/runtime`) is bundled in here.
 *
 * The parser is regenerated first by the `prebuild` script, so `npm run build`
 * is still one command.
 */

import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'src', 'index.js')
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

const shared = {
  entryPoints: [entry],
  bundle: true,
  external: ['json-logic-engine'],
  platform: 'neutral',
  target: ['es2021', 'node18'],
  logLevel: 'warning'
}

await build({ ...shared, format: 'esm', outfile: join(dist, 'esm', 'index.js') })
await build({ ...shared, format: 'cjs', outfile: join(dist, 'cjs', 'index.js'), platform: 'node' })
// A minified ESM build, for size reporting and for anyone who wants it.
await build({ ...shared, format: 'esm', minify: true, outfile: join(dist, 'esm', 'index.min.js') })

// The package is `"type": "module"`, so a bare `.js` under dist/cjs would load as
// ESM. These per-directory markers pin each format without renaming to .mjs/.cjs.
writeFileSync(join(dist, 'esm', 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n')
writeFileSync(join(dist, 'cjs', 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n')

// Hand-written declarations: the public API's types are known precisely, which
// beats inferring `any` from JSDoc.
cpSync(join(root, 'types'), join(dist, 'types'), { recursive: true })

const kb = (n) => (n / 1024).toFixed(1) + ' KB'
for (const file of ['esm/index.js', 'cjs/index.js', 'esm/index.min.js']) {
  const path = join(dist, file)
  console.log(`  dist/${file.padEnd(18)} ${kb(statSync(path).size).padStart(9)}   gzip ${kb(gzipSync(readFileSync(path)).length)}`)
}
console.log('built dist/esm, dist/cjs and dist/types')
