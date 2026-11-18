/**
 * Autocomplete for sqllang SQL.
 *
 * The parser does the grammar part. Parsing the text before the cursor plus one
 * made-up token that nothing accepts makes it fail right there, and its error says
 * which tokens would have been accepted (`expected`) and which rules it was inside
 * (`ruleStack`). Everything else here is meaning: which tables and columns exist,
 * which aliases the statement has declared, which functions can be called, and
 * which values a column is likely to be compared with.
 *
 *   const complete = createCompleter({ data })          // tables, columns, types, values: from the data
 *   complete('SELECT o.| FROM orders o', 9)             // { from, to, prefix, items: [{ label, kind, ... }] }
 *
 * What the data cannot tell it, or what you would rather state, is passed in:
 *
 *   createCompleter({
 *     tables: ['orders', 'users'],                      // names only, or
 *     tables: { orders: ['id', { name: 'status', type: 'string', values: ['open', 'paid'] }] },
 *     values: { 'orders.status': ['open', 'paid'], region: ['n', 's'] },
 *     functions: ['MYFN']
 *   })
 */

import { tokenize, parseTokens } from './parser.js'
import { toRows } from './execute.js'
import { functions } from './functions.js'
import { aggregates, windowFunctions } from './aggregates.js'

const SAMPLE_ROWS = 200 // rows read to find a table's columns
const VALUE_ROWS = 2000 // rows read to find a column's values
const MAX_VALUES = 50 // a column with more distinct values than this is not a short list
const WORD = /[A-Za-z0-9_$]/

// -- schema ---------------------------------------------------------------------------

function typeName (v) {
  if (Array.isArray(v)) return 'array'
  if (v instanceof Date) return 'date'
  return typeof v
}

function rowsOf (value) {
  try {
    const rows = toRows(value, true)
    return Array.isArray(rows) ? rows : null
  } catch { return null }
}

const tablesOf = (data) => (Array.isArray(data) ? { data } : data ?? {})

/**
 * The tables in `data` and their columns, as `{ tables: { name: [{ name, type }] } }`.
 * Columns come from the first rows, so a column that only later rows have is not seen.
 */
export function inferSchema (data) {
  const source = tablesOf(data)
  const tables = {}
  for (const name of Object.keys(source)) {
    const rows = rowsOf(source[name])
    if (rows) tables[name] = columnsOf(rows)
  }
  return { tables }
}

function columnsOf (rows) {
  const columns = new Map()
  for (let i = 0; i < rows.length && i < SAMPLE_ROWS; i++) {
    const row = rows[i]
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    for (const key of Object.keys(row)) {
      const v = row[key]
      const seen = columns.get(key)
      if (seen === undefined || (seen === null && v !== null && v !== undefined)) columns.set(key, v === null || v === undefined ? null : typeName(v))
    }
  }
  return [...columns].map(([name, type]) => ({ name, type }))
}

/** The distinct scalar values of a column, if there are few of them; otherwise null. */
function distinctValues (rows, column) {
  const seen = new Set()
  for (let i = 0; i < rows.length && i < VALUE_ROWS; i++) {
    const row = rows[i]
    const v = row !== null && typeof row === 'object' ? row[column] : undefined
    if (v === null || v === undefined || (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean')) continue
    seen.add(v)
    if (seen.size > MAX_VALUES) return null
  }
  return seen.size ? [...seen] : null
}

const asColumn = (c) => (typeof c === 'string' ? { name: c } : c)

/** Everything the completer knows: `tables` (name -> { columns, rows }), stated `values`, custom functions. */
function buildModel (options) {
  const tables = new Map()
  const source = tablesOf(options.data)
  for (const name of Object.keys(source)) {
    const rows = rowsOf(source[name])
    if (rows) tables.set(name, { columns: columnsOf(rows), rows })
  }
  // Stated tables extend or replace what the data showed.
  const stated = options.tables
  const entries = Array.isArray(stated) ? stated.map((n) => [n, null]) : Object.entries(stated ?? {})
  for (const [name, columns] of entries) {
    const known = tables.get(name)
    if (columns === null) { if (!known) tables.set(name, { columns: [], rows: null }); continue }
    const byName = new Map((known?.columns ?? []).map((c) => [c.name, c]))
    tables.set(name, { columns: columns.map((c) => ({ ...byName.get(asColumn(c).name), ...asColumn(c) })), rows: known?.rows ?? null })
  }
  return {
    tables,
    guess: Boolean(options.guessColumns),
    values: new Map(Object.entries(options.values ?? {})), // 'table.column' or 'column' -> list
    // Custom functions: the engine's, if you pass the one you query with, and any named here.
    custom: [...new Set([...(options.engine?.sqlFunctions ?? []), ...(options.functions ?? [])].map((n) => String(n).toUpperCase()))]
      .map((label) => ({ label, kind: 'function' }))
  }
}

/** The values a column is likely to be compared with: stated, then read from the data. */
function valuesFor (model, table, column) {
  const t = model.tables.get(table)
  const stated = model.values.get(`${table}.${column}`) ?? model.values.get(column) ?? t?.columns.find((c) => c.name === column)?.values
  if (stated) return stated
  if (!t?.rows) return null
  t.found ??= new Map()
  if (!t.found.has(column)) t.found.set(column, distinctValues(t.rows, column))
  return t.found.get(column)
}

// -- reading the text ---------------------------------------------------------------------

/**
 * Where `at` is: in code, in a '...' string (with the string's range), or somewhere
 * completion has nothing to say: a quoted name, a comment.
 */
function locate (sql, at) {
  let i = 0
  while (i < at) {
    const ch = sql[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      // A quote closes at the next one; a doubled quote inside is an escape and re-opens.
      let j = i + 1
      while (j < sql.length && !(sql[j] === ch && sql[j + 1] !== ch)) j += sql[j] === ch ? 2 : 1
      if (at <= j) return ch === "'" ? { kind: 'string', start: i, end: Math.min(j, sql.length) } : { kind: 'other' }
      i = j + 1
    } else if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      if (end === -1 || at <= end) return { kind: 'other' }
      i = end + 1
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1 || at < end + 2) return { kind: 'other' }
      i = end + 2
    } else i++
  }
  return { kind: 'code' }
}

// A token type is a keyword when its upper-cased name lexes back to itself: `Select`
// -> SELECT -> Select. Punctuation and the open-ended tokens (Number, String) do not,
// so no list has to be kept in step with the grammar.
const keywordText = new Map()
function keywordOf (type) {
  if (keywordText.has(type)) return keywordText.get(type)
  let text = null
  const upper = type.toUpperCase()
  // (`Identifier` is the one open-ended token that spells like a word.)
  if (/^[A-Z]+$/.test(upper) && type !== 'Identifier') {
    try {
      const t = tokenize(upper)
      if (t.length === 1 && t[0].type === type) text = upper
    } catch { /* not a word the lexer knows */ }
  }
  keywordText.set(type, text)
  return text
}

const OPERATORS = new Set(['And', 'Or', 'Between', 'Like', 'Ilike', 'In', 'Is', 'Not'])
const CLAUSE_END = new Set(['Where', 'Group', 'Having', 'Order', 'Limit', 'Offset', 'Union', 'Except', 'Intersect', 'Select', 'Semicolon', 'RParen'])
// The clause the cursor is in decides whether AND and OR are likely: a condition can go on, a select
// list or a GROUP BY cannot.
const BOOLEAN_CLAUSE = new Set(['Where', 'On', 'Having', 'When'])
const OTHER_CLAUSE = new Set(['Select', 'From', 'Group', 'Order', 'Limit', 'Offset', 'Join', 'Then', 'Else', 'Using', 'Union', 'Except', 'Intersect', 'Values', 'Insert', 'By'])
function inCondition (head) {
  for (let i = head.length - 1; i >= 0; i--) {
    if (BOOLEAN_CLAUSE.has(head[i].type)) return true
    if (OTHER_CLAUSE.has(head[i].type)) return false
  }
  return false
}
/** A table name goes right after FROM or JOIN, or after a comma in the FROM list; after one, a name is an alias. */
function tablePosition (head) {
  const last = head[head.length - 1]
  if (last?.type === 'From' || last?.type === 'Join') return true
  if (last?.type !== 'Comma') return false
  for (let i = head.length - 2; i >= 0; i--) {
    if (head[i].type === 'From') return true
    if (OTHER_CLAUSE.has(head[i].type) || BOOLEAN_CLAUSE.has(head[i].type)) return false
  }
  return false
}
const COMPARISONS = new Set(['Eq', 'EqEq', 'NotEq', 'BangEq', 'Lt', 'LtEq', 'Gt', 'GtEq', 'Like', 'Ilike'])
const LITERALS = new Set(['String', 'Number', 'Null', 'True', 'False', 'Comma'])

/**
 * The tables a statement names: `FROM t`, `JOIN t AS x`, `FROM a, b y`, `WITH c AS (...)`.
 * Read from the whole statement, so `SELECT o.| FROM orders o` knows what `o` is.
 */
function scopeOf (tokens, at) {
  // Only the statement the cursor is in.
  let lo = 0
  let hi = tokens.length
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'Semicolon') continue
    if (tokens[i].end <= at) lo = i + 1
    else { hi = i; break }
  }
  const sources = [] // { alias, table }
  const ctes = []
  let inFrom = false
  for (let i = lo; i < hi; i++) {
    const t = tokens[i]
    if (t.type === 'Identifier' && tokens[i + 1]?.type === 'As' && tokens[i + 2]?.type === 'LParen') ctes.push(t.image)
    if (t.type === 'From' || t.type === 'Join') { inFrom = true; i = readSource(tokens, i + 1, hi, sources) - 1; continue }
    if (inFrom && t.type === 'Comma') { i = readSource(tokens, i + 1, hi, sources) - 1; continue }
    if (CLAUSE_END.has(t.type)) inFrom = false
  }
  return { sources, ctes }
}

/** Reads `name[.name] [AS] [alias]` at `i`; returns the index after it. */
function readSource (tokens, i, end, sources) {
  if (i >= end || tokens[i].type !== 'Identifier') return i
  let table = tokens[i].image
  i++
  while (i + 1 < end && tokens[i].type === 'Dot' && tokens[i + 1].type === 'Identifier') { table += '.' + tokens[i + 1].image; i += 2 }
  if (tokens[i]?.type === 'LParen') return i // a table function: UNNEST(...), GENERATE_SERIES(...)
  let alias = table
  if (i < end && tokens[i].type === 'As' && tokens[i + 1]?.type === 'Identifier') { alias = tokens[i + 1].image; i += 2 }
  else if (i < end && tokens[i].type === 'Identifier') { alias = tokens[i].image; i++ }
  sources.push({ alias, table })
  return i
}

/**
 * When the cursor is where a value is compared with a column (`status = |`,
 * `status IN ('a', |)`, `o.status LIKE |`), that column: { qualifier, name }.
 */
function comparedColumn (head) {
  let i = head.length - 1
  if (i < 0) return null
  if (COMPARISONS.has(head[i].type)) i--
  else {
    // An IN list: back over the values already there to its parenthesis.
    while (i >= 0 && LITERALS.has(head[i].type)) i--
    if (head[i]?.type !== 'LParen') return null
    i--
    if (head[i]?.type !== 'In') return null
    i--
    if (head[i]?.type === 'Not') i--
  }
  if (head[i]?.type !== 'Identifier') return null
  const name = head[i].image
  if (head[i - 1]?.type === 'Dot' && head[i - 2]?.type === 'Identifier') return { qualifier: head[i - 2].image, name }
  return { qualifier: null, name }
}

// -- ordering priors -------------------------------------------------------------------

// Where nothing has been typed yet, the likeliest keyword is the next clause of a query, then
// the words that build expressions. (Unlisted words follow, alphabetically.)
const KEYWORD_ORDER = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'ON', 'AND', 'OR', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET',
  'AS', 'DESC', 'ASC', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IN', 'LIKE', 'BETWEEN', 'IS', 'NOT', 'NULL', 'EXISTS', 'UNION', 'ALL', 'OVER', 'PARTITION', 'FILTER',
  'RIGHT', 'FULL', 'CROSS', 'USING', 'WITH', 'EXCEPT', 'INTERSECT', 'INSERT', 'VALUES']
// The functions people reach for most, so `S` offers SUM before STDDEV_SAMP.
const FUNCTION_ORDER = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'ROUND', 'LOWER', 'UPPER', 'LENGTH', 'SUBSTR', 'CAST', 'CONCAT', 'TRIM', 'REPLACE', 'ABS',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'STRING_AGG', 'ARRAY_AGG', 'DATE_TRUNC', 'DATE_PART', 'STRFTIME', 'NULLIF', 'IFNULL', 'FLOOR', 'CEIL',
  'JSON_EXTRACT', 'MEDIAN', 'NOW', 'LEFT', 'RIGHT', 'SPLIT_PART', 'REGEXP_REPLACE', 'STDDEV', 'FIRST_VALUE', 'LAST_VALUE', 'NTILE', 'GREATEST', 'LEAST']
const order = (list) => new Map(list.map((name, i) => [name, i]))
const KEYWORD_RANK = order(KEYWORD_ORDER)
const FUNCTION_RANK = order(FUNCTION_ORDER)

// -- the completer ---------------------------------------------------------------------

const FUNCTION_ITEMS = [
  ...Object.keys(functions).sort().map((label) => ({ label, kind: 'function' })),
  ...Object.keys(aggregates).sort().map((label) => ({ label, kind: 'aggregate' })),
  ...[...windowFunctions].sort().map((label) => ({ label, kind: 'window' }))
]

const literal = (v) => (typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v))

/**
 * A function from SQL text and a cursor offset to suggestions, which also has
 * `.update(options)` to change what it knows (new data, more values) without
 * making a new one.
 *
 * @param {{
 *   data?: object,
 *   tables?: string[] | Record<string, Array<string | { name: string, type?: string, values?: any[] }>>,
 *   values?: Record<string, any[]>,
 *   functions?: string[],
 *   engine?: { sqlFunctions?: Iterable<string> },
 *   guessColumns?: boolean
 * }} [options]
 *   `data` is what you would pass to `query()`: tables, columns, types, and the values
 *   of columns that have only a few, are read from it. `tables` lists tables (and, as
 *   an object, their columns) you state yourself; for a table that is also in `data`
 *   it replaces the columns. `values` lists the values a column is compared with:
 *   `'table.column'` or just `column`. `functions` names custom scalar functions, and
 *   `engine` is the one from `createEngine` that you run queries with, so its functions need not be listed twice.
 *   A table's columns are suggested only while that table is in the statement (`FROM`/`JOIN`), so a
 *   select list written before its `FROM` gets none. `guessColumns: true` relaxes that, for typing left
 *   to right: with no `FROM` yet, it offers the columns of every table, and reads an undeclared
 *   alias as the table whose name it starts (`o.` as `orders`).
 */
export function createCompleter (options = {}) {
  let model = buildModel(options)

  const columnsFor = (name, scope) => {
    const key = [...model.tables.keys()].find((t) => t === name) ?? [...model.tables.keys()].find((t) => t.toLowerCase() === name.toLowerCase())
    if (key) return { table: key, columns: model.tables.get(key).columns }
    // A CTE or subquery has no known columns; there is nothing to offer for it.
    return scope.ctes.includes(name) ? { table: null, columns: [] } : null
  }

  /** Value suggestions for the column a comparison is about. */
  const valueItems = (compared, scope, quoted) => {
    if (!compared) return []
    const sources = compared.qualifier === null
      ? scope.sources
      : scope.sources.filter((s) => s.alias.toLowerCase() === compared.qualifier.toLowerCase())
    for (const s of sources) {
      const known = columnsFor(s.table, scope)
      if (!known?.table || !known.columns.some((c) => c.name === compared.name)) continue
      const list = valuesFor(model, known.table, compared.name)
      if (!list) continue
      // Inside a string only text fits, and what is inserted is the text itself.
      return list
        .filter((v) => !quoted || typeof v === 'string')
        .map((v) => ({ label: String(v), kind: 'value', detail: `${s.table}.${compared.name}`, insert: quoted ? String(v).replace(/'/g, "''") : literal(v) }))
    }
    return []
  }

  function complete (sql, cursor = sql.length) {
    cursor = Math.max(0, Math.min(cursor, sql.length))
    const place = locate(sql, cursor)
    let from = cursor
    let to = cursor
    let prefix
    if (place.kind === 'string') {
      from = place.start + 1
      to = place.end
      prefix = sql.slice(from, cursor).replace(/''/g, "'")
    } else {
      while (from > 0 && WORD.test(sql[from - 1])) from--
      // Replace the whole word under the cursor, not only the part before it.
      while (to < sql.length && WORD.test(sql[to])) to++
      prefix = sql.slice(from, cursor)
    }
    let context = { used: new Map(), aliasFirst: false, condition: false }
    const result = (items) => ({ from, to, prefix, items: rank(items, prefix, context) })
    if (place.kind === 'other') return result([])

    // What the statement names, for aliases and tables. (An unclosed string cannot be
    // tokenized, so then only the text before it is read.)
    const readUpTo = place.kind === 'string' ? place.start : from
    let tokens
    let head
    try {
      head = tokenize(sql.slice(0, readUpTo))
      try { tokens = tokenize(sql) } catch { tokens = head }
    } catch {
      return result([])
    }
    const scope = scopeOf(tokens, cursor)
    // Names already used in this statement are likelier than the rest; with several tables in play,
    // a qualifier is likelier than a bare column.
    const used = new Map()
    for (const t of tokens) {
      if (t.type !== 'Identifier' || (t.start < cursor && cursor <= t.end)) continue // (not the word being typed)
      const key = t.image.toLowerCase()
      used.set(key, (used.get(key) ?? 0) + 1)
    }
    context = { used, aliasFirst: scope.sources.length > 1, condition: inCondition(head) }

    // Inside a '...' string: a value of the column it is compared with, or nothing.
    if (place.kind === 'string') return result(valueItems(comparedColumn(head), scope, true))

    // What the parser would accept at the cursor.
    let expected
    let stack
    try {
      parseTokens([...head, { type: '$cursor', image: '', start: from, end: from }])
      return result([])
    } catch (e) {
      if (!e.expected || (e.token && e.token.type !== '$cursor')) return result([]) // a syntax error before the cursor
      expected = e.expected
      stack = e.ruleStack ?? []
    }

    const last = head[head.length - 1]
    const items = []

    // `alias.|`: the columns of that source.
    if (last?.type === 'Dot' && head[head.length - 2]?.type === 'Identifier') {
      const qualifier = head[head.length - 2].image
      const source = scope.sources.find((s) => s.alias === qualifier || s.alias.toLowerCase() === qualifier.toLowerCase())
      let known = columnsFor(source ? source.table : qualifier, scope)
      const columns = []
      if (known) columns.push(...known.columns)
      else if (model.guess) {
        // An alias not declared (yet): aliases are usually the start of the table's name, `o` for `orders`.
        const q = qualifier.toLowerCase()
        for (const [name, t] of model.tables) if (name.toLowerCase().startsWith(q)) columns.push(...t.columns)
      }
      for (const c of columns) items.push({ label: c.name, kind: 'column', detail: c.type ?? undefined })
      return result(items)
    }
    // `AS |` names something new.
    if (last?.type === 'As') return result([])

    // `Identifier` alone is a name being introduced (an implicit alias: `SELECT a b`); where an
    // expression can start, literals fit as well.
    const wantsName = expected.includes('Identifier')
    const wantsExpression = wantsName && (expected.includes('Number') || expected.includes('Null'))
    if (wantsName && stack.includes('FromItem') && tablePosition(head)) {
      for (const [label, t] of model.tables) items.push({ label, kind: 'table', detail: `${t.columns.length} columns` })
      for (const label of scope.ctes) items.push({ label, kind: 'table', detail: 'CTE' })
      for (const label of ['UNNEST', 'GENERATE_SERIES', 'JSON_EACH']) items.push({ label, kind: 'function' })
    } else if (wantsExpression) {
      const seen = new Set()
      // Before any FROM, the columns could be from any table: only a guess, so only when asked for.
      if (model.guess && !scope.sources.length) {
        for (const [table, t] of model.tables) {
          for (const c of t.columns) {
            if (!seen.has(c.name)) { seen.add(c.name); items.push({ label: c.name, kind: 'column', detail: c.type ?? table }) }
          }
        }
      }
      for (const s of scope.sources) {
        for (const c of columnsFor(s.table, scope)?.columns ?? []) {
          // A column two sources share has to be written with its alias.
          if (!seen.has(c.name)) { seen.add(c.name); items.push({ label: c.name, kind: 'column', detail: c.type ?? undefined }) }
        }
        items.push({ label: s.alias, kind: 'alias', detail: s.alias === s.table ? 'table' : s.table })
      }
      items.push(...valueItems(comparedColumn(head), scope, false))
      items.push(...FUNCTION_ITEMS, ...model.custom)
    }
    for (const type of expected) {
      const text = keywordOf(type)
      // Words that continue an expression come after the ones that start a clause.
      if (text) items.push({ label: text, kind: OPERATORS.has(type) ? 'operator' : 'keyword' })
    }
    return result(items)
  }

  /** Change what it knows. Anything given replaces the same option from before. */
  complete.update = (next = {}) => {
    options = { ...options, ...next }
    model = buildModel(options)
    return complete
  }
  return complete
}

/** One-off form: `complete(sql, cursor, { data })`. */
export function complete (sql, cursor, options) {
  return createCompleter(options)(sql, cursor)
}

// -- ranking ---------------------------------------------------------------------------

// Kinds, best first. Words that continue an expression share a rank with clause keywords, so
// AND and OR are ordered among them by KEYWORD_ORDER. (Values get a rank of their own: tied with
// another kind they would be ordered against it by label and against each other not at all,
// which is not a consistent order.)
const KIND_ORDER = { value: -1, column: 0, alias: 1, table: 1, function: 2, aggregate: 2, window: 2, keyword: 4, operator: 4 }
const ALIAS_FIRST = { ...KIND_ORDER, alias: -0.5 }

function rank (items, prefix, { used, aliasFirst, condition }) {
  const p = prefix.toLowerCase()
  const kinds = aliasFirst ? ALIAS_FIRST : KIND_ORDER
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = item.kind + ':' + item.label
    if (seen.has(key)) continue
    seen.add(key)
    const l = item.label.toLowerCase()
    const score = p === '' ? 1 : l.startsWith(p) ? 0 : l.includes(p) ? 2 : -1
    if (score < 0) continue
    // Within a kind: the likelier first. Names used earlier in the statement, the next clause
    // before the one after it, the common functions before the rare; values in the order given.
    let within
    switch (item.kind) {
      case 'column': case 'alias': case 'table': within = -(used.get(l) ?? 0); break
      case 'keyword': within = KEYWORD_RANK.get(item.label) ?? 1000; break
      // (Outside a condition AND and OR are not what comes next: IN, LIKE and the rest follow the clause words.)
      case 'operator': within = (KEYWORD_RANK.get(item.label) ?? 1000) + (condition ? 0 : 5000); break
      case 'function': case 'aggregate': case 'window': within = FUNCTION_RANK.get(item.label) ?? 1000; break
      default: within = 0
    }
    out.push({ item, score, kind: kinds[item.kind] ?? 9, within })
  }
  out.sort((a, b) => a.score - b.score || a.kind - b.kind || a.within - b.within ||
    (a.item.kind === 'value' && b.item.kind === 'value' ? 0 : a.item.label.localeCompare(b.item.label)))
  return out.map((x) => x.item)
}
