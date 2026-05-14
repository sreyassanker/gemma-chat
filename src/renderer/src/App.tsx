import { useEffect, useState } from 'react'
import { DEFAULT_MODEL, type SetupStatus } from '@shared/types'
import Setup from './components/Setup'
import Chat from './components/Chat'

const MODEL_STORAGE_KEY = 'gemma-chat:selected-model'

type AppState =
  | { phase: 'boot' }
  | { phase: 'setup'; status: SetupStatus; model: string }
  | { phase: 'ready'; model: string }
  | { phase: 'switching'; model: string; toModel: string; status: SetupStatus }

function loadPreferredModel(): string {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL
  } catch {
    return DEFAULT_MODEL
  }
}

function savePreferredModel(model: string): void {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, model)
  } catch {
    // ignore persistence failures
  }
}

export default function App() {
  const [state, setState] = useState<AppState>({ phase: 'boot' })

  useEffect(() => {
    // Forward raw Gemma output to devtools console for debugging
    const rawUnsub = window.api.onRawChunk((ev) => {
      // eslint-disable-next-line no-console
      console.log('[gemma]', ev.chunk)
    })
    let unsub: (() => void) | undefined
    ;(async () => {
      const preferredModel = loadPreferredModel()
      const cachedModels = await window.api.listLocalModels()
      const startupModel = cachedModels.includes(DEFAULT_MODEL)
        ? DEFAULT_MODEL
        : cachedModels.includes(preferredModel)
          ? preferredModel
          : cachedModels[0] || preferredModel

      unsub = window.api.onSetupStatus((status) => {
        setState((prev) => {
          if (status.stage === 'ready') {
            // If we were switching, the new model is now ready
            if (prev.phase === 'switching') {
              savePreferredModel(prev.toModel)
              return { phase: 'ready', model: prev.toModel }
            }
            const readyModel = prev.phase === 'setup' ? prev.model : startupModel
            savePreferredModel(readyModel)
            return { phase: 'ready', model: readyModel }
          }
          if (status.stage === 'error') {
            // If switch failed, go back to the previous model
            if (prev.phase === 'switching') {
              return { phase: 'ready', model: prev.model }
            }
          }
          // If we're in switching phase, keep it as switching
          if (prev.phase === 'switching') {
            return { ...prev, status }
          }
          // If we're already ready, don't jump back to setup phase for minor status updates
          if (prev.phase === 'ready') {
            return prev
          }
          const model = prev.phase === 'setup' ? prev.model : startupModel
          return { phase: 'setup', status, model }
        })
      })

      const { hasMLX } = await window.api.checkMLX()
      if (hasMLX && cachedModels.length > 0) {
        setState({
          phase: 'setup',
          status: { stage: 'starting-mlx', message: 'Starting model runtime…' },
          model: startupModel
        })
        window.api.startSetup(startupModel)
        return
      }
      setState({
        phase: 'setup',
        status: { stage: 'checking', message: 'Welcome' },
        model: startupModel
      })
    })()
    return () => {
      unsub?.()
      rawUnsub?.()
    }
  }, [])

  function handleSwitchModel(newModel: string): void {
    setState((prev) => {
      if (prev.phase !== 'ready') return prev
      if (prev.model === newModel) return prev
      return {
        phase: 'switching',
        model: prev.model,
        toModel: newModel,
        status: { stage: 'downloading-model', message: 'Switching model…' }
      }
    })
    window.api.switchModel(newModel)
  }

  if (state.phase === 'boot') {
    return <BootSplash />
  }

  if (state.phase === 'setup') {
    return (
      <div key="setup" className="anim-fade-in h-full w-full">
        <Setup
          status={state.status}
          model={state.model}
          onModelChange={(m) =>
            setState((s) => (s.phase === 'setup' ? { ...s, model: m } : s))
          }
          onStart={(model) => {
            savePreferredModel(model)
            setState({
              phase: 'setup',
              status: { stage: 'checking', message: 'Checking system…' },
              model
            })
            window.api.startSetup(model)
          }}
        />
      </div>
    )
  }

  if (state.phase === 'switching') {
    return (
      <div key="switching" className="anim-fade-in h-full w-full">
        <Chat model={state.model} onSwitchModel={handleSwitchModel} />
        <SwitchingOverlay status={state.status} />
      </div>
    )
  }

  return (
    <div key="chat" className="anim-fade-scale h-full w-full">
      <Chat model={state.model} onSwitchModel={handleSwitchModel} />
    </div>
  )
}

function BootSplash() {
  return (
    <div className="drag flex h-full w-full items-center justify-center">
      <div className="shimmer h-1 w-40 rounded-full" />
    </div>
  )
}

function SwitchingOverlay({ status }: { status: SetupStatus }) {
  return (
    <div className="anim-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="anim-fade-up flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-ink-950 px-10 py-8 shadow-2xl">
        <div className="shimmer h-1 w-32 rounded-full" />
        <p className="text-sm text-ink-200">{status.message}</p>
        {status.progress != null && status.progress > 0 && (
          <div className="w-48">
            <div className="h-1 w-full rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-white/60 transition-all duration-500"
                style={{ width: `${Math.round(status.progress * 100)}%` }}
              />
            </div>
            <p className="mt-1 text-center text-[10px] text-ink-400">
              {Math.round(status.progress * 100)}%
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
