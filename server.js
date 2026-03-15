const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = createClient({ url: `file:${path.join(__dirname, 'data.db')}` });

const VALID_CATEGORIES = ['prayer', 'spiritual', 'personal', 'family', 'faith', 'other'];

async function setup() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      category TEXT DEFAULT 'other',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      sender TEXT NOT NULL CHECK(sender IN ('user','admin')),
      body TEXT NOT NULL,
      category TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      FOREIGN KEY(thread_id) REFERENCES threads(id)
    );
  `);
  for (const sql of [
    "ALTER TABLE threads ADD COLUMN category TEXT DEFAULT 'other'",
    "ALTER TABLE threads ADD COLUMN status TEXT DEFAULT 'pending'",
    "ALTER TABLE messages ADD COLUMN category TEXT",
  ]) {
    try { await db.execute(sql); } catch {}
  }
}

function generateId() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  return `${letters[Math.floor(Math.random() * 26)]}${digits[Math.floor(Math.random() * 10)]}${digits[Math.floor(Math.random() * 10)]}`;
}

function sanitizeBody(body) {
  if (typeof body !== 'string') return null;
  const trimmed = body.trim();
  return (!trimmed || trimmed.length > 2000) ? null : trimmed;
}

function sanitizeCategory(cat) {
  return VALID_CATEGORIES.includes(cat) ? cat : 'other';
}

// Submit new question
app.post('/api/comment', async (req, res) => {
  const body = sanitizeBody(req.body?.text);
  if (!body) return res.status(400).json({ error: 'Message is required and must be under 2000 characters.' });

  const category = sanitizeCategory(req.body?.category);
  let id;
  // Ensure unique ID
  for (let i = 0; i < 10; i++) {
    const candidate = generateId();
    const row = await db.execute({ sql: 'SELECT id FROM threads WHERE id = ?', args: [candidate] });
    if (!row.rows.length) { id = candidate; break; }
  }
  if (!id) return res.status(500).json({ error: 'Could not generate ID. Try again.' });

  await db.execute({ sql: 'INSERT INTO threads (id, category) VALUES (?, ?)', args: [id, category] });
  await db.execute({ sql: 'INSERT INTO messages (thread_id, sender, body, category) VALUES (?, ?, ?, ?)', args: [id, 'user', body, category] });

  res.json({ threadId: id, label: `Anonymous #${id}` });
});

// Get thread (user)
app.get('/api/thread/:id', async (req, res) => {
  const t = await db.execute({ sql: 'SELECT id, category, status, created_at FROM threads WHERE id = ?', args: [req.params.id] });
  if (!t.rows.length) return res.status(404).json({ error: 'Thread not found' });
  const msgs = await db.execute({ sql: 'SELECT sender, body, category, created_at FROM messages WHERE thread_id = ? ORDER BY id ASC', args: [req.params.id] });
  const thread = t.rows[0];
  res.json({ threadId: thread.id, label: `Anonymous #${thread.id}`, category: thread.category, status: thread.status, messages: msgs.rows });
});

// Admin: list all threads
app.get('/api/admin/threads', async (req, res) => {
  const result = await db.execute(`
    SELECT t.id, t.category, t.status, t.created_at,
           (SELECT created_at FROM messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS latest,
           (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS count
    FROM threads t
    ORDER BY (latest IS NULL) ASC, latest DESC, t.created_at DESC
  `);
  const threads = result.rows.map(t => ({
    threadId: t.id,
    label: `Anonymous #${t.id}`,
    category: t.category || 'other',
    status: t.status || 'pending',
    createdAt: t.created_at,
    latestMessageAt: t.latest,
    messageCount: t.count
  }));
  res.json({ threads });
});

// Admin: view thread
app.get('/api/admin/threads/:id', async (req, res) => {
  const t = await db.execute({ sql: 'SELECT id, category, status, created_at FROM threads WHERE id = ?', args: [req.params.id] });
  if (!t.rows.length) return res.status(404).json({ error: 'Thread not found' });
  const msgs = await db.execute({ sql: 'SELECT sender, body, category, created_at FROM messages WHERE thread_id = ? ORDER BY id ASC', args: [req.params.id] });
  const thread = t.rows[0];
  res.json({ threadId: thread.id, label: `Anonymous #${thread.id}`, category: thread.category, status: thread.status, messages: msgs.rows });
});

// Admin: reply
app.post('/api/admin/threads/:id/reply', async (req, res) => {
  const t = await db.execute({ sql: 'SELECT id FROM threads WHERE id = ?', args: [req.params.id] });
  if (!t.rows.length) return res.status(404).json({ error: 'Thread not found' });
  const body = sanitizeBody(req.body?.text);
  if (!body) return res.status(400).json({ error: 'Message is required and must be under 2000 characters.' });

  await db.execute({ sql: 'INSERT INTO messages (thread_id, sender, body, category) VALUES (?, ?, ?, ?)', args: [req.params.id, 'admin', body, null] });
  res.json({ ok: true });
});

// Admin: update status
app.post('/api/admin/threads/:id/status', async (req, res) => {
  const t = await db.execute({ sql: 'SELECT id FROM threads WHERE id = ?', args: [req.params.id] });
  if (!t.rows.length) return res.status(404).json({ error: 'Thread not found' });

  const status = req.body?.status === 'answered' ? 'answered' : 'pending';
  await db.execute({ sql: 'UPDATE threads SET status = ? WHERE id = ?', args: [status, req.params.id] });
  res.json({ ok: true, status });
});

const PORT = process.env.PORT || 4000;
setup()
  .then(() => app.listen(PORT, () => console.log(`Ask Your Pastor running on http://localhost:${PORT}`)))
  .catch(err => { console.error('Startup failed:', err); process.exit(1); });
