// TechFix Assistant — plain Node server for Render (no npm dependencies).
// Serves the static site from /public and the AI endpoint at POST /api/chat.

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')
const PORT = process.env.PORT || 3000

// AI provider: set GEMINI_API_KEY (free tier) or ANTHROPIC_API_KEY.
// If both are set, Gemini is used.
const GEMINI_KEY = process.env.GEMINI_API_KEY || ''
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash'
const GEMINI_BASE = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '')

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || ''
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5'
const ANTHROPIC_BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '')

// Simple per-IP rate limit so a stranger can't burn through your API credits.
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN || 20)
const hits = new Map()
function rateLimited(ip) {
  const now = Date.now()
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000)
  recent.push(now)
  hits.set(ip, recent)
  return recent.length > RATE_LIMIT
}
setInterval(() => {
  const now = Date.now()
  for (const [ip, list] of hits) if (!list.some((t) => now - t < 60_000)) hits.delete(ip)
}, 60_000).unref()

const SYSTEM = `You are TechFix Assistant, a friendly, practical computer troubleshooting tutor for Grade 12 Computer Systems Servicing (CSS) students in the Philippines.

How you behave:
- Practical first. Short, clear, everyday words. No long essays. Think "helpful CSS teacher at the lab bench", not a research paper.
- Teach while fixing: for each step give a one-line "why" so the student learns, not just copies.
- Break the problem down: say what the problem most likely is, list the likely causes from most to least likely, and how to tell them apart (quick checks).
- Understand Taglish and casual descriptions (e.g. "ayaw mag-on", "mabagal", "walang display"). "Black screen" / "blank screen" / "no signal" means the No Display guide.
- If a problem description is vague, still give the best guess and ask ONE short follow-up question that would narrow it down.
- Use the conversation history: if the student says "still not working" or answers your question, move to the next most likely cause instead of repeating.
- Prefer the TechFix guides listed below. If one matches, give its exact title.
- Safety: never suggest opening a power supply, board-level repair, registry hacks, or BIOS flashing. For risky or advanced work tell them to ask their CSS teacher or a qualified technician. Remind them to unplug before touching hardware.
- Recommend YouTube lessons as search queries (not video links), short and specific, e.g. "how to reseat RAM desktop". 1–3 queries.
- Stay on topic (computers, devices, networks, basic IT). Friendly small talk is fine; politely steer unrelated requests (homework in other subjects, etc.) back to tech.

First decide what the student's message is:
- "chat": greetings ("hello", "hi", "kumusta"), thanks, small talk, questions about you, general questions or concept questions ("what is RAM?", "difference of SSD and HDD"), or anything that is NOT a device problem to fix. Reply naturally like a friendly ChatGPT-style assistant: short and conversational. For "hello" just greet back and ask what they need help with. For concept questions explain simply in 2–5 sentences, like a teacher. Do NOT invent a problem, causes, or steps. Only include videos if they asked to learn/understand a topic.
- "troubleshoot": the student describes an actual problem with a computer, device, network, or software (or follows up on one, e.g. "still not working", or answers your earlier question). Use the full breakdown.
If a message is unclear (e.g. just "help" or "my pc"), use "chat" and ask what is happening.

Reply ONLY with a JSON object, no markdown fences, in one of these two shapes:

For "chat":
{
  "mode": "chat",
  "message": "your natural reply (may use **bold** and short bullet lines starting with - )",
  "videos": [{"title": "short lesson title", "query": "youtube search query"}]
}
("videos" is an empty array unless they asked to learn a topic.)

For "troubleshoot":
{
  "mode": "troubleshoot",
  "problem": "one sentence: what the problem most likely is",
  "category": "Hardware | Software | Networking | Peripherals | Other",
  "difficulty": "Beginner | Intermediate | Advanced",
  "causes": [{"cause": "likely cause", "check": "quick way to confirm it"}],
  "steps": [{"do": "action to take", "why": "short reason"}],
  "lesson": "1–2 sentences explaining the concept behind the problem, like a teacher",
  "videos": [{"title": "short lesson title", "query": "youtube search query"}],
  "guide": "exact TechFix guide title that matches, or empty string",
  "followUp": "one short question to narrow down the issue, or empty string",
  "askTeacher": "when to stop and ask a teacher/technician, or empty string"
}
The JSON must be complete and valid (escape any quotes inside strings, never leave it unfinished). For troubleshoot, keep causes to 2–4 and steps to 3–6. Each string under ~25 words. Always answer in the same language style the student used: plain English if they wrote in English, Taglish/Filipino only if they did.`

function clean(s, max) {
  return String(s ?? '').slice(0, max)
}

function parseReply(raw) {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  const chunk = raw.slice(start, end + 1)
  // Try as-is, then repair common model slips: raw line breaks inside strings, trailing commas
  const attempts = [chunk, chunk.replace(/[\u0000-\u001F]+/g, ' '), chunk.replace(/[\u0000-\u001F]+/g, ' ').replace(/,\s*([}\]])/g, '$1')]
  for (const a of attempts) {
    try {
      return JSON.parse(a)
    } catch {}
  }
  return null
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

class AIError extends Error {
  constructor(status, userMessage) {
    super(userMessage)
    this.status = status
    this.userMessage = userMessage
  }
}

function failMessage(status) {
  return status === 429 ? 'Too many requests right now — try again in a minute.' : `AI service error (${status}).`
}

const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One request to one Gemini model. Throws {status, detail} on failure.
async function geminiOnce(model, system, contents) {
  let res
  try {
    res = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { maxOutputTokens: 4096, responseMimeType: 'application/json' },
      }),
    })
  } catch (e) {
    throw { status: 0, detail: e?.name === 'TimeoutError' ? 'timed out after 25s' : String(e?.message || e) }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    let detail = body.slice(0, 300)
    try { detail = JSON.parse(body)?.error?.message || detail } catch {}
    throw { status: res.status, detail }
  }
  const data = await res.json()
  const cand = data?.candidates?.[0]
  const text = (cand?.content?.parts || [])
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim()
  if (!text) throw { status: 0, detail: `empty reply (finishReason=${cand?.finishReason || 'none'}, blocked=${data?.promptFeedback?.blockReason || 'no'})` }
  if (cand?.finishReason === 'MAX_TOKENS') throw { status: 0, detail: 'reply was cut off (MAX_TOKENS)' }
  return text
}

// Retries short hiccups (busy / rate limit / timeout), then tries the optional fallback model.
async function callGemini(system, history, query) {
  const contents = [...history, { role: 'user', content: query }].map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: t.content }],
  }))
  const models = [GEMINI_MODEL, ...(GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL ? [GEMINI_FALLBACK_MODEL] : [])]
  let last = { status: 0, detail: 'unknown' }
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await geminiOnce(model, system, contents)
      } catch (err) {
        last = err
        console.error(`Gemini ${model} attempt ${attempt + 1} failed:`, err.status, err.detail)
        const retryable = err.status === 0 || err.status === 429 || err.status >= 500
        if (!retryable) break // bad key, bad model name, bad request: retrying will not help
        if (err.status === 429 && attempt >= 1) break // limit likely used up, move on
        if (attempt < 2) await sleep(1200 * (attempt + 1))
      }
    }
  }
  let msg = 'The AI is having trouble right now.'
  if (last.status === 429) msg = 'The AI is busy (free limit reached) — try again in a minute.'
  else if (last.status === 400 || last.status === 401 || last.status === 403) msg = 'The AI key or settings need fixing (check GEMINI_API_KEY).'
  else if (last.status === 404) msg = 'The AI model name was not found (check GEMINI_MODEL).'
  throw new AIError(502, msg)
}

async function callAnthropic(system, history, query) {
  const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2500,
      system,
      messages: [...history, { role: 'user', content: query }],
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error('Anthropic API error', res.status, detail.slice(0, 500))
    throw new AIError(502, failMessage(res.status))
  }
  const data = await res.json()
  if (data?.stop_reason === 'max_tokens') return '' // cut off: treated as a broken reply and retried
  return (data?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
}

async function handleChat(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' })

  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    return send(res, 400, { error: 'Invalid JSON body.' })
  }
  if (body?.ping) return send(res, 200, { ok: true, configured: Boolean(GEMINI_KEY || ANTHROPIC_KEY) })

  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
  if (rateLimited(ip)) return send(res, 429, { error: 'Too many requests right now — try again in a minute.' })

  const query = clean(body?.query, 1500).trim()
  if (!query) return send(res, 400, { error: 'Missing query.' })
  const guides = clean(body?.guides, 20000)

  const history = Array.isArray(body?.history)
    ? body.history
        .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.content)
        .slice(-8)
        .map((t) => ({ role: t.role, content: clean(t.content, 2000) }))
    : []
  // Anthropic requires the conversation to start with a user turn
  while (history.length && history[0].role !== 'user') history.shift()

  if (!GEMINI_KEY && !ANTHROPIC_KEY) {
    console.error('No API key set (GEMINI_API_KEY or ANTHROPIC_API_KEY)')
    return send(res, 500, { error: 'The AI service is not configured yet.' })
  }

  const system = `${SYSTEM}\n\nTechFix guides available:\n${guides}`

  try {
    // Ask up to twice: if the AI's JSON comes back broken or cut off, try once more.
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = GEMINI_KEY ? await callGemini(system, history, query) : await callAnthropic(system, history, query)
      const reply = raw ? parseReply(raw) : null
      if (reply) return send(res, 200, { text: reply.message || reply.problem || '', reply })
      console.error(`AI reply was not valid JSON (attempt ${attempt + 1}):`, String(raw).slice(0, 200))
    }
    // Never show raw JSON to the student: the page falls back to the offline guide matcher.
    return send(res, 502, { error: 'The AI reply was incomplete — please try again.' })
  } catch (e) {
    if (e instanceof AIError) return send(res, e.status, { error: e.userMessage })
    console.error('AI request failed', e)
    return send(res, 502, { error: 'Could not reach the AI service.' })
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

async function handleStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const rel = urlPath === '/' ? 'index.html' : urlPath
  const file = path.normalize(path.join(PUBLIC_DIR, rel))
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' })
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' })
    res.end(data)
  } catch {
    send(res, 404, { error: 'Not found' })
  }
}

http
  .createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname
    if (pathname === '/api/chat') return handleChat(req, res)
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' })
    if (pathname === '/healthz') return send(res, 200, { ok: true })
    return handleStatic(req, res)
  })
  .listen(PORT, () => console.log(`TechFix running on port ${PORT}`))
