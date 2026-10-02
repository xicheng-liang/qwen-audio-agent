import assert from 'node:assert/strict'
import test from 'node:test'
import { createRealtimeSessionRuntime } from '../src/voice/realtime-session-runtime.mjs'
import { SessionObservers } from '../src/voice/session-observers.mjs'
import { InputAssetRegistry } from '../src/voice/input-asset-registry.mjs'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
import { createTaskAnnouncementRuntime } from '../src/voice/announcement/task-announcement-runtime.mjs'
import { TaskManager } from '../src/task/task-manager.mjs'
import { TaskOperations } from '../src/orchestration/task-operations.mjs'
import { clientActionCapabilities } from '../src/client/client-action-port.mjs'
import { GatewayClientEvent as Input } from '../../shared/protocol/realtime-events.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'runtime condition timed out')
    await sleep(5)
  }
}

// Real session runtime with a stand-in frontend: a frontend that reports its
// voice layer silent on a typed turn is given up and the turn asked again.
function harness(t) {
  const ownerId = 'owner', sessionId = 'conversation'
  const events = [], frontends = []
  const manager = new TaskManager()
  const provider = {
    key: 'test', label: 'Test', inputSampleRate: 16000, outputSampleRate: 24000,
    capabilities: { sessionOutputVoice: true }, classifyError: () => 'other',
  }
  const backendRuntime = { run: () => new Promise(() => {}), cancel: async () => ({ layer: 'backend', state: 'cancelled' }) }
  const operations = new TaskOperations({ taskManager: manager, backendRuntime })
  let active = false
  const runtime = createRealtimeSessionRuntime({
    ownerId, sessionId, logger: { info() {}, warn() {}, error() {}, debug() {} },
    taskManager: manager, taskOperations: operations, backendRuntime,
    backendAvailability: { snapshot: () => ({ configured: true, ok: true, known: true }) },
    send: event => events.push(event), onTaskEvent() {}, onResponseDone() {},
    observers: new SessionObservers([]),
    voiceAccess: {
      isActive: () => active,
      claim: () => { active = true; return { granted: true } },
      release: () => { active = false; return true },
      changed() {},
    },
    actionCapabilities: clientActionCapabilities(), frontendToolSources: [],
    memoryService: { list: () => [], subscribe: () => () => {} },
    inputAssets: new InputAssetRegistry(), conversationSync: new ConversationSync(),
    config: { sleepTimeoutMs: 0, announcementQuietMs: 0, announcementBatchMs: 0, taskNotificationClaimTtlMs: 60000 },
    realtimeProviderRegistry: { resolve: () => provider }, defaultRealtimeProvider: 'test',
    taskAnnouncementFactory: createTaskAnnouncementRuntime,
    realtimeFrontendFactory: options => {
      const f = {
        options, provider, capabilities: provider.capabilities, ready: false, asked: [], closed: false,
        lastActivityAt: -Infinity, isQuiescent: () => true,
        async connect() { this.ready = true }, close() { this.ready = false; this.closed = true },
        cancel() {}, cancelResponses() {}, clearPendingImage() {}, appendAudio() {}, appendImage() {},
        updateAgentContext() {}, async sendFunctionOutput() {},
        async sendUserInput(parts, context) { this.asked.push({ parts, context }); return {} },
        async appendUserInputContext() {}, async ensureResponse() {}, async whenIdle() {},
      }
      frontends.push(f)
      return f
    },
  })
  t.after(() => runtime.close())
  const connect = async () => {
    runtime.start()
    runtime.handleClientEvent({ type: Input.CONNECT, inputEnabled: false, outputEnabled: true, voiceEnabled: true }, {
      descriptor: { type: 'test', instanceId: 'instance' }, capabilities: [],
    })
    await until(() => runtime.status().state === 'connected')
  }
  return { runtime, events, frontends, connect }
}

test('a typed turn the voice layer never spoke is asked again on a fresh session, in the same turn', async t => {
  const { runtime, events, frontends, connect } = harness(t)
  await connect()
  runtime.handleClientEvent({ type: Input.TEXT_MESSAGE, text: '你好，你是谁？' })
  await until(() => frontends.at(-1).asked.length === 1)
  const silent = frontends.at(-1)
  const turnStarts = events.filter(event => event.type === 'turn.started').length

  silent.options.onStallRestartRequested()
  await until(() => frontends.length === 2 && frontends[1].asked.length === 1)
  assert.equal(silent.closed, true, 'the silent session is given up')
  assert.deepEqual(frontends[1].asked[0].parts, silent.asked[0].parts)
  assert.deepEqual(frontends[1].asked[0].context, silent.asked[0].context, 'the answer belongs to the same turn')
  assert.equal(events.filter(event => event.type === 'turn.started').length, turnStarts, 'no second turn reaches the client')

  frontends[1].options.onStallRestartRequested()
  await until(() => frontends[1].closed)
  await sleep(30)
  assert.equal(frontends.length, 2, 'asked again once: a second silence just parks')
})
