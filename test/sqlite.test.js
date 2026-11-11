// Differential test: run the same queries through sqllang and node:sqlite over
// the same randomly generated (but seeded, so deterministic) tables, and compare
// the results row by row, positionally.
//
// Known, intentional dialect differences are normalized rather than flagged:
//   - booleans: sqllang yields true/false where SQLite yields 1/0; sqllang
//     booleans are mapped to 1/0 before comparing.
//   - `/` is always float division in sqllang; the corpus never divides two
//     integers without making one side REAL (`* 1.0`), so both agree.
//   - NULL ordering: sqllang sorts NULLs last ascending, SQLite first. Every
//     ORDER BY (including inside OVER) on a nullable key says NULLS FIRST/LAST.
//   - LIKE: SQLite's is ASCII case-insensitive by default; the SQLite side runs
//     with PRAGMA case_sensitive_like = ON to match sqllang (and Postgres).
//   - floating point sums may differ in the last bits depending on summation
//     order, so numbers compare with a small relative tolerance.
//   - unqualified names in a subquery always resolve to the subquery's own FROM
//     in sqllang (data is schemaless), so correlated references are qualified.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
// node:sqlite arrived in Node 22.5 and `setReturnArrays` later still; on older
// Node the comparison is skipped rather than failed (CI covers Node 18+).
let sqlite = null
try { sqlite = await import('node:sqlite') } catch {}
const available = sqlite !== null && typeof sqlite.StatementSync?.prototype?.setReturnArrays === 'function'
import { query } from '../src/index.js'

// -- seeded data -----------------------------------------------------------------

function mulberry32 (seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(20261110)
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))
const pick = (xs) => xs[Math.floor(rand() * xs.length)]
const maybe = (p, f) => (rand() < p ? null : f())

const WORDS = ['apple', 'banana', 'cherry', 'date', 'fig', 'grape', 'Apple', 'kiwi', 'lemon', 'a_b']

const t1 = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  a: maybe(0.15, () => int(-5, 10)),
  b: maybe(0.15, () => Math.round((rand() * 200 - 50)) / 4), // quarters: exact in binary
  s: maybe(0.15, () => pick(WORDS)),
  g: maybe(0.1, () => pick(['x', 'y', 'z']))
}))

const t2 = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  t1_id: maybe(0.1, () => int(1, 45)),
  qty: maybe(0.1, () => int(0, 6)),
  label: maybe(0.2, () => pick(['red', 'green', 'blue', 'x', 'y']))
}))

const db = available ? new sqlite.DatabaseSync(':memory:') : null
if (db) {
  db.exec('PRAGMA case_sensitive_like = ON')
  db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY, a INTEGER, b REAL, s TEXT, g TEXT)')
  db.exec('CREATE TABLE t2 (id INTEGER PRIMARY KEY, t1_id INTEGER, qty INTEGER, label TEXT)')
  const ins1 = db.prepare('INSERT INTO t1 VALUES (?, ?, ?, ?, ?)')
  for (const r of t1) ins1.run(r.id, r.a, r.b, r.s, r.g)
  const ins2 = db.prepare('INSERT INTO t2 VALUES (?, ?, ?, ?)')
  for (const r of t2) ins2.run(r.id, r.t1_id, r.qty, r.label)
}

const data = { t1, t2 }

// -- comparison -------------------------------------------------------------------------

function normalize (v) {
  if (v === undefined) return null
  if (v === true) return 1
  if (v === false) return 0
  if (typeof v === 'bigint') return Number(v)
  return v
}

function sameValue (x, y) {
  if (typeof x === 'number' && typeof y === 'number') {
    if (x === y) return true
    return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y))
  }
  return x === y
}

function runSqlite (sql) {
  const stmt = db.prepare(sql)
  stmt.setReturnArrays(true)
  return stmt.all().map((r) => r.map(normalize))
}

function runSqllang (sql) {
  const rows = query(sql, data)
  return rows.map((r) => rows.columns.map((c) => normalize(r[c])))
}

const canonical = (rows) => rows.map((r) => JSON.stringify(r)).sort()

function compareResults (sql, ordered) {
  const expected = runSqlite(sql)
  let actual = runSqllang(sql)
  let exp = expected
  if (!ordered) {
    const byKey = (rows) => [...rows].sort((p, q) => {
      const a = JSON.stringify(p); const b = JSON.stringify(q)
      return a < b ? -1 : a > b ? 1 : 0
    })
    exp = byKey(expected)
    actual = byKey(actual)
  }
  const detail = () => `\nSQL: ${sql}\nsqlite:  ${JSON.stringify(exp)}\nsqllang: ${JSON.stringify(actual)}`
  assert.equal(actual.length, exp.length, 'row count differs' + detail())
  for (let i = 0; i < exp.length; i++) {
    assert.equal(actual[i].length, exp[i].length, `row ${i} width differs` + detail())
    for (let j = 0; j < exp[i].length; j++) {
      if (!sameValue(actual[i][j], exp[i][j])) {
        assert.fail(`row ${i} column ${j}: sqlite ${JSON.stringify(exp[i][j])} vs sqllang ${JSON.stringify(actual[i][j])}` + detail())
      }
    }
  }
  return canonical(exp)
}

// -- corpus -------------------------------------------------------------------------------
//
// Each entry: a SQL string (ordered result), or { sql, unordered, todo }.

const corpus = [
  // projection, filters, arithmetic
  'SELECT id, a, b, s, g FROM t1 ORDER BY id',
  'SELECT id, a + 1, a - 2, a * 3, -a FROM t1 ORDER BY id',
  'SELECT id, a * 1.0 / 4, b / 2, b * a FROM t1 WHERE a <> 0 ORDER BY id',
  'SELECT id, a % 3, a % -4 FROM t1 WHERE a IS NOT NULL ORDER BY id',
  'SELECT id FROM t1 WHERE a > 3 ORDER BY id',
  'SELECT id FROM t1 WHERE a >= 3 AND b < 10 ORDER BY id',
  'SELECT id FROM t1 WHERE a < 0 OR b > 30 ORDER BY id',
  'SELECT id FROM t1 WHERE NOT (a > 3) ORDER BY id',
  'SELECT id FROM t1 WHERE a IS NULL ORDER BY id',
  'SELECT id FROM t1 WHERE s IS NOT NULL AND g IS NULL ORDER BY id',
  'SELECT id FROM t1 WHERE a = 3 OR a IS NULL ORDER BY id',
  'SELECT id, a > 3, a = b, a IS NULL, NOT (a < 2) FROM t1 ORDER BY id',
  'SELECT id, (a > 3) AND (b > 0), (a > 3) OR (b > 0) FROM t1 ORDER BY id',
  'SELECT id FROM t1 WHERE a BETWEEN 2 AND 6 ORDER BY id',
  'SELECT id FROM t1 WHERE a NOT BETWEEN 2 AND 6 ORDER BY id',
  'SELECT id FROM t1 WHERE a IN (1, 3, 5) ORDER BY id',
  'SELECT id FROM t1 WHERE a NOT IN (1, 3, 5) ORDER BY id',
  'SELECT id FROM t1 WHERE a NOT IN (1, NULL) ORDER BY id',
  'SELECT id, a IN (1, NULL), a NOT IN (2, 3) FROM t1 ORDER BY id',
  "SELECT id FROM t1 WHERE s IN ('apple', 'fig') ORDER BY id",
  "SELECT id, s FROM t1 WHERE s LIKE 'a%' ORDER BY id",
  "SELECT id, s FROM t1 WHERE s LIKE '%an%' ORDER BY id",
  "SELECT id, s FROM t1 WHERE s LIKE '_i%' ORDER BY id",
  "SELECT id, s FROM t1 WHERE s NOT LIKE '%e' ORDER BY id",
  "SELECT id, s LIKE 'A%' FROM t1 ORDER BY id",
  'SELECT id, a IS DISTINCT FROM 3, a IS NOT DISTINCT FROM NULL FROM t1 ORDER BY id',

  // expressions and functions
  "SELECT id, CASE WHEN a > 5 THEN 'big' WHEN a > 0 THEN 'small' ELSE 'other' END FROM t1 ORDER BY id",
  "SELECT id, CASE g WHEN 'x' THEN 1 WHEN 'y' THEN 2 END FROM t1 ORDER BY id",
  'SELECT id, CASE WHEN a IS NULL THEN -1 ELSE a END FROM t1 ORDER BY id',
  "SELECT id, COALESCE(a, b, -99), COALESCE(s, g, 'none') FROM t1 ORDER BY id",
  'SELECT id, NULLIF(a, 3), IFNULL(g, s) FROM t1 ORDER BY id',
  "SELECT id, s || '-' || g, UPPER(s), LOWER(s), LENGTH(s) FROM t1 ORDER BY id",
  'SELECT id, SUBSTR(s, 2, 3), SUBSTR(s, 3), REPLACE(s, \'a\', \'@\') FROM t1 ORDER BY id',
  "SELECT id, TRIM('  ' || s || '  '), INSTR(s, 'an') FROM t1 ORDER BY id",
  'SELECT id, ABS(a), ROUND(b), ROUND(b, 1), ABS(b) FROM t1 ORDER BY id',
  'SELECT id, CAST(b AS INTEGER), CAST(a AS REAL), CAST(a AS TEXT) FROM t1 ORDER BY id',
  'SELECT id, a FROM t1 WHERE a + 0.0 = CAST(a AS REAL) * 1 ORDER BY id',

  // ORDER BY / LIMIT / DISTINCT
  'SELECT id, a FROM t1 ORDER BY a NULLS FIRST, id',
  'SELECT id, a FROM t1 ORDER BY a DESC NULLS LAST, id DESC',
  'SELECT id, b FROM t1 ORDER BY b ASC NULLS LAST, id LIMIT 5',
  'SELECT id, s FROM t1 ORDER BY s NULLS FIRST, id LIMIT 7 OFFSET 3',
  'SELECT id, a + b AS ab FROM t1 ORDER BY ab DESC NULLS LAST, id',
  'SELECT id, g FROM t1 ORDER BY 2 NULLS FIRST, 1 DESC',
  'SELECT DISTINCT g FROM t1 ORDER BY g NULLS FIRST',
  'SELECT DISTINCT a, g FROM t1 ORDER BY a NULLS LAST, g NULLS LAST',
  'SELECT id FROM t1 ORDER BY id LIMIT 0',
  'SELECT id FROM t1 ORDER BY id DESC LIMIT 3 OFFSET 38',

  // aggregates
  'SELECT COUNT(*), COUNT(a), COUNT(DISTINCT a), SUM(a), MIN(a), MAX(a), AVG(a) FROM t1',
  'SELECT SUM(b), MIN(b), MAX(b), AVG(b), MIN(s), MAX(s) FROM t1',
  'SELECT COUNT(*), SUM(a), MAX(s) FROM t1 WHERE id > 1000',
  'SELECT g, COUNT(*), SUM(a), AVG(b) FROM t1 GROUP BY g ORDER BY g NULLS FIRST',
  'SELECT g, s, COUNT(*) FROM t1 GROUP BY g, s ORDER BY g NULLS LAST, s NULLS LAST',
  'SELECT g, COUNT(*) AS n FROM t1 GROUP BY g HAVING COUNT(*) > 10 ORDER BY g NULLS LAST',
  'SELECT g, SUM(a) FROM t1 GROUP BY g HAVING SUM(a) > 20 OR g IS NULL ORDER BY g NULLS FIRST',
  'SELECT a % 3 AS m, COUNT(*) FROM t1 WHERE a IS NOT NULL GROUP BY a % 3 ORDER BY m',
  'SELECT g, COUNT(DISTINCT s), SUM(DISTINCT a) FROM t1 GROUP BY g ORDER BY g NULLS LAST',
  'SELECT g, MAX(a) - MIN(a), SUM(a) * 1.0 / COUNT(*) FROM t1 GROUP BY g ORDER BY 1 NULLS FIRST',
  'SELECT g, COUNT(*) FROM t1 GROUP BY 1 ORDER BY 2 DESC, 1 NULLS LAST',
  'SELECT g, COUNT(*) FILTER (WHERE a > 0), SUM(b) FILTER (WHERE s IS NOT NULL) FROM t1 GROUP BY g ORDER BY g NULLS LAST',
  "SELECT g, GROUP_CONCAT(s, '|' ORDER BY s, id) FROM t1 WHERE s IS NOT NULL GROUP BY g ORDER BY g NULLS LAST",
  'SELECT label, COUNT(*), TOTAL(qty) FROM t2 GROUP BY label ORDER BY label NULLS FIRST',

  // joins
  'SELECT t1.id, t2.id FROM t1 JOIN t2 ON t1.id = t2.t1_id ORDER BY t1.id, t2.id',
  'SELECT t1.id, t2.id, t2.qty FROM t1 LEFT JOIN t2 ON t1.id = t2.t1_id ORDER BY t1.id, t2.id NULLS FIRST',
  'SELECT t1.id, t2.id FROM t1 LEFT JOIN t2 ON t1.id = t2.t1_id AND t2.qty > 2 ORDER BY t1.id, t2.id NULLS FIRST',
  'SELECT t1.id, t2.id FROM t2 RIGHT JOIN t1 ON t1.id = t2.t1_id ORDER BY t1.id, t2.id NULLS FIRST',
  'SELECT t1.id, t2.id FROM t1 FULL JOIN t2 ON t1.id = t2.t1_id ORDER BY t1.id NULLS LAST, t2.id NULLS LAST',
  'SELECT t1.id, t2.id FROM t1 JOIN t2 ON t1.a = t2.qty AND t1.id < t2.id ORDER BY t1.id, t2.id',
  'SELECT t1.id, t2.id FROM t1 JOIN t2 ON t1.a > t2.qty + 4 ORDER BY t1.id, t2.id',
  'SELECT x.id, y.id FROM t1 x JOIN t1 y ON x.a = y.a AND x.id < y.id ORDER BY x.id, y.id',
  'SELECT x.id, y.id FROM t1 x, t1 y WHERE x.g = y.g AND x.a = y.a + 1 ORDER BY x.id, y.id',
  'SELECT t1.id, t2.id FROM t1 CROSS JOIN t2 WHERE t1.id <= 3 AND t2.id <= 2 ORDER BY t1.id, t2.id',
  'SELECT t1.g, COUNT(t2.id), SUM(t2.qty) FROM t1 LEFT JOIN t2 ON t2.t1_id = t1.id GROUP BY t1.g ORDER BY t1.g NULLS LAST',
  'SELECT t1.id, t2.id FROM t1 JOIN t2 ON t1.g = t2.label ORDER BY t1.id, t2.id',

  // set operations
  { sql: 'SELECT a FROM t1 UNION SELECT qty FROM t2', unordered: true },
  { sql: 'SELECT a FROM t1 UNION ALL SELECT qty FROM t2', unordered: true },
  { sql: 'SELECT a FROM t1 EXCEPT SELECT qty FROM t2', unordered: true },
  { sql: 'SELECT a FROM t1 INTERSECT SELECT qty FROM t2', unordered: true },
  { sql: 'SELECT g FROM t1 UNION SELECT label FROM t2', unordered: true },
  { sql: 'SELECT g, a FROM t1 EXCEPT SELECT label, qty FROM t2', unordered: true },
  'SELECT a FROM t1 UNION SELECT qty FROM t2 ORDER BY 1 NULLS FIRST',
  'SELECT g AS k FROM t1 UNION SELECT label FROM t2 ORDER BY k DESC NULLS LAST LIMIT 4',
  { sql: 'SELECT a FROM t1 UNION SELECT qty FROM t2 EXCEPT SELECT 3', unordered: true },

  // subqueries
  'SELECT id, (SELECT COUNT(*) FROM t2 WHERE t2.t1_id = t1.id) FROM t1 ORDER BY id',
  'SELECT id FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.t1_id = t1.id AND t2.qty > 3) ORDER BY id',
  'SELECT id FROM t1 WHERE NOT EXISTS (SELECT 1 FROM t2 WHERE t2.t1_id = t1.id) ORDER BY id',
  'SELECT id FROM t1 WHERE id IN (SELECT t1_id FROM t2 WHERE qty >= 4) ORDER BY id',
  'SELECT id FROM t1 WHERE id NOT IN (SELECT t1_id FROM t2) ORDER BY id',
  'SELECT id FROM t1 WHERE id NOT IN (SELECT t1_id FROM t2 WHERE t1_id IS NOT NULL) ORDER BY id',
  'SELECT id FROM t2 WHERE qty > (SELECT AVG(a) FROM t1) ORDER BY id',
  'SELECT sub.g, sub.n FROM (SELECT g, COUNT(*) AS n FROM t1 GROUP BY g) sub WHERE sub.n > 5 ORDER BY sub.g NULLS FIRST',
  'SELECT id, (SELECT MAX(t2.qty) FROM t2 WHERE t2.t1_id <= t1.id) FROM t1 ORDER BY id',
  'WITH big AS (SELECT id, a FROM t1 WHERE a > 4), cnt AS (SELECT COUNT(*) AS n FROM big) SELECT big.id, cnt.n FROM big, cnt ORDER BY big.id',
  'WITH g AS (SELECT g, SUM(a) AS s FROM t1 GROUP BY g) SELECT g.g, g.s, t2.id FROM g JOIN t2 ON g.g = t2.label ORDER BY g.g, t2.id',
  // A subquery reading the same table as the outer query.
  { sql: 'SELECT id FROM t1 WHERE a > (SELECT AVG(a) FROM t1) ORDER BY id' },
  { sql: 'SELECT id FROM t1 WHERE a = (SELECT MAX(x.a) FROM t1 x) ORDER BY id' },
  { sql: 'SELECT id, (SELECT COUNT(*) FROM t1 x WHERE x.g = t1.g) FROM t1 ORDER BY id' },

  // window functions
  'SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) FROM t1 ORDER BY id',
  'SELECT id, g, ROW_NUMBER() OVER (PARTITION BY g ORDER BY id) FROM t1 ORDER BY id',
  'SELECT id, a, RANK() OVER (ORDER BY a NULLS LAST), DENSE_RANK() OVER (ORDER BY a NULLS LAST) FROM t1 ORDER BY id',
  'SELECT id, a, RANK() OVER (PARTITION BY g ORDER BY a DESC NULLS FIRST) FROM t1 ORDER BY id',
  'SELECT id, a, SUM(a) OVER (ORDER BY a NULLS FIRST), COUNT(*) OVER (ORDER BY a NULLS FIRST) FROM t1 ORDER BY id',
  'SELECT id, g, SUM(a) OVER (PARTITION BY g), AVG(b) OVER (PARTITION BY g), COUNT(a) OVER (PARTITION BY g) FROM t1 ORDER BY id',
  'SELECT id, SUM(b) OVER (ORDER BY id), MIN(a) OVER (ORDER BY id), MAX(a) OVER (ORDER BY id) FROM t1 ORDER BY id',
  'SELECT id, LAG(a) OVER (ORDER BY id), LEAD(a) OVER (ORDER BY id), LAG(a, 2, -1) OVER (ORDER BY id), LEAD(s, 3, \'?\') OVER (ORDER BY id) FROM t1 ORDER BY id',
  'SELECT id, g, LAG(id) OVER (PARTITION BY g ORDER BY id) FROM t1 ORDER BY id',
  'SELECT id, FIRST_VALUE(a) OVER (PARTITION BY g ORDER BY id), LAST_VALUE(a) OVER (PARTITION BY g ORDER BY id) FROM t1 ORDER BY id',
  'SELECT id, NTH_VALUE(a, 2) OVER (ORDER BY id) FROM t1 ORDER BY id',
  'SELECT id, NTILE(4) OVER (ORDER BY id), NTILE(3) OVER (PARTITION BY g ORDER BY id) FROM t1 ORDER BY id',
  'SELECT id, a, PERCENT_RANK() OVER (ORDER BY a NULLS FIRST), CUME_DIST() OVER (ORDER BY a NULLS FIRST) FROM t1 ORDER BY id',
  'SELECT g, SUM(a), RANK() OVER (ORDER BY SUM(a) DESC NULLS LAST) FROM t1 GROUP BY g ORDER BY g NULLS FIRST',
  'SELECT id, a FROM t1 ORDER BY ROW_NUMBER() OVER (ORDER BY a DESC NULLS LAST, id) LIMIT 10',
  'SELECT id, g, a, SUM(a) OVER (PARTITION BY g ORDER BY a NULLS FIRST) FROM t1 ORDER BY id',
  'SELECT id, g, SUM(a) OVER (ORDER BY g DESC NULLS LAST), LAST_VALUE(id) OVER (ORDER BY g NULLS FIRST) FROM t1 ORDER BY id',
  'SELECT id, NTH_VALUE(id, 3) OVER (ORDER BY a NULLS FIRST), NTILE(7) OVER (ORDER BY id) FROM t1 ORDER BY id',
  'SELECT id, AVG(a) OVER (PARTITION BY g ORDER BY id), LEAD(a, 1) OVER (PARTITION BY g ORDER BY a NULLS LAST, id) FROM t1 ORDER BY id',
  'SELECT id, FIRST_VALUE(s) OVER (PARTITION BY g ORDER BY s NULLS LAST, id), LAG(a, 0) OVER (ORDER BY id) FROM t1 ORDER BY id',
  'SELECT w.g, w.id, w.rn FROM (SELECT id, g, a, ROW_NUMBER() OVER (PARTITION BY g ORDER BY a DESC NULLS LAST, id) AS rn FROM t1) w WHERE w.rn <= 2 ORDER BY w.g NULLS FIRST, w.rn',
  'SELECT t1.id, t2.id, ROW_NUMBER() OVER (PARTITION BY t1.id ORDER BY t2.id) FROM t1 JOIN t2 ON t1.id = t2.t1_id ORDER BY t1.id, t2.id',

  // more expressions
  'SELECT id, a + b * 2 - a % 3, (a + b) * 2, -a * -b FROM t1 ORDER BY id',
  'SELECT id, b / 0, a % 0, a * 1.0 / 0 FROM t1 ORDER BY id',
  'SELECT id FROM t1 WHERE a > b ORDER BY id',
  'SELECT id, a BETWEEN b AND 10 FROM t1 ORDER BY id',
  'SELECT id, (a > 3) IS TRUE, (a > 3) IS NOT TRUE, (a > 3) IS FALSE FROM t1 ORDER BY id',
  'SELECT id FROM t1 WHERE a ORDER BY id',
  "SELECT id, s FROM t1 WHERE s > 'c' ORDER BY id",
  "SELECT id, s FROM t1 WHERE s BETWEEN 'b' AND 'f' ORDER BY s, id",
  'SELECT id, s FROM t1 ORDER BY s NULLS LAST, id',
  "SELECT id, UPPER(s) = 'APPLE', LENGTH(NULL), UPPER(NULL) FROM t1 ORDER BY id",
  "SELECT id, TRIM(s, 'a'), LTRIM(s, 'ab'), RTRIM(s, 'e') FROM t1 ORDER BY id",
  'SELECT id, SUBSTR(s, 0, 2), SUBSTR(s, 2) FROM t1 ORDER BY id',
  'SELECT id, COALESCE(a, 0) + COALESCE(b, 0) FROM t1 ORDER BY id',
  "SELECT id, s || a FROM t1 ORDER BY id",
  "SELECT id, REPLACE(s, 'a', '') FROM t1 ORDER BY id",
  { sql: "SELECT id, REPLACE(s, '', 'x') FROM t1 ORDER BY id" },
  "SELECT id, CASE WHEN a > 5 THEN s WHEN a > 0 THEN g END FROM t1 ORDER BY id",
  { sql: "SELECT id, CASE WHEN a % 2 THEN 'odd' ELSE 'even' END FROM t1 ORDER BY id" },
  'SELECT id, EXISTS (SELECT 1 FROM t2 WHERE t2.t1_id = t1.id), t1.id IN (SELECT t1_id FROM t2) FROM t1 ORDER BY id',
  'SELECT id FROM t1 WHERE id IN (SELECT t1_id FROM t2 ORDER BY id LIMIT 5) ORDER BY id',
  'SELECT id, (SELECT t2.label FROM t2 WHERE t2.t1_id = t1.id ORDER BY t2.id DESC LIMIT 1) FROM t1 ORDER BY id',
  'SELECT a FROM t1 UNION SELECT label FROM t2 ORDER BY 1 NULLS FIRST',

  // more grouping
  'SELECT a, COUNT(*) FROM t1 GROUP BY a HAVING a > 2 ORDER BY a',
  'SELECT g, a, COUNT(*) FROM t1 GROUP BY g, a HAVING COUNT(*) > 1 ORDER BY g NULLS FIRST, a NULLS FIRST',
  'SELECT g FROM t1 GROUP BY g ORDER BY COUNT(*) DESC, g NULLS LAST',
  'SELECT g, MIN(a), MAX(a) FROM t1 GROUP BY g HAVING MIN(a) < 0 ORDER BY g NULLS LAST',
  "SELECT g, SUM(CASE WHEN s LIKE '%a%' THEN 1 ELSE 0 END), COUNT(*) FILTER (WHERE b > 0) FROM t1 GROUP BY g ORDER BY g NULLS LAST",
  'SELECT g, MAX(a) FILTER (WHERE id % 2 = 0), MIN(s) FROM t1 GROUP BY g ORDER BY g NULLS LAST',
  { sql: 'SELECT g, COUNT(*) AS n FROM t1 GROUP BY g HAVING n > 10 ORDER BY g NULLS LAST' },
  { sql: 'SELECT COUNT(*), SUM(t2.qty) FROM t1 x JOIN t2 ON x.id = t2.t1_id JOIN t2 z ON z.label = x.g' },
  'SELECT COUNT(*), SUM(y.qty) FROM t1 x JOIN t2 y ON x.id = y.t1_id JOIN t2 z ON z.label = x.g',
  'SELECT t1.id, t2.id FROM t1 LEFT JOIN t2 ON t1.id = t2.t1_id WHERE t2.id IS NULL ORDER BY t1.id',
  'SELECT id, t1.a, t2.qty FROM t1 JOIN t2 USING (id) ORDER BY id',
  'SELECT id, t1.a, t2.qty FROM t1 FULL JOIN t2 USING (id) WHERE id > 25 ORDER BY id',
  'SELECT s.id, s.a FROM (SELECT id, a FROM t1 ORDER BY a DESC NULLS LAST, id LIMIT 5) s ORDER BY s.id',
  'SELECT * FROM (VALUES (1, \'a\'), (2, NULL), (3, \'c\')) v ORDER BY 1',
  'WITH c AS (SELECT id, g, a FROM t1 WHERE a IS NOT NULL) SELECT x.id, y.id FROM c x JOIN c y ON x.g = y.g AND x.a = y.a AND x.id < y.id ORDER BY x.id, y.id',
  'SELECT id FROM t1 ORDER BY a * -1 NULLS LAST, id',
  'SELECT DISTINCT g FROM t1 ORDER BY g DESC NULLS FIRST',
  'SELECT id FROM t1 ORDER BY id LIMIT 2 + 1 OFFSET 100'
]

// -- run ------------------------------------------------------------------------------------

describe('sqllang agrees with node:sqlite', { skip: available ? false : 'node:sqlite is not available on this Node' }, () => {
  test('the generated data has NULLs in every nullable column', () => {
    for (const c of ['a', 'b', 's', 'g']) assert.ok(t1.some((r) => r[c] === null), c)
    for (const c of ['t1_id', 'qty', 'label']) assert.ok(t2.some((r) => r[c] === null), c)
  })

  for (const entry of corpus) {
    const { sql, unordered = false, todo } = typeof entry === 'string' ? { sql: entry } : entry
    test(sql, todo ? { todo } : {}, () => {
      compareResults(sql, !unordered)
    })
  }
})
