import { config } from './config.js';

// Minimal client for any OpenAI-compatible chat API (Groq by default; set LLM_BASE_URL to use another).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body, attempt = 0) {
  if (!config.llm.apiKey) {
    const err = new Error('GROQ_API_KEY is not set.');
    err.status = 401;
    throw err;
  }
  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (res.ok) return res.json();

  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  const message = parsed?.error?.message || text.slice(0, 300) || `HTTP ${res.status}`;

  // Rate limit: wait as told (max 20s) and try again.
  if (res.status === 429 && attempt < 2) {
    const wait = Math.min(20, Number(res.headers.get('retry-after')) || 4);
    await sleep(wait * 1000);
    return post(body, attempt + 1);
  }
  // Open models occasionally write a malformed tool call; asking again usually fixes it.
  if (res.status === 400 && /tool_use_failed|failed to call a function|failed_generation/i.test(text) && attempt < 2) {
    return post(body, attempt + 1);
  }
  const err = new Error(message);
  err.status = res.status;
  throw err;
}

export function realClient() {
  return {
    /** @returns {{message: object, finish_reason: string}} first choice of the completion */
    async chat({ system, messages, tools }) {
      const data = await post({
        model: config.model,
        messages: [{ role: 'system', content: system }, ...messages],
        tools: tools?.length ? tools : undefined,
        tool_choice: tools?.length ? 'auto' : undefined,
        max_completion_tokens: 1500,
        temperature: 0.3,
      });
      const choice = data.choices?.[0];
      if (!choice?.message) throw new Error('The AI service returned an empty answer.');
      return choice;
    },
  };
}
