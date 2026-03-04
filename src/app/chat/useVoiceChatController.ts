import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DefaultChatTransport } from 'ai'
import { useChat } from '@ai-sdk/react'
import type { AgentState } from '@/components/ui/orb'
import {
  AVAILABLE_VOICES,
  DEFAULT_VOICE,
  MAX_CONSECUTIVE_SILENT_TURNS,
  MAX_RECORDING_MS,
  MIN_RECORDING_MS,
  NO_SPEECH_TIMEOUT_MS,
  ORB_COLORS_BY_VOICE,
  SILENCE_DURATION_MS,
  SILENCE_THRESHOLD,
  THREAD_STORAGE_KEY,
  VOICE_STORAGE_KEY,
  type VoiceOption,
  type VoiceState,
} from './constants'
import { createThreadId, getMessageText } from './utils'

export const useVoiceChatController = () => {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingMimeTypeRef = useRef<string>('audio/webm')
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const silenceLoopRef = useRef<number | null>(null)
  const speakingAnimationRef = useRef<number | null>(null)
  const playbackAudioContextRef = useRef<AudioContext | null>(null)
  const playbackAnalyserRef = useRef<AnalyserNode | null>(null)
  const playbackLoopRef = useRef<number | null>(null)
  const revealLoopRef = useRef<number | null>(null)
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)
  const resolvePlaybackRef = useRef<(() => void) | null>(null)
  const activeSessionRef = useRef(false)
  const processingTurnRef = useRef(false)
  const waitingAssistantRef = useRef(false)
  const lastSpokenAssistantIdRef = useRef<string | null>(null)
  const initializedHistoryRef = useRef(false)
  const startListeningTurnRef = useRef<() => Promise<void>>(async () => {})
  const consecutiveSilentTurnsRef = useRef(0)
  const voiceHintRef = useRef<string | null>(null)

  const [isSessionActive, setIsSessionActive] = useState(false)
  const [voiceState, setVoiceState] = useState<VoiceState>('')
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceHint, setVoiceHint] = useState<string | null>(null)
  const [textInput, setTextInput] = useState('')
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [threadId, setThreadId] = useState(() => createThreadId())
  const [selectedVoice, setSelectedVoice] = useState<VoiceOption>(DEFAULT_VOICE)
  const [revealedAssistantMessageId, setRevealedAssistantMessageId] = useState<string | null>(null)
  const [revealedAssistantText, setRevealedAssistantText] = useState('')
  const [isAwaitingAssistant, setIsAwaitingAssistant] = useState(false)
  const [lastSpokenAssistantId, setLastSpokenAssistantId] = useState<string | null>(null)

  const selectedVoiceProfile = useMemo(
    () => AVAILABLE_VOICES.find(voice => voice.id === selectedVoice) ?? AVAILABLE_VOICES[0],
    [selectedVoice]
  )

  const orbColors = useMemo(
    () => ORB_COLORS_BY_VOICE[selectedVoice] ?? ORB_COLORS_BY_VOICE[DEFAULT_VOICE],
    [selectedVoice]
  )

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/voice/chat',
        body: { threadId },
      }),
    [threadId]
  )

  const { messages, sendMessage, setMessages, status } = useChat({
    transport,
  })

  const assistantMessage = useMemo(() => {
    const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant')
    if (!lastAssistant) return null

    return {
      id: lastAssistant.id,
      text: getMessageText(lastAssistant),
    }
  }, [messages])

  const stopSilenceDetection = useCallback(() => {
    if (silenceLoopRef.current) {
      window.cancelAnimationFrame(silenceLoopRef.current)
      silenceLoopRef.current = null
    }

    if (audioContextRef.current) {
      void audioContextRef.current.close()
      audioContextRef.current = null
    }

    analyserRef.current = null
  }, [])

  const stopSpeakingAnimation = useCallback(() => {
    if (speakingAnimationRef.current) {
      window.cancelAnimationFrame(speakingAnimationRef.current)
      speakingAnimationRef.current = null
    }
  }, [])

  const stopPlaybackAnalysis = useCallback(() => {
    if (playbackLoopRef.current) {
      window.cancelAnimationFrame(playbackLoopRef.current)
      playbackLoopRef.current = null
    }

    if (playbackAudioContextRef.current) {
      void playbackAudioContextRef.current.close()
      playbackAudioContextRef.current = null
    }

    playbackAnalyserRef.current = null
  }, [])

  const stopRevealLoop = useCallback(() => {
    if (revealLoopRef.current) {
      window.cancelAnimationFrame(revealLoopRef.current)
      revealLoopRef.current = null
    }
  }, [])

  const stopTracks = useCallback(() => {
    if (!mediaStreamRef.current) return

    for (const track of mediaStreamRef.current.getTracks()) {
      track.stop()
    }

    mediaStreamRef.current = null
  }, [])

  const stopRecorder = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state === 'recording') {
      recorder.stop()
    }
  }, [])

  const stopVoiceSession = useCallback(() => {
    activeSessionRef.current = false
    waitingAssistantRef.current = false
    processingTurnRef.current = false
    setIsSessionActive(false)
    setVoiceState('')
    setIsConnecting(false)
    setRevealedAssistantMessageId(null)
    setRevealedAssistantText('')
    setIsAwaitingAssistant(false)
    consecutiveSilentTurnsRef.current = 0

    if (resolvePlaybackRef.current) {
      resolvePlaybackRef.current()
      resolvePlaybackRef.current = null
    }

    if (currentAudioRef.current) {
      currentAudioRef.current.pause()
      currentAudioRef.current = null
    }

    stopRevealLoop()
    stopSpeakingAnimation()
    stopPlaybackAnalysis()
    stopRecorder()
    stopSilenceDetection()
    stopTracks()
  }, [stopPlaybackAnalysis, stopRecorder, stopRevealLoop, stopSilenceDetection, stopSpeakingAnimation, stopTracks])

  useEffect(() => {
    const storedThreadId = window.localStorage.getItem(THREAD_STORAGE_KEY)
    if (!storedThreadId) return

    setThreadId(storedThreadId)
  }, [])

  useEffect(() => {
    const storedVoice = window.localStorage.getItem(VOICE_STORAGE_KEY)
    if (!storedVoice) return

    if (AVAILABLE_VOICES.some(voice => voice.id === storedVoice)) {
      setSelectedVoice(storedVoice as VoiceOption)
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(THREAD_STORAGE_KEY, threadId)
  }, [threadId])

  useEffect(() => {
    window.localStorage.setItem(VOICE_STORAGE_KEY, selectedVoice)
  }, [selectedVoice])

  useEffect(() => {
    voiceHintRef.current = voiceHint
  }, [voiceHint])

  useEffect(() => {
    const loadHistory = async () => {
      const res = await fetch(`/api/voice/chat?threadId=${encodeURIComponent(threadId)}`)
      const data = await res.json()
      setMessages(data)

      if (!initializedHistoryRef.current) {
        const previousAssistant = [...(data || [])]
          .reverse()
          .find((message: { role?: string; id?: string }) => message.role === 'assistant')

        if (previousAssistant?.id) {
          lastSpokenAssistantIdRef.current = previousAssistant.id
          setLastSpokenAssistantId(previousAssistant.id)
        }

        initializedHistoryRef.current = true
      }
    }

    void loadHistory()
  }, [setMessages, threadId])

  const transcribeAudio = useCallback(async (audioBlob: Blob, fileName: string) => {
    setVoiceError(null)

    const formData = new FormData()
    formData.append('audio', audioBlob, fileName)

    const res = await fetch('/api/voice/transcribe', {
      method: 'POST',
      body: formData,
    })

    const data = (await res.json()) as { text?: string; error?: string }

    if (!res.ok || !data.text) {
      const errorMessage = data.error || 'Falha na transcrição do áudio.'
      setVoiceError(errorMessage)
      throw new Error(errorMessage)
    }

    return data.text
  }, [])

  const synthesizeAudio = useCallback(
    async (text: string) => {
      const res = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: selectedVoice }),
      })

      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        throw new Error(data.error || 'Falha ao gerar áudio da resposta.')
      }

      return res.blob()
    },
    [selectedVoice]
  )

  const playAudio = useCallback(
    async (
      audioBlob: Blob,
      options?: {
        onProgress?: (progress: number) => void
        onComplete?: () => void
        fallbackText?: string
      }
    ) => {
      const sourceUrl = URL.createObjectURL(audioBlob)
      const audio = new Audio(sourceUrl)
      currentAudioRef.current = audio

      stopSpeakingAnimation()
      stopPlaybackAnalysis()

      try {
        const playbackContext = new AudioContext()
        playbackAudioContextRef.current = playbackContext
        const mediaElementSource = playbackContext.createMediaElementSource(audio)
        const playbackAnalyser = playbackContext.createAnalyser()
        playbackAnalyser.fftSize = 1024
        playbackAnalyserRef.current = playbackAnalyser

        mediaElementSource.connect(playbackAnalyser)
        playbackAnalyser.connect(playbackContext.destination)

        const playbackBuffer = new Uint8Array(playbackAnalyser.frequencyBinCount)
        const readOutputEnergy = () => {
          const analyser = playbackAnalyserRef.current
          if (!analyser || voiceState !== 'speaking') return

          analyser.getByteFrequencyData(playbackBuffer)
          playbackLoopRef.current = window.requestAnimationFrame(readOutputEnergy)
        }

        await playbackContext.resume()
        playbackLoopRef.current = window.requestAnimationFrame(readOutputEnergy)
      } catch {
        const start = performance.now()
        const synthOutput = (time: number) => {
          if (voiceState !== 'speaking') return
          void ((time - start) / 1000)
          speakingAnimationRef.current = window.requestAnimationFrame(synthOutput)
        }

        speakingAnimationRef.current = window.requestAnimationFrame(synthOutput)
      }

      await new Promise<void>((resolve, reject) => {
        let lastProgress = 0

        const emitProgress = () => {
          if (!options?.onProgress) return

          const duration = audio.duration
          if (!Number.isFinite(duration) || duration <= 0) return

          const nextProgress = Math.min(1, Math.max(lastProgress, audio.currentTime / duration))
          lastProgress = nextProgress
          options.onProgress(nextProgress)
        }

        const tickProgress = () => {
          emitProgress()

          if (!audio.paused && !audio.ended) {
            revealLoopRef.current = window.requestAnimationFrame(tickProgress)
          }
        }

        const cleanup = () => {
          resolvePlaybackRef.current = null
          audio.onended = null
          audio.onerror = null
          audio.ontimeupdate = null
          stopRevealLoop()
          stopSpeakingAnimation()
          stopPlaybackAnalysis()
          URL.revokeObjectURL(sourceUrl)
        }

        const done = () => {
          options?.onProgress?.(1)
          options?.onComplete?.()
          cleanup()
          resolve()
        }

        resolvePlaybackRef.current = done
        audio.onended = done
        audio.ontimeupdate = emitProgress
        audio.onerror = () => {
          cleanup()
          reject(new Error('Falha ao reproduzir áudio.'))
        }

        audio.play().catch(error => {
          const fallbackText = options?.fallbackText?.trim()

          if (
            fallbackText &&
            typeof window !== 'undefined' &&
            'speechSynthesis' in window &&
            typeof SpeechSynthesisUtterance !== 'undefined'
          ) {
            try {
              window.speechSynthesis.cancel()
              const utterance = new SpeechSynthesisUtterance(fallbackText)
              utterance.lang = 'pt-BR'
              utterance.rate = 1
              utterance.pitch = 1

              utterance.onend = () => {
                options?.onProgress?.(1)
                options?.onComplete?.()
                cleanup()
                resolve()
              }

              utterance.onerror = () => {
                cleanup()
                reject(error)
              }

              window.speechSynthesis.speak(utterance)
              return
            } catch {
              cleanup()
              reject(error)
              return
            }
          }

          cleanup()
          reject(error)
        })

        tickProgress()
      })
    },
    [stopPlaybackAnalysis, stopRevealLoop, stopSpeakingAnimation, voiceState]
  )

  const startListeningTurn = useCallback(async () => {
    if (!activeSessionRef.current) return
    if (status !== 'ready' || waitingAssistantRef.current || processingTurnRef.current) return

    if (voiceState !== 'listening') {
      setVoiceState('listening')
    }

    try {
      if (typeof MediaRecorder === 'undefined') {
        setVoiceError('Seu navegador não suporta gravação de áudio nesta página.')
        setVoiceState('')
        setIsSessionActive(false)
        activeSessionRef.current = false
        return
      }

      setVoiceError(null)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      audioChunksRef.current = []

      const preferredMimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4',
        'audio/mpeg',
      ]

      const supportedMimeType = preferredMimeTypes.find(mimeType =>
        MediaRecorder.isTypeSupported(mimeType)
      )

      const recorder = supportedMimeType
        ? new MediaRecorder(stream, { mimeType: supportedMimeType })
        : new MediaRecorder(stream)

      recordingMimeTypeRef.current = recorder.mimeType || supportedMimeType || 'audio/webm'
      mediaRecorderRef.current = recorder
      const recordingStartedAt = Date.now()
      let heardVoice = false
      let lastVoiceAt = Date.now()
      let noSpeechStop = false

      const audioContext = new AudioContext()
      audioContextRef.current = audioContext
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      analyserRef.current = analyser
      source.connect(analyser)
      const buffer = new Uint8Array(analyser.fftSize)

      recorder.ondataavailable = event => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      recorder.onstop = async () => {
        stopSilenceDetection()
        stopTracks()

        if (noSpeechStop) {
          if (!activeSessionRef.current) return

          const nextSilentTurns = consecutiveSilentTurnsRef.current + 1
          consecutiveSilentTurnsRef.current = nextSilentTurns

          if (nextSilentTurns >= MAX_CONSECUTIVE_SILENT_TURNS) {
            setVoiceHint('Não ouvi sua voz por um tempo. Toque no microfone para continuar quando quiser.')
            stopVoiceSession()
            return
          }

          setVoiceHint(
            nextSilentTurns === 1
              ? 'Estou ouvindo. Pode falar quando quiser.'
              : 'Ainda não detectei voz. Vou continuar escutando.'
          )
          setVoiceState('listening')
          window.setTimeout(() => {
            void startListeningTurnRef.current()
          }, 300)
          return
        }

        const recordedMimeType =
          audioChunksRef.current[0]?.type || recordingMimeTypeRef.current || 'audio/webm'

        const extensionByMimeType: Record<string, string> = {
          'audio/webm': 'webm',
          'audio/webm;codecs=opus': 'webm',
          'audio/mp4': 'm4a',
          'audio/mp4;codecs=mp4a.40.2': 'm4a',
          'audio/mpeg': 'mp3',
        }

        const uploadExtension =
          extensionByMimeType[recordedMimeType] ??
          (recordedMimeType.includes('mp4') ? 'm4a' : recordedMimeType.includes('mpeg') ? 'mp3' : 'webm')

        const audioBlob = new Blob(audioChunksRef.current, { type: recordedMimeType })
        if (!audioBlob.size || !activeSessionRef.current) return

        processingTurnRef.current = true
        setVoiceState('processing')

        try {
          const transcript = await transcribeAudio(audioBlob, `recording.${uploadExtension}`)

          if (transcript.trim()) {
            consecutiveSilentTurnsRef.current = 0
            setVoiceHint(null)
            waitingAssistantRef.current = true
            setIsAwaitingAssistant(true)
            await sendMessage({ text: transcript })
          } else if (activeSessionRef.current) {
            setVoiceState('listening')
            void startListeningTurnRef.current()
          }
        } catch {
          if (activeSessionRef.current) {
            setVoiceState('listening')
            window.setTimeout(() => {
              void startListeningTurnRef.current()
            }, 350)
          }
        } finally {
          processingTurnRef.current = false
        }
      }

      const detectSilence = () => {
        if (!activeSessionRef.current || recorder.state !== 'recording' || !analyserRef.current) {
          return
        }

        analyserRef.current.getByteTimeDomainData(buffer)
        let sumSquares = 0
        for (let index = 0; index < buffer.length; index += 1) {
          const normalized = (buffer[index] - 128) / 128
          sumSquares += normalized * normalized
        }

        const rms = Math.sqrt(sumSquares / buffer.length)
        const now = Date.now()

        if (rms > SILENCE_THRESHOLD) {
          heardVoice = true
          if (consecutiveSilentTurnsRef.current !== 0) {
            consecutiveSilentTurnsRef.current = 0
          }
          if (voiceHintRef.current) {
            setVoiceHint(null)
          }
          lastVoiceAt = now
        }

        const elapsed = now - recordingStartedAt
        const silenceElapsed = now - lastVoiceAt

        if (!heardVoice && elapsed >= NO_SPEECH_TIMEOUT_MS) {
          noSpeechStop = true
          stopRecorder()
          return
        }

        if (
          elapsed >= MAX_RECORDING_MS ||
          (heardVoice && elapsed >= MIN_RECORDING_MS && silenceElapsed >= SILENCE_DURATION_MS)
        ) {
          stopRecorder()
          return
        }

        silenceLoopRef.current = window.requestAnimationFrame(detectSilence)
      }

      recorder.start(200)
      detectSilence()
    } catch {
      setVoiceError('Não foi possível acessar o microfone.')
      setVoiceState('')
      setIsSessionActive(false)
      activeSessionRef.current = false
      stopTracks()
      stopSilenceDetection()
    }
  }, [sendMessage, status, stopRecorder, stopSilenceDetection, stopTracks, stopVoiceSession, transcribeAudio, voiceState])

  startListeningTurnRef.current = startListeningTurn

  const startVoiceSession = useCallback(async () => {
    if (activeSessionRef.current) return

    setVoiceError(null)
    setVoiceHint(null)
    setIsSessionActive(true)
    setIsConnecting(true)
    setVoiceState('listening')
    activeSessionRef.current = true

    await startListeningTurnRef.current()

    if (activeSessionRef.current) {
      setIsConnecting(false)
    }
  }, [])

  const toggleVoiceSession = useCallback(async () => {
    if (isSessionActive) {
      stopVoiceSession()
      return
    }

    await startVoiceSession()
  }, [isSessionActive, startVoiceSession, stopVoiceSession])

  const handleAssistantSpeech = useCallback(
    async (message: { id: string; text: string }) => {
      setRevealedAssistantMessageId(message.id)
      setRevealedAssistantText('')
      waitingAssistantRef.current = false
      setIsAwaitingAssistant(false)
      lastSpokenAssistantIdRef.current = message.id
      setLastSpokenAssistantId(message.id)

      setVoiceState('speaking')
      setVoiceError(null)

      try {
        const audioBlob = await synthesizeAudio(message.text)
        await playAudio(audioBlob, {
          onProgress: progress => {
            const nextLength = Math.min(message.text.length, Math.floor(message.text.length * progress))

            setRevealedAssistantText(message.text.slice(0, nextLength))
          },
          onComplete: () => {
            setRevealedAssistantText(message.text)
          },
          fallbackText: message.text,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Falha ao sintetizar voz.'
        setVoiceError(errorMessage)
        setRevealedAssistantText(message.text)
      } finally {
        setRevealedAssistantMessageId(null)

        if (activeSessionRef.current) {
          setVoiceState('listening')
          await startListeningTurnRef.current()
        } else {
          setVoiceState('')
        }
      }
    },
    [playAudio, synthesizeAudio]
  )

  useEffect(() => {
    if (!waitingAssistantRef.current) return
    if (!assistantMessage?.id || !assistantMessage.text.trim()) return
    if (assistantMessage.id === lastSpokenAssistantIdRef.current) return

    if (status === 'ready') {
      void handleAssistantSpeech(assistantMessage)
      return
    }

    const fallbackTimer = window.setTimeout(() => {
      if (!waitingAssistantRef.current) return
      if (assistantMessage.id === lastSpokenAssistantIdRef.current) return
      void handleAssistantSpeech(assistantMessage)
    }, 2200)

    return () => {
      window.clearTimeout(fallbackTimer)
    }
  }, [assistantMessage, handleAssistantSpeech, status])

  useEffect(() => {
    return () => {
      activeSessionRef.current = false
      waitingAssistantRef.current = false
      processingTurnRef.current = false

      if (resolvePlaybackRef.current) {
        resolvePlaybackRef.current()
        resolvePlaybackRef.current = null
      }

      if (currentAudioRef.current) {
        currentAudioRef.current.pause()
        currentAudioRef.current = null
      }

      stopSpeakingAnimation()
      stopRevealLoop()
      stopPlaybackAnalysis()
      stopRecorder()
      stopSilenceDetection()
      stopTracks()
    }
  }, [stopPlaybackAnalysis, stopRecorder, stopRevealLoop, stopSilenceDetection, stopSpeakingAnimation, stopTracks])

  const isChatConnected =
    isSessionActive || status === 'submitted' || status === 'streaming' || messages.length > 0

  const connectionSubtitle = isConnecting
    ? 'Conectando'
    : isChatConnected
      ? 'Conectado'
      : 'Desconectado'

  const connectionSubtitleClass = isConnecting
    ? 'text-muted-foreground'
    : isChatConnected
      ? 'text-emerald-500'
      : 'text-muted-foreground'

  const orbAgentState: AgentState =
    voiceState === 'listening'
      ? 'listening'
      : voiceState === 'processing'
        ? 'thinking'
        : voiceState === 'speaking'
          ? 'talking'
          : null

  const canSend = status === 'ready' && textInput.trim().length > 0

  const handleSendTextMessage = useCallback(async () => {
    if (!canSend) return

    const message = textInput.trim()
    setTextInput('')

    try {
      waitingAssistantRef.current = true
      setIsAwaitingAssistant(true)
      await sendMessage({ text: message })
    } catch (error) {
      waitingAssistantRef.current = false
      setIsAwaitingAssistant(false)
      const errorMessage = error instanceof Error ? error.message : 'Falha ao enviar mensagem.'
      setVoiceError(errorMessage)
    }
  }, [canSend, sendMessage, textInput])

  const handleCopy = useCallback((index: number, content: string) => {
    navigator.clipboard.writeText(content)
    setCopiedIndex(index)
    window.setTimeout(() => setCopiedIndex(null), 2000)
  }, [])

  const handleRestartConversation = useCallback(() => {
    stopVoiceSession()
    waitingAssistantRef.current = false
    setIsAwaitingAssistant(false)
    processingTurnRef.current = false
    setVoiceHint(null)
    initializedHistoryRef.current = false
    lastSpokenAssistantIdRef.current = null
    setLastSpokenAssistantId(null)

    const nextThreadId = createThreadId()
    setThreadId(nextThreadId)
    setMessages([])
    setVoiceError(null)
    setTextInput('')
    setCopiedIndex(null)
    setRevealedAssistantMessageId(null)
    setRevealedAssistantText('')
  }, [setMessages, stopVoiceSession])

  return {
    messages,
    status,
    assistantMessage,
    selectedVoice,
    setSelectedVoice,
    selectedVoiceProfile,
    orbColors,
    orbAgentState,
    connectionSubtitle,
    connectionSubtitleClass,
    voiceError,
    voiceHint,
    textInput,
    setTextInput,
    copiedIndex,
    revealedAssistantMessageId,
    revealedAssistantText,
    isAwaitingAssistant,
    lastSpokenAssistantId,
    canSend,
    toggleVoiceSession,
    isSessionActive,
    handleSendTextMessage,
    handleCopy,
    handleRestartConversation,
    isConnecting,
  }
}
