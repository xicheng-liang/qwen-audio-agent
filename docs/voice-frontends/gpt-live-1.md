# GPT-Live 1 (OpenAI Live API)

qwen-audio-agent can use OpenAI's GPT-Live 1 as a cloud voice frontend.
GPT-Live 1 is a full-duplex model served by the Live API, a different wire
protocol from the Realtime API used by the `gpt-live` provider: the voice model
listens while it speaks and delegates reasoning and tool use to a backend.
Gateway still owns frontend tools, memory, reminders, task delegation, and
backend-Agent orchestration; the provider adapter maps the Live API event stream
onto the shared runtime.

## Configuration

Edit the user configuration file shown by `qwenaudio config`:

```dotenv
QWEN_AUDIO_REALTIME_PROVIDER=gpt-live-1
OPENAI_API_KEY=your-openai-key
```

| Optional setting | Default | Description |
| --- | --- | --- |
| `GPT_LIVE_1_REALTIME_URL` / `OPENAI_LIVE_URL` | `wss://api.openai.com/v1/live/sessions` | Live API WebSocket endpoint |
| `GPT_LIVE_1_REALTIME_MODEL` | `gpt-live-1` | Voice model; behind Azure, the deployment name |
| `GPT_LIVE_1_REALTIME_VOICE` | Empty | Service default (`marin`), or a voice supported by the model |
| `GPT_LIVE_1_API_KEY` | Empty | Takes precedence over `OPENAI_API_KEY` when the Live frontend needs its own credential; the desktop writes this variable, and a present but empty value disables the `OPENAI_API_KEY` fallback |
| `GPT_LIVE_1_DELEGATION_MODEL` | `gpt-5.6-terra` | Responses model that reasons and calls Gateway tools |
| `GPT_LIVE_1_DELEGATION_INSTRUCTIONS` | Built in | Replaces the backend prompt frame; the Gateway task instructions and the rules for injected Gateway messages are always appended |
| `GPT_LIVE_1_VOICE_INSTRUCTIONS` | Built in | Replaces the voice-layer prompt (persona and hand-off rules) |
| `GPT_LIVE_1_OUTPUT_IDLE_MS` | `800` | Silence after which a spoken segment counts as finished |
| `GPT_LIVE_1_TRACE_EVENTS` | Empty | `1` logs every Live API event in both directions to stderr as shapes, ids, codes and sizes; conversation content (prompts, transcripts, tool output, audio) is replaced by its length (integration debugging) |
| `GPT_LIVE_1_TOOL_OUTPUT_MAX_BYTES` | Empty | Hard cap on one backend input item (a tool result, typed text). By default an item may use half of what is left of the session's backend input budget |
| `GPT_LIVE_1_IDLE_CLOSE_MS` | `0` (off) | Closes the Live session after this long with nothing in flight and reopens it on the next request, because the service bills for the time a session is open. Values below `10000` are raised to `10000` |
| `GPT_LIVE_1_DROP_SPONTANEOUS_SPEECH` | off | Set to `1` to drop speech the voice layer starts on its own while a text-only client (no input audio for 10 s) has nothing pending, such as a stray backchannel after an answer |

Desktop exposes the endpoint, key, model, and voice fields under
**Voice frontend → GPT-Live 1**. Restart a terminal Gateway after editing the
file; for an installed service, run `qwenaudio gateway restart`.

### Behind a gateway or Azure

Endpoint and credential are configuration, not code. To reach GPT-Live 1
through Azure OpenAI or an API gateway in front of it, point
`GPT_LIVE_1_REALTIME_URL` at that service's `/openai/v1/live/sessions` path,
set `GPT_LIVE_1_API_KEY` to the key it issues, and set
`GPT_LIVE_1_REALTIME_MODEL` to the deployment name. Azure resolves the
delegated Responses model the same way, so `GPT_LIVE_1_DELEGATION_MODEL` must
name a text-model deployment on the same resource. The adapter sends the same
`session.start` and `Authorization: Bearer` header either way.

## Integration boundary

- The adapter connects over WebSocket and sends `session.start`; the model
  travels inside the session configuration, not as a URL parameter.
  Authentication uses `Authorization: Bearer ...`.
- Input and output are raw mono 24 kHz PCM16 carried in
  `session.input_audio.append` and `session.output_audio.delta`. Client audio is
  resampled by the Gateway client before it reaches the provider.
- Tool calls use Responses delegation. Gateway registers its function tools in
  `delegation.responses.tools`; the delegated model's function calls arrive in
  `response.event` envelopes, Gateway executes them, and results return with
  `response.item.create` followed by `response.create`.
- The prompt is split as the prompting guide recommends: the voice layer gets
  the persona plus the Backchannel, Interruption and Delegation policy sections
  (with the backend capability list); the delegated model gets the full
  frontend instructions inside the documented backend prompt skeleton.
- Recent conversation history is seeded through `session.input` at startup:
  the most recent text messages within a token budget kept below the
  documented 8,192-token limit. If the service rejects the seeded history at
  startup, the next connect omits it. Later changes to the tools or backend
  prompt go out as `session.update` carrying only the `delegation` block, and
  only when it changed; start-time fields are never resent.
- Task results, permission requests, and typed text reach the delegated model
  as `response.item.create` items followed by `response.create`, so it can
  integrate them and answer through the voice layer. The Gateway's fixed
  guidance for such items is part of the backend prompt, so each injection is
  a single item. Short Gateway announcements are spoken directly with
  `session.commentary.append`, which accepts at most 500 tokens; the speak
  request settles on the `session.commentary.appended` acknowledgement, the
  only completion signal the wire offers.
- The Live API has no turn-complete or response-done event. The adapter closes a
  spoken segment when output stays quiet for `GPT_LIVE_1_OUTPUT_IDLE_MS`, when
  the user starts speaking, or when the output timeline jumps. Interruption is
  handled by the model itself; there is no `response.cancel`, so a Gateway
  cancel only closes the adapter's open response records.
- User turns are synthesised from the timed transcript fragments in the GA
  order. A new turn (`speech_started`) opens only for speech that began after
  the current or last answer began and more than 1.2 s after the previous
  fragment ended; while the answer still plays that is a barge-in and its
  playback record closes as cancelled. The model keeps speaking for a moment
  after a barge-in; output that still overlaps the user's speech and continues
  the cut answer's timeline is dropped, since the runtime already discarded
  that audio. Any other fragment belongs to the
  question, however late it arrives: it continues the open utterance, or
  silently reopens the completed one so the caption grows without a turn (the
  runtime clears playback on every `speech_started`). The turn is committed
  (`speech_stopped`, `committed`) as soon as the assistant starts answering or
  input stays quiet for 1.5 s, and the transcript completes on that quiet
  period. The answer's start time comes from output audio timing where the
  transport sends it and from output transcript timing otherwise; with
  neither, turns fall back to arrival order. `session.delegation.created`
  marks no turn boundary.
- User speech never supersedes backend work: a Gateway cancel closes voice
  playback records only, the delegated backend response and the Gateway
  requests waiting on it keep running, and the backend's tool calls are
  answered even after a new user turn, because the service refuses
  `response.create` while a call is unanswered.
- With `GPT_LIVE_1_IDLE_CLOSE_MS` set, an idle session is closed with
  `session.close` and reopened by the next request: typed text, a task result
  or reminder, a permission or input request, or a Gateway delivery. It never
  closes while a turn, playback, tool call, backend task or announcement is
  open. The client connection stays up and sees no connection or state event;
  the first request after a close waits for one connect, and the new session
  starts from the seeded text history without that request, which it receives
  as input. Backend items of the closed session, such as tool outputs, are not
  carried over. If reopening fails, only the request that needed it fails.
- Beyond that seeded history no pre-connection context is injected, and live
  visual frames are not negotiated for this provider.

## Validation boundary

Local protocol tests cover session configuration, the client event encoding,
segmentation of spoken output, synthesised input turns, the delegated
function-call loop, the backend input budget with its repair path, the
full-duplex turn rules (late fragments, barge-in, cancel and tool-call
survival), announcement acknowledgement, idle closing, closing and reopening an idle
session, and a mock-service connection. Live model
behavior, voices, latency, quotas, and regional availability require a valid
account and are governed by OpenAI's current Live API documentation.

## Read next

- [GPT-Live / OpenAI Realtime](gpt-live.md)
- [Frontend configuration reference](../configuration/frontend.md)
- [Custom Provider](custom-provider.md)
