'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  loadConfig,
  createLogger,
  createApp,
  splitMessage,
  extractMessages,
  isValidSignature,
  createMessageCache,
  WHATSAPP_TEXT_LIMIT,
  ConfigError,
} = require('../index.js');

const silentLogger = createLogger('error');

const baseConfig = {
  port: 0,
  geminiApiKey: 'test-gemini-key',
  geminiModel: 'gemini-2.5-flash',
  geminiThinkingBudget: 0,
  whatsappToken: 'test-wa-token',
  phoneNumberId: '123456789012345',
  verifyToken: 'verify-me',
  appSecret: null,
  graphApiVersion: 'v25.0',
  systemPrompt: 'test',
  maxHistoryTurns: 20,
  sessionTtlMs: 60_000,
  sendReadReceipts: false,
  requestTimeoutMs: 5000,
  logLevel: 'error',
};

/** Minimal HTTP client: starts the app on an ephemeral port and issues requests. */
async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function textPayload({ id = 'wamid.TEST1', from = '919999999999', body = 'Hi!' } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: '123456789012345' },
              messages: [
                {
                  from,
                  id,
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function statusPayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              statuses: [{ id: 'wamid.X', status: 'read', timestamp: '1700000000' }],
            },
          },
        ],
      },
    ],
  };
}

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

test('loadConfig applies defaults and coerces types', () => {
  const config = loadConfig({
    GEMINI_API_KEY: 'g',
    WHATSAPP_TOKEN: 'w',
    PHONE_NUMBER_ID: '1',
    VERIFY_TOKEN: 'v',
  });

  assert.equal(config.port, 3000);
  assert.equal(config.geminiModel, 'gemini-2.5-flash');
  assert.equal(config.graphApiVersion, 'v25.0');
  assert.equal(config.maxHistoryTurns, 20);
  assert.equal(config.sendReadReceipts, false);
  assert.ok(!('appSecret' in config) || config.appSecret === null);
  assert.ok(Object.isFrozen(config));
});

test('loadConfig fails fast with a clear message when keys are missing', () => {
  assert.throws(
    () => loadConfig({ GEMINI_API_KEY: 'g' }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /WHATSAPP_TOKEN/);
      assert.match(error.message, /PHONE_NUMBER_ID/);
      assert.match(error.message, /VERIFY_TOKEN/);
      return true;
    },
  );
});

// --------------------------------------------------------------------------
// Webhook verification (GET /webhook)
// --------------------------------------------------------------------------

test('GET /webhook echoes hub.challenge for a valid verify token', async () => {
  const app = createApp({
    config: baseConfig,
    logger: silentLogger,
    generateReply: async () => 'unused',
    whatsapp: { sendText: async () => ({}), markAsRead: async () => ({}) },
  });

  await withServer(app, async (origin) => {
    const res = await fetch(
      `${origin}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444`,
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '1158201444');
  });
});

test('GET /webhook rejects a wrong token with 403 and a bad mode with 400', async () => {
  const app = createApp({
    config: baseConfig,
    logger: silentLogger,
    generateReply: async () => 'unused',
    whatsapp: { sendText: async () => ({}), markAsRead: async () => ({}) },
  });

  await withServer(app, async (origin) => {
    const badToken = await fetch(
      `${origin}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`,
    );
    assert.equal(badToken.status, 403);

    const badMode = await fetch(
      `${origin}/webhook?hub.mode=unsubscribe&hub.verify_token=verify-me&hub.challenge=1`,
    );
    assert.equal(badMode.status, 400);
  });
});

// --------------------------------------------------------------------------
// Incoming messages (POST /webhook)
// --------------------------------------------------------------------------

test('POST /webhook acks 200 immediately and replies asynchronously', async () => {
  const sent = [];
  let resolveGenerate;
  const generated = new Promise((resolve) => {
    resolveGenerate = resolve;
  });

  const app = createApp({
    config: baseConfig,
    logger: silentLogger,
    generateReply: async ({ userId, text }) => {
      resolveGenerate({ userId, text });
      return 'Hello from Gemini!';
    },
    whatsapp: {
      sendText: async (args) => {
        sent.push(args);
        return {};
      },
      markAsRead: async () => ({}),
    },
  });

  await withServer(app, async (origin) => {
    const res = await fetch(`${origin}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(textPayload()),
    });
    assert.equal(res.status, 200);

    const call = await generated;
    assert.deepEqual(call, { userId: '919999999999', text: 'Hi!' });

    // Give the background task a tick to finish sending.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, '919999999999');
    assert.equal(sent[0].text, 'Hello from Gemini!');
  });
});

test('POST /webhook ignores status updates and non-text messages', async () => {
  let called = 0;
  const app = createApp({
    config: baseConfig,
    logger: silentLogger,
    generateReply: async () => {
      called += 1;
      return 'nope';
    },
    whatsapp: { sendText: async () => ({}), markAsRead: async () => ({}) },
  });

  await withServer(app, async (origin) => {
    const statusRes = await fetch(`${origin}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(statusPayload()),
    });
    assert.equal(statusRes.status, 200);

    const imagePayload = textPayload();
    const message = imagePayload.entry[0].changes[0].value.messages[0];
    message.type = 'image';
    delete message.text;

    const imageRes = await fetch(`${origin}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(imagePayload),
    });
    assert.equal(imageRes.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(called, 0);
  });
});

test('POST /webhook drops Meta retries of the same message id', async () => {
  let called = 0;
  const app = createApp({
    config: baseConfig,
    logger: silentLogger,
    generateReply: async () => {
      called += 1;
      return 'once';
    },
    whatsapp: { sendText: async () => ({}), markAsRead: async () => ({}) },
  });

  await withServer(app, async (origin) => {
    const body = JSON.stringify(textPayload({ id: 'wamid.DUP' }));
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${origin}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 200);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(called, 1);
  });
});

test('POST /webhook never crashes on malformed payloads', async () => {
  const app = createApp({
    config: baseConfig,
    logger: silentLogger,
    generateReply: async () => 'x',
    whatsapp: { sendText: async () => ({}), markAsRead: async () => ({}) },
  });

  await withServer(app, async (origin) => {
    for (const body of ['{}', 'null', '{"entry":[]}', '{"entry":[{"changes":null}]}', '[]']) {
      const res = await fetch(`${origin}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 200, `payload ${body} should be acked`);
    }

    const badJson = await fetch(`${origin}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"entry":',
    });
    assert.equal(badJson.status, 400);
  });
});

test('POST /webhook sends a fallback reply when Gemini fails', async () => {
  const sent = [];
  const app = createApp({
    config: baseConfig,
    logger: silentLogger,
    generateReply: async () => {
      throw new Error('gemini exploded');
    },
    whatsapp: {
      sendText: async (args) => {
        sent.push(args);
        return {};
      },
      markAsRead: async () => ({}),
    },
  });

  await withServer(app, async (origin) => {
    const res = await fetch(`${origin}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(textPayload({ id: 'wamid.FAIL' })),
    });
    assert.equal(res.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /couldn't generate a reply/);
  });
});

test('POST /webhook enforces X-Hub-Signature-256 when WHATSAPP_APP_SECRET is set', async () => {
  const config = { ...baseConfig, appSecret: 'shhh' };
  let called = 0;
  const app = createApp({
    config,
    logger: silentLogger,
    generateReply: async () => {
      called += 1;
      return 'ok';
    },
    whatsapp: { sendText: async () => ({}), markAsRead: async () => ({}) },
  });

  await withServer(app, async (origin) => {
    const body = JSON.stringify(textPayload({ id: 'wamid.SIG' }));

    const unsigned = await fetch(`${origin}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(unsigned.status, 401);

    const signature = `sha256=${crypto.createHmac('sha256', 'shhh').update(body).digest('hex')}`;
    const signed = await fetch(`${origin}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body,
    });
    assert.equal(signed.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(called, 1);
  });
});

test('GET /health responds with a JSON status', async () => {
  const app = createApp({
    config: baseConfig,
    logger: silentLogger,
    generateReply: async () => 'x',
    whatsapp: { sendText: async () => ({}), markAsRead: async () => ({}) },
  });

  await withServer(app, async (origin) => {
    const res = await fetch(`${origin}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.model, 'gemini-2.5-flash');
  });
});

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

test('splitMessage keeps short text intact and chunks long text under the limit', () => {
  assert.deepEqual(splitMessage('hello'), ['hello']);
  assert.deepEqual(splitMessage('   '), []);

  const paragraph = `${'a'.repeat(2000)}\n\n${'b'.repeat(3000)}`;
  const chunks = splitMessage(paragraph);
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) assert.ok(chunk.length <= WHATSAPP_TEXT_LIMIT);
  assert.equal(chunks.join('\n\n').replace(/\s+/g, ''), paragraph.replace(/\s+/g, ''));

  const noSpaces = 'x'.repeat(9000);
  const hardChunks = splitMessage(noSpaces);
  assert.equal(hardChunks.length, 3);
  assert.equal(hardChunks.join('').length, 9000);
});

test('extractMessages walks nested payloads and tolerates junk', () => {
  const logger = createLogger('error');
  assert.deepEqual(extractMessages(null, logger), []);
  assert.deepEqual(extractMessages({}, logger), []);
  assert.equal(extractMessages(textPayload(), logger).length, 1);
  assert.equal(extractMessages(statusPayload(), logger).length, 0);
});

test('isValidSignature validates HMAC-SHA256 and rejects tampering', () => {
  const raw = Buffer.from(JSON.stringify({ hello: 'world' }));
  const good = `sha256=${crypto.createHmac('sha256', 'secret').update(raw).digest('hex')}`;

  assert.equal(isValidSignature(raw, good, 'secret'), true);
  assert.equal(isValidSignature(raw, good, 'other-secret'), false);
  assert.equal(isValidSignature(raw, 'sha256=deadbeef', 'secret'), false);
  assert.equal(isValidSignature(raw, undefined, 'secret'), false);
  assert.equal(isValidSignature(raw, good, ''), false);
});

test('createMessageCache remembers ids until the TTL expires', () => {
  const cache = createMessageCache({ ttlMs: 20 });
  assert.equal(cache.seen('a'), false);
  assert.equal(cache.seen('a'), true);
  assert.equal(cache.seen(''), false);
  return new Promise((resolve) =>
    setTimeout(() => {
      assert.equal(cache.seen('a'), false);
      resolve();
    }, 40),
  );
});
