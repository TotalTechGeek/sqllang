/**
 * Operators and scalar functions, as json-logic-engine methods.
 *
 * A compiled expression is plain JSON Logic over these names —
 * `a > 1 AND b LIKE 'x%'` is `{"AND": [{"GT": [..., 1]}, {"LIKE": [..., "x%"]}]}` —
 * so it can be stored, inspected, or run with any engine that has them loaded.
 *
 * NULL propagates the SQL way: an operator with a NULL operand yields NULL,
 * AND/OR use three-valued logic, and only TRUE passes a WHERE.
 */

import { SqlError } from './errors.js'
import { regexAllowed, stringLength, rows as checkRows } from './guard.js'
import {
  isNull, setKey, toNumber, toText, toDate, equals, compare, maybeJson, walk, step, isTrue, keyOf
} from './values.js'

const fn = (method, deterministic = true) => ({
  method,
  // Compiled: a direct call `method([args], context)`, skipping the engine's lookup.
  compile: (args, bs) => {
    if (!Array.isArray(args)) args = [args]
    let res = bs.compile`${sync(method)}([`
    for (let i = 0; i < args.length; i++) res = i ? bs.compile`${res}, ${args[i]}` : bs.compile`${res}${args[i]}`
    return bs.compile`${res}], context)`
  },
  deterministic
})

/**
 * Compile-time checks for arguments that are literals: a CAST to a type that
 * does not exist, or a date unit nobody has heard of, should fail when the query
 * is compiled — not later, and not only on rows where the value is non-NULL.
 * Returns an error message, or null.
 */
export function validateCall (name, args) {
  const literal = (a) => typeof a === 'string'
  try {
    if (name === 'CAST' && literal(args[1])) cast(0, args[1])
    else if (name === 'DATE_TRUNC' && literal(args[0])) truncDate(args[0], new Date(0))
    else if (name === 'DATE_PART' && literal(args[0]) && !DATE_UNITS[unitOf(args[0])]) return `Unknown date part '${args[0]}'`
    else if ((name === 'DATE_DIFF' || name === 'DATEDIFF') && literal(args[0])) dateDiff(args[0], 0, 0)
    else if (name === 'DATE_ADD' && literal(args[2])) {
      const u = unitOf(args[2])
      if (!UNIT_MS[u] && u !== 'month' && u !== 'year' && u !== 'quarter') return `Unknown date unit '${args[2]}'`
    }
  } catch (error) {
    if (error instanceof SqlError) return error.message
    throw error
  }
  return null
}

// -- LIKE ----------------------------------------------------------------------

// Matched directly rather than through a RegExp: a pattern like '%a%a%a%a%b'
// makes a backtracking regex take exponential time, and this cannot. The
// pattern is a list of code points with two markers; the matcher is the
// classic greedy wildcard walk, O(text × pattern) at worst.

const SURROGATE = /[\uD800-\uDFFF]/

/** Length in code points, without building an array. */
function codePoints (s) {
  if (!SURROGATE.test(s)) return s.length
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0xDC00 || c > 0xDFFF) n++
  }
  return n
}

/** Slice by code points; plain `slice` when the string is all BMP. */
function sliceCodePoints (s, from, to) {
  if (!SURROGATE.test(s)) return s.slice(from, to)
  return [...s].slice(from, to).join('')
}

const ANY = 0 // %
const ONE = 1 // _

const likeCache = new Map()
function likePattern (pattern, fold) {
  const key = (fold ? 'i' : 's') + pattern
  let compiled = likeCache.get(key)
  if (compiled) return compiled
  compiled = []
  const chars = [...(fold ? pattern.toLowerCase() : pattern)]
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (c === '\\' && i + 1 < chars.length) compiled.push(chars[++i])
    else if (c === '%') { if (compiled[compiled.length - 1] !== ANY) compiled.push(ANY) }
    else if (c === '_') compiled.push(ONE)
    else compiled.push(c)
  }
  if (likeCache.size > 1000) likeCache.clear()
  likeCache.set(key, compiled)
  return compiled
}

function likeMatch (text, p) {
  // Index the string directly unless it has astral characters, where `_` must
  // still match one code point rather than one UTF-16 unit.
  const s = SURROGATE.test(text) ? [...text] : text
  let i = 0; let j = 0; let star = -1; let mark = 0
  while (i < s.length) {
    if (j < p.length && p[j] !== ANY && (p[j] === ONE || p[j] === s[i])) { i++; j++ } else if (j < p.length && p[j] === ANY) { star = j++; mark = i } else if (star !== -1) { j = star + 1; i = ++mark } else return false
  }
  while (j < p.length && p[j] === ANY) j++
  return j === p.length
}

const like = (fold) => fn(([value, pattern]) => {
  if (isNull(value) || isNull(pattern)) return null
  const text = toText(value)
  return likeMatch(fold ? text.toLowerCase() : text, likePattern(toText(pattern), fold))
})

const regexCache = new Map()
function regex (pattern, flags = '') {
  regexAllowed()
  const key = flags + '/' + pattern
  let re = regexCache.get(key)
  if (!re) {
    re = new RegExp(pattern, flags)
    if (regexCache.size > 1000) regexCache.clear()
    regexCache.set(key, re)
  }
  return re
}

// -- dates -----------------------------------------------------------------------

const DATE_UNITS = {
  year: (d) => d.getUTCFullYear(),
  quarter: (d) => Math.floor(d.getUTCMonth() / 3) + 1,
  month: (d) => d.getUTCMonth() + 1,
  week: (d) => isoWeek(d),
  day: (d) => d.getUTCDate(),
  dow: (d) => d.getUTCDay(),
  isodow: (d) => d.getUTCDay() || 7,
  doy: (d) => Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1,
  hour: (d) => d.getUTCHours(),
  minute: (d) => d.getUTCMinutes(),
  second: (d) => d.getUTCSeconds() + d.getUTCMilliseconds() / 1000,
  millisecond: (d) => d.getUTCSeconds() * 1000 + d.getUTCMilliseconds(),
  epoch: (d) => d.getTime() / 1000
}
const UNIT_ALIASES = { years: 'year', months: 'month', days: 'day', hours: 'hour', minutes: 'minute', seconds: 'second', milliseconds: 'millisecond', weeks: 'week', ms: 'millisecond', dayofweek: 'dow', dayofyear: 'doy' }
const unitOf = (u) => { const k = String(u).toLowerCase(); return UNIT_ALIASES[k] || k }

function isoWeek (d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7)
}

function truncDate (unit, d) {
  const y = d.getUTCFullYear(); const m = d.getUTCMonth()
  switch (unitOf(unit)) {
    case 'year': return new Date(Date.UTC(y, 0, 1))
    case 'quarter': return new Date(Date.UTC(y, m - (m % 3), 1))
    case 'month': return new Date(Date.UTC(y, m, 1))
    case 'week': { const day = d.getUTCDay() || 7; return new Date(Date.UTC(y, m, d.getUTCDate() - day + 1)) }
    case 'day': return new Date(Date.UTC(y, m, d.getUTCDate()))
    case 'hour': return new Date(Date.UTC(y, m, d.getUTCDate(), d.getUTCHours()))
    case 'minute': return new Date(Date.UTC(y, m, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()))
    case 'second': return new Date(Math.floor(d.getTime() / 1000) * 1000)
    default: throw new SqlError(`Unknown date unit '${unit}'`)
  }
}

const UNIT_MS = { millisecond: 1, second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 }

/** Dates leave the engine as ISO strings, so results stay JSON. */
const iso = (d) => (d ? d.toISOString() : null)
const isoDate = (d) => (d ? d.toISOString().slice(0, 10) : null)

// -- CAST ---------------------------------------------------------------------------

export function cast (value, type) {
  if (isNull(value)) return null
  switch (String(type).toLowerCase()) {
    case 'int': case 'integer': case 'bigint': case 'smallint': case 'int2': case 'int4': case 'int8': case 'tinyint': {
      const n = toNumber(value)
      return n === null ? null : Math.trunc(n)
    }
    case 'real': case 'float': case 'float4': case 'float8': case 'double': case 'numeric': case 'decimal': case 'number':
      return toNumber(value)
    case 'text': case 'varchar': case 'char': case 'string': case 'character': case 'nvarchar':
      return toText(value)
    case 'bool': case 'boolean': {
      if (typeof value === 'boolean') return value
      if (typeof value === 'number') return value !== 0
      const s = String(value).trim().toLowerCase()
      if (['t', 'true', 'yes', 'y', 'on', '1'].includes(s)) return true
      if (['f', 'false', 'no', 'n', 'off', '0'].includes(s)) return false
      return null
    }
    case 'json': case 'jsonb': case 'object': case 'array': case 'variant':
      return maybeJson(value)
    case 'date': return isoDate(toDate(value))
    case 'timestamp': case 'timestamptz': case 'datetime': return iso(toDate(value))
    default: throw new SqlError(`Unknown type '${type}' in CAST`)
  }
}

// -- the library ----------------------------------------------------------------------

// String and math functions take at most three extra arguments; passing them
// positionally avoids a slice and a spread per call.
const str = (f) => fn((args) => {
  const s = toText(args[0])
  if (s === null) return null
  return args.length === 1 ? f(s) : f(s, args[1], args[2], args[3])
})

const math = (f) => fn((args) => {
  const n = toNumber(args[0])
  if (n === null) return null
  const r = args.length === 1
    ? f(n)
    : f(n, toNumber(args[1]), args.length > 2 ? toNumber(args[2]) : undefined)
  return Number.isFinite(r) ? r : null
})

function roundTo (n, digits = 0) {
  const f = 10 ** (digits ?? 0)
  // Round half away from zero, as SQL does, and dodge 1.005 * 100 = 100.49999.
  return Math.sign(n) * Math.round(Math.abs(n) * f + Number.EPSILON * f) / f
}

// -- compiled operators ----------------------------------------------------------
//
// json-logic-engine's `.build()` only inlines operators that bring a `compile`
// hook; anything else becomes `engine.methods.X.method([args], context)` — a
// lookup and an array allocation per call, per row. Each operator here is a
// positional function plus a hook that compiles `{"EQ": [a, b]}` to a direct
// `eq(a, b)` call, with its arguments compiled inline. `method` stays for
// interpreted mode, which never generates code.

// A function interpolated into compiled code is assumed async unless it carries
// the engine's sync marker (a registered symbol, so no import is needed).
const SYNC = Symbol.for('json_logic_sync')
const sync = (f) => { f[SYNC] = true; return f }

/** `impl(${a}, ${b}, ...)` as compiled code. */
function callCompiled (bs, impl, args) {
  if (!Array.isArray(args)) args = [args]
  let res = bs.compile`${sync(impl)}(`
  for (let i = 0; i < args.length; i++) res = i ? bs.compile`${res}, ${args[i]}` : bs.compile`${res}${args[i]}`
  return bs.compile`${res})`
}

/** A positional operator: `impl(a, b)`. */
const op = (impl, deterministic = true) => ({
  method: (args) => (Array.isArray(args) ? impl(...args) : impl(args)),
  compile: (args, bs) => callCompiled(bs, impl, args),
  deterministic
})

const numeric = (f) => op((x, y) => {
  const a = toNumber(x); const b = toNumber(y)
  if (a === null || b === null) return null
  const r = f(a, b)
  return Number.isFinite(r) ? r : null
})

// -- short-circuit AND / OR -----------------------------------------------------
//
// Measured: inlining comparisons and arithmetic with a literal operand was no
// faster than the engine calling the small operator functions, so only the
// short-circuit is compiled. `prev` is the engine's scratch variable; it is
// read again before anything else can overwrite it.

/** Raw code. */
const code = (bs, text) => bs.compile([text])

/** AND stops at the first FALSE, OR at the first TRUE; anything undecided goes to the full function. */
function shortCircuit (impl, decisive) {
  return (args, bs) => {
    if (!Array.isArray(args) || args.length < 2) return callCompiled(bs, impl, args)
    let acc = args[args.length - 1]
    for (let i = args.length - 2; i >= 0; i--) {
      acc = bs.compile`((prev = ${args[i]}) === ${code(bs, String(decisive))} ? ${code(bs, String(decisive))} : ${sync(impl)}(prev, ${acc}))`
    }
    return acc
  }
}

// Each comparison written out: numbers against numbers and strings against
// strings compare directly; everything else goes through compare().
const isNil = (v) => v === null || v === undefined
const same = (a, b) => (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string')
const lt = (a, b) => (isNil(a) || isNil(b) ? null : same(a, b) ? a < b : compare(a, b) < 0)
const le = (a, b) => (isNil(a) || isNil(b) ? null : same(a, b) ? a <= b : compare(a, b) <= 0)
const gt = (a, b) => (isNil(a) || isNil(b) ? null : same(a, b) ? a > b : compare(a, b) > 0)
const ge = (a, b) => (isNil(a) || isNil(b) ? null : same(a, b) ? a >= b : compare(a, b) >= 0)

function eq (a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null
  if (a === b) return true
  if (typeof a === typeof b && typeof a !== 'object') return false
  return compare(a, b) === 0
}

function and () {
  let sawNull = false
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i]
    if (v === true) continue
    if (v === false) return false
    if (v === null || v === undefined) sawNull = true
    else if (!isTrue(v)) return false
  }
  return sawNull ? null : true
}

function or () {
  let sawNull = false
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i]
    if (v === true) return true
    if (v === null || v === undefined) sawNull = true
    else if (isTrue(v)) return true
  }
  return sawNull ? null : false
}

// `x IN (:ids)` with an array bound to `:ids` is membership in that array, as most database
// drivers expand it. A single non-array operand is the ordinary one-element list.
function inList (v) {
  if (isNull(v)) return null
  const list = arguments.length === 2 && Array.isArray(arguments[1]) ? arguments[1] : Array.prototype.slice.call(arguments, 1)
  let sawNull = false
  for (let i = 0; i < list.length; i++) {
    const e = equals(v, list[i])
    if (e) return true
    if (e === null) sawNull = true
  }
  return sawNull ? null : false
}

const own = Object.prototype.hasOwnProperty

export const operators = {
  // Column access. `PATH` walks into nested values and JSON text; its keys are
  // constants, so each call site compiles to a closure over them.
  PATH: {
    method: (args) => walk(args[0], args, 1),
    compile: (args, bs) => {
      const keys = args.slice(1)
      if (keys.some((k) => k !== null && typeof k === 'object')) return false
      const path = [null, ...keys]
      return bs.compile`${sync((v) => walk(v, path, 1))}(${args[0]})`
    },
    deterministic: true
  },
  // An unqualified column among several joined sources, found at run time.
  COL: {
    method: (args, context) => findColumn(context, args[0], args, 1),
    compile: (args, bs) => {
      if (args.some((a) => typeof a !== 'string')) return false
      const name = args[0]
      return bs.compile`${sync((context) => findColumn(context, name, args, 1))}(context)`
    },
    deterministic: false
  },

  ROW_VALUE: op((row) => {
    if (row !== null && typeof row === 'object' && !Array.isArray(row)) return own.call(row, 'value') ? row.value : null
    return row === undefined ? null : row
  }),

  // CASE takes a branch on the same truthiness WHERE uses.
  TRUTHY: op(isTrue),

  EQ: op(eq),
  NE: op((a, b) => { const e = eq(a, b); return e === null ? null : !e }),
  LT: op(lt),
  LE: op(le),
  GT: op(gt),
  GE: op(ge),
  BETWEEN: op((v, lo, hi) => {
    if (isNull(v) || isNull(lo) || isNull(hi)) return null
    return compare(v, lo) >= 0 && compare(v, hi) <= 0
  }),
  IN: op(inList),
  LIKE: like(false),
  ILIKE: like(true),
  IS_NULL: op((v) => v === null || v === undefined),
  IS_TRUE: op((v) => v === true),
  IS_FALSE: op((v) => v === false),
  IS_DISTINCT: op((a, b) => {
    if (isNull(a) && isNull(b)) return false
    if (isNull(a) || isNull(b)) return true
    return !equals(a, b)
  }),

  AND: { ...op(and), compile: shortCircuit(and, false) },
  OR: { ...op(or), compile: shortCircuit(or, true) },
  NOT: op((v) => (v === null || v === undefined ? null : !isTrue(v))),

  ADD: numeric((a, b) => a + b),
  SUB: numeric((a, b) => a - b),
  MUL: numeric((a, b) => a * b),
  // Division by zero is NULL rather than an error, as in SQLite and MySQL.
  DIV: numeric((a, b) => (b === 0 ? null : a / b)),
  MOD: numeric((a, b) => (b === 0 ? null : a % b)),
  NEG: op((a) => { const n = toNumber(a); return n === null ? null : -n }),
  POS: op((a) => toNumber(a)),
  STRCAT: op((a, b) => (isNull(a) || isNull(b) ? null : built(toText(a) + toText(b)))),

  CAST: op(cast),
  // `->` keeps JSON as JSON; `->>` hands back text.
  JSON_GET: op((v, k) => step(v, k)),
  JSON_TEXT: op((v, k) => toText(step(v, k)))
}

function findColumn (context, name, aliases, from) {
  for (let i = from; i < aliases.length; i++) {
    const row = context[aliases[i]]
    if (row !== null && typeof row === 'object' && own.call(row, name)) return row[name]
  }
  return null
}

export const functions = {
  // -- strings
  LOWER: str((s) => s.toLowerCase()),
  UPPER: str((s) => s.toUpperCase()),
  LENGTH: str(codePoints),
  CHAR_LENGTH: str(codePoints),
  LEN: str(codePoints),
  TRIM: str((s, chars) => (chars == null ? s.trim() : s.replace(regex(`^[${escapeClass(chars)}]+|[${escapeClass(chars)}]+$`, 'g'), ''))),
  LTRIM: str((s, chars) => (chars == null ? s.trimStart() : s.replace(regex(`^[${escapeClass(chars)}]+`), ''))),
  RTRIM: str((s, chars) => (chars == null ? s.trimEnd() : s.replace(regex(`[${escapeClass(chars)}]+$`), ''))),
  SUBSTR: str((s, start, len) => substr(s, start, len)),
  SUBSTRING: str((s, start, len) => substr(s, start, len)),
  LEFT: str((s, n) => sliceCodePoints(s, 0, Math.max(0, toNumber(n) ?? 0))),
  RIGHT: str((s, n) => { n = toNumber(n) ?? 0; return n <= 0 ? '' : sliceCodePoints(s, -n) }),
  REPLACE: str((s, from, to) => {
    if (isNull(from) || isNull(to)) return null
    const f = toText(from)
    return f === '' ? s : built(s.split(f).join(toText(to)))
  }),
  REVERSE: str((s) => {
    if (SURROGATE.test(s)) return [...s].reverse().join('')
    let r = ''
    for (let i = s.length - 1; i >= 0; i--) r += s[i]
    return r
  }),
  REPEAT: str((s, n) => {
    const k = Math.max(0, Math.floor(toNumber(n) ?? 0))
    stringLength(s.length * k)
    return s.repeat(k)
  }),
  LPAD: str((s, n, fill = ' ') => pad(s, n, fill, true)),
  RPAD: str((s, n, fill = ' ') => pad(s, n, fill, false)),
  STRPOS: str((s, sub) => s.indexOf(toText(sub)) + 1),
  INSTR: str((s, sub) => s.indexOf(toText(sub)) + 1),
  POSITION: str((s, sub) => s.indexOf(toText(sub)) + 1),
  STARTS_WITH: str((s, p) => s.startsWith(toText(p))),
  ENDS_WITH: str((s, p) => s.endsWith(toText(p))),
  SPLIT_PART: str((s, sep, n) => {
    const parts = s.split(toText(sep))
    const i = toNumber(n)
    const v = i > 0 ? parts[i - 1] : parts[parts.length + i]
    return v === undefined ? '' : v
  }),
  SPLIT: str((s, sep) => s.split(toText(sep))),
  STRING_TO_ARRAY: str((s, sep) => s.split(toText(sep))),
  CONCAT: fn((args) => {
    let s = ''
    for (let i = 0; i < args.length; i++) { const t = toText(args[i]); if (t !== null) s += t }
    return built(s)
  }),
  CONCAT_WS: fn((args) => {
    if (isNull(args[0])) return null
    const sep = toText(args[0])
    let s = ''; let first = true
    for (let i = 1; i < args.length; i++) {
      if (isNull(args[i])) continue
      s += (first ? '' : sep) + toText(args[i])
      first = false
    }
    return built(s)
  }),
  REGEXP_LIKE: str((s, p, flags) => regex(toText(p), flags ?? '').test(s)),
  REGEXP_REPLACE: str((s, p, to, flags = 'g') => built(s.replace(regex(toText(p), flags), toText(to) ?? ''))),
  REGEXP_EXTRACT: str((s, p, group = 0) => {
    const m = regex(toText(p)).exec(s)
    return m ? (m[toNumber(group)] ?? null) : null
  }),

  // -- nulls and conditionals
  COALESCE: fn((args) => { for (let i = 0; i < args.length; i++) if (!isNull(args[i])) return args[i]; return null }),
  IFNULL: fn(([a, b]) => (isNull(a) ? b : a)),
  NVL: fn(([a, b]) => (isNull(a) ? b : a)),
  NULLIF: fn(([a, b]) => (equals(a, b) ? null : a)),
  IF: fn(([c, a, b = null]) => (isTrue(c) ? a : b)),
  IIF: fn(([c, a, b = null]) => (isTrue(c) ? a : b)),
  GREATEST: fn((args) => extreme(args, 1)),
  LEAST: fn((args) => extreme(args, -1)),

  // -- math
  ABS: math(Math.abs),
  ROUND: math((n, d) => roundTo(n, d)),
  FLOOR: math(Math.floor),
  CEIL: math(Math.ceil),
  CEILING: math(Math.ceil),
  TRUNC: math((n, d = 0) => Math.trunc(n * 10 ** (d ?? 0)) / 10 ** (d ?? 0)),
  TRUNCATE: math((n, d = 0) => Math.trunc(n * 10 ** (d ?? 0)) / 10 ** (d ?? 0)),
  SIGN: math(Math.sign),
  SQRT: math(Math.sqrt),
  EXP: math(Math.exp),
  LN: math(Math.log),
  LOG10: math(Math.log10),
  LOG: fn((args) => {
    const a = toNumber(args[0])
    if (a === null) return null
    if (args.length === 1) { const r = Math.log10(a); return Number.isFinite(r) ? r : null }
    const b = toNumber(args[1])
    if (b === null) return null
    const r = Math.log(b) / Math.log(a)
    return Number.isFinite(r) ? r : null
  }),
  POWER: math((a, b) => a ** b),
  POW: math((a, b) => a ** b),
  RANDOM: fn(() => Math.random(), false),
  PI: fn(() => Math.PI),

  // -- types
  CAST: fn(([v, t]) => cast(v, t)),
  TYPEOF: fn(([v]) => {
    v = v === undefined ? null : v
    if (v === null) return 'null'
    if (Array.isArray(v)) return 'array'
    return typeof v
  }),

  // -- dates (UTC; text in, ISO text out)
  NOW: fn(() => new Date().toISOString(), false),
  CURRENT_TIMESTAMP: fn(() => new Date().toISOString(), false),
  CURRENT_DATE: fn(() => new Date().toISOString().slice(0, 10), false),
  DATE: fn(([v]) => isoDate(toDate(v))),
  TIMESTAMP: fn(([v]) => iso(toDate(v))),
  TO_TIMESTAMP: fn(([v]) => { const n = toNumber(v); return n === null ? iso(toDate(v)) : iso(new Date(n * 1000)) }),
  DATE_TRUNC: fn(([unit, v]) => { const d = toDate(v); return d ? iso(truncDate(unit, d)) : null }),
  DATE_PART: fn(([unit, v]) => {
    const d = toDate(v)
    if (!d) return null
    const f = DATE_UNITS[unitOf(unit)]
    if (!f) throw new SqlError(`Unknown date part '${unit}'`)
    return f(d)
  }),
  // DATE_DIFF('day', a, b) — whole units from a to b.
  DATE_DIFF: fn(([unit, a, b]) => dateDiff(unit, a, b)),
  DATEDIFF: fn(([unit, a, b]) => dateDiff(unit, a, b)),
  DATE_ADD: fn(([v, n, unit = 'day']) => {
    const d = toDate(v); const k = toNumber(n)
    if (!d || k === null) return null
    const u = unitOf(unit)
    if (u === 'month' || u === 'year' || u === 'quarter') {
      // Clamp to the end of the month: Jan 31 + 1 month is Feb 28, not Mar 3.
      const months = d.getUTCMonth() + k * (u === 'year' ? 12 : u === 'quarter' ? 3 : 1)
      const y = d.getUTCFullYear() + Math.floor(months / 12)
      const m = ((months % 12) + 12) % 12
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
      const r = new Date(d); r.setUTCFullYear(y, m, Math.min(d.getUTCDate(), last)); return iso(r)
    }
    if (!UNIT_MS[u]) throw new SqlError(`Unknown date unit '${unit}'`)
    return iso(new Date(d.getTime() + k * UNIT_MS[u]))
  }),
  EPOCH_MS: fn(([v]) => { const d = toDate(v); return d ? d.getTime() : null }),
  STRFTIME: fn(([format, v]) => { const d = toDate(v); return d ? strftime(toText(format), d) : null }),

  // -- JSON and nested values
  JSON_EXTRACT: fn(([v, path]) => walk(v, jsonPath(path))),
  JSON_VALUE: fn(([v, path]) => { const r = walk(v, jsonPath(path)); return r !== null && typeof r === 'object' ? null : r }),
  JSON_PARSE: fn(([v]) => maybeJson(v)),
  PARSE_JSON: fn(([v]) => maybeJson(v)),
  TO_JSON: fn(([v]) => (v === undefined ? null : JSON.stringify(v))),
  JSON_KEYS: fn(([v]) => { v = maybeJson(v); return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : null }),
  JSON_TYPE: fn(([v]) => { v = maybeJson(v); return isNull(v) ? 'null' : Array.isArray(v) ? 'array' : typeof v }),
  JSON_OBJECT: fn((args) => { const o = {}; for (let i = 0; i + 1 < args.length; i += 2) setKey(o, toText(args[i]), args[i + 1] ?? null); return o }),
  JSON_ARRAY: fn(arrayOf),
  ARRAY: fn(arrayOf),
  ARRAY_LENGTH: fn(([v]) => { v = maybeJson(v); return Array.isArray(v) ? v.length : null }),
  JSON_ARRAY_LENGTH: fn(([v]) => { v = maybeJson(v); return Array.isArray(v) ? v.length : null }),
  CARDINALITY: fn(([v]) => { v = maybeJson(v); return Array.isArray(v) ? v.length : null }),
  ARRAY_CONTAINS: fn(([v, x]) => { v = maybeJson(v); return Array.isArray(v) ? containsEqual(v, x) : null }),
  CONTAINS: fn(([v, x]) => {
    v = maybeJson(v)
    if (isNull(v) || isNull(x)) return null
    if (Array.isArray(v)) return containsEqual(v, x)
    return toText(v).includes(toText(x))
  }),
  ARRAY_JOIN: fn(([v, sep = ',']) => {
    v = maybeJson(v)
    if (!Array.isArray(v)) return null
    const glue = toText(sep)
    let s = ''; let first = true
    for (let i = 0; i < v.length; i++) {
      if (isNull(v[i])) continue
      s += (first ? '' : glue) + toText(v[i])
      first = false
    }
    return built(s)
  }),
  ARRAY_DISTINCT: fn(([v]) => {
    v = maybeJson(v)
    if (!Array.isArray(v)) return null
    const seen = new Set(); const out = []
    for (let i = 0; i < v.length; i++) { const k = keyOf(v[i]); if (!seen.has(k)) { seen.add(k); out.push(v[i]) } }
    return out
  }),
  ELEMENT_AT: fn(([v, i]) => { const n = toNumber(i); return n === null ? null : step(v, n > 0 ? n - 1 : n) })
}

/** A string a function just built, checked against limits.maxStringLength. */
function built (s) {
  stringLength(s.length)
  return s
}

export { checkRows }

function escapeClass (chars) { return String(chars).replace(/[\]\\^-]/g, '\\$&') }

function substr (s, start, len) {
  let from = (toNumber(start) ?? 1) - 1
  const to = len == null ? Infinity : from + toNumber(len)
  if (from < 0) from = 0
  if (to < from) return ''
  return sliceCodePoints(s, from, to === Infinity ? undefined : to)
}

function pad (s, n, fill, left) {
  n = toNumber(n)
  if (n === null) return null
  stringLength(n)
  fill = toText(fill)
  if (s.length >= n) return s.slice(0, n)
  if (!fill) return s
  const padding = fill.repeat(Math.ceil((n - s.length) / fill.length)).slice(0, n - s.length)
  return left ? padding + s : s + padding
}

function extreme (args, sign) {
  let best = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!isNull(a) && (best === null || compare(a, best) * sign > 0)) best = a
  }
  return best
}

function arrayOf (args) {
  const out = new Array(args.length)
  for (let i = 0; i < args.length; i++) out[i] = args[i] === undefined ? null : args[i]
  return out
}

function containsEqual (list, x) {
  for (let i = 0; i < list.length; i++) if (equals(list[i], x)) return true
  return false
}

function dateDiff (unit, a, b) {
  const x = toDate(a); const y = toDate(b)
  if (!x || !y) return null
  const u = unitOf(unit)
  if (u === 'year') return y.getUTCFullYear() - x.getUTCFullYear()
  if (u === 'month') return (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + y.getUTCMonth() - x.getUTCMonth()
  if (u === 'quarter') return Math.trunc(((y.getUTCFullYear() - x.getUTCFullYear()) * 12 + y.getUTCMonth() - x.getUTCMonth()) / 3)
  if (!UNIT_MS[u]) throw new SqlError(`Unknown date unit '${unit}'`)
  return Math.trunc((y - x) / UNIT_MS[u])
}

/** `$.a.b[0]`, `$.a["k"]`, `a.b` -> path keys. */
function jsonPath (path) {
  const keys = []
  const s = toText(path) ?? ''
  const re = /\.([A-Za-z_$][\w$]*)|\[(\d+|\*)\]|\[["']([^"']*)["']\]|^([A-Za-z_][\w$]*)/g
  let m
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) keys.push(m[1])
    else if (m[2] !== undefined) keys.push(m[2] === '*' ? '[*]' : Number(m[2]))
    else if (m[3] !== undefined) keys.push(m[3])
    else if (m[4] !== undefined) keys.push(m[4])
  }
  return keys
}

function strftime (format, d) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return format.replace(/%([YmdHMSjfwsF%T])/g, (_, c) => {
    switch (c) {
      case 'Y': return d.getUTCFullYear()
      case 'm': return p(d.getUTCMonth() + 1)
      case 'd': return p(d.getUTCDate())
      case 'H': return p(d.getUTCHours())
      case 'M': return p(d.getUTCMinutes())
      case 'S': return p(d.getUTCSeconds())
      case 'f': return p(d.getUTCMilliseconds(), 3)
      case 'j': return p(DATE_UNITS.doy(d), 3)
      case 'w': return d.getUTCDay()
      case 's': return Math.floor(d.getTime() / 1000)
      case 'F': return d.toISOString().slice(0, 10)
      case 'T': return d.toISOString().slice(11, 19)
      default: return '%'
    }
  })
}
