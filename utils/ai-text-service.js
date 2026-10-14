const OpenAI = require('openai');
const { Logger } = require('./logger');

const GEMINI_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash-lite',
];
const GEMINI_DEFAULT_MODEL = GEMINI_MODELS[0];

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6',
    models: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6-sol',
    models: ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5', 'google/gemini-3.7-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3'],
    envKey: 'OPENROUTER_API_KEY',
  },
  kimi: {
    name: 'Kimi (Moonshot AI)',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    envKey: 'MOONSHOT_API_KEY',
  },
  mimo: {
    name: 'MiMo (Xiaomi)',
    baseURL: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    envKey: 'MIMO_API_KEY',
  },
  glm: {
    name: 'GLM (Zhipu AI)',
    baseURL: 'https://api.z.ai/api/paas/v4/',
    defaultModel: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.2', 'glm-5.1'],
    envKey: 'GLM_API_KEY',
  },
};

class AITextService {
  constructor(credentials = {}) {
    this.logger = new Logger('AITextService');
    this.client = null;
    this.gemini = null;
    this.model = null;
    this.providerName = null;

    this._init(credentials);
  }

  _init(credentials = {}) {
    this.fallbackProviders = [];
    const candidates = [];
    const addOpenAICompatible = (preset, apiKey, model) => {
      if (!preset || !apiKey) return;
      const identity = `${preset.name}:${apiKey}`;
      if (candidates.some(item => item.identity === identity)) return;
      candidates.push({
        identity,
        type: 'openai-compatible',
        name: preset.name,
        client: new OpenAI({ apiKey, baseURL: preset.baseURL }),
        model: model || preset.defaultModel
      });
    };
    const addGemini = (apiKey, model) => {
      if (!apiKey) return;
      const identity = `Google Gemini:${apiKey}`;
      if (candidates.some(item => item.identity === identity)) return;
      try {
        const { GoogleGenAI } = require('@google/genai');
        candidates.push({
          identity,
          type: 'gemini',
          name: 'Google Gemini',
          client: new GoogleGenAI({ apiKey }),
          model: model || GEMINI_DEFAULT_MODEL
        });
      } catch (error) {
        this.logger.error('Failed to initialize Gemini:', error.message);
      }
    };

    // Explicit provider selection is primary; other configured providers are failover-only.
    const selected = credentials.aiProvider;
    if (selected?.provider && PROVIDERS[selected.provider] && selected.apiKey) {
      addOpenAICompatible(PROVIDERS[selected.provider], selected.apiKey, selected.model);
    } else if (credentials.openai?.apiKey) {
      addOpenAICompatible(PROVIDERS.openai, credentials.openai.apiKey, credentials.openai.model);
    }

    for (const preset of Object.values(PROVIDERS)) {
      addOpenAICompatible(preset, process.env[preset.envKey],
        preset === PROVIDERS.openai ? credentials.openai?.model : undefined);
    }
    addOpenAICompatible(PROVIDERS.openai, credentials.openai?.apiKey, credentials.openai?.model);
    addGemini(credentials.gemini?.apiKey || process.env.GEMINI_API_KEY, credentials.gemini?.model);

    const primary = candidates.shift();
    if (!primary) {
      this.logger.warn('No AI text provider configured — text generation unavailable');
      return;
    }

    this.primaryProvider = primary;
    this.fallbackProviders = candidates;
    this.client = primary.type === 'openai-compatible' ? primary.client : null;
    this.gemini = primary.type === 'gemini' ? primary.client : null;
    this.model = primary.model;
    this.providerName = primary.name;
    this.logger.info(`${primary.name} initialized (model: ${this.model}); ${candidates.length} fallback provider(s) available`);
  }

  async _generateFromProvider(provider, prompt, options = {}) {
    const model = options.model || provider.model;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;

    if (provider.type === 'gemini') {
      const config = { maxOutputTokens: maxTokens };
      if (!/^gemini-3\.(?:[5-9]|\d{2,})-/.test(model)) config.temperature = temperature;
      const response = await provider.client.models.generateContent({ model, contents: prompt, config });
      const text = response && response.text;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`${provider.name} returned an empty response. Check the API key and model quota.`);
      }
      return text;
    }

    const params = { model, messages: [{ role: 'user', content: prompt }], temperature };
    try {
      const response = await provider.client.chat.completions.create({
        ...params,
        max_completion_tokens: maxTokens
      });
      return this._extractContent(response, provider.name);
    } catch (error) {
      if (error && error.status === 400 && /max(_completion)?_tokens/i.test(error.message || '')) {
        const response = await provider.client.chat.completions.create({ ...params, max_tokens: maxTokens });
        return this._extractContent(response, provider.name);
      }
      throw error;
    }
  }

  async generateText(prompt, options = {}) {
    // Preserve direct property overrides used by tests and callers that inject a client.
    const primary = this.gemini
      ? { type: 'gemini', name: this.providerName || 'Google Gemini', client: this.gemini, model: this.model }
      : this.client
        ? { type: 'openai-compatible', name: this.providerName || 'OpenAI', client: this.client, model: this.model }
        : null;

    if (!primary) throw new Error('No AI text provider configured');
    try {
      return await this._generateFromProvider(primary, prompt, options);
    } catch (primaryError) {
      for (const fallback of this.fallbackProviders || []) {
        try {
          this.logger.warn(`${primary.name} text generation failed; trying ${fallback.name} fallback: ${primaryError.message}`);
          const result = await this._generateFromProvider(fallback, prompt, { ...options, model: undefined });
          this.logger.info(`AI text generation recovered using ${fallback.name}`);
          return result;
        } catch (fallbackError) {
          this.logger.warn(`${fallback.name} fallback failed: ${fallbackError.message}`);
        }
      }
      throw primaryError;
    }
  }

  _extractContent(response, providerName = this.providerName) {
    const content =
      response &&
      response.choices &&
      response.choices[0] &&
      response.choices[0].message
        ? response.choices[0].message.content
        : null;

    if (typeof content !== 'string' || !content.trim()) {
      // A null/empty body used to surface as cryptic "Unexpected end of JSON input"
      // in the agents' JSON parsers. Report the real cause instead.
      throw new Error(
        `${providerName} returned an empty response. Check the API key and model quota.`
      );
    }
    return content;
  }

  isAvailable() {
    return !!(this.client || this.gemini);
  }
}

module.exports = { AITextService, PROVIDERS, GEMINI_MODELS, GEMINI_DEFAULT_MODEL };
