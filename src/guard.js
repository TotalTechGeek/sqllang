/**
 * Resource limits for a run, for queries written by someone you do not fully trust.
 *
 *   timeoutMs        wall-clock budget for one execution
 *   maxRows          the most rows any one step may produce (a join, a GROUP BY,
 *                    GENERATE_SERIES, the result) — this is what stops a cross join
 *                    of two big tables from eating the heap
 *   maxStringLength  the longest string a function may build (REPEAT, LPAD, ||, STRING_AGG)
 *   maxQueryLength   the longest SQL text compile() accepts
 *   regex            false disables REGEXP_LIKE / REGEXP_REPLACE / REGEXP_EXTRACT —
 *                    JavaScript regexes cannot be interrupted, so a hostile pattern
 *                    can hang the process no matter what timeoutMs says
 *
 * Everything defaults to unlimited. Execution is synchronous, so the limits of the
 * run in progress live in one module-level slot, saved and restored around nested runs.
 */

import { SqlError } from './errors.js'

export class SqlLimitError extends SqlError {
  constructor (message, limit) {
    super(message, { limit })
    this.name = 'SqlLimitError'
  }
}

/** A reasonable starting point for untrusted queries. */
export const SAFE_LIMITS = Object.freeze({
  timeoutMs: 1000,
  maxRows: 1_000_000,
  maxStringLength: 1_000_000,
  maxQueryLength: 20_000,
  regex: false
})

const UNLIMITED = { timeoutMs: Infinity, maxRows: Infinity, maxStringLength: Infinity, maxQueryLength: Infinity, regex: true }

export function normalizeLimits (limits) {
  return { ...UNLIMITED, ...(limits ?? {}) }
}

let current = null
let deadline = Infinity
let ticks = 0

/** Install a run's limits; returns a function that restores the previous ones. */
export function enter (limits) {
  const saved = { current, deadline }
  current = limits
  deadline = Number.isFinite(limits.timeoutMs) ? performance.now() + limits.timeoutMs : Infinity
  return () => { current = saved.current; deadline = saved.deadline }
}

/** Count `n` units of work (one by default); checks the clock each time 1024 are crossed. */
export function tick (n = 1) {
  if (((ticks += n) & 1023) < n && performance.now() > deadline) {
    throw new SqlLimitError(`Query exceeded its time limit of ${current.timeoutMs} ms`, 'timeoutMs')
  }
}

/** Check a row count against maxRows. */
export function rows (n) {
  if (current !== null && n > current.maxRows) {
    throw new SqlLimitError(`Query produced more than ${current.maxRows} rows in one step`, 'maxRows')
  }
}

/** Check a string length (or a length about to be built) against maxStringLength. */
export function stringLength (n) {
  if (current !== null && n > current.maxStringLength) {
    throw new SqlLimitError(`Query built a string longer than ${current.maxStringLength} characters`, 'maxStringLength')
  }
}

export function regexAllowed () {
  if (current !== null && !current.regex) {
    throw new SqlLimitError('Regular expressions are disabled for this query (limits.regex)', 'regex')
  }
}
