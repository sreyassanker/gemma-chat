import { runTool, type ToolContext } from './tools'
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || ''
const CLOUD_MODEL = 'moonshotai/kimi-k2.6'  // or 'anthropic/claude-sonnet-4'

/** Cloud-based heavy cognition — 0 RAM, 0 heat */
async function cloudCognize(
  role: 'planner' | 'reviewer' | 'researcher',
  context: string
): Promise<string> {
  const prompts = {
    planner: `You are a task planner. Break the user's request into 3-5 executable steps. Return ONLY a JSON array: [{"agent":"executor","task":"..."},{"agent":"researcher","task":"..."}]`,
    reviewer: `You are a code reviewer. Find bugs and suggest fixes. Be concise.`,
    researcher: `You are a research analyst. Synthesize the provided search results into actionable facts.`
  }
  
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: CLOUD_MODEL,
      messages: [
        { role: 'system', content: prompts[role] },
        { role: 'user', content: context }
      ],
      temperature: 0.3,
      max_tokens: 2048
    })
  })
  
  const data = await res.json() as any
  return data.choices?.[0]?.message?.content || ''
}

/** The swarm loop: Cloud plans → Local executes → Cloud reviews */
export async function runSwarm(
  userRequest: string,
  localChat: (messages: any[]) => AsyncGenerator<any>,
  ctx: ToolContext
) {
  // PHASE 1: Cloud Planning (0 heat, 0 RAM)
  const planJson = await cloudCognize('planner', userRequest)
  const plan = JSON.parse(planJson)
  
  const results: any[] = []
  
  // PHASE 2: Local Execution (E2B only, thermal-paced)
  for (const step of plan) {
    if (step.agent === 'executor') {
      // Run through thermalChatStream instead of raw chatStream
      const stream = localChat([
        { role: 'system', content: 'You are the local executor. Use tools to complete the task.' },
        { role: 'user', content: step.task }
      ])
      
      let buffer = ''
      for await (const chunk of stream) {
        if (chunk.content) buffer += chunk.content
        // ... emit to UI
      }
      results.push({ step, result: buffer })
    }
    
    if (step.agent === 'researcher') {
      // Run web search via Node.js (lightweight)
      const searchResults = await runTool('web_search', { query: step.task }, ctx)
      results.push({ step, result: searchResults })
    }
  }
  
  // PHASE 3: Cloud Review (0 heat, 0 RAM)
  const review = await cloudCognize('reviewer', JSON.stringify(results))
  
  return { results, review }
}