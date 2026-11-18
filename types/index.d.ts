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

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

export type CompletionKind = 'keyword' | 'operator' | 'table' | 'column' | 'alias' | 'function' | 'aggregate' | 'window' | 'value'

export interface Completion {
  label: string
  kind: CompletionKind
  /** A column's type, a table's column count, an alias's table, the column a value belongs to. */
  detail?: string
  /**
   * The text to put in place of `from`..`to` when it is not the label: a value
   * outside a string as a SQL literal (`'it''s'`, `TRUE`, `3`), inside one as escaped text.
   */
  insert?: string
}

export interface Completions {
  /** The word (or string content) under the cursor, as a half-open range to replace. */
  from: number
  to: number
  /** What was typed of it, before the cursor. */
  prefix: string
  /** Best first, already filtered by `prefix`. */
  items: Completion[]
}

export interface CompleteColumn {
  name: string
  type?: string | null
  /** The values this column is compared with, to suggest after `=`, in `IN (...)` and so on. */
  values?: ReadonlyArray<string | number | boolean>
}

export interface CompleteOptions {
  /**
   * What you would pass to `query()`. Tables, columns, types, and the values of
   * columns that have only a few (up to 50 distinct) are read from it.
   */
  data?: Data
  /**
   * Tables you state yourself: names, or names with columns. A table also in `data`
   * keeps the types it found but takes these columns.
   */
  tables?: readonly string[] | Record<string, ReadonlyArray<string | CompleteColumn>>
  /** Values to suggest for a column: `'table.column'` or just `'column'`. Wins over the data. */
  values?: Record<string, ReadonlyArray<string | number | boolean>>
  /** Names of custom scalar functions to suggest. */
  functions?: readonly string[]
  /** The engine you query with; the custom functions it was created with are suggested. */
  engine?: Engine
  /**
   * A table's columns are only suggested while that table is in the statement, so a select list
   * written before its `FROM` gets none. Set this to guess instead, for typing left to right:
   * with no `FROM` yet, the columns of every table are offered, and an alias not declared yet is
   * read as the table whose name it starts (`o.` as `orders`). Off by default.
   */
  guessColumns?: boolean
}

export interface Completer {
  (sql: string, cursor?: number): Completions
  /** Change what it knows; each option given replaces the one before. Returns itself. */
  update (options: CompleteOptions): Completer
}

/** A completion function; it keeps what it read from the data, so it is cheap per keystroke. */
export function createCompleter (options?: CompleteOptions): Completer

/** One-off completion. Use `createCompleter` when calling it repeatedly. */
export function complete (sql: string, cursor?: number, options?: CompleteOptions): Completions

/** The tables in `data` and their columns, read from the first rows. */
export function inferSchema (data: Data): { tables: Record<string, Array<{ name: string, type: string | null }>> }
