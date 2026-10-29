import assert from 'node:assert/strict'
import test from 'node:test'
import { RealtimePresentationRuntime } from '../src/voice/realtime-presentation-runtime.mjs'
import { RealtimeTurnState } from '../src/voice/realtime-turn-state.mjs'

function harness({
  nonVoiceClient = false,
  turnCitations = null,
  terminalToolResponses = [],
  resultSummaryResponses = [],
  perResponseInstructions = false,
  concurrentVoicePlayback = false,
  playbackResponses,
  backendResultOwedMs,
} = {}) {
  const events = []
  const records = []
  const calls = []
  const turns = new RealtimeTurnState({
    createVoiceTurnId: generation => `voice-${generation}`,
  })
  let responseTurnCandidate = null
  const frontend = {
    ready: true,
    provider: { outputSampleRate: 24000 },
    capabilities: { perResponseInstructions, concurrentVoicePlayback },
    ensureResponse: async (...args) => calls.push(['ensureResponse', ...args]),
    ...(playbackResponses ? { playbackResponses } : {}),
  }
  const terminalResponses = new Set(terminalToolResponses)
  const runtime = new RealtimePresentationRuntime({
    ownerId: 'owner-1',
    sessionId: 'session-1',
    turns,
    conversationSync: { record: value => records.push(value) },
    announcementWindow: {
      queueAudio: (...args) => calls.push(['queueAudio', ...args]),
      startPlayback: (...args) => calls.push(['startPlayback', ...args]),
      finishPlayback: (...args) => calls.push(['finishPlayback', ...args]),
      responseDone: (...args) => calls.push(['responseDone', ...args]),
    },
    announcements: {
      confirmMany: ids => calls.push(['confirmMany', ids]),
      retryMany: ids => calls.push(['retryMany', ids]),
      flush: () => calls.push(['flush']),
    },
    toolCalls: {
      requiresToolResultSummary: id => resultSummaryResponses.includes(id),
      consumeTerminalToolResponse: id => {
        calls.push(['consumeTerminalToolResponse', id])
        return terminalResponses.delete(id)
      },
      finishToolResponse: async (...args) => calls.push([
        'finishToolResponse',
        ...args,
      ]),
    },
    send: event => events.push(event),
    getFrontend: () => frontend,
    getOutputEnabled: () => true,
    getNonVoiceClient: () => nonVoiceClient,
    getResponseTurnCandidate: () => responseTurnCandidate,
    clearResponseCandidate: () => {
      responseTurnCandidate = null
      calls.push(['clearResponseCandidate'])
    },
    announcementQuietMs: 60_000,
    responseContextCleanupMs: 60_000,
    turnCitations,
    ...(backendResultOwedMs ? { backendResultOwedMs } : {}),
  })
  return {
    runtime,
    turns,
    events,
    records,
    calls,
    setResponseTurnCandidate(value) {
      responseTurnCandidate = value
    },
  }
}

test('projects turn citations once on the final assistant transcript', () => {
  const stored = [{
    id: 'source_1',
    title: '杭州天气',
    url: 'https://example.com/weather',
  }]
  let consumed = false
  const setup = harness({
    turnCitations: {
      consume(turnId) {
        assert.equal(turnId, 'turn-1')
        if (consumed) return []
        consumed = true
        return stored
      },
    },
  })

  deliver(setup.runtime, {
    type: 'response.text.done',
    response_id: 'response-1',
    text: '今天晴。',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })

  const final = setup.events.find(event => event.type === 'transcript.final')
  assert.deepEqual(final.citations, stored)
  assert.deepEqual(setup.records[0].citations, stored)
})

test('does not persist a model-generated Gateway protocol envelope', () => {
  const setup = harness()
  const content = [
    '<permission_request>',
    'task_id=fake',
    '</permission_request>',
  ].join(' ')

  deliver(setup.runtime, {
    type: 'response.text.done',
    response_id: 'response-fake-protocol',
    text: content,
    __voiceContext: {
      origin: 'model',
      turnId: 'turn-1',
      turnGeneration: 1,
    },
  })

  assert.equal(setup.records.length, 0)
  assert.equal(
    setup.events.some(event => (
      event.type === 'transcript.final' && event.content === content
    )),
    true,
  )
})

test('allows only one protocol correction per user turn, including repeated invalid corrections', () => {
  const setup = harness({ perResponseInstructions: true })
  const invalidResponse = id => {
    const context = setup.turns.committed()
    deliver(setup.runtime, {
      type: 'response.text.done', response_id: id,
      text: '<permission_request>fake</permission_request>', __voiceContext: context,
    })
    deliver(setup.runtime, { type: 'response.done', response: { id, status: 'completed' } })
  }
  const first = setup.turns.beginVoice('input-1').context
  setup.turns.endSpeech()
  setup.turns.commit(first)
  invalidResponse('response-1')
  invalidResponse('response-2')
  invalidResponse('response-3')
  const corrections = () => setup.calls.filter(([name]) => name === 'ensureResponse')
  assert.equal(corrections().length, 1)
  assert.equal(corrections()[0][2].shouldCreate(), true)
  const second = setup.turns.beginVoice('input-2').context
  setup.turns.endSpeech()
  setup.turns.commit(second)
  assert.equal(corrections()[0][2].shouldCreate(), false)
  invalidResponse('response-4')
  assert.equal(corrections().length, 2)
})

function deliver(runtime, event) {
  runtime.begin(event)
  runtime.handle(event)
}

test('correlates an implicit provider response with the pending voice turn', () => {
  const setup = harness()
  const candidate = setup.turns.beginVoice('item-1').context
  setup.turns.endSpeech()
  setup.setResponseTurnCandidate(candidate)

  deliver(setup.runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
  })

  assert.deepEqual(setup.turns.committed(), candidate)
  assert.equal(setup.events[0].type, 'response.started')
  assert.equal(setup.events[1].type, 'audio.delta')
  assert.equal(setup.events[1].sampleRate, 24000)
  assert.equal(
    setup.calls.some(([name]) => name === 'clearResponseCandidate'),
    true,
  )
})

test('ties a reply that starts before the end of speech to the turn under way', () => {
  // GPT-Live starts a delegated reply a moment before it reports speech_stopped:
  // that reply answers the new turn, not the last committed one, or its tool
  // calls are counted against an old turn's budget.
  const setup = harness({ concurrentVoicePlayback: true })
  const first = setup.turns.beginVoice('input-1').context
  setup.turns.endSpeech()
  setup.turns.completeInput('input-1')
  setup.turns.commit(first)
  const second = setup.turns.beginVoice('input-2').context

  deliver(setup.runtime, { type: 'response.created', response: { id: 'resp-2' } })

  assert.equal(setup.runtime.get('resp-2').turnId, second.turnId)
  assert.equal(setup.runtime.get('resp-2').turnGeneration, second.turnGeneration)
})

test('without concurrent playback a reply during new speech stays on the committed turn', () => {
  // A provider that cancels an old reply when the user barges in: the old
  // reply must not become the answer to the new turn.
  const setup = harness()
  const first = setup.turns.beginVoice('input-1').context
  setup.turns.endSpeech()
  setup.turns.completeInput('input-1')
  setup.turns.commit(first)
  setup.turns.beginVoice('input-2')

  deliver(setup.runtime, { type: 'response.created', response: { id: 'resp-1' } })

  assert.equal(setup.runtime.get('resp-1').turnId, first.turnId)
})

test('a reply after speech that ended without a transcript stays on the committed turn', () => {
  // Speech that stopped (or was cut off by a dropped connection) and never
  // committed does not own later replies.
  const setup = harness({ concurrentVoicePlayback: true })
  const first = setup.turns.beginVoice('input-1').context
  setup.turns.endSpeech()
  setup.turns.completeInput('input-1')
  setup.turns.commit(first)
  setup.turns.beginVoice('input-2')
  setup.turns.endSpeech()

  deliver(setup.runtime, { type: 'response.created', response: { id: 'resp-2' } })

  assert.equal(setup.runtime.get('resp-2').turnId, first.turnId)
})

test('a reply after a turn that was only noise stays on the committed turn', () => {
  const setup = harness({ concurrentVoicePlayback: true })
  const first = setup.turns.beginVoice('input-1').context
  setup.turns.endSpeech()
  setup.turns.completeInput('input-1')
  setup.turns.commit(first)
  setup.turns.beginVoice('input-2')
  setup.turns.endSpeech()
  setup.turns.completeInput('input-2') // its transcript failed or was empty

  deliver(setup.runtime, { type: 'response.created', response: { id: 'resp-2' } })

  assert.equal(setup.runtime.get('resp-2').turnId, first.turnId)
})

test('holds audio transcripts until playback starts and records them once', () => {
  const { runtime, events, records, calls } = harness()
  const context = {
    turnId: 'turn-1',
    turnGeneration: 1,
    taskIds: ['work-1'],
    consumesTaskNotification: true,
  }

  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceContext: context,
  })
  deliver(runtime, {
    type: 'response.audio_transcript.delta',
    response_id: 'response-1',
    delta: '后台任务',
  })
  deliver(runtime, {
    type: 'response.audio_transcript.done',
    response_id: 'response-1',
    transcript: '后台任务完成了',
  })
  assert.equal(events.some(event => event.type === 'transcript.final'), false)

  runtime.startPlayback('response-1')

  assert.deepEqual(
    events.filter(event => event.type.startsWith('transcript.')).map(event => ({
      type: event.type,
      content: event.content,
    })),
    [
      { type: 'transcript.delta', content: '后台任务' },
      { type: 'transcript.final', content: '后台任务完成了' },
    ],
  )
  assert.equal(records.length, 1)
  assert.equal(records[0].source, 'realtime-direct')
  assert.equal(
    calls.filter(([name]) => name === 'confirmMany').length,
    1,
  )
})

test('retires an audio response only after response, transcript and playback end', () => {
  const { runtime } = harness()

  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.startPlayback('response-1')
  deliver(runtime, {
    type: 'response.audio_transcript.done',
    response_id: 'response-1',
    transcript: '完成',
  })
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })
  assert.equal(runtime.has('response-1'), true)

  runtime.finishPlayback('response-1')

  assert.equal(runtime.has('response-1'), false)
})

test('keeps processing while a foreground tool result is pending', () => {
  const { runtime, events } = harness()

  deliver(runtime, {
    type: 'response.created',
    response: { id: 'response-1' },
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.markFunctionCall('response-1')
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })

  assert.deepEqual(
    events.filter(event => event.type === 'voice.state').map(event => event.state),
    ['processing'],
  )
})

test('returns to idle after a terminal tool response', () => {
  const { runtime, events } = harness({
    terminalToolResponses: ['response-1'],
  })

  deliver(runtime, {
    type: 'response.created',
    response: { id: 'response-1' },
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.markFunctionCall('response-1')
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })

  assert.deepEqual(
    events.filter(event => event.type === 'voice.state').map(event => event.state),
    ['processing', 'idle'],
  )
})

test('releases a spoken function-call turn when its tool follow-up is suppressed', () => {
  const { runtime, events, calls } = harness()

  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.markFunctionCall('response-1')
  runtime.startPlayback('response-1')
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })
  runtime.finishPlayback('response-1')

  assert.equal(events.at(-1).type, 'voice.state')
  assert.equal(events.at(-1).state, 'idle')
  assert.deepEqual(
    calls.find(([name]) => name === 'finishToolResponse'),
    ['finishToolResponse', 'response-1', {
      suppressResponse: false,
      sourceHasSpeech: true,
    }],
  )
  assert.deepEqual(
    calls.find(([name]) => name === 'responseDone'),
    ['responseDone', {
      turnId: 'turn-1',
      origin: 'model',
      hasAudio: true,
      awaitsToolFollowUp: false,
      suppressed: false,
      failed: false,
    }],
  )
})

test('keeps a spoken inline-tool turn open until its results can be summarized', () => {
  const { runtime, calls } = harness({ resultSummaryResponses: ['response-1'] })
  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
  })
  runtime.markFunctionCall('response-1')
  deliver(runtime, {
    type: 'response.done',
    response: { id: 'response-1', status: 'completed' },
  })

  assert.deepEqual(calls.find(([name]) => name === 'finishToolResponse'), [
    'finishToolResponse', 'response-1', { suppressResponse: false, sourceHasSpeech: true },
  ])
  assert.equal(calls.find(([name]) => name === 'responseDone')[1].awaitsToolFollowUp, true)
})

for (const status of ['failed', 'cancelled', 'incomplete']) {
  test(`suppresses even an inline result summary when the source response is ${status}`, () => {
    const { runtime, calls } = harness({ resultSummaryResponses: ['response-1'] })
    deliver(runtime, {
      type: 'response.created',
      response: { id: 'response-1' },
      __voiceContext: { turnId: 'turn-1', turnGeneration: 1 },
    })
    runtime.markFunctionCall('response-1')
    deliver(runtime, { type: 'response.done', response: { id: 'response-1', status } })
    assert.deepEqual(calls.find(([name]) => name === 'finishToolResponse'), [
      'finishToolResponse', 'response-1', { suppressResponse: true, sourceHasSpeech: false },
    ])
    assert.equal(calls.find(([name]) => name === 'responseDone')[1].awaitsToolFollowUp, false)
  })
}

test('user interruption confirms an announcement and suppresses late output', () => {
  const { runtime, events, calls } = harness()

  deliver(runtime, {
    type: 'response.audio.delta',
    response_id: 'response-1',
    delta: 'audio',
    __voiceOrigin: 'announcement',
    __voiceContext: {
      turnId: 'turn-1',
      turnGeneration: 1,
      taskIds: ['work-1'],
    },
  })
  runtime.startPlayback('response-1')
  runtime.cancelPlayback('response-1', { reason: 'user_interruption' })
  deliver(runtime, {
    type: 'response.audio_transcript.done',
    response_id: 'response-1',
    transcript: '不应出现',
  })

  assert.equal(
    events.filter(event => event.type === 'transcript.final').length,
    0,
  )
  assert.equal(
    events.filter(event => event.type === 'response.interrupted').length,
    1,
  )
  assert.equal(
    calls.filter(([name]) => name === 'confirmMany').length,
    3,
  )
  assert.equal(calls.some(([name]) => name === 'retryMany'), false)
})

test('a provider failure retries an undelivered announcement', () => {
  const { runtime, calls } = harness()
  runtime.begin({
    type: 'response.created',
    response: { id: 'response-1' },
    __voiceOrigin: 'announcement',
    __voiceContext: {
      turnId: 'turn-1',
      turnGeneration: 1,
      taskIds: ['work-1'],
    },
  })

  runtime.failResponse({ type: 'error', response_id: 'response-1' })

  assert.equal(runtime.has('response-1'), false)
  assert.deepEqual(
    calls.find(([name]) => name === 'retryMany'),
    ['retryMany', ['work-1']],
  )
})

test('a concurrent voice layer presents only the spoken response; backend steps stay internal', () => {
  const { runtime, events } = harness({ concurrentVoicePlayback: true })
  const clientTypes = () => events.map(event => `${event.type}:${event.responseId || ''}`)
    .filter(entry => /^(response\.started|audio\.done|audio\.delta):/.test(entry))
  runtime.begin({ type: 'response.created', response: { id: 'resp_1' } })
  runtime.handle({ type: 'response.created', response: { id: 'resp_1' } })
  runtime.begin({ type: 'response.created', response: { id: 'voice_1' }, __voicePlayback: true })
  runtime.handle({ type: 'response.created', response: { id: 'voice_1' }, __voicePlayback: true })
  runtime.begin({ type: 'response.output_audio.delta', response_id: 'voice_1', delta: 'AAAA' })
  runtime.handle({ type: 'response.output_audio.delta', response_id: 'voice_1', delta: 'AAAA' })
  runtime.begin({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })
  runtime.handle({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })
  assert.deepEqual(clientTypes(), ['response.started:voice_1', 'audio.delta:voice_1'],
    'a finished backend step must not end the turn while the answer is still spoken')
  runtime.begin({ type: 'response.done', response: { id: 'voice_1', status: 'completed' }, __voicePlayback: true })
  runtime.handle({ type: 'response.done', response: { id: 'voice_1', status: 'completed' }, __voicePlayback: true })
  assert.deepEqual(clientTypes(), ['response.started:voice_1', 'audio.delta:voice_1', 'audio.done:voice_1'])
})

test('without a concurrent voice layer every response is presented as before', () => {
  const { runtime, events } = harness()
  runtime.begin({ type: 'response.created', response: { id: 'resp_1' } })
  runtime.handle({ type: 'response.created', response: { id: 'resp_1' } })
  runtime.begin({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })
  runtime.handle({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } })
  assert.deepEqual(events.filter(event => ['response.started', 'audio.done'].includes(event.type)).map(event => event.type),
    ['response.started', 'audio.done'])
})

function concurrentVoice(options = {}) {
  const playbackResponses = new Set()
  const setup = harness({ concurrentVoicePlayback: true, playbackResponses, ...options })
  const announcement = { turnId: 'gateway_t1', turnGeneration: 0, taskId: 'work-1', taskIds: ['work-1'] }
  const backend = (type, id, origin = 'announcement', context = announcement) => deliver(setup.runtime, {
    type, response: { id, status: 'completed' }, __voiceOrigin: origin, __voiceContext: context,
  })
  const voiceCreated = id => {
    playbackResponses.add(id)
    deliver(setup.runtime, { type: 'response.created', response: { id }, __voicePlayback: true, __voiceOrigin: 'model', __voiceContext: {} })
  }
  const voiceDone = id => {
    playbackResponses.delete(id)
    deliver(setup.runtime, { type: 'response.done', response: { id, status: 'completed' }, __voicePlayback: true, __voiceContext: {} })
  }
  const started = () => setup.events.filter(event => event.type === 'response.started')
  const called = name => setup.calls.filter(([entry]) => entry === name)
  return { ...setup, playbackResponses, backend, voiceCreated, voiceDone, started, called }
}

test('the voice response speaking a running backend step presents its announcement identity', () => {
  const h = concurrentVoice()
  h.backend('response.created', 'resp_1')
  h.voiceCreated('voice_1')
  assert.deepEqual(h.started().map(event => ({ ...event })), [{
    type: 'response.started', responseId: 'voice_1', turnId: 'gateway_t1', taskId: 'work-1',
    taskIds: ['work-1'], origin: 'announcement', turnGeneration: 0,
  }])
  deliver(h.runtime, { type: 'response.output_audio.delta', response_id: 'voice_1', delta: 'AAAA' })
  h.runtime.startPlayback('voice_1')
  assert.deepEqual(h.called('confirmMany'), [['confirmMany', ['work-1']]])
  h.backend('response.done', 'resp_1')
  h.voiceDone('voice_1')
  assert.deepEqual(h.called('retryMany'), [], 'the adopting voice response owns confirmation')
})

test('a voice response that starts shortly after the backend step finished still adopts it', async () => {
  const h = concurrentVoice({ backendResultOwedMs: 20 })
  h.backend('response.created', 'resp_1')
  h.backend('response.done', 'resp_1')
  h.voiceCreated('voice_1')
  assert.equal(h.started()[0].origin, 'announcement')
  assert.deepEqual(h.started()[0].taskIds, ['work-1'])
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(h.called('retryMany'), [])
})

test('a backend result nobody speaks within the owed window is retried', async () => {
  const h = concurrentVoice({ backendResultOwedMs: 20 })
  h.backend('response.created', 'resp_1')
  h.backend('response.done', 'resp_1')
  assert.deepEqual(h.called('retryMany'), [], 'the voice layer may still speak it')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(h.called('retryMany'), [['retryMany', ['work-1']]])
  h.voiceCreated('voice_1')
  assert.equal(h.started()[0].origin, 'model', 'an expired result is not adopted')
})

test('the voice response speaking a permission prompt keeps its permission identity', () => {
  const h = concurrentVoice()
  h.backend('response.created', 'resp_1', 'permission', { turnId: 'gateway_p1', turnGeneration: 0, taskId: 'work-1', authorizationId: 'auth-1' })
  h.voiceCreated('voice_1')
  assert.equal(h.started()[0].origin, 'permission')
  assert.equal(h.started()[0].taskId, 'work-1')
  h.runtime.cancelPermission('auth-1')
  assert.equal(h.runtime.get('voice_1').suppressed, true, 'resolving the permission stops its speech')
})

test('a voice response after a newer user turn does not adopt an older backend step', () => {
  const h = concurrentVoice()
  h.backend('response.created', 'resp_1')
  h.turns.beginManual('turn-2')
  h.voiceCreated('voice_1')
  assert.equal(h.started()[0].origin, 'model')
  assert.equal(h.started()[0].turnId, 'turn-2')
})

test('a backend step settling with no voice playback open returns its turn to idle', () => {
  const h = concurrentVoice()
  const turn = { turnId: 'turn-1', turnGeneration: 1 }
  h.backend('response.created', 'resp_1', 'model', turn)
  h.backend('response.done', 'resp_1', 'model', turn)
  assert.deepEqual(h.events.map(event => `${event.type}:${event.state || ''}:${event.turnId || ''}`),
    ['voice.state:idle:turn-1'])
})

test('a backend step settling while the voice layer still speaks leaves the turn to the voice', () => {
  const h = concurrentVoice()
  const turn = { turnId: 'turn-1', turnGeneration: 1 }
  h.backend('response.created', 'resp_2', 'model', turn)
  h.voiceCreated('voice_1')
  h.backend('response.done', 'resp_2', 'model', turn)
  assert.deepEqual(h.events.filter(event => event.type !== 'response.started').map(event => event.type), [])
})

test('a result handed to the voice layer to say is delivered, not retried', () => {
  const { runtime, calls } = harness()
  runtime.begin({
    type: 'response.created',
    response: { id: 'say_1', status: 'in_progress' },
    response_id: 'say_1',
    __voicePlayback: true,
    __voiceOrigin: 'announcement',
    __voiceContext: { turnId: 'turn-1', turnGeneration: 1, taskIds: ['work-1'] },
  })
  runtime.handle({
    type: 'response.done',
    response: { id: 'say_1', status: 'completed' },
    response_id: 'say_1',
    __voicePlayback: true,
  })
  assert.deepEqual(calls.filter(([name]) => name === 'confirmMany'), [['confirmMany', ['work-1']]])
  assert.equal(calls.some(([name]) => name === 'retryMany'), false)
})
