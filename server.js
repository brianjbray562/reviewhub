/**
 * ReviewHub — Production Server v2
 *
 * What lives where:
 *   - Reviews       → public/data/reviews.json  (static, committed to repo)
 *   - Tickets       → PostgreSQL                 (shared, real-time)
 *   - Tags/escalations → PostgreSQL              (shared, real-time)
 *   - Passwords     → PostgreSQL                 (shared, admin-managed)
 *   - AI / Slack    → proxied server-side        (keys never reach browser)
 */

'use strict';

const express = require('express');
const path    = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '4mb' }));

// ── POSTGRES ──────────────────────────────────────────────────────────────────
let pool = null;
let dbReady = false;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    console.error('[db] unexpected pool error:', err.message);
  });

  // Run migrations on startup
  initDB().then(() => {
    dbReady = true;
    console.log('[db] ready');
  }).catch(err => {
    console.error('[db] init failed:', err.message);
  });
} else {
  console.warn('[db] DATABASE_URL not set — collaborative features disabled. Set it in Render environment variables.');
}

async function query(sql, params = []) {
  if (!pool) throw new Error('Database not configured. Set DATABASE_URL in environment variables.');
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function initDB() {
  // Create all tables if they don't exist — idempotent, safe to run on every boot
  await query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id           TEXT PRIMARY KEY,
      review_id    TEXT,
      review_title TEXT NOT NULL,
      sku          TEXT NOT NULL DEFAULT '',
      priority     TEXT NOT NULL DEFAULT 'medium',
      category     TEXT NOT NULL DEFAULT 'product',
      notes        TEXT NOT NULL DEFAULT '',
      teams        JSONB NOT NULL DEFAULT '[]',
      status       TEXT NOT NULL DEFAULT 'open',
      created_at   BIGINT NOT NULL,
      created_by   TEXT NOT NULL DEFAULT '',
      is_insight   BOOLEAN NOT NULL DEFAULT FALSE,
      comments     JSONB NOT NULL DEFAULT '[]',
      audit_log    JSONB NOT NULL DEFAULT '[]',
      updated_at   BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS review_tags (
      review_id  TEXT PRIMARY KEY,
      tags       JSONB  NOT NULL DEFAULT '[]',
      escalated  BOOLEAN NOT NULL DEFAULT FALSE,
      ticket_id  TEXT,
      updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
      updated_by TEXT NOT NULL DEFAULT ''
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL
    )
  `);

  // Indexes for common queries
  await query(`CREATE INDEX IF NOT EXISTS idx_tickets_status   ON tickets(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tickets_created  ON tickets(created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tags_escalated   ON review_tags(escalated)`);

  console.log('[db] migrations complete');
}

// ── SECURITY HEADERS ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options',        'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection',       '1; mode=block');
  res.setHeader('Referrer-Policy',        'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',     'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data: https://m.media-amazon.com",
    "font-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});

// ── RATE LIMITER ──────────────────────────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const ip  = req.ip || 'unknown';
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    const e   = rateLimitMap.get(key);
    if (!e || now > e.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (e.count >= max) return res.status(429).json({ error: 'Too many requests.' });
    e.count++;
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap) if (now > v.resetAt) rateLimitMap.delete(k);
}, 5 * 60 * 1000);

// ── DB REQUIRED MIDDLEWARE ────────────────────────────────────────────────────
function requireDB(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'Database not configured. Set DATABASE_URL in Render environment variables.' });
  next();
}

// ── TAGS / ESCALATIONS API ────────────────────────────────────────────────────

// GET /api/tags — fetch all tag records (used on app load to merge with reviews)
app.get('/api/tags', requireDB, async (req, res) => {
  try {
    const result = await query('SELECT * FROM review_tags ORDER BY updated_at DESC');
    res.json(result.rows.map(r => ({
      reviewId:  r.review_id,
      tags:      r.tags,
      escalated: r.escalated,
      ticketId:  r.ticket_id,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    })));
  } catch (err) {
    console.error('[GET /api/tags]', err.message);
    res.status(500).json({ error: 'Failed to load tags.' });
  }
});

// POST /api/tags — upsert tags/escalation state for one or more reviews
app.post('/api/tags', requireDB, rateLimit(60_000, 120), async (req, res) => {
  const { updates } = req.body; // array of { reviewId, tags, escalated, ticketId, updatedBy }
  if (!Array.isArray(updates) || !updates.length) {
    return res.status(400).json({ error: 'updates array required.' });
  }

  try {
    // Batch upsert
    for (const u of updates) {
      if (!u.reviewId || typeof u.reviewId !== 'string') continue;
      await query(`
        INSERT INTO review_tags (review_id, tags, escalated, ticket_id, updated_at, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (review_id) DO UPDATE SET
          tags       = EXCLUDED.tags,
          escalated  = EXCLUDED.escalated,
          ticket_id  = EXCLUDED.ticket_id,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by
      `, [
        u.reviewId,
        JSON.stringify(u.tags || []),
        u.escalated || false,
        u.ticketId || null,
        Date.now(),
        u.updatedBy || '',
      ]);
    }
    res.json({ ok: true, count: updates.length });
  } catch (err) {
    console.error('[POST /api/tags]', err.message);
    res.status(500).json({ error: 'Failed to save tags.' });
  }
});

// ── TICKETS API ───────────────────────────────────────────────────────────────

// GET /api/tickets — fetch all tickets
app.get('/api/tickets', requireDB, async (req, res) => {
  try {
    const result = await query('SELECT * FROM tickets ORDER BY created_at DESC');
    res.json(result.rows.map(dbTicketToClient));
  } catch (err) {
    console.error('[GET /api/tickets]', err.message);
    res.status(500).json({ error: 'Failed to load tickets.' });
  }
});

// POST /api/tickets — create a new ticket
app.post('/api/tickets', requireDB, rateLimit(60_000, 60), async (req, res) => {
  const t = req.body;
  if (!t.id || !t.reviewTitle) return res.status(400).json({ error: 'id and reviewTitle required.' });

  try {
    await query(`
      INSERT INTO tickets
        (id, review_id, review_title, sku, priority, category, notes, teams,
         status, created_at, created_by, is_insight, comments, audit_log, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO NOTHING
    `, [
      t.id, t.reviewId || null, t.reviewTitle, t.sku || '',
      t.priority || 'medium', t.category || 'product', t.notes || '',
      JSON.stringify(t.teams || []),
      t.status || 'open',
      t.createdAt || Date.now(), t.createdBy || '',
      t.isInsightTicket || false,
      JSON.stringify(t.comments || []),
      JSON.stringify(t.auditLog || []),
      Date.now(),
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/tickets]', err.message);
    res.status(500).json({ error: 'Failed to create ticket.' });
  }
});

// PATCH /api/tickets/:id — update status, add comment, or update notes
app.patch('/api/tickets/:id', requireDB, rateLimit(60_000, 120), async (req, res) => {
  const { id } = req.params;
  const { status, comment, commentUser, notes, priority, teams } = req.body;
  const now = Date.now();

  try {
    // Fetch existing row first
    const existing = await query('SELECT * FROM tickets WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Ticket not found.' });

    const row      = existing.rows[0];
    const comments = Array.isArray(row.comments) ? row.comments : [];
    const auditLog = Array.isArray(row.audit_log) ? row.audit_log : [];

    if (comment && commentUser) {
      comments.push({ user: commentUser, text: comment, at: now });
      auditLog.push({ action: 'comment', by: commentUser, at: now });
    }
    if (status && status !== row.status) {
      auditLog.push({ action: `status: ${row.status} → ${status}`, by: commentUser || 'system', at: now });
    }

    await query(`
      UPDATE tickets SET
        status     = COALESCE($1, status),
        notes      = COALESCE($2, notes),
        priority   = COALESCE($3, priority),
        teams      = COALESCE($4, teams),
        comments   = $5,
        audit_log  = $6,
        updated_at = $7
      WHERE id = $8
    `, [
      status  || null,
      notes   || null,
      priority|| null,
      teams   ? JSON.stringify(teams) : null,
      JSON.stringify(comments),
      JSON.stringify(auditLog),
      now,
      id,
    ]);

    // Return updated ticket
    const updated = await query('SELECT * FROM tickets WHERE id = $1', [id]);
    res.json(dbTicketToClient(updated.rows[0]));
  } catch (err) {
    console.error('[PATCH /api/tickets/:id]', err.message);
    res.status(500).json({ error: 'Failed to update ticket.' });
  }
});

// DELETE /api/tickets/:id — admin only guard is on the client; server accepts it
app.delete('/api/tickets/:id', requireDB, rateLimit(60_000, 30), async (req, res) => {
  try {
    await query('DELETE FROM tickets WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/tickets/:id]', err.message);
    res.status(500).json({ error: 'Failed to delete ticket.' });
  }
});

// ── PASSWORDS API ─────────────────────────────────────────────────────────────

// GET /api/passwords — returns hashed passwords (admin-use on login)
// We store them as plaintext for now (same as before) — upgrade to bcrypt later
app.get('/api/passwords', requireDB, async (req, res) => {
  try {
    const result = await query("SELECT value FROM app_settings WHERE key = 'passwords'");
    const defaults = { admin:'admin123', marketing:'mkt123', product:'prod123', tech:'tech123', cs:'cs123' };
    res.json(result.rows.length ? result.rows[0].value : defaults);
  } catch (err) {
    console.error('[GET /api/passwords]', err.message);
    res.status(500).json({ error: 'Failed to load passwords.' });
  }
});

// PUT /api/passwords — update a single team password (admin only enforced on client)
app.put('/api/passwords', requireDB, rateLimit(60_000, 20), async (req, res) => {
  const { role, password } = req.body;
  if (!role || !password || password.length < 4) {
    return res.status(400).json({ error: 'role and password (min 4 chars) required.' });
  }

  try {
    // Fetch current, merge, upsert
    const current = await query("SELECT value FROM app_settings WHERE key = 'passwords'");
    const defaults = { admin:'admin123', marketing:'mkt123', product:'prod123', tech:'tech123', cs:'cs123' };
    const pw = current.rows.length ? current.rows[0].value : defaults;
    pw[role] = password;

    await query(`
      INSERT INTO app_settings (key, value) VALUES ('passwords', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `, [JSON.stringify(pw)]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /api/passwords]', err.message);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

// ── AI PROXY ──────────────────────────────────────────────────────────────────
app.post('/api/ai', rateLimit(60_000, 10), async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AI features not configured. Set ANTHROPIC_API_KEY in Render.' });

  const { prompt, maxTokens = 1000, system } = req.body;
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt required.' });
  if (prompt.length > 20000) return res.status(400).json({ error: 'Prompt too long.' });

  try {
    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: Math.min(Number(maxTokens) || 1000, 2000),
      messages: [{ role: 'user', content: prompt }],
    };
    if (system) body.system = String(system).slice(0, 2000);

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: data?.error?.message || 'AI error.' });
    res.json({ text: data?.content?.[0]?.text ?? '' });
  } catch (err) {
    console.error('[AI proxy]', err.message);
    res.status(502).json({ error: 'Could not reach AI service.' });
  }
});

// ── SLACK PROXY ───────────────────────────────────────────────────────────────
app.post('/api/slack', rateLimit(60_000, 30), async (req, res) => {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return res.status(503).json({ error: 'Slack not configured. Set SLACK_WEBHOOK_URL in Render.' });

  const { blocks, text } = req.body;
  if (!text && !blocks) return res.status(400).json({ error: 'text or blocks required.' });

  try {
    const upstream = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, blocks }),
    });
    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('[Slack proxy]', upstream.status, errText);
      return res.status(502).json({ error: 'Slack returned an error.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Slack proxy]', err.message);
    res.status(502).json({ error: 'Could not reach Slack.' });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  let dbStatus = 'not configured';
  if (pool) {
    try {
      await query('SELECT 1');
      dbStatus = 'connected';
    } catch {
      dbStatus = 'error';
    }
  }
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    db:        dbStatus,
    ai:        !!process.env.ANTHROPIC_API_KEY,
    slack:     !!process.env.SLACK_WEBHOOK_URL,
  });
});

// ── HELPERS ───────────────────────────────────────────────────────────────────
function dbTicketToClient(row) {
  return {
    id:              row.id,
    reviewId:        row.review_id,
    reviewTitle:     row.review_title,
    sku:             row.sku,
    priority:        row.priority,
    category:        row.category,
    notes:           row.notes,
    teams:           Array.isArray(row.teams)    ? row.teams    : (row.teams    || []),
    status:          row.status,
    createdAt:       Number(row.created_at),
    createdBy:       row.created_by,
    isInsightTicket: row.is_insight,
    comments:        Array.isArray(row.comments)  ? row.comments  : (row.comments  || []),
    auditLog:        Array.isArray(row.audit_log) ? row.audit_log : (row.audit_log || []),
    updatedAt:       Number(row.updated_at),
  };
}

// ── STATIC + SPA ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h', etag: true, lastModified: true,
}));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── ERROR HANDLER ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[server error]', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ReviewHub running on port ${PORT}`);
  console.log(`  DB:    ${process.env.DATABASE_URL ? 'configured' : 'not configured (set DATABASE_URL)'}`);
  console.log(`  AI:    ${process.env.ANTHROPIC_API_KEY ? 'enabled' : 'disabled'}`);
  console.log(`  Slack: ${process.env.SLACK_WEBHOOK_URL ? 'enabled' : 'disabled'}`);
});
