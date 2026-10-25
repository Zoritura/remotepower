'use strict';
const fs = require('fs');
const path = require('path');
const target = path.join(__dirname, 'config.json');
try {
  const text = fs.readFileSync(target, 'utf8');
  const cfg = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('Expected a configuration object.');
  if (cfg.allowedHosts !== undefined && !Array.isArray(cfg.allowedHosts)) throw new Error('allowedHosts must be an array.');
  const hosts = cfg.allowedHosts || [];
  if (!hosts.some(host => String(host).toLowerCase() === 'remotepower.local')) hosts.push('remotepower.local');
  cfg.allowedHosts = hosts;
  fs.copyFileSync(target, target + '.bak');
  fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  console.log('Updated allowedHosts; existing password and settings preserved.');
} catch (error) {
  console.error('Configuration update failed:', error.message);
  process.exitCode = 1;
}
