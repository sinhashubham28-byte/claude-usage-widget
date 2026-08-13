#!/usr/bin/env node
// electron-builder on Windows intermittently fails extracting the cached
// Electron zip with:
//   EPERM: operation not permitted, rename '...win-unpacked.tmp' -> '...win-unpacked'
// Almost certainly Defender's real-time scan briefly locking the
// freshly-extracted .exe/.dll files at the exact moment electron-builder
// renames the temp extraction folder into place. The lock clears within a
// few seconds (a manual retry of the same rename right after a failure has
// always succeeded during development), so retrying the whole build is a
// reliable, if inelegant, workaround. No fix exists upstream to wait on;
// this is the practical alternative to excluding the project folder from
// Defender, which needs admin rights we don't assume here.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_ATTEMPTS = 6;
const RETRY_DELAY_MS = 3000;
const DIST_DIR = path.join(__dirname, '..', 'dist');
const EPERM_MARKER = /EPERM.*rename.*win-unpacked/i;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cleanDist() {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  console.log(`[build-with-retry] attempt ${attempt}/${MAX_ATTEMPTS}`);
  cleanDist();

  const result = spawnSync('npx', ['electron-builder'], {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: true,
    encoding: 'utf8',
  });

  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');

  if (result.status === 0) {
    console.log('[build-with-retry] succeeded');
    process.exit(0);
  }

  const combined = `${result.stdout || ''}${result.stderr || ''}`;
  if (!EPERM_MARKER.test(combined)) {
    console.error('[build-with-retry] failed with a non-retryable error, stopping');
    process.exit(result.status || 1);
  }

  if (attempt < MAX_ATTEMPTS) {
    console.log(`[build-with-retry] known transient EPERM, retrying in ${RETRY_DELAY_MS}ms...`);
    sleep(RETRY_DELAY_MS);
  }
}

console.error(`[build-with-retry] gave up after ${MAX_ATTEMPTS} attempts`);
process.exit(1);
