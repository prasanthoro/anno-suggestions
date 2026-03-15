const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database(path.join(__dirname, 'data.db'));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  category TEXT DEFAULT 'other',
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  sender TEXT NOT NULL CHECK(sender IN ('user','admin')),
  body TEXT NOT NULL,
  category TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(thread_id) REFERENCES threads(id)
);
`);

// Add category and status columns if they don't exist (for existing databases)
try { db.exec('ALTER TABLE threads ADD COLUMN category TEXT DEFAULT \'other\''); } catch {}
try { db.exec('ALTER TABLE threads ADD COLUMN status TEXT DEFAULT \'pending\''); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN category TEXT'); } catch {}

const insertThread = db.prepare('INSERT INTO threads (id, category) VALUES (?, ?)');
const insertMessage = db.prepare('INSERT INTO messages (thread_id, sender, body, category) VALUES (?, ?, ?, ?)');
const getThread = db.prepare('SELECT id, category, status, created_at FROM threads WHERE id = ?');
const getMessages = db.prepare('SELECT sender, body, category, created_at FROM messages WHERE thread_id = ? ORDER BY id ASC');
const updateThreadStatus = db.prepare('UPDATE threads SET status = ? WHERE id = ?');

const listThreads = db.prepare(`
  SELECT t.id, t.category, t.status, t.created_at,
         (SELECT created_at FROM messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS latest,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS count
  FROM threads t
  ORDER BY (latest IS NULL) ASC, latest DESC, t.created_at DESC
`);

const VALID_CATEGORIES = ['prayer', 'spiritual', 'personal', 'family', 'faith', 'other'];

function generateId() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  let id;
  do {
    id = `${letters[Math.floor(Math.random() * letters.length)]}${digits[Math.floor(Math.random() * 10)]}${digits[Math.floor(Math.random() * 10)]}`;
  } while (getThread.get(id));
  return id;
}

function sanitizeBody(body) {
  if (typeof body !== 'string') return null;
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  return trimmed;
}

function sanitizeCategory(cat) {
  return VALID_CATEGORIES.includes(cat) ? cat : 'other';
}

// User submits a new question
app.post('/api/comment', (req, res) => {
  const body = sanitizeBody(req.body?.text);
  if (!body) return res.status(400).json({ error: 'Message is required and must be under 2000 characters.' });

  const category = sanitizeCategory(req.body?.category);
  const id = generateId();
  const label = `Anonymous #${id}`;

  const tx = db.transaction(() => {
    insertThread.run(id, category);
    insertMessage.run(id, 'user', body, category);
  });
  tx();

  res.json({ threadId: id, label });
});

// User loads their thread
app.get('/api/thread/:id', (req, res) => {
  const thread = getThread.get(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const messages = getMessages.all(req.params.id);
  res.json({
    threadId: thread.id,
    label: `Anonymous #${thread.id}`,
    category: thread.category,
    status: thread.status,
    messages
  });
});

// Admin: list all threads
app.get('/api/admin/threads', (req, res) => {
  const threads = listThreads.all().map((t) => ({
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

// Admin: view thread messages
app.get('/api/admin/threads/:id', (req, res) => {
  const thread = getThread.get(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const messages = getMessages.all(req.params.id);
  res.json({
    threadId: thread.id,
    label: `Anonymous #${thread.id}`,
    category: thread.category,
    status: thread.status,
    messages
  });
});

// Admin: reply to thread
app.post('/api/admin/threads/:id/reply', (req, res) => {
  const thread = getThread.get(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const body = sanitizeBody(req.body?.text);
  if (!body) return res.status(400).json({ error: 'Message is required and must be under 2000 characters.' });

  insertMessage.run(req.params.id, 'admin', body, null);
  res.json({ ok: true });
});

// Admin: update thread status
app.post('/api/admin/threads/:id/status', (req, res) => {
  const thread = getThread.get(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  const status = req.body?.status === 'answered' ? 'answered' : 'pending';
  updateThreadStatus.run(status, req.params.id);
  res.json({ ok: true, status });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Ask Your Pastor running on http://localhost:${PORT}`);
});
