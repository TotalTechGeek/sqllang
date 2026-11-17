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
