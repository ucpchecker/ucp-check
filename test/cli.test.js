'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execFile } = require('node:child_process');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'ucp-check.js');
const { normalizeDomain } = require(BIN);

// A stand-in for ucpchecker.com that answers the way the real API does.
function server(routes) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const h = routes[`${req.method} ${req.url}`];
        if (!h) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'not_found' })); }
        h(req, res, body);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const verified = { data: { domain: 'shop.example', status: 'verified', ucp_version: '2026-04-08', manifest_url: 'https://shop.example/.well-known/ucp', observed_at: '2026-09-13T10:00:00Z', observed: true, retry_after_s: null } };

test('normalizeDomain strips scheme, path, port and www', () => {
  assert.equal(normalizeDomain('https://WWW.Shop.Example:443/x?y'), 'shop.example');
  assert.equal(normalizeDomain('not a domain'), null);
  assert.equal(normalizeDomain('localhost'), null);
});

test('live check: verified exits 0 and renders the verdict', async () => {
  const { srv, base } = await server({ 'POST /api/v1/check': (req, res, body) => { assert.equal(JSON.parse(body).domain, 'shop.example'); json(res, 200, verified); } });
  try {
    const r = await run(['shop.example', '--base-url', base]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /shop\.example\s+verified · UCP 2026-04-08/);
    assert.match(r.stdout, /report\s+.*\/status\/shop\.example/);
  } finally { srv.close(); }
});

test('live check: not_detected exits 1 (the API answers 404 with a body)', async () => {
  const { srv, base } = await server({ 'POST /api/v1/check': (req, res) => json(res, 404, { data: { ...verified.data, status: 'not_detected', ucp_version: null, manifest_url: null } }) });
  try {
    const r = await run(['shop.example', '--base-url', base]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /not detected/);
  } finally { srv.close(); }
});

test('--json prints the body verbatim; --quiet prints nothing', async () => {
  const { srv, base } = await server({ 'POST /api/v1/check': (req, res) => json(res, 200, verified) });
  try {
    const j = await run(['shop.example', '--base-url', base, '--json']);
    assert.deepEqual(JSON.parse(j.stdout), verified);
    const q = await run(['shop.example', '--base-url', base, '--quiet']);
    assert.equal(q.stdout, '');
    assert.equal(q.code, 0);
  } finally { srv.close(); }
});

test('--cached reads GET /status and reports an unseen domain as exit 1', async () => {
  const { srv, base } = await server({ 'GET /api/v1/status/shop.example': (req, res) => json(res, 404, { error: 'not_found', message: 'Domain not found in database.' }) });
  try {
    const r = await run(['shop.example', '--cached', '--base-url', base]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /not in the census yet/);
  } finally { srv.close(); }
});

test('observed:false shows the last observed state and the retry hint', async () => {
  const { srv, base } = await server({ 'POST /api/v1/check': (req, res) => json(res, 200, { data: { ...verified.data, observed: false, retry_after_s: 300 } }, { 'retry-after': '300' }) });
  try {
    const r = await run(['shop.example', '--base-url', base]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /last observed state/);
    assert.match(r.stdout, /retry in 300s/);
  } finally { srv.close(); }
});

test('429 and 5xx exit 3; the server verdict is never guessed', async () => {
  const { srv, base } = await server({ 'POST /api/v1/check': (req, res) => json(res, 429, { message: 'Too Many Attempts.' }, { 'retry-after': '42' }) });
  try {
    const r = await run(['shop.example', '--base-url', base]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /rate limited .* retry after 42s/);
  } finally { srv.close(); }
  const r2 = await run(['shop.example', '--base-url', 'http://127.0.0.1:9', '--timeout', '2']);
  assert.equal(r2.code, 3);
  assert.match(r2.stderr, /could not reach/);
});

test('usage errors exit 2', async () => {
  assert.equal((await run([])).code, 2);
  assert.equal((await run(['not a domain'])).code, 2);
  assert.equal((await run(['a.com', '--bogus'])).code, 2);
  assert.equal((await run(['--version'])).stdout.trim(), require('../package.json').version);
});
