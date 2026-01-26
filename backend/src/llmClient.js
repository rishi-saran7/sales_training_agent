// Lightweight LLM chat completion client with pluggable provider settings.
// Uses a REST endpoint compatible with OpenAI's chat/completions schema.

const DEFAULT_MODEL = process.env.LLM_MODEL || 'gpt-3.5-turbo';
const DEFAULT_BASE_URL = process.env.LLM_BASE_URL || 'https://api.openai.com/v1/chat/completions';
const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || 'openai-compatible';
const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 10000);

class LlmClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.LLM_API_KEY || '';
    this.model = options.model || DEFAULT_MODEL;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.provider = options.provider || DEFAULT_PROVIDER;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  async generate(messages) {
    if (!this.apiKey) {
      throw new Error('LLM_API_KEY not configured');
    }

    if (typeof fetch !== 'function') {
      throw new Error('Global fetch is unavailable. Use Node 18+ or supply a fetch polyfill.');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'X-LLM-Provider': this.provider,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.7,
          stream: false, // TODO: Enable streaming tokens for faster first token.
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LLM request failed (${response.status}): ${body}`);
      }

      const json = await response.json();
      const text =
        (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
      const trimmed = typeof text === 'string' ? text.trim() : '';

      if (!trimmed) {
        throw new Error('LLM returned an empty response');
      }

      return trimmed;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`LLM request timed out after ${this.timeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

module.exports = { LlmClient };
