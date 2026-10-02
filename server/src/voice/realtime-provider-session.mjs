import { createRealtimeFrontend } from './realtime-provider.mjs'
import { ReconnectBackoff } from './reconnect-backoff.mjs'
import { RealtimeConfigurationError } from './realtime-errors.mjs'
import { realtimeConnectionStatus } from './realtime-connection-status.mjs'

// How often a blocked idle close is checked again.
const IDLE_CLOSE_RECHECK_MS = 1000
// setTimeout fires at once for longer delays.
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Owns one provider-facing realtime Session lifecycle.
 *
 * The Gateway decides whether the client should be active, sleeping or waking;
 * this runtime performs provider selection, connection/reconnection, bounded
 * audio buffering and fatal-error blocking without knowing UI policy.
 */
export class RealtimeProviderSession {
  constructor({
    providerRegistry,
    defaultProvider,
    getAgentContext,
    getSessionOptions = () => ({}),
    shouldReconnect,
    onEvent,
    onDiagnostic,
    onResponseSettled,
    onConnected,
    onReady,
    onDisconnected,
    onReconnected,
    onConnectionState,
    onError,
    onReconnectError,
    logger,
    maxPendingAudioChunks = 30,
    stableConnectionMs = 10_000,
    createFrontend = createRealtimeFrontend,
    reconnectBackoff = new ReconnectBackoff(),
    // '' when an idle provider session may close, otherwise the reason it may not.
    idleCloseBlocker = () => 'disabled',
    // The same for a restart after cancel, which happens mid-conversation.
    restartBlocker = () => '',
    // Called once a session that went silent on a user turn was given up, so
    // the turn can be asked again; that request wakes a fresh session.
    onStallRestarted = null,
    now = () => performance.now(),
  }) {
    this.providerRegistry = providerRegistry
    this.providerKey = providerRegistry.resolve(defaultProvider).key
    this.getAgentContext = getAgentContext
    this.getSessionOptions = getSessionOptions
    this.shouldReconnect = shouldReconnect
    this.onEvent = onEvent
    this.onDiagnostic = onDiagnostic
    this.onResponseSettled = onResponseSettled
    this.onConnected = onConnected
    this.onReady = onReady
    this.onDisconnected = onDisconnected
    this.onReconnected = onReconnected
    this.onConnectionState = onConnectionState
    this.onError = onError
    this.onReconnectError = onReconnectError
    this.logger = logger
    this.maxPendingAudioChunks = maxPendingAudioChunks
    this.stableConnectionMs = stableConnectionMs
    this.createFrontend = createFrontend
    this.reconnectBackoff = reconnectBackoff
    this.frontend = null
    this.connectPromise = null
    this.pendingAudio = []
    this.pendingImage = null
    this.scheduledReconnect = null
    this.connectedAt = 0
    this.blockedError = ''
    this.inputMuted = false
    this.idleCloseBlocker = idleCloseBlocker
    this.restartBlocker = restartBlocker
    this.onStallRestarted = onStallRestarted
    this.now = now
    // Parked: the provider session was closed while idle and reopens on the
    // next request, with no connection state change reported to the client.
    this.parked = false
    this.idleTimer = null
    this.idleBlocker = ''
    // Set by a restart after cancel, for the next connect's history seed only.
    this.trimSeedOnce = false
  }

  get ready() {
    return this.frontend?.ready === true
  }

  get connecting() {
    return Boolean(this.connectPromise)
  }

  get reconnectScheduled() {
    return Boolean(this.scheduledReconnect)
  }

  status({ sleeping = false, waking = false } = {}) {
    return realtimeConnectionStatus({
      provider: this.providerKey,
      blockedError: this.blockedError,
      sleeping,
      waking,
      ready: this.ready,
      connecting: this.connecting,
    })
  }

  provider() {
    return this.frontend?.provider
      ?? this.providerRegistry.resolve(this.providerKey)
  }

  classifyError(message) {
    return this.provider().classifyError?.(message) ?? 'other'
  }

  switchProvider(providerName) {
    const requested = this.providerRegistry.resolve(providerName)
    if (requested.key === this.providerKey) return false
    this.providerKey = requested.key
    this.blockedError = ''
    this.detach({ clearAudio: false })
    return true
  }

  reportError(error) {
    if (error?.realtimeConnectionReported) return
    if (error) error.realtimeConnectionReported = true
    this.onError(error)
  }

  block(errorMessage) {
    this.blockedError = String(errorMessage || '')
    this.clearPendingAudio()
    this.clearPendingImage()
    this.detach()
  }

  clearPendingAudio() {
    this.pendingAudio = []
  }

  clearPendingImage() {
    this.pendingImage = null
    this.frontend?.clearPendingImage?.()
  }

  setInputMuted(muted) {
    this.inputMuted = muted === true
    this.frontend?.setInputMuted?.(this.inputMuted)
  }

  cancelResponse() {
    this.frontend?.cancel()
  }

  // options 必须一并转发：底层靠 { refreshSession: false } 决定是否重发
  // session.update。这一层若吞掉第二个参数，调用方的意图会被静默丢弃 ——
  // 不报错、测试也照样绿，只是前缀缓存白白失效。
  updateAgentContext(context, options) {
    return this.frontend?.updateAgentContext(context, options)
  }

  appendAudio(audio) {
    if (this.blockedError) return
    if (this.ready) {
      this.frontend.appendAudio(audio)
      return
    }
    this.pendingAudio.push(audio)
    if (this.pendingAudio.length > this.maxPendingAudioChunks) {
      this.pendingAudio.splice(
        0,
        this.pendingAudio.length - this.maxPendingAudioChunks,
      )
    }
    if (!this.connectPromise && !this.scheduledReconnect) {
      this.ensure().catch(error => this.reportError(error))
    }
  }

  appendImage(image) {
    if (this.blockedError) return false
    if (this.ready) return this.frontend.appendImage(image)
    this.pendingImage = image
    if (!this.connectPromise && !this.scheduledReconnect) {
      this.ensure().catch(error => this.reportError(error))
    }
    return true
  }

  ensure() {
    if (this.blockedError) return Promise.reject(new Error(this.blockedError))
    if (this.ready) return Promise.resolve()
    if (this.connectPromise) return this.connectPromise
    if (this.scheduledReconnect) return this.scheduledReconnect.promise
    return this.connectNow()
  }

  connectNow() {
    if (this.blockedError) return Promise.reject(new Error(this.blockedError))
    if (this.ready) return Promise.resolve()
    if (this.connectPromise) return this.connectPromise
    // Stays parked until ready, so concurrent wakes share this attempt.
    const resumedFromPark = this.parked
    if (!resumedFromPark) {
      this.onConnectionState({
        state: 'connecting',
        provider: this.providerKey,
      })
    }
    const connectStartedAt = Date.now()
    this.logger.info('realtime.connecting', { provider: this.providerKey })
    let createdFrontend
    const sessionOptions = this.getSessionOptions() || {}
    const trimTrailingUser = this.trimSeedOnce
    this.trimSeedOnce = false
    createdFrontend = this.createFrontend({
      providerName: this.providerKey,
      providerRegistry: this.providerRegistry,
      agentContext: this.getAgentContext(),
      sessionOptions: trimTrailingUser ? { ...sessionOptions, trimTrailingUser } : sessionOptions,
      onEvent: event => {
        if (this.frontend === createdFrontend) this.onEvent(event)
      },
      onDiagnostic: this.onDiagnostic,
      onResponseSettled: event => {
        if (this.frontend === createdFrontend) this.onResponseSettled?.(event)
      },
      onError: error => this.#handleProviderError(createdFrontend, error),
      onClose: () => this.#handleClose(createdFrontend),
      onRestartRequested: () => this.#restartAfterCancel(createdFrontend),
      onStallRestartRequested: () => this.#restartAfterStall(createdFrontend),
    })
    this.frontend = createdFrontend
    let createdConnectPromise
    createdConnectPromise = createdFrontend.connect()
      .then(() => {
        if (this.frontend !== createdFrontend) return
        this.parked = false
        this.blockedError = ''
        this.connectedAt = Date.now()
        this.logger.info('realtime.connected', {
          provider: createdFrontend.provider.key,
          durationMs: this.connectedAt - connectStartedAt,
          ...(resumedFromPark ? { resumedFromPark } : {}),
        })
        if (!resumedFromPark) {
          this.onConnectionState({
            state: 'connected',
            provider: createdFrontend.provider.key,
          })
        }
        this.onConnected(createdFrontend)
        this.pendingAudio.forEach(audio => createdFrontend.appendAudio(audio))
        this.pendingAudio = []
        if (this.pendingImage) createdFrontend.appendImage(this.pendingImage)
        this.pendingImage = null
        createdFrontend.setInputMuted?.(this.inputMuted)
        this.onReady(createdFrontend, { resumedFromPark })
        this.#armIdleClose()
      })
      .catch(error => {
        if (this.frontend !== createdFrontend) return
        this.logger.error('realtime.connect_failed', {
          provider: createdFrontend.provider.key,
          durationMs: Date.now() - connectStartedAt,
          error,
        })
        const classification = error instanceof RealtimeConfigurationError
          ? 'fatal'
          : createdFrontend.provider.classifyError(error.message)
        if (classification === 'fatal') {
          this.blockedError = error.message
          this.clearPendingAudio()
          this.clearPendingImage()
        }
        if (resumedFromPark && classification !== 'fatal') {
          // A transient wake failure costs the request that woke it, not the link:
          // stay parked, report no connection state, and let the caller report it.
          this.frontend = null
          this.parked = true
          // The next wake still seeds without the cut question.
          if (trimTrailingUser) this.trimSeedOnce = true
          createdFrontend.close()
          this.logger.warn('realtime.unpark_failed', {
            provider: createdFrontend.provider.key,
            classification,
            error,
          })
          throw error
        }
        // A fatal wake leaves the park and reports unavailable, so the client rebuilds the link.
        this.parked = false
        if (classification !== 'capacity_busy') {
          this.onConnectionState({
            state: 'unavailable',
            provider: createdFrontend.provider.key,
            message: error.message,
          })
        }
        throw error
      })
      .finally(() => {
        if (this.connectPromise === createdConnectPromise) {
          this.connectPromise = null
        }
      })
    this.connectPromise = createdConnectPromise
    return createdConnectPromise
  }

  #handleProviderError(createdFrontend, error) {
    if (this.frontend !== createdFrontend) return
    const classification = createdFrontend.provider.classifyError(error.message)
    // A rejected session.update arrives before the normal event lifecycle.
    // Route it through the same bounded recovery as a rejected conversation.
    if (classification === 'content_safety' && error.realtimeEvent) {
      this.onEvent({
        type: 'error',
        error: { message: error.message },
        __voiceOrigin: 'session',
      })
      return
    }
    if (classification !== 'inactivity') {
      this.logger.warn('realtime.provider_error', {
        provider: createdFrontend.provider.key,
        classification,
        error,
      })
    }
    if (classification === 'fatal') {
      this.blockedError = error.message
      this.clearPendingAudio()
      this.clearPendingImage()
      // Fatal even during a wake: the park ends and the unavailable state reports it.
      this.parked = false
      error.realtimeConnectionReported = true
    }
    // During a wake the request that woke the session reports the failure once.
    if (this.parked) return
    if (classification !== 'inactivity' && classification !== 'capacity_busy') {
      this.reportError(error)
    }
  }

  #handleClose(createdFrontend) {
    if (this.frontend !== createdFrontend) return
    // Only a wake still connecting can close while parked; its rejection reports it.
    if (this.parked) return
    const connectedMs = this.connectedAt ? Date.now() - this.connectedAt : 0
    this.logger.warn('realtime.closed', {
      provider: createdFrontend.provider.key,
      connectedMs,
      blocked: Boolean(this.blockedError),
    })
    this.frontend = null
    this.onDisconnected()
    if (!this.shouldReconnect()) return
    this.onConnectionState({
      state: 'unavailable',
      provider: this.providerKey,
      ...(this.blockedError ? { message: this.blockedError } : {}),
    })
    if (this.blockedError) return
    if (connectedMs >= this.stableConnectionMs) this.reconnectBackoff.reset()
    this.connectedAt = 0
    this.scheduleReconnect()
      .then(() => this.onReconnected())
      .catch(error => this.onReconnectError(error))
  }

  scheduleReconnect() {
    if (this.blockedError || this.ready) return Promise.resolve()
    if (this.scheduledReconnect) return this.scheduledReconnect.promise
    let resolveScheduled
    let rejectScheduled
    const promise = new Promise((resolve, reject) => {
      resolveScheduled = resolve
      rejectScheduled = reject
    })
    const scheduled = {
      promise,
      resolve: resolveScheduled,
      reject: rejectScheduled,
      timer: null,
    }
    scheduled.timer = setTimeout(() => {
      if (this.scheduledReconnect !== scheduled) {
        scheduled.resolve()
        return
      }
      this.scheduledReconnect = null
      this.connectNow().then(scheduled.resolve, scheduled.reject)
    }, this.reconnectBackoff.next())
    scheduled.timer.unref?.()
    this.scheduledReconnect = scheduled
    return promise
  }

  cancelReconnect() {
    const scheduled = this.scheduledReconnect
    if (!scheduled) return
    this.scheduledReconnect = null
    clearTimeout(scheduled.timer)
    scheduled.resolve()
  }

  // Arms the idle check; only a provider that defines idleCloseMs ever parks.
  #armIdleClose(delay) {
    clearTimeout(this.idleTimer)
    this.idleTimer = null
    const idleMs = Number(this.frontend?.provider?.idleCloseMs?.()) || 0
    if (!(idleMs > 0)) return
    this.idleTimer = setTimeout(() => this.#checkIdle(idleMs), Math.min(delay ?? idleMs, MAX_TIMER_MS))
    this.idleTimer.unref?.()
  }

  #checkIdle(idleMs) {
    this.idleTimer = null
    const frontend = this.frontend
    if (!frontend?.ready || this.connectPromise || this.scheduledReconnect || this.blockedError) return
    // A frontend that does not track activity never parks.
    const lastActivityAt = frontend.lastActivityAt
    if (typeof lastActivityAt !== 'number' || Number.isNaN(lastActivityAt)) return
    const quietMs = this.now() - lastActivityAt
    if (quietMs < idleMs) return this.#armIdleClose(idleMs - quietMs)
    let blocker = 'frontend_busy'
    try {
      if (frontend.isQuiescent?.() === true) blocker = String(this.idleCloseBlocker() || '')
    } catch {
      blocker = 'blocker_threw'
    }
    if (blocker) {
      // Logged when the reason changes, not on every recheck.
      if (blocker !== this.idleBlocker) this.logger.info('realtime.idle_close_blocked', { reason: blocker })
      this.idleBlocker = blocker
      return this.#armIdleClose(IDLE_CLOSE_RECHECK_MS)
    }
    this.#park(quietMs)
  }

  // Closes the idle provider session without a reconnect or any client event.
  // detach() clears this.frontend first, so the closing socket's late
  // close/error/events are dropped by the identity guards.
  #park(quietMs) {
    this.logger.info('realtime.parked', {
      provider: this.frontend.provider.key,
      quietMs: Math.round(quietMs),
      connectedMs: this.connectedAt ? Date.now() - this.connectedAt : 0,
    })
    this.detach({ clearAudio: false })
    this.connectedAt = 0
    this.idleBlocker = ''
    this.parked = true
  }

  // Closes the provider session and reopens it at once with no client event,
  // for a provider whose speech a cancel cannot stop. A tick later, so the cut
  // answer's transcript is in history before the new session is seeded; the
  // seed drops a trailing unanswered question, which the service would answer.
  #restartAfterCancel(frontend) {
    const timer = setTimeout(() => {
      if (this.frontend !== frontend || !frontend.ready || this.connectPromise
        || this.scheduledReconnect || this.blockedError) return
      // A request sent in the same tick, or work above the provider the new
      // session would not know about, keeps the session.
      let blocker = frontend.restartSafe?.() === false ? 'frontend_busy' : ''
      try {
        blocker ||= String(this.restartBlocker() || '')
      } catch {
        blocker = 'blocker_threw'
      }
      if (blocker) {
        this.logger.info('realtime.restart_skipped', { provider: frontend.provider.key, reason: blocker })
        return
      }
      this.logger.info('realtime.restarted_after_cancel', {
        provider: frontend.provider.key,
        connectedMs: this.connectedAt ? Date.now() - this.connectedAt : 0,
      })
      this.detach({ clearAudio: false })
      this.connectedAt = 0
      this.idleBlocker = ''
      this.parked = true
      this.trimSeedOnce = true
      this.ensure().catch(error => this.logger.warn('realtime.restart_failed', {
        provider: frontend.provider.key,
        error,
      }))
    }, 0)
    timer.unref?.()
  }

  // Gives up a session whose voice layer went silent on a user turn: it parks as
  // an idle session does, and the turn asked again wakes a fresh one. Work above
  // the provider that a new session would not know about keeps the old session.
  #restartAfterStall(frontend) {
    const timer = setTimeout(() => {
      if (this.frontend !== frontend || !frontend.ready || this.connectPromise
        || this.scheduledReconnect || this.blockedError) return
      let blocker = ''
      try {
        blocker = String(this.restartBlocker() || '')
      } catch {
        blocker = 'blocker_threw'
      }
      if (blocker) {
        this.logger.info('realtime.restart_skipped', {
          provider: frontend.provider.key, reason: blocker, cause: 'voice_stall',
        })
        return
      }
      this.logger.info('realtime.restarted_after_stall', {
        provider: frontend.provider.key,
        connectedMs: this.connectedAt ? Date.now() - this.connectedAt : 0,
      })
      this.detach({ clearAudio: false })
      this.connectedAt = 0
      this.idleBlocker = ''
      this.parked = true
      try {
        this.onStallRestarted?.()
      } catch (error) {
        this.logger.warn('realtime.stall_replay_failed', { provider: frontend.provider.key, error })
      }
    }, 0)
    timer.unref?.()
  }

  detach({ clearAudio = true, notifyDisconnected = false } = {}) {
    this.parked = false
    clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (clearAudio) this.clearPendingAudio()
    // Visual frames are point-in-time context. Never carry one across a
    // provider rebuild, even when reconnecting preserves queued microphone
    // audio.
    this.clearPendingImage()
    this.cancelReconnect()
    const staleFrontend = this.frontend
    this.frontend = null
    this.connectPromise = null
    if (staleFrontend && notifyDisconnected) this.onDisconnected()
    staleFrontend?.close()
  }

  reconnect() {
    this.detach({ clearAudio: false })
    return this.scheduleReconnect()
  }

  close(options) {
    this.detach(options)
  }
}
