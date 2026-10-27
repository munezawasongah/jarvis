// OpenAI-compatible adapter (Groq, OpenRouter, Mistral, Cerebras, ...). Exposes the slice of the
// Anthropic client that agent.js uses: client.messages.create. History stays in Anthropic format.
import { fetchWithRetry } from './retry.js';

export function toOpenAITools(toolDefs) {
  return toolDefs.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description || t.name, parameters: t.input_schema || { type: 'object', properties: {} } },
  }));
}

export function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${text}` : text });
        } else if (b.type === 'text') {
          out.push({ role: 'user', content: b.text });
        }
      }
    }
  }
  return out;
}

export function fromOpenAIResponse(data) {
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw Object.assign(new Error('The AI returned an empty response.'), { status: 502 });
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(c.function?.arguments || '{}'); } catch { /* model sent bad JSON; run with no args */ }
    content.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
  }
  const hasCall = content.some((b) => b.type === 'tool_use');
  return { content, stop_reason: hasCall ? 'tool_use' : 'end_turn' };
}

export function createOpenAIClient({ apiKey, baseUrl, label = 'AI', fetchImpl = fetch, retry } = {}) {
  return {
    messages: {
      async create({ model, max_tokens, system, tools, messages }) {
        if (!apiKey) throw Object.assign(new Error('API key is not set'), { status: 401 });
        const body = { model, max_tokens, messages: toOpenAIMessages(system, messages) };
        if (tools?.length) body.tools = toOpenAITools(tools);

        const res = await fetchWithRetry(
          () =>
            fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
              body: JSON.stringify(body),
            }),
          retry,
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || `${label} error ${res.status}`;
          console.error(`${label} ${res.status} (${model}):`, JSON.stringify(data).slice(0, 800));
          throw Object.assign(new Error(msg), { status: res.status });
        }
        return fromOpenAIResponse(data);
      },
    },
  };
}
