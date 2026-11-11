// The performance fast paths must give exactly the answers of the general paths.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { query } from '../src/index.js'

// Deterministic data with ties, NULLs, mixed number/string values.
let seed = 7
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
const rows = Array.from({ length: 3000 }, (_, i) => ({
  id: i,
  g: ['a', 'b', 'c', null][Math.floor(rnd() * 4)],
  h: Math.floor(rnd() * 5),
  v: rnd() < 0.1 ? null : Math.floor(rnd() * 50),
  s: rnd() < 0.5 ? String(Math.floor(rnd() * 20)) : Math.floor(rnd() * 20)
}))
const data = { t: rows }
const ids = (r) => r.map((x) => x.id)

/** The same query, forced off the fast path by a join against a one-row table. */
const slow = (sql) => query(sql.replace('FROM t', 'FROM t CROSS JOIN one'), { ...data, one: [{ x: 1 }] })

describe('ORDER BY ... LIMIT keeps only the top k', () => {
  const cases = [
    'SELECT id FROM t ORDER BY v LIMIT 25',
    'SELECT id FROM t ORDER BY v DESC LIMIT 25',
    'SELECT id FROM t ORDER BY v NULLS FIRST LIMIT 25',
    'SELECT id FROM t ORDER BY v DESC NULLS LAST, g LIMIT 40 OFFSET 13',
    'SELECT id FROM t ORDER BY g, v DESC LIMIT 100',
    'SELECT id FROM t WHERE h > 1 ORDER BY v LIMIT 7',
    'SELECT id, v * 2 AS w FROM t ORDER BY w DESC LIMIT 15',
    'SELECT id FROM t ORDER BY 1 DESC LIMIT 5',
    'SELECT id FROM t ORDER BY v LIMIT 0',
    'SELECT id FROM t ORDER BY v LIMIT 100000'
  ]
  for (const sql of cases) {
    test(sql, () => {
      // Ties keep input order (a stable sort), on both paths.
      const full = query(sql.replace(/ LIMIT .*$/, ''), data)
      const m = / LIMIT (\d+)(?: OFFSET (\d+))?$/.exec(sql)
      const expected = ids(full).slice(Number(m[2] ?? 0), Number(m[2] ?? 0) + Number(m[1]))
      assert.deepEqual(ids(query(sql, data)), expected)
      assert.deepEqual(ids(slow(sql)), expected)
    })
  }
  test('top-k after GROUP BY', () => {
    const sql = 'SELECT g, h, COUNT(*) AS n FROM t GROUP BY g, h ORDER BY n DESC, g, h LIMIT 4'
    assert.deepEqual(query(sql, data), query(sql.replace(' LIMIT 4', ''), data).slice(0, 4))
  })
})

describe('numeric sort fast path', () => {
  test('matches the general comparator, including ties and DESC', () => {
    for (const dir of ['', ' DESC']) {
      const sql = `SELECT id FROM t WHERE v IS NOT NULL ORDER BY v${dir}`
      const expected = [...rows].filter((r) => r.v !== null).sort((a, b) => (dir ? b.v - a.v : a.v - b.v)).map((r) => r.id)
      assert.deepEqual(ids(query(sql, data)), expected)
    }
  })
  test('falls back when keys are not all numbers', () => {
    const r = query('SELECT id FROM t ORDER BY s, id LIMIT 30', data)
    assert.deepEqual(ids(r), ids(slow('SELECT id FROM t ORDER BY s, id LIMIT 30')))
  })
  test('window ORDER BY over numbers', () => {
    const sql = 'SELECT id, ROW_NUMBER() OVER (PARTITION BY g ORDER BY h, id) AS rn FROM t ORDER BY id'
    assert.deepEqual(query(sql, data), slow(sql))
  })
})

describe('grouping and DISTINCT with nested maps', () => {
  test('GROUP BY keeps 1 and "1" apart, and NULL is one group', () => {
    const r = query('SELECT k, COUNT(*) AS n FROM x GROUP BY k ORDER BY n', { x: [{ k: 1 }, { k: '1' }, { k: '1' }, { k: null }, {}, {}, {}] })
    assert.deepEqual(r, [{ k: 1, n: 1 }, { k: '1', n: 2 }, { k: null, n: 4 }])
  })
  test('multi-key GROUP BY equals the joined (general) path', () => {
    const sql = 'SELECT g, h, COUNT(*) AS n, SUM(v) AS sv, MIN(v) AS lo, MAX(s) AS hi FROM t GROUP BY g, h ORDER BY g, h'
    assert.deepEqual(query(sql, data), slow(sql))
  })
  test('GROUP BY over objects and dates', () => {
    const d = new Date(0)
    const r = query('SELECT COUNT(*) AS n FROM x GROUP BY k', { x: [{ k: { a: 1 } }, { k: { a: 1 } }, { k: d }, { k: new Date(0) }] })
    assert.deepEqual(r.map((x) => x.n), [2, 2])
  })
  test('DISTINCT', () => {
    const sql = 'SELECT DISTINCT g, h FROM t ORDER BY g, h'
    assert.deepEqual(query(sql, data), slow(sql))
    assert.equal(query('SELECT DISTINCT g, h FROM t', data).length, 20)
  })
  test('UNION dedupe', () => {
    assert.deepEqual(query('SELECT 1 AS a UNION SELECT 1 UNION SELECT \'1\' UNION SELECT NULL UNION SELECT NULL', {}).map((r) => r.a), [1, '1', null])
  })
})

describe('IN (subquery) lookup', () => {
  const vals = { v: [{ x: 1 }, { x: '2' }, { x: '3.0' }, { x: 'abc' }, { x: 4.5 }] }
  const cases = [[1, true], ['1', true], ['1.0', true], [2, true], ['2', true], ['2.0', false], [3, true], ['3', false],
    ['abc', true], ['ABC', false], [4.5, true], ['4.5', true], [5, false], ['x', false]]
  for (const [x, expected] of cases) {
    test(`${JSON.stringify(x)} IN (...) is ${expected}, as a scan says`, () => {
      const sql = 'SELECT :x IN (SELECT x FROM v) AS r'
      assert.equal(query(sql, vals, { params: { x } })[0].r, expected)
      // Correlated, so scanned: the reference answer.
      const scanned = query('SELECT :x IN (SELECT x FROM v WHERE o.k = 1) AS r FROM o', { ...vals, o: [{ k: 1 }] }, { params: { x } })[0].r
      assert.equal(scanned, expected)
    })
  }
})

describe('single-column hash join', () => {
  const l = [{ k: 1 }, { k: '1' }, { k: '1.0' }, { k: 2 }, { k: 'x' }, { k: null }, { k: true }, { k: new Date(0) }, { k: '7' }]
  const r = [{ k: '1', n: 'a' }, { k: 1, n: 'b' }, { k: '1.0', n: 'c' }, { k: 'x', n: 'd' }, { k: null, n: 'e' }, { k: true, n: 'f' }, { k: new Date(0), n: 'g' }, { k: 2, n: 'h' }, { k: '7', n: 'i' }]
  const sql = 'SELECT l.k AS lk, r.n FROM l LEFT JOIN r ON r.k = l.k'
  test('matches the nested-loop join exactly, order included', () => {
    const hashed = query(sql, { l, r })
    // A top-level OR is not an equi-join condition, so this one runs as a nested loop.
    const looped = query(sql.replace('ON r.k = l.k', 'ON r.k = l.k AND 1 = 1 OR 1 = 0'), { l, r })
    assert.deepEqual(hashed, looped)
    assert.ok(hashed.length > l.length)
  })
})
