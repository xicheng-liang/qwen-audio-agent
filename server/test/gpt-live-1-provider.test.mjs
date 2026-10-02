import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { config } from '../src/core/config.mjs'
import { RealtimeFrontend } from '../src/voice/realtime-provider.mjs'
import { RealtimeProviderSession } from '../src/voice/realtime-provider-session.mjs'
import { gptLive1Provider, sessionInputHistory } from '../src/voice/providers/gpt-live-1.mjs'
import { GatewaySystemEvent, createGatewaySystemEventDelivery } from '../src/delivery/gateway-system-event.mjs'
import { ToolCallHandler } from '../src/frontend/tools/tool-call-handler.mjs'
import {
  permissionResponseInstructions,
  progressResponseInstructions,
  resultResponseInstructions,
} from '../src/frontend/frontend-tools.mjs'
import {
  createGptLive1Protocol,
  clampCommentary,
  estimateTokens,
  fitBackendItem,
  utf8Bytes,
} from '../src/voice/providers/gpt-live-1-protocol.mjs'
import {
  defaultRealtimeProviderRegistry,
  describeActiveRealtime,
  validateRealtimeProvider,
} from '../src/voice/providers/registry.mjs'
import { resolveRealtimeModelProfile } from '../../shared/realtime-model-catalog.mjs'
import { assertRealtimeFrontendModel } from '../../shared/realtime-provider-catalog.mjs'
import { gatewaySetupStatus } from '../../shared/gateway/setup.mjs'

function withConfig(t, patch) {
  const previous = Object.fromEntries(
    Object.keys(patch).map(key => [key, config[key]]),
  )
  Object.assign(config, patch)
  t.after(() => Object.assign(config, previous))
}

function withEnv(t, patch) {
  const previous = Object.fromEntries(
    Object.keys(patch).map(key => [key, process.env[key]]),
  )
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

const SESSION_START_FIELDS = new Set(['model', 'instructions', 'input', 'audio', 'delegation'])

test('GPT-Live 1 registers under its key and aliases with function calling', () => {
  for (const name of ['gpt-live-1', 'gptlive1', 'openai-live', 'GPT-Live-1']) {
    // The Realtime provider keeps its own aliases; none may resolve here.
    assert.notEqual(defaultRealtimeProviderRegistry.resolve('gpt-realtime').key, 'gpt-live-1')
    assert.equal(defaultRealtimeProviderRegistry.resolve(name).key, 'gpt-live-1')
  }
  const active = describeActiveRealtime('gpt-live-1')
  assert.equal(active.model, config.gptLive1Model)
  assert.equal(active.modelCapabilities.functionCalling, true)
  assert.equal(active.modelCapabilities.audioInput, true)
  assert.equal(active.modelCapabilities.audioOutput, true)
  assert.equal(active.inputSampleRate, 24000)
  assert.deepEqual(active.modelCatalog.map(profile => profile.id), ['gpt-live-1'])
})

test('GPT-Live 1 defaults to the OpenAI Live API with a plain OpenAI key', t => {
  withConfig(t, {
    gptLive1ApiKey: 'openai-test',
    gptLive1RealtimeUrl: 'wss://api.openai.com/v1/live/sessions',
    gptLive1Model: 'gpt-live-1',
    gptLive1Voice: '',
  })
  assert.equal(gptLive1Provider.isConfigured(), true)
  // The model travels inside session.start, never as a URL query parameter.
  assert.equal(gptLive1Provider.url(), 'wss://api.openai.com/v1/live/sessions')
  assert.deepEqual(gptLive1Provider.headers(), { Authorization: 'Bearer openai-test' })
  assert.equal(gptLive1Provider.voice(), null)
})

test('an internal AI gateway is only a different endpoint and key', t => {
  withConfig(t, {
    gptLive1ApiKey: 'gateway-service-key',
    gptLive1RealtimeUrl: 'wss://gateway.example/openai/v1/live/sessions',
    gptLive1Model: 'live-deployment-a',
  })
  assert.equal(
    gptLive1Provider.url(),
    'wss://gateway.example/openai/v1/live/sessions',
  )
  assert.deepEqual(gptLive1Provider.headers(), { Authorization: 'Bearer gateway-service-key' })
  const session = gptLive1Provider.buildSession({ agentContext: {}, sessionOptions: {} })
  // The Azure deployment name is the model the session starts with.
  assert.equal(session.model, 'live-deployment-a')
})

test('GPT-Live 1 builds a strict session.start payload with Responses delegation', t => {
  withConfig(t, { gptLive1ApiKey: 'k', gptLive1Model: 'gpt-live-1', gptLive1Voice: '' })
  withEnv(t, {
    GPT_LIVE_1_DELEGATION_MODEL: 'gpt-5.6-terra',
    GPT_LIVE_1_DELEGATION_INSTRUCTIONS: undefined,
  })
  const session = gptLive1Provider.buildSession({ agentContext: {}, sessionOptions: {} })
  // The Live API rejects unknown fields at startup.
  for (const key of Object.keys(session)) assert.ok(SESSION_START_FIELDS.has(key), key)
  assert.equal(session.model, 'gpt-live-1')
  assert.ok(session.instructions.length > 0)
  assert.equal(session.audio, undefined)
  assert.equal(session.delegation.type, 'responses')
  assert.equal(session.delegation.responses.model, 'gpt-5.6-terra')
  assert.equal(session.delegation.responses.tool_choice, 'auto')
  assert.ok(session.delegation.responses.tools.length > 0)
  assert.ok(session.delegation.responses.tools.every(tool => (
    tool.type === 'function' && tool.name && tool.parameters
  )))

  const voiced = gptLive1Provider.buildSession({ agentContext: {}, sessionOptions: { voice: 'marin' } })
  assert.deepEqual(voiced.audio, { output: { voice: 'marin' } })

  // The voice prompt follows the prompting guide's policy sections and lists
  // backend capabilities; the backend prompt carries the full frontend rules.
  for (const heading of ['Backchannel policy:', 'Interruption policy:', 'Delegation policy:', 'Backend tools:']) {
    assert.ok(session.instructions.includes(heading), heading)
  }
  assert.ok(session.delegation.responses.instructions.includes('## Task instructions'))
  assert.equal(session.input, undefined, 'no history means no input field')

  // Prior conversation seeds session.input in the documented message shape.
  const seeded = gptLive1Provider.buildSession({
    agentContext: { recentMessages: [
      { role: 'user', content: '帮我记一下明天开会' },
      { role: 'assistant', content: '好的，已记下。' },
      { role: 'system', content: 'ignored' },
    ] },
    sessionOptions: {},
  })
  assert.deepEqual(seeded.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我记一下明天开会' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的，已记下。' }] },
  ])
  const many = sessionInputHistory(Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `m${i}` })))
  assert.equal(many.length, 64)
  assert.equal(many.at(-1).content[0].text, 'm199')
})

test('GPT-Live 1 speaks short announcements through commentary appends', () => {
  const protocol = createGptLive1Protocol()
  assert.deepEqual(gptLive1Provider.buildSpeakResponse('晚饭好了'), { __liveSay: '晚饭好了' })
  assert.deepEqual(protocol.responseCreate(gptLive1Provider.buildSpeakResponse('晚饭好了')), {
    type: 'session.commentary.append',
    delegation_id: null,
    content: '晚饭好了',
  })
  // Appends are capped at 500 tokens; a runaway announcement is clamped, not
  // rejected, and the estimate treats a CJK character as a whole token.
  const long = protocol.responseCreate({ __liveSay: 'x'.repeat(5000) })
  assert.ok(long.content.endsWith('…'))
  assert.ok(estimateTokens(long.content) <= 480, String(estimateTokens(long.content)))
  const cjk = clampCommentary('天'.repeat(1000))
  assert.ok(cjk.endsWith('…'))
  assert.ok([...cjk].length <= 481, String([...cjk].length))
  assert.equal(clampCommentary('晚饭好了'), '晚饭好了')
  // A spoken payload never turns into a backend instruction item.
  assert.equal(protocol.responseInstructionsItem({ __liveSay: '晚饭好了', instructions: 'ignored' }), null)
  // Without spoken content a response request continues the delegated backend.
  assert.deepEqual(protocol.responseCreate(undefined), { type: 'response.create' })
  assert.deepEqual(protocol.responseCreate({ modalities: ['audio'] }), { type: 'response.create' })
})

test('GPT-Live 1 routes task results and permissions through the delegated backend', () => {
  const protocol = createGptLive1Protocol()
  const injection = gptLive1Provider.buildResultInjection('任务完成：报告已生成')
  assert.deepEqual(protocol.conversationItemCreate(injection.item), {
    type: 'response.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '任务完成：报告已生成' }] },
  })
  // The fixed guidance for injected items is part of the backend prompt, so
  // no instruction item accompanies the injection: one item per injection.
  assert.equal(protocol.responseInstructionsItem(injection.response), null)
  assert.deepEqual(protocol.responseCreate(injection.response), { type: 'response.create' })

  const permission = gptLive1Provider.buildPermissionInjection({
    id: 'perm_1', taskId: 'task_1', summary: '删除文件',
  })
  const permissionItem = protocol.conversationItemCreate(permission.item)
  assert.equal(permissionItem.type, 'response.item.create')
  assert.match(permissionItem.item.content[0].text, /permission_id=perm_1/)
  assert.equal(protocol.responseInstructionsItem(permission.response), null)
  assert.equal(protocol.responseInstructionsItem(undefined), null)
})

test('GPT-Live 1 protocol encodes the documented client events', () => {
  const protocol = createGptLive1Protocol()
  const [start] = protocol.connectionMessages({ session: { model: 'gpt-live-1' } })
  assert.equal(start.type, 'session.start')
  assert.match(start.event_id, /^event_[0-9a-f]{32}$/)
  assert.deepEqual(start.session, { model: 'gpt-live-1' })
  const encoded = protocol.encodeOutgoing({ type: 'session.input_audio.append', audio: 'AAAA' })
  assert.match(encoded.event_id, /^event_[0-9a-f]{32}$/)
  assert.equal(encoded.type, 'session.input_audio.append')
  assert.equal(protocol.encodeOutgoing(null), null)
  assert.deepEqual(protocol.audioAppend('AAAA'), { type: 'session.input_audio.append', audio: 'AAAA' })
  assert.equal(protocol.sessionUpdate({ instructions: 'x' }), null, 'start-time fields are never resent')
  assert.deepEqual(protocol.inputMute(), { type: 'session.input_audio.mute' })
  assert.deepEqual(protocol.inputUnmute(), { type: 'session.input_audio.unmute' })
  assert.deepEqual(protocol.sessionClose('client_closed'), { type: 'session.close' })
  assert.equal(protocol.responseCancel(), null)
  assert.equal(protocol.imageAppend('img'), null)
})

test('GPT-Live 1 protocol returns tool results to the delegated backend', () => {
  const protocol = createGptLive1Protocol()
  assert.deepEqual(protocol.conversationItemCreate(
    protocol.functionOutputItem('call_1', { ok: true }),
  ), {
    type: 'response.item.create',
    item: { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
  })
  assert.deepEqual(protocol.conversationItemCreate(protocol.userTextItem('记住我喝美式')), {
    type: 'response.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '记住我喝美式' }] },
  })
  assert.equal(protocol.conversationItemCreate(protocol.userTextItem('   ')), null)
})

test('GPT-Live 1 protocol brackets spoken output into responses by timeline gaps', () => {
  const protocol = createGptLive1Protocol()
  assert.deepEqual(
    protocol.normalizeIncoming({ type: 'session.started', session: { id: 'sess_1' } }),
    { type: 'session.created', session: { id: 'sess_1' } },
  )
  const first = protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: 'AAAA', start_ms: 0, end_ms: 100,
  })
  assert.deepEqual(first.map(event => event.type), ['response.created', 'response.output_audio.delta'])
  const responseId = first[0].response.id
  assert.equal(first[1].response_id, responseId)
  assert.equal(first[1].delta, 'AAAA')

  const contiguous = protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: 'BBBB', start_ms: 100, end_ms: 200,
  })
  assert.deepEqual(contiguous.map(event => event.type), ['response.output_audio.delta'])
  assert.equal(contiguous[0].response_id, responseId)

  const transcript = protocol.normalizeIncoming({
    type: 'session.output_transcript.delta', delta: '你好', start_ms: 0, end_ms: 200,
  })
  assert.deepEqual(transcript, [{
    type: 'response.output_audio_transcript.delta', response_id: responseId, delta: '你好',
  }])

  // Omitted silence longer than the segment gap starts a new spoken response.
  const later = protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: 'CCCC', start_ms: 5000, end_ms: 5100,
  })
  assert.deepEqual(later.map(event => event.type), [
    'response.output_audio_transcript.done', 'response.done', 'response.created', 'response.output_audio.delta',
  ])
  // The closed segment's transcript is final, so the runtime records the assistant turn.
  assert.deepEqual(later[0], { type: 'response.output_audio_transcript.done', response_id: responseId, transcript: '你好' })
  assert.equal(later[1].response.id, responseId)
  assert.equal(later[1].response.status, 'completed')
  assert.notEqual(later[2].response.id, responseId)
  assert.equal(later[3].response_id, later[2].response.id)
})

test('GPT-Live 1 protocol synthesises the user turn from timed transcript fragments', () => {
  const protocol = createGptLive1Protocol()
  protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: 'AAAA', start_ms: 0, end_ms: 100,
  })
  // Fresh user speech is a barge-in: the spoken response closes first.
  const started = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '明天', start_ms: 600, end_ms: 800,
  })
  assert.deepEqual(started.map(event => event.type), [
    'response.done',
    'input_audio_buffer.speech_started',
    'conversation.item.input_audio_transcription.delta',
  ])
  const itemId = started[1].item_id
  assert.equal(started[2].item_id, itemId)
  assert.equal(started[2].text, '明天')

  // Delegation carries no turn boundary; fragments keep flowing into the item.
  assert.deepEqual(protocol.normalizeIncoming({
    type: 'session.delegation.created',
    delegation: { id: 'item_d1', type: 'delegation', target: 'responses' },
  }), [])
  const more = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '天气', start_ms: 800, end_ms: 1200,
  })
  assert.deepEqual(more.map(event => event.type), ['conversation.item.input_audio_transcription.delta'])
  assert.equal(more[0].item_id, itemId)
  assert.equal(more[0].delta, '天气')
  assert.equal(more[0].text, '明天天气', 'text carries the caption so far, not the bare fragment')

  // The assistant starts answering; a late fragment continuing the timeline
  // still belongs to the same utterance and must not cut the answer off.
  const answer = protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: 'AAAA', start_ms: 2000, end_ms: 2100,
  })
  // GA order: the user's turn ends (speech_stopped, committed) before the answer
  // opens, so the runtime does not treat the answer as talking over the user.
  assert.deepEqual(answer.map(event => event.type), [
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.committed',
    'response.created',
    'response.output_audio.delta',
  ])
  assert.equal(answer[0].item_id, itemId)
  const answerId = answer.find(event => event.type === 'response.created').response.id
  const late = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '怎么样', start_ms: 1200, end_ms: 1500,
  })
  assert.deepEqual(late.map(event => event.type), ['conversation.item.input_audio_transcription.delta'])
  assert.equal(late[0].item_id, itemId)

  // The utterance ends (idle) while the answer plays on: already committed,
  // so only the transcript completes.
  const idle = protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' })
  assert.deepEqual(idle.map(event => event.type), [
    'conversation.item.input_audio_transcription.completed',
  ])
  assert.equal(idle[0].transcript, '明天天气怎么样')

  // A lagging fragment of speech that happened BEFORE the answer began (its
  // start precedes the answer's first output) is not an interruption: it
  // reopens the question so the caption grows, and starts no turn, because
  // the runtime clears playback on every speech_started.
  const lagging = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '还有', start_ms: 1700, end_ms: 1900,
  })
  assert.deepEqual(lagging.map(event => event.type), [
    'conversation.item.input_audio_transcription.delta',
  ], 'speech from before the answer started must not cancel it')
  assert.equal(lagging[0].item_id, itemId)
  assert.equal(lagging[0].text, '明天天气怎么样还有')
  assert.deepEqual(protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' }), [], 'not completed twice')

  // Speech that starts AFTER the answer began is a barge-in: interrupt it.
  const next = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '谢谢', start_ms: 4000, end_ms: 4200,
  })
  assert.deepEqual(next.map(event => event.type), [
    'response.done',
    'input_audio_buffer.speech_started',
    'conversation.item.input_audio_transcription.delta',
  ])
  assert.equal(next[0].response.id, answerId)
  assert.equal(next[0].response.status, 'cancelled', 'a barge-in interrupts the playback record')
  assert.notEqual(next[1].item_id, itemId)
})

test('GPT-Live 1 protocol completes the user utterance once input goes idle', async () => {
  const emitted = []
  const protocol = createGptLive1Protocol({ emit: event => emitted.push(event), inputIdleMs: 20, outputIdleMs: 0 })
  const started = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '你好', start_ms: 100, end_ms: 300,
  })
  const itemId = started.find(event => event.type === 'input_audio_buffer.speech_started').item_id
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(emitted.length, 1)
  const completed = protocol.normalizeIncoming(emitted[0])
  assert.deepEqual(completed.map(event => event.type), [
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.committed',
    'conversation.item.input_audio_transcription.completed',
  ])
  assert.equal(completed[2].item_id, itemId)
  assert.equal(completed[2].transcript, '你好')
  // The answer begins; a late fragment from before it continues the question.
  const speaking = protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: 'AAAA', start_ms: 500, end_ms: 600,
  })
  assert.equal(speaking[0].type, 'response.created')
  const tail = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '啊', start_ms: 300, end_ms: 400,
  })
  assert.deepEqual(tail.map(event => event.type), ['conversation.item.input_audio_transcription.delta'])
  assert.equal(tail[0].item_id, itemId)
  assert.equal(tail[0].text, '你好啊')
  // Speech after the answer began is a new turn.
  const fresh = protocol.normalizeIncoming({
    type: 'session.input_transcript.delta', delta: '等等', start_ms: 2500, end_ms: 2700,
  })
  assert.deepEqual(fresh.map(event => event.type), [
    'response.done',
    'input_audio_buffer.speech_started',
    'conversation.item.input_audio_transcription.delta',
  ])
  assert.notEqual(fresh[1].item_id, itemId)
})

test('GPT-Live 1 protocol unwraps the delegated Responses function-call loop', () => {
  const protocol = createGptLive1Protocol()
  const created = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d1',
    event: { type: 'response.created', response: { id: 'resp_1' } },
  })
  assert.deepEqual(created, [{
    type: 'response.created', response: { id: 'resp_1', status: 'in_progress' }, response_id: 'resp_1',
  }])

  assert.deepEqual(protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d1',
    event: { type: 'response.output_text.delta', delta: 'The forecast is' },
  }), [])

  const call = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d1',
    event: {
      type: 'response.output_item.done',
      response: { id: 'resp_1' },
      item: { type: 'function_call', call_id: 'call_1', name: 'spawn_thinking', arguments: '{"task":"查天气"}' },
    },
  })
  assert.deepEqual(call, [{
    type: 'response.function_call_arguments.done',
    response_id: 'resp_1',
    call_id: 'call_1',
    name: 'spawn_thinking',
    arguments: '{"task":"查天气"}',
  }])

  const direct = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d1',
    event: { type: 'response.function_call_arguments.done', call_id: 'call_2', name: 'get_current_time', arguments: '{}' },
  })
  assert.equal(direct[0].call_id, 'call_2')
  // Nested events without a response object inherit the response id that
  // response.created bound to this delegation, so the tool batch and the
  // later response.done share one id.
  assert.equal(direct[0].response_id, 'resp_1')

  // The Responses stream also emits an arguments-done twin with no call_id
  // alongside output_item.done; it must be dropped, not raised as a bad call.
  assert.deepEqual(protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d1',
    event: { type: 'response.function_call_arguments.done', arguments: '{"q":"x"}' },
  }), [])

  const done = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d1',
    event: { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } },
  })
  assert.deepEqual(done, [{
    type: 'response.done', response: { id: 'resp_1', status: 'completed' }, response_id: 'resp_1',
  }])

  const failed = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d1',
    event: { type: 'response.failed', response: { id: 'resp_2', error: { message: 'quota' } } },
  })
  assert.equal(failed[0].type, 'error')
  assert.equal(failed[0].error.message, 'quota')
})

test('GPT-Live 1 protocol passes errors through and closes cleanly', () => {
  const protocol = createGptLive1Protocol()
  assert.deepEqual(protocol.normalizeIncoming({
    type: 'error', error: { type: 'invalid_request_error', code: 'invalid_audio', message: 'odd bytes' },
  }), { type: 'error', error: { type: 'invalid_request_error', code: 'invalid_audio', message: 'odd bytes' } })
  for (const type of [
    'session.updated', 'session.usage.updated', 'session.commentary.appended',
    'session.thinking.appended', 'session.instructions.appended',
    'session.input_audio.muted', 'session.input_audio.unmuted',
  ]) {
    assert.deepEqual(protocol.normalizeIncoming({ type }), [], type)
  }
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '嗨', start_ms: 0, end_ms: 100 })
  const spoken = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: 'AAAA', start_ms: 300, end_ms: 400 })
  assert.deepEqual(spoken.map(event => event.type).slice(0, 2), ['input_audio_buffer.speech_stopped', 'input_audio_buffer.committed'])
  const closed = protocol.normalizeIncoming({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 3 } })
  assert.deepEqual(closed.map(event => event.type), [
    'conversation.item.input_audio_transcription.completed',
    'response.done',
  ])
  assert.equal(gptLive1Provider.classifyError('Unexpected server response: 401'), 'fatal')
  assert.equal(gptLive1Provider.classifyError('immutable_field_update: instructions'), 'other')
  assert.equal(gptLive1Provider.classifyError('content_filter triggered'), 'content_safety')
})

test('GPT-Live 1 protocol closes a spoken segment once output goes idle', async () => {
  const emitted = []
  const protocol = createGptLive1Protocol({ emit: event => emitted.push(event), outputIdleMs: 20 })
  const opened = protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: 'AAAA', start_ms: 0, end_ms: 100,
  })
  const responseId = opened[0].response.id
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(emitted, [{ type: 'gpt-live-1.output_idle' }])
  assert.deepEqual(protocol.normalizeIncoming(emitted[0]), [{
    type: 'response.done', response: { id: responseId, status: 'completed' }, response_id: responseId,
    __voicePlayback: true,
  }])
  // Idle after the segment already closed is a no-op.
  assert.deepEqual(protocol.normalizeIncoming({ type: 'gpt-live-1.output_idle' }), [])
})

test('connects to a GPT-Live 1 mock service with session.start and no session.update', { timeout: 10000 }, async t => {
  withConfig(t, {
    gptLive1ApiKey: 'live-test',
    gptLive1Model: 'gpt-live-1',
    gptLive1Voice: 'marin',
  })
  withEnv(t, { GPT_LIVE_1_DELEGATION_MODEL: 'gpt-5.6-terra', GPT_LIVE_1_OUTPUT_IDLE_MS: '40' })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  const received = []
  const events = []
  let authorization = ''

  server.once('connection', (socket, request) => {
    authorization = request.headers.authorization
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      received.push(message)
      if (message.type === 'session.start') {
        socket.send(JSON.stringify({
          type: 'session.started',
          session: { id: 'sess_1', model: message.session.model },
        }))
        socket.send(JSON.stringify({
          type: 'session.output_audio.delta', delta: 'AAAA', start_ms: 0, end_ms: 100,
        }))
      } else if (message.type === 'session.commentary.append') {
        socket.send(JSON.stringify({
          type: 'session.commentary.appended', client_event_id: message.event_id,
        }))
        socket.send(JSON.stringify({
          type: 'session.output_audio.delta', delta: 'BBBB', start_ms: 4000, end_ms: 4100,
        }))
      }
    })
  })
  const address = server.address()
  withConfig(t, {
    gptLive1RealtimeUrl: `ws://127.0.0.1:${address.port}/v1/live/sessions`,
  })
  const frontend = new RealtimeFrontend({
    provider: gptLive1Provider,
    agentContext: {},
    onEvent: event => events.push(event),
    responseStartTimeoutMs: 500,
  })
  t.after(async () => {
    frontend.close()
    await new Promise(resolve => server.close(resolve))
  })

  await frontend.connect()
  assert.equal(frontend.ready, true)
  assert.equal(authorization, 'Bearer live-test')
  assert.equal(received[0].type, 'session.start')
  assert.match(received[0].event_id, /^event_/)
  assert.equal(received[0].session.model, 'gpt-live-1')
  assert.equal(received[0].session.delegation.type, 'responses')
  assert.deepEqual(received[0].session.audio, { output: { voice: 'marin' } })
  // Startup configuration is immutable: nothing else is sent before speech.
  assert.equal(received.filter(message => message.type === 'session.update').length, 0)
  assert.ok(events.some(event => event.type === 'response.output_audio.delta'))

  // The first spoken segment must close by itself (idle timer) or this speak
  // request would wait behind it forever: the Live API sends no turn end.
  const outcome = await frontend.speak('晚饭好了', 'announcement')
  const commentary = received.find(message => message.type === 'session.commentary.append')
  assert.equal(commentary?.content, '晚饭好了')
  assert.equal(commentary?.delegation_id, null)
  assert.equal(outcome.completed, true)
  const created = events.filter(event => event.type === 'response.created')
  const done = events.filter(event => event.type === 'response.done')
  // The announcement settles on the commentary acknowledgement as a playback
  // response of its own; the voice segment that speaks it is the model's.
  const announcement = created.find(event => event.__voiceOrigin === 'announcement')
  assert.ok(announcement, 'the speak request bound to the acknowledged commentary')
  assert.equal(announcement.__voicePlayback, true)
  assert.ok(done.some(event => event.response.id === announcement.response.id))
})

test('GPT-Live 1 lists the active deployment name in its model catalog', t => {
  withConfig(t, { gptLive1Model: 'live-deployment-a' })
  const ids = gptLive1Provider.modelCatalog().map(profile => profile.id)
  assert.deepEqual(ids, ['gpt-live-1', 'live-deployment-a'])
  assert.equal(gptLive1Provider.modelCatalog().at(-1).family, 'gpt-live-1')
  withConfig(t, { gptLive1Model: 'gpt-live-1' })
  assert.deepEqual(gptLive1Provider.modelCatalog().map(profile => profile.id), ['gpt-live-1'])
})

test('GPT-Live 1 accepts an Azure deployment name with the default profile', () => {
  const profile = resolveRealtimeModelProfile('live-deployment-a', 'gpt-live-1')
  assert.equal(profile.id, 'live-deployment-a')
  assert.equal(profile.family, 'gpt-live-1')
  assert.equal(profile.modelCapabilities.functionCalling, true)
  assert.doesNotThrow(() => assertRealtimeFrontendModel({ provider: 'gpt-live-1', model: 'live-deployment-a' }))
  // Providers without the flag keep the strict catalog check.
  assert.equal(resolveRealtimeModelProfile('realtime-deployment-a', 'gpt-live').family, 'unknown')
  assert.throws(
    () => assertRealtimeFrontendModel({ provider: 'gpt-live', model: 'realtime-deployment-a' }),
    /不属于 gpt-live/,
  )
})

test('GPT-Live 1 protocol closes open responses locally on cancel', async () => {
  const emitted = []
  const protocol = createGptLive1Protocol({ emit: event => emitted.push(event), outputIdleMs: 0 })
  const opened = protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: 'AA==', start_ms: 0, end_ms: 100,
  })
  const voiceId = opened.find(event => event.type === 'response.created').response.id
  // A response the adapter did not open (a foreign dialect passed through) is
  // not a playback record, so a cancel leaves it alone as well.
  protocol.normalizeIncoming({ type: 'response.created', response: { id: 'response_passthrough' } })
  // A delegated backend response keeps running on the service when speech is
  // interrupted, so a gateway cancel must leave it open for its tool loop.
  protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_bg',
    event: { type: 'response.created', response: { id: 'resp_bg' } },
  })
  assert.equal(protocol.responseCancel(), null)
  await new Promise(resolve => queueMicrotask(resolve))
  assert.deepEqual(
    emitted.map(event => [event.type, event.response.id, event.response.status]),
    [['response.done', voiceId, 'cancelled']],
  )
  const backendDone = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_bg',
    event: { type: 'response.completed', response: { id: 'resp_bg', status: 'completed' } },
  })
  assert.equal(backendDone[0].response_id, 'resp_bg')
  // A cancelled voice segment does not leak into the next one.
  const next = protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: 'AA==', start_ms: 200, end_ms: 300,
  })
  const nextId = next.find(event => event.type === 'response.created').response.id
  assert.notEqual(nextId, voiceId)
  // Only the new segment is open now; cancelling again closes just that one.
  assert.equal(protocol.responseCancel(), null)
  await new Promise(resolve => queueMicrotask(resolve))
  assert.equal(emitted.length, 2)
  assert.equal(emitted[1].response.id, nextId)
})

test('GPT-Live 1 setup gate accepts either the dedicated key or OPENAI_API_KEY', () => {
  const base = { QWEN_AUDIO_REALTIME_PROVIDER: 'gpt-live-1', GPT_LIVE_1_REALTIME_MODEL: 'live-deployment-a' }
  assert.equal(gatewaySetupStatus({ ...base, GPT_LIVE_1_API_KEY: 'service-key', OPENAI_API_KEY: '' }).ready, true)
  assert.equal(gatewaySetupStatus({ ...base, OPENAI_API_KEY: 'sk-plain' }).ready, true)
  const missing = gatewaySetupStatus({ ...base, OPENAI_API_KEY: '' })
  assert.equal(missing.ready, false)
  assert.deepEqual(missing.missing.map(item => item.key), ['GPT_LIVE_1_API_KEY'])
  assert.match(missing.missing[0].message, /也支持 OPENAI_API_KEY/)
})

test('GPT-Live 1 keeps gateway responses off the voice playback gate', async () => {
  assert.equal(gptLive1Provider.capabilities.concurrentVoicePlayback, true)
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {} })
  // A voice playback response is active but must not gate gateway work.
  frontend.activeResponses.add('voice_1')
  frontend.playbackResponses.add('voice_1')
  assert.equal(frontend.gatingResponsesActive(), false)
  await frontend.whenIdle() // resolves immediately despite open playback

  // A backend delegation response does gate: whenIdle waits for it.
  frontend.activeResponses.add('resp_1')
  assert.equal(frontend.gatingResponsesActive(), true)
  let resolved = false
  const idle = frontend.whenIdle().then(() => { resolved = true })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(resolved, false, 'a backend response still gates whenIdle')
  frontend.activeResponses.delete('resp_1')
  frontend.resolveIdle()
  await idle
  assert.equal(resolved, true)
  frontend.close()
})

test('GPT-Live 1 marks synthesised voice responses as playback end to end', () => {
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {} })
  for (const event of frontend.protocol.normalizeIncoming({
    type: 'session.output_audio.delta', delta: 'AAAA', start_ms: 0, end_ms: 100,
  })) {
    if (event.type === 'response.created') {
      assert.equal(event.__voicePlayback, true)
      frontend.handleLifecycle(event)
      assert.equal(frontend.playbackResponses.has(event.response.id), true)
      assert.equal(frontend.gatingResponsesActive(), false)
    }
  }
  frontend.close()
})

test('GPT-Live 1 binds a delegation to its backend response id', () => {
  const protocol = createGptLive1Protocol()
  assert.deepEqual(protocol.normalizeIncoming({
    type: 'session.delegation.created',
    delegation: { id: 'item_d9', type: 'delegation', target: 'responses', response_id: 'resp_9' },
  }), [])
  const call = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d9',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_9', name: 'fetch_url', arguments: '{}' } },
  })
  assert.equal(call[0].response_id, 'resp_9', 'tool call carries the bound response id, not the delegation id')
  const done = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d9',
    event: { type: 'response.completed', response: { id: 'resp_9', status: 'completed' } },
  })
  assert.equal(done[0].response_id, 'resp_9')
  // After completion the binding is gone; a stray event falls back to the delegation id.
  const stray = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_d9',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_x', name: 'f', arguments: '{}' } },
  })
  assert.equal(stray[0].response_id, 'item_d9')
})

test('GPT-Live 1 sends session.update only when the delegation block changes', () => {
  const protocol = createGptLive1Protocol()
  const delegation = { type: 'responses', responses: { model: 'gpt-5.6-terra', tools: [{ type: 'function', name: 'a' }] } }
  protocol.connectionMessages({ session: { model: 'gpt-live-1', delegation } })
  assert.equal(protocol.sessionUpdate({ model: 'gpt-live-1', delegation }), null, 'unchanged after start')
  const changed = { ...delegation, responses: { ...delegation.responses, tools: [{ type: 'function', name: 'b' }] } }
  assert.deepEqual(protocol.sessionUpdate({ model: 'gpt-live-1', instructions: 'ignored', delegation: changed }), {
    type: 'session.update',
    session: { delegation: changed },
  })
  assert.equal(protocol.sessionUpdate({ delegation: changed }), null, 'deduplicated')
})

test('GPT-Live 1 closes an incomplete backend response and isolates command errors', () => {
  const protocol = createGptLive1Protocol()
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_x',
    event: { type: 'response.created', response: { id: 'resp_x' } },
  })
  const incomplete = protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_x',
    event: { type: 'response.incomplete', response: { id: 'resp_x', status: 'incomplete' } },
  })
  assert.deepEqual(incomplete, [{
    type: 'response.done', response: { id: 'resp_x', status: 'incomplete' }, response_id: 'resp_x',
  }])

  // A rejected mute is a command error: it gets its own id instead of being
  // attributed to whichever backend response happens to be active.
  const mute = protocol.encodeOutgoing({ type: 'session.input_audio.mute' })
  const muteError = protocol.normalizeIncoming({
    type: 'error', error: { code: 'invalid_request_error', message: 'not now', client_event_id: mute.event_id },
  })
  assert.equal(muteError.response_id, `gpt-live-1:command:${mute.event_id}`)
  // A rejected response.create does concern the pending backend response.
  const create = protocol.encodeOutgoing({ type: 'response.create' })
  const createError = protocol.normalizeIncoming({
    type: 'error', error: { code: 'invalid_request_error', message: 'pending results', client_event_id: create.event_id },
  })
  assert.equal(createError.response_id, undefined)
  // Errors without a client event id pass through untouched.
  assert.equal(protocol.normalizeIncoming({ type: 'error', error: { message: 'x' } }).response_id, undefined)
})

test('GPT-Live 1 trace records both directions without audio payloads', () => {
  const lines = []
  const protocol = createGptLive1Protocol({ trace: line => lines.push(line) })
  protocol.connectionMessages({ session: { model: 'gpt-live-1' } })
  protocol.encodeOutgoing({ type: 'session.input_audio.append', audio: 'A'.repeat(4000) })
  protocol.encodeOutgoing({ type: 'response.create' })
  protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: 'B'.repeat(4000), start_ms: 0, end_ms: 100 })
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: 'hi', start_ms: 0, end_ms: 100 })
  assert.deepEqual(lines.map(line => line.split(' ')[1] + ' ' + JSON.parse(line.slice(line.indexOf('{'))).type), [
    '>> session.start',
    '>> response.create',
    '<< session.input_transcript.delta',
  ], 'audio appends and audio deltas are not traced; other events are')
  assert.ok(lines.every(line => !line.includes('A'.repeat(50)) && !line.includes('B'.repeat(50))))
})

test('GPT-Live 1 trace replaces conversation content by its length and caps service messages', () => {
  const lines = []
  const protocol = createGptLive1Protocol({ trace: line => lines.push(line) })
  protocol.connectionMessages({
    session: {
      model: 'gpt-live-1',
      instructions: 'persona secret',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'earlier turn' }] }],
      delegation: { type: 'responses', responses: { model: 'backend', instructions: 'backend secret' } },
    },
  })
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 'sess_1' } })
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: 'hi', start_ms: 0, end_ms: 100 })
  protocol.normalizeIncoming({
    type: 'response.event',
    event: { type: 'response.output_item.done', item: { type: 'function_call', name: 'get_weather', call_id: 'call_1', arguments: '{"city":"Shanghai"}' } },
  })
  protocol.encodeOutgoing({ type: 'response.item.create', item: { type: 'function_call_output', call_id: 'call_1', output: 'sunny in Shanghai' } })
  protocol.normalizeIncoming({ type: 'error', error: { code: 'invalid_value', message: 'M'.repeat(300) } })
  const joined = lines.join('')
  for (const content of ['persona secret', 'earlier turn', 'backend secret', '"delta":"hi"', 'Shanghai', 'sunny']) {
    assert.ok(!joined.includes(content), `trace must not carry ${content}`)
  }
  assert.ok(joined.includes('get_weather') && joined.includes('call_1') && joined.includes('sess_1'), 'ids and names stay')
  assert.ok(joined.includes(`${'M'.repeat(200)}…<300 chars>`) && !joined.includes('M'.repeat(201)), 'messages are capped')
})

test('GPT-Live 1 fits a tool result into a byte budget by cutting its longest string first', () => {
  const item = {
    type: 'function_call_output',
    call_id: 'call_1',
    output: JSON.stringify({ status: 'ok', url: 'https://example.test/weather', content: '天气'.repeat(6000) }),
  }
  const fitted = fitBackendItem(item, 4096)
  assert.ok(utf8Bytes(fitted) <= 4096, `${utf8Bytes(fitted)} bytes`)
  assert.equal(fitted.call_id, 'call_1')
  const output = JSON.parse(fitted.output)
  assert.equal(output.status, 'ok', 'the envelope survives; only the bulk string is cut')
  assert.equal(output.url, 'https://example.test/weather')
  assert.match(output.content, /^[天气]+…\[truncated; \d+ bytes in full\]$/, 'cut at a code-point boundary, marked once')

  assert.equal(fitBackendItem(item, 1 << 20), item, 'an item that fits is passed through untouched')

  const text = fitBackendItem({ type: 'function_call_output', call_id: 'c', output: '汉'.repeat(1000) }, 300)
  assert.ok(utf8Bytes(text) <= 300)
  assert.match(text.output, /^汉+…\[truncated; 3000 bytes in full\]$/, 'plain text is cut at a code-point boundary')

  const message = fitBackendItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(5000) }] }, 1000)
  assert.ok(utf8Bytes(message) <= 1000)
  assert.equal(message.content[0].type, 'input_text')

  assert.equal(fitBackendItem({ type: 'function_call_output', call_id: 'c', output: '{}' }, 10), null, 'nothing left to cut')
})

test('GPT-Live 1 shares the session backend input budget across tool results', () => {
  const emitted = []
  const protocol = createGptLive1Protocol({ emit: event => emitted.push(event), backendInputMaxBytes: 8192 })
  const big = () => protocol.functionOutputItem('call_x', { content: 'x'.repeat(20000) })
  const sizes = []
  for (let index = 0; index < 4; index++) {
    sizes.push(utf8Bytes(protocol.encodeOutgoing(protocol.conversationItemCreate(big())).item))
  }
  // Each result takes at most half of what is left, so they shrink and the
  // total stays under the cap with the reserve untouched.
  assert.ok(sizes[0] > sizes[1] && sizes[1] > sizes[2], sizes.join(','))
  assert.ok(sizes.reduce((sum, bytes) => sum + bytes, 0) <= 8192 - 1024 + 256, sizes.join(','))
  // With the budget spent a pending call still gets an answer: a stub.
  const stub = protocol.encodeOutgoing(protocol.conversationItemCreate(big())).item
  assert.equal(JSON.parse(stub.output).error_code, 'tool_result_too_large')
  assert.equal(stub.call_id, 'call_x')
  // Typed text is dropped instead, and the user is told the session is full.
  assert.equal(protocol.conversationItemCreate(protocol.userTextItem('记住我喝美式')), null)
  return new Promise(resolve => setImmediate(resolve)).then(() => {
    assert.equal(emitted.at(-1)?.error?.code, 'backend_input_budget_exhausted')
  })
})

test('GPT-Live 1 answers a rejected tool result again, smaller, and re-requests the response', async () => {
  const sent = []
  const protocol = createGptLive1Protocol({ send: payload => sent.push(payload) })
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  const item = protocol.encodeOutgoing(protocol.conversationItemCreate(
    protocol.functionOutputItem('call_1', { content: 'y'.repeat(30000) }),
  ))
  const create = protocol.encodeOutgoing({ type: 'response.create' })
  const rejected = protocol.normalizeIncoming({
    type: 'error',
    error: {
      type: 'invalid_request_error', code: 'response_input_buffer_full', param: 'item',
      message: 'Backend response input history is limited to 128 items and 32768 UTF-8 bytes per session.',
      client_event_id: item.event_id,
    },
  })
  assert.deepEqual(rejected, [], 'the rejection is handled, not surfaced')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(sent.map(payload => payload.type), ['response.item.create', 'response.create'])
  assert.equal(sent[0].item.call_id, 'call_1')
  assert.ok(utf8Bytes(sent[0].item) <= Math.floor(utf8Bytes(item.item) / 2), 'the retry backs off from the rejected size')
  assert.equal(JSON.parse(sent[0].item.output).content.slice(0, 3), 'yyy', 'the retry is the same result, cut shorter')
  // The superseded response.create fails on the service with "outputs
  // required"; that error is expected and swallowed. Any other passes through.
  assert.deepEqual(protocol.normalizeIncoming({
    type: 'error',
    error: { code: 'function_call_outputs_required', message: 'Submit the pending function call outputs before response.create.', client_event_id: create.event_id },
  }), [])
  const other = protocol.normalizeIncoming({
    type: 'error',
    error: { code: 'function_call_outputs_required', message: 'Submit the pending function call outputs before response.create.', client_event_id: 'event_other' },
  })
  assert.equal(other.type, 'error')
})

test('GPT-Live 1 learns the backend input limit from the service and reports exhaustion', () => {
  const protocol = createGptLive1Protocol()
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  const item = protocol.encodeOutgoing(protocol.conversationItemCreate(
    protocol.functionOutputItem('call_1', { content: 'z'.repeat(9000) }),
  ))
  // Without a send hook nothing can be re-sent: the error reaches the user with guidance.
  const error = protocol.normalizeIncoming({
    type: 'error',
    error: {
      code: 'response_input_buffer_full', client_event_id: item.event_id,
      message: 'Backend response input history is limited to 4 items and 4000 UTF-8 bytes per session.',
    },
  })
  assert.equal(error.type, 'error')
  assert.match(error.error.message, /重新连接/)
  // The cap the service stated governs the next result.
  const next = protocol.encodeOutgoing(protocol.conversationItemCreate(
    protocol.functionOutputItem('call_2', { content: 'z'.repeat(9000) }),
  ))
  assert.ok(utf8Bytes(next.item) <= 4000 - 1024, `${utf8Bytes(next.item)} bytes`)
})

test('GPT-Live 1 opens a continued backend response that resumes with in_progress', () => {
  const protocol = createGptLive1Protocol()
  const envelope = event => ({ type: 'response.event', delegation_id: 'item_d', event })
  assert.equal(protocol.normalizeIncoming(envelope({ type: 'response.created', response: { id: 'resp_c' } }))[0].type, 'response.created')
  assert.deepEqual(protocol.normalizeIncoming(envelope({ type: 'response.in_progress', response: { id: 'resp_c' } })), [],
    'in_progress after created adds nothing')
  protocol.normalizeIncoming(envelope({ type: 'response.completed', response: { id: 'resp_c', status: 'completed' } }))
  // After tool results the same response resumes without a created event.
  assert.deepEqual(protocol.normalizeIncoming(envelope({ type: 'response.in_progress', response: { id: 'resp_c' } })), [{
    type: 'response.created', response: { id: 'resp_c', status: 'in_progress' }, response_id: 'resp_c',
  }])
})

test('GPT-Live 1 seeds session.input within the documented token budget', () => {
  const history = sessionInputHistory([
    { role: 'user', content: '早'.repeat(5000) },
    { role: 'assistant', content: '好'.repeat(5000) },
    { role: 'user', content: '再见' },
  ])
  // A CJK character is about one token; 5,000 + 5,000 would exceed the budget,
  // so only the most recent two messages are seeded.
  assert.deepEqual(history.map(message => message.content[0].text.length), [5000, 2])
})

test('GPT-Live 1 releases a failed backend response so Gateway requests are not gated forever', async () => {
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {} })
  const feed = raw => {
    for (const event of frontend.protocol.normalizeIncoming(raw)) frontend.handleLifecycle(event)
  }
  feed({ type: 'session.output_audio.delta', delta: 'AAAA', start_ms: 0, end_ms: 100 })
  feed({ type: 'response.event', delegation_id: 'item_f', event: { type: 'response.created', response: { id: 'resp_f' } } })
  assert.equal(frontend.gatingResponsesActive(), true, 'a voice segment and a backend response are open')
  const failed = frontend.protocol.normalizeIncoming({
    type: 'response.event', delegation_id: 'item_f',
    event: { type: 'response.failed', response: { id: 'resp_f', error: { message: 'quota' } } },
  })
  assert.equal(failed[0].type, 'error')
  assert.equal(failed[0].response_id, 'resp_f', 'the failure names the response it ends')
  for (const event of failed) frontend.handleLifecycle(event)
  assert.equal(frontend.activeResponses.has('resp_f'), false)
  assert.equal(frontend.gatingResponsesActive(), false, 'only the playback response remains')
  await frontend.whenIdle()
  frontend.close()
})

test('GPT-Live 1 drops the tail of an interrupted answer instead of starting the next answer with it', () => {
  const types = events => events.map(event => event.type)
  const protocol = createGptLive1Protocol()
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 'sess_1' } })
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '天气', start_ms: 1000, end_ms: 1400 })
  for (const [start, end, delta] of [[3000, 3200, '晴'], [3200, 3400, '没'], [3400, 3600, '有']]) {
    protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta, start_ms: start, end_ms: end })
  }
  // The user barges in at 3600; the model needs 600 ms more to yield.
  const barge = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '哦你', start_ms: 3600, end_ms: 3800 })
  assert.equal(barge.find(event => event.type === 'response.done').response.status, 'cancelled')
  assert.ok(types(barge).includes('input_audio_buffer.speech_started'))
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '能', start_ms: 3800, end_ms: 4000 })
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '下', start_ms: 3800, end_ms: 4000 }), [],
    'the tail overlapping the user is dropped, not shown as the next answer')
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '说', start_ms: 4000, end_ms: 4200 })
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '雨', start_ms: 4000, end_ms: 4200 }), [])
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: 'AAAA', start_ms: 4200, end_ms: 4400 }), [],
    'timed tail audio is dropped too')
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '日期吗', start_ms: 4200, end_ms: 5400 })
  // The real answer begins after the user finished: a fresh voice response.
  const answer = protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '好', start_ms: 6000, end_ms: 6200 })
  assert.deepEqual(types(answer), [
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.committed',
    'response.created',
    'response.output_audio_transcript.delta',
  ])
  assert.equal(answer.at(-1).delta, '好')
  // Once the model yielded, output is never judged as tail again.
  assert.deepEqual(types(protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '的', start_ms: 6200, end_ms: 6400 })),
    ['response.output_audio_transcript.delta'])
})

test('GPT-Live 1 grows the question caption from late fragments without starting a turn', () => {
  const protocol = createGptLive1Protocol()
  const types = events => events.map(event => event.type)
  const first = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '查', start_ms: 600, end_ms: 800 })
  assert.deepEqual(types(first), ['input_audio_buffer.speech_started', 'conversation.item.input_audio_transcription.delta'])
  const itemId = first[0].item_id
  // The answer begins as audio without timing, as on the OpenAI primary WebSocket.
  assert.ok(types(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: 'AAAA' })).includes('response.created'))
  // The output transcript carries the time the answer began.
  protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '好', start_ms: 1800, end_ms: 2000 })
  assert.deepEqual(types(protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' })),
    ['conversation.item.input_audio_transcription.completed'])
  // A late fragment continuing the question's timeline reopens it: caption only.
  const late = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '天气', start_ms: 800, end_ms: 1000 })
  assert.deepEqual(types(late), ['conversation.item.input_audio_transcription.delta'])
  assert.equal(late[0].item_id, itemId)
  assert.equal(late[0].text, '查天气')
  assert.deepEqual(protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' }), [], 'not completed twice')
  // Speech that began after the answer began is a barge-in: a new turn, playback cancelled.
  const barge = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '等', start_ms: 3500, end_ms: 3700 })
  assert.deepEqual(types(barge), ['response.output_audio_transcript.done', 'response.done', 'input_audio_buffer.speech_started', 'conversation.item.input_audio_transcription.delta'])
  assert.equal(barge[0].transcript, '好', 'what was said before the cut is recorded')
  assert.equal(barge[1].response.status, 'cancelled')
  assert.notEqual(barge[2].item_id, itemId)
})

test('GPT-Live 1 falls back to arrival order for turns when the transport sends no output timing', () => {
  const protocol = createGptLive1Protocol()
  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: 'hi', start_ms: 0, end_ms: 200 })
  protocol.normalizeIncoming({ type: 'gpt-live-1.input_idle' })
  // A pause before any answer continues the same turn.
  const more = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: ' there', start_ms: 2000, end_ms: 2200 })
  assert.deepEqual(more.map(event => event.type), ['conversation.item.input_audio_transcription.delta'])
  assert.equal(more[0].text, 'hi there')
  protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: 'AAAA' })
  // Once an answer began, a later pause-separated fragment is a new turn.
  const next = protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 5000, end_ms: 5200 })
  assert.deepEqual(next.map(event => event.type).slice(0, 2), ['response.done', 'input_audio_buffer.speech_started'])
})

test('GPT-Live 1 settles a speak request on the commentary acknowledgement', () => {
  const protocol = createGptLive1Protocol()
  const append = protocol.encodeOutgoing(protocol.responseCreate({ __liveSay: '晚饭好了' }))
  assert.equal(append.type, 'session.commentary.append')
  const acked = protocol.normalizeIncoming({ type: 'session.commentary.appended', client_event_id: append.event_id })
  assert.deepEqual(acked.map(event => event.type), ['response.created', 'response.done'])
  assert.equal(acked[0].__voicePlayback, true, 'a playback response: it never gates Gateway work')
  assert.equal(acked[1].response.id, acked[0].response.id)
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.commentary.appended', client_event_id: 'event_unknown' }), [])
  // A rejected commentary fails its own request, not the running backend response.
  const second = protocol.encodeOutgoing(protocol.responseCreate({ __liveSay: 'x' }))
  const rejected = protocol.normalizeIncoming({
    type: 'error', error: { code: 'invalid_request_error', message: 'too long', client_event_id: second.event_id },
  })
  assert.deepEqual(rejected.map(event => event.type), ['response.created', 'error'])
  assert.equal(rejected[1].response_id, rejected[0].response.id)
})

test('GPT-Live 1 keeps the Gateway message rules in the backend prompt, not in per-injection items', t => {
  const session = gptLive1Provider.buildSession({ agentContext: {}, sessionOptions: {} })
  const instructions = session.delegation.responses.instructions
  assert.match(instructions, /## Gateway messages/)
  assert.ok(instructions.includes(permissionResponseInstructions))
  assert.ok(instructions.includes(resultResponseInstructions))
  assert.deepEqual(gptLive1Provider.buildResultInjection('done').response, {})
  assert.deepEqual(gptLive1Provider.buildPermissionInjection({ id: 'p1', taskId: 't1', summary: 'read a file' }).response, {})
  const protocol = gptLive1Provider.createProtocol({})
  assert.equal(protocol.responseInstructionsItem({ instructions: resultResponseInstructions }), null)
  assert.equal(protocol.responseInstructionsItem({ instructions: progressResponseInstructions }), null)
  assert.equal(protocol.responseInstructionsItem({ instructions: '只读第一条工具结果' })?.type, 'message',
    'other per-response instructions still travel as items')
  // A custom backend prompt replaces the frame only; the task instructions stay.
  withEnv(t, { GPT_LIVE_1_DELEGATION_INSTRUCTIONS: 'Custom frame.' })
  const custom = gptLive1Provider.buildSession({ agentContext: {}, sessionOptions: {} }).delegation.responses.instructions
  assert.ok(custom.startsWith('Custom frame.'))
  assert.match(custom, /## Task instructions/)
  assert.match(custom, /## Gateway messages/)
})

test('GPT-Live 1 omits the seeded history once after the service rejected it at startup', () => {
  const recentMessages = [{ role: 'user', content: '早' }, { role: 'assistant', content: '好' }]
  const build = messages => gptLive1Provider.buildSession({ agentContext: { recentMessages: messages }, sessionOptions: {} })
  const protocol = gptLive1Provider.createProtocol({})
  protocol.connectionMessages({ session: build(recentMessages) })
  assert.equal(build(recentMessages).input.length, 2)
  protocol.normalizeIncoming({
    type: 'error',
    error: { type: 'invalid_request_error', code: 'invalid_value', param: 'input', message: 'input exceeds 8192 tokens', client_event_id: 'event_start' },
  })
  // Another connection in the same process seeds its own history untouched.
  assert.equal(build([{ role: 'user', content: '午安' }]).input.length, 1)
  assert.equal(build(recentMessages).input, undefined, 'the retry connects without the history the service refused')
  assert.equal(build(recentMessages).input.length, 2, 'later connects seed it again')
})

test('GPT-Live 1 classifies capacity limits and safety closures', () => {
  assert.equal(gptLive1Provider.classifyError('Unexpected server response: 429'), 'capacity_busy')
  assert.equal(gptLive1Provider.classifyError('Too many concurrent sessions for this tier'), 'capacity_busy')
  const protocol = createGptLive1Protocol()
  const closed = protocol.normalizeIncoming({ type: 'session.closed', reason: 'content', usage: { seconds: 10 } })
  assert.equal(closed.at(-1).type, 'error')
  assert.equal(gptLive1Provider.classifyError(closed.at(-1).error.message), 'content_safety')
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.closed', reason: 'expired' }), [])
})

test('GPT-Live 1 user speech cancels playback only; backend work and its tool calls survive', () => {
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {} })
  const feed = raw => {
    for (const event of frontend.protocol.normalizeIncoming(raw)) frontend.handleLifecycle(event)
  }
  feed({ type: 'session.output_audio.delta', delta: 'AAAA', start_ms: 0, end_ms: 100 })
  feed({ type: 'response.event', delegation_id: 'item_c', event: { type: 'response.created', response: { id: 'resp_c' } } })
  const waiter = { origin: 'agent', context: {}, settled: false, resolve: () => {}, timer: null }
  frontend.responseWaiters.set('resp_c', waiter)
  const generation = frontend.responseQueueGeneration
  frontend.cancel()
  assert.equal(frontend.activeResponses.has('resp_c'), true, 'the backend response keeps running')
  assert.equal(frontend.responseWaiters.get('resp_c'), waiter, 'the request waiting on it is not settled')
  assert.equal(waiter.settled, false)
  assert.equal(frontend.responseQueueGeneration, generation, 'queued Gateway work is not dropped')
  frontend.close()

  // Tool calls of a full-duplex frontend are never superseded by a new user turn.
  const fullDuplex = new ToolCallHandler({
    getFrontend: () => ({ capabilities: { concurrentVoicePlayback: true } }),
    getTurnId: () => 'turn_2', getTurnGeneration: () => 2,
  })
  assert.equal(fullDuplex.isStale('turn_1', 1), false)
  const halfDuplex = new ToolCallHandler({
    getFrontend: () => ({ capabilities: {} }),
    getTurnId: () => 'turn_2', getTurnGeneration: () => 2,
  })
  assert.equal(halfDuplex.isStale('turn_1', 1), true, 'other providers keep the turn gate')
})

test('GPT-Live 1 encodes assistant history for the backend as output_text', () => {
  const protocol = createGptLive1Protocol()
  const item = protocol.conversationItemCreate({ type: 'message', role: 'assistant', content: [{ type: 'text', text: '好的' }] })
  assert.deepEqual(item.item.content, [{ type: 'output_text', text: '好的' }])
})

function keepaliveHarness(t, { refuse = false } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let clock = 0
  const sent = []
  const protocol = createGptLive1Protocol({
    send: (payload, options) => {
      sent.push({ payload, options })
      // The runtime's send returns the encoded body, or undefined once the socket is gone.
      return refuse ? undefined : payload
    },
    now: () => clock,
    inputKeepaliveMs: 100,
    inputKeepaliveGapMs: 500,
    outputIdleMs: 0,
  })
  const advance = ms => {
    for (let step = 0; step < ms; step += 100) {
      clock += 100
      t.mock.timers.tick(100)
    }
  }
  const silenceMs = () => sent
    .filter(entry => entry.payload.type === 'session.input_audio.append')
    .map(entry => Buffer.from(entry.payload.audio, 'base64').length / 2 / 24)
  return { protocol, sent, advance, silenceMs, setClock: value => { clock = value } }
}

test('GPT-Live 1 keeps the session timeline moving with real-time silence when no audio is sent', t => {
  const { protocol, sent, advance, silenceMs } = keepaliveHarness(t)
  advance(300)
  assert.deepEqual(sent, [], 'nothing before session.started')
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  advance(1000)
  assert.equal(silenceMs().length, 10)
  assert.equal(silenceMs().reduce((sum, ms) => sum + ms, 0), 1000, 'silence matches elapsed wall-clock time')
  assert.ok(silenceMs().every(ms => ms === 100))
  assert.ok(sent.every(entry => entry.options?.audio === true), 'sent under the audio backpressure budget')
  assert.ok(Buffer.from(sent[0].payload.audio, 'base64').every(byte => byte === 0), 'PCM16 zeros')
})

test('GPT-Live 1 appends no silence while real input audio flows, and fills only the gap after it stops', t => {
  const { protocol, sent, advance, silenceMs } = keepaliveHarness(t)
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  for (let i = 0; i < 10; i += 1) {
    protocol.encodeOutgoing(protocol.audioAppend('AAAA'))
    advance(100)
  }
  assert.deepEqual(silenceMs(), [], 'a streaming microphone is never padded')
  advance(300)
  assert.deepEqual(silenceMs(), [], 'nothing inside the gap')
  advance(100)
  assert.deepEqual(silenceMs(), [500], 'the first fill covers the time since the last real audio')
  advance(100)
  assert.deepEqual(silenceMs(), [500, 100])
  assert.equal(sent.length, 2)
})

test('GPT-Live 1 stops the silence keepalive on session.closed and on a failed send', t => {
  const closed = keepaliveHarness(t)
  closed.protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  closed.advance(200)
  closed.protocol.normalizeIncoming({ type: 'session.closed', reason: 'client' })
  closed.advance(1000)
  assert.equal(closed.silenceMs().length, 2)

  t.mock.timers.reset()
  const failed = keepaliveHarness(t, { refuse: true })
  failed.protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  failed.advance(1000)
  assert.equal(failed.silenceMs().length, 1, 'the socket is gone after the first refused append')
})

function pcmFrame({ amplitude = 0, ms = 100 } = {}) {
  const samples = 24 * ms
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(amplitude * Math.sin(i / 8)), i * 2)
  return pcm.toString('base64')
}

test('GPT-Live 1 does not play the silent output stream between answers, and keeps a soft onset', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const protocol = createGptLive1Protocol({ emit: () => {}, outputIdleMs: 800 })
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  const silence = pcmFrame()
  const onset = pcmFrame({ amplitude: 60 })
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: silence }), [], 'idle silence is dropped')
  }
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: onset }), [], 'a sub-threshold onset is held, not played')
  const speech = pcmFrame({ amplitude: 3000 })
  const events = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: speech })
  assert.deepEqual(events.map(event => event.type), ['response.created', 'response.output_audio.delta', 'response.output_audio.delta'])
  assert.equal(events[1].delta, onset, 'the held frame plays first')
  assert.equal(events[2].delta, speech)
})

test('GPT-Live 1 closes a spoken segment one idle window after the last spoken frame despite continuous silence', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const emitted = []
  let protocol = null
  protocol = createGptLive1Protocol({ emit: event => emitted.push(...[].concat(protocol.normalizeIncoming(event))), outputIdleMs: 800 })
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  const opened = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: pcmFrame({ amplitude: 3000 }) })
  const responseId = opened[0].response_id
  const pauses = []
  for (let i = 0; i < 7; i += 1) {
    pauses.push(...protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: pcmFrame() }))
    t.mock.timers.tick(100)
  }
  assert.equal(pauses.length, 7, 'a pause inside speech is still played')
  assert.ok(pauses.every(event => event.type === 'response.output_audio.delta' && event.response_id === responseId))
  assert.deepEqual(emitted, [])
  t.mock.timers.tick(100)
  assert.deepEqual(emitted.map(event => event.type), ['response.done'], 'silence does not hold the segment open')
  assert.equal(emitted[0].response_id, responseId)
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: pcmFrame() }), [], 'trailing silence is dropped')
})

test('GPT-Live 1 finalizes the spoken transcript when a segment closes, so the assistant turn reaches history', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const emitted = []
  let protocol = null
  protocol = createGptLive1Protocol({ emit: event => emitted.push(...[].concat(protocol.normalizeIncoming(event))), outputIdleMs: 800 })
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  const opened = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: pcmFrame({ amplitude: 3000 }) })
  protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '明天', start_ms: 0, end_ms: 200 })
  protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '有雨。', start_ms: 200, end_ms: 400 })
  t.mock.timers.tick(800)
  assert.deepEqual(emitted, [
    { type: 'response.output_audio_transcript.done', response_id: opened[0].response_id, transcript: '明天有雨。' },
    { type: 'response.done', response: { id: opened[0].response_id, status: 'completed' }, response_id: opened[0].response_id, __voicePlayback: true },
  ])
  protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: pcmFrame({ amplitude: 3000 }) })
  emitted.length = 0
  t.mock.timers.tick(800)
  assert.deepEqual(emitted.map(event => event.type), ['response.done'], 'the next segment starts with an empty transcript')
})

function segmentHarness(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 0
  const emitted = []
  let protocol = null
  protocol = createGptLive1Protocol({
    emit: event => emitted.push(...[].concat(protocol.normalizeIncoming(event))),
    outputIdleMs: 800,
    voiceOwedMs: 4000,
    now: () => clock,
    ...options,
  })
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  const wait = ms => {
    for (let step = 0; step < ms; step += 100) {
      clock += 100
      t.mock.timers.tick(100)
    }
  }
  const frames = (amplitude, count) => {
    const out = []
    for (let i = 0; i < count; i += 1) {
      out.push(...protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: pcmFrame({ amplitude }) }))
      wait(100)
    }
    return out
  }
  const backend = nested => protocol.normalizeIncoming({ type: 'response.event', delegation_id: 'del_1', event: nested })
  const doneIds = () => emitted.filter(event => event.type === 'response.done' && event.__voicePlayback).map(event => event.response_id)
  return { protocol, emitted, wait, frames, backend, doneIds }
}

test('GPT-Live 1 keeps a filler, the tool wait and the spoken result in one response', t => {
  const { protocol, frames, backend, wait, doneIds } = segmentHarness(t)
  protocol.encodeOutgoing({ type: 'response.create' })
  const filler = frames(3000, 5)
  const voiceId = filler[0].response_id
  backend({ type: 'response.created', response: { id: 'resp_1' } })
  frames(0, 20)
  backend({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{}' } })
  backend({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } })
  frames(0, 50)
  assert.deepEqual(doneIds(), [], 'held while the tool result is outstanding, longer than the owed window')
  protocol.encodeOutgoing(protocol.conversationItemCreate(protocol.functionOutputItem('call_1', { ok: true })))
  protocol.encodeOutgoing({ type: 'response.create' })
  backend({ type: 'response.created', response: { id: 'resp_2' } })
  backend({ type: 'response.completed', response: { id: 'resp_2', status: 'completed' } })
  frames(0, 5)
  assert.deepEqual(doneIds(), [], 'held until the voice layer speaks the result')
  const answer = frames(3000, 10)
  assert.ok(answer.every(event => event.response_id === voiceId), 'the result continues the same response')
  wait(900)
  assert.deepEqual(doneIds(), [voiceId], 'closed once, after the result was spoken')
})

test('GPT-Live 1 closes a held segment when the owed result is never spoken', t => {
  const { protocol, frames, backend, wait, doneIds } = segmentHarness(t)
  protocol.encodeOutgoing({ type: 'response.create' })
  const filler = frames(3000, 3)
  backend({ type: 'response.created', response: { id: 'resp_1' } })
  backend({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } })
  wait(3000)
  assert.deepEqual(doneIds(), [])
  wait(1700)
  assert.deepEqual(doneIds(), [filler[0].response_id])
})

async function until(predicate, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

// A GPT-Live 1 service stand-in: answers session.start and records each
// connection's messages and whether it closed.
async function liveMockServer(t, onMessage = () => {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  const connections = []
  server.on('connection', socket => {
    const connection = { socket, received: [], closed: false }
    connections.push(connection)
    socket.on('close', () => { connection.closed = true })
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      connection.received.push(message)
      if (message.type === 'session.start') {
        socket.send(JSON.stringify({ type: 'session.started', session: { id: `sess_${connections.length}` } }))
      }
      onMessage(message, connection)
    })
  })
  withConfig(t, {
    gptLive1ApiKey: 'live-test',
    gptLive1Model: 'gpt-live-1',
    gptLive1RealtimeUrl: `ws://127.0.0.1:${server.address().port}/v1/live/sessions`,
  })
  t.after(async () => {
    for (const connection of connections) connection.socket.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  return { connections }
}

test('GPT-Live 1 idle close is off by default and floored when enabled', t => {
  withEnv(t, { GPT_LIVE_1_IDLE_CLOSE_MS: undefined })
  assert.equal(gptLive1Provider.idleCloseMs(), 0)
  for (const [value, expected] of [['0', 0], ['-1', 0], ['off', 0], ['3000', 10000], ['30000', 30000], ['30000.7', 30000]]) {
    process.env.GPT_LIVE_1_IDLE_CLOSE_MS = value
    assert.equal(gptLive1Provider.idleCloseMs(), expected, value)
  }
  assert.throws(() => validateRealtimeProvider({ ...gptLive1Provider, idleCloseMs: 30000 }), /idleCloseMs/)
})

test('GPT-Live 1 stops the silence keepalive as soon as the client closes the session', t => {
  const { protocol, advance, silenceMs } = keepaliveHarness(t)
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  advance(200)
  assert.equal(silenceMs().length, 2)
  assert.deepEqual(protocol.sessionClose(), { type: 'session.close' })
  advance(1000)
  assert.equal(silenceMs().length, 2, 'no silence after session.close')
})

test('GPT-Live 1 swallows two refused silence appends, reports the third once and stops the keepalive', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let clock = 0
  const appended = []
  let protocol = null
  protocol = createGptLive1Protocol({
    // Encoded as the runtime does, so each append carries its own event_id.
    send: payload => {
      const encoded = protocol.encodeOutgoing(payload)
      appended.push(encoded)
      return encoded
    },
    now: () => clock,
    inputKeepaliveMs: 100,
    inputKeepaliveGapMs: 500,
    outputIdleMs: 0,
  })
  const advance = ms => {
    for (let step = 0; step < ms; step += 100) {
      clock += 100
      t.mock.timers.tick(100)
    }
  }
  const refuse = append => protocol.normalizeIncoming({
    type: 'error',
    error: { type: 'invalid_request_error', code: 'invalid_audio', message: 'Invalid audio', client_event_id: append.event_id },
  })
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  advance(300)
  assert.equal(appended.length, 3)
  assert.deepEqual(refuse(appended[0]), [], 'a refused silence append does not fail the turn')
  assert.deepEqual(refuse(appended[1]), [])
  const reported = refuse(appended[2])
  assert.equal(reported.type, 'error')
  assert.equal(reported.error.code, 'invalid_audio')
  advance(1000)
  assert.equal(appended.length, 3, 'the keepalive stopped after reporting')
  const unrelated = protocol.normalizeIncoming({ type: 'error', error: { code: 'unknown_field', message: 'x', client_event_id: 'event_other' } })
  assert.equal(unrelated.type, 'error', 'other command errors still pass through')
})

test('GPT-Live 1 protocol is quiescent only with nothing in flight on either layer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 0
  let protocol = null
  protocol = createGptLive1Protocol({
    emit: event => protocol.normalizeIncoming(event),
    outputIdleMs: 800,
    inputIdleMs: 1500,
    voiceOwedMs: 4000,
    now: () => clock,
  })
  const backend = (delegationId, nested) => protocol.normalizeIncoming({
    type: 'response.event', delegation_id: delegationId, event: nested,
  })
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  assert.equal(protocol.isQuiescent(), true)

  protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: pcmFrame({ amplitude: 3000 }) })
  assert.equal(protocol.isQuiescent(), false, 'a spoken segment is open')
  t.mock.timers.tick(800)
  assert.equal(protocol.isQuiescent(), true, 'the segment closed on idle')

  protocol.normalizeIncoming({ type: 'session.input_transcript.delta', delta: '你好', start_ms: 5000, end_ms: 5400 })
  assert.equal(protocol.isQuiescent(), false, 'a user utterance is open')
  t.mock.timers.tick(1500)
  assert.equal(protocol.isQuiescent(), true, 'the utterance completed on idle')

  protocol.normalizeIncoming({ type: 'session.delegation.created', delegation: { id: 'del_1', response_id: 'resp_1' } })
  assert.equal(protocol.isQuiescent(), false, 'a delegation is running')
  backend('del_1', { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } })
  assert.equal(protocol.isQuiescent(), false, 'the voice layer still owes the result')
  clock += 4000
  assert.equal(protocol.isQuiescent(), true, 'the owed window passed')

  protocol.encodeOutgoing({ type: 'response.create' })
  assert.equal(protocol.isQuiescent(), false, 'a backend response was requested')
  backend('del_2', { type: 'response.created', response: { id: 'resp_2' } })
  assert.equal(protocol.isQuiescent(), false, 'a nested backend response is running')
  backend('del_2', { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{}' } })
  backend('del_2', { type: 'response.completed', response: { id: 'resp_2', status: 'completed' } })
  clock += 4000
  assert.equal(protocol.isQuiescent(), false, 'a tool result is outstanding')
  protocol.encodeOutgoing(protocol.conversationItemCreate(protocol.functionOutputItem('call_1', { ok: true })))
  assert.equal(protocol.isQuiescent(), true, 'the tool result was returned')

  const say = protocol.encodeOutgoing(protocol.responseCreate({ __liveSay: '晚饭好了' }))
  assert.equal(protocol.isQuiescent(), false, 'a speak request awaits its acknowledgement')
  protocol.normalizeIncoming({ type: 'session.commentary.appended', client_event_id: say.event_id })
  assert.equal(protocol.isQuiescent(), true)

  protocol.encodeOutgoing(protocol.conversationItemCreate({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'context' }] }))
  assert.equal(protocol.isQuiescent(), true, 'a context-only item leaves nothing in flight')
})

test('GPT-Live 1 frontend counts commands and events as activity, not the idle output stream or keepalive', { timeout: 10000 }, async t => {
  withEnv(t, { GPT_LIVE_1_OUTPUT_IDLE_MS: '40' })
  const { connections } = await liveMockServer(t)
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {}, onEvent: () => {}, responseStartTimeoutMs: 1000 })
  t.after(() => frontend.close())
  await frontend.connect()
  const settledAt = frontend.lastActivityAt
  const { socket } = connections[0]
  for (let elapsed = 0; elapsed < 300; elapsed += 20) {
    socket.send(JSON.stringify({ type: 'session.usage.updated', usage: {} }))
    socket.send(JSON.stringify({ type: 'session.output_audio.delta', delta: pcmFrame({ ms: 20 }) }))
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(connections[0].received.some(message => message.type === 'session.input_audio.append'), 'the keepalive ran meanwhile')
  assert.equal(frontend.lastActivityAt, settledAt, 'silence, usage and keepalive are not activity')
  frontend.appendAudio(pcmFrame({ ms: 20 }))
  assert.ok(frontend.lastActivityAt > settledAt, 'microphone audio is, even when quiet')
  const audioAt = frontend.lastActivityAt
  await new Promise(resolve => setTimeout(resolve, 2))
  frontend.setInputMuted(true)
  assert.ok(frontend.lastActivityAt > audioAt, 'a command is')
  const commandAt = frontend.lastActivityAt
  socket.send(JSON.stringify({ type: 'session.output_audio.delta', delta: pcmFrame({ amplitude: 3000 }) }))
  await until(() => frontend.lastActivityAt > commandAt)
})

test('GPT-Live 1 frontend is not quiescent while a text request is queued or its answer is still spoken', { timeout: 10000 }, async t => {
  withEnv(t, { GPT_LIVE_1_OUTPUT_IDLE_MS: '40' })
  await liveMockServer(t, (message, { socket }) => {
    if (message.type !== 'response.create') return
    const send = event => socket.send(JSON.stringify(event))
    send({ type: 'response.event', delegation_id: 'del_1', event: { type: 'response.created', response: { id: 'resp_1' } } })
    send({ type: 'response.event', delegation_id: 'del_1', event: { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } } })
    send({ type: 'session.output_audio.delta', delta: pcmFrame() })
    send({ type: 'session.output_audio.delta', delta: pcmFrame({ amplitude: 3000 }) })
  })
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {}, onEvent: () => {}, responseStartTimeoutMs: 2000 })
  t.after(() => frontend.close())
  await frontend.connect()
  assert.equal(frontend.isQuiescent(), true)
  const outcome = frontend.sendUserText('明天会下雨吗')
  assert.equal(frontend.isQuiescent(), false, 'queued')
  assert.equal((await outcome).completed, true)
  await until(() => frontend.isQuiescent())
  frontend.close()
  assert.equal(frontend.isQuiescent(), false, 'a closed frontend is not ready')
})

test('an idle GPT-Live 1 session parks and wakes on the next request without client-visible state changes', { timeout: 10000 }, async t => {
  const { connections } = await liveMockServer(t)
  const provider = { ...gptLive1Provider, idleCloseMs: () => 50 }
  const states = []
  const readies = []
  const logs = []
  const session = new RealtimeProviderSession({
    providerRegistry: { resolve: () => provider },
    defaultProvider: 'gpt-live-1',
    getAgentContext: () => ({}),
    shouldReconnect: () => true,
    onEvent: () => {},
    onDiagnostic: () => {},
    onConnected: () => {},
    onReady: (_frontend, info) => readies.push(info),
    onDisconnected: () => states.push({ state: 'disconnected' }),
    onReconnected: () => {},
    onConnectionState: state => states.push(state),
    onError: error => states.push({ state: 'error', message: error.message }),
    onReconnectError: () => {},
    logger: { info: (name, fields) => logs.push([name, fields]), warn: () => {}, error: () => {} },
    idleCloseBlocker: () => '',
  })
  t.after(() => session.close())
  await session.ensure()
  await until(() => session.parked)
  await until(() => connections[0].closed)
  assert.ok(connections[0].received.some(message => message.type === 'session.close'), 'closed with session.close')
  assert.ok(logs.some(([name]) => name === 'realtime.parked'))
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(connections.length, 1, 'no reconnect after a park')
  assert.deepEqual(states.map(state => state.state), ['connecting', 'connected'])

  await session.ensure()
  assert.equal(connections.length, 2)
  assert.equal(connections[1].received[0].type, 'session.start')
  assert.deepEqual(states.map(state => state.state), ['connecting', 'connected'], 'the wake is invisible')
  assert.deepEqual(readies, [{ resumedFromPark: false }, { resumedFromPark: true }])
  assert.equal(session.parked, false)
  assert.ok(logs.some(([name, fields]) => name === 'realtime.connected' && fields.resumedFromPark === true))
})

test('GPT-Live 1 settles a text request on its backend response, not on the voice layer speaking', { timeout: 10000 }, async t => {
  withConfig(t, { gptLive1ApiKey: 'live-test', gptLive1Model: 'gpt-live-1' })
  withEnv(t, { GPT_LIVE_1_DELEGATION_MODEL: 'gpt-5.6-terra', GPT_LIVE_1_OUTPUT_IDLE_MS: '40' })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  let backendDoneAt = 0
  server.once('connection', socket => {
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      if (message.type === 'session.start') {
        socket.send(JSON.stringify({ type: 'session.started', session: { id: 'sess_1' } }))
      } else if (message.type === 'response.create') {
        // The voice layer starts a filler before the backend response exists.
        socket.send(JSON.stringify({ type: 'session.output_audio.delta', delta: pcmFrame({ amplitude: 3000 }) }))
        setTimeout(() => {
          socket.send(JSON.stringify({ type: 'response.event', delegation_id: 'del_1', event: { type: 'response.created', response: { id: 'resp_1' } } }))
          socket.send(JSON.stringify({ type: 'response.event', delegation_id: 'del_1', event: { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } } }))
          backendDoneAt = performance.now()
        }, 50)
      }
    })
  })
  withConfig(t, { gptLive1RealtimeUrl: `ws://127.0.0.1:${server.address().port}/v1/live/sessions` })
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {}, onEvent: () => {}, responseStartTimeoutMs: 2000 })
  t.after(async () => {
    frontend.close()
    await new Promise(resolve => server.close(resolve))
  })
  await frontend.connect()
  const outcome = await Promise.race([
    frontend.sendUserText('明天天气怎么样'),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 1500)),
  ])
  assert.notEqual(outcome, 'timeout', 'a tool result queued behind this request would wait for the voice layer to finish')
  assert.equal(outcome.completed, true)
  assert.ok(performance.now() - backendDoneAt < 500)
  assert.equal(frontend.playbackResponses.size, 1, 'the spoken segment is still open, owed the result')
})

function relayHarness(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 0
  const sent = []
  const emitted = []
  let protocol = null
  protocol = createGptLive1Protocol({
    emit: event => emitted.push(...[].concat(protocol.normalizeIncoming(event))),
    send: payload => {
      const encoded = protocol.encodeOutgoing(payload)
      sent.push(encoded)
      return encoded
    },
    inputKeepaliveMs: 0,
    outputIdleMs: 800,
    voiceOwedMs: 4000,
    resultRelayMs: 2000,
    now: () => clock,
  })
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  const wait = ms => {
    for (let step = 0; step < ms; step += 100) {
      clock += 100
      t.mock.timers.tick(100)
    }
  }
  const frame = amplitude => protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: pcmFrame({ amplitude }) })
  const backend = nested => protocol.normalizeIncoming({ type: 'response.event', delegation_id: 'del_1', event: nested })
  const finishBackend = text => {
    protocol.encodeOutgoing({ type: 'response.create' })
    backend({ type: 'response.created', response: { id: 'resp_1' } })
    backend({ type: 'response.output_text.delta', delta: text.slice(0, 3) })
    backend({ type: 'response.output_text.done', text })
    backend({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } })
  }
  const relays = () => sent.filter(payload => payload.type === 'session.commentary.append')
  return { protocol, emitted, wait, frame, finishBackend, relays }
}

test('GPT-Live 1 relays a completed backend result the voice layer leaves unspoken', t => {
  const { protocol, emitted, wait, finishBackend, relays } = relayHarness(t)
  finishBackend('上海今天有小雨，出门带伞。')
  wait(1900)
  assert.deepEqual(relays(), [])
  wait(200)
  assert.equal(relays().length, 1)
  assert.equal(relays()[0].content, '上海今天有小雨，出门带伞。')
  assert.equal(relays()[0].delegation_id, null)
  const id = relays()[0].event_id
  assert.deepEqual(protocol.normalizeIncoming({ type: 'error', error: { code: 'x', message: 'refused', client_event_id: id } }), [], 'a refused relay does not fail the turn')
  assert.equal(emitted.filter(event => event.type === 'error').length, 0)
})

test('GPT-Live 1 keeps a relay acknowledgement internal', t => {
  const { protocol, wait, finishBackend, relays } = relayHarness(t)
  finishBackend('结果')
  wait(2100)
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.commentary.appended', client_event_id: relays()[0].event_id }), [], 'the relay is not a speak request')
})

test('GPT-Live 1 does not relay a result the voice layer speaks or is speaking', t => {
  const spoken = relayHarness(t)
  spoken.finishBackend('结果')
  spoken.frame(0)
  spoken.wait(300)
  spoken.frame(3000)
  spoken.wait(2000)
  assert.deepEqual(spoken.relays(), [], 'the voice layer started speaking the result')

  t.mock.timers.reset()
  const speaking = relayHarness(t)
  speaking.frame(3000)
  speaking.finishBackend('结果')
  for (let i = 0; i < 20; i += 1) {
    speaking.frame(3000)
    speaking.wait(100)
  }
  assert.deepEqual(speaking.relays(), [], 'still talking straight into the result')
})

test('GPT-Live 1 records a cancelled segment\'s transcript once, apart from the next answer', async t => {
  const { protocol, emitted, frames, backend, wait } = segmentHarness(t)
  const transcripts = () => emitted
    .filter(event => event.type === 'response.output_audio_transcript.done')
    .map(event => [event.response_id, event.transcript])
  protocol.encodeOutgoing({ type: 'response.create' })
  backend({ type: 'response.created', response: { id: 'resp_1' } })
  const cut = frames(3000, 2)[0].response_id
  protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: 'Let me check.' })
  frames(0, 10)
  // A new press interrupts playback while the backend still works.
  protocol.responseCancel()
  await new Promise(resolve => queueMicrotask(resolve))
  assert.deepEqual(emitted.map(event => [event.type, event.response_id]), [
    ['response.output_audio_transcript.done', cut],
    ['response.done', cut],
  ], 'what was heard is recorded before the cancel closes it')
  backend({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } })
  frames(0, 5)
  const answer = frames(3000, 2)[0].response_id
  protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: 'It is sunny.' })
  wait(900)
  assert.notEqual(answer, cut)
  assert.deepEqual(transcripts(), [[cut, 'Let me check.'], [answer, 'It is sunny.']], 'the next answer starts clean')

  // A quiet onset frame held before the cancel does not lead the next answer.
  frames(60, 1)
  protocol.responseCancel()
  const next = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: pcmFrame({ amplitude: 3000 }) })
  assert.deepEqual(next.map(event => event.type), ['response.created', 'response.output_audio.delta'])
})

test('GPT-Live 1 keeps the result in the filler\'s response when the backend completes between filler words', t => {
  const { protocol, frames, backend, wait, doneIds } = segmentHarness(t)
  protocol.encodeOutgoing({ type: 'response.create' })
  backend({ type: 'response.created', response: { id: 'resp_1' } })
  const voiceId = frames(3000, 3)[0].response_id
  frames(0, 1)
  backend({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } })
  // The filler goes on with one-frame pauses between words, then ends.
  frames(3000, 3)
  frames(0, 1)
  frames(3000, 2)
  frames(0, 12)
  assert.deepEqual(doneIds(), [], 'a pause between filler words is not the result starting')
  const answer = frames(3000, 5)
  assert.ok(answer.every(event => event.response_id === voiceId), 'the result continues the filler\'s response')
  wait(900)
  assert.deepEqual(doneIds(), [voiceId])
})

test('GPT-Live 1 counts a pause already under way at completion toward the result onset', t => {
  const { protocol, frames, backend, wait, doneIds } = segmentHarness(t)
  protocol.encodeOutgoing({ type: 'response.create' })
  backend({ type: 'response.created', response: { id: 'resp_1' } })
  const voiceId = frames(3000, 3)[0].response_id
  frames(0, 10)
  backend({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } })
  frames(0, 1)
  frames(3000, 3)
  wait(900)
  assert.deepEqual(doneIds(), [voiceId], 'the result began: the segment closes after it, not after the owed window')
})

test('GPT-Live 1 relays the result when only the filler went on past the backend\'s completion', t => {
  const filler = relayHarness(t)
  filler.frame(3000)
  filler.finishBackend('结果')
  for (const amplitude of [3000, 0, 3000, 3000]) {
    filler.wait(100)
    filler.frame(amplitude)
  }
  for (let i = 0; i < 16; i += 1) {
    filler.wait(100)
    filler.frame(0)
  }
  assert.equal(filler.relays().length, 1, 'a pause between filler words is not the result being spoken')

  t.mock.timers.reset()
  const spoken = relayHarness(t)
  spoken.frame(3000)
  spoken.finishBackend('结果')
  for (const amplitude of [3000, 0, 0, 0, 0, 0, 3000, 3000, 3000]) {
    spoken.wait(100)
    spoken.frame(amplitude)
  }
  spoken.wait(1300)
  assert.deepEqual(spoken.relays(), [], 'speech after a sustained pause is the result')
})

test('GPT-Live 1 stops holding a spoken segment after 20 s without speech and traces it', t => {
  const lines = []
  const { protocol, frames, backend, doneIds } = segmentHarness(t, { trace: line => lines.push(line) })
  protocol.encodeOutgoing({ type: 'response.create' })
  backend({ type: 'response.created', response: { id: 'resp_1' } })
  const filler = frames(3000, 3)[0].response_id
  // The tool handler fails without returning an output: the call stays unanswered.
  backend({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'recall', arguments: '{}' } })
  backend({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } })
  frames(0, 195)
  assert.deepEqual(doneIds(), [], 'held while the call is unanswered')
  frames(0, 10)
  assert.deepEqual(doneIds(), [filler], 'released once 20 s passed without speech')
  assert.ok(lines.some(line => line.includes('"type":"gpt-live-1.hold_expired"')), 'the release is traced')
  const next = frames(3000, 3)[0].response_id
  frames(0, 10)
  assert.deepEqual(doneIds(), [filler, next], 'the stale call does not hold the next answer')
  assert.equal(protocol.isQuiescent(), true)
})

test('GPT-Live 1 stops waiting on backend work the service refused or closed', t => {
  const refused = segmentHarness(t)
  refused.protocol.encodeOutgoing({ type: 'response.create' })
  refused.backend({ type: 'response.created', response: { id: 'resp_1' } })
  const voiceId = refused.frames(3000, 3)[0].response_id
  refused.backend({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'recall', arguments: '{}' } })
  refused.backend({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } })
  refused.frames(0, 50)
  const create = refused.protocol.encodeOutgoing({ type: 'response.create' })
  refused.protocol.normalizeIncoming({
    type: 'error',
    error: { type: 'invalid_request_error', code: 'invalid_request', message: 'function call outputs required', client_event_id: create.event_id },
  })
  refused.frames(0, 10)
  assert.deepEqual(refused.doneIds(), [voiceId], 'a refused response.create continues nothing')
  assert.equal(refused.protocol.isQuiescent(), true)

  t.mock.timers.reset()
  const closed = segmentHarness(t)
  closed.protocol.encodeOutgoing({ type: 'response.create' })
  closed.backend({ type: 'response.created', response: { id: 'resp_1' } })
  closed.backend({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'recall', arguments: '{}' } })
  closed.backend({ type: 'response.completed', response: { id: 'resp_1', status: 'completed' } })
  closed.protocol.encodeOutgoing({ type: 'response.create' })
  assert.equal(closed.protocol.isQuiescent(), false)
  assert.deepEqual(closed.protocol.normalizeIncoming({ type: 'session.closed', reason: 'expired' }), [])
  assert.equal(closed.protocol.isQuiescent(), true, 'nothing is awaited after the session closed')
})

function spontaneousHarness(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 20000
  const protocol = createGptLive1Protocol({
    emit: () => {}, inputKeepaliveMs: 0, outputIdleMs: 800, dropSpontaneousSpeech: true, now: () => clock,
  })
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  const voiced = () => protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: pcmFrame({ amplitude: 3000 }) })
  const words = () => protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '嗯' })
  const advance = ms => { clock += ms; t.mock.timers.tick(ms) }
  return { protocol, voiced, words, advance }
}

test('GPT-Live 1 drops speech the voice layer starts on its own for a text-only client with nothing pending', t => {
  const { voiced, words } = spontaneousHarness(t)
  assert.deepEqual(voiced(), [], 'a stray backchannel would reach the earbud as a notification')
  assert.deepEqual(words(), [], 'and its caption would open a response of its own')
})

test('GPT-Live 1 still speaks for a pending request, a speaking microphone, and an acknowledged speak request', t => {
  const requested = spontaneousHarness(t)
  requested.protocol.encodeOutgoing({ type: 'response.create' })
  assert.equal(requested.voiced()[0].type, 'response.created', 'a request is pending')

  t.mock.timers.reset()
  const microphone = spontaneousHarness(t)
  microphone.protocol.encodeOutgoing(microphone.protocol.audioAppend('AAAA'))
  microphone.advance(2000)
  assert.equal(microphone.voiced()[0].type, 'response.created', 'a full-duplex client may be answered at any time')

  t.mock.timers.reset()
  const speak = spontaneousHarness(t)
  const say = speak.protocol.encodeOutgoing({ type: 'session.commentary.append', delegation_id: null, content: '该喝水了' })
  speak.protocol.normalizeIncoming({ type: 'session.commentary.appended', client_event_id: say.event_id })
  speak.advance(1000)
  assert.equal(speak.voiced()[0].type, 'response.created', 'the acknowledged announcement is spoken after its ack')
})

test('GPT-Live 1 applies the output gain after judging silence, clipping at full scale', () => {
  const protocol = createGptLive1Protocol({ emit: () => {}, inputKeepaliveMs: 0, outputIdleMs: 0, outputGain: 2 })
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  const scaled = base64 => {
    const pcm = Buffer.from(base64, 'base64')
    for (let offset = 0; offset < pcm.length; offset += 2) {
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, pcm.readInt16LE(offset) * 2)), offset)
    }
    return pcm.toString('base64')
  }
  const onset = pcmFrame({ amplitude: 150 })
  assert.deepEqual(protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: onset }), [],
    'a frame that is silent before the gain stays silence')
  const loud = pcmFrame({ amplitude: 20000 })
  const events = protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: loud })
  assert.deepEqual(events.map(event => event.type), ['response.created', 'response.output_audio.delta', 'response.output_audio.delta'])
  assert.equal(events[1].delta, scaled(onset), 'the held onset plays with the same gain')
  assert.equal(events[2].delta, scaled(loud), 'speech is doubled and clipped at full scale')
  assert.ok(Buffer.from(events[2].delta, 'base64').includes(Buffer.from([0xff, 0x7f])), 'peaks are clipped, not wrapped')
})

function cancelHarness(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let clock = 20000
  const protocol = createGptLive1Protocol({
    emit: () => {}, inputKeepaliveMs: 0, outputIdleMs: 800, dropCancelledTail: true, now: () => clock, ...options,
  })
  protocol.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
  const voiced = () => protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: pcmFrame({ amplitude: 3000 }) })
  const silence = () => protocol.normalizeIncoming({ type: 'session.output_audio.delta', delta: pcmFrame() })
  const words = () => protocol.normalizeIncoming({ type: 'session.output_transcript.delta', delta: '的小助手' })
  const advance = ms => { clock += ms; t.mock.timers.tick(ms) }
  return { protocol, voiced, silence, words, advance }
}

test('GPT-Live 1 drops the rest of an answer a Gateway cancel cut until the voice pauses', t => {
  const h = cancelHarness(t)
  const cut = h.voiced()[0].response_id
  h.advance(100)
  h.protocol.responseCancel()
  for (let i = 0; i < 5; i += 1) {
    h.advance(100)
    assert.deepEqual(h.voiced(), [], 'the cut answer keeps streaming but is not played')
  }
  assert.deepEqual(h.words(), [], 'nor recorded as the start of the next answer')
  for (let i = 0; i < 7; i += 1) {
    h.advance(100)
    assert.deepEqual(h.silence(), [])
  }
  const next = h.voiced()
  assert.equal(next[0].type, 'response.created', 'speech after the pause is a new answer')
  assert.notEqual(next[0].response_id, cut)
})

test('GPT-Live 1 stops dropping a cut answer 2.5 s after the next request, so the new answer is heard', t => {
  const h = cancelHarness(t)
  h.voiced()
  h.protocol.responseCancel()
  h.advance(100)
  assert.deepEqual(h.voiced(), [])
  h.protocol.encodeOutgoing({ type: 'response.create' })
  for (let i = 0; i < 24; i += 1) {
    h.advance(100)
    assert.deepEqual(h.voiced(), [], 'the voice is still finishing the cut answer')
  }
  h.advance(100)
  assert.equal(h.voiced()[0].type, 'response.created')
})

test('GPT-Live 1 keeps speech after a Gateway cancel unless dropCancelledTail is on', t => {
  const h = cancelHarness(t, { dropCancelledTail: false })
  h.voiced()
  h.protocol.responseCancel()
  h.advance(100)
  assert.equal(h.voiced()[0].type, 'response.created')
})

test('GPT-Live 1 asks the backend for the sentence to say when a reminder is due', () => {
  const protocol = createGptLive1Protocol()
  const due = createGatewaySystemEventDelivery(GatewaySystemEvent.REMINDER_DUE, { data: { content: '提醒你喝水' } })
  const [part] = protocol.conversationItemCreate(gptLive1Provider.buildResultInjection(due.text).item).item.content
  assert.ok(part.text.startsWith(due.text), 'the event itself is passed on unchanged')
  assert.match(part.text, /time is up and what to do/, 'followed by the ask for a spoken sentence')
  const result = gptLive1Provider.buildResultInjection('任务完成：报告已生成').item.content[0].text
  assert.equal(result, '任务完成：报告已生成', 'other deliveries are untouched')
})

function restartHarness(t, options = {}) {
  const requests = []
  const h = cancelHarness(t, { restartOnCancel: true, requestRestart: () => requests.push(1), ...options })
  const backend = (delegationId, nested) => h.protocol.normalizeIncoming({
    type: 'response.event', delegation_id: delegationId, event: nested,
  })
  return { ...h, requests, backend }
}

test('GPT-Live 1 asks for a fresh session when a cancel cuts speech with no backend work in flight', t => {
  const idle = restartHarness(t)
  idle.voiced()
  idle.protocol.responseCancel()
  assert.equal(idle.requests.length, 1)
  idle.advance(100)
  idle.voiced()
  assert.equal(idle.requests.length, 1, 'asked once per cancel')

  t.mock.timers.reset()
  const silent = restartHarness(t)
  silent.protocol.responseCancel()
  assert.equal(silent.requests.length, 0, 'nothing was being said')

  t.mock.timers.reset()
  const off = restartHarness(t, { restartOnCancel: false })
  off.voiced()
  off.protocol.responseCancel()
  assert.equal(off.requests.length, 0, 'off by default')
})

test('GPT-Live 1 asks for a fresh session only once delegated work has finished', t => {
  const h = restartHarness(t)
  h.protocol.normalizeIncoming({ type: 'session.delegation.created', delegation: { id: 'del_1', response_id: 'resp_1' } })
  h.voiced()
  h.protocol.responseCancel()
  for (let i = 0; i < 10; i += 1) {
    h.advance(100)
    h.voiced()
  }
  assert.equal(h.requests.length, 0, 'closing would drop the running delegation')
  h.backend('del_1', { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } })
  for (let i = 0; i < 40 && !h.requests.length; i += 1) {
    h.advance(100)
    h.voiced()
  }
  assert.equal(h.requests.length, 1, 'the cut answer still streaming asks once the work is done')
})

function stallHarness(t, options = {}) {
  const stalls = []
  let elapsed = 0
  const h = cancelHarness(t, { voiceStallMs: 4500, requestStallRestart: () => stalls.push(elapsed), ...options })
  const advance = ms => { elapsed += ms; h.advance(ms) }
  const ask = (text = '你好，你是谁？') => {
    h.protocol.encodeOutgoing({
      type: 'response.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    })
    h.protocol.encodeOutgoing({ type: 'response.create' })
  }
  const backend = (id, nested) => h.protocol.normalizeIncoming({ type: 'response.event', delegation_id: id, event: nested })
  const answer = id => {
    h.protocol.normalizeIncoming({ type: 'session.delegation.created', delegation: { id, response_id: `resp_${id}` } })
    backend(id, { type: 'response.created', response: { id: `resp_${id}` } })
    return () => backend(id, { type: 'response.completed', response: { id: `resp_${id}`, status: 'completed' } })
  }
  return { ...h, advance, stalls, ask, answer }
}

test('GPT-Live 1 takes the voice stall watch from the environment and hands the request to its session', async t => {
  const run = env => {
    withEnv(t, { GPT_LIVE_1_VOICE_STALL_MS: env })
    const stalls = []
    const frontend = new RealtimeFrontend({
      provider: gptLive1Provider, agentContext: {}, onStallRestartRequested: () => stalls.push(1),
    })
    t.after(() => frontend.close())
    const p = frontend.protocol
    p.normalizeIncoming({ type: 'session.started', session: { id: 's' } })
    p.encodeOutgoing({
      type: 'response.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] },
    })
    p.encodeOutgoing({ type: 'response.create' })
    p.normalizeIncoming({ type: 'session.delegation.created', delegation: { id: 'del_1', response_id: 'resp_1' } })
    for (const type of ['response.created', 'response.completed']) {
      p.normalizeIncoming({
        type: 'response.event', delegation_id: 'del_1',
        event: { type, response: { id: 'resp_1', status: 'completed' } },
      })
    }
    return stalls
  }
  const on = run('2000')
  const off = run(undefined)
  await new Promise(resolve => setTimeout(resolve, 2300))
  assert.deepEqual(on, [1], 'GPT_LIVE_1_VOICE_STALL_MS=2000 asks after 2 s')
  assert.deepEqual(off, [], 'unset: off')
})

test('GPT-Live 1 asks for a fresh session when a user turn is never spoken', t => {
  const h = stallHarness(t)
  h.ask()
  const done = h.answer('del_1')
  h.advance(2000)
  done()
  h.advance(2400)
  assert.deepEqual(h.stalls, [], 'not before the stall time')
  h.advance(100)
  assert.deepEqual(h.stalls, [4500], 'asked once the turn went unspoken for 4.5 s')
  h.advance(5000)
  assert.equal(h.stalls.length, 1, 'once per turn')
})

test('GPT-Live 1 leaves a turn alone once the voice speaks, and is off by default', t => {
  const spoken = stallHarness(t)
  spoken.ask()
  const done = spoken.answer('del_1')
  spoken.advance(3000)
  spoken.voiced()
  done()
  spoken.advance(6000)
  assert.deepEqual(spoken.stalls, [])

  t.mock.timers.reset()
  const off = stallHarness(t, { voiceStallMs: 0 })
  off.ask()
  off.answer('del_1')()
  off.advance(10000)
  assert.deepEqual(off.stalls, [])

  t.mock.timers.reset()
  const tool = stallHarness(t)
  tool.protocol.encodeOutgoing({
    type: 'response.item.create', item: { type: 'function_call_output', call_id: 'c1', output: '{}' },
  })
  tool.protocol.encodeOutgoing({ type: 'response.create' })
  tool.advance(10000)
  assert.deepEqual(tool.stalls, [], 'a tool result is not a user turn')
})

test('GPT-Live 1 waits for the backend before calling a turn silent, within the client budget', t => {
  const slow = stallHarness(t)
  slow.ask()
  const done = slow.answer('del_1')
  slow.advance(4000)
  done()
  slow.advance(1400)
  assert.deepEqual(slow.stalls, [], 'the voice gets a moment after the result')
  for (let i = 0; i < 6 && !slow.stalls.length; i += 1) slow.advance(100)
  assert.equal(slow.stalls.length, 1)
  assert.ok(slow.stalls[0] >= 5500 && slow.stalls[0] <= 5800, 'asked 1.5 to 1.8 s after the result')

  t.mock.timers.reset()
  const busy = stallHarness(t)
  busy.ask()
  busy.answer('del_1')
  busy.advance(20000)
  assert.deepEqual(busy.stalls, [], 'too late for a fresh session to help: left to the backend')
})

test('GPT-Live 1 drops the stall watch when the session closes', t => {
  const h = stallHarness(t)
  h.ask()
  h.answer('del_1')()
  h.protocol.sessionClose()
  h.advance(10000)
  assert.deepEqual(h.stalls, [])
})

test('GPT-Live 1 treats a cut answer still streaming as speech, and a new request disarms the restart', t => {
  const h = restartHarness(t)
  h.voiced()
  h.protocol.encodeOutgoing({ type: 'response.create' })
  h.protocol.responseCancel()
  assert.equal(h.requests.length, 0, 'a backend response was requested')
  // Context for the backend disarms the first cut; the voice keeps finishing it.
  h.protocol.encodeOutgoing({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [] } })
  h.backend('del_1', { type: 'response.created', response: { id: 'resp_1' } })
  h.backend('del_1', { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } })
  for (let i = 0; i < 45; i += 1) {
    h.advance(100)
    assert.deepEqual(h.voiced(), [], 'the cut answer is still dropped')
  }
  assert.equal(h.requests.length, 0)
  h.protocol.responseCancel()
  assert.equal(h.requests.length, 1, 'a second cancel while the cut answer still streams counts as cutting speech')

  t.mock.timers.reset()
  const sent = restartHarness(t)
  sent.protocol.normalizeIncoming({ type: 'session.delegation.created', delegation: { id: 'del_1', response_id: 'resp_1' } })
  sent.voiced()
  sent.protocol.responseCancel()
  sent.protocol.encodeOutgoing({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [] } })
  sent.backend('del_1', { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } })
  for (let i = 0; i < 50; i += 1) {
    sent.advance(100)
    sent.voiced()
  }
  assert.equal(sent.requests.length, 0, 'the new request lives on this session')
})

test('a GPT-Live 1 cancel of speech reopens the session silently, without the unanswered question', { timeout: 10000 }, async t => {
  withEnv(t, { GPT_LIVE_1_RESTART_ON_CANCEL: '1' })
  const speech = pcmFrame({ amplitude: 3000 })
  const { connections } = await liveMockServer(t, (message, connection) => {
    if (message.type === 'session.start' && connections.length === 1) {
      connection.socket.send(JSON.stringify({ type: 'session.output_audio.delta', delta: speech }))
    }
  })
  const history = [
    { role: 'user', content: '简单讲讲黑洞是什么' },
    { role: 'assistant', content: '黑洞是引力' },
    { role: 'user', content: '一加一等于几' },
  ]
  const states = []
  const readies = []
  const logs = []
  const events = []
  const session = new RealtimeProviderSession({
    providerRegistry: { resolve: () => gptLive1Provider },
    defaultProvider: 'gpt-live-1',
    getAgentContext: () => ({ recentMessages: history }),
    shouldReconnect: () => true,
    onEvent: event => events.push(event),
    onDiagnostic: () => {},
    onConnected: () => {},
    onReady: (_frontend, info) => readies.push(info),
    onDisconnected: () => states.push({ state: 'disconnected' }),
    onReconnected: () => {},
    onConnectionState: state => states.push(state),
    onError: error => states.push({ state: 'error', message: error.message }),
    onReconnectError: () => {},
    logger: { info: (name, fields) => logs.push([name, fields]), warn: () => {}, error: () => {} },
  })
  t.after(() => session.close())
  await session.ensure()
  await until(() => events.some(event => event.type === 'response.output_audio.delta'))
  const firstSeed = connections[0].received[0].session.input
  assert.equal(firstSeed.at(-1).content[0].text, '一加一等于几', 'a normal connect seeds the whole history')

  session.cancelResponse()
  await until(() => connections.length === 2 && connections[1].received.length > 0)
  assert.ok(connections[0].received.some(message => message.type === 'session.close'), 'the talking session is closed')
  await until(() => readies.length === 2)
  const reseed = connections[1].received[0]
  assert.equal(reseed.type, 'session.start')
  assert.deepEqual(reseed.session.input.map(message => message.role), ['user', 'assistant'],
    'the reopened session is not left an unanswered question to answer on start')
  assert.deepEqual(states.map(state => state.state), ['connecting', 'connected'], 'the restart is invisible to the client')
  assert.deepEqual(readies, [{ resumedFromPark: false }, { resumedFromPark: true }])
  assert.ok(logs.some(([name]) => name === 'realtime.restarted_after_cancel'))

  session.cancelResponse()
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(connections.length, 2, 'a cancel with nothing being said does not restart')
})

test('a GPT-Live 1 request sent in the same tick as the cancel keeps the session, so the question is not lost', { timeout: 10000 }, async t => {
  withEnv(t, { GPT_LIVE_1_RESTART_ON_CANCEL: '1', GPT_LIVE_1_DROP_CANCELLED_TAIL: '1' })
  const speech = pcmFrame({ amplitude: 3000 })
  const { connections } = await liveMockServer(t, (message, connection) => {
    if (message.type === 'session.start') connection.socket.send(JSON.stringify({ type: 'session.output_audio.delta', delta: speech }))
  })
  const logs = []
  const events = []
  const session = new RealtimeProviderSession({
    providerRegistry: { resolve: () => gptLive1Provider },
    defaultProvider: 'gpt-live-1',
    getAgentContext: () => ({}),
    shouldReconnect: () => true,
    onEvent: event => events.push(event),
    onDiagnostic: () => {},
    onConnected: () => {},
    onReady: () => {},
    onDisconnected: () => {},
    onReconnected: () => {},
    onConnectionState: () => {},
    onError: () => {},
    onReconnectError: () => {},
    logger: { info: (name, fields) => logs.push([name, fields]), warn: () => {}, error: () => {} },
  })
  t.after(() => session.close())
  await session.ensure()
  await until(() => events.some(event => event.type === 'response.output_audio.delta'))
  // RealtimeInputRuntime.submit order: cancel the voice, then send the text on the current frontend.
  session.cancelResponse()
  session.frontend.sendUserInput([{ type: 'text', text: '一加一等于几' }], {}).catch(() => {})
  await until(() => logs.some(([name]) => name === 'realtime.restart_skipped'))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(connections.length, 1, 'the session carrying the question is kept')
  assert.ok(connections[0].received.some(message => message.type === 'response.create'))
  assert.ok(!connections[0].received.some(message => message.type === 'session.close'))
  assert.equal(logs.find(([name]) => name === 'realtime.restart_skipped')[1].reason, 'frontend_busy')
})

test('GPT-Live 1 voice speech that starts before a delivery\'s backend step speaks for that delivery', { timeout: 10000 }, async t => {
  withConfig(t, { gptLive1ApiKey: 'live-test', gptLive1Model: 'gpt-live-1' })
  withEnv(t, { GPT_LIVE_1_DELEGATION_MODEL: 'gpt-5.6-terra', GPT_LIVE_1_OUTPUT_IDLE_MS: '40' })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise(resolve => server.once('listening', resolve))
  server.once('connection', socket => {
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      if (message.type === 'session.start') {
        socket.send(JSON.stringify({ type: 'session.started', session: { id: 'sess_1' } }))
      } else if (message.type === 'response.create') {
        // The backend is slow; the voice layer speaks the reminder at once.
        socket.send(JSON.stringify({ type: 'session.output_audio.delta', delta: pcmFrame({ amplitude: 3000 }) }))
        setTimeout(() => {
          socket.send(JSON.stringify({ type: 'response.event', delegation_id: 'del_1', event: { type: 'response.created', response: { id: 'resp_1' } } }))
          socket.send(JSON.stringify({ type: 'response.event', delegation_id: 'del_1', event: { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } } }))
        }, 100)
      }
    })
  })
  withConfig(t, { gptLive1RealtimeUrl: `ws://127.0.0.1:${server.address().port}/v1/live/sessions` })
  const events = []
  const frontend = new RealtimeFrontend({ provider: gptLive1Provider, agentContext: {}, onEvent: event => events.push(event), responseStartTimeoutMs: 2000 })
  t.after(async () => {
    frontend.close()
    await new Promise(resolve => server.close(resolve))
  })
  await frontend.connect()
  const outcome = await frontend.injectDelivery('<gateway_system_event type="reminder.due"/>', 'gateway-system-event',
    { turnId: 'gateway_1', taskId: 'task_1' }, { route: 'respond' })
  const voice = events.find(event => event.type === 'response.created' && event.__voicePlayback)
  assert.equal(voice.__voiceOrigin, 'gateway-system-event')
  assert.equal(voice.__voiceContext.taskId, 'task_1')
  assert.equal(voice.__voiceContext.turnId, 'gateway_1')
  const backend = events.find(event => event.type === 'response.created' && !event.__voicePlayback)
  assert.equal(backend.__voiceOrigin, 'gateway-system-event', 'the request is still settled by its backend step')
  assert.equal(outcome.completed, true)
})
