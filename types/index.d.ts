/**
 * sqllang — SQL over plain JavaScript data.
 *
 * Hand-written so the public API carries real types rather than the `any` that
 * inference from JSDoc would produce.
 */

import type { LogicEngine } from 'json-logic-engine'

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/** A result row: column name to value. */
export type Row = Record<string, unknown>

/**
 * What a query reads. Usually tables by name — `{ orders: [...], users: [...] }` —
 * where a table may be an array of rows, a columnar object (`{ id: [...], name: [...] }`),
 * a header-row array (`[['id', 'name'], [1, 'a']]`), a single document, or any of those
 * as JSON text. A bare array is the table `data`.
 */
export type Data = Record<string, unknown> | readonly unknown[]

/** Bound parameters: positional (`?`, `$1`) by array, named (`:name`) by object. */
export type Params = readonly unknown[] | Record<string, unknown>

/** Rows of a result, with the column names in select-list order. */
export type Rows<T extends object = Row> = T[] & { readonly columns: string[] }

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Resource limits for queries you did not write. Every field defaults to unlimited. */
export interface Limits {
  /** Wall-clock budget for one execution, in milliseconds. Checked cooperatively. */
  timeoutMs?: number
  /** The most rows any one step may produce: a join, a GROUP BY, GENERATE_SERIES, the result. */
  maxRows?: number
  /** The longest string a function may build (REPEAT, LPAD, ||, STRING_AGG, ...). */
  maxStringLength?: number
  /** The longest SQL text `compile` accepts. */
  maxQueryLength?: number
  /**
   * `false` refuses REGEXP_LIKE / REGEXP_REPLACE / REGEXP_EXTRACT. JavaScript cannot
   * interrupt a running regex, so turn this off for untrusted SQL.
   */
  regex?: boolean
}

/** `{ timeoutMs: 1000, maxRows: 1e6, maxStringLength: 1e6, maxQueryLength: 20000, regex: false }` */
export const SAFE_LIMITS: Readonly<Required<Limits>>

/** Which limit a `SqlLimitError` hit. `depth` is excessive nesting at compile time. */
export type LimitName = 'timeoutMs' | 'maxRows' | 'maxStringLength' | 'maxQueryLength' | 'regex' | 'depth'

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * A scalar function callable from SQL. A plain function receives the evaluated
 * arguments as an array; an object is passed to json-logic-engine's `addMethod`
 * as is (for `deterministic`, `optimizeUnary`, `compile`, ...).
 */
export type ScalarFunction = ((args: unknown[]) => unknown) | {
  method: (args: unknown[], context?: unknown) => unknown
  deterministic?: boolean
  [option: string]: unknown
}

/** A json-logic-engine `LogicEngine` with the SQL operators and function library loaded. */
export type Engine = LogicEngine & {
  /** Names of the extra functions this engine was created with (upper-cased). */
  readonly sqlFunctions: ReadonlySet<string>
}

export interface EngineOptions {
  /** Extra scalar functions by name. Names are case-insensitive in SQL. */
  functions?: Record<string, ScalarFunction>
  /** Anything else is passed to the `LogicEngine` constructor. */
  [option: string]: unknown
}

export function createEngine (options?: EngineOptions): Engine

/** The engine used when none is given. */
export const defaultEngine: Engine

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * A compiled script: plain JSON, every expression in it JSON Logic. Store it,
 * ship it, diff it, and run it later with `executePlan`. The node shapes are an
 * implementation detail and may change between versions; `version` says which.
 */
export interface Plan {
  type: 'sqllang'
  version: 1
  statements: unknown[]
  ctes: unknown[]
  subqueries: unknown[]
  /** How many `?` placeholders the script has. */
  positionalParams: number
}

export interface CompileOptions {
  /** Extra scalar function names the compiler should accept. */
  functions?: Iterable<string>
  /** Applies `maxQueryLength` and `regex` at compile time. */
  limits?: Limits
}

export function compile (sql: string, options?: CompileOptions): Plan

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Values for `?`, `$1` and `:name`. */
  params?: Params
  /** An engine from `createEngine`; needed to call custom functions. */
  engine?: Engine
  /**
   * Never generate code: run expressions with the interpreter, for a strict
   * Content-Security-Policy (no `unsafe-eval`). Slower.
   */
  interpreted?: boolean
  /** Resource limits. See `SAFE_LIMITS`. */
  limits?: Limits
  /** Extra tables by name, as if INSERTed before the script ran. */
  tables?: Record<string, readonly unknown[]>
}

/** One statement's result. */
export interface StatementResult<T extends object = Row> {
  columns: string[]
  rows: T[]
}

/** An INSERT's result. */
export interface InsertResult {
  columns: []
  rows: []
  inserted: number
  table: string
}

export interface ExecuteResult {
  results: Array<StatementResult | InsertResult>
  /** Tables built by INSERT, by name. Your input data is never modified. */
  tables: Map<string, Row[]>
}

export interface Prepared {
  plan: Plan
  /** Rows of the last SELECT in the script. */
  query<T extends object = Row> (data: Data, params?: Params): Rows<T>
  /** Every statement's result, and the tables INSERT built. */
  execute (data: Data, params?: Params): ExecuteResult
}

/** Compile once, run many times. */
export function prepare (sql: string, options?: RunOptions): Prepared

/** Run SQL against data; rows of the last SELECT. */
export function query<T extends object = Row> (sql: string, data: Data, options?: RunOptions): Rows<T>

/** Run a script; every statement's result, and the tables INSERT built. */
export function execute (sql: string, data: Data, options?: RunOptions): ExecuteResult

/** Run a stored plan. */
export function executePlan (plan: Plan, data: Data, options?: RunOptions): ExecuteResult

/**
 * The rows a value stands for, as a FROM item sees it. With `shapes`, columnar
 * objects and header-row arrays are recognised too.
 */
export function toRows (value: unknown, shapes: boolean): unknown[]

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Anything wrong with a query: an unknown column or table, a misplaced aggregate, ... */
export class SqlError extends Error {
  name: 'SqlError' | 'SqlSyntaxError' | 'SqlLimitError'
}

export interface SourcePosition {
  offset: number
  line: number
  column: number
}

/** The SQL does not parse. */
export class SqlSyntaxError extends SqlError {
  name: 'SqlSyntaxError'
  location: { start: SourcePosition, end: SourcePosition }
}

/** A query exceeded one of its `limits`. */
export class SqlLimitError extends SqlError {
  name: 'SqlLimitError'
  limit: LimitName
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/** Every built-in scalar function name. */
export const functionNames: readonly string[]
/** Every aggregate function name. */
export const aggregateNames: readonly string[]
/** Every window-only function name (ROW_NUMBER, RANK, LAG, ...). */
export const windowFunctions: ReadonlySet<string>
