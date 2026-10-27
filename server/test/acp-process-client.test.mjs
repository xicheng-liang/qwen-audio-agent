import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { AcpProcessClient } from '../src/backend/adapters/acp/process-client.mjs'
import { openClawBackendDriver } from '../src/backend/adapters/acp/drivers/openclaw.mjs'

test('starts a Windows batch ACP command from a directory containing spaces', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-audio-acp-'))
  try {
    const directory = join(root, 'Agent Tools')
    mkdirSync(directory)
    const argsPath = join(directory, 'args.json')
    writeFileSync(join(directory, 'agent.mjs'), [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)))`,
      "process.stderr.write('spaced agent stopped\\n')",
      'process.exit(1)',
      '',
    ].join('\n'))
    const command = join(directory, 'agent.cmd')
    writeFileSync(command, `@"${process.execPath}" "%~dp0agent.mjs" %*\r\n`)
    const args = ['--acp', '--config', join(root, 'Agent Config', 'agent.json')]
    const client = new AcpProcessClient({ label: 'Spaced Agent', command, args })

    await assert.rejects(client.start(), /Spaced Agent ACP .*spaced agent stopped/)
    assert.deepEqual(JSON.parse(readFileSync(argsPath, 'utf8')), args)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('keeps session object identity stable across re-registration', () => {
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'unused',
  })
  const first = client.rememberSession('sess-1', { role: 'coordinator' })
  // adapter 在同一引用上维护运行时路由字段（如权限事件回调）。
  const onEvent = () => {}
  first.onEvent = onEvent
  first.coordinationRunId = 'work_current'

  // resume 重新注册后必须仍是同一对象，否则权限请求会拿到
  // 旧闭包快照，被路由到已完成的旧任务上。
  const second = client.rememberSession('sess-1', { cwd: '/next' })
  assert.equal(second, first)
  assert.equal(client.sessions.get('sess-1'), first)
  assert.equal(second.onEvent, onEvent)
  assert.equal(second.coordinationRunId, 'work_current')
  assert.equal(second.cwd, '/next')
  assert.equal(second.role, 'coordinator')
})

test('forgets a Session after cancelling when ACP close is unsupported', async () => {
  const client = new AcpProcessClient({ label: 'Test Agent', command: 'unused' })
  const cancelled = []
  client.start = async () => {}
  client.initializeResult = { agentCapabilities: { sessionCapabilities: {} } }
  client.cancelSession = async sessionId => { cancelled.push(sessionId) }
  client.rememberSession('sess-cancel')

  await client.closeSession('sess-cancel')

  assert.deepEqual(cancelled, ['sess-cancel'])
  assert.equal(client.sessions.has('sess-cancel'), false)
})

test('forgets a Session and falls back to cancel when ACP close fails', async () => {
  const client = new AcpProcessClient({ label: 'Test Agent', command: 'unused' })
  const cancelled = []
  client.start = async () => {}
  client.initializeResult = {
    agentCapabilities: { sessionCapabilities: { close: {} } },
  }
  client.request = async () => { throw new Error('close failed') }
  client.cancelSession = async sessionId => { cancelled.push(sessionId) }
  client.rememberSession('sess-failed-close')

  await assert.rejects(client.closeSession('sess-failed-close'), /close failed/)

  assert.deepEqual(cancelled, ['sess-failed-close'])
  assert.equal(client.sessions.has('sess-failed-close'), false)
})

test('shares an in-flight ACP initialization across concurrent callers', async () => {
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'unused',
  })
  let finishInitialization
  const initialized = {
    protocolVersion: 1,
    agentInfo: { name: 'test-agent' },
  }
  client.startProcess = () => {
    client.context = {}
    client.child = { exitCode: null }
    return new Promise(resolve => {
      finishInitialization = () => {
        client.initializeResult = initialized
        resolve(initialized)
      }
    })
  }

  const first = client.start()
  const second = client.start()
  finishInitialization()

  assert.equal(await first, initialized)
  assert.equal(await second, initialized)
})

test('preserves ENOENT when a local ACP executable cannot be spawned', {
  skip: process.platform === 'win32',
}, async () => {
  const client = new AcpProcessClient({
    label: 'Missing Agent',
    command: '__qwen_audio_agent_missing_acp__',
  })

  await assert.rejects(client.start(), error => {
    assert.equal(error.code, 'ENOENT')
    assert.equal(error.cause?.code, 'ENOENT')
    return true
  })
})

test('starts a POSIX ACP backend in a dedicated process group', async () => {
  let options
  const child = new EventEmitter()
  Object.assign(child, {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {},
  })
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'test-agent',
    platform: 'darwin',
    killImpl() {
      const error = new Error('missing process group')
      error.code = 'ESRCH'
      throw error
    },
    spawnImpl(_command, _args, spawnOptions) {
      options = spawnOptions
      process.nextTick(() => {
        const error = new Error('test spawn failure')
        error.code = 'ENOENT'
        child.emit('error', error)
      })
      return child
    },
  })

  await assert.rejects(client.start(), /进程启动失败/)
  assert.equal(options.detached, true)
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe'])
})

test('preserves native stderr when ACP closes during initialization', async () => {
  const client = new AcpProcessClient({
    label: 'Native Agent',
    command: process.execPath,
    args: ['-e', "process.stderr.write('native configuration required\\n')"],
  })

  await assert.rejects(
    client.start(),
    /Native Agent ACP .*native configuration required/,
  )
})

test('escalates from SIGTERM to SIGKILL for a surviving POSIX process group', async () => {
  const signals = []
  let alive = true
  const child = {
    pid: 4242,
    exitCode: 0,
    signalCode: null,
    kill() {
      assert.fail('dedicated process groups should not fall back to child.kill')
    },
  }
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'unused',
    platform: 'darwin',
    killImpl(pid, signal) {
      assert.equal(pid, -4242)
      if (signal === 0) {
        if (alive) return
        const error = new Error('gone')
        error.code = 'ESRCH'
        throw error
      }
      signals.push(signal)
      if (signal === 'SIGKILL') alive = false
    },
  })

  await client.stopProcessTree(child, 1)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})

test('uses taskkill tree cleanup on Windows and forces only after failure', async () => {
  const calls = []
  let unrefCalls = 0
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'unused',
    platform: 'win32',
    treeSpawnImpl(command, args, options) {
      calls.push([command, args, options])
      const killer = new EventEmitter()
      killer.unref = () => { unrefCalls += 1 }
      process.nextTick(() => killer.emit('exit', calls.length === 1 ? 1 : 0))
      return killer
    },
  })

  await client.stopProcessTree({ pid: 4242 })
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [
    ['taskkill', ['/PID', '4242', '/T']],
    ['taskkill', ['/PID', '4242', '/T', '/F']],
  ])
  assert.equal(calls.every(call => call[2].windowsHide), true)
  assert.equal(unrefCalls, 0)
})

test('applies backend-specific ACP error and output formatting hooks', async () => {
  const profile = openClawBackendDriver.createProfile({
    root: '/repo',
    directory: '/work',
    baseUrl: 'http://127.0.0.1:18789',
    tokenFile: '/state/gateway-token',
  })
  const client = new AcpProcessClient({
    label: profile.label,
    command: 'unused',
    sanitizeProcessOutput: profile.sanitizeProcessOutput,
    formatRequestError: profile.formatRequestError,
  })
  client.start = async () => {}
  client.context = {
    async request() {
      const error = new Error('Internal error')
      error.name = 'RequestError'
      error.code = -32603
      error.data = { details: 'missing scope: operator.write' }
      throw error
    },
  }
  client.appendStderr(
    '\u001b[1;36m🦞 [openclaw-bundle]\u001b[0m SafeMode Active\n',
  )

  await assert.rejects(
    client.request('session/prompt', {}),
    error => {
      assert.match(
        error.message,
        /需要在 OpenClaw 中批准 ACP 设备权限（缺少 operator\.write）/,
      )
      assert.doesNotMatch(error.message, /Internal error|openclaw-bundle|\u001b/)
      assert.equal(error.body, 'missing scope: operator.write')
      return true
    },
  )
})

test('preserves diagnostics written during a failed ACP request', async () => {
  const profile = openClawBackendDriver.createProfile({
    root: '/repo',
    directory: '/work',
    baseUrl: 'http://127.0.0.1:18789',
    tokenFile: '/state/gateway-token',
  })
  const client = new AcpProcessClient({
    label: profile.label,
    command: 'unused',
    sanitizeProcessOutput: profile.sanitizeProcessOutput,
    formatRequestError: profile.formatRequestError,
  })
  client.start = async () => {}
  client.appendStderr('[diagnostic] earlier healthy message\n')
  client.context = {
    async request() {
      client.appendStderr(
        '[diagnostic] reply session initialization conflicted for agent:main:test\n',
      )
      const error = new Error('Internal error')
      error.name = 'RequestError'
      error.code = -32603
      throw error
    },
  }

  await assert.rejects(
    client.request('session/prompt', {}),
    error => {
      assert.match(
        error.body,
        /reply session initialization conflicted for agent:main:test/,
      )
      assert.doesNotMatch(error.body, /earlier healthy message/)
      return true
    },
  )
})

test('pauses the prompt timeout while waiting for user permission', async () => {
  let resolvePermission
  let finishPrompt
  let promptSettled = false
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'unused',
    onPermission: () => new Promise(resolve => {
      resolvePermission = resolve
    }),
  })
  client.start = async () => {}
  client.context = {
    request: (_method, _params, { signal }) => new Promise(
      (resolve, reject) => {
        finishPrompt = () => resolve({ stopReason: 'end_turn' })
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      },
    ),
    notify: async () => {},
  }
  client.sessions.set('session-one', { sessionId: 'session-one' })

  const prompting = client.prompt('session-one', 'inspect project', {
    timeoutMs: 30,
  }).finally(() => {
    promptSettled = true
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  const permission = client.handlePermission({
    sessionId: 'session-one',
  }, new AbortController().signal)

  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(promptSettled, false)

  resolvePermission({ outcome: { outcome: 'selected', optionId: 'allow' } })
  await permission
  finishPrompt()
  assert.deepEqual(await prompting, {
    content: '',
    contentBlocks: [],
    response: { stopReason: 'end_turn' },
  })
})

test('pauses the prompt timeout while waiting for elicited input', async () => {
  let resolveInput
  let finishPrompt
  let promptSettled = false
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'unused',
    onElicitation: () => new Promise(resolve => {
      resolveInput = resolve
    }),
  })
  client.start = async () => {}
  client.context = {
    request: (_method, _params, { signal }) => new Promise(
      (resolve, reject) => {
        finishPrompt = () => resolve({ stopReason: 'end_turn' })
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      },
    ),
    notify: async () => {},
  }
  client.sessions.set('session-one', { sessionId: 'session-one' })

  const prompting = client.prompt('session-one', 'inspect project', {
    timeoutMs: 30,
  }).finally(() => {
    promptSettled = true
  })
  await new Promise(resolve => setTimeout(resolve, 10))
  const elicitation = client.handleElicitation({
    sessionId: 'session-one',
    mode: 'form',
    message: 'Choose an output language',
  }, new AbortController().signal)

  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(promptSettled, false)

  resolveInput({ action: 'accept', content: { language: 'zh' } })
  await elicitation
  finishPrompt()
  assert.deepEqual(await prompting, {
    content: '',
    contentBlocks: [],
    response: { stopReason: 'end_turn' },
  })
})

test('reports a prompt timeout even when the Agent confirms cancellation', async () => {
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'unused',
  })
  client.start = async () => {}
  client.context = {
    request: (_method, _params, { signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => {
        resolve({ stopReason: 'cancelled' })
      }, { once: true })
    }),
    notify: async () => {},
  }
  client.sessions.set('session-one', { sessionId: 'session-one' })

  const keepAlive = setTimeout(() => {}, 50)
  try {
    await assert.rejects(
      client.prompt('session-one', 'inspect project', { timeoutMs: 10 }),
      error => {
        assert.equal(error.status, 504)
        assert.match(error.message, /Test Agent ACP 请求超时（10 毫秒）/)
        return true
      },
    )
  } finally {
    clearTimeout(keepAlive)
  }
})

test('keeps Session metadata on the process client boundary', async () => {
  const calls = []
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'unused',
  })
  client.start = async () => {}
  client.context = {
    async request(method, params) {
      calls.push([method, params])
      if (method === 'session/new') return { sessionId: 'session-one' }
      return {}
    },
  }
  const meta = { sessionKey: 'agent:voice:coordinator' }

  const session = await client.newSession({
    cwd: '/workspace',
    meta,
  })
  assert.equal(session.meta, meta)
  assert.deepEqual(calls.at(-1)[0], 'session/new')
})

test('rejects an MCP transport the Agent did not advertise', async () => {
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'unused',
  })
  client.initializeResult = {
    agentCapabilities: { mcpCapabilities: { http: false } },
  }
  client.start = async () => client.initializeResult
  client.context = {
    async request() {
      assert.fail('session/new must not be sent')
    },
  }

  await assert.rejects(
    client.newSession({
      cwd: '/workspace',
      mcpServers: [{ type: 'http', name: 'tools', url: 'http://tools' }],
    }),
    /未声明支持 HTTP MCP/,
  )
})

test('sends multimodal ContentBlocks unchanged after capability negotiation', async () => {
  const calls = []
  const client = new AcpProcessClient({ label: 'Test Agent', command: 'unused' })
  client.initializeResult = {
    agentCapabilities: { promptCapabilities: { image: true } },
  }
  client.start = async () => client.initializeResult
  client.context = {
    async request(method, params) {
      calls.push([method, params])
      return { stopReason: 'end_turn' }
    },
    async notify() {},
  }
  const prompt = [
    { type: 'text', text: 'inspect' },
    { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
  ]
  await client.prompt('session-image', prompt)
  assert.deepEqual(calls[0][1].prompt, prompt)
})

test('preserves all ACP agent message ContentBlocks in prompt results', async () => {
  const client = new AcpProcessClient({ label: 'Test Agent', command: 'unused' })
  client.start = async () => {}
  client.context = {
    async request() {
      client.handleUpdate({
        sessionId: 'session-output',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '分析完成。' },
        },
      })
      client.handleUpdate({
        sessionId: 'session-output',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'image',
            mimeType: 'image/png',
            data: 'aGVsbG8=',
          },
        },
      })
      return { stopReason: 'end_turn' }
    },
    async notify() {},
  }

  const result = await client.prompt('session-output', 'inspect')

  assert.equal(result.content, '分析完成。')
  assert.deepEqual(result.contentBlocks, [
    { type: 'text', text: '分析完成。' },
    { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
  ])
  assert.equal(result.response.stopReason, 'end_turn')
})

function withFinalTextOnly(t, value = 'on') {
  const before = process.env.GPT_LIVE_1_FINAL_TEXT_ONLY
  if (value === null) delete process.env.GPT_LIVE_1_FINAL_TEXT_ONLY
  else process.env.GPT_LIVE_1_FINAL_TEXT_ONLY = value
  t.after(() => {
    if (before === undefined) delete process.env.GPT_LIVE_1_FINAL_TEXT_ONLY
    else process.env.GPT_LIVE_1_FINAL_TEXT_ONLY = before
  })
}

test('prompt result is the text after the last tool call, not the narration before it', async t => {
  withFinalTextOnly(t)
  const client = new AcpProcessClient({ label: 'Test Agent', command: 'unused' })
  client.start = async () => {}
  const say = text => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  client.context = {
    async request() {
      for (const update of [
        say('Only the target exists; '),
        say('delete it.'),
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'rm', status: 'pending' },
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
        say('已删除桌面上的暗号.txt。'),
      ]) client.handleUpdate({ sessionId: 'session-narration', update })
      return { stopReason: 'end_turn' }
    },
    async notify() {},
  }

  const result = await client.prompt('session-narration', 'delete it')

  assert.equal(result.content, '已删除桌面上的暗号.txt。')
})

test('a prompt that ends on a tool call keeps the last text it said', async t => {
  withFinalTextOnly(t)
  const client = new AcpProcessClient({ label: 'Test Agent', command: 'unused' })
  client.start = async () => {}
  client.context = {
    async request() {
      client.handleUpdate({
        sessionId: 'session-tail-tool',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } },
      })
      client.handleUpdate({
        sessionId: 'session-tail-tool',
        update: { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'cleanup', status: 'pending' },
      })
      return { stopReason: 'end_turn' }
    },
    async notify() {},
  }

  const result = await client.prompt('session-tail-tool', 'go')

  assert.equal(result.content, 'Done.')
})

function declineHarness(t, { knob, choose }) {
  const before = process.env.GPT_LIVE_1_DECLINE_ENDS_TASK
  if (knob === undefined) delete process.env.GPT_LIVE_1_DECLINE_ENDS_TASK
  else process.env.GPT_LIVE_1_DECLINE_ENDS_TASK = knob
  t.after(() => {
    if (before === undefined) delete process.env.GPT_LIVE_1_DECLINE_ENDS_TASK
    else process.env.GPT_LIVE_1_DECLINE_ENDS_TASK = before
  })
  const client = new AcpProcessClient({
    label: 'Test Agent',
    command: 'unused',
    onPermission: async () => ({ outcome: { outcome: 'selected', optionId: choose } }),
  })
  client.start = async () => {}
  client.context = {
    async request() {
      await client.handlePermission({
        sessionId: 'session-decline',
        options: [
          { optionId: 'allow', kind: 'allow_once' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      })
      throw new Error('Internal error: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use')
    },
    async notify() {},
  }
  return client
}

test('GPT_LIVE_1_DECLINE_ENDS_TASK turns the failure after a declined permission into a result', async t => {
  const client = declineHarness(t, { knob: 'on', choose: 'reject' })
  const result = await client.prompt('session-decline', 'delete the file')
  assert.equal(result.content, '用户拒绝了这项操作，后台没有执行。')
  assert.equal(result.response.stopReason, 'end_turn')
})

test('a declined permission still fails the prompt when GPT_LIVE_1_DECLINE_ENDS_TASK is off', async t => {
  const client = declineHarness(t, { knob: undefined, choose: 'reject' })
  await assert.rejects(client.prompt('session-decline', 'delete the file'), /ede_diagnostic/)
})

test('an approved permission followed by a failure is still a failure', async t => {
  const client = declineHarness(t, { knob: 'on', choose: 'allow' })
  await assert.rejects(client.prompt('session-decline', 'delete the file'), /ede_diagnostic/)
})

test('a late status update of an earlier tool does not split the final answer', async t => {
  withFinalTextOnly(t)
  const client = new AcpProcessClient({ label: 'Test Agent', command: 'unused' })
  client.start = async () => {}
  const say = text => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  client.context = {
    async request() {
      for (const update of [
        say('Checking. '),
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', status: 'pending' },
        say('已删除。'),
        { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
        say('桌面上没有其他同名文件。'),
      ]) client.handleUpdate({ sessionId: 'session-late-update', update })
      return { stopReason: 'end_turn' }
    },
    async notify() {},
  }
  const result = await client.prompt('session-late-update', 'go')
  assert.equal(result.content, '已删除。桌面上没有其他同名文件。')
})

test('without GPT_LIVE_1_FINAL_TEXT_ONLY the result keeps every agent text chunk', async t => {
  withFinalTextOnly(t, null)
  const client = new AcpProcessClient({ label: 'Test Agent', command: 'unused' })
  client.start = async () => {}
  const say = text => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  client.context = {
    async request() {
      for (const update of [
        say('Only the target exists; delete it.'),
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'rm', status: 'pending' },
        say('已删除。'),
      ]) client.handleUpdate({ sessionId: 'session-knob-off', update })
      return { stopReason: 'end_turn' }
    },
    async notify() {},
  }
  const result = await client.prompt('session-knob-off', 'go')
  assert.equal(result.content, 'Only the target exists; delete it.已删除。')
})

test('a cancelled permission outcome is not a decline', async t => {
  const client = declineHarness(t, { knob: 'on', choose: 'reject' })
  client.onPermission = async () => ({ outcome: { outcome: 'cancelled' } })
  await assert.rejects(client.prompt('session-decline', 'delete the file'), /ede_diagnostic/)
})

test('after a decline, an unrelated failure still fails the prompt', async t => {
  const client = declineHarness(t, { knob: 'on', choose: 'reject' })
  const request = client.context.request
  client.context.request = async (...args) => {
    try { await request(...args) } catch { throw new Error('relay connection lost') }
  }
  await assert.rejects(client.prompt('session-decline', 'delete the file'), /relay connection lost/)
})

test('returns ACP stop reasons without interpreting Gateway task state', async () => {
  const client = new AcpProcessClient({ label: 'Test Agent', command: 'unused' })
  client.start = async () => {}
  client.context = {
    async request() {
      return { stopReason: 'refusal' }
    },
    async notify() {},
  }

  const result = await client.prompt('session-refusal', 'inspect')

  assert.equal(result.response.stopReason, 'refusal')
  assert.equal(result.content, '')
  assert.deepEqual(result.contentBlocks, [])
})
