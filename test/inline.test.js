// Operators compile to inline code when one side is a literal. The interpreted
// engine runs the plain functions, so it is the reference for the compiled one.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { query } from '../src/index.js'

const values = [0, 1, 2, -3, 2.5, 100, 1e21, NaN, Infinity, '', 'a', 'b', 'abc', '1', '2', '2.5', ' 3 ', 'x1', true, false, null, undefined,
  new Date(0), [1], { a: 1 }]
const rows = values.map((v, i) => ({ i, v, w: values[(i * 7 + 3) % values.length] }))
const data = { t: rows }
const literals = ['0', '1', '2', '-3', '2.5', "''", "'a'", "'1'", "'2.5'", "'abc'", 'NULL', 'TRUE', 'FALSE']
const same = (sql) => {
  const compiled = [...query(sql, data)]
  const interpreted = [...query(sql, data, { interpreted: true })]
  assert.deepEqual(compiled, interpreted, sql)
}

describe('inlined operators match the general functions', () => {
  for (const op of ['=', '<>', '<', '<=', '>', '>=']) {
    test(`v ${op} literal, and literal ${op} v`, () => {
      for (const l of literals) {
        same(`SELECT i, v ${op} ${l} AS r FROM t`)
        same(`SELECT i, ${l} ${op} v AS r FROM t`)
      }
      same(`SELECT i, v ${op} w AS r FROM t`)
    })
  }
  for (const op of ['+', '-', '*', '/', '%']) {
    test(`v ${op} literal, and literal ${op} v`, () => {
      for (const l of ['0', '1', '2', '-3', '2.5', "'2'", "'a'", 'NULL']) {
        same(`SELECT i, v ${op} ${l} AS r FROM t`)
        same(`SELECT i, ${l} ${op} v AS r FROM t`)
      }
    })
  }
  test('AND / OR, three-valued, in a select list and as WHERE', () => {
    const preds = ['v = 1', 'v > 1', 'v IS NULL', 'w < 2', 'v', 'NULL', 'TRUE', 'FALSE', 'v = w']
    for (const a of preds) {
      for (const b of preds) {
        same(`SELECT i, (${a}) AND (${b}) AS r, (${a}) OR (${b}) AS s FROM t`)
        same(`SELECT i FROM t WHERE (${a}) AND (${b})`)
        same(`SELECT i FROM t WHERE (${a}) OR (${b})`)
        for (const c of preds.slice(0, 5)) same(`SELECT i, (${a}) AND (${b}) AND (${c}) AS r, (${a}) OR (${b}) OR (${c}) AS s FROM t`)
      }
    }
  })
  test('short-circuiting does not skip errors it would not have hit', () => {
    // The right side of a decided AND is not evaluated, so it cannot throw.
    assert.deepEqual([...query('SELECT 1 AS x FROM t WHERE FALSE AND v = 1 AND w = 2', data)], [])
  })
})

describe('compiled GROUP BY matches the general path', () => {
  const g = Array.from({ length: 400 }, (_, i) => ({
    i,
    a: [null, 'x', 'y', 1, 2, '1', true][i % 7],
    b: i % 3 === 0 ? null : i % 5,
    v: [null, 1, 2.5, '3', 'abc', -4, 10, NaN, undefined][i % 9],
    s: [null, 'p', 'q', 'a'][i % 4]
  }))
  const gdata = { t: g, empty: [] }
  const sameGroups = (sql) => {
    const norm = (rows) => JSON.stringify([...rows].sort((x, y) => JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))
    assert.equal(norm(query(sql, gdata)), norm(query(sql, gdata, { interpreted: true })), sql)
  }
  const aggs = 'COUNT(*) AS n, COUNT(v) AS c, SUM(v) AS s, AVG(v) AS m, MIN(v) AS lo, MAX(v) AS hi, MIN(s) AS ls, MAX(s) AS hs'
  test('one, two and three keys, with WHERE and FILTER', () => {
    sameGroups(`SELECT a, ${aggs} FROM t GROUP BY a`)
    sameGroups(`SELECT a, b, ${aggs} FROM t GROUP BY a, b`)
    sameGroups(`SELECT a, b, s, ${aggs} FROM t GROUP BY a, b, s`)
    sameGroups(`SELECT a, ${aggs} FROM t WHERE i % 2 = 0 AND v IS NOT NULL GROUP BY a`)
    sameGroups('SELECT b, COUNT(*) FILTER (WHERE v > 1) AS big, SUM(v) FILTER (WHERE a = \'x\') AS sx FROM t GROUP BY b')
    sameGroups('SELECT a, COUNT(*) AS n FROM t GROUP BY a HAVING COUNT(*) > 50')
    sameGroups('SELECT b + 1 AS k, SUM(i) AS s FROM t GROUP BY b + 1')
  })
  test('no GROUP BY: one row, even over nothing', () => {
    sameGroups(`SELECT ${aggs} FROM t`)
    sameGroups(`SELECT ${aggs} FROM t WHERE i < 0`)
    sameGroups(`SELECT ${aggs} FROM empty`)
    assert.deepEqual([...query('SELECT COUNT(*) AS n, SUM(v) AS s FROM empty', gdata)], [{ n: 0, s: null }])
    assert.deepEqual([...query('SELECT a, COUNT(*) AS n FROM empty GROUP BY a', gdata)], [])
  })
})

describe('GROUP BY on one integer-like key', () => {
  // The compiled path indexes small non-negative integers into an array and keeps every
  // other key in a Map; both must group the same as the general path, in the same order.
  const keys = [0, -0, 1, 2, 1048575, 1048576, 1048577, 4294967296, -1, 1.5, 2.5, NaN, Infinity, '0', '1', '', null, undefined, true, false, 7, 7, 0, 1]
  const kdata = { k: keys.map((v, i) => ({ v, i })) }
  const rows = (sql, options) => JSON.stringify([...query(sql, kdata, options)])
  test('same groups, same order as the general path', () => {
    for (const sql of [
      'SELECT v, COUNT(*) AS n, SUM(i) AS s, MIN(i) AS lo, MAX(i) AS hi FROM k GROUP BY v',
      'SELECT v, COUNT(*) AS n FROM k WHERE i % 2 = 0 GROUP BY v',
      'SELECT v + 0 AS w, COUNT(*) AS n FROM k GROUP BY v + 0'
    ]) assert.equal(rows(sql), rows(sql, { interpreted: true }), sql)
  })
  test('0 and -0 are one group; 1 and "1" are two; 7 repeats', () => {
    const r = [...query('SELECT v, COUNT(*) AS n FROM k GROUP BY v', kdata)]
    const n = (pick) => r.filter((x) => pick(x.v)).map((x) => x.n)
    assert.deepEqual(n((v) => v === 0), [3]) // 0, -0, 0
    assert.deepEqual(n((v) => v === '0'), [1])
    assert.deepEqual(n((v) => v === 1), [2])
    assert.deepEqual(n((v) => v === '1'), [1])
    assert.deepEqual(n((v) => v === 7), [2])
    assert.deepEqual(n((v) => v === null), [2]) // null and undefined are one NULL group
    assert.equal(r.reduce((t, x) => t + x.n, 0), keys.length)
  })
})
