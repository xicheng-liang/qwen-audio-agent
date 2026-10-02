import { randomUUID } from 'node:crypto'

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function eventId() {
  return `event_${randomUUID().replaceAll('-', '')}`
}

function textFromItem(item) {
  return (Array.isArray(item?.content) ? item.content : [])
    .map(part => String(part?.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

// A new spoken output segment whose server-timeline start jumps past the end of
// the previous one by more than this represents a fresh turn, not mid-utterance
// silence. Tune against real audio; the Live API emits no explicit turn end.
const OUTPUT_SEGMENT_GAP_MS = 1500
// After a barge-in the model keeps speaking for a moment before it yields.
// Output that still overlaps the user's speech (this margin covers transcript
// lag) and continues the cut answer's timeline is that tail. The runtime
// discarded its audio on speech_started, so its transcript is dropped too.
const BARGE_IN_TAIL_MARGIN_MS = 300
// Input transcript fragments follow audio cadence and may lag the speech they
// describe, so utterance boundaries come from the session timeline: a fragment
// starting this long after the previous one ended is a new user utterance
// (synthesises speech_started / barge-in). A fragment that merely arrives late
// but continues the timeline belongs to the current utterance.
const INPUT_SEGMENT_GAP_MS = 1200
// With no input fragment for this long the user utterance is complete. The Live
// API emits no turn-complete event; session.delegation.created carries no turn
// boundary either (fragments keep arriving after it).
export const DEFAULT_INPUT_IDLE_MS = 1500
const INPUT_IDLE_EVENT = 'gpt-live-1.input_idle'
// With no output for this long the spoken segment is over. The Live API emits
// no turn-complete event, so this idle timer is what frees the response slot
// for Gateway-initiated speech (task results, permission prompts).
export const DEFAULT_OUTPUT_IDLE_MS = 800
const OUTPUT_IDLE_EVENT = 'gpt-live-1.output_idle'
// The session timeline advances only while input audio arrives. Without it
// (a text-only client, a muted or idle microphone) appends stay unacknowledged
// and the voice layer never speaks, so once no real audio has been sent for
// the gap, real-time PCM16 silence is appended on every tick.
export const DEFAULT_INPUT_KEEPALIVE_MS = 100
export const DEFAULT_INPUT_KEEPALIVE_GAP_MS = 500
const INPUT_KEEPALIVE_MAX_FILL_MS = 1000
// One answer is one spoken segment: a filler said while the backend works and
// the result spoken after it must not become two responses, because a client
// that ends its turn on the first finished response would lose the result. The
// segment stays open while backend work is outstanding and, after the backend
// completes, until the voice layer starts speaking again or this long passes.
export const DEFAULT_VOICE_OWED_MS = 4000
// Speech after this much consecutive silent output is a new utterance; a
// shorter pause is a gap between words of the one already under way.
const OUTPUT_ONSET_PAUSE_MS = 400
// A hold with no spoken frame for this long is stale bookkeeping (a tool call
// never answered, a refusal that named no command): the segment is let go.
const VOICE_HOLD_MAX_QUIET_MS = 20000
// The voice layer occasionally leaves a completed backend result unspoken. With
// no spoken onset this long after completion, the result text is handed to it
// as commentary (measured: not spoken twice when the voice was already on it).
export const DEFAULT_RESULT_RELAY_MS = 2000
// Some sessions never speak at all, not even a relayed result, while the next
// session answers the same question normally (measured: 1 session in 9 through
// the internal gateway, idle time irrelevant). With voiceStallMs, a user turn
// still unspoken that long after its request, its backend done for a moment,
// asks for a fresh session that asks the turn again. The checks stop where an
// answer from that session could no longer reach a client waiting 8 s.
const VOICE_STALL_AFTER_BACKEND_MS = 1500
const VOICE_STALL_GIVE_UP_MS = 2500
const VOICE_STALL_RECHECK_MS = 250
// With dropSpontaneousSpeech, a text-only client (no real input audio this long)
// asks nothing between its requests: speech the voice layer starts with nothing
// pending would reach it as a stray notification, so it is dropped.
const SPONTANEOUS_INPUT_QUIET_MS = 10000
const RESULT_RELAY_QUIET_MS = 700
// With dropCancelledTail, a Gateway cancel drops the rest of the cut answer: a
// text-only client cannot barge in on the service, so the voice keeps talking.
// The drop ends once the voice pauses, or this long after the next request so
// the new answer is never swallowed.
const CANCEL_TAIL_QUIET_MS = 700
const CANCEL_TAIL_MAX_AFTER_REQUEST_MS = 2500
const BACKEND_TEXT_MAX_CHARS = 4000
// While the timeline runs the service streams output audio continuously,
// silence included, so missing deltas never mark the end of speech. A frame
// below this RMS is silence: outside a spoken segment it is not played, and
// inside one it does not extend the segment. Measured: silence 0-96, speech
// frames 690 and up. Frames shorter than the minimum are not judged.
const OUTPUT_SILENCE_RMS = 150
const OUTPUT_SILENCE_MIN_SAMPLES = 240

function silentPcm16(base64) {
  const pcm = Buffer.from(String(base64 || ''), 'base64')
  const samples = Math.floor(pcm.length / 2)
  if (samples < OUTPUT_SILENCE_MIN_SAMPLES) return false
  let sum = 0
  for (let offset = 0; offset < samples * 2; offset += 2) {
    const value = pcm.readInt16LE(offset)
    sum += value * value
  }
  return Math.sqrt(sum / samples) < OUTPUT_SILENCE_RMS
}

// Fixed output gain with hard clipping; a no-op at 1.
function scalePcm16(base64, gain) {
  if (gain === 1 || !base64) return base64
  const pcm = Buffer.from(String(base64), 'base64')
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const value = Math.round(pcm.readInt16LE(offset) * gain)
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, value)), offset)
  }
  return pcm.toString('base64')
}
// The three append events accept at most 500 tokens. Estimate tokens
// conservatively (a CJK character is about one token, other text about four
// characters per token) and clamp below the limit rather than have the
// service reject the whole command.
const COMMENTARY_MAX_TOKENS = 480
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/

export function estimateTokens(text) {
  let tokens = 0
  let latin = 0
  for (const char of String(text || '')) {
    if (CJK.test(char)) tokens += 1
    else latin += 1
  }
  return tokens + Math.ceil(latin / 4)
}

export function clampCommentary(text) {
  const value = String(text || '').trim()
  if (estimateTokens(value) <= COMMENTARY_MAX_TOKENS) return value
  let end = 0
  let tokens = 0
  for (const char of value) {
    tokens += CJK.test(char) ? 1 : 0.25
    if (tokens > COMMENTARY_MAX_TOKENS - 1) break
    end += char.length
  }
  return `${value.slice(0, end)}…`
}

// The service caps the backend input history (every item appended with
// response.item.create) per session and reports the cap only by rejecting an
// item: "limited to 128 items and 32768 UTF-8 bytes per session". Measured
// against the service: the whole item JSON counts in raw UTF-8, a backend
// response does not release what it consumed, and session.input is separate.
export const DEFAULT_BACKEND_INPUT_MAX_BYTES = 32768
export const DEFAULT_BACKEND_INPUT_MAX_ITEMS = 128
// One item may take at most this share of what is left, so later results in
// the session still get a useful slice, but never less than the floor while
// that much remains.
const BACKEND_INPUT_ITEM_SHARE = 0.5
const BACKEND_INPUT_ITEM_FLOOR_BYTES = 2048
// Held back so every pending function call can still be answered, if only
// with a stub: a call left without output blocks response.create for good.
const BACKEND_INPUT_RESERVE_BYTES = 1024
const BACKEND_INPUT_MAX_HEALS = 3
const BACKEND_INPUT_FULL_HINT = 'GPT-Live 1 后端输入历史已达本会话上限，请重新连接开始新会话。'
const BACKEND_INPUT_LIMIT_PATTERN = /(\d+)\s+items?\s+and\s+(\d+)\s+UTF-8\s+bytes/i

export function utf8Bytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

const truncationMark = totalBytes => `…[truncated; ${totalBytes} bytes in full]`

// Longest prefix of text within maxBytes of UTF-8 at a code-point boundary.
function utf8Prefix(text, maxBytes) {
  if (maxBytes <= 0) return ''
  if (utf8Bytes(text) <= maxBytes) return text
  let bytes = 0
  let end = 0
  for (const char of text) {
    const size = utf8Bytes(char)
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return text.slice(0, end)
}

// Longest string leaf of a JSON value. The item's own identity fields are
// never content; anything below them is.
const ITEM_IDENTITY_KEYS = new Set(['type', 'call_id', 'role', 'name', 'id'])

function longestStringLeaf(value, depth = 0, parent = null, key = null) {
  if (typeof value === 'string') return { parent, key, text: value, bytes: utf8Bytes(value) }
  if (!value || typeof value !== 'object') return null
  let best = null
  for (const [childKey, child] of Object.entries(value)) {
    if (depth === 0 && ITEM_IDENTITY_KEYS.has(childKey)) continue
    const leaf = longestStringLeaf(child, depth + 1, value, childKey)
    if (leaf && (!best || leaf.bytes > best.bytes)) best = leaf
  }
  return best
}

// Fits a Responses input item into maxBytes of item JSON. The item stays valid
// JSON, and so does a JSON-encoded tool output: its longest string leaves are
// cut first, so status fields survive and bulk content loses its tail. Returns
// null when nothing short of dropping the content would fit.
export function fitBackendItem(item, maxBytes) {
  if (utf8Bytes(item) <= maxBytes) return item
  const working = structuredClone(item)
  let decodedOutput = false
  if (typeof working.output === 'string') {
    try {
      const parsed = JSON.parse(working.output)
      if (parsed && typeof parsed === 'object') {
        working.output = parsed
        decodedOutput = true
      }
    } catch {
      // Plain-text output is cut as one string.
    }
  }
  const encode = value => (decodedOutput ? { ...value, output: JSON.stringify(value.output) } : value)
  // holder -> key -> full size, so a leaf carries one mark however often it is cut.
  const marks = new Map()
  for (let round = 0; round < 64; round++) {
    const encoded = encode(working)
    const excess = utf8Bytes(encoded) - maxBytes
    if (excess <= 0) return encoded
    const leaf = longestStringLeaf(working)
    if (!leaf?.parent) return null
    const totals = marks.get(leaf.parent) || new Map()
    const marked = totals.has(leaf.key)
    const total = marked ? totals.get(leaf.key) : leaf.bytes
    const mark = truncationMark(total)
    const body = marked ? leaf.text.slice(0, leaf.text.length - mark.length) : leaf.text
    if (!body) return null
    // Escaping and nesting only make a removed byte worth more, so cutting
    // `excess` raw bytes (plus the mark) removes at least `excess` from the item.
    const keep = utf8Bytes(body) - excess - (marked ? 0 : utf8Bytes(mark))
    leaf.parent[leaf.key] = `${utf8Prefix(body, keep)}${mark}`
    totals.set(leaf.key, total)
    marks.set(leaf.parent, totals)
  }
  return null
}

// A tool result that cannot fit even truncated still answers its call.
function stubOutputItem(item) {
  return {
    type: 'function_call_output',
    call_id: item.call_id,
    output: JSON.stringify({
      error: true,
      error_code: 'tool_result_too_large',
      message: 'Tool result dropped: it exceeds what is left of the GPT-Live 1 backend input budget for this session.',
      bytes: utf8Bytes(item),
    }),
  }
}

// Session ledger of backend input items. Charged on send, refunded when the
// service rejects an item, and re-capped from the service's own error text.
function createBackendInputLedger({ maxBytes, maxItems, itemMaxBytes }) {
  let usedBytes = 0
  let usedItems = 0
  return {
    learn(message) {
      const match = BACKEND_INPUT_LIMIT_PATTERN.exec(String(message || ''))
      if (!match) return false
      maxItems = Number(match[1])
      maxBytes = Number(match[2])
      return true
    },
    // Bytes the next item may take now.
    allowance() {
      if (usedItems >= maxItems) return 0
      const soft = maxBytes - usedBytes - BACKEND_INPUT_RESERVE_BYTES
      let bytes = Math.min(soft, Math.max(BACKEND_INPUT_ITEM_FLOOR_BYTES, Math.floor(soft * BACKEND_INPUT_ITEM_SHARE)))
      if (itemMaxBytes) bytes = Math.min(bytes, itemMaxBytes)
      return Math.max(0, bytes)
    },
    charge(bytes) {
      usedBytes += bytes
      usedItems += 1
    },
    refund(bytes) {
      usedBytes = Math.max(0, usedBytes - bytes)
      usedItems = Math.max(0, usedItems - 1)
    },
  }
}

function backendItem(item) {
  if (item?.type === 'function_call_output') {
    return {
      type: 'function_call_output',
      call_id: String(item.call_id || ''),
      output: typeof item.output === 'string'
        ? item.output
        : JSON.stringify(item.output ?? ''),
    }
  }
  const text = textFromItem(item)
  if (!text) return null
  const role = item.role === 'assistant' ? 'assistant' : 'user'
  return {
    type: 'message',
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
  }
}

// Wire trace for integration debugging: event shapes, ids, codes and sizes.
// Conversation content (prompts, transcripts, tool output, audio) is replaced
// by its length so a trace never carries what was said or returned.
const TRACE_TEXT_KEYS = new Set([
  'audio', 'delta', 'text', 'transcript', 'instructions', 'output', 'content', 'arguments', 'description',
])
const TRACE_KEEP_KEYS = new Set([
  'type', 'event_id', 'client_event_id', 'id', 'call_id', 'name', 'model', 'code', 'param', 'status', 'role',
])
// Service messages may quote the offending input, so they are capped.
const TRACE_CAPPED_KEYS = new Set(['message', 'reason'])
const TRACE_MESSAGE_MAX_CHARS = 200

function traceValue(value, key = '') {
  if (typeof value === 'string') {
    if (TRACE_CAPPED_KEYS.has(key)) {
      return value.length > TRACE_MESSAGE_MAX_CHARS
        ? `${value.slice(0, TRACE_MESSAGE_MAX_CHARS)}…<${value.length} chars>`
        : value
    }
    if (TRACE_KEEP_KEYS.has(key)) return value
    return TRACE_TEXT_KEYS.has(key) || value.length > 80 ? `<${value.length} chars>` : value
  }
  if (Array.isArray(value)) return value.map(entry => traceValue(entry, key))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, traceValue(child, childKey)]))
  }
  return value
}

function traceLine(direction, event) {
  return `gpt-live-1 ${direction} ${JSON.stringify(traceValue(event))}\n`
}

/**
 * Stateful adapter between the Gateway's turn-based realtime lifecycle and
 * OpenAI's full-duplex GPT-Live 1 Live API.
 *
 * The Live API has no response.created / response.done boundaries: the voice
 * layer streams session.output_audio.delta continuously, and reasoning runs in
 * a separate Responses stream delivered inside response.event envelopes. This
 * adapter reconstructs two independent response lifecycles the Gateway can
 * consume:
 *   - a synthesised "voice" response bracketing a contiguous run of spoken
 *     output (segmented by output-timeline gaps and closed on barge-in);
 *   - the delegated "backend" response taken verbatim from the Responses events
 *     inside response.event, which carries the function-call loop.
 *
 * Turn segmentation and input speech events are heuristic (the Live API emits
 * no VAD or turn-complete events); the deterministic mappings — session start,
 * audio append, output audio, transcripts, the function-call loop and close —
 * are exercised by the provider tests.
 */
export function createGptLive1Protocol({
  emit,
  send = null,
  trace = null,
  outputIdleMs = DEFAULT_OUTPUT_IDLE_MS,
  inputIdleMs = DEFAULT_INPUT_IDLE_MS,
  itemMaxBytes,
  backendInputMaxBytes = DEFAULT_BACKEND_INPUT_MAX_BYTES,
  backendInputMaxItems = DEFAULT_BACKEND_INPUT_MAX_ITEMS,
  onStartupError = null,
  standingInstructions = [],
  inputKeepaliveMs = DEFAULT_INPUT_KEEPALIVE_MS,
  inputKeepaliveGapMs = DEFAULT_INPUT_KEEPALIVE_GAP_MS,
  inputSampleRate = 24000,
  outputSampleRate = 24000,
  voiceOwedMs = DEFAULT_VOICE_OWED_MS,
  resultRelayMs = DEFAULT_RESULT_RELAY_MS,
  dropSpontaneousSpeech = false,
  dropCancelledTail = false,
  restartOnCancel = false,
  requestRestart = null,
  voiceStallMs = 0,
  requestStallRestart = null,
  outputGain = 1,
  now = () => performance.now(),
} = {}) {
  let voiceResponseId = ''
  // With restartOnCancel, a Gateway cancel of speech arms a request for a fresh
  // session: closing it is the only way to stop the voice layer finishing the
  // cut answer. It fires once no backend work is in flight, and a new request
  // on this session disarms it.
  let restartArmed = false
  // Set by a Gateway cancel with dropCancelledTail; see CANCEL_TAIL_QUIET_MS.
  let cancelTail = false
  let cancelTailVoicedAt = 0
  let cancelTailRequestAt = 0
  // Output transcript of the open spoken segment. The runtime records the
  // assistant turn from transcript.done; without it history holds only the
  // user's side and a new session answers old questions again.
  let voiceTranscript = ''
  // Timeline keepalive: when real input audio was last sent, when silence was
  // last appended, and whether the append in flight is ours.
  let keepaliveTimer = null
  let lastRealAudioAt = -Infinity
  let lastFillAt = -Infinity
  let fillingSilence = false
  // event_ids of silence appends: a rejected one must not fail the open turn.
  const keepaliveIds = new Set()
  let keepaliveRejections = 0
  // The last silent output frame dropped outside a segment, replayed ahead of
  // the next spoken frame so a soft onset is not clipped.
  let heldSilentDelta = ''
  // Backend work the spoken segment waits for: a response.create not yet
  // answered, function calls whose outputs qaa has not returned, and a
  // completed result the voice layer has not started to speak.
  let awaitingBackend = false
  const pendingFunctionCalls = new Set()
  let voiceOwedUntil = 0
  let quietSinceBackendDone = false
  // Consecutive silent output in audio ms: since the last spoken frame, and
  // since the backend's completion.
  let silentRunMs = 0
  let silentSinceDoneMs = 0
  let lastVoicedAt = -Infinity
  let voiceOpenedAt = -Infinity
  // Result relay: backend output text per response, the pending relay, and the
  // relay commentary ids, whose acks and errors stay internal.
  const backendText = new Map()
  let relayTimer = null
  let relaying = false
  const relayIds = new Set()
  // A speak request acknowledged: its speech may start after the ack.
  let speakOwedUntil = 0
  // Voice stall watch: when the open user turn was requested, when the backend
  // last finished, and the pending check.
  let userTurnAt = -Infinity
  let backendDoneAt = -Infinity
  let stallTimer = null
  // When the current or last spoken answer began on the session timeline. The
  // OpenAI primary WebSocket sends audio without timing, so this also comes
  // from output transcript deltas; NaN until either arrives.
  let answerStartMs = NaN
  // Whether an answer began since the current user item opened: the turn
  // test for transports that never send output timing.
  let answeredSinceInput = false
  // Set by a barge-in cancel until the model's next fresh output; the cut
  // answer's timeline end grows with each tail fragment.
  let bargeInTail = false
  let tailEndMs = -Infinity
  let lastOutputEndMs = -Infinity
  let outputIdleTimer = null
  let inputItemId = ''
  let lastInputEndMs = -Infinity
  let inputTranscript = ''
  let inputIdleTimer = null
  // The user turn is committed (speech_stopped + committed) once the assistant
  // starts answering or input goes idle; the transcript may still be completing.
  let inputCommitted = false
  // The most recent completed user item. A late fragment that continues its
  // timeline reopens it silently, growing the caption without a new turn.
  let lastInput = null
  let inputCompletedOnce = false
  // Speak requests in flight: commentary event_id -> synthetic response id.
  const commentaryRequests = new Map()
  const standing = new Set(standingInstructions.map(text => String(text || '').trim()).filter(Boolean))
  // Backend response ids from response.event. A gateway cancel must not close
  // them: interrupting speech leaves delegated work running on the service.
  const backendResponses = new Set()
  // Set once session.started arrives; command errors before that fail startup.
  let started = false
  // The delegation block last sent, so session.update only goes out on change.
  let lastDelegationJson = ''
  // The session sent with session.start, handed to onStartupError so the
  // provider knows which seeded history the service refused.
  let lastStartSession = null
  // event_ids of response.create / response.item.create we sent: an error
  // correlated to one of them concerns the backend response; any other
  // command error (an append, a mute) must not be charged to it.
  const responseCommandIds = new Set()
  // Response ids the runtime has seen opened and not yet closed, and the
  // subset that only represents voice playback. The wire has no cancel, so a
  // Gateway cancel closes the playback records locally and nothing else.
  const openResponses = new Set()
  const playbackResponses = new Set()
  // delegation_id -> the backend response id currently running under it. Most
  // nested Responses events carry no response object, so the lifecycle would
  // otherwise split between the delegation id and the response id, and a tool
  // batch keyed by one would never see the other's response.done.
  const delegationResponses = new Map()
  const ledger = createBackendInputLedger({
    maxBytes: backendInputMaxBytes,
    maxItems: backendInputMaxItems,
    itemMaxBytes,
  })
  // event_id -> what response.item.create sent, and the response.create that
  // followed it, so a rejection can be answered and that request re-issued.
  const sentItems = new Map()
  let pendingBatch = []
  // call_id -> the unfitted tool result, refit smaller if the service rejects.
  const originals = new Map()
  const healAttempts = new Map()
  // event_ids of response.create requests a heal superseded: their
  // "outputs required" error is expected and must not fail the turn.
  const swallowedErrors = new Set()

  const remember = (map, key, value, limit = 64) => {
    map.set(key, value)
    if (map.size > limit) map.delete(map.keys().next().value)
  }

  // Fits an outgoing backend item into the session budget. A tool result that
  // cannot fit even truncated becomes a stub so its call is answered; other
  // items are dropped once the budget is gone.
  const fitToBudget = (item, allowance = ledger.allowance()) => {
    const fitted = fitBackendItem(item, allowance)
    if (fitted) return fitted
    return item.type === 'function_call_output' ? stubOutputItem(item) : null
  }

  // The service rejected an item for the session budget: take back its ledger
  // charge, learn the cap the message states, and answer a pending tool call
  // again with a smaller result, since an unanswered call blocks response.create.
  const healRejectedItem = (clientEventId, error) => {
    ledger.learn(error.message)
    const sent = sentItems.get(clientEventId)
    if (!sent) return false
    sentItems.delete(clientEventId)
    ledger.refund(sent.bytes)
    const { item } = sent
    if (item?.type !== 'function_call_output' || typeof send !== 'function') return false
    const attempts = (healAttempts.get(item.call_id) || 0) + 1
    if (attempts > BACKEND_INPUT_MAX_HEALS) return false
    remember(healAttempts, item.call_id, attempts)
    // The service may hold more than the ledger knows, so back off from what
    // the rejected attempt used rather than trusting the allowance alone.
    const allowance = Math.min(ledger.allowance(), Math.floor(sent.bytes / 2))
    const retry = fitToBudget(originals.get(item.call_id) || item, allowance)
    if (sent.responseCreateId) swallowedErrors.add(sent.responseCreateId)
    queueMicrotask(() => {
      send({ type: 'response.item.create', item: retry })
      if (sent.responseCreateId) send({ type: 'response.create' })
    })
    return true
  }

  const stopKeepalive = () => {
    clearInterval(keepaliveTimer)
    keepaliveTimer = null
  }

  // Fills the wall-clock time since the last audio of either kind, capped so a
  // stalled timer cannot burst. A failed send means the socket is gone.
  const keepaliveTick = () => {
    const at = now()
    if (at - lastRealAudioAt < inputKeepaliveGapMs) return
    const fillMs = Math.min(at - Math.max(lastRealAudioAt, lastFillAt), INPUT_KEEPALIVE_MAX_FILL_MS)
    const samples = Math.round(inputSampleRate * fillMs / 1000)
    if (!(samples > 0)) return
    lastFillAt = at
    fillingSilence = true
    let sent
    try {
      sent = send({ type: 'session.input_audio.append', audio: Buffer.alloc(samples * 2).toString('base64') }, { audio: true })
    } finally {
      fillingSilence = false
    }
    if (!sent) stopKeepalive()
  }

  const startKeepalive = () => {
    if (keepaliveTimer || typeof send !== 'function' || !(inputKeepaliveMs > 0)) return
    lastFillAt = now()
    keepaliveTimer = setInterval(keepaliveTick, inputKeepaliveMs)
    keepaliveTimer.unref?.()
  }

  const trackResponses = normalized => {
    for (const event of [].concat(normalized ?? [])) {
      const responseId = event?.response?.id || event?.response_id
      if (!responseId) continue
      if (event.type === 'response.created') {
        openResponses.add(responseId)
        if (event.__voicePlayback) playbackResponses.add(responseId)
      } else if (['response.done', 'response.cancelled', 'response.canceled', 'error'].includes(event.type)) {
        openResponses.delete(responseId)
        playbackResponses.delete(responseId)
      }
    }
    return normalized
  }

  const clearOutputIdle = () => {
    clearTimeout(outputIdleTimer)
    outputIdleTimer = null
  }

  // Re-armed on every output fragment; fires once the service has been quiet.
  // Without an emit hook (bare protocol tests) segmentation falls back to the
  // timeline gap and barge-in triggers alone.
  const armOutputIdle = () => {
    if (typeof emit !== 'function' || !(outputIdleMs > 0)) return
    clearOutputIdle()
    outputIdleTimer = setTimeout(() => {
      outputIdleTimer = null
      emit({ type: OUTPUT_IDLE_EVENT })
    }, outputIdleMs)
    outputIdleTimer.unref?.()
  }

  const clearInputIdle = () => {
    clearTimeout(inputIdleTimer)
    inputIdleTimer = null
  }

  const armInputIdle = () => {
    if (typeof emit !== 'function' || !(inputIdleMs > 0)) return
    clearInputIdle()
    inputIdleTimer = setTimeout(() => {
      inputIdleTimer = null
      emit({ type: INPUT_IDLE_EVENT })
    }, inputIdleMs)
    inputIdleTimer.unref?.()
  }

  const clearRelay = () => {
    clearTimeout(relayTimer)
    relayTimer = null
  }

  const scheduleRelay = text => {
    clearRelay()
    const content = clampCommentary(String(text || '').trim())
    if (!content || typeof send !== 'function' || !(resultRelayMs > 0)) return
    relayTimer = setTimeout(() => {
      relayTimer = null
      // Spoken already, or speaking right now: leave it to the voice layer.
      if (!voiceOwedUntil || now() - lastVoicedAt < RESULT_RELAY_QUIET_MS) return
      voiceOwedUntil = now() + voiceOwedMs
      quietSinceBackendDone = true
      relaying = true
      try {
        send({ type: 'session.commentary.append', delegation_id: null, content })
      } finally {
        relaying = false
      }
    }, resultRelayMs)
    relayTimer.unref?.()
  }

  const clearStall = () => {
    clearTimeout(stallTimer)
    stallTimer = null
  }

  const checkStall = () => {
    stallTimer = null
    if (lastVoicedAt >= userTurnAt) return
    const backendBusy = awaitingBackend || backendResponses.size > 0 || pendingFunctionCalls.size > 0
    if (backendBusy || now() - backendDoneAt < VOICE_STALL_AFTER_BACKEND_MS) {
      if (now() - userTurnAt < voiceStallMs + VOICE_STALL_GIVE_UP_MS) {
        stallTimer = setTimeout(checkStall, VOICE_STALL_RECHECK_MS)
        stallTimer.unref?.()
      }
      return
    }
    if (trace) {
      trace(traceLine('--', { type: 'gpt-live-1.voice_stalled', waited_ms: Math.round(now() - userTurnAt) }))
    }
    clearRelay()
    requestStallRestart()
  }

  const armStall = () => {
    clearStall()
    if (!(voiceStallMs > 0) || typeof requestStallRestart !== 'function') return
    userTurnAt = now()
    stallTimer = setTimeout(checkStall, voiceStallMs)
    stallTimer.unref?.()
  }

  const holdVoiceSegment = () => backendResponses.size > 0
    || awaitingBackend
    || pendingFunctionCalls.size > 0
    || now() < voiceOwedUntil

  const spontaneous = () => dropSpontaneousSpeech
    && !voiceResponseId
    && now() - lastRealAudioAt > SPONTANEOUS_INPUT_QUIET_MS
    && !holdVoiceSegment()
    && commentaryRequests.size === 0
    && !relayTimer
    && !(now() < speakOwedUntil)

  const pcm16Ms = base64 => Buffer.byteLength(String(base64 || ''), 'base64') / 2 / outputSampleRate * 1000

  // A spoken frame after a sustained pause following the backend's completion
  // is the voice layer speaking the result: nothing is owed any more.
  const noteOutputFrame = (silent, ms) => {
    silentRunMs = silent ? silentRunMs + ms : 0
    if (!voiceOwedUntil) return
    if (silent) {
      silentSinceDoneMs += ms
      if (silentSinceDoneMs >= OUTPUT_ONSET_PAUSE_MS) quietSinceBackendDone = true
    } else if (quietSinceBackendDone) voiceOwedUntil = 0
    else silentSinceDoneMs = 0
  }

  // Lets go of every hold reason, so stale bookkeeping cannot hold later answers.
  const expireHold = quietMs => {
    if (trace) {
      trace(traceLine('--', {
        type: 'gpt-live-1.hold_expired',
        response_id: voiceResponseId,
        quiet_ms: Math.round(quietMs),
        awaiting_backend: awaitingBackend,
        backend_responses: backendResponses.size,
        pending_function_calls: pendingFunctionCalls.size,
      }))
    }
    awaitingBackend = false
    pendingFunctionCalls.clear()
    backendResponses.clear()
    voiceOwedUntil = 0
  }

  const openVoiceResponse = (events, startMs = NaN) => {
    if (voiceResponseId) {
      if (!Number.isFinite(answerStartMs) && Number.isFinite(startMs)) answerStartMs = startMs
      return voiceResponseId
    }
    voiceResponseId = id('voice')
    voiceOpenedAt = now()
    answerStartMs = Number.isFinite(startMs) ? startMs : NaN
    answeredSinceInput = true
    events.push({
      type: 'response.created',
      response: { id: voiceResponseId, status: 'in_progress' },
      response_id: voiceResponseId,
      __voicePlayback: true,
      // The voice layer speaks on its own; no client request is answered by it.
      __unsolicited: true,
    })
    return voiceResponseId
  }

  // The open segment's transcript as a final event; null when nothing was said.
  const voiceTranscriptDone = () => (voiceResponseId && voiceTranscript.trim()
    ? { type: 'response.output_audio_transcript.done', response_id: voiceResponseId, transcript: voiceTranscript }
    : null)

  const finishVoiceResponse = (events, status = 'completed') => {
    clearOutputIdle()
    if (!voiceResponseId) return
    const transcriptDone = voiceTranscriptDone()
    if (transcriptDone) events.push(transcriptDone)
    voiceTranscript = ''
    events.push({
      type: 'response.done',
      response: { id: voiceResponseId, status },
      response_id: voiceResponseId,
      __voicePlayback: true,
    })
    voiceResponseId = ''
    lastOutputEndMs = -Infinity
  }

  // Output that continues the answer a barge-in cut while the user still
  // speaks. Untimed output cannot be judged and passes through.
  const interruptedTail = (startMs, endMs) => {
    if (!bargeInTail || !Number.isFinite(startMs)) return false
    const overlapsUser = startMs < lastInputEndMs + BARGE_IN_TAIL_MARGIN_MS
    const continuesAnswer = !Number.isFinite(tailEndMs) || startMs - tailEndMs <= OUTPUT_SEGMENT_GAP_MS
    if (overlapsUser && continuesAnswer) {
      tailEndMs = Number.isFinite(endMs) ? endMs : startMs
      return true
    }
    bargeInTail = false
    return false
  }

  // Closing the session would drop delegated work or a result not yet spoken.
  const backendIdle = () => backendResponses.size === 0 && pendingFunctionCalls.size === 0
    && !awaitingBackend && commentaryRequests.size === 0 && !(now() < voiceOwedUntil) && !relayTimer

  const maybeRestart = () => {
    if (!restartArmed || !backendIdle() || typeof requestRestart !== 'function') return
    restartArmed = false
    requestRestart()
  }

  // Output still belonging to an answer a Gateway cancel cut; a spoken frame
  // keeps the drop going, and retries an armed restart.
  const cancelledTail = voiced => {
    if (!cancelTail) return false
    const at = now()
    if (at - cancelTailVoicedAt >= CANCEL_TAIL_QUIET_MS
      || (cancelTailRequestAt && at - cancelTailRequestAt >= CANCEL_TAIL_MAX_AFTER_REQUEST_MS)) {
      cancelTail = false
      restartArmed = false
      return false
    }
    if (voiced) {
      cancelTailVoicedAt = at
      maybeRestart()
    }
    return true
  }

  // Ends the user's turn in the runtime's model (GA order: speech_stopped,
  // committed, then the response). The transcript keeps streaming into the
  // committed item until it completes, exactly as GA transcription arrives late.
  const commitInput = events => {
    if (!inputItemId || inputCommitted) return
    inputCommitted = true
    events.push({ type: 'input_audio_buffer.speech_stopped', item_id: inputItemId })
    events.push({ type: 'input_audio_buffer.committed', item_id: inputItemId })
  }

  const completeInput = events => {
    clearInputIdle()
    if (!inputItemId) return
    commitInput(events)
    if (!inputCompletedOnce) {
      events.push({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: inputItemId,
        transcript: inputTranscript.trim(),
      })
    }
    lastInput = { id: inputItemId, transcript: inputTranscript }
    inputItemId = ''
    inputTranscript = ''
    inputCommitted = false
    inputCompletedOnce = false
  }

  // A nested Responses event (unwrapped from a response.event envelope) mapped
  // onto the Gateway's response lifecycle. The backend response id comes from
  // the Responses stream itself, so it never collides with the voice response.
  const normalizeBackendEvent = (nested, delegationId) => {
    const nestedId = nested?.response?.id || ''
    if (nestedId && delegationId) delegationResponses.set(delegationId, nestedId)
    const responseId = nestedId || delegationResponses.get(delegationId) || delegationId || ''
    if (responseId) backendResponses.add(responseId)
    switch (nested?.type) {
      case 'response.created':
      case 'response.in_progress':
        awaitingBackend = false
        // A response continued after tool results may resume with in_progress
        // and no created event; open it then, once.
        if (nested.type === 'response.in_progress' && openResponses.has(responseId)) return []
        return [{
          type: 'response.created',
          response: { id: responseId, status: 'in_progress' },
          response_id: responseId,
        }]
      case 'response.function_call_arguments.done':
        // The authoritative function call is response.output_item.done, which
        // carries call_id/name. The arguments-done twin has no call_id in the
        // Responses stream, so a bare one here is that duplicate: drop it.
        if (!nested.call_id) return []
        pendingFunctionCalls.add(nested.call_id)
        return [{
          type: 'response.function_call_arguments.done',
          response_id: responseId,
          call_id: nested.call_id,
          name: nested.name || '',
          arguments: nested.arguments || '{}',
        }]
      case 'response.output_item.done': {
        const item = nested.item || {}
        if (item.type !== 'function_call') return []
        if (item.call_id) pendingFunctionCalls.add(item.call_id)
        return [{
          type: 'response.function_call_arguments.done',
          response_id: responseId,
          call_id: item.call_id || '',
          name: item.name || '',
          arguments: item.arguments || '{}',
        }]
      }
      case 'response.completed':
      case 'response.done':
      case 'response.incomplete':
        delegationResponses.delete(delegationId)
        backendResponses.delete(responseId)
        backendDoneAt = now()
        voiceOwedUntil = now() + voiceOwedMs
        // Quiet already: no spoken segment, or one in a sustained pause.
        quietSinceBackendDone = !voiceResponseId || silentRunMs >= OUTPUT_ONSET_PAUSE_MS
        silentSinceDoneMs = 0
        scheduleRelay(backendText.get(responseId))
        backendText.delete(responseId)
        return [{
          type: 'response.done',
          response: {
            id: responseId,
            status: nested.type === 'response.incomplete' ? 'incomplete' : (nested.response?.status || 'completed'),
          },
          response_id: responseId,
        }]
      case 'response.failed':
      case 'error':
        awaitingBackend = false
        backendDoneAt = now()
        backendText.delete(responseId)
        delegationResponses.delete(delegationId)
        backendResponses.delete(responseId)
        // With the id the runtime releases this response; without it the
        // failure would be charged to the sole waiter, or to nothing, and the
        // backend id would gate every later Gateway request for good.
        return [{
          type: 'error',
          error: nested.error || nested.response?.error || { message: 'GPT-Live 1 backend response failed' },
          response_id: responseId,
        }]
      // Backend text is not spoken directly; the voice layer speaks. It is kept
      // only as the relay's fallback content.
      case 'response.output_text.delta':
        if (responseId) backendText.set(responseId, `${backendText.get(responseId) || ''}${nested.delta || ''}`.slice(0, BACKEND_TEXT_MAX_CHARS))
        return []
      case 'response.output_text.done':
        if (responseId && typeof nested.text === 'string') backendText.set(responseId, nested.text.slice(0, BACKEND_TEXT_MAX_CHARS))
        return []
      default:
        return []
    }
  }

  // A rejected append/mute/update is not the failure of the backend response
  // that happens to be running; give it its own id so the runtime does not
  // settle the sole active response with it.
  const commandError = (error, clientEventId) => {
    const unrelated = started && clientEventId && !responseCommandIds.has(clientEventId)
    return unrelated
      ? { type: 'error', error, response_id: `gpt-live-1:command:${clientEventId}` }
      : { type: 'error', error }
  }

  const normalizeEvent = event => {
    switch (event?.type) {
      case 'session.started':
        started = true
        startKeepalive()
        return { type: 'session.created', session: { id: event.session?.id || null } }

      // session.update acks carry nothing the runtime needs; usage and the
      // other appends are acknowledgements only.
      case 'session.updated':
      case 'session.usage.updated':
      case 'session.thinking.appended':
      case 'session.instructions.appended':
      case 'session.input_audio.muted':
      case 'session.input_audio.unmuted':
        return []

      case 'session.output_audio.delta': {
        const events = []
        const startMs = Number(event.start_ms)
        if (interruptedTail(startMs, Number(event.end_ms))) return events
        const silent = silentPcm16(event.delta)
        if (!silent) lastVoicedAt = now()
        noteOutputFrame(silent, pcm16Ms(event.delta))
        if (cancelledTail(!silent)) {
          heldSilentDelta = ''
          return events
        }
        const delta = scalePcm16(event.delta || '', outputGain)
        if (silent && !voiceResponseId) {
          heldSilentDelta = delta
          return events
        }
        if (spontaneous()) {
          heldSilentDelta = ''
          return events
        }
        if (
          voiceResponseId
          && Number.isFinite(startMs)
          && Number.isFinite(lastOutputEndMs)
          && startMs - lastOutputEndMs > OUTPUT_SEGMENT_GAP_MS
          && !holdVoiceSegment()
        ) {
          finishVoiceResponse(events)
        }
        // The assistant answering ends the user's turn; without this the
        // runtime treats the answer as talking over the user and mutes it.
        commitInput(events)
        const opening = !voiceResponseId
        const responseId = openVoiceResponse(events, Number(event.start_ms))
        if (Number.isFinite(event.end_ms)) lastOutputEndMs = Number(event.end_ms)
        if (opening && heldSilentDelta) {
          events.push({ type: 'response.output_audio.delta', response_id: responseId, delta: heldSilentDelta })
        }
        heldSilentDelta = ''
        events.push({
          type: 'response.output_audio.delta',
          response_id: responseId,
          delta,
        })
        // A pause inside speech is played but does not extend the segment, so
        // it closes one idle window after the last spoken frame.
        if (!silent) armOutputIdle()
        return events
      }

      // The voice layer speaks commentary inside its current or next segment;
      // the acknowledgement is the only completion signal the wire offers, so
      // it settles the Gateway's speak request as a finished playback response.
      case 'session.commentary.appended': {
        const clientEventId = String(event.client_event_id || '')
        if (relayIds.delete(clientEventId)) return []
        const sayId = commentaryRequests.get(clientEventId)
        if (!sayId) return []
        commentaryRequests.delete(clientEventId)
        speakOwedUntil = now() + voiceOwedMs
        return [
          { type: 'response.created', response: { id: sayId, status: 'in_progress' }, response_id: sayId, __voicePlayback: true },
          { type: 'response.done', response: { id: sayId, status: 'completed' }, response_id: sayId, __voicePlayback: true },
        ]
      }

      case 'session.output_transcript.delta': {
        const events = []
        if (interruptedTail(Number(event.start_ms), Number(event.end_ms))) return events
        if (cancelledTail(false)) return events
        if (spontaneous()) return events
        commitInput(events)
        const responseId = openVoiceResponse(events, Number(event.start_ms))
        voiceTranscript += event.delta || ''
        events.push({
          type: 'response.output_audio_transcript.delta',
          response_id: responseId,
          delta: event.delta || '',
        })
        armOutputIdle()
        return events
      }

      case OUTPUT_IDLE_EVENT: {
        const events = []
        if (voiceResponseId && holdVoiceSegment()) {
          const quietMs = now() - Math.max(lastVoicedAt, voiceOpenedAt)
          if (quietMs < VOICE_HOLD_MAX_QUIET_MS) {
            armOutputIdle()
            return events
          }
          expireHold(quietMs)
        }
        finishVoiceResponse(events)
        return events
      }

      case 'session.input_transcript.delta': {
        const events = []
        const startMs = Number(event.start_ms)
        const endMs = Number(event.end_ms)
        // A timeline jump is fresh speech; a late fragment continuing the
        // timeline is not, even if the previous utterance was already closed.
        const timelineGap = !Number.isFinite(lastInputEndMs)
          || !Number.isFinite(startMs)
          || startMs - lastInputEndMs > INPUT_SEGMENT_GAP_MS
        // Transcripts lag the audio. Speech that began after the answer began
        // is a new turn (a barge-in while the answer still plays); a fragment
        // from before it belongs to the question, however late it arrives, and
        // must not start a turn: the runtime clears playback on speech_started.
        const afterAnswer = Number.isFinite(answerStartMs)
          ? Number.isFinite(startMs) && startMs > answerStartMs
          : answeredSinceInput
        const freshTurn = timelineGap && afterAnswer
        if (inputItemId && freshTurn) completeInput(events)
        if (!inputItemId) {
          if (freshTurn || !lastInput) {
            if (voiceResponseId) {
              bargeInTail = true
              tailEndMs = lastOutputEndMs
              finishVoiceResponse(events, 'cancelled')
            }
            inputItemId = id('input')
            inputTranscript = ''
            inputCommitted = false
            inputCompletedOnce = false
            answeredSinceInput = false
            events.push({
              type: 'input_audio_buffer.speech_started',
              item_id: inputItemId,
            })
          } else {
            // Reopen the previous utterance: its caption grows, no turn starts.
            inputItemId = lastInput.id
            inputTranscript = lastInput.transcript
            inputCommitted = true
            inputCompletedOnce = true
          }
        }
        if (Number.isFinite(endMs)) lastInputEndMs = Math.max(lastInputEndMs, endMs)
        else if (Number.isFinite(startMs)) lastInputEndMs = Math.max(lastInputEndMs, startMs)
        const delta = String(event.delta || '')
        inputTranscript += delta
        // `text` is the transcript so far: the runtime shows it as the live
        // user caption, so a bare fragment would flash and vanish.
        events.push({
          type: 'conversation.item.input_audio_transcription.delta',
          item_id: inputItemId,
          delta,
          text: inputTranscript,
        })
        armInputIdle()
        return events
      }

      case INPUT_IDLE_EVENT: {
        const events = []
        completeInput(events)
        return events
      }

      // The Responses lifecycle arrives in response.event; the delegation
      // record itself marks no turn boundary (transcript fragments continue),
      // but it binds the delegation to the response id that follows.
      case 'session.delegation.created': {
        const delegation = event.delegation || {}
        if (delegation.id && delegation.response_id) {
          delegationResponses.set(delegation.id, delegation.response_id)
          backendResponses.add(delegation.response_id)
        }
        return []
      }

      case 'response.event':
        return normalizeBackendEvent(event.event, event.delegation_id)

      case 'session.closed': {
        stopKeepalive()
        clearRelay()
        clearStall()
        backendText.clear()
        awaitingBackend = false
        pendingFunctionCalls.clear()
        voiceOwedUntil = 0
        const events = []
        completeInput(events)
        finishVoiceResponse(events)
        // A safety termination must reach the runtime as a content-safety
        // error, or the reconnect would reseed the same history and repeat it.
        if (String(event.reason || '') === 'content') {
          events.push({
            type: 'error',
            error: { type: 'session_closed', code: 'content', message: 'GPT-Live 1 session closed by the service: content policy' },
          })
        }
        return events
      }

      case 'error': {
        const error = event.error || { message: 'GPT-Live 1 error' }
        const clientEventId = String(error.client_event_id || '')
        if (!started && typeof onStartupError === 'function') onStartupError(error, { session: lastStartSession })
        if (swallowedErrors.delete(clientEventId)) return []
        // A refused relay leaves the result to the voice layer, as before it.
        if (relayIds.delete(clientEventId)) return []
        // Refused silence is reported once, after which the keepalive stops.
        if (keepaliveIds.delete(clientEventId)) {
          keepaliveRejections += 1
          if (keepaliveRejections < 3) return []
          stopKeepalive()
          return commandError(error, clientEventId)
        }
        // A refused response.create starts no backend work, so the segment no
        // longer waits on it or on the calls it was to continue.
        if (responseCommandIds.has(clientEventId) && !sentItems.has(clientEventId)) {
          awaitingBackend = false
          pendingFunctionCalls.clear()
        }
        const sayId = commentaryRequests.get(clientEventId)
        if (sayId) {
          // A rejected commentary fails the speak request it belongs to.
          commentaryRequests.delete(clientEventId)
          return [
            { type: 'response.created', response: { id: sayId, status: 'in_progress' }, response_id: sayId, __voicePlayback: true },
            { type: 'error', error, response_id: sayId },
          ]
        }
        if (error.code === 'response_input_buffer_full') {
          if (healRejectedItem(clientEventId, error)) return []
          // The user sees the hint; the service's own wording stays for logs.
          return commandError({
            ...error,
            message: BACKEND_INPUT_FULL_HINT,
            service_message: error.message || '',
          }, clientEventId)
        }
        return commandError(error, clientEventId)
      }

      default:
        return event
    }
  }

  return Object.freeze({
    encodeOutgoing: payload => {
      if (payload == null) return null
      const encoded = { event_id: eventId(), ...payload }
      if (payload.type === 'response.create') awaitingBackend = true
      if (['response.create', 'response.item.create', 'session.commentary.append'].includes(payload.type)) {
        restartArmed = false
      }
      if (cancelTail && !cancelTailRequestAt
        && (payload.type === 'response.create' || payload.type === 'session.commentary.append')) {
        cancelTailRequestAt = now()
      }
      if (payload.type === 'response.item.create' && payload.item?.type === 'function_call_output') {
        pendingFunctionCalls.delete(payload.item.call_id)
      }
      if (payload.type === 'response.create' || payload.type === 'response.item.create') {
        responseCommandIds.add(encoded.event_id)
        if (responseCommandIds.size > 200) responseCommandIds.delete(responseCommandIds.values().next().value)
      }
      if (payload.type === 'session.commentary.append') {
        if (relaying) {
          relayIds.add(encoded.event_id)
          if (relayIds.size > 32) relayIds.delete(relayIds.values().next().value)
        } else {
          remember(commentaryRequests, encoded.event_id, id('say'))
        }
      }
      if (payload.type === 'response.item.create') {
        const bytes = utf8Bytes(encoded.item)
        ledger.charge(bytes)
        remember(sentItems, encoded.event_id, { item: encoded.item, bytes, responseCreateId: '' })
        pendingBatch.push(encoded.event_id)
      } else if (payload.type === 'response.create') {
        let userTurn = false
        for (const itemEventId of pendingBatch) {
          const sent = sentItems.get(itemEventId)
          if (sent) sent.responseCreateId = encoded.event_id
          if (sent?.item?.type === 'message' && sent.item.role === 'user') userTurn = true
        }
        pendingBatch = []
        if (userTurn) armStall()
      }
      if (payload.type === 'session.input_audio.append' && !fillingSilence) lastRealAudioAt = now()
      if (fillingSilence) {
        keepaliveIds.add(encoded.event_id)
        if (keepaliveIds.size > 64) keepaliveIds.delete(keepaliveIds.values().next().value)
      }
      if (trace && payload.type !== 'session.input_audio.append') trace(traceLine('>>', encoded))
      return encoded
    },

    normalizeIncoming: event => {
      if (trace && event?.type !== 'session.output_audio.delta') trace(traceLine('<<', event))
      return trackResponses(normalizeEvent(event))
    },

    // Sent on the raw socket before encodeOutgoing applies, so stamp the id here;
    // a startup error echoes it as error.client_event_id.
    connectionMessages: ({ session }) => {
      lastStartSession = session ?? null
      lastDelegationJson = JSON.stringify(session?.delegation ?? null)
      const start = { type: 'session.start', event_id: eventId(), session }
      if (trace) trace(traceLine('>>', start))
      return [start]
    },

    // Only delegation.responses may change after startup (tools, backend
    // prompt). Send the complete delegation block, and only when it differs
    // from what the service already has; start-time fields are never resent.
    sessionUpdate: session => {
      const delegation = session?.delegation
      if (!delegation || delegation.type !== 'responses') return null
      const json = JSON.stringify(delegation)
      if (json === lastDelegationJson) return null
      lastDelegationJson = json
      return { type: 'session.update', session: { delegation } }
    },

    sessionClose: () => {
      stopKeepalive()
      clearRelay()
      clearStall()
      return { type: 'session.close' }
    },

    // Nothing in flight on either layer: no spoken segment, user utterance,
    // speak request, backend work or result the voice layer still owes.
    isQuiescent: () => !voiceResponseId && !inputItemId && !outputIdleTimer && !inputIdleTimer
      && commentaryRequests.size === 0 && backendResponses.size === 0 && delegationResponses.size === 0
      && !awaitingBackend && pendingFunctionCalls.size === 0 && !(now() < voiceOwedUntil) && !relayTimer,

    audioAppend: audio => ({ type: 'session.input_audio.append', audio }),

    inputMute: () => ({ type: 'session.input_audio.mute' }),
    inputUnmute: () => ({ type: 'session.input_audio.unmute' }),

    imageAppend: () => null,
    clearImageBuffer: () => {},

    conversationItemId: () => id('item'),

    // Tool results, typed text, injected results and permission requests all go
    // to the delegated backend as Responses input items.
    conversationItemCreate: item => {
      const backend = backendItem(item)
      if (!backend) return null
      if (backend.type === 'function_call_output' && backend.call_id) remember(originals, backend.call_id, backend)
      const fitted = fitToBudget(backend)
      if (!fitted) {
        if (typeof emit === 'function') {
          queueMicrotask(() => emit({
            type: 'error',
            error: { type: 'invalid_request_error', code: 'backend_input_budget_exhausted', message: BACKEND_INPUT_FULL_HINT },
          }))
        }
        return null
      }
      return { type: 'response.item.create', item: fitted }
    },

    // response.create carries no instructions in the Live API; the Gateway
    // creates this item first and then requests the response.
    responseInstructionsItem: response => {
      const instructions = String(response?.instructions || '').trim()
      // Instructions the provider already placed in the backend prompt are not
      // repeated as items: each item counts against the session budget.
      if (!instructions || response?.__liveSay || standing.has(instructions)) return null
      return {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: instructions }],
      }
    },

    // A buildSpeakResponse payload is spoken by the voice layer through a
    // commentary append; anything else runs or continues the backend response.
    responseCreate: response => {
      const say = clampCommentary(response?.__liveSay)
      if (say) {
        return { type: 'session.commentary.append', delegation_id: null, content: say }
      }
      return { type: 'response.create' }
    },

    correlateResponseCreate: payload => payload,
    responseCorrelationId: () => '',

    // Checked again by the session when the requested restart runs.
    restartSafe: () => backendIdle(),

    // The Live model owns turn-taking and barge-in; there is no client cancel.
    // A Gateway cancel closes the adapter's playback records so the runtime
    // frees them; backend responses keep running as they do on the service.
    // The close is delivered asynchronously like a wire event.
    responseCancel: () => {
      // A cut answer still streaming under the tail drop is speech as well.
      const speaking = Boolean(voiceResponseId)
        || (cancelTail && now() - cancelTailVoicedAt < CANCEL_TAIL_QUIET_MS)
      if (dropCancelledTail && speaking) {
        cancelTail = true
        cancelTailVoicedAt = now()
        cancelTailRequestAt = 0
      }
      if (restartOnCancel && speaking) restartArmed = true
      clearOutputIdle()
      // What was heard of the cut segment is recorded once, as on a barge-in,
      // and none of it is carried into the next answer.
      const transcriptDone = voiceTranscriptDone()
      voiceResponseId = ''
      voiceTranscript = ''
      heldSilentDelta = ''
      lastOutputEndMs = -Infinity
      const cancelled = [...playbackResponses]
      for (const responseId of cancelled) {
        openResponses.delete(responseId)
        playbackResponses.delete(responseId)
      }
      if ((transcriptDone || cancelled.length) && typeof emit === 'function') {
        queueMicrotask(() => {
          if (transcriptDone) emit(transcriptDone)
          for (const responseId of cancelled) {
            emit({
              type: 'response.done',
              response: { id: responseId, status: 'cancelled' },
              response_id: responseId,
            })
          }
        })
      }
      maybeRestart()
      return null
    },

    userTextItem: text => ({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    }),

    functionOutputItem: (callId, output) => ({
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(output),
    }),
  })
}
