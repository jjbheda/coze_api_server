// server.js
import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const {
  PORT = 3000,
  COZE_TOKEN,
  COZE_BASE_URL = 'https://api.coze.cn',
  // 原工作流ID（保留原有页面调用）
  COZE_WORKFLOW_ID,
  // 新增：主页抓取工作流ID（你这次要测的）
  COZE_WORKFLOW_ID_HOME, // 例如 7538006170724941870

  // 可选：默认绑定（两条接口都可用）
  DEFAULT_BOT_ID,
  DEFAULT_APP_ID,
  DEFAULT_WORKFLOW_VERSION,
} = process.env;

const mask = (s) => (s ? s.slice(0, 4) + '***' : '');
console.log('ENV CHECK =>', {
  PORT,
  COZE_BASE_URL,
  COZE_WORKFLOW_ID: mask(COZE_WORKFLOW_ID),
  COZE_WORKFLOW_ID_HOME: mask(COZE_WORKFLOW_ID_HOME),
  COZE_TOKEN: COZE_TOKEN ? 'SET' : 'MISSING',
});

const app = express();
app.disable('x-powered-by');

// ---------- CORS（含预检；放开本地端口） ----------
const allowList = new Set([
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);
const corsOptionsDelegate = (req, cb) => {
  const origin = req.header('Origin');
  const pass =
    !origin ||
    allowList.has(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  cb(
    pass ? null : new Error(`Origin ${origin} not allowed by CORS`),
    {
      origin: pass,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
      credentials: false,
    }
  );
};
app.use(cors(corsOptionsDelegate));
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- 中间件 ----------
app.use(express.json({ limit: '20mb' }));

// ---------- 根/健康检查 ----------
app.get('/', (_req, res) => {
  res.type('html').send(`
    <h3>Coze 流式代理服务运行中</h3>
    <p>健康检查：<a href="/health">/health</a></p>
    <p>原接口：POST <code>/api/coze/run-workflow/stream</code></p>
    <p>新接口：POST <code>/api/coze/home/stream</code></p>
  `);
});
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- 工具：统一转发 Coze 的 SSE ----------
async function proxyCozeStream(res, upstreamUrl, upstreamInit, { tag = 'COZE STREAM' } = {}) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(': connected\n\n');

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 1000);

  const clean = () => clearInterval(keepAlive);
  res.on('close', clean);
  res.on('finish', clean);

  try {
    const upstream = await fetch(upstreamUrl, upstreamInit);
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      console.error(`✗ ${tag} upstream error`, upstream.status, {
        'www-authenticate': upstream.headers.get('www-authenticate'),
        'x-request-id': upstream.headers.get('x-request-id'),
        'content-type': upstream.headers.get('content-type'),
        body: text,
      });
      res.write(`event: error\ndata: ${JSON.stringify({ status: upstream.status, body: text || 'no body' })}\n\n`);
      clean(); return res.end();
    }

    const bodyStream = upstream.body;
    if (bodyStream && typeof bodyStream.getReader === 'function') {
      const reader = bodyStream.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
      clean(); res.end();
    } else if (bodyStream && (typeof bodyStream.pipe === 'function' || Symbol.asyncIterator in bodyStream)) {
      bodyStream.on?.('error', (err) => {
        console.error(`${tag} stream error:`, err);
        try { res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`); } catch {}
      });
      bodyStream.on?.('data', (chunk) => { try { res.write(chunk); } catch {} });
      await new Promise((resolve) => bodyStream.on?.('end', resolve));
      clean(); res.end();
    } else {
      const text = await upstream.text().catch(() => '');
      if (text) res.write(`data: ${text}\n\n`);
      clean(); res.end();
    }
  } catch (e) {
    console.error(`✗ ${tag} proxy failed`, e);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ message: e?.message || 'stream failed' })}\n\n`);
      clean(); res.end();
    } catch {}
  }
}

// ---------- 原有：执行“输入链接”的工作流（保留） ----------
app.post('/api/coze/run-workflow/stream', async (req, res) => {
  const {
    input,
    parameters = {},
    bot_id,
    app_id,
    workflow_version,
  } = req.body || {};

  if (!input && Object.keys(parameters).length === 0) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    return res.end(`event: error\ndata: ${JSON.stringify({ message: '缺少 input 或 parameters。至少提供一个。' })}\n\n`);
  }
  if (!COZE_TOKEN) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    return res.end(`event: error\ndata: ${JSON.stringify({ message: '后端未配置 COZE_TOKEN（.env）' })}\n\n`);
  }
  if (!COZE_WORKFLOW_ID) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    return res.end(`event: error\ndata: ${JSON.stringify({ message: '后端未配置 COZE_WORKFLOW_ID（.env）' })}\n\n`);
  }

  const upstreamBody = {
    workflow_id: COZE_WORKFLOW_ID,
    parameters: { input, ...parameters },
    ...(bot_id || DEFAULT_BOT_ID ? { bot_id: bot_id || DEFAULT_BOT_ID } : {}),
    ...(app_id || DEFAULT_APP_ID ? { app_id: app_id || DEFAULT_APP_ID } : {}),
    ...(workflow_version || DEFAULT_WORKFLOW_VERSION
      ? { workflow_version: workflow_version || DEFAULT_WORKFLOW_VERSION } : {}),
  };

  console.log('[COZE STREAM] →', {
    base: COZE_BASE_URL,
    workflow_id: mask(COZE_WORKFLOW_ID),
    token: mask(COZE_TOKEN),
    withBot: Boolean(upstreamBody.bot_id),
    withApp: Boolean(upstreamBody.app_id),
  });

  await proxyCozeStream(
    res,
    `${COZE_BASE_URL}/v1/workflow/stream_run`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${COZE_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(upstreamBody),
    },
    { tag: 'COZE STREAM' }
  );
});

// ---------- 新增：执行“主页抓取”工作流（parameters.home_url） ----------
app.post('/api/coze/home/stream', async (req, res) => {
  const {
    workflow_id,     // 可在请求中手动覆盖；否则用 COZE_WORKFLOW_ID_HOME
    home_url,        // 直接传入的主页 URL
    parameters = {}, // 也允许直接传 parameters.home_url
    bot_id,
    app_id,
    workflow_version,
  } = req.body || {};

  if (!COZE_TOKEN) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    return res.end(`event: error\ndata: ${JSON.stringify({ message: '后端未配置 COZE_TOKEN（.env）' })}\n\n`);
  }

  const wfId = workflow_id || COZE_WORKFLOW_ID_HOME;
  if (!wfId) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    return res.end(`event: error\ndata: ${JSON.stringify({ message: '未提供 workflow_id，且 .env 缺少 COZE_WORKFLOW_ID_HOME' })}\n\n`);
  }

  const upstreamBody = {
    workflow_id: wfId,
    parameters: { home_url, ...parameters },
    ...(bot_id || DEFAULT_BOT_ID ? { bot_id: bot_id || DEFAULT_BOT_ID } : {}),
    ...(app_id || DEFAULT_APP_ID ? { app_id: app_id || DEFAULT_APP_ID } : {}),
    ...(workflow_version || DEFAULT_WORKFLOW_VERSION
      ? { workflow_version: workflow_version || DEFAULT_WORKFLOW_VERSION } : {}),
  };

  console.log('[COZE STREAM HOME] →', {
    base: COZE_BASE_URL,
    workflow_id: mask(wfId),
    token: mask(COZE_TOKEN),
    hasHomeUrl: Boolean(home_url || parameters?.home_url),
  });

  await proxyCozeStream(
    res,
    `${COZE_BASE_URL}/v1/workflow/stream_run`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${COZE_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(upstreamBody),
    },
    { tag: 'COZE STREAM HOME' }
  );
});

// ---------- 启动 ----------
const server = app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`🚀 Coze 流式代理服务已启动: http://localhost:${PORT}`);
});

// ---------- 全局错误兜底 ----------
process.on('uncaughtException', (err) => console.error('UNCAUGHT EXCEPTION:', err));
process.on('unhandledRejection', (reason) => console.error('UNHANDLED REJECTION:', reason));

// ---------- 优雅退出 ----------
function shutdown(sig) {
  console.log(`\n${sig} received, closing server...`);
  server.close(() => { console.log('HTTP server closed. Bye.'); process.exit(0); });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
