import fs from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

test('restored normal tabs explicitly use the persistent browser partition', () => {
  assert.match(
    source,
    /createTab\(st\.url,\s*\{[^}]*partition:\s*PERSISTENT_PARTITION[^}]*\}\)/s
  )
})

test('persisted tabs save the current navigated URL rather than the original URL', () => {
  assert.match(
    source,
    /url:\s*currentUrlMap\.get\(t\.id\)\s*\|\|\s*t\.url/
  )
})

test('incognito tabs are excluded from restored session state', () => {
  assert.match(
    source,
    /tabs\.filter\(function \(t\) \{ return t\._partition !== INCOGNITO_PARTITION \}\)/
  )
})

test('normal and incognito partitions are named constants', () => {
  assert.match(source, /const PERSISTENT_PARTITION = 'persist:hermes-dev-browser'/)
  assert.match(source, /const INCOGNITO_PARTITION = 'hermes-dev-browser-incognito'/)
})
