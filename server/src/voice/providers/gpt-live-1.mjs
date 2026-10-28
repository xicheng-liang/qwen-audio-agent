import { createHash } from 'node:crypto'
import { config } from '../../core/config.mjs'
import {
  realtimeModelCatalog,
  resolveRealtimeModelProfile,
} from '../../../../shared/realtime-model-catalog.mjs'
import { PERMISSION_DECISIONS } from '../../../../shared/permission-decisions.mjs'
import { frontendInputProjection, inputText } from '../../../../shared/input-parts.mjs'
import { resolveAssistantProfile } from '../../conversation/frontend-agent-context.mjs'
import {
  buildFrontendInstructions,
  frontendTools,
  inputRequestResponseInstructions,
  permissionResponseInstructions,
  progressResponseInstructions,
  resultResponseInstructions,
} from '../../frontend/frontend-tools.mjs'
import { isRecoverableRealtimeInactivityError } from '../realtime-errors.mjs'
import {
  createGptLive1Protocol,
  DEFAULT_OUTPUT_IDLE_MS,
  estimateTokens,
} from './gpt-live-1-protocol.mjs'

// GPT-Live-1 is OpenAI's full-duplex Live API (POST/WS /v1/live/sessions), a
// different wire protocol from the Realtime API that the `gpt-live` provider
// speaks. The voice model runs the conversation and delegates reasoning and
// tool use to a backend. We use Responses delegation with the Gateway's own
// frontend tools, so the same tool-call loop the other providers rely on still
// applies: the delegated Responses model requests a function, the Gateway
// executes it, and the result is returned for the voice layer to speak.
//
// Endpoint and credential are configuration, not code: the defaults target
// api.openai.com with a plain OpenAI key, and an internal AI gateway is reached
// by pointing GPT_LIVE_1_REALTIME_URL at its /openai/v1/live/sessions path with
// the gateway key. Nothing below is gateway-specific.

const DEFAULT_DELEGATION_MODEL = 'gpt-5.6-terra'

function modelProfile() {
  return resolveRealtimeModelProfile(config.gptLive1Model, 'gpt-live-1')
}

// The delegated Responses model reasons and calls the Gateway's tools. It is a
// separate model from the voice layer; pick it with GPT_LIVE_1_DELEGATION_MODEL.
function delegationModel() {
  return String(process.env.GPT_LIVE_1_DELEGATION_MODEL || '').trim()
    || DEFAULT_DELEGATION_MODEL
}

// The prompt is split, as the Live migration guide asks: the voice layer gets
// the persona and how to hand off; the delegated backend gets the full frontend
// instructions, which is where the tool guidance is acted on.
// One line per backend capability, so the voice model knows what it can hand
// off (the prompting guide's "Backend tools" list). Definitions stay in
// delegation.responses.tools.
function backendCapabilities(agentContext) {
  return frontendTools(agentContext).map(tool => {
    const description = String(tool.function.description || '').trim().split(/(?<=[.。!?！？])\s+/)[0]
    return `- ${tool.function.name}: ${description || 'backend action'}`
  })
}

// GPT_LIVE_1_QUIET_WAIT (off by default): asked to "say briefly that you are
// checking", the voice opened nearly every delegated reply, results included,
// with a line guessing the topic ("let me look at the file").
function waitPolicy() {
  if (!/^(1|on|true|yes)$/i.test(String(process.env.GPT_LIVE_1_QUIET_WAIT || '').trim())) {
    return ['Do not guess the result while waiting; say briefly that you are checking.']
  }
  return [
    'Before you hand a request to the backend, say a very short neutral',
    'acknowledgement at once, then wait. Never say what you are checking and',
    'never guess the result.',
    'When you speak a backend result, start with the result itself, with no lead-in.',
  ]
}

// GPT_LIVE_1_TEXT_CONTEXT (off by default): on the text uplink the voice layer
// never learned what the user said; mid-session text with the user role is
// not accepted (startup input only), so each turn's words are also given to
// the voice as factual context through session.thinking.append, the
// documented "add factual context without asking the model to say it".
const THINKING_MAX_CHARS = 900

function textContext() {
  return /^(1|on|true|yes)$/i.test(String(process.env.GPT_LIVE_1_TEXT_CONTEXT || '').trim())
}

export function userWordsContext(parts) {
  const said = Array.from(String(inputText(parts) || '').trim()).slice(0, THINKING_MAX_CHARS).join('')
  return said ? `The user just said: "${said}"` : ''
}

// GPT_LIVE_1_TEXT_UPLINK (off by default): on the earbud the user's words
// reach the backend as text and the voice layer hears only the silence
// keepalive, so it explained the silence ("I'm here, it seemed stuck, what
// did you say?") and then opened every reply that way.
function textUplinkPolicy() {
  if (!/^(1|on|true|yes)$/i.test(String(process.env.GPT_LIVE_1_TEXT_UPLINK || '').trim())) return []
  return [
    '',
    'Input policy: The user\'s words reach the backend as text, so you may hear',
    'only silence. That is normal. Never say the connection was stuck or slow,',
    'never say you did not hear, and never ask the user to repeat; the backend',
    'reply answers what they said. Do not open replies the same way each time.',
    ...(textContext()
      ? [
          'Each thing the user says is also given to you as context starting',
          '"The user just said". Use it to understand them, but let the backend',
          'answer: after a short acknowledgement, say what the backend returns.',
        ]
      : [
          'Because you cannot know what the user said, never answer by yourself:',
          'after the short acknowledgement, say only what the backend returns.',
        ]),
  ]
}

// Follows the GPT-Live prompting guide: persona, then the Backchannel,
// Interruption and Delegation policy sections. Task procedure and tool rules
// live in the backend prompt, not here.
function voiceInstructions(agentContext) {
  const custom = String(process.env.GPT_LIVE_1_VOICE_INSTRUCTIONS || '').trim()
  if (custom) return custom
  return [
    'You are the spoken voice of a personal assistant. Speak naturally and',
    'briefly, in the language the user speaks. Be clear and direct.',
    '',
    'Backchannel policy: Use moderate backchannels. Acknowledge naturally',
    'without competing with the main response.',
    '',
    'Interruption policy: Stop speaking when the user interrupts. Listen to',
    'what they say.',
    '',
    'Delegation policy:',
    'Backend tools:',
    ...backendCapabilities(agentContext),
    '',
    'Delegate to the backend when:',
    '- The request needs facts, tools, memory, schedules, files or any action.',
    '- A correction changes work already requested.',
    '- The answer needs careful reasoning beyond a brief reply.',
    '',
    'Do not delegate to the backend when:',
    '- You can answer from the conversation or a still-current backend result.',
    '- You need a brief clarification to understand the request.',
    '',
    'Delegate before giving an answer that depends on backend work.',
    ...waitPolicy(),
    'Only report an action as done when the backend result says it succeeded.',
    ...textUplinkPolicy(),
    '',
    '# Assistant Profile',
    '<assistant_profile authority="persona_only">',
    resolveAssistantProfile(agentContext),
    '</assistant_profile>',
  ].join('\n')
}

// Backend prompt skeleton from the delegation guide, wrapping the Gateway's
// full frontend instructions (tools, policies, task hand-off rules).
// The Gateway's fixed guidance for injected items lives here once, not as a
// user item per injection: every backend item counts against the session budget.
const STANDING_RESPONSE_INSTRUCTIONS = [
  resultResponseInstructions,
  progressResponseInstructions,
  permissionResponseInstructions,
  inputRequestResponseInstructions,
]

function delegationInstructions(agentContext) {
  const custom = String(process.env.GPT_LIVE_1_DELEGATION_INSTRUCTIONS || '').trim()
  return [
    ...(custom ? [custom] : [
      '## Voice conversation context',
      'You are the reasoning backend of a live voice assistant. Transcripts can',
      'contain mistakes, unfinished phrases and later corrections. Use the latest',
      'context and verified tool results. If a needed detail is unclear, ask for',
      'that detail instead of guessing.',
    ]),
    '',
    '## Task instructions',
    buildFrontendInstructions(agentContext),
    '',
    '## Gateway messages',
    'Some user-role items are inserted by the Gateway, not spoken by the user.',
    'Recognise them by their shape and handle each as follows.',
    `- A final result of earlier work: ${resultResponseInstructions}`,
    `- A progress update of earlier work: ${progressResponseInstructions}`,
    `- A <permission_request> block: ${permissionResponseInstructions}`,
    `- A follow-up question from running work: ${inputRequestResponseInstructions}`,
    ...(custom ? [] : [
      '',
      '## Return the result',
      'Return the relevant facts, the task status and the next step, concisely,',
      'for the voice layer to speak. Report an action as complete only after the',
      'tool confirms it. If the outcome is unclear, say so and what to check.',
      ...(matchLanguage() ? [
        'Write the reply in the language of the user\'s latest spoken message,',
        'even when the tool results or these instructions are in another language.',
      ] : []),
    ]),
  ].join('\n')
}

// GPT_LIVE_1_MATCH_LANGUAGE (off by default): the backend wrote its replies in
// the language of its (Chinese) instructions, so English questions got Chinese
// answers on the earbud.
function matchLanguage() {
  return /^(1|on|true|yes)$/i.test(String(process.env.GPT_LIVE_1_MATCH_LANGUAGE || '').trim())
}

// Startup history for session.input (text only). The Live API accepts up to
// 128 messages and 8,192 tokens; the token estimate is approximate, so keep a
// margin below the documented limit. Keeps the most recent turns that fit.
const SESSION_INPUT_MAX_MESSAGES = 64
const SESSION_INPUT_TOKEN_BUDGET = 6144

export function sessionInputHistory(messages = []) {
  const selected = []
  let used = 0
  for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'user' ? 'user' : ''
    const text = typeof message?.content === 'string' ? message.content.trim() : ''
    if (!role || !text) continue
    const tokens = estimateTokens(text)
    if (selected.length && (used + tokens > SESSION_INPUT_TOKEN_BUDGET
      || selected.length >= SESSION_INPUT_MAX_MESSAGES)) break
    if (!selected.length && tokens > SESSION_INPUT_TOKEN_BUDGET) break
    selected.unshift({
      type: 'message',
      role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
    })
    used += tokens
  }
  return selected
}

// Wire-level event trace on stderr (audio reduced to byte counts).
function traceEvents() {
  return String(process.env.GPT_LIVE_1_TRACE_EVENTS || '').trim() === '1'
}

// How long the voice layer must stay quiet before its spoken segment is closed.
function outputIdleMs() {
  const value = Number(process.env.GPT_LIVE_1_OUTPUT_IDLE_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_OUTPUT_IDLE_MS
}

// Close an idle Live session after this long; the next request reopens it. 0
// (default) = off. The floor covers the gap before the voice layer speaks a result.
const MIN_IDLE_CLOSE_MS = 10_000

// Drop speech the voice layer starts on its own while a text-only client has
// nothing pending (off by default).
function dropSpontaneousSpeech() {
  return String(process.env.GPT_LIVE_1_DROP_SPONTANEOUS_SPEECH || '').trim() === '1'
}

// Drop the rest of an answer a Gateway cancel cut (off by default): a text-only
// client cannot barge in, so the voice layer would finish it in the next answer.
function dropCancelledTail() {
  return String(process.env.GPT_LIVE_1_DROP_CANCELLED_TAIL || '').trim() === '1'
}

// Close and reopen the Live session when a Gateway cancel cuts speech with no
// backend work in flight (off by default): the voice layer keeps talking otherwise.
function restartOnCancel() {
  return String(process.env.GPT_LIVE_1_RESTART_ON_CANCEL || '').trim() === '1'
}

// Ask a user turn again on a fresh Live session when the voice layer has said
// nothing this long after the request (off by default; 2000 to 6000 ms).
function voiceStallMs() {
  const value = Number(process.env.GPT_LIVE_1_VOICE_STALL_MS)
  return Number.isFinite(value) && value > 0 ? Math.min(6000, Math.max(2000, Math.floor(value))) : 0
}

// Fixed gain on the voice output, 0.25 to 4 (default 1). Measured on the earbud:
// about 6 dB below the other providers, with about 10 dB of peak headroom.
function outputGain() {
  const value = Number(process.env.GPT_LIVE_1_OUTPUT_GAIN)
  return Number.isFinite(value) && value > 0 ? Math.min(4, Math.max(0.25, value)) : 1
}

function idleCloseMs() {
  const value = Number(process.env.GPT_LIVE_1_IDLE_CLOSE_MS)
  return Number.isFinite(value) && value > 0 ? Math.max(MIN_IDLE_CLOSE_MS, Math.floor(value)) : 0
}

// Optional hard cap on a single backend input item (a tool result, typed
// text). Without it an item may use its share of the session budget.
function backendItemMaxBytes() {
  const value = Number(process.env.GPT_LIVE_1_TOOL_OUTPUT_MAX_BYTES)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function delegationTools(agentContext) {
  return frontendTools(agentContext).map(tool => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))
}

// Seeded histories the service rejected at startup (error.param === 'input'),
// keyed by content so only a retry with that same history omits it. Keyed
// rather than flagged: every connection in the process shares this module.
const REJECTED_HISTORY_LIMIT = 16
const rejectedHistories = new Set()

function historyKey(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function rememberRejectedHistory(input) {
  if (!Array.isArray(input) || !input.length) return
  rejectedHistories.add(historyKey(input))
  while (rejectedHistories.size > REJECTED_HISTORY_LIMIT) {
    rejectedHistories.delete(rejectedHistories.values().next().value)
  }
}

// trimTrailingUser: a seed that ends with the user's message is answered at
// session start, so a reopen after a cancel drops the unanswered question.
function seededHistory(recentMessages, { trimTrailingUser = false } = {}) {
  const input = sessionInputHistory(recentMessages)
  while (trimTrailingUser && input.at(-1)?.role === 'user') input.pop()
  if (input.length && rejectedHistories.delete(historyKey(input))) return []
  return input
}

export const gptLive1Provider = {
  key: 'gpt-live-1',
  label: 'GPT-Live 1',
  aliases: ['gptlive1', 'openai-live'],
  // Live API input and output are both raw mono PCM16 at 24 kHz.
  inputSampleRate: 24000,
  outputSampleRate: 24000,
  createProtocol: context => createGptLive1Protocol({
    ...context,
    outputIdleMs: outputIdleMs(),
    dropSpontaneousSpeech: dropSpontaneousSpeech(),
    dropCancelledTail: dropCancelledTail(),
    restartOnCancel: restartOnCancel(),
    voiceStallMs: voiceStallMs(),
    outputGain: outputGain(),
    itemMaxBytes: backendItemMaxBytes(),
    standingInstructions: STANDING_RESPONSE_INSTRUCTIONS,
    onStartupError: (error, { session } = {}) => {
      if (error?.param === 'input') rememberRejectedHistory(session?.input)
    },
    trace: traceEvents() ? line => process.stderr.write(line) : null,
  }),
  capabilities: {
    // session.started is the only startup acknowledgement; there is no
    // session.updated unless a session.update is sent, so setup completes on
    // the mapped session.created rather than waiting for an ack.
    acknowledgesSessionUpdate: false,
    // Instructions, voice and history are fixed at session.start. A later
    // session.update may change delegation.responses (tools, backend prompt);
    // the protocol sends one only when that block actually changed.
    mutableSession: true,
    // Tool results are returned with response.item.create; the Live API does
    // not echo a conversation.item.created receipt, so do not wait for one.
    conversationItemIdEcho: false,
    acknowledgesConversationItems: false,
    // Pre-connection history goes into session.input at startup, the Live
    // API's own mechanism, not into a synthetic live user item.
    restoreConversationContext: false,
    // response.create carries no instructions; they travel as a backend item.
    perResponseInstructions: false,
    sessionOutputVoice: true,
    // The Live model keeps speaking while the backend works, so tool-result
    // continuations must not wait for the synthetic voice playback response.
    concurrentVoicePlayback: true,
  },

  model: () => config.gptLive1Model,
  modelProfile,
  // A deployment name is served alongside the catalog so clients can match the
  // active model's capabilities instead of reporting them unavailable.
  modelCatalog: () => {
    const profiles = realtimeModelCatalog('gpt-live-1').profiles
    const active = modelProfile()
    return profiles.some(profile => profile.id === active.id) ? profiles : [...profiles, active]
  },
  voice: () => config.gptLive1Voice || null,
  idleCloseMs,
  isConfigured: () => Boolean(config.gptLive1ApiKey),
  missingConfigurationMessage: '请先配置 GPT_LIVE_1_API_KEY',
  connectTimeoutMessage: '连接 GPT-Live 1 Live API 超时',
  url: () => config.gptLive1RealtimeUrl,
  headers: () => ({ Authorization: `Bearer ${config.gptLive1ApiKey}` }),
  // GPT_LIVE_1_CONNECT_RETRIES (0 = off): the internal AI gateway answers some
  // session starts with model_not_deployed and the next one succeeds; a failed
  // wake costs the user's turn, so try again at once.
  connectRetries: () => Math.min(8, Math.max(0, Number(process.env.GPT_LIVE_1_CONNECT_RETRIES) || 0)),
  retryConnect: message => /model[_ -]?not[_ -]?deployed/i.test(message),
  classifyError: message => {
    if (isRecoverableRealtimeInactivityError(message)) return 'inactivity'
    // Rejected session.update / append are per-command, not session-fatal.
    if (/immutable[_ -]?field|invalid[_ -]?audio|unknown[_ -]?field/i.test(message)) return 'other'
    if (/another response is in progress|already has an active response/i.test(message)) return 'response_slot_busy'
    if (/no (?:active|ongoing) response|no response.*cancel/i.test(message)) return 'no_active_response'
    if (/unexpected server response: 429|rate[_ -]?limit|too many (?:concurrent )?sessions|concurrent[_ -]?sessions?/i.test(message)) return 'capacity_busy'
    if (/invalid[_ -]?api[_ -]?key|authentication|unauthorized|forbidden|unexpected server response: (?:401|403)|model[_ -]?not[_ -]?found/i.test(message)) return 'fatal'
    if (/content[_ -]?(?:filter|moderation|safety|policy)|policy violation/i.test(message)) return 'content_safety'
    return 'other'
  },

  // GPT_LIVE_1_TEXT_CONTEXT: the user's words reach the voice as context too.
  projectUserInput: ({ parts, options, protocol }) => {
    if (!textContext()) return null
    const content = frontendInputProjection(parts, options)
    if (!content) return null
    const said = userWordsContext(parts)
    return {
      beforeEvents: said ? [{ type: 'session.thinking.append', delegation_id: null, content: said }] : [],
      conversationItem: protocol.userTextItem(content),
    }
  },

  buildSession: ({ agentContext, sessionOptions }) => {
    const voice = String(sessionOptions?.voice || config.gptLive1Voice || '').trim()
    const input = seededHistory(agentContext?.recentMessages, {
      trimTrailingUser: sessionOptions?.trimTrailingUser === true,
    })
    return {
      model: config.gptLive1Model,
      instructions: voiceInstructions(agentContext),
      ...(input.length ? { input } : {}),
      ...(voice ? { audio: { output: { voice } } } : {}),
      delegation: {
        type: 'responses',
        responses: {
          model: delegationModel(),
          instructions: delegationInstructions(agentContext),
          tools: delegationTools(agentContext),
          tool_choice: 'auto',
          parallel_tool_calls: true,
        },
      },
    }
  },

  // A short announcement is spoken directly by the voice layer: the protocol
  // turns this payload into session.commentary.append (capped at 500 tokens).
  buildSpeakResponse: content => ({ __liveSay: content }),

  // Task results and permission requests go to the delegated backend as user
  // items so it can integrate them (and call respond_permission later); the
  // voice layer then speaks the backend's reply. No append size cap applies.
  buildResultInjection: content => ({
    item: userTextItem(withReminderDueHint(content)),
    response: {},
  }),

  buildPermissionInjection: permission => ({
    item: userTextItem([
      '<permission_request>',
      `permission_id=${permission.id}`,
      `task_id=${permission.taskId}`,
      `operation=${permission.summary}`,
      `allowed_decisions=${PERMISSION_DECISIONS.join(',')}`,
      '</permission_request>',
    ].join('\n')),
    response: {},
  }),
}

// The backend tends to answer a due reminder with its bare content, which the
// voice layer, paraphrasing, took for a request to set one. Ask for the
// sentence to say instead.
const REMINDER_DUE_EVENT = '<gateway_system_event type="reminder.due">'
const REMINDER_DUE_HINT = 'The reminder is due now. Output only the one sentence to say to the user, '
  + 'in the language of the conversation, saying that the time is up and what to do '
  + '(for example: 时间到了，该喝水啦。).'

export function withReminderDueHint(content) {
  const text = String(content ?? '')
  return text.includes(REMINDER_DUE_EVENT) ? `${text}\n${REMINDER_DUE_HINT}` : text
}

function userTextItem(text) {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
}
