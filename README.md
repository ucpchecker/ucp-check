# ucp-check

Is this domain verified for the [Universal Commerce Protocol](https://ucp.dev)? One command, from your terminal or CI.

```
npx ucp-check example.com
```

```
  example.com  verified · UCP 2026-08-25
  manifest   https://example.com/.well-known/ucp
  observed   2026-09-13T10:00:00+00:00 (live)
  report     https://ucpchecker.com/status/example.com
```

`ucp-check` is a thin client over the [UCP Checker](https://ucpchecker.com) REST API. No account, no API key, no dependencies, Node 18+. It renders the verdict the API returns and turns it into an exit code. It never inspects the manifest itself and never scores anything locally, so what you see here is exactly what [ucpchecker.com/status/example.com](https://ucpchecker.com/status/example.com) shows.

## Usage

```
ucp-check <domain> [options]

  --cached            Read the last observed state instead of running a live check
  --json              Print the API response as JSON, exactly as served
  --quiet             No output; exit code only
  --base-url <url>    API origin (default https://ucpchecker.com, or UCP_CHECK_BASE_URL)
  --timeout <s>       Seconds to wait for the API (default 60)
```

A live check fetches the domain's `/.well-known/ucp` from the UCP Checker crawler, validates it against the current spec, and records the observation. `--cached` skips the crawl and returns the last observed state, which is what you want on every push when the manifest has not changed.

## Exit codes

Exit codes are the contract; everything else is display.

| Code | Meaning |
|---|---|
| `0` | verified |
| `1` | not verified: `not_detected`, `invalid`, `blocked`, `unreachable` or `pending` |
| `2` | usage error: bad flags, malformed domain |
| `3` | API unreachable, timed out, or rate limit exhausted |

## CI gate

```yaml
- name: UCP manifest verifies
  run: npx ucp-check your-store.com --quiet
```

The job fails when the live manifest does not verify. The API allows 30 live checks a minute and 200 a day per IP; cached reads are 60 a minute and 1,000 a day. A pipeline that checks on every push stays inside that by using `--cached` on pushes and a live check on deploy.

## Rate limits and the `observed` flag

A store's edge can rate-limit the crawler. When that happens the API still answers `200` with the last observed state and `observed: false`; the CLI says so and the exit code reflects that last state. Retry after the number of seconds it prints.

## What it does not do

It does not validate a manifest from disk, run a local server, or compute a score. Those live on the server so that a check from CI, from the website and from an agent's MCP call all say the same thing. For the score, methodology and the machine-readable versions of both, see the [API docs](https://ucpchecker.com/docs).

## Related

- [UCP Checker API & MCP docs](https://ucpchecker.com/docs): REST, MCP server, ARD discovery, skills
- [MCP server](https://ucpchecker.com/docs#mcp-server): `check-domain`, `list-stores`, `search-catalog` and more, for agents
- [ucpchecker/ucp-checker-skills](https://github.com/ucpchecker/ucp-checker-skills): agent skills

## License

MIT
