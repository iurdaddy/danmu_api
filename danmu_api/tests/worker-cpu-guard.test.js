import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../worker.js';
import { Globals } from '../configs/globals.js';

const baseEnv = { TOKEN: 'test-token', LOG_LEVEL: 'error', SOURCE_ORDER: '', SEARCH_RATE_LIMIT_MAX_REQUESTS: '2' };

test('无效令牌、预检和黑名单请求不调用外部服务，也不读取请求体', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  let calls = 0;
  let bodyReads = 0;
  globalThis.fetch = async () => { calls++; throw new Error('测试禁止外部请求'); };
  console.error = () => {};
  const env = { ...baseEnv, AI_API_KEY: '模拟凭据', UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: '模拟凭据' };
  try {
    for (const [path, method, extra, expected] of [
      ['/wrong-token/api/v2/match', 'POST', {}, 401],
      ['/api/v2/match', 'POST', {}, 401],
      ['/api/v2/search/episodes', 'OPTIONS', {}, 204],
      ['/test-token/api/v2/search/episodes', 'GET', { IP_BLACKLIST: '192.0.2.1' }, 403]
    ]) {
      const request = {
        url: `https://example.test${path}`, method,
        clone() { bodyReads++; throw new Error('不应读取被拒绝的请求体'); }
      };
      const response = await handleRequest(request, { ...env, ...extra }, 'cloudflare', '192.0.2.1');
      assert.equal(response.status, expected);
    }
    assert.equal(calls, 0);
    assert.equal(bodyReads, 0);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test('搜索别名和匹配接口共用额度，独立来源与弹幕下载额度互不影响', async () => {
  Globals.requestHistory = new Map([['192.0.2.2', [Date.now(), Date.now(), Date.now()]]]);
  const request = path => new Request(`https://example.test/test-token${path}`);
  // 参数缺失直接返回，测试不触发任何数据源。
  assert.equal((await handleRequest(request('/api/v2/search/episodes'), baseEnv, 'cloudflare', '192.0.2.2')).status, 400);
  assert.equal((await handleRequest(request('/search/episodes'), baseEnv, 'cloudflare', '192.0.2.2')).status, 400);
  const denied = await handleRequest(new Request('https://example.test/test-token/api/v2/match', { method: 'POST', body: '{}' }), baseEnv, 'cloudflare', '192.0.2.2');
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('Retry-After'), '60');
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await handleRequest(request('/api/v2/api/v2/search/episodes'), baseEnv, 'cloudflare', '192.0.2.2')).status, 429);
  assert.equal((await handleRequest(request('/api/v2/search/episodes'), baseEnv, 'cloudflare', '192.0.2.3')).status, 400);
  Globals.requestHistory.set('search:192.0.2.2', [Date.now() - 60001]);
  assert.equal((await handleRequest(request('/v2/search/episodes'), baseEnv, 'cloudflare', '192.0.2.2')).status, 400);
  const disabledEnv = { ...baseEnv, SEARCH_RATE_LIMIT_MAX_REQUESTS: '0' };
  for (let i = 0; i < 3; i++) {
    assert.equal((await handleRequest(request('/api/v2/search/episodes'), disabledEnv, 'cloudflare', '192.0.2.2')).status, 400);
  }
  Globals.requestHistory.clear();
});
