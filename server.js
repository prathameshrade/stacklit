const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const sanitizeHtml = require('sanitize-html');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'stackit-dev-secret-change-me';
const DB_PATH = path.join(__dirname, 'stackit.db');
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || `http://localhost:${PORT}`;
const IS_PROD = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');

if (IS_PROD && JWT_SECRET === 'stackit-dev-secret-change-me') {
  // eslint-disable-next-line no-console
  console.error('JWT_SECRET must be set in production');
  process.exit(1);
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' }
  })
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const allowed = [CLIENT_ORIGIN, `http://localhost:${PORT}`, 'http://127.0.0.1:3000'];
      if (allowed.includes(origin)) return callback(null, true);
      return callback(new Error('CORS blocked'));
    },
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
  })
);

app.use(express.json({ limit: '1mb', strict: true }));
app.use(express.static(__dirname));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Try again later.' }
});

app.use('/api', apiLimiter);
app.use('/api/auth', authLimiter);

const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
    expiresIn: '7d'
  });
}

function parsePositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sanitizePlainText(value, maxLen = 400) {
  const text = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim();
  return text.slice(0, maxLen);
}

function sanitizeUsername(value) {
  const clean = sanitizePlainText(value, 40).toLowerCase();
  return clean.replace(/[^a-z0-9_]/g, '').slice(0, 24);
}

function sanitizeTag(value) {
  const clean = sanitizePlainText(value, 30).toLowerCase();
  return clean.replace(/[^a-z0-9.+#-]/g, '').slice(0, 24);
}

function sanitizeRichText(value) {
  return sanitizeHtml(String(value || ''), {
    allowedTags: [
      'p',
      'br',
      'strong',
      'em',
      's',
      'code',
      'pre',
      'ul',
      'ol',
      'li',
      'a',
      'img',
      'blockquote',
      'span'
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt'],
      '*': ['style']
    },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard'
  });
}

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await get('SELECT id, username, role, is_banned FROM users WHERE id = ?', [payload.id]);
    if (!user || user.is_banned) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    return next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  return next();
}

function parseMentions(htmlText) {
  const matches = htmlText.match(/@([a-zA-Z0-9_]+)/g) || [];
  return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))];
}

async function notifyUser(userId, type, text, actorId = null, questionId = null, answerId = null) {
  await run(
    `INSERT INTO notifications (user_id, type, text, actor_user_id, question_id, answer_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, type, text, actorId, questionId, answerId]
  );
}

async function ensureTags(tagNames) {
  const unique = [...new Set((tagNames || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 5);
  const ids = [];

  for (const tag of unique) {
    let row = await get('SELECT id FROM tags WHERE name = ?', [tag]);
    if (!row) {
      const result = await run('INSERT INTO tags (name) VALUES (?)', [tag]);
      row = { id: result.lastID };
    }
    ids.push(row.id);
  }

  return ids;
}

async function getQuestionById(questionId, viewerId = null) {
  const question = await get(
    `SELECT q.id, q.title, q.description, q.user_id, q.created_at, q.updated_at,
            u.username,
            COALESCE(SUM(qv.value), 0) AS votes,
            (SELECT COUNT(1) FROM answers a WHERE a.question_id = q.id) AS answers_count
     FROM questions q
     JOIN users u ON u.id = q.user_id
     LEFT JOIN question_votes qv ON qv.question_id = q.id
     WHERE q.id = ?
     GROUP BY q.id`,
    [questionId]
  );

  if (!question) return null;

  const tags = await all(
    `SELECT t.id, t.name
     FROM question_tags qt
     JOIN tags t ON t.id = qt.tag_id
     WHERE qt.question_id = ?
     ORDER BY t.name ASC`,
    [questionId]
  );

  const answers = await all(
    `SELECT a.id, a.body, a.is_accepted, a.user_id, a.created_at, u.username,
            COALESCE(SUM(av.value), 0) AS votes
     FROM answers a
     JOIN users u ON u.id = a.user_id
     LEFT JOIN answer_votes av ON av.answer_id = a.id
     WHERE a.question_id = ?
     GROUP BY a.id
     ORDER BY a.is_accepted DESC, votes DESC, a.created_at ASC`,
    [questionId]
  );

  let myQuestionVote = 0;
  if (viewerId) {
    const qVote = await get(
      'SELECT value FROM question_votes WHERE question_id = ? AND user_id = ?',
      [questionId, viewerId]
    );
    myQuestionVote = qVote ? qVote.value : 0;
  }

  const answerVoteMap = {};
  if (viewerId && answers.length) {
    const answerVotes = await all(
      `SELECT answer_id, value
       FROM answer_votes
       WHERE user_id = ? AND answer_id IN (${answers.map(() => '?').join(',')})`,
      [viewerId, ...answers.map((a) => a.id)]
    );
    answerVotes.forEach((v) => {
      answerVoteMap[v.answer_id] = v.value;
    });
  }

  return {
    ...question,
    myQuestionVote,
    tags,
    answers: answers.map((a) => ({ ...a, myVote: answerVoteMap[a.id] || 0 }))
  };
}

async function seedData() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      is_banned INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS question_tags (
      question_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (question_id, tag_id),
      FOREIGN KEY (question_id) REFERENCES questions(id),
      FOREIGN KEY (tag_id) REFERENCES tags(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      is_accepted INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (question_id) REFERENCES questions(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS answer_votes (
      answer_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      value INTEGER NOT NULL CHECK (value IN (-1, 1)),
      PRIMARY KEY (answer_id, user_id),
      FOREIGN KEY (answer_id) REFERENCES answers(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS question_votes (
      question_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      value INTEGER NOT NULL CHECK (value IN (-1, 1)),
      PRIMARY KEY (question_id, user_id),
      FOREIGN KEY (question_id) REFERENCES questions(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      actor_user_id INTEGER,
      question_id INTEGER,
      answer_id INTEGER,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reporter_user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const userCount = await get('SELECT COUNT(1) AS c FROM users');
  if (userCount.c > 0) return;

  const users = [
    { username: 'admin', password: 'admin123', role: 'admin' },
    { username: 'priya_k', password: 'user123', role: 'user' },
    { username: 'tanvir_r', password: 'user123', role: 'user' },
    { username: 'lisa_dev', password: 'user123', role: 'user' },
    { username: 'dev_max', password: 'user123', role: 'user' }
  ];

  for (const user of users) {
    const hash = await bcrypt.hash(user.password, 10);
    await run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [
      user.username,
      hash,
      user.role
    ]);
  }

  const priya = await get('SELECT id FROM users WHERE username = ?', ['priya_k']);
  const tanvir = await get('SELECT id FROM users WHERE username = ?', ['tanvir_r']);
  const lisa = await get('SELECT id FROM users WHERE username = ?', ['lisa_dev']);
  const dev = await get('SELECT id FROM users WHERE username = ?', ['dev_max']);

  const seedQuestions = [
    {
      userId: priya.id,
      title: 'Why does useEffect run twice in React 18 strict mode even with an empty dependency array?',
      description:
        '<p>I upgraded my project to React 18 and noticed my <code>useEffect</code> runs twice in development. Is this expected?</p>',
      tags: ['react', 'hooks', 'strict-mode']
    },
    {
      userId: tanvir.id,
      title: 'How to properly invalidate JWT tokens on logout without a blacklist database?',
      description: '<p>I want immediate logout behavior but I do not want to persist every revoked token.</p>',
      tags: ['jwt', 'authentication', 'security']
    },
    {
      userId: lisa.id,
      title: 'PostgreSQL vs MySQL for a high-traffic read-heavy application?',
      description: '<p>80% reads, 10k concurrent users. Which would you choose and why?</p>',
      tags: ['postgresql', 'mysql', 'performance']
    },
    {
      userId: dev.id,
      title: 'Docker container exits immediately after starting - CMD vs ENTRYPOINT?',
      description: '<p>Container exits with code 0. Node server does not stay alive.</p>',
      tags: ['docker', 'node.js', 'devops']
    }
  ];

  for (const q of seedQuestions) {
    const inserted = await run(
      'INSERT INTO questions (user_id, title, description) VALUES (?, ?, ?)',
      [q.userId, q.title, q.description]
    );
    const tagIds = await ensureTags(q.tags);
    for (const tagId of tagIds) {
      await run('INSERT INTO question_tags (question_id, tag_id) VALUES (?, ?)', [inserted.lastID, tagId]);
    }
  }

  const q1 = await get('SELECT id, user_id FROM questions WHERE title LIKE ?', ['Why does useEffect run twice%']);
  await run('INSERT INTO answers (question_id, user_id, body, is_accepted) VALUES (?, ?, ?, 1)', [
    q1.id,
    tanvir.id,
    '<p>This is expected in React 18 StrictMode during development. React remounts to detect unsafe side effects.</p>'
  ]);
  await run('INSERT INTO answers (question_id, user_id, body, is_accepted) VALUES (?, ?, ?, 0)', [
    q1.id,
    priya.id,
    '<p>You can temporarily remove StrictMode for migration, but long term make effects idempotent.</p>'
  ]);

  const answers = await all('SELECT id FROM answers WHERE question_id = ?', [q1.id]);
  await run('INSERT INTO answer_votes (answer_id, user_id, value) VALUES (?, ?, ?)', [answers[0].id, lisa.id, 1]);
  await run('INSERT INTO answer_votes (answer_id, user_id, value) VALUES (?, ?, ?)', [answers[0].id, dev.id, 1]);

  await run('INSERT INTO reports (target_type, target_id, reason, reporter_user_id) VALUES (?, ?, ?, ?)', [
    'question',
    q1.id,
    'Off-topic',
    dev.id
  ]);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const username = sanitizeUsername(req.body.username);
    const password = String(req.body.password || '').trim();

    if (!username || username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (!password || password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      return res
        .status(400)
        .json({ error: 'Password must be 8+ characters and include at least one letter and one number' });
    }

    const existing = await get('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', [username]);
    if (existing) return res.status(409).json({ error: 'Username already exists' });

    const hash = await bcrypt.hash(password, 10);
    const result = await run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [
      username,
      hash,
      'user'
    ]);

    const user = { id: result.lastID, username, role: 'user' };
    const token = signToken(user);
    return res.status(201).json({ token, user });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = sanitizeUsername(req.body.username);
    const password = String(req.body.password || '').trim();

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await get('SELECT id, username, role, password_hash, is_banned FROM users WHERE LOWER(username) = LOWER(?)', [
      username
    ]);
    if (!user || user.is_banned) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken(user);
    return res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/me', auth, async (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/questions', async (req, res) => {
  try {
    const allowedSort = new Set(['newest', 'active', 'votes', 'unanswered']);
    const sortRaw = sanitizePlainText(req.query.sort || 'newest', 20).toLowerCase();
    const sort = allowedSort.has(sortRaw) ? sortRaw : 'newest';
    const search = sanitizePlainText(req.query.search || '', 100).toLowerCase();

    let orderBy = 'q.created_at DESC';
    if (sort === 'active') orderBy = 'q.updated_at DESC';
    if (sort === 'votes') orderBy = 'votes DESC, q.created_at DESC';
    if (sort === 'unanswered') orderBy = 'answers_count ASC, q.created_at DESC';

    let where = '';
    const params = [];
    if (search) {
      where = 'WHERE LOWER(q.title) LIKE ? OR LOWER(q.description) LIKE ?';
      params.push(`%${search}%`, `%${search}%`);
    }

    const rows = await all(
      `SELECT q.id, q.title, q.description, q.user_id, q.created_at, q.updated_at, u.username,
              COALESCE(SUM(qv.value), 0) AS votes,
              (SELECT COUNT(1) FROM answers a WHERE a.question_id = q.id) AS answers_count
       FROM questions q
       JOIN users u ON u.id = q.user_id
       LEFT JOIN question_votes qv ON qv.question_id = q.id
       ${where}
       GROUP BY q.id
       ORDER BY ${orderBy}
       LIMIT 100`,
      params
    );

    const questionIds = rows.map((r) => r.id);
    const tagRows = questionIds.length
      ? await all(
          `SELECT qt.question_id, t.name
           FROM question_tags qt
           JOIN tags t ON t.id = qt.tag_id
           WHERE qt.question_id IN (${questionIds.map(() => '?').join(',')})`,
          questionIds
        )
      : [];

    const tagsByQuestion = {};
    tagRows.forEach((tr) => {
      if (!tagsByQuestion[tr.question_id]) tagsByQuestion[tr.question_id] = [];
      tagsByQuestion[tr.question_id].push(tr.name);
    });

    return res.json(
      rows.map((r) => ({
        ...r,
        tags: tagsByQuestion[r.id] || []
      }))
    );
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/questions/:id', async (req, res) => {
  try {
    const questionId = parsePositiveInt(req.params.id);
    if (!questionId) return res.status(400).json({ error: 'Invalid question id' });

    let viewerId = null;
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        viewerId = payload.id;
      } catch {
        viewerId = null;
      }
    }

    const question = await getQuestionById(questionId, viewerId);
    if (!question) return res.status(404).json({ error: 'Question not found' });

    return res.json(question);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/questions', auth, async (req, res) => {
  try {
    const title = sanitizePlainText(req.body.title, 180);
    const description = sanitizeRichText(req.body.description).trim();
    const tags = Array.isArray(req.body.tags) ? req.body.tags.map(sanitizeTag).filter(Boolean) : [];

    if (title.length < 10) return res.status(400).json({ error: 'Title must be at least 10 characters' });
    if (!description) return res.status(400).json({ error: 'Description is required' });
    if (!tags.length) return res.status(400).json({ error: 'At least one valid tag is required' });

    const result = await run('INSERT INTO questions (user_id, title, description) VALUES (?, ?, ?)', [
      req.user.id,
      title,
      description
    ]);

    const tagIds = await ensureTags(tags);
    for (const tagId of tagIds) {
      await run('INSERT INTO question_tags (question_id, tag_id) VALUES (?, ?)', [result.lastID, tagId]);
    }

    const fullQuestion = await getQuestionById(result.lastID, req.user.id);
    return res.status(201).json(fullQuestion);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/questions/:id/vote', auth, async (req, res) => {
  try {
    const questionId = parsePositiveInt(req.params.id);
    const value = Number(req.body.value);
    if (!questionId) return res.status(400).json({ error: 'Invalid question id' });
    if (![-1, 1].includes(value)) return res.status(400).json({ error: 'Vote must be -1 or 1' });

    const exists = await get('SELECT id FROM questions WHERE id = ?', [questionId]);
    if (!exists) return res.status(404).json({ error: 'Question not found' });

    await run(
      `INSERT INTO question_votes (question_id, user_id, value)
       VALUES (?, ?, ?)
       ON CONFLICT(question_id, user_id) DO UPDATE SET value = excluded.value`,
      [questionId, req.user.id, value]
    );

    const votesRow = await get('SELECT COALESCE(SUM(value), 0) AS votes FROM question_votes WHERE question_id = ?', [
      questionId
    ]);

    return res.json({ votes: votesRow.votes, myVote: value });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/answers', auth, async (req, res) => {
  try {
    const questionId = parsePositiveInt(req.body.questionId);
    const body = sanitizeRichText(req.body.body).trim();
    if (!questionId) return res.status(400).json({ error: 'Invalid question id' });
    if (!body) return res.status(400).json({ error: 'Answer body is required' });

    const q = await get('SELECT id, user_id, title FROM questions WHERE id = ?', [questionId]);
    if (!q) return res.status(404).json({ error: 'Question not found' });

    const result = await run('INSERT INTO answers (question_id, user_id, body) VALUES (?, ?, ?)', [
      questionId,
      req.user.id,
      body
    ]);
    await run('UPDATE questions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [questionId]);

    if (q.user_id !== req.user.id) {
      await notifyUser(
        q.user_id,
        'answer',
        `@${req.user.username} answered your question: ${q.title}`,
        req.user.id,
        questionId,
        result.lastID
      );
    }

    const mentioned = parseMentions(body);
    for (const username of mentioned) {
      const user = await get('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)', [username]);
      if (user && user.id !== req.user.id) {
        await notifyUser(
          user.id,
          'mention',
          `@${req.user.username} mentioned you in an answer`,
          req.user.id,
          questionId,
          result.lastID
        );
      }
    }

    const answer = await get(
      `SELECT a.id, a.body, a.is_accepted, a.user_id, a.created_at, u.username,
              0 AS votes
       FROM answers a
       JOIN users u ON u.id = a.user_id
       WHERE a.id = ?`,
      [result.lastID]
    );

    return res.status(201).json({ ...answer, myVote: 0 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/answers/:id/vote', auth, async (req, res) => {
  try {
    const answerId = parsePositiveInt(req.params.id);
    const value = Number(req.body.value);
    if (!answerId) return res.status(400).json({ error: 'Invalid answer id' });
    if (![-1, 1].includes(value)) return res.status(400).json({ error: 'Vote must be -1 or 1' });

    const exists = await get('SELECT id FROM answers WHERE id = ?', [answerId]);
    if (!exists) return res.status(404).json({ error: 'Answer not found' });

    await run(
      `INSERT INTO answer_votes (answer_id, user_id, value)
       VALUES (?, ?, ?)
       ON CONFLICT(answer_id, user_id) DO UPDATE SET value = excluded.value`,
      [answerId, req.user.id, value]
    );

    const row = await get('SELECT COALESCE(SUM(value), 0) AS votes FROM answer_votes WHERE answer_id = ?', [answerId]);
    return res.json({ votes: row.votes, myVote: value });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/answers/:id/accept', auth, async (req, res) => {
  try {
    const answerId = parsePositiveInt(req.params.id);
    if (!answerId) return res.status(400).json({ error: 'Invalid answer id' });
    const answer = await get('SELECT id, question_id FROM answers WHERE id = ?', [answerId]);
    if (!answer) return res.status(404).json({ error: 'Answer not found' });

    const question = await get('SELECT id, user_id FROM questions WHERE id = ?', [answer.question_id]);
    if (!question) return res.status(404).json({ error: 'Question not found' });
    if (question.user_id !== req.user.id) return res.status(403).json({ error: 'Only question owner can accept' });

    await run('UPDATE answers SET is_accepted = 0 WHERE question_id = ?', [question.id]);
    await run('UPDATE answers SET is_accepted = 1 WHERE id = ?', [answerId]);

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/notifications', auth, async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, type, text, is_read, question_id, answer_id, created_at
       FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.user.id]
    );

    const unread = rows.filter((r) => !r.is_read).length;
    return res.json({ unread, items: rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/read-all', auth, async (req, res) => {
  try {
    await run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/summary', auth, adminOnly, async (_req, res) => {
  try {
    const totalQuestions = await get('SELECT COUNT(1) AS c FROM questions');
    const activeUsers = await get('SELECT COUNT(1) AS c FROM users WHERE is_banned = 0');
    const pendingReports = await get("SELECT COUNT(1) AS c FROM reports WHERE status = 'pending'");
    const answersToday = await get(
      "SELECT COUNT(1) AS c FROM answers WHERE DATE(created_at) = DATE('now')"
    );

    return res.json({
      totalQuestions: totalQuestions.c,
      activeUsers: activeUsers.c,
      pendingReports: pendingReports.c,
      answersToday: answersToday.c
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', auth, adminOnly, async (_req, res) => {
  try {
    const users = await all(
      `SELECT u.id, u.username, u.role, u.is_banned, u.created_at,
              (SELECT COUNT(1) FROM questions q WHERE q.user_id = u.id) AS questions_count
       FROM users u
       ORDER BY u.created_at DESC`
    );
    res.json(users);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users/:id/ban', auth, adminOnly, async (req, res) => {
  try {
    const userId = parsePositiveInt(req.params.id);
    const banned = Boolean(req.body.banned);
    if (!userId) return res.status(400).json({ error: 'Invalid user id' });
    if (req.user.id === userId) return res.status(400).json({ error: 'Cannot ban yourself' });

    await run('UPDATE users SET is_banned = ? WHERE id = ?', [banned ? 1 : 0, userId]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/reports', auth, adminOnly, async (_req, res) => {
  try {
    const rows = await all(
      `SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at,
              u.username AS reporter
       FROM reports r
       LEFT JOIN users u ON u.id = r.reporter_user_id
       ORDER BY r.created_at DESC`
    );
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reports/:id/status', auth, adminOnly, async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    const status = String(req.body.status || '').toLowerCase();
    if (!id) return res.status(400).json({ error: 'Invalid report id' });
    if (!['pending', 'dismissed', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await run('UPDATE reports SET status = ? WHERE id = ?', [status, id]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/questions/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid question id' });
    await run('DELETE FROM question_tags WHERE question_id = ?', [id]);
    await run('DELETE FROM question_votes WHERE question_id = ?', [id]);

    const answers = await all('SELECT id FROM answers WHERE question_id = ?', [id]);
    for (const a of answers) {
      await run('DELETE FROM answer_votes WHERE answer_id = ?', [a.id]);
    }
    await run('DELETE FROM answers WHERE question_id = ?', [id]);
    await run('DELETE FROM questions WHERE id = ?', [id]);

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/answers/:id', auth, adminOnly, async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid answer id' });
    await run('DELETE FROM answer_votes WHERE answer_id = ?', [id]);
    await run('DELETE FROM answers WHERE id = ?', [id]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'stackit.html'));
});

app.use((err, _req, res, next) => {
  if (err && String(err.message || '').includes('CORS')) {
    return res.status(403).json({ error: 'Origin not allowed by CORS policy' });
  }
  return next(err);
});

seedData()
  .then(() => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`StackIt API running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
