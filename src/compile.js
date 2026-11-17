/**
 * SQL text -> a query plan.
 *
 * The parser (generated from grammar.gram) produces statement nodes whose
 * expressions are already JSON Logic, apart from a few placeholders that need
 * the query's scope: column references, function calls, subqueries and
 * parameters. This module resolves them, so that a plan is
 *
 *   - plain JSON (store it, ship it, diff it), and
 *   - every expression in it is JSON Logic that json-logic-engine runs as is.
 *
 * Rows in the executor are "environments": `{ o: orderRow, i: itemRow }`, one
 * key per FROM alias. A reference resolves to a path into that object —
 * `o.total` is `{"val": ["o", "total"]}` — and anything deeper, or inside a
 * JSON-text column, goes through `PATH`.
 */

import * as parser from './parser.js'
import { SqlError, SqlSyntaxError } from './errors.js'
import { SqlLimitError, normalizeLimits } from './guard.js'

const REGEX_FUNCTIONS = ['REGEXP_LIKE', 'REGEXP_REPLACE', 'REGEXP_EXTRACT']
import { aggregates, windowFunctions } from './aggregates.js'
import { functions as scalarFunctions, validateCall } from './functions.js'

const TABLE_FUNCTIONS = {
  UNNEST: 'unnest', FLATTEN: 'unnest', EXPLODE: 'unnest',
  GENERATE_SERIES: 'series', RANGE: 'series',
  JSON_EACH: 'entries', ENTRIES: 'entries'
}

/**
 * @param {string} source
 * @param {{ functions?: Iterable<string>, limits?: object }} [options]
 *   `functions`: extra scalar function names. `limits`: see guard.js — compile
 *   applies `maxQueryLength` and `regex`.
 */
export function compile (source, options = {}) {
  if (typeof source !== 'string') throw new SqlError('A query must be a string')
  const limits = normalizeLimits(options.limits)
  if (source.length > limits.maxQueryLength) {
    throw new SqlLimitError(`Query is ${source.length} characters; the limit is ${limits.maxQueryLength}`, 'maxQueryLength')
  }
  try {
    return compileSource(source, options, limits)
  } catch (error) {
    // The parser and planner recurse; pathological nesting runs out of stack.
    if (error instanceof RangeError && /call stack/i.test(error.message)) {
      throw new SqlLimitError('Query is nested too deeply', 'depth')
    }
    throw error
  }
}

function compileSource (source, options, limits) {
  let ast
  try {
    ast = parser.parse(source)
  } catch (error) {
    if (error && (error.name === 'ParseError' || error.name === 'LexError')) throw syntaxError(source, error)
    throw error
  }

  const names = new Set(Object.keys(scalarFunctions))
  for (const name of options.functions ?? []) names.add(String(name).toUpperCase())

  const disabled = new Set(limits.regex ? [] : REGEX_FUNCTIONS)
  const cx = { subqueries: [], ctes: [], positional: 0, functions: names, disabled, scopes: [] }
  const statements = [ast.head, ...ast.tail].filter(Boolean).map((s) => planStatement(s, cx))
  return {
    type: 'sqllang',
    version: 1,
    statements,
    ctes: cx.ctes,
    subqueries: cx.subqueries,
    positionalParams: cx.positional
  }
}

function planStatement (node, cx) {
  if (node.type === 'Insert') {
    return {
      kind: 'insert',
      table: node.table.join('.'),
      columns: node.columns,
      source: planQuery(node.source, null, new Map(), cx)
    }
  }
  return planQuery(node, null, new Map(), cx)
}

// -- scopes ------------------------------------------------------------------

function newScope (cx, outer, cteNames) {
  const scope = {
    aliases: [],
    outer,
    cteNames,
    outputs: null,
    aggregates: [],
    aggKeys: new Map(),
    windows: [],
    winKeys: new Map(),
    correlated: false
  }
  cx.scopes.push(scope)
  return scope
}

const NO_REFS = { aliases: [], outer: null, cteNames: new Map(), outputs: null, aggregates: [], aggKeys: new Map(), windows: [], winKeys: new Map() }

// -- queries --------------------------------------------------------------------

function planQuery (q, outer, cteNames, cx) {
  const firstScope = cx.scopes.length
  cteNames = new Map(cteNames)
  for (const cte of q.with ?? []) {
    const id = cx.ctes.length
    cx.ctes.push(null)
    // A CTE sees the CTEs before it, never the row it is used from.
    cx.ctes[id] = { name: cte.name, plan: planQuery(cte.query, null, cteNames, cx) }
    cteNames.set(cte.name, id)
  }

  const plan = { kind: 'query', body: null, orderBy: null, limit: null, offset: null, correlated: false }
  if (q.body.type === 'Select') {
    plan.body = planSelect(q.body, outer, cteNames, cx, q.orderBy)
  } else {
    plan.body = planBody(q.body, outer, cteNames, cx)
    if (q.orderBy) {
      // Over a UNION, ORDER BY sees only the result's columns.
      plan.orderBy = q.orderBy.map((item) => orderItem(item, outputOnlyScope(), cx))
    }
  }
  if (q.limit) {
    plan.limit = q.limit.limit === null ? null : expr(q.limit.limit, NO_REFS, cx, {})
    plan.offset = q.limit.offset === null ? null : expr(q.limit.offset, NO_REFS, cx, {})
  }
  plan.correlated = cx.scopes.slice(firstScope).some((s) => s.correlated)
  return plan
}

function outputOnlyScope () {
  return { ...NO_REFS, outputs: new Map(), outputOnly: true }
}

function planBody (node, outer, cteNames, cx) {
  switch (node.type) {
    case 'Select': return planSelect(node, outer, cteNames, cx, null)
    case 'Query': return planQuery(node, outer, cteNames, cx)
    case 'SetOp':
      return {
        kind: 'setop',
        op: node.op,
        all: node.all,
        left: planBody(node.left, outer, cteNames, cx),
        right: planBody(node.right, outer, cteNames, cx)
      }
    case 'Values': {
      const scope = newScope(cx, outer, cteNames)
      return { kind: 'values', rows: node.rows.map((row) => row.map((e) => expr(e, scope, cx, {}))) }
    }
    default: throw new SqlError(`Unexpected ${node.type}`)
  }
}

function planSelect (sel, outer, cteNames, cx, orderBy) {
  const scope = newScope(cx, outer, cteNames)
  const steps = []

  const addItem = (item, join, on, using) => {
    const { alias, source } = planSource(item, scope, cx)
    if (alias === '__proto__' || alias.startsWith('$')) throw new SqlError(`'${alias}' cannot be used as a table alias`)
    if (scope.aliases.includes(alias)) throw new SqlError(`Table name '${alias}' specified more than once; give one an alias`)
    const leftAliases = [...scope.aliases]
    scope.aliases.push(alias)
    const step = { alias, source, join, on: null, hash: null, leftAliases }

    let conjuncts = []
    if (using) {
      for (const column of using) {
        conjuncts.push({ logic: { EQ: [{ COL: [column, ...leftAliases] }, { val: [alias, column] }] }, deps: new Set() })
      }
    } else if (on) {
      conjuncts = splitAnd(on).map((c) => {
        const deps = new Set()
        return { logic: expr(c, scope, cx, { deps }), deps }
      })
    }

    // An equality between something of the new table and something of the
    // tables before it becomes a hash join instead of a nested loop.
    const hashable = source.kind !== 'expr' && (join === 'INNER' || join === 'LEFT')
    const keys = { left: [], right: [] }
    const residual = []
    for (const c of conjuncts) {
      const logic = c.logic
      if (hashable && c.deps && logic.EQ) {
        const [a, b] = logic.EQ
        const da = depsOf(conjuncts, c, 0); const db = depsOf(conjuncts, c, 1)
        if (onlyNew(da, alias) && notNew(db, alias)) { keys.right.push(a); keys.left.push(b); continue }
        if (onlyNew(db, alias) && notNew(da, alias)) { keys.right.push(b); keys.left.push(a); continue }
      }
      residual.push(logic)
    }
    if (keys.left.length) step.hash = keys
    if (residual.length) step.on = residual.length === 1 ? residual[0] : { AND: residual }
    if ((join === 'INNER' || join === 'LEFT' || join === 'RIGHT' || join === 'FULL') && !on && !using) {
      throw new SqlError(`${join} JOIN ${alias} needs an ON or USING condition`)
    }
    steps.push(step)
  }

  ;(sel.from ?? []).forEach((term, i) => {
    addItem(term.base, i === 0 ? 'FROM' : 'CROSS', null, null)
    for (const j of term.joins) addItem(j.item, j.joinType, j.on, j.using)
  })

  // WHERE conjuncts that read a single table are applied to that table's rows
  // before any join. Only where the table is never the nullable side of an
  // outer join (a later RIGHT/FULL, or its own LEFT), so the answer is unchanged.
  let where = null
  if (sel.where != null) {
    const parts = steps.length > 1 ? splitAnd(sel.where) : [sel.where]
    const residual = []
    for (const part of parts) {
      const deps = new Set()
      const logic = expr(part, scope, cx, { deps })
      const alias = deps.size === 1 ? [...deps][0] : null
      const i = alias === null ? -1 : steps.findIndex((s) => s.alias === alias)
      const step = steps[i]
      const pushable = steps.length > 1 && step && step.source.kind !== 'expr' &&
        (step.join === 'FROM' || step.join === 'CROSS' || step.join === 'INNER') &&
        !steps.slice(i + 1).some((s) => s.join === 'RIGHT' || s.join === 'FULL')
      if (pushable) step.filter = step.filter ? { AND: [step.filter, logic] } : logic
      else residual.push(logic)
    }
    where = residual.length === 0 ? null : residual.length === 1 ? residual[0] : { AND: residual }
  }

  // Select list. Expression columns are compiled first so GROUP BY and ORDER BY
  // can refer to them by alias or position.
  const columns = []
  const outputs = new Map()
  const taken = new Set()
  expandPivots(sel.columns).forEach((col, i) => {
    if (col.type === 'Star') {
      if (col.table !== null && !scope.aliases.includes(col.table)) throw new SqlError(`Unknown table '${col.table}' in ${col.table}.*`)
      const aliases = col.table !== null ? [col.table] : [...scope.aliases]
      if (!aliases.length) throw new SqlError('SELECT * needs a FROM clause')
      columns.push({ kind: 'star', aliases })
      return
    }
    const logic = expr(col.expr, scope, cx, { agg: true, win: true })
    let name = col.alias ?? deriveName(col.expr, i)
    if (taken.has(name)) { let n = 2; while (taken.has(`${name}_${n}`)) n++; name = `${name}_${n}` }
    taken.add(name)
    columns.push({ kind: 'expr', name, expr: logic })
    outputs.set(name, { logic, ast: col.expr, index: i })
  })
  scope.outputs = outputs

  let groupBy = null
  if (sel.groupBy) {
    groupBy = sel.groupBy.map((g) => {
      if (typeof g === 'number') {
        const col = columns[g - 1]
        if (!col || col.kind !== 'expr') throw new SqlError(`GROUP BY position ${g} is not in the select list`)
        if (containsAggregate(col.expr)) throw new SqlError(`GROUP BY position ${g} refers to an aggregate`)
        return col.expr
      }
      if (g && g.$ref && g.$ref.length === 1 && outputs.has(g.$ref[0])) {
        const out = outputs.get(g.$ref[0])
        const sameColumn = out.ast && out.ast.$ref && out.ast.$ref.length === 1 && out.ast.$ref[0] === g.$ref[0]
        if (!sameColumn && !containsAggregate(out.logic)) return out.logic
      }
      return expr(g, scope, cx, {})
    })
  }

  // HAVING may name a select-list alias (as SQLite allows): `HAVING n > 1`. It runs
  // before projection, so the alias is replaced by its expression.
  const having = sel.having == null ? null : expr(sel.having, scope, cx, { agg: true, inlineOutputs: true })
  let needsOutv = false
  const order = orderBy
    ? orderBy.map((item) => {
      const o = orderItem(item, scope, cx)
      if (o.ordinal) needsOutv = true
      return o
    })
    : null

  return {
    kind: 'select',
    distinct: sel.distinct,
    steps,
    where,
    grouped: groupBy !== null || scope.aggregates.length > 0,
    groupBy,
    aggregates: scope.aggregates,
    having,
    windows: scope.windows,
    columns,
    // The select list as one expression, when it is all expressions with safe names.
    row: columns.length && columns.every((c) => c.kind === 'expr' && c.name !== '__proto__')
      ? { ROW: columns.flatMap((c) => [c.name, c.expr]) }
      : null,
    orderBy: order,
    needsOutv
  }
}

/**
 * `PIVOT(agg FOR col IN (a, b))` is one column per value: `agg FILTER (WHERE col = a)
 * AS a, ...`. The values are literals, so the columns are known at compile time.
 */
function expandPivots (columns) {
  if (!columns.some((c) => c.expr && c.expr.$pivot)) return columns
  return columns.flatMap((c) => {
    if (!c.expr || !c.expr.$pivot) return [c]
    const { agg, col, values } = c.expr.$pivot
    if (c.alias != null) throw new SqlError('PIVOT makes one column per value, so it cannot take an alias')
    const call = agg && agg.$call
    if (!call || call.over || call.filter) throw new SqlError('PIVOT needs a plain aggregate, such as PIVOT(SUM(x) FOR col IN (...))')
    return values.map((v) => {
      if (v !== null && typeof v === 'object') throw new SqlError('PIVOT values must be literals')
      const match = v === null ? { IS_NULL: [col] } : { EQ: [col, v] }
      return { type: 'Column', alias: v === null ? 'null' : String(v), expr: { $call: { ...call, filter: match } } }
    })
  })
}

function direction (item) {
  const desc = item.dir === 'DESC'
  let nullsFirst = null
  if (item.nulls !== null) {
    const n = String(item.nulls).toUpperCase()
    if (n !== 'FIRST' && n !== 'LAST') throw new SqlError(`Expected NULLS FIRST or NULLS LAST, got NULLS ${item.nulls}`)
    nullsFirst = n === 'FIRST'
  }
  return { desc, nullsFirst }
}

function orderItem (item, scope, cx) {
  const { desc, nullsFirst } = direction(item)
  if (typeof item.expr === 'number') {
    return { expr: { val: ['$outv', item.expr - 1] }, desc, nullsFirst, ordinal: true }
  }
  return { expr: expr(item.expr, scope, cx, { agg: true, win: true, outputs: true }), desc, nullsFirst }
}

function planSource (item, scope, cx) {
  const src = item.source
  switch (src.type) {
    case 'Path': {
      const segs = src.path
      const head = segs[0]
      const defaultAlias = [...segs].reverse().find((s) => typeof s === 'string' && s !== '[*]') ?? 'value'
      const alias = item.alias ?? defaultAlias
      if (segs.length === 1 && scope.cteNames.has(head)) {
        return { alias, source: { kind: 'cte', id: scope.cteNames.get(head) } }
      }
      // A path *into* an alias already in scope is a lateral join: `FROM orders o, o.items i`.
      // A bare name is always a table, so `FROM t, t u` and `(SELECT ... FROM t)` inside a
      // query over t mean what they say.
      if (segs.length > 1 && visibleAlias(scope, head)) {
        return { alias, source: { kind: 'expr', expr: ref(segs, scope, cx, {}) } }
      }
      return { alias, source: { kind: 'table', path: segs } }
    }
    case 'Subquery':
      return {
        alias: item.alias ?? 'subquery',
        source: { kind: 'subquery', plan: planQuery(src.query, null, scope.cteNames, cx) }
      }
    case 'Function': {
      const name = String(src.name).toUpperCase()
      const kind = TABLE_FUNCTIONS[name]
      if (!kind) throw new SqlError(`Unknown table function ${src.name}()`)
      const args = src.args.map((a) => expr(a, scope, cx, {}))
      const alias = item.alias ?? (kind === 'unnest' ? 'unnest' : String(src.name).toLowerCase())
      if (kind === 'unnest') {
        if (args.length !== 1) throw new SqlError(`${name}() takes one argument`)
        return { alias, source: { kind: 'expr', expr: args[0] } }
      }
      if (kind === 'series') return { alias, source: { kind: 'expr', expr: { SERIES: args } } }
      return { alias, source: { kind: 'expr', expr: { ENTRIES: args } } }
    }
    default: throw new SqlError(`Unexpected FROM item ${src.type}`)
  }
}

function visibleAlias (scope, name) {
  for (let s = scope; s; s = s.outer) if (s.aliases.includes(name)) return true
  return false
}

// -- expressions ------------------------------------------------------------------

/**
 * Resolve an expression's placeholders.
 *
 * mode.agg      aggregates allowed here (select list, HAVING, ORDER BY)
 * mode.win      window functions allowed here
 * mode.outputs  a bare name may be a select-list alias (ORDER BY)
 * mode.deps     collects the aliases the expression reads (for hash joins)
 */
function expr (node, scope, cx, mode) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((n) => expr(n, scope, cx, mode))
  const key = Object.keys(node)[0]
  const value = node[key]
  switch (key) {
    case '$ref': return ref(value, scope, cx, mode)
    case '$pivot': throw new SqlError('PIVOT can only be a column in the select list')
    case '$param':
      return { PARAM: [value === null ? cx.positional++ : typeof value === 'number' ? value - 1 : value] }
    case '$call': return call(value, scope, cx, mode)
    case '$subquery': return { SUBQUERY: [subquery(value, scope, cx, mode)] }
    case '$exists': return { EXISTS: [subquery(value, scope, cx, mode)] }
    case '$inSub': return { IN_SUB: [expr(value[0], scope, cx, mode), subquery(value[1], scope, cx, mode)] }
    default: {
      const problem = validateCall(key, Array.isArray(value) ? value : [value])
      if (problem) throw new SqlError(problem)
      return { [key]: Array.isArray(value) ? value.map((n) => expr(n, scope, cx, mode)) : expr(value, scope, cx, mode) }
    }
  }
}

function subquery (q, scope, cx, mode) {
  if (mode.deps) mode.deps.add('*')
  const id = cx.subqueries.length
  cx.subqueries.push(null)
  cx.subqueries[id] = planQuery(q, scope.outputOnly ? null : scope, scope.cteNames ?? new Map(), cx)
  return id
}

function ref (segs, scope, cx, mode) {
  const head = segs[0]

  if (mode.outputs && segs.length === 1 && scope.outputs && scope.outputs.has(head)) {
    return { val: ['$out', head] }
  }
  if (mode.inlineOutputs && segs.length === 1 && scope.outputs && scope.outputs.has(head) && !scope.aliases.includes(head)) {
    const out = scope.outputs.get(head)
    const sameColumn = out.ast && out.ast.$ref && out.ast.$ref.length === 1 && out.ast.$ref[0] === head
    if (!sameColumn) return out.logic
  }
  if (scope.outputOnly) {
    if (segs.length === 1) return { val: ['$out', head] }
    throw new SqlError(`Unknown column '${segs.join('.')}' in ORDER BY`)
  }

  if (typeof head === 'string' && scope.aliases.includes(head)) {
    mode.deps?.add(head)
    return qualified(head, segs.slice(1))
  }
  for (let s = scope.outer; s; s = s.outer) {
    if (s.aliases.includes(head)) {
      markCorrelated(scope, s)
      mode.deps?.add('*')
      return qualified(head, segs.slice(1))
    }
  }

  // Unqualified. Find the nearest scope with any tables in it.
  let target = scope
  while (target && target.aliases.length === 0) target = target.outer
  if (!target) throw new SqlError(`Unknown column '${segs.join('.')}' — there is no FROM clause to read it from`)
  if (target !== scope) { markCorrelated(scope, target); mode.deps?.add('*') }

  if (target.aliases.length === 1) {
    mode.deps?.add(target.aliases[0])
    return qualified(target.aliases[0], segs)
  }
  for (const a of target.aliases) mode.deps?.add(a)
  const base = { COL: [head, ...target.aliases] }
  return segs.length > 1 ? { PATH: [base, ...segs.slice(1)] } : base
}

function qualified (alias, rest) {
  let base
  let remaining
  if (rest.length && rest[0] === 'value') {
    // `x.value` is the element itself when x ranges over plain values
    // (UNNEST of a list of numbers), and the field `value` otherwise.
    base = { ROW_VALUE: [{ val: [alias] }] }
    remaining = rest.slice(1)
  } else if (rest.length && typeof rest[0] === 'string' && rest[0] !== '[*]') {
    base = { val: [alias, rest[0]] }
    remaining = rest.slice(1)
  } else {
    base = { val: [alias] }
    remaining = rest
  }
  return remaining.length ? { PATH: [base, ...remaining] } : base
}

function markCorrelated (from, to) {
  for (let s = from; s && s !== to; s = s.outer) s.correlated = true
}

function call (c, scope, cx, mode) {
  const name = String(c.name).toUpperCase()
  const inner = { deps: mode.deps }

  if (c.over) {
    if (!mode.win) throw new SqlError(`Window function ${name}() is not allowed here`)
    if (!aggregates[name] && !windowFunctions.has(name)) throw new SqlError(`${name}() is not a window function`)
    // Window arguments may use aggregates: SUM(SUM(x)) OVER (...).
    const argMode = { agg: mode.agg, deps: mode.deps }
    const spec = {
      name,
      aggregate: Boolean(aggregates[name]),
      star: c.star || (name === 'COUNT' && c.args.length === 0),
      distinct: c.distinct,
      args: c.args.map((a) => expr(a, scope, cx, argMode)),
      partitionBy: (c.over.partitionBy ?? []).map((p) => expr(p, scope, cx, argMode)),
      orderBy: (c.over.orderBy ?? []).map((item) => {
        if (typeof item.expr === 'number') throw new SqlError('Window ORDER BY does not take positions')
        return { expr: expr(item.expr, scope, cx, argMode), ...direction(item) }
      })
    }
    return { val: ['$win', intern(scope.windows, scope.winKeys, spec)] }
  }

  if (aggregates[name]) {
    if (!mode.agg) throw new SqlError(`Aggregate ${name}() is not allowed here`)
    const spec = {
      name,
      star: c.star || (name === 'COUNT' && c.args.length === 0),
      distinct: c.distinct,
      args: c.args.map((a) => expr(a, scope, cx, inner)),
      filter: c.filter == null ? null : expr(c.filter, scope, cx, inner),
      orderBy: c.orderBy
        ? c.orderBy.map((item) => {
          return { expr: expr(item.expr, scope, cx, inner), ...direction(item) }
        })
        : null
    }
    if (aggregates[name].pairs && spec.args.length !== 2) throw new SqlError(`${name}() takes two arguments`)
    if (!spec.star && spec.args.length === 0) throw new SqlError(`${name}() needs an argument`)
    return { val: ['$agg', intern(scope.aggregates, scope.aggKeys, spec)] }
  }

  if (windowFunctions.has(name)) throw new SqlError(`${name}() needs an OVER (...) clause`)
  if (c.star || c.distinct || c.filter || c.orderBy) throw new SqlError(`${name}() is not an aggregate`)
  if (cx.disabled.has(name)) throw new SqlLimitError(`${name}() is disabled for this query (limits.regex)`, 'regex')
  if (!cx.functions.has(name)) throw new SqlError(`Unknown function ${c.name}()`)
  const problem = validateCall(name, c.args)
  if (problem) throw new SqlError(problem)
  return { [name]: c.args.map((a) => expr(a, scope, cx, mode)) }
}

function intern (list, keys, spec) {
  const key = JSON.stringify(spec)
  let i = keys.get(key)
  if (i === undefined) { i = list.length; list.push(spec); keys.set(key, i) }
  return i
}

// -- helpers ------------------------------------------------------------------------

function splitAnd (node) {
  if (node && node.AND) return node.AND.flatMap(splitAnd)
  return [node]
}

/** Dependencies of one side of an EQ conjunct, recomputed from its logic. */
function depsOf (_all, c, side) {
  return logicDeps(c.logic.EQ[side])
}

function logicDeps (logic, out = new Set()) {
  if (logic === null || typeof logic !== 'object') return out
  if (Array.isArray(logic)) { for (const l of logic) logicDeps(l, out); return out }
  const key = Object.keys(logic)[0]
  const v = logic[key]
  if (key === 'val') { if (Array.isArray(v) && typeof v[0] === 'string') out.add(v[0]); return out }
  if (key === 'COL') { for (const a of v.slice(1)) out.add(a); return out }
  if (key === 'SUBQUERY' || key === 'EXISTS' || key === 'IN_SUB' || key === 'PARAM') out.add('*')
  return logicDeps(v, out)
}

const onlyNew = (deps, alias) => deps.size > 0 && [...deps].every((d) => d === alias)
const notNew = (deps, alias) => !deps.has(alias) && !deps.has('*')

function containsAggregate (logic) {
  if (logic === null || typeof logic !== 'object') return false
  if (Array.isArray(logic)) return logic.some(containsAggregate)
  const key = Object.keys(logic)[0]
  if (key === 'val' && Array.isArray(logic.val) && (logic.val[0] === '$agg' || logic.val[0] === '$win')) return true
  return containsAggregate(logic[key])
}

function deriveName (ast, i) {
  if (ast === null || typeof ast !== 'object') return ast === null ? 'NULL' : String(ast)
  if (ast.$ref) {
    const name = [...ast.$ref].reverse().find((s) => typeof s === 'string' && s !== '[*]')
    return name ?? `col${i + 1}`
  }
  if (ast.$call) return String(ast.$call.name).toLowerCase()
  if (ast.CAST) return deriveName(ast.CAST[0], i)
  if (ast.JSON_TEXT || ast.JSON_GET) {
    const k = (ast.JSON_TEXT || ast.JSON_GET)[1]
    if (typeof k === 'string' || typeof k === 'number') return String(k)
  }
  if (ast.$subquery) return `col${i + 1}`
  return `col${i + 1}`
}

function syntaxError (source, error) {
  const offset = error.token ? error.token.start : (error.offset ?? source.length)
  const endOffset = error.token ? error.token.end : Math.min(source.length, offset + (error.name === 'LexError' ? 1 : 0))
  const position = (at) => {
    const before = source.slice(0, at)
    return { offset: at, line: before.split('\n').length, column: at - before.lastIndexOf('\n') }
  }
  const { line, column } = position(offset)
  const text = source.split('\n')[line - 1] ?? source
  const what = error.message.replace(/ at offset \d+$/, '')
  const message = `${what} at line ${line}, column ${column}\n  ${text}\n  ${' '.repeat(Math.max(0, column - 1))}^`
  return new SqlSyntaxError(message, { start: position(offset), end: position(endOffset) })
}
