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
For troubleshoot, keep causes to 2–4 and steps to 3–6. Each string under ~25 words. Always answer in the same language style the student used: plain English if they wrote in English, Taglish/Filipino only if they did.`

function clean(s, max) {
  return String(s ?? '').slice(0, max)
}

function parseReply(raw) {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
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

async function callGemini(system, history, query) {
  const contents = [...history, { role: 'user', content: query }].map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: t.content }],
  }))
  const res = await fetch(`${GEMINI_BASE}/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: 2048, responseMimeType: 'application/json' },
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error('Gemini API error', res.status, detail.slice(0, 500))
    throw new AIError(502, failMessage(res.status))
  }
  const data = await res.json()
  const parts = data?.candidates?.[0]?.content?.parts || []
  return parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim()
}

async function callAnthropic(system, history, query) {
  const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1200,
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
  if (body?.ping) return send(res, 200, { ok: true })

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
    const raw = GEMINI_KEY ? await callGemini(system, history, query) : await callAnthropic(system, history, query)
    if (!raw) return send(res, 502, { error: 'Empty AI reply.' })

    const reply = parseReply(raw)
    // `text` is kept so the chat still works if the reply wasn't valid JSON
    return send(res, 200, { text: reply ? reply.message || reply.problem || '' : raw, reply })
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
