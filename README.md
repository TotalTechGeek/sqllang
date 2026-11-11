# sqllang

[![CI](https://github.com/TotalTechGeek/sqllang/actions/workflows/ci.yml/badge.svg)](https://github.com/TotalTechGeek/sqllang/actions/workflows/ci.yml)

**SQL over your own data.** Query arrays of rows, columnar tables and nested
documents with a familiar SQL dialect — no database, no schema, no loading step.

```js
import { query } from 'sqllang'

query(`
  SELECT c.city, COUNT(*) AS orders, SUM(o.total) AS revenue
  FROM orders o
  JOIN customers c ON c.name = o.customer
  WHERE o.meta.src = 'web'            -- meta is a JSON string; paths parse it
  GROUP BY c.city
  ORDER BY revenue DESC
`, { orders, customers })
// [ { city: 'Lisbon', orders: 2, revenue: 210 }, ... ]
```

It is the SQL sibling of [sheetlang](../formulas): the grammar is a
[grammatik](../jl-grammar-claude) `.gram` file, every expression compiles to
JSON Logic, and [json-logic-engine](https://github.com/TotalTechGeek/json-logic-engine)
runs it. A compiled query is a plain JSON plan you can store and run later.

## Install

```bash
npm install sqllang
```

```js
import { query } from 'sqllang'       // ESM
const { query } = require('sqllang')  // CommonJS
```

TypeScript types are included. The only runtime dependency is `json-logic-engine`.
Node 18+ or any modern bundler; about 36 KB minified and gzipped, plus the engine.

## Data

`data` is an object of tables. A table can be:

| shape | example |
| --- | --- |
| rows | `[{ id: 1, name: 'a' }, { id: 2, name: 'b' }]` |
| columnar | `{ id: [1, 2], name: ['a', 'b'] }` (every value an array, same length) |
| header row | `[['id', 'name'], [1, 'a'], [2, 'b']]` |
| a document | `{ id: 1, items: [...] }` — one row |
| JSON text | any of the above as a string |

A bare array is the table `data`: `query('SELECT * FROM data', rows)`.

A table name is a path, so documents nest: `FROM report.sections[0].rows`.
Keys containing dots work too — `FROM analytics.events` finds the key
`'analytics.events'` before trying `analytics` → `events`.

### Nested values and JSON-in-a-column

Wide tables exported from a database usually carry nested data as JSON strings.
Paths walk straight into them:

```sql
SELECT properties.metadata.dom.id,      -- dotted path, parses the JSON text
       properties->>'label',             -- Postgres arrows work too
       context.screen.width,
       tags[0], items[*].sku,            -- index, or every element
       "column with spaces"
FROM activity
```

### Lateral joins over nested arrays

A FROM item that is a path into an earlier alias ranges over that array:

```sql
SELECT o.id, i.sku, i.qty
FROM orders o, o.items i                 -- one row per item
WHERE i.qty > 1

SELECT a.id, anc.id AS ancestor
FROM activity a, a.properties.metadata.dom.ancestors anc
```

Also `UNNEST(expr)`, `GENERATE_SERIES(from, to[, step])` and `JSON_EACH(obj)`
(rows of `{ key, value }`). An element that is a plain value is the column `value`.

### Loading a SQL dump

A script can `INSERT` and then query, so a database dump runs as is:

```js
query(readFileSync('dump.sql', 'utf8') + '; SELECT event, COUNT(*) FROM analytics.events GROUP BY 1', {})
```

INSERT never mutates your data; `execute()` returns the tables it built.

## The dialect

Mostly Postgres-flavoured, with a few SQLite conveniences.

- `SELECT [DISTINCT] … FROM … WHERE … GROUP BY … HAVING … ORDER BY … LIMIT … OFFSET …`
- joins: `[INNER] | LEFT | RIGHT | FULL [OUTER] | CROSS JOIN`, `ON` or `USING (…)`, comma joins.
  Equality conditions run as hash joins.
- `WITH` (CTEs), subqueries in FROM, scalar / `EXISTS` / `IN (SELECT …)` subqueries, correlated ones too
- `UNION [ALL]`, `EXCEPT [ALL]`, `INTERSECT [ALL]`, `VALUES (…), (…)`
- `CASE`, `CAST(x AS type)` and `x::type`, `EXTRACT(part FROM ts)`, `||`, `LIKE`, `ILIKE`,
  `BETWEEN`, `IN`, `IS [NOT] NULL | TRUE | FALSE | DISTINCT FROM`
- aggregates with `DISTINCT`, `FILTER (WHERE …)` and `ORDER BY` inside:
  `STRING_AGG(name, ', ' ORDER BY name)`
- window functions: `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `PERCENT_RANK`, `CUME_DIST`, `NTILE`,
  `LAG`, `LEAD`, `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE`, and any aggregate `OVER (PARTITION BY … ORDER BY …)`
  (default frame: running to the current row's peers when ordered, the whole partition otherwise)
- parameters: `?`, `$1`, `:name`
- comments: `-- …` and `/* … */`; identifiers `"quoted"` or `` `backticked` ``

`ORDER BY` and `GROUP BY` accept select-list aliases and positions; `HAVING` accepts aliases.

### Semantics worth knowing

- **NULL** is SQL NULL: comparisons with it are NULL, `AND`/`OR` are three-valued, and only
  TRUE passes `WHERE`. A missing key is NULL.
- **Loose typing**, because data is: `1 = '1'` is true and numeric strings sort as numbers
  against numbers. `/` is always real division; division by zero is NULL.
- **NULLs sort last** ascending and first descending (Postgres); say `NULLS FIRST|LAST` to choose.
- **Identifiers are case-sensitive** (they are JSON keys). Keywords are not. Table names fall back
  to a case-insensitive match.
- **Timestamps** are text in, ISO text out. Parsing accepts ISO 8601 and Postgres' output format
  (`2026-06-30 16:33:13.070000 +00:00`). Date functions work in UTC.
- `SELECT *` over rows of different shapes returns the union of their keys, NULL-filled.

### Functions

Strings: `LOWER UPPER LENGTH TRIM LTRIM RTRIM SUBSTR LEFT RIGHT REPLACE REVERSE REPEAT LPAD RPAD
STRPOS SPLIT_PART SPLIT CONCAT CONCAT_WS STARTS_WITH ENDS_WITH REGEXP_LIKE REGEXP_REPLACE REGEXP_EXTRACT`

Nulls & logic: `COALESCE IFNULL NVL NULLIF IF IIF GREATEST LEAST`

Math: `ABS ROUND FLOOR CEIL TRUNC SIGN SQRT EXP LN LOG LOG10 POWER RANDOM PI`

Dates: `NOW CURRENT_DATE DATE TIMESTAMP TO_TIMESTAMP DATE_TRUNC DATE_PART DATE_DIFF DATE_ADD EPOCH_MS STRFTIME`

JSON & arrays: `JSON_EXTRACT JSON_VALUE JSON_PARSE TO_JSON JSON_KEYS JSON_TYPE JSON_OBJECT JSON_ARRAY
ARRAY ARRAY_LENGTH CARDINALITY ARRAY_CONTAINS CONTAINS ARRAY_JOIN ARRAY_DISTINCT ELEMENT_AT`

Aggregates: `COUNT SUM TOTAL AVG MIN MAX MEDIAN MODE STDDEV STDDEV_POP VARIANCE VAR_POP
ARRAY_AGG STRING_AGG GROUP_CONCAT BOOL_AND BOOL_OR COUNT_IF ANY_VALUE FIRST LAST OBJECT_AGG`

Add your own:

```js
import { createEngine, query } from 'sqllang'
const engine = createEngine({ functions: { SLUG: ([s]) => s.toLowerCase().replace(/\W+/g, '-') } })
query('SELECT SLUG(title) FROM posts', { posts }, { engine })
```

## Running queries you didn't write

Some protections are always on:

- **No prototype tricks.** Columns, tables and parameters are own keys only, so
  `constructor` is just a missing column. Objects built from data or aliases
  (`AS "__proto__"`, `JSON_OBJECT`, `OBJECT_AGG`, a `__proto__` key in JSON) get
  an ordinary field, never a new prototype.
- **LIKE cannot hang.** It is matched directly, not through a RegExp, so a
  pattern like `'%a%a%a%a%a%b'` is linear-ish instead of exponential.
- **Deep nesting is an error**, not a stack overflow.
- Queries only call the listed functions. They cannot reach JavaScript.

Resource limits are opt-in, because only you know what is reasonable:

```js
import { query, SAFE_LIMITS } from 'sqllang'

query(userSql, data, { limits: SAFE_LIMITS })
// { timeoutMs: 1000, maxRows: 1e6, maxStringLength: 1e6, maxQueryLength: 20000, regex: false }

query(userSql, data, { limits: { ...SAFE_LIMITS, timeoutMs: 200 } })
```

| limit | stops |
| --- | --- |
| `timeoutMs` | slow queries — checked inside joins, filters, grouping, windows and subqueries |
| `maxRows` | any single step producing too many rows: a cross join, a `GENERATE_SERIES(1, 1e12)` (refused before it is built), the result |
| `maxStringLength` | `REPEAT`, `LPAD`, `\|\|`, `CONCAT`, `STRING_AGG`, `REPLACE` building huge strings |
| `maxQueryLength` | oversized SQL text, checked before parsing |
| `regex: false` | `REGEXP_LIKE` / `REGEXP_REPLACE` / `REGEXP_EXTRACT`. JavaScript cannot interrupt a running regex, so a hostile pattern can hang the process regardless of `timeoutMs`. Turn this off for untrusted SQL. |

Exceeding a limit throws `SqlLimitError` (a `SqlError`) with `.limit` naming which one.

What the limits don't cover: memory is bounded only indirectly (by `maxRows` and
`maxStringLength`), a single sort of `maxRows` rows can't be interrupted, and the
timeout is cooperative, checked every 1024 units of work. For hard isolation of hostile
input, also run the query in a worker you can terminate.

## API

| | |
| --- | --- |
| `query(sql, data, options?)` | Rows of the last statement, as objects. `rows.columns` lists the columns in order. |
| `execute(sql, data, options?)` | `{ results, tables }` — every statement's result, and the tables INSERT built. |
| `prepare(sql, options?)` | Compile once: `{ plan, query(data, params), execute(data, params) }`. |
| `compile(sql)` | The JSON plan. |
| `executePlan(plan, data, options?)` | Run a stored plan. |
| `createEngine({ functions })` | An engine with extra scalar functions. |

Options: `params` (array or object), `engine`, `limits` (see above), `interpreted: true` (never generates code —
for a strict Content-Security-Policy), `tables` (extra tables by name).

## What a plan looks like

```js
compile('SELECT id FROM orders WHERE total > 100').statements[0].body
// {
//   kind: 'select',
//   steps: [{ alias: 'orders', source: { kind: 'table', path: ['orders'] }, join: 'FROM', ... }],
//   where: { GT: [{ val: ['orders', 'total'] }, 100] },
//   columns: [{ kind: 'expr', name: 'id', expr: { val: ['orders', 'id'] } }],
//   ...
// }
```

Each row is evaluated against `{ <alias>: row, ... }`, so `o.total` is
`{"val": ["o", "total"]}`. Paths deeper than a column, or into JSON text, are
`{"PATH": [...]}`.

## Performance

200k rows, Node 26, Apple silicon, prepared queries, median of 7 runs, against
alasql 4.22.1 on the same data (it compiles SQL straight to JavaScript):

| query | sqllang | alasql |
| --- | --- | --- |
| filter + project | 5.9 ms | 5.2 ms |
| GROUP BY two columns | 20.7 ms | 24.3 ms |
| hash join + GROUP BY | 36.0 ms | 58.5 ms |
| nested path + GROUP BY | 12.4 ms | 17.7 ms |
| ORDER BY … LIMIT 10 | 18.2 ms | 118.2 ms |
| full ORDER BY | 71.5 ms | 164.7 ms |
| DISTINCT | 31.0 ms | 52.2 ms |
| IN (subquery) | 15.5 ms | 26.3 ms |
| ROW_NUMBER() OVER (PARTITION BY … ORDER BY …) | 63.5 ms | 32.5 ms * |

\* alasql ignores PARTITION BY and ORDER BY inside OVER and numbers the rows
1…n, so it skips the sort that dominates this query; its answer is wrong.

What makes it fast, roughly in order of effect:

- Operators carry json-logic-engine `compile` hooks, so `.build()` turns
  `{"AND": [{"EQ": …}, {"GT": …}]}` into direct calls instead of method lookups
  with an argument array per call.
- A single-table query streams rows through one reused context object; with
  GROUP BY, aggregates are fed per row (COUNT/SUM/AVG/MIN/MAX keep running totals)
  and a group keeps only its first row.
- Groups, DISTINCT, set operations and window partitions use nested Maps keyed by
  the raw values — no key strings built per row.
- ORDER BY … LIMIT k keeps the best k as rows stream past, and projects a row only
  once it makes the cut.
- Single-column hash joins and uncorrelated `IN (SELECT …)` look up raw values, and
  consult a numeric side-table only when a cross-type match (`1 = '1'`) is possible.
- One comparator per ORDER BY, with numbers and strings compared inline, and plain
  subtraction for a single numeric key.

`test/fastpaths.test.js` holds each of these to the general path's answers.

## Development

```
bun run test           # regenerates src/parser.js from src/grammar.gram, then runs the tests
bun run build          # dist/esm, dist/cjs, dist/types (+ a minified ESM build)
bun run test:types     # the declarations, under tsc --strict
bun run test:dist      # the built bundles, loaded through package.json "exports"
bun run test:csp       # runs with code generation disabled, as under a strict CSP
bun run test:all       # all of the above; also what prepublishOnly runs
```

Dependencies are managed with [bun](https://bun.sh) (`bun install`); the tests
themselves run on Node, which is what the package supports.

`grammatik` is a build-time dependency only: it generates `src/parser.js`, and
the small runtime that file needs is bundled into `dist`. The published package
depends on `json-logic-engine` alone. Types are hand-written in `types/index.d.ts`.
