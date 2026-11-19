import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPENAI_BASE_URL_DEFAULT,
  resolveOpenAiEndpoint,
} from './endpoint.js';

test('an unset or blank OPENAI_BASE_URL is the cloud endpoint', () => {
  for (const env of [{}, { OPENAI_BASE_URL: undefined }, { OPENAI_BASE_URL: '' }, { OPENAI_BASE_URL: '   ' }]) {
    assert.deepEqual(resolveOpenAiEndpoint(env), {
      baseUrl: OPENAI_BASE_URL_DEFAULT,
      selfHosted: false,
    });
  }
});

test('a self-hosted URL is normalized (trailing slash trimmed) and flagged', () => {
  assert.deepEqual(resolveOpenAiEndpoint({ OPENAI_BASE_URL: 'http://localhost:11434/v1/' }), {
    baseUrl: 'http://localhost:11434/v1',
    selfHosted: true,
  });
  assert.deepEqual(resolveOpenAiEndpoint({ OPENAI_BASE_URL: 'https://llm.lan:8080' }), {
    baseUrl: 'https://llm.lan:8080',
    selfHosted: true,
  });
  // The cloud URL itself, spelled by the operator, is still the cloud path.
  assert.deepEqual(resolveOpenAiEndpoint({ OPENAI_BASE_URL: 'https://api.openai.com/v1' }), {
    baseUrl: OPENAI_BASE_URL_DEFAULT,
    selfHosted: false,
  });
});

test('an unusable OPENAI_BASE_URL refuses with null, never a silent fallback', () => {
  for (const value of [
    'localhost:11434/v1', // no scheme
    'not a url',
    'ftp://llm.lan/v1', // not http(s)
    'http://user:pw@llm.lan/v1', // embedded credentials
    'http://llm.lan/v1?x=1', // query
    'http://llm.lan/v1#frag', // fragment
  ]) {
    assert.equal(resolveOpenAiEndpoint({ OPENAI_BASE_URL: value }), null, value);
  }
});
