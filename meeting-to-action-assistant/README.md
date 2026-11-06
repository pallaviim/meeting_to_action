# MeetMind AI — Meeting-to-Action Assistant

Turns meeting transcripts into saved, reviewable summaries, decisions, action items, follow-ups, and clarification questions. The backend uses Groq when configured; it never fabricates an analysis if the provider is unavailable.

## Windows PowerShell setup

1. `cd meeting-to-action-assistant`
2. `Copy-Item backend/.env.example backend/.env`
3. Set `GROQ_API_KEY` in `backend/.env` and optionally `GROQ_MODEL`.
4. `npm install` (root tools), then `npm run install:all` (frontend and backend)
5. `npm run dev`

Open http://localhost:5173. The API runs at http://localhost:3001/api. SQLite data persists in `backend/data/meetmind.sqlite`.

To create a production frontend bundle run `npm run build`. Start the API with `npm start`.

Configuration: `AI_PROVIDER=groq`, `GROQ_API_KEY`, `GROQ_MODEL` (default `openai/gpt-oss-120b`), `PORT=3001`, `DATABASE_PATH=./data/meetmind.sqlite`, `CLIENT_ORIGIN=http://localhost:5173`. The backend explicitly loads `backend/.env`; it does not overwrite environment variables supplied by the shell.

The first-time experience explains that analysis needs a valid Groq API key. Missing credentials return an actionable error; no mock analyses are saved. See backend/.env.example.
