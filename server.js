/**
 * ReviewHub — Production Server
 * Handles static serving, security headers, Anthropic API proxying,
 * and Slack webhook proxying so secrets never touch the client.
 */

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));

// ── SECURITY HEADERS ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options',        'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection',       '1; mode=block');
  res.setHeader('Referrer-Policy',        'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',     'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data: https://m.media-amazon.com",
      "font-src 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  next();
});

// ── SIMPLE IN-MEMORY RATE LIMITER ─────────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(windowMs, maxRequests) {
  return (req, res, next) => {
    const ip  = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const key = `${ip}:${req.path}`;

    if (!rateLimitMap.has(key)) {
      rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    const entry = rateLimitMap.get(key);
    if (now > entry.resetAt) {
      entry.count   = 1;
      entry.resetAt = now + windowMs;
      return next();
    }

    if (entry.count >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please wait and try again.' });
    }

    entry.count++;
    next();
  };
}

// Clean stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap.entries()) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000);

// ── ANTHROPIC API PROXY ───────────────────────────────────────────────────────
// The API key lives ONLY in the server environment — never sent to the browser.
app.post(
  '/api/ai',
  rateLimit(60_000, 10), // 10 requests per minute per IP
  async (req, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: 'AI features are not configured. Set ANTHROPIC_API_KEY in your environment variables.',
      });
    }

    const { prompt, maxTokens = 1000, system } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required and must be a string.' });
    }
    if (prompt.length > 20000) {
      return res.status(400).json({ error: 'Prompt too long.' });
    }

    try {
      const body = {
        model:      'claude-sonnet-4-20250514',
        max_tokens: Math.min(Number(maxTokens) || 1000, 2000),
        messages:   [{ role: 'user', content: prompt }],
      };
      if (system) body.system = String(system).slice(0, 2000);

      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'Content-Type':         'application/json',
          'x-api-key':            apiKey,
          'anthropic-version':    '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      const data = await upstream.json();

      if (!upstream.ok) {
        console.error('[AI proxy] upstream error:', upstream.status, data);
        return res.status(upstream.status).json({ error: data?.error?.message || 'AI service error.' });
      }

      const text = data?.content?.[0]?.text ?? '';
      res.json({ text });
    } catch (err) {
      console.error('[AI proxy] fetch error:', err.message);
      res.status(502).json({ error: 'Could not reach AI service. Please try again.' });
    }
  }
);

// ── SLACK WEBHOOK PROXY ───────────────────────────────────────────────────────
// Webhook URL lives ONLY in the server — never exposed to the browser.
app.post(
  '/api/slack',
  rateLimit(60_000, 30), // 30 Slack messages per minute per IP
  async (req, res) => {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
      return res.status(503).json({ error: 'Slack not configured. Set SLACK_WEBHOOK_URL in environment variables.' });
    }

    const { blocks, text } = req.body;
    if (!text && !blocks) {
      return res.status(400).json({ error: 'text or blocks required.' });
    }

    try {
      const upstream = await fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, blocks }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        console.error('[Slack proxy] upstream error:', upstream.status, errText);
        return res.status(502).json({ error: 'Slack returned an error. Check your webhook URL.' });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('[Slack proxy] fetch error:', err.message);
      res.status(502).json({ error: 'Could not reach Slack. Please try again.' });
    }
  }
);

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    ai:        !!process.env.ANTHROPIC_API_KEY,
    slack:     !!process.env.SLACK_WEBHOOK_URL,
  });
});

// ── STATIC + SPA FALLBACK ─────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge:     '1h',
  etag:       true,
  lastModified: true,
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── GLOBAL ERROR HANDLER ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[server error]', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ReviewHub running on port ${PORT}`);
  console.log(`  AI features: ${process.env.ANTHROPIC_API_KEY ? 'enabled' : 'disabled (set ANTHROPIC_API_KEY)'}`);
  console.log(`  Slack: ${process.env.SLACK_WEBHOOK_URL ? 'enabled' : 'disabled (set SLACK_WEBHOOK_URL)'}`);
});
