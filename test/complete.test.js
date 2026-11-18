import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createCompleter, createEngine, complete, inferSchema, functionNames, aggregateNames, windowFunctions } from '../src/index.js'

const data = {
  orders: [{ id: 1, uid: 2, total: 9.5, status: 'a' }],
  users: [{ id: 2, name: 'Ann', region: 'n' }],
  events: { id: [1, 2], kind: ['x', 'y'] } // columnar
}
const c = createCompleter({ data })

/** Suggestions for `text`, with `|` marking the cursor. */
const at = (text, completer = c) => {
  const cursor = text.indexOf('|')
  return completer(text.replace('|', ''), cursor)
}
const labels = (text, kind) => at(text).items.filter((i) => !kind || i.kind === kind).map((i) => i.label)

describe('keywords come from the parser', () => {
  test('a statement starts with a statement keyword', () => {
    assert.deepEqual(labels('|').sort(), ['INSERT', 'SELECT', 'VALUES', 'WITH'])
    assert.equal(labels('|')[0], 'SELECT') // the likeliest first
    assert.deepEqual(labels('SEL|'), ['SELECT'])
    assert.deepEqual(labels('select * fr|'), ['FROM'])
  })
  test('after a complete FROM item, the clauses that can follow', () => {
    const next = labels('SELECT * FROM orders o |', 'keyword')
    for (const k of ['WHERE', 'JOIN', 'GROUP', 'ORDER', 'LIMIT']) assert.ok(next.includes(k), k)
    assert.ok(!next.includes('SELECT'))
  })
  test('operator words sort after clause keywords', () => {
    const items = at('SELECT uid FROM orders GROUP BY uid |').items
    assert.ok(items.findIndex((i) => i.label === 'HAVING') < items.findIndex((i) => i.label === 'AND'))
  })
  test('keywords are not offered where only a name fits', () => {
    assert.ok(!labels('SELECT * FROM |').includes('SELECT'))
    assert.ok(!labels('SELECT * FROM |').includes('IDENTIFIER'))
  })
})

describe('tables and columns', () => {
  test('FROM offers tables, and the CTEs the statement defines', () => {
    assert.deepEqual(labels('SELECT * FROM |', 'table'), ['events', 'orders', 'users'])
    assert.deepEqual(labels('WITH t AS (SELECT 1) SELECT * FROM |', 'table'), ['t', 'events', 'orders', 'users']) // the CTE just defined leads
    assert.deepEqual(labels('SELECT * FROM ord|', 'table'), ['orders'])
  })
  test('alias. offers that table\'s columns, even when the alias is declared later', () => {
    assert.deepEqual(labels('SELECT o.| FROM orders o', 'column'), ['id', 'status', 'total', 'uid'])
    assert.deepEqual(labels('SELECT o.to| FROM orders AS o', 'column'), ['total'])
    assert.deepEqual(labels('SELECT * FROM orders o JOIN users u ON u.id = u.|', 'column'), ['id', 'name', 'region'])
  })
  test('the table name works as its own qualifier; columnar tables are read too', () => {
    assert.deepEqual(labels('SELECT orders.| FROM orders', 'column'), ['id', 'status', 'total', 'uid'])
    assert.deepEqual(labels('SELECT e.| FROM events e', 'column'), ['id', 'kind'])
  })
  test('unqualified columns come from the tables in scope, and the aliases too', () => {
    const items = at('SELECT * FROM orders o JOIN users u ON 1 = 1 WHERE |').items
    const cols = items.filter((i) => i.kind === 'column').map((i) => i.label)
    assert.deepEqual([...new Set(cols)].sort(), ['id', 'name', 'region', 'status', 'total', 'uid'])
    assert.deepEqual(items.filter((i) => i.kind === 'alias').map((i) => i.label).sort(), ['o', 'u'])
  })
  test('only the statement the cursor is in counts', () => {
    assert.deepEqual(labels('SELECT * FROM orders; SELECT u.| FROM users u', 'column'), ['id', 'name', 'region'])
  })
  test('column types are reported', () => {
    const t = at('SELECT o.| FROM orders o').items.find((i) => i.label === 'total')
    assert.equal(t.detail, 'number')
  })
})

describe('functions', () => {
  test('in an expression: scalar, aggregate and window functions, plus custom ones', () => {
    const custom = createCompleter({ data, functions: ['myfn'] })
    const su = custom('SELECT SU', 9).items
    for (const l of ['SUM', 'SUBSTR']) assert.ok(su.some((i) => i.label === l), l)
    assert.equal(su.find((i) => i.label === 'SUM').kind, 'aggregate')
    assert.equal(su.find((i) => i.label === 'SUBSTR').kind, 'function')
    assert.ok(custom('SELECT MYF', 10).items.some((i) => i.label === 'MYFN'))
    assert.ok(!c('SELECT MYF', 10).items.some((i) => i.label === 'MYFN'))
    assert.ok(labels('SELECT ROW_NUM|', 'window').includes('ROW_NUMBER'))
  })
  test('prefix matches come before contains-matches, columns before functions', () => {
    const items = at('SELECT * FROM orders WHERE st|').items
    assert.equal(items[0].label, 'status')
    assert.equal(items[0].kind, 'column')
  })
})

describe('where it stays quiet', () => {
  test('naming something new, inside strings and comments', () => {
    assert.deepEqual(at('SELECT a AS |').items, [])
    assert.deepEqual(at("SELECT 'abc|").items, [])
    assert.deepEqual(at('SELECT 1 -- note |').items, [])
    assert.deepEqual(at('SELECT 1 /* note | */').items, [])
    assert.deepEqual(at('SELECT "my col|" FROM t').items, [])
    // ...and wakes up again after them
    assert.ok(at("SELECT 'it''s' FROM |").items.length > 0)
    assert.ok(at('SELECT 1 -- note\nFROM |').items.some((i) => i.label === 'orders'))
    assert.ok(at('SELECT /* a */ 1 FROM |').items.some((i) => i.label === 'orders'))
  })
  test('after a syntax error before the cursor', () => {
    assert.deepEqual(at('SELECT FROM FROM |').items, [])
  })
  test('an unknown qualifier has no columns', () => {
    assert.deepEqual(at('SELECT zzz.| FROM orders').items, [])
  })
})

describe('the replaced range', () => {
  test('covers the whole word under the cursor', () => {
    const r = c('SELECT * FROM orders WHERE total > 1', 29) // inside "total"
    assert.deepEqual([r.from, r.to, r.prefix], [27, 32, 'to'])
  })
  test('is empty between words', () => {
    const r = c('SELECT * FROM ', 14)
    assert.deepEqual([r.from, r.to, r.prefix], [14, 14, ''])
  })
  test('the cursor defaults to the end, and is clamped', () => {
    assert.deepEqual(c('SEL').items.map((i) => i.label), ['SELECT'])
    assert.deepEqual(c('SEL', 99).items.map((i) => i.label), ['SELECT'])
  })
})

describe('stating what the data cannot say', () => {
  const stated = createCompleter({ tables: { t: ['a', { name: 'b', type: 'number' }] } })
  test('tables with columns, without any data', () => {
    assert.deepEqual(at('SELECT x.| FROM t x', stated).items.map((i) => [i.label, i.detail]), [['a', undefined], ['b', 'number']])
    assert.deepEqual(at('SELECT * FROM |', stated).items.filter((i) => i.kind === 'table').map((i) => i.label), ['t'])
  })
  test('table names alone', () => {
    const names = createCompleter({ tables: ['orders', 'users'] })
    assert.deepEqual(at('SELECT * FROM |', names).items.filter((i) => i.kind === 'table').map((i) => i.label), ['orders', 'users'])
    assert.deepEqual(at('SELECT o.| FROM orders o', names).items, []) // no columns known
  })
  test('stated tables extend the data, and a stated table replaces its columns', () => {
    const both = createCompleter({ data, tables: { orders: ['id', 'note'], extra: ['z'] } })
    assert.deepEqual(at('SELECT o.| FROM orders o', both).items.map((i) => i.label), ['id', 'note'])
    assert.equal(at('SELECT o.| FROM orders o', both).items.find((i) => i.label === 'id').detail, 'number') // type kept from the data
    assert.deepEqual(at('SELECT * FROM |', both).items.filter((i) => i.kind === 'table').map((i) => i.label), ['events', 'extra', 'orders', 'users'])
  })
  test('an engine\'s custom functions are offered, without listing them again', () => {
    const engine = createEngine({ functions: { double: ([x]) => x * 2, Shout: ([s]) => String(s).toUpperCase() } })
    const labels = (cc, text) => cc(text).items.filter((i) => i.kind === 'function').map((i) => i.label)
    assert.deepEqual(labels(createCompleter({ engine }), 'SELECT DOU'), ['DOUBLE'])
    assert.deepEqual(labels(createCompleter({ engine }), 'SELECT SHO'), ['SHOUT'])
    assert.deepEqual(labels(createCompleter({ engine, functions: ['double', 'extra'] }), 'SELECT E').includes('EXTRA'), true)
    assert.deepEqual(labels(createCompleter({}), 'SELECT DOU'), [])
  })
  test('every built-in function, aggregate and window function is offered', () => {
    const offered = new Set()
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const i of c(`SELECT ${ch}`).items) offered.add(i.label)
    for (const name of [...functionNames, ...aggregateNames, ...windowFunctions]) assert.ok(offered.has(name), name)
  })
  test('functions', () => {
    assert.ok(createCompleter({ functions: ['myfn'] })('SELECT MYF').items.some((i) => i.label === 'MYFN'))
  })
  test('inferSchema reads columns from the first rows, and finds a type once a value is not NULL', () => {
    const s = inferSchema({ t: [{ a: null, b: 1 }, { a: 'x', c: true }] })
    assert.deepEqual(s.tables.t, [{ name: 'a', type: 'string' }, { name: 'b', type: 'number' }, { name: 'c', type: 'boolean' }])
  })
  test('complete() is the one-off form', () => {
    assert.deepEqual(complete('SEL', 3).items.map((i) => i.label), ['SELECT'])
  })
})

describe('values', () => {
  const vdata = {
    orders: [
      { id: 1, status: 'open', kind: "it's", paid: true, n: 3 },
      { id: 2, status: 'paid', kind: 'x', paid: false, n: 3 },
      { id: 3, status: 'open', kind: 'y', paid: true, n: 5 }
    ],
    big: Array.from({ length: 500 }, (_, i) => ({ id: i, code: 'c' + i }))
  }
  const v = createCompleter({ data: vdata })
  const values = (text, completer = v) => at(text, completer).items.filter((i) => i.kind === 'value')

  test('after a comparison, the values the column has in the data', () => {
    assert.deepEqual(values('SELECT * FROM orders WHERE status = |').map((i) => i.label), ['open', 'paid'])
    assert.deepEqual(values('SELECT * FROM orders o WHERE o.status <> |').map((i) => i.label), ['open', 'paid'])
    assert.deepEqual(values('SELECT * FROM orders WHERE n > |').map((i) => i.label), ['3', '5'])
  })
  test('outside a string they insert as SQL literals', () => {
    const items = values('SELECT * FROM orders WHERE kind = |')
    assert.deepEqual(items.map((i) => [i.label, i.insert]), [["it's", "'it''s'"], ['x', "'x'"], ['y', "'y'"]])
    assert.deepEqual(values('SELECT * FROM orders WHERE paid = |').map((i) => i.insert), ['TRUE', 'FALSE'])
    assert.deepEqual(values('SELECT * FROM orders WHERE n = |').map((i) => i.insert), ['3', '5'])
  })
  test('inside a string they complete the text, escaped, replacing what is there', () => {
    const r = at("SELECT * FROM orders WHERE status = 'op|'", v)
    assert.deepEqual(r.items.map((i) => [i.label, i.insert]), [['open', 'open']])
    assert.equal("SELECT * FROM orders WHERE status = 'op'".slice(r.from, r.to), 'op')
    assert.deepEqual(at("SELECT * FROM orders WHERE kind = 'it|", v).items.map((i) => i.insert), ["it''s"])
    assert.deepEqual(at("SELECT * FROM orders WHERE kind = 'it''|", v).items.map((i) => i.label), ["it's"]) // typed escape counts
    assert.deepEqual(at("SELECT * FROM orders WHERE n = '|", v).items, []) // numbers do not go in quotes
  })
  test('in an IN list, after the values already written', () => {
    assert.deepEqual(values("SELECT * FROM orders WHERE status IN (|").map((i) => i.label), ['open', 'paid'])
    assert.deepEqual(values("SELECT * FROM orders WHERE status NOT IN ('open', |").map((i) => i.label), ['open', 'paid'])
    assert.equal(at("SELECT * FROM orders WHERE status IN ('open', 'p|')", v).items[0].label, 'paid') // (`open` has a p in it, so it follows)
  })
  test('LIKE offers them too', () => {
    assert.deepEqual(values('SELECT * FROM orders WHERE status LIKE |').map((i) => i.label), ['open', 'paid'])
  })
  test('a column with many distinct values is not a short list', () => {
    assert.deepEqual(values('SELECT * FROM big WHERE code = |'), [])
    assert.deepEqual(values('SELECT * FROM big WHERE id = |'), [])
  })
  test('not where no column is being compared', () => {
    assert.deepEqual(values('SELECT * FROM orders WHERE |'), [])
    assert.deepEqual(values('SELECT | FROM orders'), [])
    assert.deepEqual(at("SELECT * FROM orders WHERE 'x|' = status", v).items, [])
  })
  test('stated values win over what the data has, by table.column or by column', () => {
    const s = createCompleter({ data: vdata, values: { 'orders.status': ['open', 'paid', 'void'] } })
    assert.deepEqual(values('SELECT * FROM orders WHERE status = |', s).map((i) => i.label), ['open', 'paid', 'void'])
    const bare = createCompleter({ tables: { t: ['region'] }, values: { region: ['n', 's'] } })
    assert.deepEqual(values('SELECT * FROM t WHERE region = |', bare).map((i) => i.label), ['n', 's'])
    const inline = createCompleter({ tables: { t: [{ name: 'region', values: ['e', 'w'] }] } })
    assert.deepEqual(values('SELECT * FROM t WHERE region = |', inline).map((i) => i.label), ['e', 'w'])
  })
  test('values are ranked with the columns, ahead of functions', () => {
    const items = at('SELECT * FROM orders WHERE status = |', v).items
    assert.ok(items.findIndex((i) => i.kind === 'value') < items.findIndex((i) => i.kind === 'function'))
  })
})

describe('update', () => {
  test('replaces what it knows without making a new completer', () => {
    const live = createCompleter({ data: { t: [{ a: 1 }] } })
    assert.deepEqual(at('SELECT x.| FROM t x', live).items.map((i) => i.label), ['a'])
    assert.equal(live.update({ data: { t: [{ b: 1 }], u: [{ c: 1 }] } }), live)
    assert.deepEqual(at('SELECT x.| FROM t x', live).items.map((i) => i.label), ['b'])
    assert.deepEqual(at('SELECT * FROM |', live).items.filter((i) => i.kind === 'table').map((i) => i.label), ['t', 'u'])
    live.update({ values: { b: ['q'] } })
    assert.deepEqual(at('SELECT * FROM t WHERE b = |', live).items.filter((i) => i.kind === 'value').map((i) => i.label), ['q'])
  })
})

describe('only what fits is offered', () => {
  test('after a complete expression a name can only be an alias, so no columns or functions', () => {
    for (const text of ['SELECT id, name |', 'SELECT orders.id |', 'SELECT COUNT(*) |']) {
      const items = at(text + ' FROM orders').items
      assert.ok(!items.some((i) => ['column', 'function', 'aggregate', 'alias'].includes(i.kind)), text)
      assert.ok(items.some((i) => i.label === 'AS'), text)
    }
    assert.ok(at('SELECT | FROM orders').items.some((i) => i.kind === 'column')) // ...but at the start of one, yes
  })
  test('every suggestion keeps the text parseable up to that point', () => {
    for (const text of ['SELECT | FROM orders o', 'SELECT * FROM orders o WHERE |', 'SELECT * FROM orders o WHERE o.status = |', 'SELECT * FROM orders o |']) {
      for (const item of at(text).items.slice(0, 200)) {
        const sql = text.replace('|', item.insert ?? item.label)
        assert.doesNotThrow(() => complete(sql, sql.length), `${text} + ${item.label}`)
      }
    }
  })
})

describe('ordering', () => {
  const first = (text, n = 1, completer = c) => at(text, completer).items.slice(0, n).map((i) => i.label)
  test('with nothing typed, the next clause comes first', () => {
    assert.deepEqual(first('SELECT id FROM orders |', 3), ['WHERE', 'JOIN', 'INNER'])
    assert.equal(first('SELECT id |')[0], 'FROM')
    assert.deepEqual(first('SELECT id FROM orders GROUP BY id |', 3), ['HAVING', 'ORDER', 'LIMIT'])
  })
  test('AND and OR are likely in a condition, and not in a select list or GROUP BY', () => {
    assert.deepEqual(first('SELECT * FROM orders WHERE id = 1 |', 2), ['AND', 'OR'])
    assert.equal(first('SELECT * FROM orders o JOIN users u ON u.id = o.uid |')[0], 'WHERE')
    const group = at('SELECT id FROM orders GROUP BY id |').items.map((i) => i.label)
    assert.ok(group.indexOf('HAVING') < group.indexOf('AND'))
    const list = at('SELECT id |').items.map((i) => i.label)
    assert.ok(list.indexOf('FROM') < list.indexOf('AND'))
  })
  test('common functions come before rare ones', () => {
    const su = at('SELECT SU|').items.filter((i) => i.kind !== 'keyword').map((i) => i.label)
    assert.ok(su.indexOf('SUM') < su.indexOf('SUBSTR'))
    assert.ok(su.indexOf('SUBSTR') < su.indexOf('SUBSTRING'))
    assert.equal(first('SELECT CO|')[0], 'COUNT')
  })
  test('names used earlier in the statement come first', () => {
    assert.equal(first('SELECT total FROM orders WHERE |')[0], 'total')
    assert.equal(first('SELECT status FROM orders GROUP BY |')[0], 'status')
  })
  test('with several tables, aliases come before bare columns', () => {
    assert.equal(first('SELECT * FROM orders o JOIN users u ON |')[0], 'o')
    assert.equal(first('SELECT * FROM orders o WHERE |')[0], 'id') // one table: the columns
  })
})

describe('columns belong to the tables in the query', () => {
  const stated = createCompleter({ tables: { orders: ['id', 'total'], users: ['id', 'name'] } })
  const cols = (text, completer = stated) => at(text, completer).items.filter((i) => i.kind === 'column').map((i) => i.label)
  test('a table\'s columns are offered only when the table is in the statement', () => {
    assert.deepEqual(cols('SELECT na| FROM users'), ['name'])
    assert.deepEqual(cols('SELECT na| FROM orders'), []) // `name` belongs to users
    assert.deepEqual(cols('SELECT * FROM orders WHERE |'), ['id', 'total'])
    assert.deepEqual(cols('SELECT * FROM orders o JOIN users u ON 1 = 1 WHERE |').sort(), ['id', 'name', 'total'])
    assert.deepEqual(cols('SELECT x.| FROM users x'), ['id', 'name'])
    assert.deepEqual(cols('SELECT x.| FROM users x JOIN orders y ON 1 = 1'), ['id', 'name'])
  })
  test('so before any FROM there are none, and an undeclared alias has none', () => {
    assert.deepEqual(cols('SELECT na|'), [])
    assert.deepEqual(cols('SELECT |'), [])
    assert.deepEqual(cols('SELECT o.to|'), [])
    assert.ok(at('SELECT |', stated).items.some((i) => i.kind === 'function')) // functions and keywords still are
  })
  test('another statement\'s tables do not count', () => {
    assert.deepEqual(cols('SELECT * FROM orders; SELECT na| FROM users'), ['name'])
    assert.deepEqual(cols('SELECT * FROM users; SELECT na| FROM orders'), [])
  })
  test('values are per table.column, so they follow the same rule', () => {
    const v = createCompleter({ tables: { orders: ['status'], users: ['status'] }, values: { 'orders.status': ['open'], 'users.status': ['active'] } })
    const vals = (text) => at(text, v).items.filter((i) => i.kind === 'value').map((i) => i.label)
    assert.deepEqual(vals('SELECT * FROM orders WHERE status = |'), ['open'])
    assert.deepEqual(vals('SELECT * FROM users WHERE status = |'), ['active'])
    assert.deepEqual(vals('SELECT * FROM orders o JOIN users u ON 1 = 1 WHERE u.status = |'), ['active'])
  })
})

describe('guessColumns: before there is a FROM', () => {
  test('the columns of every table are offered, deduplicated', () => {
    const g = createCompleter({ data, guessColumns: true })
    assert.deepEqual(at('SELECT na|', g).items.filter((i) => i.kind === 'column').map((i) => i.label), ['name'])
    const all = at('SELECT |', g).items.filter((i) => i.kind === 'column').map((i) => i.label)
    assert.equal(new Set(all).size, all.length)
    for (const col of ['id', 'total', 'name', 'region', 'kind']) assert.ok(all.includes(col), col)
  })
  test('an alias not declared yet stands for the table whose name it starts', () => {
    const g = createCompleter({ data, guessColumns: true })
    assert.equal(at('SELECT o.| FROM orders o', g).items.length, 4) // declared: that table, as always
    assert.deepEqual(at('SELECT o.to|', g).items.map((i) => i.label), ['total']) // not yet: `o` is probably orders
    assert.deepEqual(at('SELECT u.na|', g).items.map((i) => i.label), ['name'])
    assert.deepEqual(at('SELECT zzz.|', g).items, []) // but nothing is guessed from nothing
  })
  test('with a FROM present it changes nothing', () => {
    const g = createCompleter({ data, guessColumns: true })
    assert.deepEqual(at('SELECT na| FROM orders', g).items.filter((i) => i.kind === 'column'), [])
  })
  test('update() can turn it on', () => {
    const live = createCompleter({ data })
    assert.deepEqual(at('SELECT na|', live).items.filter((i) => i.kind === 'column'), [])
    live.update({ guessColumns: true })
    assert.deepEqual(at('SELECT na|', live).items.filter((i) => i.kind === 'column').map((i) => i.label), ['name'])
  })
})
