import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimeProviderSession } from '../src/voice/realtime-provider-session.mjs'
import { RealtimeConfigurationError } from '../src/voice/realtime-errors.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function harness({
  connectMode = 'manual',
  shouldReconnect = false,
  maxPendingAudioChunks = 2,
  sessionOptions = {},
  idleCloseMs,
  ...sessionOverrides
} = {}) {
  const calls = []
  const frontends = []
  const profiles = {
    dashscope: {
      key: 'dashscope',
      label: 'DashScope',
      inputSampleRate: 16000,
      outputSampleRate: 24000,
      classifyError: message => String(message).includes('invalid')
        ? 'fatal'
        : String(message).includes('busy') ? 'capacity_busy' : 'other',
      ...(idleCloseMs ? { idleCloseMs: () => idleCloseMs } : {}),
    },
    s2s: {
      key: 's2s',
      label: 'Speech-to-Speech',
      inputSampleRate: 16000,
      outputSampleRate: 24000,
      classifyError: () => 'other',
    },
  }
  const providerRegistry = {
    resolve(name) {
      const profile = profiles[name]
      if (!profile) throw new Error(`unknown provider: ${name}`)
      return profile
    },
  }
  const createFrontend = options => {
    const connection = deferred()
    const frontend = {
      options,
      provider: profiles[options.providerName],
      ready: false,
      lastActivityAt: -Infinity,
      quiescent: true,
      isQuiescent: () => frontend.quiescent,
      connect: () => {
        calls.push(['connect', options.providerName])
        if (connectMode === 'resolve') connection.resolve()
        if (connectMode === 'reject') connection.reject(new Error('connect failed'))
        return connection.promise.then(() => {
          frontend.ready = true
        })
      },
      appendAudio: audio => calls.push(['appendAudio', audio]),
      appendImage: image => calls.push(['appendImage', image]),
      clearPendingImage: () => calls.push(['clearPendingImage']),
      cancel: () => calls.push(['cancel']),
      close: () => calls.push(['close', options.providerName]),
      // 记下第二个参数：这一层曾经只转发 context，把 options 静默吞掉，
      // 而 stub 当时也只记录第一个参数，于是那个断点在测试里完全隐形。
      updateAgentContext: (context, options) => calls.push(['updateAgentContext', context, options]),
      triggerError: error => options.onError(error),
      triggerClose: () => {
        frontend.ready = false
        options.onClose()
      },
      resolveConnect: connection.resolve,
      rejectConnect: connection.reject,
    }
    frontends.push(frontend)
    return frontend
  }
  const runtime = new RealtimeProviderSession({
    providerRegistry,
    defaultProvider: 'dashscope',
    getAgentContext: () => ({ client: { locale: 'zh-CN' } }),
    getSessionOptions: () => (
      typeof sessionOptions === 'function' ? sessionOptions() : sessionOptions
    ),
    shouldReconnect: () => shouldReconnect,
    onEvent: event => calls.push(['event', event]),
    onDiagnostic: value => calls.push(['diagnostic', value]),
    onConnected: () => calls.push(['onConnected']),
    onReady: (_frontend, info) => calls.push(['onReady', info]),
    onDisconnected: () => calls.push(['onDisconnected']),
    onReconnected: () => calls.push(['onReconnected']),
    onConnectionState: state => calls.push(['state', state]),
    onError: error => calls.push(['error', error.message]),
    onReconnectError: error => calls.push(['reconnectError', error.message]),
    logger: {
      info: (...args) => calls.push(['log.info', ...args]),
      warn: (...args) => calls.push(['log.warn', ...args]),
      error: (...args) => calls.push(['log.error', ...args]),
    },
    maxPendingAudioChunks,
    stableConnectionMs: 10_000,
    createFrontend,
    reconnectBackoff: {
      next: () => 1,
      reset: () => calls.push(['backoff.reset']),
    },
    ...sessionOverrides,
  })
  return { runtime, calls, frontends }
}

test('passes session options into every provider connection attempt', async () => {
  const { runtime, frontends } = harness({
    connectMode: 'resolve',
    sessionOptions: { voice: 'longanlufeng' },
  })

  await runtime.ensure()

  assert.deepEqual(frontends[0].options.sessionOptions, {
    voice: 'longanlufeng',
  })
})

test('late events from a detached provider cannot affect its replacement', async () => {
  const { runtime, frontends, calls } = harness({ connectMode: 'resolve' })
  await runtime.ensure()
  const stale = frontends[0]
  runtime.detach()
  await runtime.ensure()
  stale.options.onEvent({ type: 'error', error: { message: 'stale rejection' } })
  frontends[1].options.onEvent({ type: 'response.created' })
  assert.deepEqual(calls.filter(([name]) => name === 'event'), [
    ['event', { type: 'response.created' }],
  ])
  runtime.close()
})

test('a rejected initial session configuration enters the shared content recovery path', async () => {
  const { runtime, frontends, calls } = harness()
  const pending = runtime.ensure()
  frontends[0].provider.classifyError = () => 'content_safety'
  const error = Object.assign(new Error('data_inspection_failed'), { realtimeEvent: true })
  frontends[0].triggerError(error)
  assert.deepEqual(calls.filter(([name]) => name === 'event'), [[
    'event', { type: 'error', error: { message: error.message }, __voiceOrigin: 'session' },
  ]])
  assert.equal(calls.some(([name]) => name === 'error'), false)
  frontends[0].rejectConnect(error)
  await assert.rejects(pending, /data_inspection_failed/)
  runtime.close()
})

test('reads fresh session options when an upstream provider Session is rebuilt', async () => {
  let outputVoice = 'longanqian'
  const { runtime, frontends } = harness({
    connectMode: 'resolve',
    sessionOptions: () => ({ voice: outputVoice }),
  })

  await runtime.ensure()
  runtime.detach({ clearAudio: false })
  outputVoice = 'longanlufeng'
  await runtime.ensure()

  assert.equal(frontends.length, 2)
  assert.equal(frontends[0].options.sessionOptions.voice, 'longanqian')
  assert.equal(frontends[1].options.sessionOptions.voice, 'longanlufeng')
})

test('shares one connection attempt and flushes bounded audio before ready', async () => {
  const { runtime, calls, frontends } = harness()

  runtime.appendAudio('oldest')
  runtime.appendAudio('middle')
  runtime.appendAudio('latest')
  const shared = runtime.ensure()
  assert.equal(shared, runtime.connectPromise)
  assert.equal(frontends.length, 1)

  frontends[0].resolveConnect()
  await shared

  assert.equal(runtime.ready, true)
  assert.deepEqual(
    calls.filter(([name]) => name === 'appendAudio'),
    [['appendAudio', 'middle'], ['appendAudio', 'latest']],
  )
  assert.ok(
    calls.findIndex(([name]) => name === 'onConnected')
      < calls.findIndex(([name]) => name === 'appendAudio'),
  )
  assert.ok(
    calls.findIndex(([name]) => name === 'appendAudio')
      < calls.findIndex(([name]) => name === 'onReady'),
  )
})

test('keeps only the latest visual frame while connecting', async () => {
  const { runtime, calls, frontends } = harness()

  runtime.appendImage('older-jpeg')
  runtime.appendImage('latest-jpeg')
  assert.equal(frontends.length, 1)

  frontends[0].resolveConnect()
  await runtime.connectPromise

  assert.deepEqual(
    calls.filter(([name]) => name === 'appendImage'),
    [['appendImage', 'latest-jpeg']],
  )
  assert.equal(runtime.pendingImage, null)
})

test('unexpected close reconnects once through the shared backoff', async () => {
  const { runtime, calls, frontends } = harness({
    connectMode: 'resolve',
    shouldReconnect: true,
  })
  await runtime.ensure()

  frontends[0].triggerClose()
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(frontends.length, 2)
  assert.equal(runtime.ready, true)
  assert.equal(
    calls.filter(([name]) => name === 'onReconnected').length,
    1,
  )
  assert.equal(
    calls.some(([, state]) => state?.state === 'unavailable'),
    true,
  )
})

test('fatal errors block later connection attempts and clear buffered audio', async () => {
  const { runtime, frontends } = harness({ connectMode: 'resolve' })
  await runtime.ensure()
  runtime.appendAudio('buffered-directly')
  runtime.appendImage('buffered-image')

  runtime.block('invalid api key')

  assert.equal(runtime.ready, false)
  assert.equal(runtime.pendingAudio.length, 0)
  assert.equal(runtime.pendingImage, null)
  await assert.rejects(runtime.ensure(), /invalid api key/)
  assert.deepEqual(runtime.status(), {
    provider: 'dashscope',
    state: 'unavailable',
    error: 'invalid api key',
  })
  assert.equal(frontends.length, 1)
})

test('switching providers detaches the old frontend without losing queued audio', async () => {
  const { runtime, calls, frontends } = harness()
  const connecting = runtime.ensure()
  runtime.pendingAudio.push('queued')
  runtime.pendingImage = 'stale-jpeg'

  assert.equal(runtime.switchProvider('s2s'), true)
  assert.equal(runtime.providerKey, 's2s')
  assert.deepEqual(runtime.pendingAudio, ['queued'])
  assert.equal(runtime.pendingImage, null)
  assert.equal(
    calls.filter(([name]) => name === 'clearPendingImage').length,
    1,
  )
  assert.equal(runtime.ready, false)

  frontends[0].resolveConnect()
  await connecting
  const replacement = runtime.ensure()
  frontends[1].resolveConnect()
  await replacement
  assert.equal(frontends[1].provider.key, 's2s')
})

test('configuration validation errors use the existing fatal path without reconnecting', async () => {
  const { runtime, calls, frontends } = harness({ shouldReconnect: true })
  const error = new RealtimeConfigurationError('音色 Cherry 不支持模型 omni；请改用该模型的默认音色 Ethan')
  const connecting = runtime.ensure()
  runtime.pendingAudio.push('queued')
  runtime.pendingImage = 'queued-image'
  frontends[0].rejectConnect(error)
  await assert.rejects(connecting, failure => failure === error)
  await assert.rejects(runtime.ensure(), /音色 Cherry/)
  assert.equal(frontends.length, 1)
  assert.deepEqual(runtime.pendingAudio, [])
  assert.equal(runtime.pendingImage, null)
  assert.equal(runtime.scheduledReconnect, null)
  assert.deepEqual(calls.find(([name, state]) => name === 'state' && state.state === 'unavailable'), [
    'state', { state: 'unavailable', provider: 'dashscope', message: error.message },
  ])
  runtime.detach()
})

test('capacity-busy connection failures stay silent and retryable', async () => {
  const { runtime, calls, frontends } = harness()
  const connection = runtime.ensure()
  frontends[0].rejectConnect(new Error('pipeline busy'))

  await assert.rejects(connection, /pipeline busy/)

  assert.equal(runtime.blockedError, '')
  assert.equal(
    calls.some(([, state]) => state?.state === 'unavailable'),
    false,
  )
})

test('explicit close can notify disconnection without a duplicate close callback', async () => {
  const { runtime, calls, frontends } = harness({ connectMode: 'resolve' })
  await runtime.ensure()

  runtime.close({ notifyDisconnected: true })
  frontends[0].triggerClose()

  assert.equal(runtime.ready, false)
  assert.equal(
    calls.filter(([name]) => name === 'onDisconnected').length,
    1,
  )
})

test('forwards agent context options down to the frontend', async () => {
  // 底层靠 { refreshSession: false } 决定要不要重发 session.update。这一层
  // 若只转发第一个参数，调用方的意图会被静默丢弃 —— 不报错，测试也照样绿，
  // 只是整场会话的前缀缓存白白失效。
  const { runtime, calls } = harness({ connectMode: 'resolve' })
  await runtime.ensure()

  runtime.updateAgentContext({ memories: [] }, { refreshSession: false })

  const [, context, options] = calls.find(([name]) => name === 'updateAgentContext')
  assert.deepEqual(context, { memories: [] })
  assert.deepEqual(options, { refreshSession: false }, 'options 必须原样到底层')
})

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate, timeoutMs = 2000) {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'condition timed out')
    await wait(5)
  }
}

const connectionStates = calls => calls.filter(([name]) => name === 'state').map(([, state]) => state.state)

async function parkedHarness(options = {}) {
  const h = harness({ idleCloseMs: 20, idleCloseBlocker: () => '', ...options })
  const first = h.runtime.ensure()
  h.frontends[0].resolveConnect()
  await first
  await until(() => h.runtime.parked)
  return h
}

test('an idle session parks: the provider closes with no connection state, disconnect or reconnect', async () => {
  const { runtime, calls, frontends } = await parkedHarness({ shouldReconnect: true })
  assert.deepEqual(calls.filter(([name]) => name === 'close'), [['close', 'dashscope']])
  assert.equal(runtime.ready, false)
  assert.equal(runtime.frontend, null)
  assert.deepEqual(connectionStates(calls), ['connecting', 'connected'])
  assert.equal(calls.some(([name]) => name === 'onDisconnected'), false)
  assert.equal(runtime.scheduledReconnect, null)
  assert.ok(calls.some(([name, event]) => name === 'log.info' && event === 'realtime.parked'))

  frontends[0].triggerClose()
  frontends[0].triggerError(new Error('late failure'))
  await wait(30)
  assert.equal(frontends.length, 1, 'a late close from the parked socket does not reconnect')
  assert.deepEqual(connectionStates(calls), ['connecting', 'connected'])
  assert.equal(calls.some(([name]) => name === 'onDisconnected' || name === 'error'), false)
  assert.equal(runtime.parked, true)
  runtime.close()
  assert.equal(runtime.parked, false, 'an explicit close ends the park')
})

test('an idle session stays open while anything holds it, and says why', async () => {
  const reasons = calls => calls
    .filter(([name, event]) => name === 'log.info' && event === 'realtime.idle_close_blocked')
    .map(([, , fields]) => fields.reason)
  const cases = [
    { name: 'recent activity', options: { now: () => 0 }, hold: frontend => { frontend.lastActivityAt = 0 }, reason: null },
    { name: 'busy frontend', hold: frontend => { frontend.quiescent = false }, reason: 'frontend_busy' },
    { name: 'runtime blocker', options: { idleCloseBlocker: () => 'active_task' }, reason: 'active_task' },
    { name: 'throwing blocker', options: { idleCloseBlocker: () => { throw new Error('boom') } }, reason: 'blocker_threw' },
    { name: 'pending connect', hold: (_frontend, runtime) => { runtime.connectPromise = new Promise(() => {}) }, reason: null },
    {
      name: 'scheduled reconnect',
      hold: (_frontend, runtime) => { runtime.scheduledReconnect = { promise: Promise.resolve(), resolve() {}, timer: null } },
      reason: null,
    },
  ]
  for (const { name, options = {}, hold = () => {}, reason } of cases) {
    const { runtime, calls, frontends } = harness({
      connectMode: 'resolve', idleCloseMs: 20, idleCloseBlocker: () => '', ...options,
    })
    await runtime.ensure()
    hold(frontends[0], runtime)
    await wait(100)
    assert.equal(runtime.parked, false, name)
    assert.equal(calls.some(([call]) => call === 'close'), false, name)
    assert.deepEqual(reasons(calls), reason ? [reason] : [], name)
    runtime.close()
  }
})

test('a blocked idle close logs its reason once and parks once the session goes quiet', async () => {
  let clock = 0
  let blocker = 'active_task'
  const { runtime, calls, frontends } = harness({
    connectMode: 'resolve', idleCloseMs: 20, idleCloseBlocker: () => blocker, now: () => clock,
  })
  await runtime.ensure()
  frontends[0].lastActivityAt = 0
  await wait(60)
  assert.equal(runtime.parked, false, 'quiet for less than the idle time')
  clock = 100
  await wait(1100)
  assert.equal(runtime.parked, false)
  assert.equal(calls.filter(([name, event]) => name === 'log.info' && event === 'realtime.idle_close_blocked').length, 1)
  blocker = ''
  await until(() => runtime.parked)
  runtime.close()
})

test('a request after a park reopens the provider without connection state and reports the wake', async () => {
  const { runtime, calls, frontends } = await parkedHarness()
  const waking = runtime.ensure()
  assert.equal(runtime.ensure(), waking, 'concurrent wakes share one attempt')
  assert.equal(runtime.parked, true, 'parked until the new session is ready')
  frontends[1].resolveConnect()
  await waking
  assert.equal(frontends.length, 2)
  assert.equal(runtime.ready, true)
  assert.equal(runtime.parked, false)
  assert.deepEqual(connectionStates(calls), ['connecting', 'connected'])
  assert.deepEqual(
    calls.filter(([name]) => name === 'onReady').map(([, info]) => info),
    [{ resumedFromPark: false }, { resumedFromPark: true }],
  )
  assert.equal(calls.filter(([name]) => name === 'onConnected').length, 2, 'ready hooks run again')
  assert.ok(calls.some(([name, event, fields]) => (
    name === 'log.info' && event === 'realtime.connected' && fields.resumedFromPark === true
  )))
  await until(() => runtime.parked)
  assert.equal(frontends.length, 2, 'a woken session parks again when idle')
  runtime.close()
})

test('a failed wake costs the request, not the link: no unavailable, no reconnect, still parked', async () => {
  for (const order of ['reject then close', 'close then reject']) {
    const { runtime, calls, frontends } = await parkedHarness({ shouldReconnect: true })
    const waking = runtime.ensure()
    const failure = new Error('connect failed')
    if (order === 'close then reject') frontends[1].triggerClose()
    frontends[1].rejectConnect(failure)
    await assert.rejects(waking, error => error === failure, order)
    if (order === 'reject then close') frontends[1].triggerClose()
    await wait(20)
    assert.deepEqual(connectionStates(calls), ['connecting', 'connected'], order)
    assert.equal(runtime.parked, true, order)
    assert.equal(runtime.scheduledReconnect, null, order)
    assert.equal(frontends.length, 2, order)
    assert.equal(calls.some(([name]) => name === 'onDisconnected' || name === 'error'), false, order)
    assert.ok(calls.some(([name, event]) => name === 'log.warn' && event === 'realtime.unpark_failed'), order)
    const retry = runtime.ensure()
    frontends[2].resolveConnect()
    await retry
    assert.equal(runtime.ready, true, order)
    runtime.close()
  }
})

test('provider errors during a wake are left to the waking request; a fatal one ends the park as unavailable', async () => {
  const { runtime, calls, frontends } = await parkedHarness()
  const waking = runtime.ensure()
  const failure = new Error('socket hang up')
  frontends[1].triggerError(failure)
  frontends[1].rejectConnect(failure)
  await assert.rejects(waking, error => error === failure)
  assert.equal(calls.some(([name]) => name === 'error'), false, 'the session does not report it')
  assert.equal(failure.realtimeConnectionReported, undefined)

  const blocked = runtime.ensure()
  const fatal = new Error('invalid api key')
  frontends[2].triggerError(fatal)
  frontends[2].rejectConnect(fatal)
  await assert.rejects(blocked, error => error === fatal)
  assert.equal(runtime.parked, false, 'a fatal wake leaves the park')
  assert.equal(fatal.realtimeConnectionReported, true, 'the unavailable state reports it, as without a park')
  assert.equal(runtime.blockedError, 'invalid api key')
  await assert.rejects(runtime.ensure(), /invalid api key/)
  assert.deepEqual(connectionStates(calls), ['connecting', 'connected', 'unavailable'])
  assert.deepEqual(calls.filter(([name]) => name === 'state').at(-1), [
    'state', { state: 'unavailable', provider: 'dashscope', message: 'invalid api key' },
  ])
  assert.equal(calls.some(([name]) => name === 'error'), false)
  runtime.close()
})

test('a fatal wake failure takes the path of a fatal connect without a park', async () => {
  const trace = calls => calls.filter(([name]) => ['state', 'onDisconnected', 'error'].includes(name))
  const plain = harness({ shouldReconnect: true })
  const connecting = plain.runtime.ensure()
  plain.frontends[0].rejectConnect(new Error('invalid api key'))
  await assert.rejects(connecting, /invalid api key/)
  plain.frontends[0].triggerClose()
  const [first, ...expected] = trace(plain.calls)
  assert.deepEqual(first, ['state', { state: 'connecting', provider: 'dashscope' }])
  assert.ok(expected.length > 0)
  plain.runtime.close()

  const { runtime, calls, frontends } = await parkedHarness({ shouldReconnect: true })
  const mark = calls.length
  const waking = runtime.ensure()
  frontends[1].rejectConnect(new Error('invalid api key'))
  await assert.rejects(waking, /invalid api key/)
  frontends[1].triggerClose()
  await wait(20)
  assert.deepEqual(trace(calls.slice(mark)), expected, 'the same unavailable, disconnect and block')
  assert.equal(runtime.parked, false)
  assert.equal(runtime.scheduledReconnect, null)
  assert.equal(frontends.length, 2)
  runtime.close()
})

test('an idle close longer than the timer range is not cut short', async () => {
  const { runtime } = harness({ connectMode: 'resolve', idleCloseMs: 3_000_000_000, idleCloseBlocker: () => '' })
  await runtime.ensure()
  await wait(50)
  assert.equal(runtime.parked, false)
  runtime.close()
})

test('providers without idleCloseMs, or sessions without a blocker, never close on idle', async () => {
  const plain = harness({ connectMode: 'resolve', idleCloseBlocker: () => '' })
  await plain.runtime.ensure()
  assert.equal(plain.runtime.idleTimer, null, 'no idle timer is armed')
  const unwired = harness({ connectMode: 'resolve', idleCloseMs: 20 })
  await unwired.runtime.ensure()
  await wait(80)
  for (const { runtime, calls } of [plain, unwired]) {
    assert.equal(runtime.parked, false)
    assert.equal(runtime.ready, true)
    assert.equal(calls.some(([name]) => name === 'close'), false)
    runtime.close()
  }
})
