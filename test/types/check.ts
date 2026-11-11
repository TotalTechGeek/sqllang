// Compiled with `tsc --noEmit --strict` (npm run test:types); never run.
// Each line is something a user would write; the @ts-expect-error lines must fail.
import {
  query, prepare, execute, compile, executePlan, createEngine,
  SAFE_LIMITS, SqlError, SqlSyntaxError, SqlLimitError,
  type Row, type Rows, type Plan, type Limits
} from 'sqllang'

const orders = [{ id: 1, total: 120 }]

const rows: Rows = query('SELECT id, total FROM orders', { orders })
const columns: string[] = rows.columns
const first: Row | undefined = rows[0]

interface Order { id: number, total: number }
const typed = query<{ id: number, total: number }>('SELECT id, total FROM orders', { orders })
const n: number = typed[0].total

query('SELECT * FROM data', orders)
query('SELECT * FROM t WHERE id = ?', { t: orders }, { params: [1] })
query('SELECT * FROM t WHERE id = :id', { t: orders }, { params: { id: 1 }, limits: SAFE_LIMITS })
query('SELECT * FROM t', { t: orders }, { interpreted: true, limits: { timeoutMs: 50, regex: false } })

const p = prepare('SELECT id FROM t')
const again: Rows<Order> = p.query<Order>({ t: orders })
const plan: Plan = p.plan
const stored: Plan = JSON.parse(JSON.stringify(compile('SELECT 1')))
executePlan(stored, {}).results.forEach((r) => r.columns)

const { results, tables } = execute("INSERT INTO t VALUES (1); SELECT * FROM t", {})
const loaded: Row[] | undefined = tables.get('t')
results.length.toFixed()

const engine = createEngine({ functions: { SLUG: ([s]) => String(s).toLowerCase() } })
engine.sqlFunctions.has('SLUG')
query('SELECT SLUG(name) FROM t', { t: [] }, { engine })

const limits: Limits = { ...SAFE_LIMITS, maxRows: 10 }

try { compile('SELECT') } catch (e) {
  if (e instanceof SqlSyntaxError) e.location.start.column.toFixed()
  if (e instanceof SqlLimitError) { const which: 'timeoutMs' | 'maxRows' | 'maxStringLength' | 'maxQueryLength' | 'regex' | 'depth' = e.limit }
  if (e instanceof SqlError) e.message.trim()
}

// @ts-expect-error — SQL must be a string
query(42, {})
// @ts-expect-error — no such option
query('SELECT 1', {}, { paramz: [] })
// @ts-expect-error — limits are numbers
query('SELECT 1', {}, { limits: { maxRows: 'lots' } })
// @ts-expect-error — columns is read-only
rows.columns = []

void [columns, first, n, again, plan, loaded, limits]
