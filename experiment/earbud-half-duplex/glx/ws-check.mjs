// Connects to a tenant through the glx entry the way the gateway does and reports what came back.
//   node ws-check.mjs <tenant> [hold_s]   marker read from /run/glx-marker (a 600 file, never printed)
// Prints event types and timings only, never payloads.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire('/app/package.json')
const WebSocket = require('ws')

const [tenant, holdArg = '0'] = process.argv.slice(2)
const holdMs = Number(holdArg) * 1000
const marker = readFileSync('/run/glx-marker', 'utf8').trim()
const url = `ws://10.0.2.151:80/t/${tenant}/api/realtime`
const t0 = performance.now()
const ms = () => Math.round(performance.now() - t0)
const seen = []

const ws = new WebSocket(url, { headers: { 'X-Qaa-Proxy': marker } })
ws.on('unexpected-response', (_req, res) => { console.log(JSON.stringify({ http: res.statusCode, ms: ms() })); process.exit(2) })
ws.on('open', () => {
  console.log(JSON.stringify({ open: ms() }))
  ws.send(JSON.stringify({
    type: 'connect', clientType: 'web', clientLabel: 'glx-ws-check', clientInstanceId: `probe:glx-${tenant}`,
    inputEnabled: false, outputEnabled: true, voiceEnabled: true, textOnly: false, locale: 'en-US', timeZone: 'UTC'
  }))
})
ws.on('message', (raw) => {
  let type = ''
  try { type = JSON.parse(String(raw)).type || '' } catch {}
  if (type && !seen.includes(type)) seen.push(type)
  if (type === 'voice.ready') {
    console.log(JSON.stringify({ voice_ready: ms() }))
    if (!holdMs) ws.close(1000)
    else setTimeout(() => ws.close(1000), holdMs)
  }
})
ws.on('close', (code) => { console.log(JSON.stringify({ close: code, ms: ms(), events: seen })); process.exit(0) })
ws.on('error', (err) => { console.log(JSON.stringify({ error: err.code || err.name, ms: ms() })); process.exit(1) })
setTimeout(() => { console.log(JSON.stringify({ timeout: ms(), events: seen })); process.exit(3) }, 30000 + holdMs)
