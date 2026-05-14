import { chatStream } from './mlx'

interface ThermalState {
  baselineTPS: number
  currentQuantum: number
  cooldownMs: number
  tokenTimestamps: number[]
}

const state: ThermalState = {
  baselineTPS: 0,
  currentQuantum: 40,      // Start with 40-token bursts
  cooldownMs: 80,          // 80ms rest between bursts
  tokenTimestamps: []
}

/** Measure tokens/sec over the last N tokens */
function measureTPS(): number {
  const ts = state.tokenTimestamps
  if (ts.length < 5) return state.baselineTPS || 999
  const windowMs = ts[ts.length - 1] - ts[0]
  return (ts.length - 1) / (windowMs / 1000)
}

/** Calibrate baseline on first warm-up */
export async function calibrateThermal(_python: string, model: string): Promise<void> {
  const warmup = chatStream({
    model,
    messages: [{ role: 'user', content: 'Say hello' }],
    temperature: 0.1
  })
  
  const start = Date.now()
  let tokens = 0
  
  for await (const chunk of warmup) {
    if (chunk.content) tokens++
  }
  
  state.baselineTPS = tokens / ((Date.now() - start) / 1000)
  console.log(`[thermal] Baseline TPS calibrated: ${state.baselineTPS.toFixed(1)}`)
}

/** The novel loop: adaptive burst generation with thermal equilibrium */
export async function* thermalChatStream(
  opts: Parameters<typeof chatStream>[0]
) {
  const stream = chatStream(opts)
  let buffer = ''
  let quantumTokens = 0
  
  for await (const chunk of stream) {
    if (chunk.content) {
      buffer += chunk.content
      quantumTokens++
      state.tokenTimestamps.push(Date.now())
      if (state.tokenTimestamps.length > 25) state.tokenTimestamps.shift()
      
      // Adaptive thermal check every quantum
      if (quantumTokens >= state.currentQuantum) {
        const tps = measureTPS()
        const stress = state.baselineTPS / tps
        
        if (stress > 1.25) {
          // THERMAL THROTTLING DETECTED
          state.currentQuantum = Math.max(10, state.currentQuantum * 0.75)
          state.cooldownMs = Math.min(600, state.cooldownMs * 1.4)
          console.log(`[thermal] Throttling! Quantum→${state.currentQuantum}, Cooldown→${state.cooldownMs}ms`)
          
          // Yield to macOS scheduler + let ANE idle
          await new Promise(r => setTimeout(r, state.cooldownMs))
          
          // Force garbage collection if available (run Electron with --expose-gc)
          if (global.gc) global.gc()
        } else if (stress < 1.05 && state.cooldownMs > 40) {
          // Running cool, can be more aggressive
          state.currentQuantum = Math.min(80, state.currentQuantum * 1.15)
          state.cooldownMs = Math.max(40, state.cooldownMs * 0.85)
        }
        
        quantumTokens = 0
      }
      
      yield chunk
    }
    
    if (chunk.done) {
      yield chunk
      // Reset to conservative defaults after each turn
      state.currentQuantum = 40
      state.cooldownMs = 80
    }
  }
}