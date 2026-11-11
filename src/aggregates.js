/**
 * Aggregate functions. Each takes the argument values collected over a group —
 * NULLs already dropped, except where an aggregate says otherwise — and
 * reduces them. They run in the executor, not the engine: an aggregate is a
 * fold over rows, which a per-row JSON Logic expression cannot express.
 */

import { compare, isNull, setKey, toNumber, toText, keyOf } from './values.js'
import { stringLength } from './guard.js'

function joined (values, sep) {
  if (!values.length) return null
  const glue = toText(sep) ?? ''
  let s = toText(values[0])
  for (let i = 1; i < values.length; i++) {
    s += glue + toText(values[i])
    if (s.length > 65536) stringLength(s.length)
  }
  stringLength(s.length)
  return s
}

function objectOf (pairs) {
  const o = {}
  for (let i = 0; i < pairs.length; i++) {
    const k = pairs[i][0]
    if (!isNull(k)) setKey(o, toText(k), pairs[i][1] ?? null)
  }
  return o
}

function countTrue (values) {
  let n = 0
  for (let i = 0; i < values.length; i++) if (values[i] === true) n++
  return n
}

const numbers = (values) => {
  const out = []
  for (let i = 0; i < values.length; i++) { const n = toNumber(values[i]); if (n !== null) out.push(n) }
  return out
}

function total (xs) {
  let t = 0
  for (let i = 0; i < xs.length; i++) t += xs[i]
  return t
}
const sum = (values) => { const xs = numbers(values); return xs.length ? total(xs) : null }
const avg = (values) => { const xs = numbers(values); return xs.length ? total(xs) / xs.length : null }

function variance (values, sample) {
  const xs = numbers(values)
  const n = xs.length
  if (n === 0 || (sample && n === 1)) return null
  const mean = total(xs) / n
  let ss = 0
  for (let i = 0; i < n; i++) ss += (xs[i] - mean) ** 2
  return ss / (sample ? n - 1 : n)
}

function extreme (values, sign) {
  let best = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (best === null || compare(v, best) * sign > 0) best = v
  }
  return best
}

function median (values) {
  const xs = numbers(values).sort((a, b) => a - b)
  if (!xs.length) return null
  const mid = xs.length >> 1
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
}

/**
 * `keepNulls`: the aggregate sees NULL arguments (ARRAY_AGG collects them, as in
 * Postgres). `arity`: how many arguments it reads per row; the rest are
 * constants taken from the first row (STRING_AGG's separator).
 */
export const aggregates = {
  COUNT: { reduce: (values) => values.length },
  SUM: { reduce: sum },
  TOTAL: { reduce: (values) => sum(values) ?? 0 },
  AVG: { reduce: avg },
  MEAN: { reduce: avg },
  MIN: { reduce: (values) => extreme(values, -1) },
  MAX: { reduce: (values) => extreme(values, 1) },
  MEDIAN: { reduce: median },
  STDDEV: { reduce: (v) => { const x = variance(v, true); return x === null ? null : Math.sqrt(x) } },
  STDDEV_SAMP: { reduce: (v) => { const x = variance(v, true); return x === null ? null : Math.sqrt(x) } },
  STDDEV_POP: { reduce: (v) => { const x = variance(v, false); return x === null ? null : Math.sqrt(x) } },
  VARIANCE: { reduce: (v) => variance(v, true) },
  VAR_SAMP: { reduce: (v) => variance(v, true) },
  VAR_POP: { reduce: (v) => variance(v, false) },
  ARRAY_AGG: { reduce: (values) => (values.length ? values : null), keepNulls: true },
  LIST: { reduce: (values) => values, keepNulls: true },
  STRING_AGG: { reduce: (values, sep = ',') => joined(values, sep), arity: 1 },
  GROUP_CONCAT: { reduce: (values, sep = ',') => joined(values, sep), arity: 1 },
  BOOL_AND: { reduce: (values) => (values.length ? countTrue(values) === values.length : null) },
  BOOL_OR: { reduce: (values) => (values.length ? countTrue(values) > 0 : null) },
  EVERY: { reduce: (values) => (values.length ? countTrue(values) === values.length : null) },
  COUNT_IF: { reduce: countTrue },
  ANY_VALUE: { reduce: (values) => (values.length ? values[0] : null) },
  FIRST: { reduce: (values) => (values.length ? values[0] : null), keepNulls: true },
  LAST: { reduce: (values) => (values.length ? values[values.length - 1] : null), keepNulls: true },
  MODE: {
    reduce: (values) => {
      const counts = new Map(); let best = null; let bestN = 0
      for (let i = 0; i < values.length; i++) {
        const v = values[i]
        const k = keyOf(v); const n = (counts.get(k) || 0) + 1; counts.set(k, n)
        if (n > bestN) { bestN = n; best = v }
      }
      return best
    }
  },
  // Pairs: OBJECT_AGG(key, value).
  OBJECT_AGG: { reduce: objectOf, pairs: true },
  JSON_OBJECT_AGG: { reduce: objectOf, pairs: true }
}

/** Window-only functions: they need the partition, its order, and the row's place in it. */
export const windowFunctions = new Set([
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'PERCENT_RANK', 'CUME_DIST', 'NTILE',
  'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE'
])
