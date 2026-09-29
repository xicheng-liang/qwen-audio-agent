import assert from 'node:assert/strict'
import test from 'node:test'
import { createRealtimeSessionRuntime } from '../src/voice/realtime-session-runtime.mjs'
import { SessionObservers } from '../src/voice/session-observers.mjs'
import { InputAssetRegistry } from '../src/voice/input-asset-registry.mjs'
import { createTaskAnnouncementRuntime } from '../src/voice/announcement/task-announcement-runtime.mjs'
import { ConversationSync } from '../src/conversation/conversation-sync.mjs'
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

// Real session runtime, AnnouncementManager and presentation runtime. The
// frontend emits what RealtimeFrontend emits for a concurrent voice layer: the
// backend response takes the Gateway request, the voice segment is unsolicited.
// The client stands in for the earbud gateway with no turn open: every
// response.started (or unannounced audio) gets a playback.started receipt.
function harness(t, { concurrentVoicePlayback = true, voiceAfterBackendDone = false } = {}) {
  const ownerId = 'owner', sessionId = 'conversation'
  const events = [], frontends = [], runs = new Map()
  const manager = new TaskManager()
  const provider = {
    key: 'test', label: 'Test', inputSampleRate: 16000, outputSampleRate: 24000,
    capabilities: { sessionOutputVoice: true, concurrentVoicePlayback },
    classifyError: () => 'other',
  }
  const backendRuntime = {
    run: (_input, execution) => new Promise(resolve => runs.set(execution.taskId, { ...execution, resolve })),
    cancel: async () => ({ layer: 'backend', state: 'cancelled' }),
  }
  const operations = new TaskOperations({ taskManager: manager, backendRuntime })
  let active = false
  let runtime
  const receipted = new Set()
  const receipt = responseId => {
    if (!responseId || receipted.has(responseId)) return
    receipted.add(responseId)
    setImmediate(() => runtime.handleClientEvent({ type: Input.PLAYBACK_STARTED, responseId }))
  }
  const send = event => {
    events.push(event)
    if (event.type === 'response.started' || event.type === 'audio.delta') receipt(event.responseId)
    if (event.type === 'audio.done' && receipted.has(event.responseId)) {
      setImmediate(() => runtime.handleClientEvent({ type: Input.PLAYBACK_ENDED, responseId: event.responseId }))
    }
  }
  let sequence = 0
  runtime = createRealtimeSessionRuntime({
    ownerId, sessionId, logger: { info() {}, warn() {}, error() {}, debug() {} },
    taskManager: manager, taskOperations: operations, backendRuntime,
    backendAvailability: { snapshot: () => ({ configured: true, ok: true, known: true }) },
    send, onTaskEvent() {}, onResponseDone() {},
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
    taskAnnouncementFactory: options => createTaskAnnouncementRuntime({
      ...options,
      resultOptions: { ...options.resultOptions, retryBaseMs: 20, retryMaxMs: 40 },
    }),
    realtimeFrontendFactory: options => {
      const emit = options.onEvent
      const speak = async voice => {
        f.playbackResponses.add(voice)
        emit({ type: 'response.created', response: { id: voice }, __voicePlayback: true, __unsolicited: true, __voiceOrigin: 'model', __voiceContext: {} })
        emit({ type: 'response.output_audio.delta', response_id: voice, delta: 'AAAA' })
        await sleep(5)
        emit({ type: 'response.output_audio_transcript.done', response_id: voice, transcript: 'Your tests: 39 of 42 passed.' })
        f.playbackResponses.delete(voice)
        emit({ type: 'response.done', response: { id: voice, status: 'completed' }, __voicePlayback: true, __voiceOrigin: 'model', __voiceContext: {} })
      }
      const f = {
        provider, capabilities: provider.capabilities, ready: false, deliveries: [], playbackResponses: new Set(),
        lastActivityAt: -Infinity, isQuiescent: () => true,
        async connect() { this.ready = true }, close() { this.ready = false },
        cancel() {}, cancelResponses() {}, clearPendingImage() {}, appendAudio() {}, appendImage() {},
        updateAgentContext() {}, async sendUserInput() { return {} }, async sendFunctionOutput() {},
        async injectDelivery(_text, origin, context) {
          this.deliveries.push({ origin, context })
          const backend = `resp_${++sequence}`, voice = `voice_${sequence}`
          const tagged = { __voiceOrigin: origin, __voiceContext: { ...context } }
          emit({ type: 'response.created', response: { id: backend }, ...tagged })
          await sleep(5)
          let speaking = null
          if (!voiceAfterBackendDone) speaking = speak(voice)
          await sleep(5)
          emit({ type: 'response.done', response: { id: backend, status: 'completed' }, ...tagged })
          if (voiceAfterBackendDone) setTimeout(() => speak(voice), 30)
          await speaking
          return { completed: true, contextInjected: true }
        },
        async appendUserInputContext() {}, async ensureResponse() {}, async whenIdle() {},
      }
      frontends.push(f)
      return f
    },
  })
  t.after(async () => {
    runtime.close()
    await Promise.all(manager.list({ active: true }).map(task => operations.cancel(task.id, { ownerId })))
  })
  const connect = async () => {
    runtime.start()
    runtime.handleClientEvent({ type: Input.CONNECT, inputEnabled: false, outputEnabled: true, voiceEnabled: true }, {
      descriptor: { type: 'test', instanceId: 'instance' }, capabilities: [],
    })
    await until(() => runtime.status().state === 'connected')
    return frontends.at(-1)
  }
  const request = objective => operations.submit({ objective }, { ownerId, sessionId })
  const started = () => events.filter(event => event.type === 'response.started')
  return { connect, request, runs, manager, events, started }
}

async function completeTask(h) {
  const f = await h.connect()
  const task = h.request('check tests')
  await until(() => h.runs.has(task.id))
  h.runs.get(task.id).resolve({ status: 'completed', result: '39 of 42 passed' })
  await until(() => f.deliveries.length > 0)
  // Long enough for every retry of an unconfirmed result (20-40 ms backoff, 8 attempts).
  await sleep(600)
  return { f, task }
}

for (const voiceAfterBackendDone of [false, true]) {
  const when = voiceAfterBackendDone ? 'after the backend step finished' : 'while the backend step runs'
  test(`a task result the voice layer speaks ${when} is delivered once and confirmed`, async t => {
    const h = harness(t, { voiceAfterBackendDone })
    const { f, task } = await completeTask(h)
    assert.equal(f.deliveries.length, 1)
    assert.deepEqual(h.started().map(event => [event.responseId, event.origin, event.taskIds]),
      [['voice_1', 'announcement', [task.id]]])
    assert.equal(h.manager.get(task.id).notificationStatus, 'delivered')
  })
}

test('a permission prompt spoken by the voice layer keeps its permission origin', async t => {
  const h = harness(t)
  const f = await h.connect()
  const task = h.request('read file')
  await until(() => h.runs.has(task.id))
  h.runs.get(task.id).onEvent({ type: 'backend.permission.requested', permission: {
    id: 'auth_1', status: 'pending', summary: 'read a file',
  } })
  await until(() => f.deliveries.some(delivery => delivery.origin === 'permission'))
  await until(() => h.started().length > 0)
  const [voice] = h.started()
  assert.equal(voice.responseId, 'voice_1')
  assert.equal(voice.origin, 'permission')
  assert.equal(voice.taskId, task.id)
})

test('without a concurrent voice layer the task result is confirmed by its own response', async t => {
  const h = harness(t, { concurrentVoicePlayback: false })
  const { f, task } = await completeTask(h)
  assert.equal(f.deliveries.length, 1)
  assert.deepEqual(h.started()[0].origin, 'announcement')
  assert.equal(h.started()[0].responseId, 'resp_1')
  assert.equal(h.manager.get(task.id).notificationStatus, 'delivered')
})
