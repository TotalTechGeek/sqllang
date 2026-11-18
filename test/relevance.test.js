// How well the right suggestion ranks. Each word of each query is "typed" again, with the cursor
// after 0, 1 or 2 of its characters, and the rank of the word actually written is measured.
// The floors sit a little under what it scores, so only a real loss of relevance trips them.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createCompleter } from '../src/index.js'
import { tokenize } from '../src/parser.js'

const pick = (arr, i) => arr[i % arr.length]
const data = {
  orders: Array.from({ length: 30 }, (_, i) => ({ id: i, user_id: i % 7, product_id: i % 5, total: i * 10, status: pick(['open', 'paid', 'void'], i), created_at: '2024-01-01', region: pick(['n', 's', 'e', 'w'], i) })),
  users: Array.from({ length: 7 }, (_, i) => ({ id: i, name: 'u' + i, email: `u${i}@x.io`, region: pick(['n', 's', 'e', 'w'], i), plan: pick(['free', 'pro', 'team'], i), signup_date: '2023-05-05' })),
  products: Array.from({ length: 5 }, (_, i) => ({ id: i, title: 'p' + i, category: pick(['books', 'games', 'tools'], i), price: i + 1 })),
  events: Array.from({ length: 20 }, (_, i) => ({ id: i, user_id: i % 7, kind: pick(['click', 'view', 'buy'], i), ts: '2024-02-02 10:00:00' })),
}
const corpus = [
  "SELECT id, name, email FROM users WHERE plan = 'pro' ORDER BY name",
  "SELECT o.id, o.total, u.name FROM orders o JOIN users u ON u.id = o.user_id WHERE o.status = 'paid' AND o.total > 100 ORDER BY o.total DESC LIMIT 10",
  "SELECT status, COUNT(*) AS n, SUM(total) AS revenue FROM orders GROUP BY status HAVING COUNT(*) > 2 ORDER BY revenue DESC",
  "SELECT region, AVG(total) AS avg_total, MAX(total) AS biggest FROM orders WHERE status <> 'void' GROUP BY region",
  "SELECT u.name, COUNT(o.id) AS orders FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.name ORDER BY orders DESC",
  "SELECT p.title, p.category, p.price FROM products p WHERE p.category IN ('books', 'games') AND p.price BETWEEN 2 AND 4",
  "SELECT kind, COUNT(*) FROM events WHERE kind = 'click' OR kind = 'buy' GROUP BY kind",
  "SELECT o.id, p.title FROM orders o JOIN products p ON p.id = o.product_id WHERE p.category = 'tools'",
  "SELECT name FROM users WHERE id IN (SELECT user_id FROM orders WHERE total > 200)",
  "WITH big AS (SELECT user_id, SUM(total) AS spent FROM orders GROUP BY user_id) SELECT u.name, big.spent FROM users u JOIN big ON big.user_id = u.id ORDER BY big.spent DESC",
  "SELECT id, total, RANK() OVER (PARTITION BY region ORDER BY total DESC) AS rnk FROM orders",
  "SELECT id, SUM(total) OVER (ORDER BY created_at) AS running FROM orders WHERE status = 'paid'",
  "SELECT email, UPPER(name) AS shout, LENGTH(email) AS len FROM users WHERE region = 'n'",
  "SELECT COALESCE(region, 'none') AS r, COUNT(*) AS n FROM users GROUP BY COALESCE(region, 'none')",
  "SELECT id, CASE WHEN total > 100 THEN 'big' WHEN total > 50 THEN 'mid' ELSE 'small' END AS size FROM orders",
  "SELECT DISTINCT region FROM orders WHERE status = 'open' ORDER BY region",
  "SELECT u.region, p.category, SUM(o.total) FROM orders o JOIN users u ON u.id = o.user_id JOIN products p ON p.id = o.product_id GROUP BY u.region, p.category",
  "SELECT * FROM events WHERE user_id = 3 AND kind IN ('view', 'buy') ORDER BY ts DESC LIMIT 5",
  "SELECT id FROM orders WHERE created_at >= '2024-01-01' AND status = 'paid'",
  "SELECT u.name, e.kind FROM users u JOIN events e ON e.user_id = u.id WHERE e.kind <> 'view'",
  "SELECT plan, COUNT(*) AS members FROM users GROUP BY plan ORDER BY members DESC LIMIT 3",
  "SELECT id, total * 2 AS doubled, ROUND(total / 3, 2) AS third FROM orders WHERE total IS NOT NULL",
  "SELECT o.id FROM orders o WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = o.user_id AND u.plan = 'team')",
  "SELECT category, MIN(price) AS cheapest, MAX(price) AS dearest FROM products GROUP BY category",
  "SELECT title FROM products WHERE title LIKE 'p%' ORDER BY price",
  "SELECT SUBSTR(email, 1, 3) AS prefix, COUNT(*) FROM users GROUP BY SUBSTR(email, 1, 3)",
  "SELECT user_id, COUNT(*) AS n FROM events GROUP BY user_id HAVING COUNT(*) > 1 ORDER BY n DESC",
  "SELECT o.status, u.plan, COUNT(*) FROM orders o JOIN users u ON u.id = o.user_id WHERE o.region = 's' GROUP BY o.status, u.plan",
  "SELECT id, name FROM users WHERE signup_date > '2023-01-01' AND plan IN ('pro', 'team') ORDER BY signup_date DESC",
  "SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY ts) AS seq FROM events",
  "SELECT region, SUM(total) FILTER (WHERE status = 'paid') AS paid FROM orders GROUP BY region",
  "SELECT t.user_id, t.n FROM (SELECT user_id, COUNT(*) AS n FROM events GROUP BY user_id) t WHERE t.n > 2",
  "SELECT id, total FROM orders ORDER BY total DESC, id LIMIT 5 OFFSET 10",
  "SELECT name, email FROM users WHERE region = 'e' AND plan = 'free'",
  "SELECT a.id, b.id FROM orders a JOIN orders b ON a.user_id = b.user_id WHERE a.id < b.id",
  "SELECT product_id, COUNT(DISTINCT user_id) AS buyers FROM orders GROUP BY product_id",
  "SELECT id FROM orders WHERE status = 'void' UNION SELECT id FROM events WHERE kind = 'buy'",
  "SELECT price, price * 1.2 AS with_tax FROM products WHERE category = 'books'",
  "SELECT u.name FROM users u WHERE u.id NOT IN (SELECT user_id FROM orders)",
  "SELECT region, plan, COUNT(*) AS n, AVG(id) AS mean_id FROM users GROUP BY region, plan ORDER BY region, n DESC",
  "SELECT CAST(total AS TEXT) AS t, status FROM orders WHERE status IN ('open', 'paid', 'void')",
]


// (Typed left to right a select list comes before its FROM, so these runs guess columns.)
const complete = createCompleter({ data, guessColumns: true })
const isWord = (t) => /^[A-Za-z_]+$/.test(t.image)
const isKeyword = (t) => {
  if (t.type === 'Identifier' || !isWord(t)) return false
  try { const k = tokenize(t.image.toUpperCase()); return k.length === 1 && k[0].type === t.type } catch { return false }
}

/** { n, offered, hit1, mrr } for typing `typed` characters of every word, with or without the rest of the query. */
function measure (typed, withRest, only = () => true) {
  let n = 0; let offered = 0; let hit1 = 0; let rr = 0
  for (const sql of corpus) {
    const toks = tokenize(sql)
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]
      let truth, kind
      if (t.type === 'String') { truth = t.image.slice(1, -1); kind = 'value' }
      else if (isKeyword(t)) { truth = t.image.toUpperCase(); kind = 'keyword' }
      else if (t.type === 'Identifier') {
        const prev = toks[i - 1]?.type
        if (prev === 'As' || (prev === 'Identifier' && ['From', 'Join'].includes(toks[i - 2]?.type))) continue // a new name
        const call = toks[i + 1]?.type === 'LParen'
        truth = call ? t.image.toUpperCase() : t.image
        kind = call ? 'function' : 'name'
      } else continue
      if (!only(kind)) continue
      const len = t.type === 'String' ? t.image.length - 2 : t.image.length
      if (typed > 0 && typed > len - 1) continue
      const start = t.type === 'String' ? t.start + 1 : t.start
      const rest = withRest ? sql.slice(t.type === 'String' ? t.end - 1 : t.end) : ''
      const items = complete(sql.slice(0, start + typed) + rest, start + typed).items
      const rank = items.findIndex((x) => x.label.toLowerCase() === truth.toLowerCase())
      n++
      if (rank >= 0) { offered++; rr += 1 / (rank + 1); if (rank === 0) hit1++ }
    }
  }
  return { n, offered: offered / n, hit1: hit1 / n, mrr: rr / n }
}

describe('relevance floors', () => {
  test('after one character, the word written is usually first', () => {
    const typed = measure(1, false)
    const edit = measure(1, true)
    assert.ok(typed.mrr >= 0.83, `typed, 1 char: MRR ${typed.mrr.toFixed(2)}`)
    assert.ok(edit.mrr >= 0.86, `editing, 1 char: MRR ${edit.mrr.toFixed(2)}`)
    assert.ok(typed.hit1 >= 0.75 && edit.hit1 >= 0.80, `hit@1 ${typed.hit1.toFixed(2)} / ${edit.hit1.toFixed(2)}`)
  })
  test('after two characters it nearly always is', () => {
    assert.ok(measure(2, false).mrr >= 0.88)
    assert.ok(measure(2, true).mrr >= 0.89)
  })
  test('with nothing typed, the right word is near the top', () => {
    const typed = measure(0, false)
    const edit = measure(0, true)
    assert.ok(typed.mrr >= 0.40, `typed, 0 chars: MRR ${typed.mrr.toFixed(2)}`)
    assert.ok(edit.mrr >= 0.45, `editing, 0 chars: MRR ${edit.mrr.toFixed(2)}`)
  })
  test('keywords and functions, the words that come from a fixed list, rank well', () => {
    const keywords = measure(0, false, (k) => k === 'keyword')
    assert.ok(keywords.mrr >= 0.58, `keywords, 0 chars: MRR ${keywords.mrr.toFixed(2)}`)
    assert.equal(keywords.offered, 1)
    assert.ok(measure(2, false, (k) => k === 'function').hit1 >= 0.7)
  })
  test('what is written is almost always among the suggestions', () => {
    assert.ok(measure(1, true).offered >= 0.93)
    assert.ok(measure(1, false).offered >= 0.93)
  })
})
