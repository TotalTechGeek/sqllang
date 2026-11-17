import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { query, execute, compile, prepare, SqlError, SqlSyntaxError } from '../src/index.js'

/** Rows as a plain array, so deepEqual ignores the non-enumerable `columns`. */
const q = (sql, data = {}, options) => [...query(sql, data, options)]
/** The values of one column. */
const col = (sql, data = {}, options) => {
  const rows = query(sql, data, options)
  return rows.map((r) => r[rows.columns[0]])
}
/** One scalar. */
const one = (sql, data = {}, options) => col(sql, data, options)[0]

const people = [
  { id: 1, name: 'Ann', age: 34, dept: 'eng', boss: null },
  { id: 2, name: 'Bob', age: 25, dept: 'eng', boss: 1 },
  { id: 3, name: 'Cid', age: null, dept: 'ops', boss: 1 },
  { id: 4, name: 'Dee', age: 41, dept: null, boss: 2 },
  { id: 5, name: 'Eve', age: 25, dept: 'ops', boss: 3 }
]
const depts = [
  { dept: 'eng', floor: 3 },
  { dept: 'ops', floor: 1 },
  { dept: 'hr', floor: 2 }
]
const D = { people, depts }

// ---------------------------------------------------------------------------------

describe('selection', () => {
  test('columns, aliases and expressions', () => {
    assert.deepEqual(q('SELECT id, name AS n, age + 1 next FROM people WHERE id <= 2', D), [
      { id: 1, n: 'Ann', next: 35 },
      { id: 2, n: 'Bob', next: 26 }
    ])
  })

  test('result carries a non-enumerable columns array', () => {
    const rows = query('SELECT name, id FROM people LIMIT 1', D)
    assert.deepEqual(rows.columns, ['name', 'id'])
    assert.ok(!Object.keys(rows).includes('columns'))
  })

  test('SELECT * and t.*', () => {
    assert.deepEqual(q('SELECT * FROM depts WHERE floor = 1', D), [{ dept: 'ops', floor: 1 }])
    assert.deepEqual(q('SELECT d.* FROM depts d WHERE d.floor = 2', D), [{ dept: 'hr', floor: 2 }])
  })

  test('SELECT * over rows of different shapes fills missing columns with NULL', () => {
    const rows = query('SELECT * FROM t', { t: [{ x: 1 }, { y: 2 }] })
    assert.deepEqual(rows.columns, ['x', 'y'])
    assert.deepEqual([...rows], [{ x: 1, y: null }, { x: null, y: 2 }])
  })

  test('derived names and de-duplication of names', () => {
    const rows = query("SELECT COUNT(*), COUNT(age), meta->>'k', 1 + 1 FROM t", { t: [{ age: 1, meta: '{"k":"v"}' }] })
    assert.deepEqual(rows.columns, ['count', 'count_2', 'k', 'col4'])
  })

  test('SELECT without FROM', () => {
    assert.deepEqual(q("SELECT 1 AS a, 'x' AS b, NULL AS c, TRUE AS d"), [{ a: 1, b: 'x', c: null, d: true }])
  })

  test('quoted identifiers, string escapes and comments', () => {
    assert.deepEqual(q('SELECT "weird col", `other` FROM t', { t: [{ 'weird col': 1, other: 2 }] }), [{ 'weird col': 1, other: 2 }])
    assert.equal(one("SELECT 'it''s' -- trailing\n /* block */"), "it's")
  })

  test('keywords may be used as field names after a dot', () => {
    assert.deepEqual(q('SELECT t.order, t.from FROM t', { t: [{ order: 1, from: 2 }] }), [{ order: 1, from: 2 }])
  })

  test('a column that does not exist reads as NULL (data is schemaless)', () => {
    assert.deepEqual(col('SELECT nope FROM people LIMIT 2', D), [null, null])
  })

  test('VALUES as a query', () => {
    assert.deepEqual(q("VALUES (1, 'a'), (2, 'b') ORDER BY column1 DESC"), [
      { column1: 2, column2: 'b' }, { column1: 1, column2: 'a' }
    ])
  })
})

describe('WHERE and three-valued logic', () => {
  test('comparisons skip NULLs', () => {
    assert.deepEqual(col('SELECT id FROM people WHERE age > 30', D), [1, 4])
    assert.deepEqual(col('SELECT id FROM people WHERE NOT (age > 30)', D), [2, 5])
    assert.deepEqual(col('SELECT id FROM people WHERE age <> 25', D), [1, 4])
  })

  test('IS NULL / IS NOT NULL / IS DISTINCT FROM', () => {
    assert.deepEqual(col('SELECT id FROM people WHERE age IS NULL', D), [3])
    assert.deepEqual(col('SELECT id FROM people WHERE dept IS NOT NULL AND age IS NOT NULL', D), [1, 2, 5])
    assert.deepEqual(col("SELECT id FROM people WHERE dept IS DISTINCT FROM 'eng'", D), [3, 4, 5])
    assert.deepEqual(col('SELECT id FROM people WHERE dept IS NOT DISTINCT FROM NULL', D), [4])
  })

  test('NULL truth tables', () => {
    assert.deepEqual(q('SELECT NULL = NULL a, NULL AND FALSE b, NULL AND TRUE c, NULL OR TRUE d, NULL OR FALSE e, NOT NULL f'), [
      { a: null, b: false, c: null, d: true, e: null, f: null }
    ])
  })

  test('IN and NOT IN with NULLs', () => {
    assert.deepEqual(q('SELECT 1 IN (2, NULL) a, 1 IN (1, NULL) b, 1 NOT IN (2, NULL) c, NULL IN (1) d, 3 NOT IN (1, 2) e'), [
      { a: null, b: true, c: null, d: null, e: true }
    ])
  })

  test('IN (:param) takes an array parameter as the list', () => {
    assert.deepEqual(col('SELECT id FROM people WHERE id IN (:ids) ORDER BY id', D, { params: { ids: [4, 2] } }), [2, 4])
    assert.deepEqual(col('SELECT id FROM people WHERE id NOT IN (:ids) ORDER BY id LIMIT 2', D, { params: { ids: [1, 2] } }), [3, 4])
    assert.deepEqual(col('SELECT id FROM people WHERE id IN (:ids)', D, { params: { ids: [] } }), [])
    assert.deepEqual(col('SELECT id FROM people WHERE id IN (:id)', D, { params: { id: 4 } }), [4])
  })

  test('BETWEEN, LIKE, ILIKE', () => {
    assert.deepEqual(col('SELECT id FROM people WHERE age BETWEEN 25 AND 34', D), [1, 2, 5])
    assert.deepEqual(col('SELECT id FROM people WHERE age NOT BETWEEN 25 AND 34', D), [4])
    assert.deepEqual(col("SELECT name FROM people WHERE name LIKE '_e%'", D), ['Dee'])
    assert.deepEqual(col("SELECT name FROM people WHERE name LIKE 'a%'", D), [], 'LIKE is case-sensitive')
    assert.deepEqual(col("SELECT name FROM people WHERE name ILIKE 'a%'", D), ['Ann'])
    assert.deepEqual(col("SELECT name FROM people WHERE name NOT LIKE '%e%'", D), ['Ann', 'Bob', 'Cid'])
  })

  test('LIKE treats regex characters literally and supports backslash escapes', () => {
    const t = { t: [{ s: 'a.c' }, { s: 'abc' }, { s: '50%' }, { s: '500' }] }
    assert.deepEqual(col("SELECT s FROM t WHERE s LIKE 'a.c'", t), ['a.c'])
    assert.deepEqual(col("SELECT s FROM t WHERE s LIKE '50\\%'", t), ['50%'])
  })

  test('only TRUE passes a WHERE; non-zero numbers count as true', () => {
    assert.deepEqual(col('SELECT x FROM t WHERE x', { t: [{ x: 0 }, { x: 2 }, { x: null }, { x: true }, { x: false }] }), [2, true])
  })

  test('precedence: AND binds tighter than OR, NOT looser than comparisons', () => {
    assert.equal(one('SELECT TRUE OR FALSE AND FALSE'), true)
    assert.equal(one('SELECT NOT 1 = 2'), true)
    assert.equal(one('SELECT 2 + 3 * 4 - 6 / 2'), 11)
    assert.equal(one('SELECT -2 * -3'), 6)
  })
})

describe('joins', () => {
  const a = [{ k: 1, v: 'a1' }, { k: 2, v: 'a2' }, { k: null, v: 'an' }]
  const b = [{ k: 1, w: 'b1' }, { k: 1, w: 'b1x' }, { k: 3, w: 'b3' }, { k: null, w: 'bn' }]
  const AB = { a, b }

  test('INNER JOIN (hash path) never matches NULL keys', () => {
    assert.deepEqual(q('SELECT a.v, b.w FROM a JOIN b ON a.k = b.k', AB), [
      { v: 'a1', w: 'b1' }, { v: 'a1', w: 'b1x' }
    ])
    const plan = compile('SELECT a.v FROM a JOIN b ON a.k = b.k')
    assert.ok(plan.statements[0].body.steps[1].hash, 'equality join is compiled to a hash join')
  })

  test('hash join with reversed sides, residual condition and loose number/string keys', () => {
    assert.deepEqual(q("SELECT a.v, b.w FROM a JOIN b ON b.k = a.k AND b.w <> 'b1'", AB), [{ v: 'a1', w: 'b1x' }])
    assert.deepEqual(q('SELECT x.id, y.id AS id2 FROM x JOIN y ON x.id = y.id', { x: [{ id: 1 }], y: [{ id: '1' }] }), [{ id: 1, id2: '1' }])
  })

  test('nested-loop join on a non-equality condition', () => {
    const plan = compile('SELECT 1 FROM a JOIN b ON a.k < b.k')
    assert.equal(plan.statements[0].body.steps[1].hash, null)
    assert.deepEqual(q('SELECT a.v, b.w FROM a JOIN b ON a.k < b.k ORDER BY a.v, b.w', AB), [
      { v: 'a1', w: 'b3' }, { v: 'a2', w: 'b3' }
    ])
  })

  test('LEFT JOIN keeps unmatched left rows; ON conditions on the right do not filter the left', () => {
    assert.deepEqual(q("SELECT a.v, b.w FROM a LEFT JOIN b ON a.k = b.k AND b.w = 'b1x'", AB), [
      { v: 'a1', w: 'b1x' }, { v: 'a2', w: null }, { v: 'an', w: null }
    ])
  })

  test('LEFT JOIN ... WHERE right IS NULL (anti join)', () => {
    assert.deepEqual(col('SELECT a.v FROM a LEFT JOIN b ON a.k = b.k WHERE b.k IS NULL', AB), ['a2', 'an'])
  })

  test('RIGHT JOIN', () => {
    assert.deepEqual(q('SELECT a.v, b.w FROM a RIGHT JOIN b ON a.k = b.k', AB), [
      { v: 'a1', w: 'b1' }, { v: 'a1', w: 'b1x' }, { v: null, w: 'b3' }, { v: null, w: 'bn' }
    ])
  })

  test('FULL JOIN', () => {
    assert.deepEqual(q('SELECT a.v, b.w FROM a FULL OUTER JOIN b ON a.k = b.k', AB), [
      { v: 'a1', w: 'b1' }, { v: 'a1', w: 'b1x' }, { v: 'a2', w: null }, { v: 'an', w: null },
      { v: null, w: 'b3' }, { v: null, w: 'bn' }
    ])
  })

  test('JOIN ... USING; an unqualified USING column reads whichever side has it', () => {
    assert.deepEqual(q('SELECT name, floor FROM people JOIN depts USING (dept) ORDER BY id', D), [
      { name: 'Ann', floor: 3 }, { name: 'Bob', floor: 3 }, { name: 'Cid', floor: 1 }, { name: 'Eve', floor: 1 }
    ])
    assert.deepEqual(col('SELECT dept FROM people FULL JOIN depts USING (dept) WHERE id IS NULL OR id = 4', D), [null, 'hr'])
  })

  test('comma join, CROSS JOIN and self join', () => {
    assert.equal(one('SELECT COUNT(*) FROM a, b', AB), 12)
    assert.equal(one('SELECT COUNT(*) FROM a CROSS JOIN b', AB), 12)
    assert.deepEqual(q('SELECT e.name, m.name AS boss FROM people e JOIN people m ON e.boss = m.id ORDER BY e.id', D), [
      { name: 'Bob', boss: 'Ann' }, { name: 'Cid', boss: 'Ann' }, { name: 'Dee', boss: 'Bob' }, { name: 'Eve', boss: 'Cid' }
    ])
  })

  test('three tables', () => {
    assert.deepEqual(q(`
      SELECT e.name, m.name AS boss, d.floor
      FROM people e JOIN people m ON e.boss = m.id LEFT JOIN depts d ON d.dept = e.dept
      ORDER BY e.id`, D), [
      { name: 'Bob', boss: 'Ann', floor: 3 }, { name: 'Cid', boss: 'Ann', floor: 1 },
      { name: 'Dee', boss: 'Bob', floor: null }, { name: 'Eve', boss: 'Cid', floor: 1 }
    ])
  })

  test('SELECT * over a join renames clashing columns', () => {
    const rows = query('SELECT * FROM a JOIN b ON a.k = b.k LIMIT 1', AB)
    assert.deepEqual(rows.columns, ['k', 'v', 'b.k', 'w'])
  })

  test('SELECT * over a LEFT JOIN with an unmatched row has only the real columns', () => {
    const rows = query('SELECT * FROM a LEFT JOIN b ON a.k = b.k', AB)
    assert.deepEqual(rows.columns, ['k', 'v', 'b.k', 'w'])
  })

  test('a FROM item naming a table again under another alias is a second scan of that table', () => {
    const u = [{ id: 1 }, { id: 2 }, { id: 3 }]
    assert.equal(one('SELECT COUNT(*) FROM u, u v', { u }), 9)
  })

  test('errors: join without a condition, duplicate alias', () => {
    assert.throws(() => query('SELECT * FROM a JOIN b', AB), (e) => e instanceof SqlError && /needs an ON or USING/.test(e.message))
    assert.throws(() => query('SELECT * FROM a x, b x', AB), (e) => e instanceof SqlError && /more than once/.test(e.message))
  })
})

describe('GROUP BY, HAVING and aggregates', () => {
  test('group by with NULL as its own group', () => {
    assert.deepEqual(q('SELECT dept, COUNT(*) n, SUM(age) s, AVG(age) a, MIN(name) mn, MAX(age) mx FROM people GROUP BY dept ORDER BY dept', D), [
      { dept: 'eng', n: 2, s: 59, a: 29.5, mn: 'Ann', mx: 34 },
      { dept: 'ops', n: 2, s: 25, a: 25, mn: 'Cid', mx: 25 },
      { dept: null, n: 1, s: 41, a: 41, mn: 'Dee', mx: 41 }
    ])
  })

  test('missing keys and NULL group together', () => {
    assert.deepEqual(q('SELECT x, COUNT(*) n FROM t GROUP BY x ORDER BY x', { t: [{ x: 1 }, { x: null }, {}] }), [
      { x: 1, n: 1 }, { x: null, n: 2 }
    ])
  })

  test('COUNT(*) vs COUNT(col) vs COUNT(DISTINCT col)', () => {
    assert.deepEqual(q('SELECT COUNT(*) a, COUNT(age) b, COUNT(DISTINCT age) c, SUM(DISTINCT age) d FROM people', D), [
      { a: 5, b: 4, c: 3, d: 100 }
    ])
  })

  test('aggregates over no rows: one row without GROUP BY, none with it', () => {
    assert.deepEqual(q('SELECT COUNT(*) c, SUM(age) s, AVG(age) a, MAX(age) m, TOTAL(age) t, ARRAY_AGG(age) l FROM people WHERE id > 99', D), [
      { c: 0, s: null, a: null, m: null, t: 0, l: null }
    ])
    assert.deepEqual(q('SELECT dept, COUNT(*) FROM people WHERE id > 99 GROUP BY dept', D), [])
    assert.deepEqual(q('SELECT COUNT(*) n FROM e', { e: [] }), [{ n: 0 }])
  })

  test('HAVING', () => {
    assert.deepEqual(col('SELECT dept FROM people GROUP BY dept HAVING COUNT(*) > 1 ORDER BY dept', D), ['eng', 'ops'])
    assert.deepEqual(col('SELECT dept FROM people GROUP BY dept HAVING MAX(age) > 30 ORDER BY dept', D), ['eng', null])
  })

  test('HAVING can refer to a select-list alias', () => {
    assert.deepEqual(col('SELECT dept, COUNT(*) n FROM people GROUP BY dept HAVING n > 1 ORDER BY dept', D), ['eng', 'ops'])
  })

  test('GROUP BY an alias, a position, and an expression', () => {
    const expected = [{ decade: 20, n: 2 }, { decade: 30, n: 1 }, { decade: 40, n: 1 }, { decade: null, n: 1 }]
    assert.deepEqual(q('SELECT FLOOR(age / 10) * 10 AS decade, COUNT(*) n FROM people GROUP BY decade ORDER BY decade', D), expected)
    assert.deepEqual(q('SELECT FLOOR(age / 10) * 10 AS decade, COUNT(*) n FROM people GROUP BY 1 ORDER BY 1', D), expected)
    assert.deepEqual(q('SELECT FLOOR(age / 10) * 10 AS decade, COUNT(*) n FROM people GROUP BY FLOOR(age / 10) * 10 ORDER BY decade', D), expected)
  })

  test('ORDER BY an aggregate that is not selected', () => {
    assert.deepEqual(col('SELECT dept FROM people GROUP BY dept ORDER BY SUM(age) DESC', D), ['eng', null, 'ops'])
  })

  test('FILTER, ordered aggregates and STRING_AGG', () => {
    assert.deepEqual(q("SELECT COUNT(*) FILTER (WHERE dept = 'eng') e, SUM(age) FILTER (WHERE age > 30) s FROM people", D), [{ e: 2, s: 75 }])
    assert.equal(one("SELECT STRING_AGG(name, ', ' ORDER BY name DESC) FROM people WHERE dept = 'ops'", D), 'Eve, Cid')
    assert.deepEqual(one('SELECT ARRAY_AGG(age ORDER BY id) FROM people', D), [34, 25, null, 41, 25])
  })

  test('other aggregates', () => {
    const t = { t: [{ x: 1, k: 'a' }, { x: 3, k: 'b' }, { x: null, k: 'c' }, { x: 3, k: 'd' }] }
    assert.deepEqual(q('SELECT MEDIAN(x) md, MODE(x) mo, BOOL_AND(x > 0) ba, BOOL_OR(x > 2) bo, COUNT_IF(x = 3) ci, VAR_POP(x) vp FROM t', t), [
      { md: 3, mo: 3, ba: true, bo: true, ci: 2, vp: 8 / 9 }
    ])
    assert.deepEqual(one('SELECT OBJECT_AGG(k, x) FROM t', t), { a: 1, b: 3, c: null, d: 3 })
  })

  test('aggregate misuse is a SqlError', () => {
    const bad = [
      ['SELECT name FROM people WHERE COUNT(*) > 1', /Aggregate COUNT\(\) is not allowed here/],
      ['SELECT SUM(COUNT(*)) FROM people', /Aggregate COUNT\(\) is not allowed here/],
      ['SELECT COUNT(*) FROM people GROUP BY 1', /refers to an aggregate/],
      ['SELECT id FROM people GROUP BY 2', /GROUP BY position 2/],
      ['SELECT UPPER(DISTINCT name) FROM people', /UPPER\(\) is not an aggregate/],
      ['SELECT SUM() FROM people', /needs an argument/],
      ['SELECT OBJECT_AGG(id) FROM people', /takes two arguments/]
    ]
    for (const [sql, re] of bad) {
      assert.throws(() => query(sql, D), (e) => e instanceof SqlError && !(e instanceof SqlSyntaxError) && re.test(e.message), sql)
    }
  })
})

describe('ORDER BY, LIMIT, OFFSET, DISTINCT', () => {
  test('NULLs sort last ascending and first descending by default', () => {
    assert.deepEqual(col('SELECT age FROM people ORDER BY age', D), [25, 25, 34, 41, null])
    assert.deepEqual(col('SELECT age FROM people ORDER BY age DESC', D), [null, 41, 34, 25, 25])
  })

  test('NULLS FIRST / NULLS LAST', () => {
    assert.deepEqual(col('SELECT age FROM people ORDER BY age NULLS FIRST', D), [null, 25, 25, 34, 41])
    assert.deepEqual(col('SELECT age FROM people ORDER BY age DESC NULLS LAST', D), [41, 34, 25, 25, null])
    assert.throws(() => query('SELECT age FROM people ORDER BY age NULLS MIDDLE', D), /NULLS FIRST or NULLS LAST/)
  })

  test('multiple keys, aliases, ordinals and expressions', () => {
    assert.deepEqual(col('SELECT id FROM people ORDER BY age, id DESC', D), [5, 2, 1, 4, 3])
    assert.deepEqual(col('SELECT id, age * 2 AS dbl FROM people ORDER BY dbl DESC NULLS LAST, id', D), [4, 1, 2, 5, 3])
    assert.deepEqual(col('SELECT id, name FROM people ORDER BY 2 DESC', D), [5, 4, 3, 2, 1])
    assert.deepEqual(col('SELECT id FROM people ORDER BY LENGTH(name) - id', D), [5, 4, 3, 2, 1])
    assert.deepEqual(col('SELECT name FROM people ORDER BY age IS NULL DESC, name', D), ['Cid', 'Ann', 'Bob', 'Dee', 'Eve'])
  })

  test('ORDER BY a column that is not selected', () => {
    assert.deepEqual(col('SELECT name FROM people ORDER BY id DESC', D), ['Eve', 'Dee', 'Cid', 'Bob', 'Ann'])
  })

  test('the sort is stable', () => {
    assert.deepEqual(col('SELECT id FROM people ORDER BY dept NULLS FIRST', D), [4, 1, 2, 3, 5])
  })

  test('mixed types order deterministically: numbers before strings', () => {
    assert.deepEqual(col('SELECT x FROM t ORDER BY x', { t: [{ x: 'b' }, { x: 2 }, { x: 'a' }, { x: 10 }] }), [2, 10, 'a', 'b'])
  })

  test('LIMIT / OFFSET', () => {
    assert.deepEqual(col('SELECT id FROM people ORDER BY id LIMIT 2', D), [1, 2])
    assert.deepEqual(col('SELECT id FROM people ORDER BY id LIMIT 2 OFFSET 2', D), [3, 4])
    assert.deepEqual(col('SELECT id FROM people ORDER BY id OFFSET 3', D), [4, 5])
    assert.deepEqual(col('SELECT id FROM people ORDER BY id LIMIT ALL OFFSET 4', D), [5])
    assert.deepEqual(col('SELECT id FROM people ORDER BY id LIMIT 0', D), [])
    assert.deepEqual(col('SELECT id FROM people ORDER BY id LIMIT 10 OFFSET 99', D), [])
    assert.deepEqual(col('SELECT id FROM people ORDER BY id LIMIT 1 + 1', D), [1, 2])
  })

  test('DISTINCT over one and several columns, NULL is one value', () => {
    assert.deepEqual(col('SELECT DISTINCT dept FROM people ORDER BY dept', D), ['eng', 'ops', null])
    assert.deepEqual(q('SELECT DISTINCT age, dept FROM people ORDER BY age, dept', D), [
      { age: 25, dept: 'eng' }, { age: 25, dept: 'ops' }, { age: 34, dept: 'eng' }, { age: 41, dept: null }, { age: null, dept: 'ops' }
    ])
    assert.deepEqual(col('SELECT DISTINCT x FROM t', { t: [{ x: null }, {}, { x: null }] }), [null])
  })
})

describe('set operations', () => {
  const V = { a: [{ x: 1 }, { x: 1 }, { x: 2 }, { x: null }], b: [{ x: 1 }, { x: 3 }, { x: null }] }

  test('UNION, UNION ALL', () => {
    assert.deepEqual(col('SELECT x FROM a UNION SELECT x FROM b ORDER BY x', V), [1, 2, 3, null])
    assert.deepEqual(col('SELECT x FROM a UNION ALL SELECT x FROM b ORDER BY x', V), [1, 1, 1, 2, 3, null, null])
  })

  test('EXCEPT and INTERSECT treat NULLs as equal', () => {
    assert.deepEqual(col('SELECT x FROM a EXCEPT SELECT x FROM b', V), [2])
    assert.deepEqual(col('SELECT x FROM a INTERSECT SELECT x FROM b ORDER BY x', V), [1, null])
  })

  test('EXCEPT ALL / INTERSECT ALL count duplicates', () => {
    assert.deepEqual(col('SELECT x FROM a EXCEPT ALL SELECT x FROM b ORDER BY x', V), [1, 2])
    assert.deepEqual(col('SELECT * FROM (VALUES (1), (1), (2)) v INTERSECT ALL SELECT * FROM (VALUES (1), (1), (1)) w'), [1, 1])
  })

  test('column names come from the left; ORDER BY / LIMIT apply to the whole', () => {
    const rows = query('SELECT x AS k FROM a UNION SELECT x FROM b ORDER BY k DESC NULLS LAST LIMIT 2', V)
    assert.deepEqual(rows.columns, ['k'])
    assert.deepEqual([...rows], [{ k: 3 }, { k: 2 }])
  })

  test('operators chain left to right; parentheses group', () => {
    assert.deepEqual(col('SELECT 1 UNION SELECT 2 EXCEPT SELECT 1'), [2])
    assert.deepEqual(col('SELECT 1 x UNION (SELECT 2 EXCEPT SELECT 2) ORDER BY x'), [1])
  })

  test('column count mismatch is an error', () => {
    assert.throws(() => query('SELECT 1 UNION SELECT 1, 2'), /same number of columns/)
  })
})

describe('CTEs and subqueries', () => {
  test('CTEs see the CTEs before them and can be joined to themselves', () => {
    assert.deepEqual(q(`
      WITH eng AS (SELECT id, name, boss FROM people WHERE dept = 'eng'),
           named AS (SELECT e.name, m.name AS boss FROM eng e LEFT JOIN eng m ON e.boss = m.id)
      SELECT * FROM named ORDER BY name`, D), [{ name: 'Ann', boss: null }, { name: 'Bob', boss: 'Ann' }])
  })

  test('a CTE shadows a table of the same name', () => {
    assert.deepEqual(col('WITH depts AS (SELECT 9 AS floor) SELECT floor FROM depts', D), [9])
  })

  test('derived tables', () => {
    assert.deepEqual(q('SELECT s.dept, s.n FROM (SELECT dept, COUNT(*) n FROM people GROUP BY dept) s WHERE s.n > 1 ORDER BY s.dept', D), [
      { dept: 'eng', n: 2 }, { dept: 'ops', n: 2 }
    ])
  })

  test('scalar subqueries: uncorrelated and correlated, NULL on no rows', () => {
    assert.deepEqual(col('SELECT name FROM people WHERE dept = (SELECT dept FROM depts WHERE floor = 1)', D), ['Cid', 'Eve'])
    assert.deepEqual(q('SELECT p.name, (SELECT d.floor FROM depts d WHERE d.dept = p.dept) AS floor FROM people p ORDER BY p.id', D).map((r) => r.floor), [3, 3, 1, null, 1])
  })

  test('EXISTS / NOT EXISTS', () => {
    assert.deepEqual(col('SELECT d.dept FROM depts d WHERE EXISTS (SELECT 1 FROM people p WHERE p.dept = d.dept)', D), ['eng', 'ops'])
    assert.deepEqual(col('SELECT d.dept FROM depts d WHERE NOT EXISTS (SELECT 1 FROM people p WHERE p.dept = d.dept)', D), ['hr'])
  })

  test('IN / NOT IN subqueries follow NULL semantics', () => {
    assert.deepEqual(col('SELECT dept FROM depts WHERE dept IN (SELECT dept FROM people)', D), ['eng', 'ops'])
    // people.dept contains a NULL, so NOT IN is never TRUE.
    assert.deepEqual(col('SELECT dept FROM depts WHERE dept NOT IN (SELECT dept FROM people)', D), [])
    assert.deepEqual(col('SELECT dept FROM depts WHERE dept NOT IN (SELECT dept FROM people WHERE dept IS NOT NULL)', D), ['hr'])
  })

  test('correlated subquery in the select list over a join partner', () => {
    assert.deepEqual(q('SELECT d.dept, (SELECT COUNT(*) FROM people p WHERE p.dept = d.dept) AS n FROM depts d', D), [
      { dept: 'eng', n: 2 }, { dept: 'ops', n: 2 }, { dept: 'hr', n: 0 }
    ])
  })

  test('a subquery over the same table as the outer query', () => {
    assert.deepEqual(col('SELECT name FROM people WHERE age = (SELECT MAX(age) FROM people)', D), ['Dee'])
  })

  test('a subquery over the same table under a different alias', () => {
    assert.deepEqual(col('SELECT name FROM people WHERE age = (SELECT MAX(x.age) FROM people x)', D), ['Dee'])
  })

  test('workaround: aliasing the outer table makes same-table subqueries work', () => {
    assert.deepEqual(col('SELECT p.name FROM people p WHERE p.age = (SELECT MAX(age) FROM people)', D), ['Dee'])
    assert.deepEqual(col('SELECT p.name FROM people p WHERE p.age > (SELECT AVG(x.age) FROM people x WHERE x.dept = p.dept) ORDER BY p.id', D), ['Ann'])
  })
})

describe('window functions', () => {
  const S = {
    s: [
      { id: 1, g: 'a', v: 10 },
      { id: 2, g: 'a', v: 20 },
      { id: 3, g: 'a', v: 20 },
      { id: 4, g: 'b', v: 5 },
      { id: 5, g: 'b', v: null },
      { id: 6, g: 'a', v: 30 }
    ]
  }

  test('ROW_NUMBER, RANK, DENSE_RANK with ties', () => {
    assert.deepEqual(q('SELECT id, ROW_NUMBER() OVER (ORDER BY v, id) rn, RANK() OVER (ORDER BY v) r, DENSE_RANK() OVER (ORDER BY v) dr FROM s ORDER BY id', S), [
      { id: 1, rn: 2, r: 2, dr: 2 },
      { id: 2, rn: 3, r: 3, dr: 3 },
      { id: 3, rn: 4, r: 3, dr: 3 },
      { id: 4, rn: 1, r: 1, dr: 1 },
      { id: 5, rn: 6, r: 6, dr: 5 },
      { id: 6, rn: 5, r: 5, dr: 4 }
    ])
  })

  test('PARTITION BY', () => {
    assert.deepEqual(q('SELECT id, ROW_NUMBER() OVER (PARTITION BY g ORDER BY id DESC) rn FROM s ORDER BY id', S).map((r) => r.rn), [4, 3, 2, 2, 1, 1])
  })

  test('running SUM includes peers; no ORDER BY means the whole partition', () => {
    assert.deepEqual(q('SELECT id, SUM(v) OVER (PARTITION BY g ORDER BY v) rs, SUM(v) OVER (PARTITION BY g) tot, COUNT(*) OVER () n FROM s ORDER BY id', S), [
      { id: 1, rs: 10, tot: 80, n: 6 },
      { id: 2, rs: 50, tot: 80, n: 6 },
      { id: 3, rs: 50, tot: 80, n: 6 },
      { id: 4, rs: 5, tot: 5, n: 6 },
      { id: 5, rs: 5, tot: 5, n: 6 },
      { id: 6, rs: 80, tot: 80, n: 6 }
    ])
  })

  test('LAG / LEAD with offsets and defaults', () => {
    assert.deepEqual(q('SELECT id, LAG(v) OVER (ORDER BY id) p, LEAD(v, 2) OVER (ORDER BY id) n2, LAG(id, 1, 0) OVER (PARTITION BY g ORDER BY id) pg FROM s ORDER BY id', S), [
      { id: 1, p: null, n2: 20, pg: 0 },
      { id: 2, p: 10, n2: 5, pg: 1 },
      { id: 3, p: 20, n2: null, pg: 2 },
      { id: 4, p: 20, n2: 30, pg: 0 },
      { id: 5, p: 5, n2: null, pg: 4 },
      { id: 6, p: null, n2: null, pg: 3 }
    ])
  })

  test('FIRST_VALUE, LAST_VALUE (default frame), NTH_VALUE, NTILE', () => {
    assert.deepEqual(q("SELECT id, FIRST_VALUE(id) OVER w1 f FROM s WHERE g = 'a'".replace('OVER w1', 'OVER (ORDER BY v DESC, id)'), S).map((r) => r.f), [6, 6, 6, 6])
    assert.deepEqual(q("SELECT id, LAST_VALUE(id) OVER (ORDER BY v) l FROM s WHERE g = 'a' ORDER BY id", S).map((r) => r.l), [1, 3, 3, 6])
    assert.deepEqual(q("SELECT id, NTH_VALUE(id, 2) OVER (ORDER BY id) x FROM s WHERE g = 'a' ORDER BY id", S).map((r) => r.x), [null, 2, 2, 2])
    assert.deepEqual(q('SELECT id, NTILE(4) OVER (ORDER BY id) t FROM s ORDER BY id', S).map((r) => r.t), [1, 1, 2, 2, 3, 4])
  })

  test('windows over aggregates, and in ORDER BY', () => {
    assert.deepEqual(q('SELECT g, SUM(v) s, RANK() OVER (ORDER BY SUM(v) DESC) r, SUM(SUM(v)) OVER () t FROM s GROUP BY g ORDER BY g', S), [
      { g: 'a', s: 80, r: 1, t: 85 }, { g: 'b', s: 5, r: 2, t: 85 }
    ])
    assert.deepEqual(col('SELECT id FROM s ORDER BY ROW_NUMBER() OVER (ORDER BY id DESC) LIMIT 2', S), [6, 5])
  })

  test('top-N per group through a derived table', () => {
    assert.deepEqual(q(`SELECT w.g, w.id FROM (SELECT g, id, ROW_NUMBER() OVER (PARTITION BY g ORDER BY v DESC NULLS LAST, id) rn FROM s) w
      WHERE w.rn = 1 ORDER BY w.g`, S), [{ g: 'a', id: 6 }, { g: 'b', id: 4 }])
  })

  test('window misuse is a SqlError', () => {
    assert.throws(() => query('SELECT ROW_NUMBER() FROM s', S), /needs an OVER/)
    assert.throws(() => query('SELECT id FROM s WHERE ROW_NUMBER() OVER () = 1', S), /not allowed here/)
    assert.throws(() => query('SELECT UPPER(g) OVER () FROM s', S), /not a window function/)
    assert.throws(() => query('SELECT ROW_NUMBER() OVER (ORDER BY 1) FROM s', S), /does not take positions/)
  })
})

describe('nested values and JSON text', () => {
  const orders = [
    { id: 1, customer: { name: 'Ann', address: { city: 'Oslo' } }, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }], meta: '{"src":"web","tags":["x","y"],"n":{"k":5}}' },
    { id: 2, customer: { name: 'Bob' }, items: [], meta: null },
    { id: 3, customer: null, items: '[{"sku":"C","qty":7}]', meta: 'not json' }
  ]
  const O = { orders }

  test('dotted paths and indexes', () => {
    assert.deepEqual(q('SELECT o.customer.name n, o.customer.address.city c, o.items[0].sku s, o.items[1][\'qty\'] q FROM orders o', O), [
      { n: 'Ann', c: 'Oslo', s: 'A', q: 1 },
      { n: 'Bob', c: null, s: null, q: null },
      { n: null, c: null, s: 'C', q: null }
    ])
  })

  test('unqualified paths and [*]', () => {
    assert.deepEqual(col('SELECT customer.name FROM orders', O), ['Ann', 'Bob', null])
    assert.deepEqual(col('SELECT items[*].sku FROM orders', O), [['A', 'B'], [], ['C']])
  })

  test('paths walk into JSON text columns', () => {
    assert.deepEqual(col('SELECT meta.src FROM orders', O), ['web', null, null])
    assert.deepEqual(col('SELECT meta.tags[1] FROM orders', O), ['y', null, null])
  })

  test('-> keeps JSON, ->> gives text', () => {
    assert.deepEqual(q("SELECT meta->>'src' a, meta->'n'->'k' b, meta->'n'->>'k' c, meta->'tags'->>0 d FROM orders WHERE id = 1", O), [
      { a: 'web', b: 5, c: '5', d: 'x' }
    ])
  })

  test('filter and group on nested values', () => {
    assert.deepEqual(col("SELECT id FROM orders WHERE meta->>'src' = 'web'", O), [1])
    assert.deepEqual(col('SELECT id FROM orders WHERE ARRAY_LENGTH(items) > 0 ORDER BY id', O), [1, 3])
  })

  test('JSON functions', () => {
    assert.deepEqual(q("SELECT JSON_EXTRACT(meta, '$.n.k') a, JSON_VALUE(meta, '$.tags') b, JSON_KEYS(meta) c, JSON_TYPE(meta) d FROM orders WHERE id = 1", O), [
      { a: 5, b: null, c: ['src', 'tags', 'n'], d: 'object' }
    ])
    assert.deepEqual(one("SELECT JSON_OBJECT('a', 1, 'b', ARRAY(1, 2))"), { a: 1, b: [1, 2] })
    assert.equal(one("SELECT TO_JSON(JSON_PARSE('[1,2]'))"), '[1,2]')
  })
})

describe('lateral joins and table functions', () => {
  const orders = [
    { id: 1, items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }], tags: ['x', 'y'], m: '{"a":1,"b":2}' },
    { id: 2, items: [], tags: null, m: '{}' },
    { id: 3, items: '[{"sku":"A","qty":5}]', tags: ['z'], m: null }
  ]
  const O = { orders }

  test('FROM t, t.array unnests per row (inner)', () => {
    assert.deepEqual(q('SELECT o.id, i.sku, i.qty FROM orders o, o.items i', O), [
      { id: 1, sku: 'A', qty: 2 }, { id: 1, sku: 'B', qty: 1 }, { id: 3, sku: 'A', qty: 5 }
    ])
  })

  test('LEFT JOIN over a nested array keeps rows without elements', () => {
    assert.deepEqual(q('SELECT o.id, i.sku FROM orders o LEFT JOIN o.items i ON TRUE', O), [
      { id: 1, sku: 'A' }, { id: 1, sku: 'B' }, { id: 2, sku: null }, { id: 3, sku: 'A' }
    ])
  })

  test('aggregate over a lateral join', () => {
    assert.deepEqual(q('SELECT i.sku, SUM(i.qty) q FROM orders o, o.items i GROUP BY i.sku ORDER BY i.sku', O), [
      { sku: 'A', q: 7 }, { sku: 'B', q: 1 }
    ])
  })

  test('lateral over plain values: alias.value and bare alias', () => {
    assert.deepEqual(q('SELECT o.id, t.value AS tag FROM orders o, o.tags t', O), [
      { id: 1, tag: 'x' }, { id: 1, tag: 'y' }, { id: 3, tag: 'z' }
    ])
    assert.deepEqual(col('SELECT t FROM orders o, o.tags t', O), ['x', 'y', 'z'])
  })

  test('UNNEST', () => {
    assert.deepEqual(col('SELECT x.value FROM UNNEST(ARRAY(1, 2, 3)) x WHERE x.value > 1'), [2, 3])
    assert.deepEqual(q('SELECT o.id, u.sku FROM orders o, UNNEST(o.items) u WHERE u.qty > 1', O), [{ id: 1, sku: 'A' }, { id: 3, sku: 'A' }])
  })

  test('GENERATE_SERIES', () => {
    assert.deepEqual(col('SELECT value FROM GENERATE_SERIES(1, 4)'), [1, 2, 3, 4])
    assert.deepEqual(col('SELECT * FROM GENERATE_SERIES(10, 1, -3)'), [10, 7, 4, 1])
    assert.deepEqual(col('SELECT n.value FROM GENERATE_SERIES(0, 10, 5) n'), [0, 5, 10])
    assert.deepEqual(col('SELECT * FROM GENERATE_SERIES(1, 3, 0)'), [])
  })

  test('JSON_EACH over JSON text and arrays', () => {
    assert.deepEqual(q('SELECT o.id, e.key, e.value FROM orders o, JSON_EACH(o.m) e', O), [
      { id: 1, key: 'a', value: 1 }, { id: 1, key: 'b', value: 2 }
    ])
    assert.deepEqual(q("SELECT key, value FROM JSON_EACH('[\"p\",\"q\"]')"), [{ key: 0, value: 'p' }, { key: 1, value: 'q' }])
  })

  test('RIGHT/FULL joins cannot be lateral; unknown table functions are errors', () => {
    assert.throws(() => query('SELECT 1 FROM orders o RIGHT JOIN o.items i ON TRUE', O), /cannot be lateral/)
    assert.throws(() => query('SELECT * FROM BOGUS(1)'), (e) => e instanceof SqlError && /Unknown table function/.test(e.message))
  })
})

describe('parameters', () => {
  test('positional ?', () => {
    assert.deepEqual(col('SELECT id FROM people WHERE age > ? AND dept = ?', D, { params: [20, 'ops'] }), [5])
    assert.deepEqual(q('SELECT ? AS a, ? AS b, ? AS c', {}, { params: [10, 'x', null] }), [{ a: 10, b: 'x', c: null }])
  })

  test('numbered $n, reusable', () => {
    assert.deepEqual(col('SELECT id FROM people WHERE id = $1 OR id = $1 + $2', D, { params: [1, 3] }), [1, 4])
  })

  test('named :name', () => {
    assert.deepEqual(col('SELECT name FROM people WHERE dept = :d AND age < :max', D, { params: { d: 'eng', max: 30 } }), ['Bob'])
  })

  test('parameters in LIMIT and IN lists', () => {
    assert.deepEqual(col('SELECT id FROM people WHERE id IN (?, ?) ORDER BY id LIMIT ?', D, { params: [4, 2, 1] }), [2])
  })

  test('a missing parameter is a SqlError', () => {
    assert.throws(() => query('SELECT ? + 1'), (e) => e instanceof SqlError && /No value bound for parameter 1/.test(e.message))
    assert.throws(() => query('SELECT :x', {}, { params: {} }), /parameter :x/)
  })

  test('prepare compiles once and runs with different params', () => {
    const p = prepare('SELECT id FROM people WHERE age > ? ORDER BY id')
    assert.deepEqual(p.query(D, [30]).map((r) => r.id), [1, 4])
    assert.deepEqual(p.query(D, [40]).map((r) => r.id), [4])
    assert.equal(p.plan.positionalParams, 1)
  })

  test('interpreted mode gives the same answers', () => {
    const sql = 'SELECT dept, COUNT(*) n FROM people WHERE age > ? GROUP BY dept ORDER BY dept'
    assert.deepEqual(q(sql, D, { params: [20], interpreted: true }), q(sql, D, { params: [20] }))
  })
})

describe('INSERT scripts', () => {
  test('INSERT INTO a new table, then query it', () => {
    const { results, tables } = execute(`
      INSERT INTO z (a, b) VALUES (1, 'x'), (2, 'y');
      INSERT INTO z SELECT a + 10, b FROM z;
      SELECT * FROM z ORDER BY a DESC;`, {})
    assert.deepEqual(results.slice(0, 2).map((r) => r.inserted), [2, 2])
    assert.deepEqual(results[2].rows, [{ a: 12, b: 'y' }, { a: 11, b: 'x' }, { a: 2, b: 'y' }, { a: 1, b: 'x' }])
    assert.equal(tables.get('z').length, 4)
  })

  test('query() returns the last SELECT of a script', () => {
    assert.deepEqual(q("INSERT INTO t (n) VALUES (1); SELECT n FROM t; INSERT INTO t (n) VALUES (2);"), [{ n: 1 }])
  })

  test('INSERT without columns names them column1.. for a new table', () => {
    assert.deepEqual(q("INSERT INTO t VALUES (1, 'x'); SELECT * FROM t"), [{ column1: 1, column2: 'x' }])
  })

  test('INSERT into an existing input table appends without mutating the input', () => {
    const input = [{ id: 1, v: 'a' }]
    const rows = q("INSERT INTO t VALUES (2, 'b'); SELECT id, v FROM t ORDER BY id", { t: input })
    assert.deepEqual(rows, [{ id: 1, v: 'a' }, { id: 2, v: 'b' }])
    assert.equal(input.length, 1)
  })

  test('INSERT column count mismatch', () => {
    assert.throws(() => execute('INSERT INTO t (a, b) VALUES (1)', {}), /2 columns but the values have 1/)
  })

  test('a dump-style script with comments and empty statements', () => {
    const dump = `
      -- dumped
      INSERT INTO "users" ("id", "name") VALUES (1, 'Ann'), (2, 'O''Neil');;
      INSERT INTO users (id, name) VALUES (3, NULL);
      SELECT COUNT(*) n, COUNT(name) named FROM users;`
    assert.deepEqual(q(dump), [{ n: 3, named: 2 }])
  })
})

describe('data shapes and table resolution', () => {
  test('a bare array is the table `data`', () => {
    assert.deepEqual(col('SELECT x FROM data WHERE x > 1', [{ x: 1 }, { x: 2 }]), [2])
  })

  test('columnar tables', () => {
    assert.deepEqual(q('SELECT * FROM c ORDER BY id DESC', { c: { id: [1, 2], n: ['a', 'b'] } }), [{ id: 2, n: 'b' }, { id: 1, n: 'a' }])
  })

  test('a single-column columnar table is read as one row (ambiguous with one object)', () => {
    // Documented behaviour of toRows: columnar needs more than one key.
    assert.deepEqual(q('SELECT * FROM c', { c: { id: [1, 2] } }), [{ id: [1, 2] }])
  })

  test('header-row arrays', () => {
    assert.deepEqual(q('SELECT n FROM h WHERE id = 2', { h: [['id', 'n'], [1, 'a'], [2, 'b']] }), [{ n: 'b' }])
  })

  test('a single object is a one-row table', () => {
    assert.deepEqual(q('SELECT a FROM o', { o: { a: 1 } }), [{ a: 1 }])
  })

  test('tables inside nested objects, dotted keys, case-insensitive fallback', () => {
    assert.deepEqual(col('SELECT x FROM db.users', { db: { users: [{ x: 1 }] } }), [1])
    assert.deepEqual(col('SELECT x FROM my.table', { 'my.table': [{ x: 2 }] }), [2])
    assert.deepEqual(col('SELECT x FROM "my.table"', { 'my.table': [{ x: 3 }] }), [3])
    assert.deepEqual(col('SELECT x FROM USERS', { users: [{ x: 4 }] }), [4])
  })

  test('JSON text as a table', () => {
    assert.deepEqual(col('SELECT x FROM t', { t: '[{"x":1},{"x":2}]' }), [1, 2])
  })

  test('unknown table is a SqlError', () => {
    assert.throws(() => query('SELECT * FROM nope', { users: [] }), (e) => e instanceof SqlError && /Unknown table 'nope'/.test(e.message))
  })

  test('the input data is never mutated', () => {
    const t = [{ id: 2 }, { id: 1 }]
    const snapshot = JSON.stringify(t)
    query('SELECT id, ROW_NUMBER() OVER (ORDER BY id) rn FROM t ORDER BY id', { t })
    assert.equal(JSON.stringify(t), snapshot)
  })
})

describe('CAST, dates and string functions', () => {
  test('CAST and ::', () => {
    assert.deepEqual(q("SELECT CAST(3.9 AS INTEGER) a, CAST(-3.9 AS INT) b, '5'::int * 2 c, CAST('1e2' AS REAL) d, CAST('x' AS INT) e, 1::text || 'x' f, CAST('t' AS BOOLEAN) g, CAST(0 AS BOOL) h, CAST('[1,2]' AS JSON) i, CAST(NULL AS INT) j, CAST('7' AS VARCHAR(10)) k"), [
      { a: 3, b: -3, c: 10, d: 100, e: null, f: '1x', g: true, h: false, i: [1, 2], j: null, k: '7' }
    ])
  })

  test('arithmetic edge cases', () => {
    assert.deepEqual(q('SELECT 7 / 2 a, 7 % 0 b, 1 / 0 c, -7 % 3 d, ROUND(2.5) e, ROUND(-2.5) f, ROUND(1.005, 2) g, TRUNC(1.99) h, \'2\' + 3 i, \'x\' + 1 j'), [
      { a: 3.5, b: null, c: null, d: -1, e: 3, f: -3, g: 1.01, h: 1, i: 5, j: null }
    ])
  })

  test('date functions', () => {
    assert.deepEqual(q(`SELECT
        EXTRACT(YEAR FROM '2026-06-30 16:33:13') y,
        DATE_PART('month', '2026-06-30') m,
        DATE_PART('dow', '2026-06-30') dow,
        DATE_TRUNC('month', '2026-06-30T16:33:13Z') tm,
        DATE_TRUNC('week', '2026-07-02') tw,
        DATE('2026-06-30 23:30:00 -02:00') d,
        CAST('2026-06-30 16:33:13.070000+02:00' AS TIMESTAMP) ts,
        DATE_DIFF('day', '2026-01-01', '2026-03-01') dd,
        DATE_ADD('2026-01-01', 36, 'hour') da,
        STRFTIME('%Y/%m/%d %H:%M', '2026-06-30T16:33:13Z') sf,
        TO_TIMESTAMP(86400) tt`), [{
      y: 2026, m: 6, dow: 2, tm: '2026-06-01T00:00:00.000Z', tw: '2026-06-29T00:00:00.000Z',
      d: '2026-07-01', ts: '2026-06-30T14:33:13.070Z', dd: 59, da: '2026-01-02T12:00:00.000Z',
      sf: '2026/06/30 16:33', tt: '1970-01-02T00:00:00.000Z'
    }])
  })

  test('dates compare and group as written in dumps', () => {
    const t = { t: [{ at: '2026-01-05 10:00:00' }, { at: '2026-02-01 09:00:00' }, { at: '2026-01-20 08:00:00' }] }
    assert.deepEqual(q("SELECT DATE_TRUNC('month', at) m, COUNT(*) n FROM t GROUP BY 1 ORDER BY 1", t), [
      { m: '2026-01-01T00:00:00.000Z', n: 2 }, { m: '2026-02-01T00:00:00.000Z', n: 1 }
    ])
  })

  test('DATE_ADD by one month from Jan 31 clamps to the end of February', () => {
    assert.equal(one("SELECT DATE_ADD('2026-01-31', 1, 'month')"), '2026-02-28T00:00:00.000Z')
  })

  test('string functions', () => {
    assert.deepEqual(q(`SELECT UPPER('abc') u, LOWER('ABC') l, LENGTH('héllo') len, SUBSTR('hello', 2, 3) s1, SUBSTRING('hello', 3) s2,
        REPLACE('aaa', 'a', 'b') r, SPLIT_PART('a,b,c', ',', 2) sp, SPLIT_PART('a,b,c', ',', -1) spl, LPAD('5', 3, '0') lp, RPAD('ab', 4, 'xy') rp,
        TRIM('  x ') t, TRIM('xxhixx', 'x') tc, LTRIM('aab', 'a') lt, RTRIM('baa', 'a') rt, REVERSE('abc') rev, LEFT('hello', 2) le, RIGHT('hello', 3) ri,
        STRPOS('hello', 'l') sp2, CONCAT('a', NULL, 1) c, CONCAT_WS('-', 'a', NULL, 'b') cw, 'a' || NULL cn, REPEAT('ab', 3) rep`), [{
      u: 'ABC', l: 'abc', len: 5, s1: 'ell', s2: 'llo', r: 'bbb', sp: 'b', spl: 'c', lp: '005', rp: 'abxy',
      t: 'x', tc: 'hi', lt: 'b', rt: 'b', rev: 'cba', le: 'he', ri: 'llo', sp2: 3, c: 'a1', cw: 'a-b', cn: null, rep: 'ababab'
    }])
  })

  test('REPLACE with an empty search string leaves the string alone', () => {
    assert.equal(one("SELECT REPLACE('abc', '', 'x')"), 'abc')
  })

  test('regex, null and conditional functions', () => {
    assert.deepEqual(q(`SELECT REGEXP_REPLACE('a1b22', '[0-9]+', '#') rr, REGEXP_EXTRACT('ab-12', '([a-z]+)-([0-9]+)', 2) re,
        REGEXP_LIKE('Abc', '^a', 'i') rl, COALESCE(NULL, NULL, 3) co, NULLIF(1, 1) ni, IFNULL(NULL, 'd') ifn, IIF(1 > 2, 'y', 'n') iif,
        GREATEST(1, NULL, 3) gr, LEAST(2, 1) le, ABS(-2) ab, POWER(2, 10) pw, SQRT(-1) sq`), [{
      rr: 'a#b#', re: '12', rl: true, co: 3, ni: null, ifn: 'd', iif: 'n', gr: 3, le: 1, ab: 2, pw: 1024, sq: null
    }])
  })

  test('CASE: searched and simple, NULL never matches', () => {
    assert.deepEqual(col("SELECT CASE WHEN age > 30 THEN 'old' WHEN age IS NULL THEN '?' ELSE 'young' END FROM people ORDER BY id", D), ['old', 'young', '?', 'old', 'young'])
    assert.deepEqual(col("SELECT CASE dept WHEN 'eng' THEN 1 WHEN NULL THEN 2 END FROM people ORDER BY id", D), [1, 1, null, null, null])
  })

  test('CASE WHEN treats a non-zero number as true, like WHERE does', () => {
    assert.equal(one("SELECT CASE WHEN 1 THEN 'y' ELSE 'n' END"), 'y')
  })

  test('TYPEOF', () => {
    assert.deepEqual(Object.values(q("SELECT TYPEOF(1), TYPEOF('a'), TYPEOF(NULL), TYPEOF(ARRAY(1)), TYPEOF(TRUE), TYPEOF(JSON_OBJECT('a', 1))")[0]),
      ['number', 'string', 'null', 'array', 'boolean', 'object'])
  })
})

describe('errors', () => {
  test('syntax errors are SqlSyntaxErrors with a location', () => {
    let err
    try { query('SELECT id,\n  FROM t', { t: [] }) } catch (e) { err = e }
    assert.ok(err instanceof SqlSyntaxError)
    assert.ok(err instanceof SqlError)
    assert.equal(err.name, 'SqlSyntaxError')
    assert.deepEqual(err.location.start, { offset: 13, line: 2, column: 3 })
    assert.equal(err.location.end.offset, 17)
    assert.match(err.message, /line 2, column 3/)
    assert.match(err.message, /\n {4}FROM t\n {4}\^/)
  })

  test('a syntax error at end of input points past the last character', () => {
    let err
    try { compile('SELECT id FROM t WHERE') } catch (e) { err = e }
    assert.ok(err instanceof SqlSyntaxError)
    assert.deepEqual(err.location.start, { offset: 22, line: 1, column: 23 })
  })

  test('other syntax errors', () => {
    for (const sql of ['SELEC 1', 'SELECT 1 FROM t WHERE id = 1 GROUP', 'SELECT (1', 'SELECT 1 +', 'SELECT 1 FROM']) {
      assert.throws(() => compile(sql), SqlSyntaxError, sql)
    }
  })

  test('a character the lexer rejects is a SqlSyntaxError with a location', () => {
    for (const sql of ['SELECT #', "SELECT 'unterminated", 'SELECT 1 ~ 2']) {
      assert.throws(() => compile(sql), (e) => e instanceof SqlSyntaxError && e.location && e.location.start.line === 1, sql)
    }
  })

  test("a syntax error's end location has the end column", () => {
    let err
    try { compile('SELECT id,\n  FROM t') } catch (e) { err = e }
    assert.deepEqual(err.location.end, { offset: 17, line: 2, column: 7 })
  })

  test('helpful SqlErrors at compile time', () => {
    const cases = [
      ['SELECT nope', /Unknown column 'nope' — there is no FROM clause/],
      ['SELECT foo(1)', /Unknown function foo\(\)/],
      ['SELECT x.* FROM t', /Unknown table 'x' in x\.\*/],
      ['SELECT *', /SELECT \* needs a FROM clause/]
    ]
    for (const [sql, re] of cases) {
      assert.throws(() => compile(sql), (e) => e instanceof SqlError && !(e instanceof SqlSyntaxError) && re.test(e.message), sql)
    }
    assert.throws(() => compile(42), SqlError)
  })

  test('an unknown CAST type is reported as a SqlError', () => {
    assert.throws(() => compile("SELECT CAST('a' AS foo)"), SqlError)
  })

  test('compile() returns a plain-JSON plan', () => {
    const plan = compile('SELECT a FROM t WHERE a > ? ORDER BY a')
    assert.equal(plan.type, 'sqllang')
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan)
    assert.deepEqual(plan.statements[0].body.where, { GT: [{ val: ['t', 'a'] }, { PARAM: [0] }] })
  })
})

describe('PIVOT', () => {
  const s = [
    { month: 'Jan', region: 'north', amount: 10 }, { month: 'Jan', region: 'south', amount: 7 },
    { month: 'Feb', region: 'north', amount: 12 }, { month: 'Feb', region: null, amount: 1 },
    { month: 'Mar', region: 'north', amount: 3 }, { month: 'Mar', region: 'north', amount: 4 }
  ]
  const data = { s, p: [{ pivot: 1 }] }
  test('one column per listed value, per group', () => {
    assert.deepEqual(
      q("SELECT month, PIVOT(SUM(amount) FOR region IN ('north', 'south')) FROM s GROUP BY month ORDER BY month", data),
      [{ month: 'Feb', north: 12, south: null }, { month: 'Jan', north: 10, south: 7 }, { month: 'Mar', north: 7, south: null }]
    )
  })
  test('is the same as writing the FILTER aggregates out', () => {
    const a = q("SELECT month, PIVOT(COUNT(*) FOR region IN ('north', 'south')) FROM s GROUP BY month ORDER BY month", data)
    const b = q("SELECT month, COUNT(*) FILTER (WHERE region = 'north') AS north, COUNT(*) FILTER (WHERE region = 'south') AS south FROM s GROUP BY month ORDER BY month", data)
    assert.deepEqual(a, b)
  })
  test('NULL and numeric values; clashing names are renamed', () => {
    assert.deepEqual(q('SELECT PIVOT(COUNT(*) FOR region IN (NULL)) FROM s', data), [{ null: 1 }])
    assert.deepEqual(q("SELECT PIVOT(SUM(amount) FOR month IN ('Jan')), PIVOT(MAX(amount) FOR month IN ('Jan')) FROM s", data), [{ Jan: 17, Jan_2: 10 }])
  })
  test('pivot is still usable as a name', () => {
    assert.deepEqual(q('SELECT pivot FROM p', data), [{ pivot: 1 }])
  })
  test('rejects what it cannot expand', () => {
    assert.throws(() => query("SELECT PIVOT(SUM(amount) FOR region IN ('a')) AS x FROM s", data), SqlError)
    assert.throws(() => query("SELECT PIVOT(amount FOR region IN ('a')) FROM s", data), SqlError)
    assert.throws(() => query('SELECT PIVOT(SUM(amount) FOR region IN (month)) FROM s', data), SqlError)
    assert.throws(() => query("SELECT month FROM s WHERE PIVOT(SUM(amount) FOR region IN ('a')) > 1", data), SqlError)
  })
})
