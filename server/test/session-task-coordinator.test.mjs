import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeliveryHarness, flush, startTask } from './helpers/task-session-harness.mjs'
import { createTaskAnnouncementRuntime } from '../src/voice/announcement/task-announcement-runtime.mjs'

function harness(t, options) {
  const h = createDeliveryHarness(options)
  t.after(async () => {
    h.coordinator.close()
    await Promise.all(h.taskManager.list({ active: true }).map(task => h.taskManager.cancel(task.id)))
  })
  return h
}

function permission(run, id = 'auth_1') {
  run.emit({ type: 'backend.permission.requested', permission: { id, status: 'pending', summary: 'read a file' } })
}

function input(run, id = 'input_1') {
  run.emit({ type: 'backend.input.requested', input: {
    id, status: 'pending', mode: 'form', prompt: 'Which format?',
    schema: { type: 'object', properties: { format: { type: 'string', enum: ['PDF', 'HTML'] } }, required: ['format'] },
  } })
}

test('permission delivery exposes the tool first, deduplicates, then resolves through the same Task', async t => {
  const h = harness(t)
  const run = await startTask(h)
  permission(run)
  h.coordinator.announcePendingPermissions()
  await flush()
  assert.deepEqual(h.order, ['tools', 'permission'])
  assert.equal(h.injectCalls.length, 1)
  assert.equal(h.coordinator.hasPendingPermission(), true)
  const call = h.injectCalls[0]
  assert.equal(call.context.taskId, run.task.id)
  assert.equal(call.context.authorizationId, 'auth_1')
  assert.match(call.context.turnId, /^gateway_/u)
  assert.match(call.text, /allowed_decisions=task,always,reject/u)
  assert.equal(call.options.contextTiming, 'immediate')
  assert.ok(call.options.instructions)
  assert.equal(call.options.shouldRespond(), true)
  run.emit({ type: 'backend.permission.resolved', permission: { id: 'auth_1', status: 'approved' } })
  assert.equal(h.coordinator.hasPendingPermission(), false)
  assert.equal(call.options.shouldRespond(), false)
  assert.equal(h.contextCalls.length, 1, 'card resolution silently updates the model context')
  const cancelled = h.cancellations.find(value => typeof value === 'function'
    && value({ authorizationId: 'auth_1' }, 'permission'))
  assert.ok(cancelled)
  assert.equal(cancelled({ authorizationId: 'another' }, 'permission'), false)
  assert.equal(h.cancellations.at(-1), 'auth_1', 'clear only this permission presentation')
  assert.equal(h.taskManager.get(run.task.id).status, 'running')
})

test('explicit input requests retry after a busy turn, stay correlated and resolve without a new Task', async t => {
  const h = harness(t)
  const run = await startTask(h)
  h.state.busy = true
  input(run)
  await flush()
  assert.equal(h.injectCalls.length, 0)
  assert.equal(h.coordinator.hasPendingInput(), true)
  h.state.busy = false
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(h.injectCalls.length, 1)
  const call = h.injectCalls[0]
  assert.equal(call.origin, 'backend-input')
  assert.equal(call.context.taskId, run.task.id)
  assert.equal(call.context.inputRequestId, 'input_1')
  assert.match(call.text, /"required":true/u)
  run.emit({ type: 'backend.input.resolved', input: { id: 'input_1', status: 'accepted', mode: 'form' } })
  assert.equal(h.coordinator.hasPendingInput(), false)
  assert.equal(call.options.shouldRespond(), false)
  assert.ok(h.cancellations.some(value => typeof value === 'function'
    && value({ inputRequestId: 'input_1' }, 'backend-input')))
  assert.equal(h.taskManager.list({}).length, 1)
})

test('ordinary backend prose cannot synthesize an input request or permission', async t => {
  const h = harness(t)
  const run = await startTask(h)
  run.complete({ content: 'Which format do you prefer?' })
  await h.taskManager.wait(run.task.id)
  await flush()
  assert.equal(h.coordinator.hasPendingInput(), false)
  assert.equal(h.coordinator.hasPendingPermission(), false)
  assert.equal(h.injectCalls[0].origin, 'announcement')
})

test('owner/session filtering applies before projection, permission exposure and input delivery', async t => {
  const h = harness(t)
  const foreign = await startTask(h, { ownerId: 'other' })
  const otherSession = await startTask(h, { sessionId: 'other-session' })
  permission(foreign)
  input(otherSession)
  await flush()
  assert.equal(h.events.length, 0)
  assert.equal(h.injectCalls.length, 0)
  assert.equal(h.coordinator.hasPendingPermission(), false)
  assert.equal(h.coordinator.hasPendingInput(), false)
  foreign.complete({ content: 'private result' })
  await h.taskManager.wait(foreign.task.id)
  h.coordinator.claimPendingNotifications()
  await flush()
  assert.equal(h.injectCalls.length, 0)
})

test('sleeping permission wakes the session once and delivers only after tool exposure', async t => {
  const h = harness(t)
  const run = await startTask(h)
  h.state.sleeping = true
  permission(run)
  await flush()
  assert.deepEqual(h.order, ['tools', 'wake', 'permission'])
  assert.equal(h.injectCalls.length, 1)
})

test('a blocked or failed request delivery remains pending and can be retried', async t => {
  const h = harness(t)
  const run = await startTask(h)
  const inject = h.frontend.injectDelivery
  h.frontend.injectDelivery = async () => ({ completed: false, blocked: true })
  input(run)
  await flush()
  assert.equal(h.injectCalls.length, 0)
  h.frontend.injectDelivery = async () => { throw new Error('temporarily unavailable') }
  h.coordinator.announcePendingInputs()
  await flush()
  assert.match(h.errors[0], /temporarily unavailable/u)
  h.frontend.injectDelivery = inject
  h.coordinator.announcePendingInputs()
  await flush()
  assert.equal(h.injectCalls.length, 1)
  assert.equal(h.taskManager.get(run.task.id).inputRequest.status, 'pending')
})

test('reconnecting re-delivers unresolved permission/input without re-executing Tasks', async t => {
  const h = harness(t)
  const run = await startTask(h)
  permission(run)
  input(run)
  await flush()
  assert.equal(h.injectCalls.length, 2)
  const old = h.injectCalls.map(call => call.options)
  h.state.ready = false
  h.coordinator.resetPresentation()
  assert.ok(old.every(options => !options.shouldRespond()))
  h.state.ready = true
  h.coordinator.announcePendingPermissions()
  h.coordinator.announcePendingInputs()
  await flush()
  assert.equal(h.injectCalls.length, 4)
  h.coordinator.announcePendingPermissions()
  h.coordinator.announcePendingInputs()
  await flush()
  assert.equal(h.injectCalls.length, 4)
  assert.equal(h.taskManager.list({}).length, 1)
  assert.equal(h.coordinator.hasPendingPermission(), true)
  assert.equal(h.coordinator.hasPendingInput(), true)
})

test('waiting for permission/input discards old progress and blocks new execution progress', async t => {
  const h = harness(t)
  const run = await startTask(h)
  h.coordinator.announcements.progress.offer({ taskId: run.task.id, message: 'reading memory' })
  permission(run)
  await flush()
  assert.equal(h.coordinator.announcements.progress.candidates.size, 0)
  run.emit({ type: 'backend.message', message: 'still reading' })
  h.coordinator.handleEvent({
    type: 'task.updated', task: h.taskManager.get(run.task.id), message: 'still reading',
  })
  await flush()
  assert.equal(h.coordinator.announcements.progress.candidates.size, 0)
  assert.ok(h.injectCalls.every(call => call.origin === 'permission'))
  run.emit({ type: 'backend.permission.resolved', permission: { id: 'auth_1', status: 'approved' } })
  h.coordinator.announcements.progress.offer({ taskId: run.task.id, message: 'resumed' })
  input(run)
  await flush()
  assert.equal(h.coordinator.announcements.progress.candidates.size, 0)
})

test('pending input survives unready/waking/output-disabled presentation until activation', async t => {
  const h = harness(t)
  const run = await startTask(h)
  h.state.ready = false
  input(run)
  h.state.ready = true
  h.state.waking = true
  h.coordinator.announcePendingInputs()
  h.state.waking = false
  h.state.outputEnabled = false
  h.coordinator.announcePendingInputs()
  await flush()
  assert.equal(h.injectCalls.length, 0)
  h.state.outputEnabled = true
  h.coordinator.announcePendingInputs()
  h.coordinator.announcePendingInputs()
  await flush()
  assert.equal(h.injectCalls.length, 1)
})

test('stale request promises cannot clear a newer attempt or retry after close', async t => {
  const h = harness(t)
  const run = await startTask(h)
  const inject = h.frontend.injectDelivery
  let rejectOld, oldOptions
  h.frontend.injectDelivery = (_text, _origin, _context, options) => {
    oldOptions = options
    return new Promise((_resolve, reject) => { rejectOld = reject })
  }
  permission(run)
  await flush()
  h.frontend.injectDelivery = inject
  h.coordinator.retryPermission('auth_1')
  await flush()
  assert.equal(oldOptions.shouldRespond(), false, 'superseded queued response must not speak')
  rejectOld(new Error('old attempt'))
  await flush()
  h.coordinator.announcePendingPermissions()
  await flush()
  assert.equal(h.injectCalls.length, 1)
  assert.equal(h.errors.length, 0)
  let finish
  h.frontend.injectDelivery = () => new Promise(resolve => { finish = resolve })
  h.coordinator.retryPermission('auth_1')
  await flush()
  h.coordinator.close()
  finish({ completed: false })
  await flush()
  assert.equal(h.coordinator.retryTimer, null)
  assert.equal(h.taskManager.get(run.task.id).status, 'running')
})

test('disconnect releases notification claims; reconnect delivers without re-executing or marking played early', async t => {
  const h = harness(t)
  const run = await startTask(h)
  run.complete({ content: 'finished once' })
  await h.taskManager.wait(run.task.id)
  await flush()
  assert.equal(h.taskManager.get(run.task.id).status, 'completed')
  assert.equal(h.taskManager.get(run.task.id).notificationStatus, 'delivering')
  h.coordinator.close()
  assert.equal(h.taskManager.get(run.task.id).notificationStatus, 'pending')
  const next = harness(t, { taskManager: h.taskManager })
  next.coordinator.claimPendingNotifications()
  next.coordinator.claimPendingNotifications()
  await flush()
  assert.equal(next.injectCalls.length, 1)
  assert.equal(next.taskManager.get(run.task.id).notificationStatus, 'delivering')
  next.announcements.confirmMany([run.task.id])
  assert.equal(next.taskManager.get(run.task.id).notificationStatus, 'delivered')
  next.coordinator.claimPendingNotifications()
  await flush()
  assert.equal(next.injectCalls.length, 1)
})

test('output-disabled sessions leave results claimable and never cancel accepted work on close', async t => {
  const h = harness(t)
  const run = await startTask(h)
  h.state.outputEnabled = false
  h.coordinator.close()
  assert.equal(h.taskManager.get(run.task.id).status, 'running')
  run.complete({ content: 'after disconnection' })
  await h.taskManager.wait(run.task.id)
  assert.equal(h.taskManager.get(run.task.id).notificationStatus, 'pending')
  const next = harness(t, { taskManager: h.taskManager, sessionId: 'new-session' })
  next.state.outputEnabled = false
  next.coordinator.claimPendingNotifications()
  await flush()
  assert.equal(next.injectCalls.length, 0)
  next.state.outputEnabled = true
  next.coordinator.claimPendingNotifications()
  await flush()
  assert.equal(next.injectCalls.length, 1, 'restoration may claim the same owner’s older-session result')
})

test('explicit cancellation clears queued progress and never announces a completion', async t => {
  const h = harness(t)
  const run = await startTask(h)
  h.coordinator.announcements.progress.offer({ taskId: run.task.id, startedAt: Date.now(), message: 'working' })
  await h.taskManager.cancel(run.task.id)
  await h.taskManager.wait(run.task.id)
  await flush()
  assert.equal(h.taskManager.get(run.task.id).status, 'cancelled')
  assert.equal(h.injectCalls.length, 0)
})

test('existing scenario announcement factory still owns presentation while coordinator owns claims', async t => {
  let options
  const h = harness(t, { taskAnnouncementFactory: value => {
    options = value
    return createTaskAnnouncementRuntime(value)
  } })
  const run = await startTask(h)
  assert.equal(options.progressOptions.isTaskActive(run.task.id), true)
  run.complete({ content: 'result' })
  await h.taskManager.wait(run.task.id)
  await flush()
  options.resultOptions.onLeaseRenew([run.task.id])
  options.resultOptions.onDelivered([run.task.id])
  assert.equal(h.taskManager.get(run.task.id).notificationStatus, 'delivered')
  assert.equal(options.progressOptions.isTaskActive(run.task.id), false)
})

test('user Task kinds share result delivery while system jobs stay outside the frontend', async t => {
  const h = harness(t)
  for (const kind of ['work', 'reminder', 'control']) {
    const run = await startTask(h, { kind })
    run.complete({ content: `${kind} result` })
    await h.taskManager.wait(run.task.id)
    await flush()
    assert.equal(h.injectCalls.at(-1).context.taskIds[0], run.task.id)
    h.announcements.confirmMany([run.task.id])
  }
  const count = h.events.length
  const system = h.taskManager.createSystemJob({
    ownerId: h.ownerId, sessionId: h.sessionId, objective: 'ingest document',
    runner: async () => ({ content: 'indexed' }),
  })
  await h.taskManager.wait(system.id)
  h.coordinator.claimPendingNotifications()
  await flush()
  assert.equal(h.injectCalls.length, 3)
  assert.equal(h.events.length, count)
})

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve))
}

async function advance(t, ms) {
  t.mock.timers.tick(ms)
  await settle()
}

// A parked session on mocked timers. Its wakes fail until wakeSucceeds is set;
// a successful wake runs the ready hooks the runtime runs.
function parkedCoordinator(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(t)
  Object.assign(h.state, { ready: false, parked: true })
  const wakes = []
  let inflight = null
  h.wakeSucceeds = false
  h.coordinator.onUnpark = reason => {
    if (inflight) return inflight
    inflight = Promise.resolve().then(() => {
      wakes.push(reason)
      inflight = null
      if (!h.wakeSucceeds) throw new Error('socket hang up')
      Object.assign(h.state, { ready: true, parked: false })
      h.coordinator.announcePendingPermissions()
      h.coordinator.announcePendingInputs()
      h.coordinator.claimPendingNotifications()
    })
    // Observed here too, so an ignored failure fails an assertion, not the process.
    inflight.catch(() => {})
    return inflight
  }
  return Object.assign(h, { wakes })
}

async function completedWhileParked(t) {
  const h = parkedCoordinator(t)
  const run = await startTask(h)
  run.complete({ content: 'time to leave' })
  await h.taskManager.wait(run.task.id)
  await settle()
  assert.equal(h.wakes.length, 1, 'the completion wakes the session once')
  return { h, run }
}

test('a failed proactive wake is retried after 2, 4 and 8 s, then left for the next wake', async t => {
  const { h, run } = await completedWhileParked(t)
  for (const delay of [2000, 4000, 8000]) {
    const before = h.wakes.length
    await advance(t, delay - 1)
    assert.equal(h.wakes.length, before, `not before ${delay} ms`)
    await advance(t, 1)
    assert.equal(h.wakes.length, before + 1, `retried after ${delay} ms`)
  }
  await advance(t, 120_000)
  assert.equal(h.wakes.length, 4, 'three retries at most')
  assert.deepEqual(h.errors, [], 'no client-visible error')
  assert.equal(h.injectCalls.length, 0)
  assert.equal(h.taskManager.get(run.task.id).notificationStatus, 'pending', 'still claimable later')
  assert.equal(h.coordinator.wakeRetryTimer, null)
})

test('a retried wake that succeeds delivers through the ready hooks and stops retrying', async t => {
  const { h } = await completedWhileParked(t)
  await advance(t, 2000)
  assert.equal(h.wakes.length, 2)
  h.wakeSucceeds = true
  await advance(t, 4000)
  await advance(t, 0)
  assert.equal(h.wakes.length, 3)
  assert.deepEqual(h.injectCalls.map(call => call.origin), ['announcement'])
  await advance(t, 120_000)
  assert.equal(h.wakes.length, 3)

  Object.assign(h.state, { ready: false, parked: true })
  h.wakeSucceeds = false
  const next = await startTask(h)
  next.complete({ content: 'second result' })
  await h.taskManager.wait(next.task.id)
  await settle()
  assert.equal(h.wakes.length, 4)
  await advance(t, 2000)
  assert.equal(h.wakes.length, 5, 'a later failure starts from 2 s again')
})

test('work that arrives during the backoff waits for the scheduled retry', async t => {
  const { h } = await completedWhileParked(t)
  const run = await startTask(h)
  permission(run)
  await advance(t, 1999)
  assert.equal(h.wakes.length, 1, 'no extra wake inside the backoff')
  h.wakeSucceeds = true
  await advance(t, 1)
  await advance(t, 0)
  assert.equal(h.wakes.length, 2)
  assert.deepEqual(h.injectCalls.map(call => call.origin).sort(), ['announcement', 'permission'])
})

test('a permission request whose wake failed is asked once a retried wake succeeds', async t => {
  const h = parkedCoordinator(t)
  const run = await startTask(h)
  permission(run)
  await settle()
  assert.equal(h.wakes.length, 1)
  h.wakeSucceeds = true
  await advance(t, 2000)
  assert.equal(h.wakes.length, 2)
  assert.deepEqual(h.injectCalls.map(call => call.origin), ['permission'])
})

test('wake retries stop once nothing is undelivered, the session is not parked, or it closes', async t => {
  const cases = {
    'claimed elsewhere': (h, run) => h.taskManager.claimNotifications({
      ownerId: h.ownerId, sessionId: h.sessionId, claimantId: 'elsewhere', taskIds: [run.task.id],
    }),
    'no longer parked': h => { h.state.parked = false },
    'reset on disconnect': h => h.coordinator.resetPresentation(),
    closed: h => h.coordinator.close(),
  }
  for (const [name, stop] of Object.entries(cases)) {
    await t.test(name, async st => {
      const { h, run } = await completedWhileParked(st)
      stop(h, run)
      if (['reset on disconnect', 'closed'].includes(name)) assert.equal(h.coordinator.wakeRetryTimer, null, name)
      await advance(st, 120_000)
      assert.equal(h.wakes.length, 1, name)
    })
  }
})

test('a retry that stops because the session was woken leaves a full budget for the next park', async t => {
  const { h, run } = await completedWhileParked(t)
  h.state.parked = false
  await advance(t, 2000)
  assert.equal(h.wakes.length, 1)
  h.state.parked = true
  h.coordinator.claimPendingNotifications([run.task.id])
  await settle()
  assert.equal(h.wakes.length, 2)
  await advance(t, 2000)
  assert.equal(h.wakes.length, 3, 'retried after 2 s again')
})
