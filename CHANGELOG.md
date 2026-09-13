# Changelog

## 0.1.0 — 2026-09-13

First release. `ucp-check <domain>` runs a live check through the UCP Checker API and
turns the verdict into an exit code (`0` verified · `1` not verified · `2` usage ·
`3` API unreachable or rate limited). `--cached` reads the last observed state,
`--json` prints the response as served, `--quiet` is exit-code only.
