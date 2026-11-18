/**
 * sqllang — SQL over plain JavaScript data.
 *
 *   import { query } from 'sqllang'
 *   query('SELECT name, SUM(total) AS spent FROM orders GROUP BY name', { orders })
 *
 * A query compiles to a JSON plan whose expressions are JSON Logic; the
 * executor runs it on json-logic-engine.
 */

import { compile } from './compile.js'
import { executePlan, createEngine, defaultEngine, toRows } from './execute.js'
import { SqlError, SqlSyntaxError } from './errors.js'
import { SqlLimitError, SAFE_LIMITS } from './guard.js'
import { functions } from './functions.js'
import { aggregates, windowFunctions } from './aggregates.js'
import { complete, createCompleter, inferSchema } from './complete.js'

/**
 * Compile once, run many times.
 *
 * @param {string} sql One statement, or a script of `;`-separated statements.
 * @param {{ engine?: any, interpreted?: boolean, limits?: object }} [options]
 *   `limits` — { timeoutMs, maxRows, maxStringLength, maxQueryLength, regex }, or
 *   SAFE_LIMITS; applied at compile time and on every run.
 */
export function prepare (sql, options = {}) {
  const engine = options.engine ?? defaultEngine
  const plan = compile(sql, { functions: engine.sqlFunctions, limits: options.limits })
  const run = (data, params, runOptions = {}) =>
    executePlan(plan, data, { ...options, ...runOptions, engine, params: params ?? runOptions.params ?? options.params })
  return {
    plan,
    /** Rows of the last statement, with a non-enumerable `columns` array. */
    query: (data, params) => asRows(last(run(data, params).results)),
    /** Every statement's result, plus the tables INSERT created. */
    execute: (data, params) => run(data, params)
  }
}

/**
 * Run SQL against data and get rows back.
 *
 * @param {string} sql
 * @param {object | object[]} data Tables by name — `{ orders: [...], users: [...] }` — or
 *   a single array, which is the table `data`.
 * @param {{ params?: any[] | Record<string, any>, engine?: any, interpreted?: boolean }} [options]
 * @returns {object[] & { columns: string[] }}
 */
export function query (sql, data, options = {}) {
  const engine = options.engine ?? defaultEngine
  return asRows(last(executePlan(planFor(sql, engine, options), data, { ...options, engine }).results))
}

/**
 * Run a script and get every statement's result, and the tables it created.
 */
export function execute (sql, data, options = {}) {
  const engine = options.engine ?? defaultEngine
  return executePlan(planFor(sql, engine, options), data, { ...options, engine })
}

// The same SQL text compiles to the same plan, and a plan carries the functions the
// engine built for it, so `query()` keeps the most recent ones. `limits` shape the
// plan at compile time, so a call that passes them compiles its own.
const plans = new WeakMap()
const PLAN_CACHE_SIZE = 256
const PLAN_CACHE_MAX_SQL = 8192

function planFor (sql, engine, options) {
  const fresh = () => compile(sql, { functions: engine.sqlFunctions, limits: options.limits })
  if (options.limits || typeof sql !== 'string' || sql.length > PLAN_CACHE_MAX_SQL) return fresh()
  let cache = plans.get(engine)
  if (!cache) plans.set(engine, cache = new Map())
  let plan = cache.get(sql)
  if (plan !== undefined) {
    cache.delete(sql) // least recently used first
    cache.set(sql, plan)
    return plan
  }
  plan = fresh()
  cache.set(sql, plan)
  if (cache.size > PLAN_CACHE_SIZE) cache.delete(cache.keys().next().value)
  return plan
}

function last (results) {
  for (let i = results.length - 1; i >= 0; i--) if (!('inserted' in results[i])) return results[i]
  return { columns: [], rows: [] }
}

function asRows ({ columns, rows }) {
  Object.defineProperty(rows, 'columns', { value: columns, enumerable: false })
  return rows
}

/** Every scalar function name SQL can call. */
export const functionNames = Object.keys(functions).sort()
/** Every aggregate function name. */
export const aggregateNames = Object.keys(aggregates).sort()

export {
  compile, executePlan, createEngine, defaultEngine, toRows, complete, createCompleter, inferSchema,
  SqlError, SqlSyntaxError, SqlLimitError, SAFE_LIMITS, windowFunctions
}
