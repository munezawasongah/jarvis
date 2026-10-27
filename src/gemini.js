// Gemini adapter: exposes the small slice of the Anthropic client that agent.js uses
// (client.messages.create) but talks to Google's Gemini REST API. No extra dependency.
// History stays in Anthropic format; it is converted on every call.

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const KEEP = new Set(['type', 'description', 'properties', 'items', 'enum', 'required', 'nullable']);

/** Gemini accepts only a subset of JSON Schema; strip everything else. */
export function cleanSchema(s) {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'properties') {
      out.properties = Object.fromEntries(Object.entries(v).map(([n, p]) => [n, cleanSchema(p)]));
    } else if (KEEP.has(k)) {
      out[k] = k === 'items' ? cleanSchema(v) : v;
    }
  }
  return out;
}

export function toGeminiTools(toolDefs) {
  const functionDeclarations = toolDefs.map((t) => {
    const d = { name: t.name, description: t.description || t.name };
    const params = cleanSchema(t.input_schema);
    if (params && params.properties && Object.keys(params.properties).length) d.parameters = params;
    return d;
  });
  return [{ functionDeclarations }];
}

export function toGeminiContents(messages) {
  const nameById = new Map();
  const contents = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
      continue;
    }
    const parts = [];
    for (const b of m.content) {
      if (b.type === 'text') {
        if (b.text) parts.push({ text: b.text });
      } else if (b.type === 'tool_use') {
        nameById.set(b.id, b.name);
        const p = { functionCall: { name: b.name, args: b.input || {} } };
        if (b._sig) p.thoughtSignature = b._sig; // Gemini 3 needs this echoed back
        parts.push(p);
      } else if (b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        parts.push({
          functionResponse: {
            name: nameById.get(b.tool_use_id) || 'tool',
            response: b.is_error ? { error: text } : { result: text },
          },
        });
      }
    }
    if (parts.length) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return contents;
}

export function fromGeminiResponse(data) {
  const cand = data?.candidates?.[0];
  if (!cand) {
    const why = data?.promptFeedback?.blockReason || 'no response';
    throw Object.assign(new Error(`Gemini returned nothing (${why}).`), { status: 502 });
  }
  const content = [];
  let n = 0;
  for (const p of cand.content?.parts || []) {
    if (p.functionCall) {
      content.push({
        type: 'tool_use',
        id: `call_${Date.now().toString(36)}_${n++}`,
        name: p.functionCall.name,
        input: p.functionCall.args || {},
        ...(p.thoughtSignature ? { _sig: p.thoughtSignature } : {}),
      });
    } else if (typeof p.text === 'string' && !p.thought) {
      content.push({ type: 'text', text: p.text });
    }
  }
  const hasCall = content.some((b) => b.type === 'tool_use');
  return { content, stop_reason: hasCall ? 'tool_use' : 'end_turn' };
}

export function createGeminiClient({ apiKey = process.env.GEMINI_API_KEY, fetchImpl = fetch } = {}) {
  return {
    messages: {
      async create({ model, max_tokens, system, tools, messages }) {
        if (!apiKey) {
          throw Object.assign(new Error('GEMINI_API_KEY is not set'), { status: 401 });
        }
        const body = {
          system_instruction: { parts: [{ text: system }] },
          contents: toGeminiContents(messages),
          generationConfig: { maxOutputTokens: max_tokens },
        };
        if (tools?.length) body.tools = toGeminiTools(tools);

        const res = await fetchImpl(`${BASE}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = data?.error?.message || `Gemini error ${res.status}`;
          const status = res.status === 400 && /api key/i.test(msg) ? 401 : res.status;
          throw Object.assign(new Error(msg), { status });
        }
        return fromGeminiResponse(data);
      },
    },
  };
}
