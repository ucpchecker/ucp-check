#!/usr/bin/env node
'use strict';

// ucp-check — is this domain verified for the Universal Commerce Protocol?
//
// A thin client over the UCP Checker REST API. It renders the verdict the
// server returns and turns it into an exit code. It never inspects the
// manifest itself and never scores anything locally: one fact, one owner.
//
// Exit codes are the contract:
//   0  verified
//   1  not verified (not_detected, invalid, blocked, unreachable, pending)
//   2  usage error (bad flags, malformed domain)
//   3  API unreachable, timed out, or rate limit exhausted

const pkg = require('../package.json');

const DEFAULT_BASE = 'https://ucpchecker.com';
const USAGE = `ucp-check ${pkg.version}

Usage
  ucp-check <domain> [options]

Options
  --cached            Read the last observed state instead of running a live check
  --json              Print the API response as JSON, exactly as served
  --quiet             No output; exit code only
  --base-url <url>    API origin (default ${DEFAULT_BASE}, or UCP_CHECK_BASE_URL)
  --timeout <s>       Seconds to wait for the API (default 60)
  -h, --help          Show this help
  -v, --version       Print the version

Exit codes
  0  verified   1  not verified   2  usage   3  API unreachable or rate limited

Examples
  npx ucp-check example.com
  npx ucp-check example.com --cached --json
  # CI gate — fails the job unless the live manifest verifies
  npx ucp-check example.com --quiet
`;

function parseArgs(argv) {
  const opts = { cached: false, json: false, quiet: false, baseUrl: process.env.UCP_CHECK_BASE_URL || DEFAULT_BASE, timeout: 60, domain: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '-v' || a === '--version') return { version: true };
    if (a === '--cached') { opts.cached = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--quiet' || a === '-q') { opts.quiet = true; continue; }
    if (a === '--base-url' || a === '--timeout') {
      const v = argv[++i];
      if (v === undefined) throw usage(`${a} needs a value`);
      if (a === '--base-url') opts.baseUrl = v;
      else {
        opts.timeout = Number(v);
        if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw usage('--timeout must be a positive number of seconds');
      }
      continue;
    }
    if (a.startsWith('-')) throw usage(`unknown option ${a}`);
    if (opts.domain !== null) throw usage('only one domain per run');
    opts.domain = a;
  }
  if (opts.domain === null) throw usage('a domain is required');
  opts.domain = normalizeDomain(opts.domain);
  if (!opts.domain) throw usage('that does not look like a domain');
  opts.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  return opts;
}

// Accepts "example.com", "https://example.com/path", "EXAMPLE.com:443". The
// server applies its own normalisation and validation; this only needs to be
// permissive enough not to reject a domain the API would accept.
function normalizeDomain(input) {
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/:\d+$/, '');
  s = s.replace(/^www\./, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null;
  return s;
}

function usage(msg) {
  const e = new Error(msg);
  e.exitCode = 2;
  return e;
}

function apiError(msg) {
  const e = new Error(msg);
  e.exitCode = 3;
  return e;
}

async function callApi(opts) {
  const url = opts.cached
    ? `${opts.baseUrl}/api/v1/status/${encodeURIComponent(opts.domain)}`
    : `${opts.baseUrl}/api/v1/check`;
  const init = {
    method: opts.cached ? 'GET' : 'POST',
    headers: {
      accept: 'application/json',
      'user-agent': `ucp-check/${pkg.version} (+${pkg.homepage})`,
    },
    signal: AbortSignal.timeout(opts.timeout * 1000),
  };
  if (!opts.cached) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify({ domain: opts.domain });
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const why = err && err.name === 'TimeoutError' ? `timed out after ${opts.timeout}s` : (err && err.message) || String(err);
    throw apiError(`could not reach ${opts.baseUrl}: ${why}`);
  }

  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }

  if (res.status === 429) {
    const ra = res.headers.get('retry-after');
    throw apiError(`rate limited by ${opts.baseUrl}${ra ? ` — retry after ${ra}s` : ''}`);
  }
  if (res.status >= 500) throw apiError(`${opts.baseUrl} answered ${res.status}`);
  if (res.status === 400 || (body && body.error === 'invalid_domain')) throw usage((body && body.message) || 'invalid domain');

  return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
}

function render(opts, result) {
  const d = result.body && result.body.data;

  // GET /status on a domain the census has never seen.
  if (!d && result.status === 404) {
    return { exitCode: 1, lines: [`  ${opts.domain}  not in the census yet — run without --cached for a live check`] };
  }
  if (!d) throw apiError(`unexpected response from ${opts.baseUrl} (${result.status})`);

  const verified = d.status === 'verified';
  const lines = [];
  const head = `  ${d.domain}  ${label(d.status)}${d.ucp_version ? ` · UCP ${d.ucp_version}` : ''}`;
  lines.push(head);
  if (d.manifest_url) lines.push(`  manifest   ${d.manifest_url}`);
  if (d.observed_at) lines.push(`  observed   ${d.observed_at}${opts.cached ? ' (cached)' : d.observed === false ? ' (last observed state)' : ' (live)'}`);
  if (d.observed === false) {
    lines.push(`  note       the store's edge rate-limited this check; showing the last observed state${d.retry_after_s ? `, retry in ${d.retry_after_s}s` : ''}`);
  }
  lines.push(`  report     ${opts.baseUrl}/status/${d.domain}`);
  return { exitCode: verified ? 0 : 1, lines };
}

function label(status) {
  switch (status) {
    case 'verified': return 'verified';
    case 'not_detected': return 'not detected';
    case 'invalid': return 'invalid manifest';
    case 'blocked': return 'blocked';
    case 'unreachable': return 'unreachable';
    case 'pending': return 'pending';
    default: return status || 'unknown';
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`ucp-check: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) { process.stdout.write(USAGE); return 0; }
  if (opts.version) { process.stdout.write(`${pkg.version}\n`); return 0; }

  try {
    const result = await callApi(opts);
    const out = render(opts, result);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
    } else if (!opts.quiet) {
      process.stdout.write(`${out.lines.join('\n')}\n`);
    }
    return out.exitCode;
  } catch (err) {
    if (!opts.quiet) process.stderr.write(`ucp-check: ${err.message}\n`);
    return err.exitCode || 3;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { parseArgs, normalizeDomain, render };
