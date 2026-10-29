import { GatewayServerEvent } from '../../../shared/protocol/realtime-events.mjs'
import {
  ensureResponseContext,
  mergeResponseContext,
  responseActivityContextPatch,
} from './response-context.mjs'
import {
  evaluateResponseGuards,
  isResponseGuardTurnCurrent,
} from './response-guards/index.mjs'
import {
  containsReservedProtocolEnvelope,
} from './response-guards/reserved-protocol-envelope.mjs'
import { realtimeResponseId } from './response-lifecycle.mjs'

const PRESENTATION_RESPONSE_EVENTS = new Set([
  'response.created',
  'response.audio.delta',
  'response.output_audio.delta',
  'response.audio_transcript.delta',
  'response.output_audio_transcript.delta',
  'response.audio_transcript.done',
  'response.output_audio_transcript.done',
  'response.text.delta',
  'response.text.done',
  'response.done',
])

// A concurrent voice layer speaks a finished backend step's result within this
// long (the provider's result relay plus its owed window).
const BACKEND_RESULT_OWED_MS = 6000

export function confirmsTaskNotificationOnPlaybackStart(context) {
  return Boolean(
    context
    && (
      context.origin === 'announcement'
      || context.consumesTaskNotification
      // A due reminder is delivered as a Gateway system event about its task.
      || (context.origin === 'gateway-system-event' && (context.taskId || context.taskIds?.length))
    ),
  )
}

export function acceptsPlaybackReceipt({
  outputEnabled,
  active,
  responseKnown,
}) {
  return outputEnabled === true && active === true && responseKnown === true
}

function contextTaskIds(context) {
  return context?.taskIds?.length
    ? context.taskIds
    : [context?.taskId].filter(Boolean)
}

function awaitsToolFollowUp(context) {
  return Boolean(context?.awaitsToolFollowUp ?? context?.hasFunctionCall)
}

/**
 * Owns response correlation and user-visible presentation for one realtime
 * connection. Audio/text provider events and client playback receipts meet at
 * this boundary so a response is acknowledged, retried and recorded once.
 */
export class RealtimePresentationRuntime {
  constructor({
    ownerId,
    sessionId,
    turns,
    conversationSync,
    announcementWindow,
    announcements,
    toolCalls,
    send,
    getFrontend,
    getOutputEnabled,
    getNonVoiceClient,
    getResponseTurnCandidate,
    clearResponseCandidate,
    announcementQuietMs,
    responseContextCleanupMs,
    turnCitations = null,
    backendResultOwedMs = BACKEND_RESULT_OWED_MS,
  }) {
    this.ownerId = ownerId
    this.sessionId = sessionId
    this.turns = turns
    this.conversationSync = conversationSync
    this.announcementWindow = announcementWindow
    this.announcements = announcements
    this.toolCalls = toolCalls
    this.send = send
    this.getFrontend = getFrontend
    this.getOutputEnabled = getOutputEnabled
    this.getNonVoiceClient = getNonVoiceClient
    this.getResponseTurnCandidate = getResponseTurnCandidate
    this.clearResponseCandidate = clearResponseCandidate
    this.announcementQuietMs = announcementQuietMs
    this.responseContextCleanupMs = responseContextCleanupMs
    this.turnCitations = turnCitations
    this.backendResultOwedMs = backendResultOwedMs
    this.contexts = new Map()
    this.playbackTurns = new Map()
    // Finished backend steps whose result the voice layer has not spoken yet.
    this.owedResults = new Map()
    this.lastCorrectionTurn = null
  }

  has(id) {
    return this.contexts.has(id)
  }

  get(id) {
    return this.contexts.get(id)
  }

  entries() {
    return this.contexts.entries()
  }

  markFunctionCall(id) {
    const context = this.contexts.get(id)
    if (context) {
      context.hasFunctionCall = true
      this.send({
        type: GatewayServerEvent.VOICE_STATE,
        state: 'processing',
        turnId: context.turnId || this.turns.turnId,
        origin: context.origin || 'model',
      })
    }
    return context
  }

  publicContext(context = {}) {
    return {
      turnId: context.turnId,
      taskId: context.taskId,
      taskIds: context.taskIds,
      origin: context.origin,
      turnGeneration: context.turnGeneration,
    }
  }

  fallbackContext() {
    const turn = this.turns.responseTurn()
    return {
      turnId: turn.turnId,
      taskId: null,
      origin: 'model',
      turnGeneration: turn.turnGeneration,
    }
  }

  begin(event) {
    const id = realtimeResponseId(event)
    if (!id) return null
    const existing = this.contexts.get(id)
    const source = existing ? event : this.#adoptBackendIdentity(id, event)
    const automaticResponse = (
      !existing
      && (source.__voiceOrigin || 'model') === 'model'
      && !source.__voiceContext?.turnId
    )
    const automaticTurn = automaticResponse
      ? this.getResponseTurnCandidate()
      : null
    const responseTurn = this.turns.responseTurn()
    const fallback = {
      turnId: source.__voiceContext?.turnId
        || automaticTurn?.turnId
        || responseTurn.turnId,
      taskId: source.__voiceContext?.taskId || null,
      origin: source.__voiceOrigin || 'model',
      authorizationId: source.__voiceContext?.authorizationId || null,
      turnGeneration: Number.isInteger(source.__voiceContext?.turnGeneration)
        ? source.__voiceContext.turnGeneration
        : automaticTurn?.turnGeneration ?? responseTurn.turnGeneration,
    }
    const context = mergeResponseContext(
      this.contexts,
      id,
      responseActivityContextPatch({ existing, event: source, fallback }),
    )
    if (
      this.turns.manualInputGeneration !== null
      && !automaticResponse
      && context.turnGeneration === this.turns.manualInputGeneration
      && context.origin === 'model'
    ) {
      this.turns.finishManualResponse(context)
    }
    if (
      context.playbackStarted
      && confirmsTaskNotificationOnPlaybackStart(context)
    ) {
      this.announcements.confirmMany(contextTaskIds(context))
    }
    if (automaticTurn) {
      this.turns.commit(automaticTurn)
      this.clearResponseCandidate()
    }
    // With a concurrent voice layer the backend response has no audio of its
    // own; the voice layer speaks. Clients see only the spoken response, so a
    // backend step finishing does not end a turn whose answer is still owed.
    if (!existing) {
      context.backendOnly = this.getFrontend?.()?.capabilities?.concurrentVoicePlayback === true
        && event.__voicePlayback !== true
      if (context.backendOnly) context.turnSequence = this.turns.turnSequence
    }
    if (!context.responseStarted && !context.suppressed && !context.backendOnly) {
      context.responseStarted = true
      this.send({
        type: GatewayServerEvent.RESPONSE_STARTED,
        responseId: id,
        ...this.publicContext(context),
      })
    }
    return context
  }

  // The voice layer speaks for a backend step that carries a Gateway request
  // (announcement, permission, ...); its speech takes that identity so the
  // client's playback receipt confirms the request.
  #adoptBackendIdentity(id, event) {
    if (
      event.__voicePlayback !== true
      || this.getFrontend?.()?.capabilities?.concurrentVoicePlayback !== true
    ) return event
    const backend = [...this.owedResults.keys(), ...this.contexts.values()]
      .find(context => this.#speaksFor(context))
    if (!backend) return event
    backend.adoptedBy = id
    this.#releaseOwed(backend)
    const { turnId, taskId, taskIds, authorizationId, turnGeneration } = backend
    return {
      ...event,
      __voiceOrigin: backend.origin,
      __voiceContext: { ...event.__voiceContext, turnId, taskId, taskIds, authorizationId, turnGeneration },
    }
  }

  // A request from before the latest user turn is no longer what the voice speaks.
  #speaksFor(context) {
    return Boolean(
      context.backendOnly
      && !context.adoptedBy
      && !context.suppressed
      && context.origin !== 'model'
      && context.turnSequence === this.turns.turnSequence,
    )
  }

  // Held like unplayed audio so no other delivery starts before the voice
  // speaks it; unspoken within the window, the result is delivered again.
  #oweResult(id, context) {
    this.announcementWindow.queueAudio(id, { turnId: context.turnId, origin: context.origin })
    const timer = setTimeout(() => {
      if (!this.#releaseOwed(context)) return
      if (context.origin === 'announcement') {
        this.announcements.retryMany(contextTaskIds(context))
      } else {
        this.#flushAnnouncementsSoon()
      }
    }, this.backendResultOwedMs)
    timer.unref?.()
    this.owedResults.set(context, { id, timer })
  }

  #releaseOwed(context) {
    const owed = this.owedResults.get(context)
    if (!owed) return false
    clearTimeout(owed.timer)
    this.owedResults.delete(context)
    this.announcementWindow.finishPlayback(owed.id)
    return true
  }

  handle(event) {
    if (!PRESENTATION_RESPONSE_EVENTS.has(event?.type)) return false
    if (event.type === 'response.created') return true
    if (
      event.type === 'response.audio.delta'
      || event.type === 'response.output_audio.delta'
    ) {
      this.#audioDelta(event)
    } else if (
      event.type === 'response.audio_transcript.delta'
      || event.type === 'response.output_audio_transcript.delta'
    ) {
      this.#audioTranscriptDelta(event)
    } else if (
      event.type === 'response.audio_transcript.done'
      || event.type === 'response.output_audio_transcript.done'
    ) {
      this.#audioTranscriptDone(event)
    } else if (event.type === 'response.text.delta') {
      this.#textDelta(event)
    } else if (event.type === 'response.text.done') {
      this.#textDone(event)
    } else if (event.type === 'response.done') {
      this.#responseDone(event)
    }
    return true
  }

  #contextFor(event) {
    return ensureResponseContext(
      this.contexts,
      realtimeResponseId(event),
      this.fallbackContext(),
    )
  }

  #audioDelta(event) {
    const id = realtimeResponseId(event)
    const context = this.#contextFor(event)
    if (context?.suppressed) return
    const responseTurnId = context.turnId || this.turns.turnId
    if (context.backendOnly) {
      // Audio after all: present it as a normal response from here on.
      context.backendOnly = false
      if (!context.responseStarted) {
        context.responseStarted = true
        this.send({ type: GatewayServerEvent.RESPONSE_STARTED, responseId: id, ...this.publicContext(context) })
      }
    }
    if (id) {
      context.hasAudio = true
      this.playbackTurns.set(id, responseTurnId)
      this.announcementWindow.queueAudio(id, {
        turnId: responseTurnId,
        origin: context.origin || 'model',
      })
    }
    this.send({
      type: GatewayServerEvent.AUDIO_DELTA,
      audio: event.delta,
      sampleRate: Number(event.sampleRate)
        || this.getFrontend().provider.outputSampleRate,
      responseId: id,
      turnId: responseTurnId,
    })
  }

  #audioTranscriptDelta(event) {
    const id = realtimeResponseId(event)
    const context = this.#contextFor(event)
    if (context.suppressed) return
    if (!context.playbackStarted) {
      context.pendingTranscripts.push({
        content: event.delta || '',
        final: false,
      })
      return
    }
    this.#emitTranscript({
      id,
      context,
      content: event.delta || '',
      final: false,
    })
  }

  #audioTranscriptDone(event) {
    const id = realtimeResponseId(event)
    const context = this.#contextFor(event)
    if (context.suppressed) return
    context.transcriptDone = true
    context.assistantTranscript = event.transcript || ''
    if (!context.playbackStarted) {
      context.pendingTranscripts.push({
        content: event.transcript || '',
        final: true,
      })
    } else {
      this.#emitTranscript({
        id,
        context,
        content: event.transcript || '',
        final: true,
      })
    }
    this.#finishContextIfComplete(id, context)
  }

  #textDelta(event) {
    const id = realtimeResponseId(event)
    const context = this.#contextFor(event)
    if (context.suppressed) return
    this.#emitTranscript({
      id,
      context,
      content: event.delta || '',
      final: false,
    })
  }

  #textDone(event) {
    const id = realtimeResponseId(event)
    const context = this.#contextFor(event)
    if (context.suppressed) return
    context.transcriptDone = true
    context.assistantTranscript = event.text || ''
    this.#emitTranscript({
      id,
      context,
      content: event.text || '',
      final: true,
    })
  }

  #responseDone(event) {
    const id = realtimeResponseId(event)
    const context = this.contexts.get(id)
    const terminalToolResponse = this.toolCalls.consumeTerminalToolResponse(id)
    const responseTurnId = context?.turnId || this.turns.turnId
    const responseStatus = event.response?.status
    const failed = ['failed', 'cancelled', 'incomplete'].includes(responseStatus)
    const sourceHasSpeech = Boolean(context?.hasAudio || context?.assistantTranscript?.trim())
    const suppressResponse = Boolean(failed || context?.suppressed)
    // A spoken task-acceptance receipt needs no second acknowledgement, but
    // inline tool results still need a summary after execution has finished.
    const suppressToolFollowUp = suppressResponse || (
      sourceHasSpeech && !this.toolCalls.requiresToolResultSummary?.(id)
    )
    const toolFollowUpPending = Boolean(
      context?.hasFunctionCall
      && !terminalToolResponse
      && !suppressToolFollowUp,
    )
    if (context) context.awaitsToolFollowUp = toolFollowUpPending
    this.toolCalls.finishToolResponse(id, {
      suppressResponse,
      sourceHasSpeech,
    }).catch(error => this.send({
      type: GatewayServerEvent.ERROR,
      message: error.message,
    }))
    const guardDecision = evaluateResponseGuards({
      origin: context?.origin || 'model',
      hasFunctionCall: Boolean(context?.hasFunctionCall),
      failed,
      suppressed: Boolean(context?.suppressed),
      transcript: context?.assistantTranscript || '',
    })
    if (context?.backendOnly && this.getFrontend?.()?.playbackResponses?.size) {
      // Internal only while the voice layer speaks; its response reports the turn's end.
    } else if (!context?.suppressed) {
      // A backend step has no audio of its own; with nothing spoken only idle applies.
      if (!context?.backendOnly) {
        this.send({
          type: GatewayServerEvent.AUDIO_DONE,
          responseId: id,
          turnId: responseTurnId,
        })
      }
      if (!context?.hasAudio && !toolFollowUpPending) {
        this.send({
          type: GatewayServerEvent.VOICE_STATE,
          state: 'idle',
          turnId: responseTurnId,
          origin: context?.origin || 'model',
        })
      }
    } else if (!context.hasAudio && responseTurnId === this.turns.committedTurnId && !this.turns.userSpeaking) {
      this.send({ type: GatewayServerEvent.VOICE_STATE, state: 'idle', turnId: responseTurnId })
    }
    if (context?.hasAudio && !failed) {
      context.responseDone = true
      this.#finishContextIfComplete(id, context)
    } else {
      const nonVoiceClient = this.getNonVoiceClient()
      const completedNonVoiceAnnouncement = (
        context?.origin === 'announcement'
        && nonVoiceClient
        && !failed
      )
      const completedNonVoiceTaskNotification = (
        context?.consumesTaskNotification
        && nonVoiceClient
        && !failed
      )
      if (
        context
        && !failed
        && (
          context.origin !== 'announcement'
          || completedNonVoiceAnnouncement
        )
      ) {
        this.#flushPendingTranscripts(id, context)
      }
      const owesSpeech = Boolean(context && !failed && this.#speaksFor(context))
      if (owesSpeech) this.#oweResult(id, context)
      // A result handed to the voice layer to say (GPT-Live commentary) settles
      // without audio of its own; the voice says it in its next segment, so it
      // is delivered. Retrying it read the same result out several times.
      const handedToVoice = event.__voicePlayback === true && !failed
      if (context?.origin === 'announcement') {
        if (completedNonVoiceAnnouncement || handedToVoice) {
          this.announcements.confirmMany(contextTaskIds(context))
        } else if (context.adoptedBy || owesSpeech) {
          // The voice response speaking this result confirms or retries it.
        } else {
          this.announcements.retryMany(contextTaskIds(context))
        }
      } else if (completedNonVoiceTaskNotification) {
        this.announcements.confirmMany(contextTaskIds(context))
      }
      this.contexts.delete(id)
    }
    if (failed && id) {
      this.playbackTurns.delete(id)
      this.announcementWindow.finishPlayback(id, {
        awaitsToolFollowUp: false,
      })
    }
    this.announcementWindow.responseDone({
      turnId: responseTurnId,
      origin: context?.origin || 'model',
      hasAudio: Boolean(context?.hasAudio && !context?.playbackEnded),
      awaitsToolFollowUp: toolFollowUpPending,
      suppressed: Boolean(context?.suppressed) || terminalToolResponse,
      failed,
    })
    if (guardDecision) this.#requestGuardCorrection(guardDecision, context, responseTurnId)
    this.#flushAnnouncementsSoon()
  }

  #requestGuardCorrection(decision, context, responseTurnId) {
    const frontend = this.getFrontend()
    if (
      !this.getOutputEnabled()
      || !frontend?.ready
      || !frontend.capabilities.perResponseInstructions
    ) return
    const generation = context?.turnGeneration
    const isCurrent = () => isResponseGuardTurnCurrent({
      sameFrontend: this.getFrontend() === frontend,
      outputEnabled: this.getOutputEnabled(),
      userSpeaking: this.turns.userSpeaking,
      responseTurnId,
      responseTurnGeneration: generation,
      committedTurnId: this.turns.committedTurnId,
      committedTurnGeneration: this.turns.committedTurnGeneration,
    })
    const turnKey = JSON.stringify([responseTurnId, generation])
    if (!isCurrent() || this.lastCorrectionTurn === turnKey) return
    // The budget belongs to the user turn, not a Response. A correction may
    // itself be invalid; it must never become a self-sustaining response loop.
    this.lastCorrectionTurn = turnKey
    frontend.ensureResponse({
      turnId: responseTurnId,
      turnGeneration: generation,
    }, {
      shouldCreate: isCurrent,
      response: { instructions: decision.instructions },
    }).catch(error => this.send({
      type: GatewayServerEvent.ERROR,
      message: error.message,
    }))
  }

  #emitTranscript({ id, context, content, final }) {
    const citations = final && String(content || '').trim()
      ? this.turnCitations?.consume(context.turnId) || []
      : []
    const invalidModelProtocol = Boolean(
      final
      && context.origin === 'model'
      && containsReservedProtocolEnvelope(content),
    )
    if (final && !invalidModelProtocol) {
      this.conversationSync.record({
        ownerId: this.ownerId,
        sessionId: this.sessionId,
        id: `voice:assistant:${id}`,
        role: 'assistant',
        content,
        source: context.origin === 'model'
          ? 'realtime-direct'
          : 'agent-presentation',
        ...(citations.length ? { citations } : {}),
        ...context,
      })
    }
    this.send({
      type: final
        ? GatewayServerEvent.TRANSCRIPT_FINAL
        : GatewayServerEvent.TRANSCRIPT_DELTA,
      role: 'assistant',
      content: content || '',
      responseId: id,
      ...(citations.length ? { citations } : {}),
      ...this.publicContext(context),
    })
  }

  #flushPendingTranscripts(id, context) {
    for (const transcript of context?.pendingTranscripts || []) {
      this.#emitTranscript({
        id,
        context,
        content: transcript.content,
        final: transcript.final,
      })
    }
    if (context) context.pendingTranscripts = []
  }

  #finishContextIfComplete(id, context) {
    if (
      context
      && context.playbackEnded
      && context.responseDone
      && context.transcriptDone
    ) {
      this.contexts.delete(id)
    }
  }

  #scheduleContextCleanup(id, context) {
    const timer = setTimeout(() => {
      if (this.contexts.get(id) !== context) return
      this.contexts.delete(id)
      this.playbackTurns.delete(id)
      this.announcementWindow.finishPlayback(id, {
        awaitsToolFollowUp: awaitsToolFollowUp(context),
      })
    }, this.responseContextCleanupMs)
    timer.unref?.()
  }

  #flushAnnouncementsSoon() {
    const timer = setTimeout(
      () => this.announcements.flush(),
      this.announcementQuietMs,
    )
    timer.unref?.()
  }

  startPlayback(id) {
    const context = this.contexts.get(id)
    if (context?.suppressed) return
    this.announcementWindow.startPlayback(id)
    const playbackTurnId = context?.turnId
      || this.playbackTurns.get(id)
      || this.turns.turnId
    this.send({
      type: GatewayServerEvent.VOICE_STATE,
      state: 'speaking',
      turnId: playbackTurnId,
      origin: context?.origin || 'model',
    })
    if (!context || context.playbackStarted) return
    context.playbackStarted = true
    if (confirmsTaskNotificationOnPlaybackStart(context)) {
      this.announcements.confirmMany(contextTaskIds(context))
    }
    this.#flushPendingTranscripts(id, context)
  }

  finishPlayback(id) {
    const playbackTurnId = this.playbackTurns.get(id) || this.turns.turnId
    const context = this.contexts.get(id)
    if (context?.suppressed) {
      this.playbackTurns.delete(id)
      return
    }
    this.announcementWindow.finishPlayback(id, {
      awaitsToolFollowUp: awaitsToolFollowUp(context),
    })
    this.playbackTurns.delete(id)
    if (context) {
      context.playbackEnded = true
      this.#finishContextIfComplete(id, context)
      if (this.contexts.get(id) === context) {
        this.#scheduleContextCleanup(id, context)
      }
    }
    const remainsProcessing = Boolean(
      awaitsToolFollowUp(context),
    )
    this.send({
      type: GatewayServerEvent.VOICE_STATE,
      state: this.turns.userSpeaking
        ? 'listening'
        : remainsProcessing
          ? 'processing'
          : 'idle',
      turnId: this.turns.userSpeaking ? this.turns.turnId : playbackTurnId,
      origin: context?.origin || 'model',
    })
    this.#flushAnnouncementsSoon()
  }

  cancelPlayback(id, { reason = '' } = {}) {
    const context = this.contexts.get(id)
    this.announcementWindow.finishPlayback(id, {
      awaitsToolFollowUp: awaitsToolFollowUp(context),
    })
    const playbackTurnId = this.playbackTurns.get(id) || this.turns.turnId
    this.playbackTurns.delete(id)
    if (context?.origin === 'announcement') {
      if (reason === 'user_interruption') {
        this.announcements.confirmMany(contextTaskIds(context))
      } else {
        this.announcements.retryMany(contextTaskIds(context))
      }
    }
    if (context?.playbackStarted && reason === 'user_interruption') {
      this.send({
        type: GatewayServerEvent.RESPONSE_INTERRUPTED,
        responseId: id,
        ...this.publicContext(context),
      })
    }
    if (context) {
      context.suppressed = true
      context.playbackEnded = true
      context.pendingTranscripts = []
      this.#scheduleContextCleanup(id, context)
    }
    this.send({
      type: GatewayServerEvent.VOICE_STATE,
      state: this.turns.userSpeaking ? 'listening' : 'idle',
      turnId: this.turns.userSpeaking ? this.turns.turnId : playbackTurnId,
      origin: context?.origin || 'model',
    })
    this.#flushAnnouncementsSoon()
  }

  cancelPermission(authorizationId) {
    for (const [responseId, context] of this.contexts) {
      if (
        context.origin === 'permission'
        && context.authorizationId === authorizationId
        && !context.suppressed
      ) {
        this.cancelPlayback(responseId, { reason: 'permission_resolved' })
      }
    }
  }

  failResponse(event) {
    const id = realtimeResponseId(event)
    const context = this.contexts.get(id)
    if (context?.origin === 'announcement') {
      this.send({ type: GatewayServerEvent.PLAYBACK_CLEAR })
      this.announcementWindow.finishPlayback(id)
      this.playbackTurns.delete(id)
      this.contexts.delete(id)
      this.announcements.retryMany(contextTaskIds(context))
    } else {
      if (id && context?.hasAudio) {
        this.send({
          type: GatewayServerEvent.AUDIO_DONE,
          responseId: id,
          turnId: context.turnId || this.turns.turnId,
        })
        this.#scheduleContextCleanup(id, context)
      } else if (id) {
        this.contexts.delete(id)
        this.playbackTurns.delete(id)
      }
      this.announcementWindow.responseDone({
        turnId: context?.turnId || this.turns.turnId,
        origin: context?.origin || 'model',
        hasAudio: Boolean(context?.hasAudio),
        awaitsToolFollowUp: false,
        failed: true,
      })
    }
    this.#flushAnnouncementsSoon()
  }

  clear() {
    this.contexts.clear()
    this.playbackTurns.clear()
    for (const { timer } of this.owedResults.values()) clearTimeout(timer)
    this.owedResults.clear()
  }
}
