import {
  wsWriteFile,
  wsReadFile,
  wsEditFile,
  wsDeleteFile,
  wsRunBash,
  ensureWorkspace,
  listTree,
  previewUrl
} from './workspace'

export interface ToolContext {
  conversationId: string
  onFileChange?: () => void
}

export interface ToolSpec {
  name: string
  description: string
  params: Array<{ name: string; description: string; required?: boolean; multiline?: boolean }>
  example: string
  mode: 'chat' | 'code' | 'both'
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

const DEFAULT_SEARXNG_INSTANCES = [
  'https://search.sapti.me',
  'https://searx.be',
  'https://search.bus-hit.me',
  'https://searx.tiekoetter.com',
  'https://opnxng.com'
]

const SEARX_SPACE_BOOTSTRAP_URL = 'https://searx.space/data/instances.json'
const SEARX_INSTANCE_CACHE_TTL_MS = 15 * 60 * 1000
const SEARCH_TIMEOUT_MS = 8000

interface SearchHit {
  title: string
  url: string
  snippet: string
}

let cachedSearxInstances:
  | {
      expiresAt: number
      urls: string[]
    }
  | null = null

function normalizeBaseUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (!/^https?:$/.test(url.protocol)) return null
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.origin}${path}`
  } catch {
    return null
  }
}

function splitInstanceConfig(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((value) => normalizeBaseUrl(value))
    .filter((value): value is string => !!value)
}

function configuredSearxInstances(): string[] {
  const raw = process.env.SEARXNG_BASE_URL ?? process.env.SEARXNG_INSTANCES ?? ''
  return unique(splitInstanceConfig(raw))
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function joinSearchEndpoint(base: string, path: string, params: Record<string, string>): string {
  const root = new URL(base.endsWith('/') ? base : `${base}/`)
  const url = new URL(path, root)
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value)
  }
  return url.toString()
}

function collectPotentialUrls(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    const matches = value.match(/https?:\/\/[^\s"'<>]+/g) ?? []
    for (const match of matches) out.add(match)
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) collectPotentialUrls(item, out)
    return
  }

  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectPotentialUrls(key, out)
      collectPotentialUrls(item, out)
    }
  }
}

function isLikelySearxInstance(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (host === 'searx.space' || host === 'docs.searxng.org' || host.includes('github.com')) {
      return false
    }
    return url.pathname === '/' || url.pathname === ''
  } catch {
    return false
  }
}

async function discoverSearxInstances(): Promise<string[]> {
  if (cachedSearxInstances && cachedSearxInstances.expiresAt > Date.now()) {
    return cachedSearxInstances.urls
  }

  const configured = configuredSearxInstances()
  const discovered = new Set<string>()

  try {
    const res = await fetch(SEARX_SPACE_BOOTSTRAP_URL, {
      headers: { Accept: 'application/json', 'user-agent': UA },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
    })
    if (res.ok) {
      const data = (await res.json()) as unknown
      collectPotentialUrls(data, discovered)
    }
  } catch {
    // fall back to defaults below
  }

  const dynamic = shuffle(
    unique(
      [...discovered]
        .map((value) => normalizeBaseUrl(value))
        .filter((value): value is string => !!value && isLikelySearxInstance(value))
    )
  )

  const urls = unique([...configured, ...dynamic, ...DEFAULT_SEARXNG_INSTANCES])
  cachedSearxInstances = {
    urls,
    expiresAt: Date.now() + SEARX_INSTANCE_CACHE_TTL_MS
  }
  return urls
}

function normalizeResultUrl(rawUrl: string, base: string): string | null {
  try {
    const url = new URL(rawUrl, base)
    const redirectTarget = url.searchParams.get('url')
    if (
      redirectTarget &&
      (url.pathname.includes('/url') || url.pathname.includes('/redirect'))
    ) {
      return redirectTarget
    }
    return url.toString()
  } catch {
    return null
  }
}

function formatSearchHits(hits: SearchHit[]): string {
  return hits
    .slice(0, 8)
    .map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet.slice(0, 200)}`)
    .join('\n\n')
}

function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>()
  const out: SearchHit[] = []
  for (const hit of hits) {
    const key = hit.url.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out
}

function parseJsonHits(data: unknown, base: string): SearchHit[] {
  const results = (data as { results?: Array<Record<string, unknown>> })?.results
  if (!Array.isArray(results)) return []

  return dedupeHits(
    results
      .map((result) => {
        const title = typeof result.title === 'string' ? htmlToText(result.title) : ''
        const url =
          typeof result.url === 'string' ? normalizeResultUrl(result.url, base) : null
        const snippetSource =
          typeof result.content === 'string'
            ? result.content
            : typeof result.snippet === 'string'
              ? result.snippet
              : typeof result.pretty_url === 'string'
                ? result.pretty_url
                : ''
        const snippet = htmlToText(snippetSource)
        if (!title || !url) return null
        return { title, url, snippet: snippet || 'No snippet available.' }
      })
      .filter((hit): hit is SearchHit => !!hit)
  )
}

async function searchSearxJson(base: string, q: string): Promise<SearchHit[]> {
  const url = joinSearchEndpoint(base, 'search', {
    q,
    format: 'json',
    pageno: '1',
    safesearch: '0'
  })
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  })

  if (res.status === 403) {
    throw new Error('json format disabled')
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }

  const data = (await res.json()) as unknown
  const hits = parseJsonHits(data, base)
  if (!hits.length) {
    throw new Error('no JSON results')
  }
  return hits
}

function parseHtmlHits(html: string, base: string): SearchHit[] {
  const blocks =
    html.match(/<article\b[\s\S]*?<\/article>/gi) ??
    html.match(/<div\b[^>]*class=(["'])[^"']*\bresult\b[^"']*\1[\s\S]*?<\/div>/gi) ??
    []

  return dedupeHits(
    blocks
      .map((block) => {
        const anchorMatch =
          block.match(
            /<h[1-6][^>]*>[\s\S]*?<a[^>]+href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/i
          ) ?? block.match(/<a[^>]+href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/i)
        if (!anchorMatch) return null

        const url = normalizeResultUrl(anchorMatch[2], base)
        const title = htmlToText(anchorMatch[3])
        if (!url || !title) return null

        const snippetMatch =
          block.match(/<p[^>]*class=(["'])[^"']*\bcontent\b[^"']*\1[^>]*>([\s\S]*?)<\/p>/i) ??
          block.match(
            /<div[^>]*class=(["'])[^"']*\b(content|description)\b[^"']*\1[^>]*>([\s\S]*?)<\/div>/i
          )
        const snippet = htmlToText(snippetMatch?.[2] ?? snippetMatch?.[3] ?? '')

        return {
          title,
          url,
          snippet: snippet || 'No snippet available.'
        }
      })
      .filter((hit): hit is SearchHit => !!hit)
  )
}

async function searchSearxHtml(base: string, q: string): Promise<SearchHit[]> {
  const url = joinSearchEndpoint(base, 'search', {
    q,
    pageno: '1',
    safesearch: '0',
    theme: 'simple'
  })
  const res = await fetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml', 'user-agent': UA },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }

  const html = await res.text()
  const hits = parseHtmlHits(html, base)
  if (!hits.length) {
    throw new Error('no HTML results')
  }
  return hits
}

async function searchSearxInstance(base: string, q: string): Promise<SearchHit[]> {
  try {
    return await searchSearxJson(base, q)
  } catch (jsonError) {
    try {
      return await searchSearxHtml(base, q)
    } catch (htmlError) {
      const jsonMessage = (jsonError as Error).message
      const htmlMessage = (htmlError as Error).message
      throw new Error(`${jsonMessage}; html fallback failed: ${htmlMessage}`)
    }
  }
}

async function webSearch(args: Record<string, unknown>): Promise<string> {
  const q = String(args.query ?? '').trim()
  if (!q) return 'Error: missing query'

  const instances = await discoverSearxInstances()
  const errors: string[] = []

  for (const base of instances) {
    try {
      const hits = await searchSearxInstance(base, q)
      if (hits.length) return formatSearchHits(hits)
    } catch (e) {
      errors.push(`${base}: ${(e as Error).message}`)
    }
  }

  const detail = errors.slice(0, 3).join(' | ')
  return detail
    ? `Error: Search unavailable across ${instances.length} SearXNG instance(s). ${detail}`
    : 'Error: Search unavailable. Check internet connection or configure SEARXNG_BASE_URL.'
}

async function fetchUrl(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? '').trim()
  if (!url) return 'Error: missing url'
  if (!/^https?:\/\//.test(url)) return 'Error: url must be http(s)'
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA } })
    if (!res.ok) return `Fetch failed: ${res.status} ${res.statusText}`
    const ct = res.headers.get('content-type') || ''
    const text = await res.text()
    if (ct.includes('html')) {
      return htmlToText(text).slice(0, 8000)
    }
    return text.slice(0, 8000)
  } catch (e) {
    return `Error fetching: ${(e as Error).message}`
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

async function calc(args: Record<string, unknown>): Promise<string> {
  const expr = String(args.expression ?? '').trim()
  if (!expr) return 'Error: missing expression'
  if (!/^[0-9+\-*/().\s^%,eE]*$/.test(expr)) {
    return 'Error: only numeric expressions allowed'
  }
  try {
    const sanitized = expr.replace(/\^/g, '**')
    const result = Function(`"use strict"; return (${sanitized})`)()
    return String(result)
  } catch (e) {
    return `Error: ${(e as Error).message}`
  }
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = String(args.path ?? '').trim()
  const raw = typeof args.content === 'string' ? args.content : ''
  if (!path) return 'Error: missing <path>'
  const content = cleanFileContent(raw, path)
  await wsWriteFile(ctx.conversationId, path, content)
  ctx.onFileChange?.()
  const lines = content.split('\n').length
  return `Wrote ${path} (${content.length} bytes, ${lines} lines).`
}

export function cleanFileContent(raw: string, path: string): string {
  let s = raw

  // Case 1: fully wrapped in ```lang ... ```
  const full = s.trim().match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```[\s\S]*$/)
  if (full) {
    s = full[1]
  } else {
    // Case 2: just a leading fence ```lang\n
    const lead = s.match(/^\s*```[a-zA-Z0-9_-]*\n/)
    if (lead) {
      s = s.slice(lead[0].length)
      // If there's a trailing fence somewhere, cut everything from there
      const trail = s.search(/\n```(?:\s|$)/)
      if (trail >= 0) s = s.slice(0, trail)
    }
  }

  // Case 3: file-type-aware truncation of post-file commentary
  const lower = path.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    const end = s.toLowerCase().lastIndexOf('</html>')
    if (end >= 0) s = s.slice(0, end + '</html>'.length) + '\n'
  } else if (lower.endsWith('.svg')) {
    const end = s.toLowerCase().lastIndexOf('</svg>')
    if (end >= 0) s = s.slice(0, end + '</svg>'.length) + '\n'
  } else if (lower.endsWith('.json')) {
    // Trim anything after a trailing } or ]
    const trimmed = s.trim()
    const lastBrace = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'))
    if (lastBrace >= 0) s = trimmed.slice(0, lastBrace + 1) + '\n'
  }

  return s
}

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = String(args.path ?? '').trim()
  if (!path) return 'Error: missing <path>'
  try {
    const content = await wsReadFile(ctx.conversationId, path)
    if (content.length > 20_000) {
      return content.slice(0, 20_000) + '\n[…truncated]'
    }
    return content
  } catch (e) {
    return `Error reading ${path}: ${(e as Error).message}`
  }
}

async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = String(args.path ?? '').trim()
  const oldStr = typeof args.old_string === 'string' ? args.old_string : ''
  const newStr = typeof args.new_string === 'string' ? args.new_string : ''
  const replaceAll = args.replace_all === true || args.replace_all === 'true'
  if (!path) return 'Error: missing <path>'
  if (!oldStr) return 'Error: missing <old_string>'
  try {
    const r = await wsEditFile(ctx.conversationId, path, oldStr, newStr, replaceAll)
    ctx.onFileChange?.()
    return `Edited ${path} (${r.occurrences} replacement${r.occurrences === 1 ? '' : 's'}).`
  } catch (e) {
    return `Error editing ${path}: ${(e as Error).message}`
  }
}

async function listFiles(
  _args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const base = await ensureWorkspace(ctx.conversationId)
  const tree = await listTree(base, 200)
  if (tree.length === 0) return '(workspace is empty)'
  return tree
    .map((e) =>
      e.kind === 'dir' ? `${e.path}/` : `${e.path}${e.size != null ? ` (${e.size}B)` : ''}`
    )
    .join('\n')
}

async function deleteFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = String(args.path ?? '').trim()
  if (!path) return 'Error: missing <path>'
  try {
    await wsDeleteFile(ctx.conversationId, path)
    ctx.onFileChange?.()
    return `Deleted ${path}.`
  } catch (e) {
    return `Error deleting ${path}: ${(e as Error).message}`
  }
}

async function runBash(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const command = String(args.command ?? '').trim()
  const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 60_000
  if (!command) return 'Error: missing <command>'
  try {
    const r = await wsRunBash(ctx.conversationId, command, timeout)
    ctx.onFileChange?.()
    const parts: string[] = []
    parts.push(`exit=${r.exitCode ?? 'killed'} (${r.durationMs}ms)`)
    if (r.stdout) parts.push('stdout:\n' + r.stdout)
    if (r.stderr) parts.push('stderr:\n' + r.stderr)
    if (r.truncated) parts.push('[output was truncated]')
    return parts.join('\n')
  } catch (e) {
    return `Error: ${(e as Error).message}`
  }
}

async function openPreview(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const url = previewUrl(ctx.conversationId)
  return `Preview is live at ${url}. The Canvas pane on the right shows it.`
}

export const TOOLS: Record<string, ToolSpec> = {
  web_search: {
    name: 'web_search',
    description:
      'Search the web via SearXNG with multi-instance fallback. Returns a numbered list of results.',
    params: [{ name: 'query', description: 'what to search for', required: true }],
    example:
      '<action name="web_search">\n<query>latest tensorflow release notes</query>\n</action>',
    mode: 'both',
    run: webSearch
  },
  fetch_url: {
    name: 'fetch_url',
    description: 'Fetch a web page and return its text content (truncated to ~8KB).',
    params: [{ name: 'url', description: 'absolute http(s) URL', required: true }],
    example: '<action name="fetch_url">\n<url>https://example.com</url>\n</action>',
    mode: 'both',
    run: fetchUrl
  },
  calc: {
    name: 'calc',
    description: 'Evaluate a numeric expression.',
    params: [{ name: 'expression', description: 'math expression', required: true }],
    example: '<action name="calc">\n<expression>2 + 2 * 3</expression>\n</action>',
    mode: 'both',
    run: calc
  },
  write_file: {
    name: 'write_file',
    description:
      'Create or overwrite a file in the workspace. Use this to generate code, HTML, CSS, JSON, etc.',
    params: [
      { name: 'path', description: 'path relative to workspace (e.g. index.html)', required: true },
      { name: 'content', description: 'full file text', required: true, multiline: true }
    ],
    example:
      '<action name="write_file">\n<path>index.html</path>\n<content>\n<!doctype html>\n<html>\n<body>Hello</body>\n</html>\n</content>\n</action>',
    mode: 'code',
    run: writeFile
  },
  read_file: {
    name: 'read_file',
    description: 'Read a file from the workspace.',
    params: [{ name: 'path', description: 'path relative to workspace', required: true }],
    example: '<action name="read_file">\n<path>index.html</path>\n</action>',
    mode: 'code',
    run: readFile
  },
  edit_file: {
    name: 'edit_file',
    description:
      'Replace a snippet in an existing file. old_string must appear exactly once, or pass <replace_all>true</replace_all>.',
    params: [
      { name: 'path', description: 'file path', required: true },
      { name: 'old_string', description: 'exact text to find', required: true, multiline: true },
      { name: 'new_string', description: 'replacement text', required: true, multiline: true },
      { name: 'replace_all', description: 'true to replace every occurrence' }
    ],
    example:
      '<action name="edit_file">\n<path>index.html</path>\n<old_string>Hello</old_string>\n<new_string>Hello, world</new_string>\n</action>',
    mode: 'code',
    run: editFile
  },
  list_files: {
    name: 'list_files',
    description: 'List every file in the workspace.',
    params: [],
    example: '<action name="list_files"></action>',
    mode: 'code',
    run: listFiles
  },
  delete_file: {
    name: 'delete_file',
    description: 'Delete a file or directory from the workspace.',
    params: [{ name: 'path', description: 'path to delete', required: true }],
    example: '<action name="delete_file">\n<path>old.html</path>\n</action>',
    mode: 'code',
    run: deleteFile
  },
  run_bash: {
    name: 'run_bash',
    description:
      'Run a bash command inside the workspace directory. Use for npm install, git, formatters, quick checks.',
    params: [
      { name: 'command', description: 'shell command', required: true, multiline: true }
    ],
    example: '<action name="run_bash">\n<command>ls -la</command>\n</action>',
    mode: 'code',
    run: runBash
  },
  open_preview: {
    name: 'open_preview',
    description:
      'Reveal the Canvas preview. Call after creating or updating index.html so the user sees the result.',
    params: [],
    example: '<action name="open_preview"></action>',
    mode: 'code',
    run: openPreview
  }
}

function tz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

function renderToolHelp(mode: 'chat' | 'code'): string {
  const wanted = (t: ToolSpec): boolean => t.mode === 'both' || t.mode === mode
  const lines: string[] = []
  for (const t of Object.values(TOOLS)) {
    if (!wanted(t)) continue
    lines.push(`### ${t.name}`)
    lines.push(t.description)
    if (t.params.length) {
      lines.push('Parameters:')
      for (const p of t.params) {
        const req = p.required ? ' (required)' : ''
        const multi = p.multiline ? ' — multi-line OK' : ''
        lines.push(`  <${p.name}>: ${p.description}${req}${multi}`)
      }
    } else {
      lines.push('No parameters.')
    }
    lines.push('Example:')
    lines.push(t.example)
    lines.push('')
  }
  return lines.join('\n')
}

export function chatSystemPrompt(enableTools: boolean): string {
  const now = new Date().toISOString()
  const day = new Date().toLocaleDateString('en-US', { weekday: 'long' })
  if (!enableTools) {
    return [
      "You are Gemma, an AI assistant running 100% locally on the user's Mac.",
      `Current date/time: ${now} (${day}). Timezone: ${tz()}.`,
      'Be rigorously honest, evidence-first, and constructive.',
      'Speak with high agency and optimism about solutions, but never fake certainty or soften the truth.',
      'Think like a world-class interdisciplinary scientist and engineer: precise, skeptical, quantitative, and deeply analytical.',
      'Clearly separate facts, inference, and speculation.',
      'Use markdown for formatting when useful.'
    ].join('\n')
  }
  return [
    "You are Gemma, an AI assistant running 100% locally on the user's Mac.",
    `Current date/time: ${now} (${day}). Timezone: ${tz()}.`,
    '',
    'IDENTITY',
    '========',
    '- Tell the truth even when it is inconvenient, unpopular, or disappointing.',
    '- Be constructively tough-minded: brutal about facts, positive about what can be done next.',
    '- Think like a top 1% scientist and engineer: rigorous, skeptical, causal, quantitative, and detail-oriented.',
    '- Maintain broad interdisciplinary knowledge, but never pretend certainty you do not have.',
    '- Separate observed facts, inferences, assumptions, and speculation whenever that distinction matters.',
    '',
    'RESEARCH STANDARD',
    '=================',
    '- For every user question or information request, use web_search first before answering.',
    '- For current events, news, changing facts, products, science, medicine, law, finance, or anything time-sensitive, search first and usually fetch_url the best 1-3 sources before giving the final answer.',
    '- Do not trust search snippets alone when the answer depends on concrete facts; verify with fetch_url when needed.',
    '- If the first search results are noisy, low-quality, SEO-heavy, contradictory, or irrelevant, refine the query and search again.',
    '- If a question includes words like "latest", "today", "right now", or "recent", search using those terms and mention concrete dates in the final answer.',
    '- If tools fail or evidence is weak, say so plainly instead of bluffing.',
    '',
    'TOOL USE',
    '========',
    'When a tool helps, emit ONE action block and STOP. You will receive the result, then you may continue or call another tool.',
    '',
    'Action format:',
    '<action name="tool_name">',
    '<param_name>value</param_name>',
    '</action>',
    '',
    'Rules:',
    '- One action per response, on its own line.',
    '- Never wrap actions in markdown code fences.',
    '- After writing </action>, STOP. Wait for the result before continuing.',
    '- After enough evidence is gathered, write the final answer in plain text or markdown and emit no more actions.',
    '- Never print scratchpad tags such as <observation>, <analysis>, or raw JSON notes in the user-facing reply.',
    '- If you expose internal reasoning, use <thinking>...</thinking> only. Do not expose tool observations outside that block.',
    '- Your final answer must be honest, specific, and grounded in the gathered evidence.',
    '',
    'Tools:',
    '',
    renderToolHelp('chat')
  ].join('\n')
}

export function codeSystemPrompt(workspacePath: string, previewHref: string): string {
  const now = new Date().toISOString()
  const day = new Date().toLocaleDateString('en-US', { weekday: 'long' })
  return [
    "You are Gemma, a local coding agent running entirely on the user's Mac.",
    `Date: ${now} (${day}). Workspace: ${workspacePath}. Preview: ${previewHref}`,
    '',
    'WHAT TO BUILD',
    'You build small apps, pages, demos, and scripts. Quality matters — the user is watching.',
    '- Modern, polished design by default: clean typography, generous whitespace, subtle gradients, rounded corners, smooth transitions. Dark-mode-friendly when it fits.',
    '- Real-feeling copy, not lorem ipsum. Invent brand names and details.',
    '- Make it actually work: click handlers wired, animations smooth, forms usable.',
    '- Fetch real images only when asked; otherwise use CSS/SVG for illustrations.',
    '',
    'FILE STRUCTURE — PREFER MULTI-FILE FOR ANYTHING NON-TRIVIAL',
    '- One-off widgets / tiny demos → single `index.html` with <style> + <script> inline.',
    '- Landing pages, apps with state, anything > ~200 lines → split into:',
    '    `index.html` — structure + <link rel="stylesheet" href="style.css"> + <script src="app.js" defer></script>',
    '    `style.css`  — all styling',
    '    `app.js`     — all behavior',
    '- Multi-file is easier to read, edit later, and shows off modular thinking. Emit a separate write_file action for each file.',
    '',
    'HOW YOU WORK',
    '1. Start with ONE sentence describing your plan (e.g., "I\'ll split this into index.html, style.css, and app.js."). Then IMMEDIATELY emit your first write_file action in the SAME response. Do NOT stop after planning — start building right away.',
    '2. After each action, STOP and wait for the result. In subsequent turns, one sentence of narration (e.g., "Now the stylesheet."), then the action, then STOP.',
    '3. After all files are written, call `open_preview`, then write a one-sentence plain-text summary. Emit no further actions.',
    '',
    'CRITICAL: You MUST emit a write_file action in your VERY FIRST response. Never respond with only a plan or description. Always start coding immediately.',
    'Never print scratchpad tags such as <observation> or <analysis>. Only use <action> blocks for tool calls.',
    '',
    'ACTION FORMAT — EXACT',
    '<action name="tool_name">',
    '<param_name>value</param_name>',
    '</action>',
    '',
    '<content> RULES — READ TWICE',
    'The string between <content> and </content> is WRITTEN TO DISK LITERALLY. Everything is saved.',
    '- NEVER put ``` fences at the start or end of <content>. Not ``` alone, not ```html, not ```js. None.',
    '- NEVER put explanatory text, "Key Features", "Instructions to Use", or any commentary INSIDE <content>. Only the file contents.',
    '- Close <content> with </content> on its own line, immediately after the last line of the file.',
    '- Then close the action with </action> on its own line.',
    '',
    'EXAMPLE — multi-file build (FIRST response)',
    '',
    "I'll split this into three files: index.html for structure, style.css for the design, and app.js for the countdown behavior. Starting with the HTML shell.",
    '',
    '<action name="write_file">',
    '<path>index.html</path>',
    '<content>',
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Coming Soon</title>',
    '<link rel="stylesheet" href="style.css">',
    '<script src="app.js" defer></script>',
    '</head>',
    '<body><main><h1>Coming soon</h1></main></body>',
    '</html>',
    '</content>',
    '</action>',
    '',
    'HARD RULES',
    '- ALWAYS start coding in your first response. Never reply with only a plan.',
    '- Never paste file contents in your chat reply — only inside <content>.',
    '- Never wrap <action> tags in ``` code fences.',
    '- Paths are relative to the workspace (no leading slashes).',
    '- One action per response, then STOP and wait.',
    '',
    'AVAILABLE TOOLS',
    '',
    renderToolHelp('code')
  ].join('\n')
}

export interface ParsedAction {
  name: string
  args: Record<string, unknown>
  raw: string
  start: number
  end: number
}

export function findNextAction(text: string, from = 0): ParsedAction | 'incomplete' | null {
  // Accept variations: <action name="x">, name='x', name=x, case-insensitive
  const openRe = /<action\s+name\s*=\s*["']?([a-zA-Z_][\w]*)["']?\s*>/gi
  openRe.lastIndex = from
  const open = openRe.exec(text)
  if (!open) return null
  const name = open[1]
  const bodyStart = open.index + open[0].length
  const closeMatch = text.slice(bodyStart).match(/<\/action\s*>/i)
  if (!closeMatch || closeMatch.index === undefined) return 'incomplete'
  const closeIdx = bodyStart + closeMatch.index
  const body = text.slice(bodyStart, closeIdx)
  const args = parseActionBody(body)
  return {
    name,
    args,
    raw: text.slice(open.index, closeIdx + closeMatch[0].length),
    start: open.index,
    end: closeIdx + closeMatch[0].length
  }
}

function parseActionBody(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}

  // Special-case <content>…</content> — use the LAST </content> to survive nested close-tags
  const contentOpen = body.indexOf('<content>')
  let outside = body
  if (contentOpen >= 0) {
    const contentCloseRel = body.lastIndexOf('</content>')
    if (contentCloseRel > contentOpen) {
      let content = body.slice(contentOpen + '<content>'.length, contentCloseRel)
      content = content.replace(/^\n/, '')
      content = content.replace(/\n[ \t]*$/, '')
      args.content = content
      outside = body.slice(0, contentOpen) + body.slice(contentCloseRel + '</content>'.length)
    }
  }

  const tagRe = /<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(outside)) !== null) {
    const key = m[1]
    if (key === 'content') continue
    const raw = m[2]
    const trimmed = raw.trim()
    if (trimmed === 'true') args[key] = true
    else if (trimmed === 'false') args[key] = false
    else if (/^-?\d+$/.test(trimmed)) args[key] = Number(trimmed)
    else args[key] = raw.replace(/^\n/, '').replace(/\n[ \t]*$/, '')
  }
  return args
}

export function emitSafeBoundary(buffer: string, from: number): number {
  // Return the largest index ≤ buffer.length such that the slice [from, idx)
  // cannot be the start of a forming <action ...> tag.
  // Scan backwards from the end for a '<' that could start "<action".
  for (let i = buffer.length - 1; i >= from; i--) {
    if (buffer[i] !== '<') continue
    const tail = buffer.slice(i).toLowerCase()
    // Could this be the start of "<action"? If tail is shorter than "<action"
    // we can't be sure yet — hold back.
    if (tail.length < 8) {
      if ('<action'.startsWith(tail)) return i
      continue
    }
    if (tail.startsWith('<action') && /\s/.test(tail[7])) return i
    // Otherwise this '<' is some other tag — safe.
  }
  return buffer.length
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const tool = TOOLS[name]
  if (!tool) return `Error: unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}`
  try {
    return await tool.run(args, ctx)
  } catch (e) {
    return `Error running ${name}: ${(e as Error).message}`
  }
}
