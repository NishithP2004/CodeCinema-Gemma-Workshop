const { clipText } = require("./utils");

function getOllamaConfig() {
  const host = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const model = process.env.OLLAMA_MODEL || "gemma4:e2b";
  return { host, model };
}

async function chatWithOllama(messages, options = {}) {
  const { host, model } = getOllamaConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 180_000);

  try {
    const response = await fetch(`${options.host || host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model || model,
        messages,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.15,
          top_p: options.topP ?? 0.9,
          num_ctx: options.numCtx || 4096
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Ollama returned ${response.status}: ${clipText(body, 300)}`);
    }

    const data = await response.json();
    return {
      content: data.message?.content || data.response || "",
      model: data.model || options.model || model,
      raw: data
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function createEmbedding(text, options = {}) {
  const { host } = getOllamaConfig();
  const model = options.model || process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
  const response = await fetch(`${options.host || host}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text })
  });
  if (!response.ok) throw new Error(`Ollama embeddings failed with ${response.status}`);
  const data = await response.json();
  return data.embedding || [];
}

module.exports = {
  chatWithOllama,
  createEmbedding,
  getOllamaConfig
};
