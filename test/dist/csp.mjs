// Run with `node --disallow-code-generation-from-strings`: `new Function`/`eval` throw,
// as under a Content-Security-Policy without 'unsafe-eval'. The generated parser and
// `interpreted: true` must work without either.
import assert from 'node:assert/strict'
import { query, compile, prepare } from '../../src/index.js'

assert.throws(() => new Function('return 1'), 'code generation should be disabled here')

const t = [{ id: 1, g: 'a', v: 3, j: '{"k": [1, 2]}' }, { id: 2, g: 'a', v: null, j: null }, { id: 3, g: 'b', v: 5, j: '{"k": []}' }]
const opts = { interpreted: true }
assert.deepEqual(
  query("SELECT g, COUNT(*) AS n, SUM(v) AS s FROM t WHERE id > 0 AND g LIKE '%' GROUP BY g ORDER BY g", { t }, opts),
  [{ g: 'a', n: 2, s: 3 }, { g: 'b', n: 1, s: 5 }]
)
assert.deepEqual(
  query('SELECT t.id, k.value AS k FROM t, UNNEST(t.j.k) k ORDER BY 1, 2', { t }, opts),
  [{ id: 1, k: 1 }, { id: 1, k: 2 }]
)
assert.deepEqual(
  query('SELECT id, ROW_NUMBER() OVER (PARTITION BY g ORDER BY id DESC) AS rn FROM t ORDER BY id', { t }, opts).map((r) => r.rn),
  [2, 1, 1]
)
assert.ok(compile('WITH x AS (SELECT 1 AS a) SELECT * FROM x').statements.length === 1)
assert.equal(prepare('SELECT COUNT(*) AS n FROM t WHERE v IN (SELECT v FROM t)', opts).query({ t })[0].n, 2)

// Without `interpreted`, building expressions needs code generation, and says so.
assert.throws(() => query('SELECT id FROM t WHERE v > 1', { t }))
console.log('csp ok: parser + interpreted execution run without code generation')
