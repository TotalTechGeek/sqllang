import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { query, compile, prepare, executePlan, SAFE_LIMITS, SqlLimitError, SqlError } from '../src/index.js'

const t = [{ a: 1 }, { a: 2 }, { a: 3 }]
const big = Array.from({ length: 2000 }, (_, i) => ({ id: i }))

const limitError = (limit) => (e) => e instanceof SqlLimitError && e.limit === limit

describe('always on: prototype safety', () => {
  test('an alias named __proto__ is an ordinary column', () => {
    const [row] = query('SELECT 1 AS "__proto__", 2 AS b', {})
    assert.equal(Object.getPrototypeOf(row), Object.prototype)
    assert.deepEqual(Object.keys(row), ['__proto__', 'b'])
    assert.equal(Object.getOwnPropertyDescriptor(row, '__proto__').value, 1)
  })

  test('JSON_OBJECT and OBJECT_AGG cannot set a prototype', () => {
    const [{ o }] = query("SELECT JSON_OBJECT('__proto__', JSON_OBJECT('polluted', 1)) AS o", {})
    assert.equal(o.polluted, undefined)
    assert.equal(Object.getPrototypeOf(o), Object.prototype)
    const [{ g }] = query("SELECT OBJECT_AGG(column1, column2) AS g FROM (VALUES ('__proto__', 1), ('x', 2)) p", {})
    assert.equal(Object.getPrototypeOf(g), Object.prototype)
    assert.equal(g.x, 2)
  })

  test('a __proto__ key in JSON data survives SELECT * as data', () => {
    const [row] = query('SELECT * FROM t', { t: '[{"__proto__": {"x": 1}, "a": 2}]' })
    assert.equal(Object.getPrototypeOf(row), Object.prototype)
    assert.equal(row.x, undefined)
    assert.deepEqual(Object.getOwnPropertyDescriptor(row, '__proto__').value, { x: 1 })
  })

  test('inherited properties are not columns, tables or parameters', () => {
    assert.deepEqual(query('SELECT constructor, t.toString AS s FROM t LIMIT 1', { t }), [{ constructor: null, s: null }])
    assert.throws(() => query('SELECT * FROM constructor', { t }), /Unknown table/)
    assert.throws(() => query('SELECT :constructor AS c', {}, { params: {} }), /No value bound/)
  })

  test('reserved aliases are refused', () => {
    assert.throws(() => compile('SELECT 1 FROM t AS "__proto__"'), SqlError)
    assert.throws(() => compile('SELECT 1 FROM t AS "$agg"'), SqlError)
  })
})

describe('always on: LIKE cannot backtrack', () => {
  test('a pathological pattern is fast', () => {
    const text = 'a'.repeat(5000)
    const start = performance.now()
    const [{ m }] = query('SELECT s LIKE :p AS m FROM t', { t: [{ s: text }] }, { params: { p: '%a%a%a%a%a%a%a%a%a%a%b' } })
    assert.equal(m, false)
    assert.ok(performance.now() - start < 500, 'LIKE took too long')
  })

  test('LIKE semantics are unchanged', () => {
    const cases = [
      ['abc', 'a%', true], ['abc', '%c', true], ['abc', 'a_c', true], ['abc', '_', false],
      ['abc', '%b%', true], ['abc', 'abc%', true], ['', '%', true], ['', '_', false],
      ['a%c', 'a\\%c', true], ['abc', 'a\\%c', false], ['a_c', 'a\\_c', true], ['aXc', 'a\\_c', false],
      ['mississippi', '%iss%ppi', true], ['mississippi', 'm%s%s%s%', true], ['mississippi', 'm%s%s%s%s%s%', false], ['héllo', 'h_llo', true],
      ['ABC', 'abc', false]
    ]
    for (const [s, p, expected] of cases) {
      const [{ m }] = query('SELECT :s LIKE :p AS m', {}, { params: { s, p } })
      assert.equal(m, expected, `${JSON.stringify(s)} LIKE ${JSON.stringify(p)}`)
    }
    assert.equal(query("SELECT 'ABC' ILIKE 'a%c' AS m", {})[0].m, true)
  })
})

describe('always on: depth', () => {
  test('absurd nesting is a SqlLimitError, not a stack overflow', () => {
    const sql = 'SELECT ' + '('.repeat(20000) + '1' + ')'.repeat(20000)
    assert.throws(() => compile(sql), limitError('depth'))
  })
})

describe('limits', () => {
  test('maxRows stops a runaway cross join', () => {
    assert.throws(
      () => query('SELECT COUNT(*) FROM big a, big b', { big }, { limits: { maxRows: 100_000 } }),
      limitError('maxRows')
    )
  })

  test('maxRows stops a huge GENERATE_SERIES before building it', () => {
    const start = performance.now()
    assert.throws(() => query('SELECT COUNT(*) FROM GENERATE_SERIES(1, 1e12)', {}, { limits: { maxRows: 1e6 } }), limitError('maxRows'))
    assert.ok(performance.now() - start < 100)
  })

  test('maxRows caps the result', () => {
    assert.throws(() => query('SELECT * FROM big', { big }, { limits: { maxRows: 1000 } }), limitError('maxRows'))
    assert.equal(query('SELECT * FROM big LIMIT 10', { big }, { limits: { maxRows: 5000 } }).length, 10)
  })

  test('timeoutMs interrupts a slow query', () => {
    const start = performance.now()
    assert.throws(
      () => query('SELECT COUNT(*) FROM big a, big b, big c', { big }, { limits: { timeoutMs: 50 } }),
      limitError('timeoutMs')
    )
    assert.ok(performance.now() - start < 1000)
  })

  test('timeoutMs covers correlated subqueries', () => {
    assert.throws(
      () => query('SELECT a.id, (SELECT COUNT(*) FROM big b, big c WHERE b.id = a.id) FROM big a', { big }, { limits: { timeoutMs: 50 } }),
      limitError('timeoutMs')
    )
  })

  test('maxStringLength stops string bombs', () => {
    const limits = { maxStringLength: 10_000 }
    assert.throws(() => query("SELECT REPEAT('x', 1e9)", {}, { limits }), limitError('maxStringLength'))
    assert.throws(() => query("SELECT LPAD('x', 1e9)", {}, { limits }), limitError('maxStringLength'))
    assert.throws(() => query("SELECT STRING_AGG(REPEAT('x', 100), ',') FROM big", { big }, { limits }), limitError('maxStringLength'))
    assert.equal(query("SELECT REPEAT('ab', 3) AS r", {}, { limits })[0].r, 'ababab')
  })

  test('maxQueryLength', () => {
    assert.throws(() => compile('SELECT 1' + ' '.repeat(100), { limits: { maxQueryLength: 50 } }), limitError('maxQueryLength'))
  })

  test('regex: false refuses REGEXP_* at compile time', () => {
    assert.throws(() => prepare("SELECT REGEXP_LIKE('a', 'a')", { limits: { regex: false } }), limitError('regex'))
    assert.equal(query("SELECT REGEXP_LIKE('abc', 'b') AS m", {})[0].m, true)
  })

  test('regex: false is enforced at run time for a plan compiled elsewhere', () => {
    const plan = JSON.parse(JSON.stringify(compile("SELECT REGEXP_LIKE(s, 'b') AS m FROM t")))
    const data = { t: [{ s: 'abc' }] }
    assert.throws(() => executePlan(plan, data, { limits: { regex: false } }), limitError('regex'))
    assert.equal(executePlan(plan, data).results[0].rows[0].m, true)
  })

  test('SAFE_LIMITS runs ordinary queries untouched', () => {
    const rows = query('SELECT a, COUNT(*) n FROM t GROUP BY a ORDER BY a', { t }, { limits: SAFE_LIMITS })
    assert.equal(rows.length, 3)
  })

  test('limits do not leak into the next run', () => {
    assert.throws(() => query('SELECT * FROM big', { big }, { limits: { maxRows: 10 } }), limitError('maxRows'))
    assert.equal(query('SELECT * FROM big', { big }).length, 2000)
  })
})


describe('IN (subquery) via a hash lookup', () => {
  const vals = [{ v: 1 }, { v: '2' }, { v: 'x' }, { v: 3.5 }]
  const probe = (x, extra = []) => query('SELECT :x IN (SELECT v FROM vals) AS r', { vals: [...vals, ...extra] }, { params: { x } })[0].r
  test('matches loosely, exactly as a scan would', () => {
    assert.equal(probe(1), true)
    assert.equal(probe('1'), true)
    assert.equal(probe('1.0'), true)
    assert.equal(probe(2), true)
    assert.equal(probe('x'), true)
    assert.equal(probe('X'), false)
    assert.equal(probe(3.5), true)
    assert.equal(probe(4), false)
  })
  test('NULL semantics', () => {
    assert.equal(probe(4, [{ v: null }]), null)
    assert.equal(probe(1, [{ v: null }]), true)
    assert.equal(query('SELECT NULL IN (SELECT v FROM vals) AS r', { vals })[0].r, null)
  })
  test('non-hashable values fall back to a scan', () => {
    assert.equal(probe(true, [{ v: true }]), true)
  })
  test('large uncorrelated IN is fast', () => {
    const big = Array.from({ length: 100000 }, (_, i) => ({ id: i }))
    const keep = Array.from({ length: 5000 }, (_, i) => ({ id: i * 3 }))
    const start = performance.now()
    const [{ n }] = query('SELECT COUNT(*) AS n FROM big WHERE id IN (SELECT id FROM keep)', { big, keep })
    assert.equal(n, 5000)
    assert.ok(performance.now() - start < 500)
  })
})
