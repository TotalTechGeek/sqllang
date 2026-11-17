/**
 * Runs a plan from compile.js against data.
 *
 * Per-row work — every WHERE, ON, select-list and ORDER BY expression — is JSON
 * Logic built once by json-logic-engine. What JSON Logic cannot express (joins,
 * grouping, aggregation, windows, sorting, set operations) is this file.
 */

import { LogicEngine } from 'json-logic-engine'
import { operators, functions } from './functions.js'
import { aggregates } from './aggregates.js'
import { SqlError } from './errors.js'
import { enter, normalizeLimits, tick, rows as checkRows } from './guard.js'
import {
  isNull, isTrue, setKey, keyOf, rowKey, sortCompare, equals, toNumber, maybeJson, walk, isNumericString
} from './values.js'

// The run in progress. Execution is synchronous, so one slot is enough for the
// operators that need it (parameters, subqueries); nested runs save and restore it.
let active = null

const SYNC = Symbol.for('json_logic_sync')
const sync = (f) => { f[SYNC] = true; return f }

const internal = {
  // One output row from `[name, value, name, value, ...]`. Compiled, it is a single
  // object literal, so a whole select list costs one call per row. Not
  // deterministic: each row needs its own object, never a folded shared one.
  // A whole single-table scan as one function: [alias, where | null, row]. Compiled, the
  // loop, the filter and the projection are one piece of code, with the rows passed in
  // as `context.$scan`. Only used compiled; the interpreted path runs the loop itself.
  SCAN: {
    method: () => { throw new SqlError('SCAN runs compiled only') },
    compile: ([alias, where, row], bs) => {
      const skip = where === null ? bs.compile`` : bs.compile`if (!${sync(isTrue)}(${where})) continue;`
      return bs.compile`(() => { const rows = context["$scan"]; const out = []; for (let i = 0; i < rows.length; i++) { if ((i & 1023) === 0) ${sync(tick)}(Math.min(1024, rows.length - i)); context[${alias}] = rows[i]; ${skip} out.push(${row}) } return out })()`
    },
    traverse: false,
    deterministic: false
  },
  ROW: {
    method: (args) => {
      const out = {}
      for (let i = 0; i < args.length; i += 2) setKey(out, args[i], args[i + 1] === undefined ? null : args[i + 1])
      return out
    },
    compile: (args, bs) => {
      let res = bs.compile`({`
      for (let i = 0; i < args.length; i += 2) {
        res = bs.compile`${res}${i ? bs.compile`,` : bs.compile``}${args[i]}: (${args[i + 1]}) ?? null`
      }
      return bs.compile`${res}})`
    },
    deterministic: false
  },
  PARAM: {
    method: ([key]) => {
      const params = active?.params
      // Own keys only: `:constructor` must not find Object.prototype.constructor.
      const v = params == null || !Object.prototype.hasOwnProperty.call(params, key) ? undefined : params[key]
      if (v === undefined) throw new SqlError(`No value bound for parameter ${typeof key === 'number' ? key + 1 : ':' + key}`)
      return v
    },
    deterministic: false
  },
  SUBQUERY: {
    method: ([id], env) => {
      const { rows, columns } = runSubquery(id, env)
      if (!rows.length) return null
      return rows[0][columns[0]] ?? null
    },
    deterministic: false
  },
  EXISTS: {
    method: ([id], env) => runSubquery(id, env).rows.length > 0,
    deterministic: false
  },
  IN_SUB: {
    method: ([value, id], env) => {
      if (isNull(value)) return null
      const plan = active.plan.subqueries[id]
      // Uncorrelated: the subquery's values are the same for every row, so they
      // are hashed once and each row is a lookup instead of a scan.
      if (!plan.correlated) return inLookup(lookupFor(id), value)
      const { rows, columns } = runSubquery(id, env)
      return inScan(rows, columns[0], value)
    },
    deterministic: false
  },
  SERIES: {
    method: ([from, to, by = 1]) => {
      const a = toNumber(from); const b = toNumber(to); const s = toNumber(by)
      if (a === null || b === null || !s) return []
      checkRows(Math.floor((b - a) / s) + 1)
      const out = []
      if (s > 0) for (let x = a; x <= b; x += s) out.push(x)
      else for (let x = a; x >= b; x += s) out.push(x)
      return out
    },
    deterministic: true
  },
  ENTRIES: {
    method: ([v]) => {
      v = maybeJson(v)
      const out = []
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) out.push({ key: i, value: v[i] })
      } else if (v && typeof v === 'object') {
        const keys = Object.keys(v)
        for (let i = 0; i < keys.length; i++) out.push({ key: keys[i], value: v[keys[i]] })
      }
      return out
    },
    deterministic: true
  }
}

/**
 * An engine with the SQL operators and function library loaded.
 *
 * @param {{ functions?: Record<string, Function | object>, [k: string]: any }} [options]
 *   `functions` adds scalar functions, callable from SQL by name (case-insensitive).
 *   A plain function receives the evaluated arguments as an array.
 */
export function createEngine (options = {}) {
  const { functions: extra = {}, ...engineOptions } = options
  const engine = new LogicEngine(undefined, engineOptions)
  for (const [name, method] of Object.entries({ ...operators, ...functions, ...internal })) engine.addMethod(name, method)
  const names = new Set()
  for (const [name, method] of Object.entries(extra)) {
    const upper = name.toUpperCase()
    engine.addMethod(upper, typeof method === 'function' ? { method, deterministic: false } : method)
    names.add(upper)
  }
  engine.sqlFunctions = names
  return engine
}

export const defaultEngine = createEngine()

// -- running ---------------------------------------------------------------------

const caches = new WeakMap()

/**
 * Execute every statement of a compiled script.
 *
 * @returns {{ results: Array<{columns: string[], rows: object[]}>, tables: Map<string, object[]> }}
 */
export function executePlan (plan, data, options = {}) {
  const engine = options.engine ?? defaultEngine
  let cache = caches.get(engine)
  if (!cache) { cache = new WeakMap(); caches.set(engine, cache) }

  const state = {
    plan,
    engine,
    cache,
    interpreted: Boolean(options.interpreted),
    root: Array.isArray(data) ? { data } : (data ?? {}),
    params: options.params ?? null,
    tables: new Map(Object.entries(options.tables ?? {})),
    cteResults: new Map(),
    subqueryResults: new Map(),
    inLookups: new Map()
  }

  const previous = active
  active = state
  const leave = enter(normalizeLimits(options.limits))
  try {
    const results = []
    for (const statement of plan.statements) {
      if (statement.kind === 'insert') results.push(runInsert(statement, state))
      else results.push(runQuery(statement, state, null))
      // CTE results do not outlive their statement — a later INSERT may change their inputs.
      state.cteResults.clear()
      state.subqueryResults.clear()
      state.inLookups.clear()
    }
    return { results, tables: state.tables }
  } finally {
    leave()
    active = previous
  }
}

function fnOf (state, logic) {
  if (logic === null || typeof logic !== 'object') return () => logic
  let f = state.cache.get(logic)
  if (!f) {
    if (state.interpreted) {
      const engine = state.engine
      f = (env) => engine.run(logic, env)
    } else {
      f = state.engine.build(logic)
    }
    state.cache.set(logic, f)
  }
  return f
}

function inScan (rows, column, value) {
  let sawNull = false
  for (let i = 0; i < rows.length; i++) {
    const e = equals(value, rows[i][column])
    if (e) return true
    if (e === null) sawNull = true
  }
  return sawNull ? null : false
}

/**
 * The hashed form of an uncorrelated IN subquery, built once per run.
 *
 *   exact    every number and string, as is — most probes end here, hit or miss
 *   numeric  the numbers, plus the numeric reading of numeric strings, for the
 *            loose matches equals() allows (1 = '1', '1.0' = 1); only consulted
 *            when a cross-type match is possible at all
 *
 * Values hashing cannot place (dates, objects, booleans) fall back to a scan.
 */
function lookupFor (id) {
  const state = active
  let lookup = state.inLookups.get(id)
  if (lookup) return lookup
  const { rows, columns } = runSubquery(id, null)
  const column = columns[0]
  const exact = new Set()
  const numeric = new Map()
  let hasNull = false
  let hashable = true
  let hasNumbers = false
  let hasStrings = false
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i][column]
    if (v === null || v === undefined) { hasNull = true; continue }
    if (typeof v === 'number') { hasNumbers = true; exact.add(v); addNumeric(numeric, v, v); continue }
    if (typeof v !== 'string') { hashable = false; break }
    hasStrings = true
    exact.add(v)
    if (isNumericString(v)) addNumeric(numeric, Number(v), v)
  }
  lookup = hashable
    ? { exact, numeric, hasNull, hasNumbers, hasNumericStrings: hasStrings && numeric.size > 0 }
    : { rows, column }
  state.inLookups.set(id, lookup)
  return lookup
}

function addNumeric (map, n, v) {
  const list = map.get(n)
  if (list === undefined) map.set(n, [v])
  else list.push(v)
}

function inLookup (lookup, value) {
  if (lookup.exact === undefined) return inScan(lookup.rows, lookup.column, value)
  const miss = lookup.hasNull ? null : false
  if (typeof value === 'number') {
    if (lookup.exact.has(value)) return true
    // A number can still equal a numeric string: 1 = '1.0'.
    if (!lookup.hasNumericStrings) return miss
    return confirm(lookup.numeric.get(value), value) ? true : miss
  }
  if (typeof value === 'string') {
    if (lookup.exact.has(value)) return true
    // A string can only equal a number now ('1' = 1); strings compare as strings.
    if (!lookup.hasNumbers || !isNumericString(value)) return miss
    return confirm(lookup.numeric.get(Number(value)), value) ? true : miss
  }
  // A date or an object against numbers and strings: compare the slow way.
  for (const v of lookup.exact) if (equals(value, v)) return true
  return miss
}

function confirm (candidates, value) {
  if (candidates === undefined) return false
  for (let i = 0; i < candidates.length; i++) if (equals(value, candidates[i])) return true
  return false
}

function runSubquery (id, env) {
  const state = active
  const plan = state.plan.subqueries[id]
  if (!plan.correlated) {
    let hit = state.subqueryResults.get(id)
    if (!hit) { hit = runQuery(plan, state, null); state.subqueryResults.set(id, hit) }
    return hit
  }
  return runQuery(plan, state, env)
}

function runQuery (plan, state, outer) {
  tick()
  const limited = plan.limit !== null || plan.offset !== null
  const offset = plan.offset === null ? 0 : Math.max(0, toNumber(fnOf(state, plan.offset)({})) ?? 0)
  const limit = plan.limit === null ? Infinity : Math.max(0, toNumber(fnOf(state, plan.limit)({})) ?? 0)
  // ORDER BY ... LIMIT on a select only needs the first offset + limit rows in order.
  const keep = limited && plan.body.kind === 'select' && plan.body.orderBy && Number.isFinite(limit) ? offset + limit : null
  let result = runBody(plan.body, state, outer, keep)
  checkRows(result.rows.length)
  if (plan.orderBy) {
    const keys = plan.orderBy.map((o) => fnOf(state, o.expr))
    const { rows, columns } = result
    const decorated = new Array(rows.length)
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const env = { $out: row, $outv: valuesOf(row, columns) }
      const k = new Array(keys.length)
      for (let j = 0; j < keys.length; j++) k[j] = keys[j](env)
      decorated[i] = { row, keys: k }
    }
    sortDecorated(decorated, plan.orderBy)
    const sorted = new Array(decorated.length)
    for (let i = 0; i < decorated.length; i++) sorted[i] = decorated[i].row
    result = { columns, rows: sorted }
  }
  if (limited) result = { columns: result.columns, rows: result.rows.slice(offset, offset + limit) }
  return result
}

function runBody (body, state, outer, keep = null) {
  switch (body.kind) {
    case 'select': return runSelect(body, state, outer, keep)
    case 'query': return runQuery(body, state, outer)
    case 'values': return runValues(body, state, outer)
    case 'setop': return runSetOp(body, state, outer)
    default: throw new SqlError(`Unknown plan node ${body.kind}`)
  }
}

function runValues (body, state, outer) {
  const env = outer ? Object.create(outer) : {}
  const width = body.rows[0].length
  const columns = Array.from({ length: width }, (_, i) => `column${i + 1}`)
  const rows = new Array(body.rows.length)
  for (let i = 0; i < body.rows.length; i++) {
    const r = body.rows[i]
    if (r.length !== width) throw new SqlError('VALUES rows must all have the same number of columns')
    const row = {}
    for (let j = 0; j < r.length; j++) setKey(row, columns[j], nullish(fnOf(state, r[j])(env)))
    rows[i] = row
  }
  return { columns, rows }
}

function runSetOp (body, state, outer) {
  const left = runBody(body.left, state, outer)
  const right = runBody(body.right, state, outer)
  if (left.columns.length !== right.columns.length) {
    throw new SqlError(`${body.op} needs both sides to have the same number of columns (${left.columns.length} vs ${right.columns.length})`)
  }
  const columns = left.columns
  const toRow = (vals) => { const o = {}; for (let i = 0; i < columns.length; i++) setKey(o, columns[i], vals[i]); return o }
  const leftVals = new Array(left.rows.length)
  for (let i = 0; i < left.rows.length; i++) leftVals[i] = valuesOf(left.rows[i], columns)
  const rightVals = new Array(right.rows.length)
  for (let i = 0; i < right.rows.length; i++) rightVals[i] = valuesOf(right.rows[i], right.columns)

  let out
  if (body.op === 'UNION') {
    out = leftVals.concat(rightVals)
    if (!body.all) out = dedupe(out)
  } else {
    const counts = new Map()
    for (let i = 0; i < rightVals.length; i++) { const k = rowKey(rightVals[i]); counts.set(k, (counts.get(k) || 0) + 1) }
    const source = body.all ? leftVals : dedupe(leftVals)
    out = []
    for (let i = 0; i < source.length; i++) {
      const v = source[i]
      const k = rowKey(v)
      const n = counts.get(k) || 0
      if (body.op === 'INTERSECT' ? n > 0 : n === 0) out.push(v)
      if (body.all && n > 0) counts.set(k, n - 1)
    }
  }
  checkRows(out.length)
  const rows = new Array(out.length)
  for (let i = 0; i < out.length; i++) rows[i] = toRow(out[i])
  return { columns, rows }
}

function dedupe (rows) {
  if (!rows.length) return rows
  const add = tupleSet(rows[0].length)
  const out = []
  for (let i = 0; i < rows.length; i++) if (add(rows[i])) out.push(rows[i])
  return out
}

function valuesOf (row, columns) {
  const out = new Array(columns.length)
  for (let i = 0; i < columns.length; i++) out[i] = row[columns[i]]
  return out
}

function filterTrue (envs, fn) {
  const out = []
  for (let i = 0; i < envs.length; i++) {
    tick()
    if (isTrue(fn(envs[i]))) out.push(envs[i])
  }
  return out
}

// -- SELECT ------------------------------------------------------------------------

/**
 * A new context: `env` plus one more alias. `aliases` are the aliases `env`
 * already holds (the join step knows them), so nothing is enumerated per row.
 */
function extend (env, aliases, alias, row) {
  const proto = Object.getPrototypeOf(env)
  const e = proto === Object.prototype ? {} : Object.create(proto)
  for (let i = 0; i < aliases.length; i++) e[aliases[i]] = env[aliases[i]]
  e[alias] = row
  return e
}

function runSelect (p, state, outer, keep = null) {
  const base = outer ? Object.create(outer) : {}
  const projector = makeProjector(p, state)
  const orderFns = p.orderBy ? p.orderBy.map((o) => fnOf(state, o.expr)) : null
  // DISTINCT must see every row before the first k are known, so it sorts fully.
  const top = orderFns && keep !== null && !p.distinct ? topK(keep, comparatorFor(p.orderBy)) : null

  // `items` are { row, keys }: the projected row and its ORDER BY keys (or null).
  let items
  let plain = null // the projected rows themselves, when there is no ORDER BY
  const single = p.steps.length === 1 && p.steps[0].join === 'FROM' && !p.windows.length

  if (single && !p.grouped && p.having === null) {
    if (top !== null && !readsOutput(p.orderBy)) {
      // The keys come from the input row, so a row is only projected once it
      // has made the cut.
      const probe = { row: null, keys: null }
      streamRows(p, state, base, (env) => {
        const keys = new Array(orderFns.length)
        for (let k = 0; k < orderFns.length; k++) keys[k] = orderFns[k](env)
        probe.keys = keys
        if (!top.admits(probe)) return
        top.add({ row: projector.project(env), keys })
      })
      items = top.best
    } else if (orderFns === null) {
      // No ORDER BY: nothing needs the `{ row, keys }` wrapper, so keep the rows.
      plain = scanRows(p, state, base)
      if (plain === null) {
        plain = []
        streamRows(p, state, base, (env) => { plain.push(projector.project(env)) })
      }
    } else {
      items = []
      streamRows(p, state, base, (env) => {
        const row = projector.project(env)
        const item = { row, keys: orderKeys(p, env, row, projector, orderFns) }
        if (top !== null) { if (top.admits(item)) top.add(item) } else items.push(item)
      })
      if (top !== null) items = top.best
    }
  } else {
    let envs
    if (single && p.grouped) {
      envs = group(p, state, base, (visit) => streamRows(p, state, base, visit))
    } else {
      envs = [base]
      for (const step of p.steps) envs = joinStep(step, envs, base, state)
      if (p.where !== null) {
        const where = fnOf(state, p.where)
        envs = filterTrue(envs, where)
      }
      if (p.grouped) {
        const rows = envs
        envs = group(p, state, base, (visit) => { for (let i = 0; i < rows.length; i++) { tick(); visit(rows[i], false) } })
      }
    }

    if (p.having !== null) {
      const having = fnOf(state, p.having)
      envs = filterTrue(envs, having)
    }

    if (p.windows.length) computeWindows(p.windows, envs, state)

    items = top !== null ? null : new Array(envs.length)
    for (let i = 0; i < envs.length; i++) {
      tick()
      const env = envs[i]
      const row = projector.project(env)
      const item = { row, keys: orderFns ? orderKeys(p, env, row, projector, orderFns) : null }
      if (top !== null) { if (top.admits(item)) top.add(item) } else items[i] = item
    }
    if (top !== null) items = top.best
  }

  const columns = projector.columns
  if (plain !== null) {
    if (projector.hasStar) for (let i = 0; i < plain.length; i++) plain[i] = padRow(plain[i], columns)
    if (p.distinct) {
      const add = tupleSet(columns.length)
      plain = plain.filter((row) => add(valuesOf(row, columns)))
    }
    return { columns, rows: plain }
  }
  if (projector.hasStar) {
    // With `*` over rows of differing shape, give every row every column.
    for (let i = 0; i < items.length; i++) {
      const o = items[i].row
      items[i].row = padRow(o, columns)
    }
  }

  if (p.distinct) {
    const add = tupleSet(columns.length)
    const kept = []
    for (let i = 0; i < items.length; i++) if (add(valuesOf(items[i].row, columns))) kept.push(items[i])
    items = kept
  }

  // A top-k collector already holds its rows in order.
  if (orderFns && top === null) sortDecorated(items, p.orderBy)
  const rows = new Array(items.length)
  for (let i = 0; i < items.length; i++) rows[i] = items[i].row
  return { columns, rows }
}

/**
 * One table and no windows: the common case, and the one where per-row
 * allocation shows most. Rows that pass WHERE stream through a single reused
 * context object; `visit(env, true)` must copy anything it keeps.
 */
function sourceRows (p, state, base) {
  const source = p.steps[0].source
  return source.kind === 'expr' ? toRows(fnOf(state, source.expr)(base), false) : materialize(source, state)
}

const scanLogics = new WeakMap()

/** The projected rows of a one-table scan, run as one compiled function; null when it cannot be. */
function scanRows (p, state, base) {
  if (state.interpreted || !p.row) return null
  let logic = scanLogics.get(p)
  if (!logic) scanLogics.set(p, logic = { SCAN: [p.steps[0].alias, p.where, p.row] })
  const env = snapshot(base)
  env.$scan = sourceRows(p, state, base)
  return fnOf(state, logic)(env)
}

function streamRows (p, state, base, visit) {
  const step = p.steps[0]
  const alias = step.alias
  const rows = sourceRows(p, state, base)
  const where = p.where === null ? null : fnOf(state, p.where)
  const env = snapshot(base)
  for (let i = 0; i < rows.length; i++) {
    if ((i & 1023) === 0) tick(Math.min(1024, rows.length - i))
    env[alias] = rows[i]
    if (where !== null && !isTrue(where(env))) continue
    visit(env, true)
  }
}

function orderKeys (p, env, row, projector, orderFns) {
  env.$out = row
  if (p.needsOutv) env.$outv = valuesOf(row, projector.columns)
  const keys = new Array(orderFns.length)
  for (let k = 0; k < orderFns.length; k++) keys[k] = orderFns[k](env)
  return keys
}

/** Builds output rows from contexts, and collects the column list as it goes. */
function makeProjector (p, state) {
  const cols = p.columns
  const exprFns = cols.map((c) => (c.kind === 'expr' ? fnOf(state, c.expr) : null))
  const hasStar = cols.some((c) => c.kind === 'star')
  const columnSet = new Set()
  const columns = []
  const addColumn = (name) => { if (!columnSet.has(name)) { columnSet.add(name); columns.push(name) } }
  if (!hasStar) for (const c of cols) addColumn(c.name)
  // Names are fixed per query; only `__proto__` needs the careful path.
  const plain = cols.map((c) => c.kind === 'expr' && c.name !== '__proto__')

  // No `*` and no `__proto__`: the whole select list is one compiled object literal.
  const rowFn = !hasStar && p.row ? fnOf(state, p.row) : null

  const project = rowFn ?? ((env) => {
    const out = {}
    for (let j = 0; j < cols.length; j++) {
      const c = cols[j]
      if (c.kind === 'expr') {
        const v = exprFns[j](env)
        if (plain[j]) out[c.name] = v === undefined ? null : v
        else setKey(out, c.name, nullish(v))
        continue
      }
      for (let a = 0; a < c.aliases.length; a++) {
        const alias = c.aliases[a]
        const row = env[alias]
        if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
          const keys = Object.keys(row)
          if (c.aliases.length === 1) {
            // One table: its keys cannot collide with each other.
            for (let k = 0; k < keys.length; k++) {
              const key = keys[k]
              const v = row[key]
              if (key === '__proto__') setKey(out, key, nullish(v))
              else out[key] = v === undefined ? null : v
            }
            continue
          }
          for (let k = 0; k < keys.length; k++) {
            const key = keys[k]
            const name = Object.prototype.hasOwnProperty.call(out, key) ? `${alias}.${key}` : key
            setKey(out, name, nullish(row[key]))
          }
        } else if (row !== undefined && row !== null) {
          // (A NULL row is the missing side of an outer join: no columns to add.)
          // A plain value (UNNEST of numbers) is the column `value`.
          out[Object.prototype.hasOwnProperty.call(out, 'value') ? `${alias}.value` : 'value'] = nullish(row)
        }
      }
    }
    if (hasStar) for (const k in out) if (!columnSet.has(k)) addColumn(k)
    return out
  })
  return { project, columns, hasStar }
}

const comparators = new WeakMap()

/**
 * A comparator for `{ keys }` items under an ORDER BY, built once per ORDER BY.
 * Numbers against numbers and strings against strings — nearly every
 * comparison — never reach the general compare(). NULL placement is not
 * flipped by DESC; NULLS FIRST defaults to DESC, as in Postgres.
 */
function comparatorFor (orderBy) {
  let cmp = comparators.get(orderBy)
  if (cmp) return cmp
  const n = orderBy.length
  const desc = orderBy.map((o) => o.desc)
  const nullsFirst = orderBy.map((o) => o.nullsFirst ?? o.desc)
  cmp = (a, b) => {
    const ka = a.keys; const kb = b.keys
    for (let i = 0; i < n; i++) {
      const x = ka[i]; const y = kb[i]
      let c
      if ((typeof x === 'number' && typeof y === 'number') || (typeof x === 'string' && typeof y === 'string')) {
        c = x < y ? -1 : x > y ? 1 : 0
      } else {
        const xn = x === null || x === undefined
        const yn = y === null || y === undefined
        if (xn || yn) {
          if (xn && yn) continue
          return xn ? (nullsFirst[i] ? -1 : 1) : (nullsFirst[i] ? 1 : -1)
        }
        c = sortCompare(x, y, false, null)
      }
      if (c !== 0) return desc[i] ? -c : c
    }
    return 0
  }
  comparators.set(orderBy, cmp)
  return cmp
}

function sortDecorated (decorated, orderBy) {
  // One numeric key with no NULLs (the usual window ORDER BY): plain subtraction.
  if (orderBy.length === 1 && decorated.length > 16) {
    let numeric = true
    for (let i = 0; i < decorated.length; i++) {
      const k = decorated[i].keys[0]
      if (typeof k !== 'number' || k !== k) { numeric = false; break }
    }
    if (numeric) {
      decorated.sort(orderBy[0].desc ? (a, b) => b.keys[0] - a.keys[0] : (a, b) => a.keys[0] - b.keys[0])
      return
    }
  }
  decorated.sort(comparatorFor(orderBy))
}

/**
 * Keeps the k smallest items under `cmp`, in order, as they stream past —
 * O(n log k) instead of sorting everything for ORDER BY ... LIMIT k. An item
 * lands after any it ties with, so the result matches a stable sort.
 */
function topK (k, cmp) {
  const best = []
  return {
    best,
    /** Would this item make the cut? (Ask before paying to build it.) */
    admits (item) { return k > 0 && (best.length < k || cmp(item, best[best.length - 1]) < 0) },
    add (item) {
      let lo = 0; let hi = best.length
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cmp(item, best[mid]) < 0) hi = mid; else lo = mid + 1 }
      if (lo >= k) return
      best.splice(lo, 0, item)
      if (best.length > k) best.pop()
    }
  }
}

/** A set of value tuples in nested Maps — no key strings built per row. */
function tupleSet (width) {
  const root = new Map()
  const last = width - 1
  /** Adds the tuple; returns false if it was already present. */
  return (values) => {
    if (width === 0) { if (root.has(true)) return false; root.set(true, true); return true }
    let level = root
    for (let d = 0; d < last; d++) {
      const k = groupKey(values[d])
      let next = level.get(k)
      if (next === undefined) { next = new Map(); level.set(k, next) }
      level = next
    }
    const k = groupKey(values[last])
    if (level.has(k)) return false
    level.set(k, true)
    return true
  }
}

const outRefs = new WeakMap()

/** Does this ORDER BY read the projected row ($out / $outv)? */
function readsOutput (orderBy) {
  let r = outRefs.get(orderBy)
  if (r === undefined) {
    const visit = (l) => {
      if (l === null || typeof l !== 'object') return false
      if (Array.isArray(l)) return l.some(visit)
      if (Array.isArray(l.val) && (l.val[0] === '$out' || l.val[0] === '$outv')) return true
      return visit(l[Object.keys(l)[0]])
    }
    r = orderBy.some((o) => visit(o.expr))
    outRefs.set(orderBy, r)
  }
  return r
}

const nullish = (v) => (v === undefined ? null : v)
/** `o` with every column present, in column order (the row itself when it already is). */
function padRow (o, columns) {
  if (sameKeys(o, columns)) return o
  const r = {}
  for (let j = 0; j < columns.length; j++) {
    const c = columns[j]
    setKey(r, c, Object.prototype.hasOwnProperty.call(o, c) ? o[c] : null)
  }
  return r
}

/** Whether `o` has exactly `columns`, in that order: it needs no padding. */
function sameKeys (o, columns) {
  const keys = Object.keys(o)
  if (keys.length !== columns.length) return false
  for (let i = 0; i < keys.length; i++) if (keys[i] !== columns[i]) return false
  return true
}

// -- FROM and JOIN --------------------------------------------------------------------

function joinStep (step, envs, base, state) {
  const { alias, source, join, leftAliases } = step
  const lateral = source.kind === 'expr'
  const sourceFn = lateral ? fnOf(state, source.expr) : null
  let right = lateral ? null : materialize(source, state)
  if (step.filter) {
    const keep = fnOf(state, step.filter)
    const e = snapshot(base)
    const kept = []
    for (let j = 0; j < right.length; j++) {
      tick()
      e[alias] = right[j]
      if (isTrue(keep(e))) kept.push(right[j])
    }
    right = kept
  }
  const on = step.on === null ? null : fnOf(state, step.on)
  const out = []

  if (join === 'FROM' || join === 'CROSS') {
    for (let i = 0; i < envs.length; i++) {
      const env = envs[i]
      const rows = lateral ? toRows(sourceFn(env), false) : right
      for (let j = 0; j < rows.length; j++) {
        tick()
        const e = extend(env, leftAliases, alias, rows[j])
        if (on !== null && !isTrue(on(e))) continue
        out.push(e)
        checkRows(out.length)
      }
    }
    return out
  }

  if (step.hash) return hashJoin(step, envs, right, base, on, state)

  if (join === 'INNER' || join === 'LEFT') {
    for (let i = 0; i < envs.length; i++) {
      const env = envs[i]
      const rows = lateral ? toRows(sourceFn(env), false) : right
      let matched = false
      for (let j = 0; j < rows.length; j++) {
        tick()
        const e = extend(env, leftAliases, alias, rows[j])
        if (on === null || isTrue(on(e))) { out.push(e); matched = true; checkRows(out.length) }
      }
      if (!matched && join === 'LEFT') out.push(extend(env, leftAliases, alias, null))
    }
    checkRows(out.length)
    return out
  }

  // RIGHT and FULL: track which right rows found a partner.
  if (lateral) throw new SqlError(`${join} JOIN cannot be lateral`)
  const rows = right
  const matchedRight = new Uint8Array(rows.length)
  for (let i = 0; i < envs.length; i++) {
    const env = envs[i]
    let matched = false
    for (let j = 0; j < rows.length; j++) {
      tick()
      const e = extend(env, leftAliases, alias, rows[j])
      if (on === null || isTrue(on(e))) { out.push(e); matched = true; matchedRight[j] = 1; checkRows(out.length) }
    }
    if (!matched && join === 'FULL') out.push(extend(env, leftAliases, alias, null))
  }
  const nullLeft = nullEnv(base, leftAliases)
  for (let j = 0; j < rows.length; j++) if (!matchedRight[j]) out.push(extend(nullLeft, leftAliases, alias, rows[j]))
  checkRows(out.length)
  return out
}

function nullEnv (base, aliases) {
  const e = Object.create(Object.getPrototypeOf(base))
  for (let i = 0; i < aliases.length; i++) e[aliases[i]] = null
  return e
}

/**
 * Single-column equi-join. Matching follows equals(), so 1 = '1' and
 * '1.0' = 1 still join, but the common case is one Map lookup on the raw value:
 *
 *   exact    raw value -> right rows (numbers, strings, keyOf for the rest)
 *   numeric  numeric reading -> right rows whose value is a number or a numeric
 *            string, consulted only for a cross-type match (number vs string)
 *
 * Within one left row, matches come out in right-table order, as a scan would give.
 */
function hashJoin1 (step, envs, right, base, on, state) {
  const { alias, join, leftAliases } = step
  const rightKey = fnOf(state, step.hash.right[0])
  const leftKey = fnOf(state, step.hash.left[0])
  const exact = new Map()
  const numeric = new Map()
  let rightNumbers = false
  let rightNumericStrings = false
  const probe = snapshot(base)
  for (let i = 0; i < right.length; i++) {
    tick()
    probe[alias] = right[i]
    const v = rightKey(probe)
    if (v === null || v === undefined) continue
    const entry = { i, row: right[i], v }
    const k = groupKey(v)
    const bucket = exact.get(k)
    if (bucket === undefined) exact.set(k, [entry])
    else bucket.push(entry)
    let n = null
    if (typeof v === 'number') { rightNumbers = true; n = v } else if (typeof v === 'string' && isNumericString(v)) { rightNumericStrings = true; n = Number(v) }
    if (n !== null) {
      const list = numeric.get(n)
      if (list === undefined) numeric.set(n, [entry])
      else list.push(entry)
    }
  }
  const out = []
  for (let i = 0; i < envs.length; i++) {
    const env = envs[i]
    const v = leftKey(env)
    let matched = false
    if (v !== null && v !== undefined) {
      let candidates = exact.get(groupKey(v))
      // Same-type matches are exact; a cross-type one needs the numeric map.
      let cross
      if (typeof v === 'number' && rightNumericStrings) cross = numeric.get(v)
      else if (typeof v === 'string' && rightNumbers && isNumericString(v)) cross = numeric.get(Number(v))
      else if (typeof v === 'object' || typeof v === 'boolean') candidates = undefined
      if (cross !== undefined) {
        const extra = []
        for (let c = 0; c < cross.length; c++) if (typeof cross[c].v !== typeof v && equals(v, cross[c].v)) extra.push(cross[c])
        if (extra.length) candidates = candidates === undefined ? extra : candidates.concat(extra).sort((x, y) => x.i - y.i)
      }
      if (candidates === undefined && (typeof v === 'object' || typeof v === 'boolean')) {
        // Dates, objects, booleans: no shortcut — compare against every key.
        candidates = []
        for (const bucket of exact.values()) for (let c = 0; c < bucket.length; c++) if (equals(v, bucket[c].v)) candidates.push(bucket[c])
        candidates.sort((x, y) => x.i - y.i)
      }
      if (candidates !== undefined) {
        for (let c = 0; c < candidates.length; c++) {
          tick()
          const e = extend(env, leftAliases, alias, candidates[c].row)
          if (on === null || isTrue(on(e))) { out.push(e); matched = true; checkRows(out.length) }
        }
      }
    }
    if (!matched && join === 'LEFT') out.push(extend(env, leftAliases, alias, null))
  }
  return out
}

/** Equality-keyed join. Buckets are coarse (1 and '1' share one); EQ confirms. */
function hashJoin (step, envs, right, base, on, state) {
  if (step.hash.right.length === 1) return hashJoin1(step, envs, right, base, on, state)
  const { alias, join, leftAliases } = step
  const rightKeys = step.hash.right.map((l) => fnOf(state, l))
  const leftKeys = step.hash.left.map((l) => fnOf(state, l))
  const width = rightKeys.length
  const buckets = new Map()
  // Right-side keys are evaluated against one reused context.
  const probe = snapshot(base)
  for (let i = 0; i < right.length; i++) {
    tick()
    const row = right[i]
    probe[alias] = row
    const values = new Array(width)
    for (let k = 0; k < width; k++) values[k] = rightKeys[k](probe)
    const key = hashKey(values)
    if (key === null) continue
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [{ row, values }])
    else bucket.push({ row, values })
  }
  const out = []
  const values = new Array(width)
  for (let i = 0; i < envs.length; i++) {
    const env = envs[i]
    for (let k = 0; k < width; k++) values[k] = leftKeys[k](env)
    const key = hashKey(values)
    let matched = false
    const bucket = key === null ? undefined : buckets.get(key)
    if (bucket !== undefined) {
      for (let b = 0; b < bucket.length; b++) {
        tick()
        const candidate = bucket[b]
        let same = true
        for (let k = 0; k < width; k++) if (equals(values[k], candidate.values[k]) !== true) { same = false; break }
        if (!same) continue
        const e = extend(env, leftAliases, alias, candidate.row)
        if (on === null || isTrue(on(e))) { out.push(e); matched = true; checkRows(out.length) }
      }
    }
    if (!matched && join === 'LEFT') out.push(extend(env, leftAliases, alias, null))
  }
  return out
}

function hashKey (values) {
  let key = ''
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v === null || v === undefined) return null
    if (typeof v === 'number') key += 'n' + v
    else if (isNumericString(v)) key += 'n' + Number(v)
    else key += keyOf(v)
    key += '\u0000'
  }
  return key
}

function materialize (source, state) {
  switch (source.kind) {
    case 'table': return toRows(resolveTable(source.path, state), true)
    case 'cte': {
      let rows = state.cteResults.get(source.id)
      if (!rows) {
        rows = runQuery(state.plan.ctes[source.id].plan, state, null).rows
        state.cteResults.set(source.id, rows)
      }
      return rows
    }
    case 'subquery': return runQuery(source.plan, state, null).rows
    default: throw new SqlError(`Unknown source ${source.kind}`)
  }
}

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k)

/**
 * A table name is a path into the data, or a table created by INSERT. Keys may
 * themselves contain dots (`analytics.events`), so the longest matching
 * prefix wins: `a.b.c` tries the key `a.b.c`, then `a.b` + `.c`, then `a` + `.b.c`.
 */
function resolveTable (path, state) {
  for (let i = path.length; i >= 1; i--) {
    const head = path.slice(0, i)
    if (head.some((s) => typeof s !== 'string')) continue
    const key = head.join('.')
    if (state.tables.has(key)) return walk(state.tables.get(key), path, i)
    if (own(state.root, key)) return walk(state.root[key], path, i)
  }
  // Fall back to a case-insensitive match on the first segment.
  const first = String(path[0]).toLowerCase()
  for (const key of state.tables.keys()) if (key.toLowerCase() === first) return walk(state.tables.get(key), path, 1)
  for (const key of Object.keys(state.root)) if (key.toLowerCase() === first) return walk(state.root[key], path, 1)
  throw new SqlError(`Unknown table '${path.join('.')}'`)
}

/**
 * The rows a value stands for. An array is its elements; an object is one row.
 * For a table (`shapes`), two more layouts are recognised:
 *   - columnar: `{ id: [1, 2], name: ['a', 'b'] }` — every value an array, same length
 *   - header row: `[['id', 'name'], [1, 'a'], [2, 'b']]`
 */
export function toRows (value, shapes) {
  value = maybeJson(value)
  if (isNull(value)) return []
  if (Array.isArray(value)) {
    if (shapes && value.length > 1 && value.every(Array.isArray) && value[0].length && value[0].every((h) => typeof h === 'string')) {
      const header = value[0]
      const rows = new Array(value.length - 1)
      for (let i = 1; i < value.length; i++) {
        const r = value[i]
        const o = {}
        for (let j = 0; j < header.length; j++) setKey(o, header[j], r[j] === undefined ? null : r[j])
        rows[i - 1] = o
      }
      return rows
    }
    return value
  }
  if (typeof value === 'object' && shapes) {
    const keys = Object.keys(value)
    if (keys.length > 1 && keys.every((k) => Array.isArray(value[k]))) {
      const n = value[keys[0]].length
      if (keys.every((k) => value[k].length === n)) {
        const rows = new Array(n)
        const cols = new Array(keys.length)
        for (let k = 0; k < keys.length; k++) cols[k] = value[keys[k]]
        for (let i = 0; i < n; i++) {
          const o = {}
          for (let k = 0; k < keys.length; k++) setKey(o, keys[k], cols[k][i])
          rows[i] = o
        }
        return rows
      }
    }
  }
  return [value]
}

// -- GROUP BY and aggregates ---------------------------------------------------------------

// Aggregates are fed one row at a time, so grouping never holds on to rows:
// COUNT/SUM/AVG/MIN/MAX keep running totals, the rest collect their argument
// values, and a group keeps only its first row (for the non-aggregated columns).

const INCREMENTAL = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])
const COUNT = 0; const SUM = 1; const AVG = 2; const MIN = 3; const MAX = 4
const KIND = { COUNT, SUM, AVG, MIN, MAX }

function makeAggregators (p, state) {
  return p.aggregates.map((spec) => {
    const impl = aggregates[spec.name]
    return {
      spec,
      impl,
      args: spec.args.map((a) => fnOf(state, a)),
      filter: spec.filter === null ? null : fnOf(state, spec.filter),
      order: spec.orderBy ? spec.orderBy.map((o) => fnOf(state, o.expr)) : null,
      arity: impl.pairs ? 2 : (impl.arity ?? 1),
      incremental: INCREMENTAL.has(spec.name) && !spec.distinct && !spec.orderBy,
      kind: KIND[spec.name] ?? -1
    }
  })
}

const newAccumulator = (a) => (a.incremental ? { count: 0, sum: 0, numeric: 0, best: null } : { values: [], extra: null })

function accumulate (a, acc, env) {
  if (a.filter !== null && !isTrue(a.filter(env))) return
  if (a.incremental) {
    if (a.spec.star) { acc.count++; return }
    const v = a.args[0](env)
    if (v === null || v === undefined) return
    acc.count++
    switch (a.kind) {
      case SUM: case AVG: {
        const x = typeof v === 'number' ? v : toNumber(v)
        if (x !== null) { acc.sum += x; acc.numeric++ }
        return
      }
      case MIN:
        if (acc.best === null || (typeof v === 'number' && typeof acc.best === 'number' ? v < acc.best : sortCompare(v, acc.best, false, null) < 0)) acc.best = v
        return
      case MAX:
        if (acc.best === null || (typeof v === 'number' && typeof acc.best === 'number' ? v > acc.best : sortCompare(v, acc.best, false, null) > 0)) acc.best = v
    }
    return
  }
  // Constant extra arguments (STRING_AGG's separator) come from the first row.
  if (acc.extra === null) {
    acc.extra = []
    for (let i = a.arity; i < a.args.length; i++) acc.extra.push(a.args[i](env))
  }
  let v
  if (a.spec.star) v = 1
  else if (a.impl.pairs) v = [a.args[0](env), a.args[1](env)]
  else {
    v = a.args[0](env)
    if ((v === null || v === undefined) && !a.impl.keepNulls) return
    if (v === undefined) v = null
  }
  if (a.order === null) { acc.values.push(v); return }
  const keys = new Array(a.order.length)
  for (let i = 0; i < a.order.length; i++) keys[i] = a.order[i](env)
  acc.values.push({ v, keys })
}

function finish (a, acc) {
  if (a.incremental) {
    switch (a.kind) {
      case COUNT: return acc.count
      case SUM: return acc.numeric ? acc.sum : null
      case AVG: return acc.numeric ? acc.sum / acc.numeric : null
      default: return acc.best
    }
  }
  let list = acc.values
  if (a.order !== null) {
    sortDecorated(list, a.spec.orderBy)
    const plain = new Array(list.length)
    for (let i = 0; i < list.length; i++) plain[i] = list[i].v
    list = plain
  }
  if (a.spec.distinct) list = distinctValues(list)
  let extra = acc.extra
  if (extra === null) {
    extra = []
    for (let i = a.arity; i < a.args.length; i++) extra.push(a.args[i]({}))
  }
  return nullish(a.impl.reduce(list, ...extra))
}

function distinctValues (list) {
  const seen = new Set()
  const out = []
  for (let i = 0; i < list.length; i++) {
    const k = keyOf(list[i])
    if (!seen.has(k)) { seen.add(k); out.push(list[i]) }
  }
  return out
}

function snapshot (env) {
  const proto = Object.getPrototypeOf(env)
  const e = proto === Object.prototype ? {} : Object.create(proto)
  for (const k in env) if (Object.prototype.hasOwnProperty.call(env, k)) e[k] = env[k]
  return e
}

function newAccumulators (aggs) {
  const accs = new Array(aggs.length)
  for (let i = 0; i < aggs.length; i++) accs[i] = newAccumulator(aggs[i])
  return accs
}

/**
 * GROUP BY over rows produced by `each(visit)`. `visit(env, reused)`: when the
 * producer reuses one context object, a new group copies it.
 */
/**
 * A grouping key part as a Map key. Primitives are their own keys — Map's
 * SameValueZero already keeps 1 and '1' apart, as keyOf does — so the common
 * case builds no string at all; anything else (dates, objects) goes through keyOf.
 */
function groupKey (v) {
  if (v === undefined) return null
  if (v !== null && typeof v === 'object') return keyOf(v)
  return v
}

/**
 * GROUP BY over rows produced by `each(visit)`. `visit(env, reused)`: when the
 * producer reuses one context object, a new group copies it.
 *
 * Groups live in nested Maps, one level per GROUP BY expression, so a
 * multi-column key is a chain of lookups rather than a concatenated string.
 */
function group (p, state, base, each) {
  const keyFns = (p.groupBy ?? []).map((g) => fnOf(state, g))
  const aggs = makeAggregators(p, state)
  const depth = keyFns.length
  const root = new Map()
  const list = []

  const open = (env, reused) => {
    const g = { first: reused ? snapshot(env) : env, accs: newAccumulators(aggs) }
    list.push(g)
    checkRows(list.length)
    return g
  }

  if (depth === 0) {
    let g = null
    // (Row producers tick; the visitors here do not tick again.)
    each((env, reused) => {
      if (g === null) g = open(env, reused)
      for (let i = 0; i < aggs.length; i++) accumulate(aggs[i], g.accs[i], env)
    })
    // An aggregate over no rows at all still produces one row: SELECT COUNT(*) FROM empty.
    if (g === null) list.push({ first: base, accs: newAccumulators(aggs) })
  } else {
    const last = depth - 1
    each((env, reused) => {
      let level = root
      for (let d = 0; d < last; d++) {
        const k = groupKey(keyFns[d](env))
        let next = level.get(k)
        if (next === undefined) { next = new Map(); level.set(k, next) }
        level = next
      }
      const k = groupKey(keyFns[last](env))
      let g = level.get(k)
      if (g === undefined) { g = open(env, reused); level.set(k, g) }
      for (let i = 0; i < aggs.length; i++) accumulate(aggs[i], g.accs[i], env)
    })
  }

  const out = new Array(list.length)
  for (let gi = 0; gi < list.length; gi++) {
    const g = list[gi]
    const env = snapshot(g.first)
    const results = new Array(aggs.length)
    for (let i = 0; i < aggs.length; i++) results[i] = finish(aggs[i], g.accs[i])
    env.$agg = results
    out[gi] = env
  }
  return out
}

function reduceValues (spec, impl, args, rows) {
  const values = []
  const arity = impl.pairs ? 2 : (impl.arity ?? 1)
  for (let i = 0; i < rows.length; i++) {
    const env = rows[i]
    if (impl.pairs) {
      values.push([args[0](env), args[1](env)])
      continue
    }
    const v = args[0](env)
    if (isNull(v) && !impl.keepNulls) continue
    values.push(v === undefined ? null : v)
  }
  const list = spec.distinct ? distinctValues(values) : values
  const extra = []
  for (let i = arity; i < args.length; i++) extra.push(rows.length ? args[i](rows[0]) : args[i]({}))
  return nullish(impl.reduce(list, ...extra))
}

// -- window functions ------------------------------------------------------------------------

function computeWindows (windows, envs, state) {
  for (let i = 0; i < envs.length; i++) envs[i].$win = new Array(windows.length)
  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi]
    const partFns = w.partitionBy.map((p) => fnOf(state, p))
    const orderFns = w.orderBy.map((o) => fnOf(state, o.expr))
    const argFns = w.args.map((a) => fnOf(state, a))
    // Partitions in nested Maps, one level per PARTITION BY expression.
    const root = new Map()
    const parts = []
    const last = partFns.length - 1
    for (let i = 0; i < envs.length; i++) {
      tick()
      const env = envs[i]
      let part
      if (last < 0) {
        part = parts[0]
        if (part === undefined) { part = []; parts.push(part) }
      } else {
        let level = root
        for (let d = 0; d < last; d++) {
          const k = groupKey(partFns[d](env))
          let next = level.get(k)
          if (next === undefined) { next = new Map(); level.set(k, next) }
          level = next
        }
        const k = groupKey(partFns[last](env))
        part = level.get(k)
        if (part === undefined) { part = []; level.set(k, part); parts.push(part) }
      }
      const keys = new Array(orderFns.length)
      for (let j = 0; j < orderFns.length; j++) keys[j] = orderFns[j](env)
      part.push({ env, keys })
    }
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi]
      if (orderFns.length) sortDecorated(part, w.orderBy)
      windowPartition(w, wi, part, argFns, orderFns.length > 0)
    }
  }
}

function samePeers (a, b) {
  for (let j = 0; j < a.length; j++) if (sortCompare(a[j], b[j], false, null) !== 0) return false
  return true
}

function peerGroups (part, ordered) {
  // Rows with equal ORDER BY keys are peers: they share a rank and a frame end.
  const starts = []
  const ends = []
  if (!ordered) { starts.push(0); ends.push(part.length); return { starts, ends } }
  let start = 0
  for (let i = 1; i <= part.length; i++) {
    if (i === part.length || !samePeers(part[i].keys, part[start].keys)) {
      starts.push(start)
      ends.push(i)
      start = i
    }
  }
  return { starts, ends }
}

const INCREMENTAL_WINDOW = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])

function windowPartition (w, wi, part, argFns, ordered) {
  const n = part.length
  const set = (i, v) => { part[i].env.$win[wi] = v === undefined ? null : v }
  const arg = (i, k) => argFns[k](part[i].env)
  // Peer groups as parallel start/end arrays: rows [starts[g], ends[g]) are peers.
  const { starts, ends } = peerGroups(part, ordered)
  const groupCount = starts.length

  if (w.aggregate) {
    // The default frame: the whole partition without ORDER BY, otherwise
    // everything up to and including the current row's peers.
    if (INCREMENTAL_WINDOW.has(w.name) && !w.distinct) {
      let count = 0; let sum = 0; let numeric = 0; let best = null
      for (let g = 0; g < groupCount; g++) {
        const s = starts[g]; const e = ends[g]
        for (let i = s; i < e; i++) {
          if (w.star) { count++; continue }
          const v = arg(i, 0)
          if (v === null || v === undefined) continue
          count++
          const x = typeof v === 'number' ? v : toNumber(v)
          if (x !== null) { sum += x; numeric++ }
          if (w.name === 'MIN' && (best === null || sortCompare(v, best, false, null) < 0)) best = v
          else if (w.name === 'MAX' && (best === null || sortCompare(v, best, false, null) > 0)) best = v
        }
        const value = w.name === 'COUNT'
          ? count
          : w.name === 'SUM'
            ? (numeric ? sum : null)
            : w.name === 'AVG' ? (numeric ? sum / numeric : null) : best
        for (let i = s; i < e; i++) set(i, value)
      }
      return
    }
    // Anything else re-reduces the growing frame once per peer group.
    const impl = aggregates[w.name]
    const envs = new Array(n)
    for (let i = 0; i < n; i++) envs[i] = part[i].env
    for (let g = 0; g < groupCount; g++) {
      const e = ends[g]
      let value
      if (w.star) value = impl.reduce(new Array(e).fill(1))
      else value = reduceValues(w, impl, argFns, envs.slice(0, e))
      for (let i = starts[g]; i < e; i++) set(i, value)
    }
    return
  }

  switch (w.name) {
    case 'ROW_NUMBER':
      for (let i = 0; i < n; i++) set(i, i + 1)
      return
    case 'RANK':
      for (let g = 0; g < groupCount; g++) for (let i = starts[g]; i < ends[g]; i++) set(i, starts[g] + 1)
      return
    case 'DENSE_RANK':
      for (let g = 0; g < groupCount; g++) for (let i = starts[g]; i < ends[g]; i++) set(i, g + 1)
      return
    case 'PERCENT_RANK':
      for (let g = 0; g < groupCount; g++) for (let i = starts[g]; i < ends[g]; i++) set(i, n > 1 ? starts[g] / (n - 1) : 0)
      return
    case 'CUME_DIST':
      for (let g = 0; g < groupCount; g++) for (let i = starts[g]; i < ends[g]; i++) set(i, ends[g] / n)
      return
    case 'NTILE': {
      const buckets = Math.max(1, toNumber(n ? arg(0, 0) : 1) ?? 1)
      const size = Math.floor(n / buckets); const extra = n % buckets
      let i = 0
      for (let b = 1; b <= buckets && i < n; b++) {
        const len = size + (b <= extra ? 1 : 0)
        for (let j = 0; j < len; j++) set(i++, b)
      }
      return
    }
    case 'LAG':
    case 'LEAD': {
      const sign = w.name === 'LAG' ? -1 : 1
      for (let i = 0; i < n; i++) {
        const offset = argFns[1] ? toNumber(arg(i, 1)) ?? 1 : 1
        const j = i + sign * offset
        set(i, j >= 0 && j < n ? arg(j, 0) : (argFns[2] ? arg(i, 2) : null))
      }
      return
    }
    case 'FIRST_VALUE': {
      const first = n ? arg(0, 0) : null
      for (let i = 0; i < n; i++) set(i, first)
      return
    }
    case 'LAST_VALUE':
      for (let g = 0; g < groupCount; g++) {
        const value = arg(ends[g] - 1, 0)
        for (let i = starts[g]; i < ends[g]; i++) set(i, value)
      }
      return
    case 'NTH_VALUE':
      for (let g = 0; g < groupCount; g++) {
        const e = ends[g]
        for (let i = starts[g]; i < e; i++) {
          const k = (toNumber(arg(i, 1)) ?? 1) - 1
          set(i, k >= 0 && k < e ? arg(k, 0) : null)
        }
      }
      return
    default:
      throw new SqlError(`Unknown window function ${w.name}`)
  }
}

// -- INSERT ------------------------------------------------------------------------------------

function runInsert (statement, state) {
  const source = runQuery(statement.source, state, null)
  const name = statement.table
  let existing = state.tables.get(name)
  if (!existing) {
    existing = own(state.root, name) ? toRows(state.root[name], true).slice() : []
    state.tables.set(name, existing)
  }
  const columns = statement.columns ??
    (existing.length && typeof existing[0] === 'object' ? Object.keys(existing[0]) : source.columns)
  if (columns.length !== source.columns.length) {
    throw new SqlError(`INSERT INTO ${name} has ${columns.length} columns but the values have ${source.columns.length}`)
  }
  for (let r = 0; r < source.rows.length; r++) {
    const row = source.rows[r]
    const o = {}
    for (let i = 0; i < columns.length; i++) setKey(o, columns[i], row[source.columns[i]])
    existing.push(o)
  }
  return { columns: [], rows: [], inserted: source.rows.length, table: name }
}
