// Run after `npm run build`: the published bundles load and work, as ESM and as CommonJS,
// resolved through package.json "exports" exactly as a consumer would resolve them.
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const esm = await import('sqllang')
const cjs = require('sqllang')

const orders = [{ id: 1, c: 'a', total: 10 }, { id: 2, c: 'a', total: 5 }, { id: 3, c: 'b', total: 7 }]
const sql = 'SELECT c, SUM(total) AS s FROM orders GROUP BY c ORDER BY c'
for (const [name, lib] of [['esm', esm], ['cjs', cjs]]) {
  const rows = lib.query(sql, { orders })
  assert.deepEqual(rows, [{ c: 'a', s: 15 }, { c: 'b', s: 7 }], name)
  assert.deepEqual(rows.columns, ['c', 's'], name)
  assert.throws(() => lib.compile('SELECT'), lib.SqlSyntaxError, name)
  assert.throws(() => lib.query('SELECT * FROM o a, o b', { o: orders }, { limits: { maxRows: 2 } }), lib.SqlLimitError, name)
  assert.equal(typeof lib.SAFE_LIMITS.timeoutMs, 'number', name)
}
console.log('dist ok: esm + cjs')
