import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(backendDir, '..', '.env');

// Load backend/.env during config module initialization, before server code runs.
dotenv.config({ path: envPath });

export function normalizeAIProvider(value) {
  return String(value ?? 'groq').trim().toLowerCase();
}

const groqMaxOutputTokens = 65536;
const configuredGroqMaxCompletionTokens = Number.parseInt(process.env.GROQ_MAX_COMPLETION_TOKENS || '8192', 10);

export const config = Object.freeze({
  aiProvider: normalizeAIProvider(process.env.AI_PROVIDER),
  groqApiKey: process.env.GROQ_API_KEY ?? '',
  groqModel: process.env.GROQ_MODEL?.trim() || 'openai/gpt-oss-120b',
  groqMaxCompletionTokens: Number.isFinite(configuredGroqMaxCompletionTokens)
    ? Math.min(Math.max(configuredGroqMaxCompletionTokens, 256), groqMaxOutputTokens)
    : 8192,
  port: Number(process.env.PORT) || 3001,
  databasePath: path.resolve(backendDir, '..', process.env.DATABASE_PATH || './data/meetmind.sqlite'),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
});
