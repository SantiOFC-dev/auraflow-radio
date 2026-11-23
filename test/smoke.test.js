const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('core files exist and pass syntax check', () => {
  for (const file of ['server.js', 'db.js', 'mailer.js']) {
    const p = path.join(root, file);
    assert.ok(fs.existsSync(p), `Missing ${file}`);
    execFileSync('node', ['--check', p]);
  }
});

test('live /health endpoint responds 200', async () => {
  const res = await fetch('http://127.0.0.1:3002/health');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
});
