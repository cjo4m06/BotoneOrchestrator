#!/usr/bin/env bash
# 產生一個 throwaway 測試專案（獨立 git repo）供 orchestrator 端到端試跑。
# 預設放在 data/（已被 gitignore），不影響本 repo。可重複執行（會重建）。
set -euo pipefail
DIR="${1:-data/fixtures/sample-project}"
rm -rf "$DIR"
mkdir -p "$DIR"

cat > "$DIR/package.json" <<'JSON'
{
  "name": "sample-project",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "node -e \"console.log('build ok')\"",
    "test": "node --test",
    "lint": "node -e \"console.log('lint ok')\""
  }
}
JSON

cat > "$DIR/sum.js" <<'JS'
function sum(a, b) {
  return a + b;
}
module.exports = { sum };
JS

cat > "$DIR/sum.test.js" <<'JS'
const test = require('node:test');
const assert = require('node:assert');
const { sum } = require('./sum');

test('sum adds two numbers', () => {
  assert.equal(sum(1, 2), 3);
});
JS

git -C "$DIR" init -q -b main
git -C "$DIR" config user.email "fixture@local"
git -C "$DIR" config user.name "fixture"
git -C "$DIR" add -A
git -C "$DIR" commit -qm "init sample project"

echo "fixture ready at $DIR"
