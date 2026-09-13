#!/usr/bin/env node
'use strict';
// `ucpchecker` is an alias for `ucp-check`; all behaviour lives there.
const { spawnSync } = require('node:child_process');
const bin = require.resolve('ucp-check/bin/ucp-check.js');
const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = r.status === null ? 3 : r.status;
