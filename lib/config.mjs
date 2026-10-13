import os from 'node:os';
import path from 'node:path';
import { localConfig } from './i18n.mjs';

const home = os.homedir();
const root = path.join(import.meta.dirname, '..');

// Defaults work out of the box; local/config.json (gitignored) and environment variables override them.
export const config = {
  port: Number(process.env.PORT || localConfig.port || 4318),
  dataRoot: process.env.TALK_DATA || localConfig.dataRoot || path.join(root, 'talks'),
  cacheDir: path.join(root, 'data'),
  // "default" is the system input device; `ffmpeg -f avfoundation -list_devices true -i ""` lists names.
  audioDevice: process.env.AUDIO_DEVICE || localConfig.audioDevice || 'default',
  whisperBin: process.env.WHISPER_BIN || 'whisper-cli',
  whisperModel: process.env.WHISPER_MODEL || localConfig.whisperModel || path.join(home, '.cache/whisper/ggml-large-v3-turbo-q5_0.bin'),
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  // Prep searches the web with Claude by default; "grok" uses the Grok CLI instead.
  prepEngine: process.env.PREP_ENGINE || localConfig.prepEngine || 'claude',
  grokBin: process.env.GROK_BIN || localConfig.grokBin || path.join(home, '.grok/bin/grok'),
  scheduleUrl: 'https://ai.engineer/nyc/2026/schedule',
  conference: 'AI Engineer NYC 2026',
  timezone: 'America/New_York',
  // Auto-cut: once a chunk passes minChunk seconds, cut at the next pause; force a cut at maxChunk.
  minChunk: 300,
  maxChunk: 420,
  pieceSeconds: 10,
};

// Terms Whisper tends to misspell at an AI engineering conference.
export const glossary = [
  'Claude', 'Claude Code', 'Anthropic', 'OpenAI', 'Gemini', 'MCP', 'Model Context Protocol',
  'LLM', 'RAG', 'evals', 'agentic', 'harness', 'prompt caching', 'context window', 'fine-tuning',
  'RL', 'post-training', 'inference', 'tokens', 'embeddings', 'vector DB', 'LangChain', 'LangGraph',
  'Cursor', 'Copilot', 'swyx', 'Latent Space', 'hill climb', 'subagents', 'skills', 'A2A',
];
