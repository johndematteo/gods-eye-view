// The HUD summary against a self-hosted OpenAI-compatible endpoint:
// Chat Completions instead of the Responses API, configured with or without
// a key, and the cloud paths byte-identical to before.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { handleHudSummary } from '../server/providers/openai/hud-summary.js';

// The OpenAI cost limiter is cached at module scope on first use, so this
// file disables it up front; a second cap here would need its own process.
process.env.GEV_RATELIMIT_OPENAI_PER_MIN = '0';

/** Drive the handler with a small mock req/res pair, like the route sees it. */
function request(handler, { method = 'POST', url = '/', body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(body)]);
    Object.assign(req, {
      method,
      url,
      headers: { host: 'localhost:4173', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      aborted: false,
    });
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      end(payload = '') {
        resolve({
          status: this.statusCode,
          headers,
          body: payload ? JSON.parse(payload) : null,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const UPSTREAM = 'http://llm.lan:11434/v1';

function mockUpstream(calls, reply) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith(UPSTREAM)) {
      calls.push({
        url: String(url),
        body: JSON.parse(options.body),
        authorization: options.headers?.Authorization,
      });
      return Response.json(reply);
    }
    return realFetch(url, options);
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

const CHAT_REPLY = {
  choices: [
    {
      message: {
        role: 'assistant',
        content: '{"summary":"Two flights over Austin","feedState":null}',
      },
    },
  ],
};

test('self-hosted HUD summary: status probe, keyless POST, Chat Completions body', async (t) => {
  process.env.OPENAI_BASE_URL = UPSTREAM;
  delete process.env.OPENAI_API_KEY;
  t.after(() => delete process.env.OPENAI_BASE_URL);

  const status = await request(handleHudSummary, { method: 'GET', url: '/status' });
  assert.equal(status.status, 200);
  assert.equal(status.body.configured, true, 'keyless self-hosted is configured');

  const calls = [];
  const restore = mockUpstream(calls, CHAT_REPLY);
  t.after(restore);
  const response = await request(handleHudSummary, { body: '{"locale":"en"}' });
  assert.equal(response.status, 200);
  assert.equal(response.body.summary, 'Two flights over Austin');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${UPSTREAM}/chat/completions`);
  assert.equal(calls[0].authorization, undefined, 'no key means no bearer');
  assert.deepEqual(Object.keys(calls[0].body).sort(), [
    'max_tokens',
    'messages',
    'model',
    'response_format',
    'stream',
  ]);
});

test('self-hosted HUD summary with a key still sends the bearer', async (t) => {
  process.env.OPENAI_BASE_URL = UPSTREAM;
  process.env.OPENAI_API_KEY = 'sk-fixture';
  t.after(() => {
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
  });
  const calls = [];
  const restore = mockUpstream(calls, CHAT_REPLY);
  t.after(restore);
  const response = await request(handleHudSummary, { body: '{"locale":"en"}' });
  assert.equal(response.status, 200);
  assert.equal(calls[0].authorization, 'Bearer sk-fixture');
});

test('cloud HUD summary keeps the Responses API and the graceful keyless reply', async (t) => {
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  const status = await request(handleHudSummary, { method: 'GET', url: '/status' });
  assert.equal(status.body.configured, false);
  const response = await request(handleHudSummary, { body: '{"locale":"en"}' });
  assert.equal(response.status, 200);
  assert.equal(response.body.code, 'OPENAI_NOT_CONFIGURED');
});

test('a self-hosted reply wrapped in a markdown code fence is still read', async (t) => {
  process.env.OPENAI_BASE_URL = UPSTREAM;
  delete process.env.OPENAI_API_KEY;
  t.after(() => delete process.env.OPENAI_BASE_URL);
  const calls = [];
  const restore = mockUpstream(calls, {
    choices: [
      {
        message: {
          role: 'assistant',
          content:
            '```json\n{"summary":"Two flights over Austin","feedState":"nominal"}\n```',
        },
      },
    ],
  });
  t.after(restore);
  const response = await request(handleHudSummary, { body: '{"locale":"en"}' });
  assert.equal(response.status, 200);
  assert.equal(response.body.summary, 'Two flights over Austin');
  assert.equal(response.body.feedState, 'nominal');
});

test('a non-JSON self-hosted reply degrades to no summary, never a crash', async (t) => {
  process.env.OPENAI_BASE_URL = UPSTREAM;
  delete process.env.OPENAI_API_KEY;
  t.after(() => delete process.env.OPENAI_BASE_URL);
  const calls = [];
  const restore = mockUpstream(calls, {
    choices: [{ message: { role: 'assistant', content: 'plain prose, no JSON' } }],
  });
  t.after(restore);
  const response = await request(handleHudSummary, { body: '{"locale":"en"}' });
  assert.equal(response.status, 200);
  assert.equal(response.body.summary, null);
});
