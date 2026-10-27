// Which AI "brain" Jarvis uses. Every provider except anthropic/gemini speaks the
// OpenAI-compatible chat API, so one adapter (openai.js) covers them all.
export const PRESETS = {
  gemini: { keyEnv: 'GEMINI_API_KEY', model: 'gemini-3.8-flash' },
  anthropic: { keyEnv: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5' },
  groq: { keyEnv: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  openrouter: { keyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  mistral: { keyEnv: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
  cerebras: { keyEnv: 'CEREBRAS_API_KEY', baseUrl: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b' },
  // Any other OpenAI-compatible service: set OPENAI_BASE_URL, OPENAI_API_KEY and JARVIS_MODEL.
  openai: { keyEnv: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
};

const AUTO_ORDER = ['anthropic', 'gemini', 'groq', 'openrouter', 'mistral', 'cerebras', 'openai'];

export function pickProvider(env = process.env) {
  const asked = (env.JARVIS_PROVIDER || '').toLowerCase();
  const name = PRESETS[asked] ? asked : AUTO_ORDER.find((n) => env[PRESETS[n].keyEnv]) || 'anthropic';
  const p = PRESETS[name];
  return {
    name,
    keyEnv: p.keyEnv,
    baseUrl: env.OPENAI_BASE_URL || p.baseUrl,
    model: env.JARVIS_MODEL || p.model,
  };
}
