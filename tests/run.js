#!/usr/bin/env node
// 執行所有測試（npm test）。逐一列出檔案再交給 node --test，Node 18～最新版、Windows / macOS / Linux 都一樣。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(__dirname, f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
