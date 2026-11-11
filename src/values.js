/**
 * Value semantics shared by the operators, functions and executor: SQL NULL,
 * comparison and equality across loosely-typed data, JSON-in-a-string columns,
 * and timestamps written the way databases dump them.
 */

export const isNull = (v) => v === null || v === undefined

/**
 * Set a key on a fresh object without letting the key reach the prototype.
 * `o['__proto__'] = v` replaces o's prototype instead of adding a field; data
 * (JSON.parse makes `__proto__` an ordinary own key) and aliases can both
 * carry that name, so every object built from user-controlled keys uses this.
 */
export function setKey (o, k, v) {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true })
  else o[k] = v
}

// -- JSON stored as text ------------------------------------------------------
//
// Wide tables exported from a database usually carry their nested data as JSON
// strings (`properties`, `context`, `metadata` ...). Navigating into one parses
// it, and the parse is cached, since a query typically reads several fields out
// of the same blob per row.

const jsonCache = new Map()
const JSON_CACHE_LIMIT = 4096

export function maybeJson (value) {
  if (typeof value !== 'string') return value
  const c = value.charCodeAt(0)
  // `{` or `[` — anything else is plain text, not a document.
  if (c !== 123 && c !== 91) return value
  const hit = jsonCache.get(value)
  if (hit !== undefined) return hit
  let parsed
  try { parsed = JSON.parse(value) } catch { parsed = value }
  if (jsonCache.size >= JSON_CACHE_LIMIT) jsonCache.clear()
  jsonCache.set(value, parsed)
  return parsed
}

const own = Object.prototype.hasOwnProperty

/** One step of a path: a key, an index, or `[*]` (every element). */
export function step (value, key) {
  value = maybeJson(value)
  if (isNull(value)) return null
  if (key === '[*]') {
    if (Array.isArray(value)) return value
    if (typeof value === 'object') return Object.values(value)
    return null
  }
  if (Array.isArray(value)) {
    if (typeof key === 'number') {
      const v = value[key < 0 ? value.length + key : key]
      return v === undefined ? null : v
    }
    return null
  }
  if (typeof value === 'object') {
    const k = typeof key === 'number' ? String(key) : key
    return own.call(value, k) ? value[k] : null
  }
  return null
}

/**
 * Follow a path. After a `[*]`, the rest of the path maps over every element,
 * so `items[*].sku` is the array of skus.
 */
export function walk (value, keys, from = 0) {
  for (let i = from; i < keys.length; i++) {
    const key = keys[i]
    value = step(value, key)
    if (key === '[*]') {
      if (value === null) return null
      const out = []
      for (let j = 0; j < value.length; j++) out.push(walk(value[j], keys, i + 1))
      return out
    }
    if (value === null) return null
  }
  return value === undefined ? null : value
}

// -- timestamps ----------------------------------------------------------------

// 2026-06-30, 2026-06-30 16:33:13, 2026-06-30T16:33:13.070000+00:00,
// 2026-06-30 16:33:13.070000 +00:00 — Postgres' text output and ISO 8601 both.
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i

export function toDate (value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') return new Date(value)
  if (typeof value !== 'string') return null
  const m = TIMESTAMP.exec(value.trim())
  if (!m) return null
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', zone] = m
  const ms = frac ? Math.round(Number('0.' + frac) * 1000) : 0
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms)
  if (zone && zone.toUpperCase() !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1
    const digits = zone.slice(1).replace(':', '')
    const offset = (+digits.slice(0, 2)) * 60 + (+(digits.slice(2) || 0))
    t -= sign * offset * 60000
  }
  return new Date(t)
}

// -- numbers -------------------------------------------------------------------

const NUMERIC = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/

/** A number, or null when the value has no numeric reading. */
export function toNumber (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (isNull(value)) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') return NUMERIC.test(value) ? Number(value) : null
  if (value instanceof Date) return value.getTime()
  return null
}

export const isNumericString = (v) => typeof v === 'string' && NUMERIC.test(v)

// -- text ------------------------------------------------------------------------

export function toText (value) {
  if (isNull(value)) return null
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// -- comparison ------------------------------------------------------------------

/** A stable key for grouping, DISTINCT and set operations. */
export function keyOf (value) {
  if (value === undefined) return 'null'
  if (value instanceof Date) return 'd' + value.getTime()
  if (typeof value === 'object' && value !== null) return 'j' + JSON.stringify(value)
  return typeof value === 'string' ? 's' + value : String(value)
}

export const rowKey = (values) => {
  let key = ''
  for (let i = 0; i < values.length; i++) key += keyOf(values[i]) + '\u0000'
  return key
}

/**
 * Three-way comparison of two non-null values. Numbers compare numerically —
 * against numeric strings too, since dumped data is often text — and strings
 * by code unit. Mixed, otherwise unrelated types order by type name so a sort
 * is still total.
 */
export function compare (a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'number' && isNumericString(b)) return compare(a, Number(b))
  if (typeof b === 'number' && isNumericString(a)) return compare(Number(a), b)
  if (a instanceof Date || b instanceof Date) {
    const x = toDate(a); const y = toDate(b)
    if (x && y) return compare(x.getTime(), y.getTime())
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1
  if (typeof a === 'object' && typeof b === 'object') return compare(JSON.stringify(a), JSON.stringify(b))
  const ta = typeof a; const tb = typeof b
  if (ta !== tb) return ta < tb ? -1 : 1
  return compare(String(a), String(b))
}

/** SQL `=`: NULL when either side is NULL. */
export function equals (a, b) {
  if (isNull(a) || isNull(b)) return null
  if (a === b) return true
  return compare(a, b) === 0
}

/** For ORDER BY: NULLs last ascending and first descending, as in Postgres. */
export function sortCompare (a, b, desc, nullsFirst) {
  const an = isNull(a); const bn = isNull(b)
  if (an || bn) {
    if (an && bn) return 0
    const nf = nullsFirst ?? desc
    return an ? (nf ? -1 : 1) : (nf ? 1 : -1)
  }
  const c = compare(a, b)
  return desc ? -c : c
}

/** SQL truthiness for WHERE / HAVING / ON: only TRUE passes. */
export const isTrue = (v) => v === true || (typeof v === 'number' && v !== 0 && !Number.isNaN(v))
