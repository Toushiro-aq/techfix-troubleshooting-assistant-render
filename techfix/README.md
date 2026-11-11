# TechFix

Web-based computer troubleshooting assistant for Grade 12 CSS students.

- `public/index.html` — the whole frontend
- `server.js` — tiny Node server: serves `public/` and handles `POST /api/chat`
- No npm dependencies, nothing to install

## AI key

Set ONE of these environment variables:

- `GEMINI_API_KEY` — free key from https://aistudio.google.com (Get API key). Used first if set.
- `ANTHROPIC_API_KEY` — paid Anthropic key. Used only if no Gemini key is set.

Optional: `GEMINI_MODEL` (default `gemini-3.5-flash`), `ANTHROPIC_MODEL`, `RATE_LIMIT_PER_MIN`.

If Gemini answers with "limit: 0" or a model error, change `GEMINI_MODEL` to another free Flash model listed in AI Studio.

## Run locally

    GEMINI_API_KEY=your-key node server.js

Then open http://localhost:3000

## Deploy on Render

1. Push this repo to GitHub.
2. Render dashboard → New → Web Service → pick the repo.
3. Runtime: Node. Build command: empty (or `echo ok`). Start command: `npm start`. Instance type: Free.
4. Environment variable: `GEMINI_API_KEY` = your key.
5. Deploy.

## Updating

`git add .`, `git commit -m "message"`, `git push` — Render redeploys automatically.
