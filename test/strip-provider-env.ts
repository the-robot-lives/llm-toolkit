// Vitest setup: no test may reach a real model. Strip live LLM/embedding
// provider credentials and endpoints before any module copies them into
// config (routes/config.ts, routes/llm.ts, services/llm.ts read process.env).
const PROVIDER_ENV = /(_API_KEY|_BASE_URL|_AUTH_TOKEN)$|^(ANTHROPIC|OPENAI|AZURE_OPENAI|GEMINI|GOOGLE|GROQ|MISTRAL|OPENROUTER|DEEPSEEK|XAI|GROK|ZAI|QWEN|CEREBRAS|WAFER_AI|TOGETHER|COHERE|OLLAMA|LITELLM|HF)_/;

for (const name of Object.keys(process.env)) {
  if (PROVIDER_ENV.test(name)) delete process.env[name];
}

// Config-home resolution is $NPL_CONFIG_HOME > $XDG_CONFIG_HOME > <home>.
// GH runners export XDG_CONFIG_HOME, which shadows the temp homes tests pass
// in and points them at the runner's real ~/.config — clear both.
delete process.env.NPL_CONFIG_HOME;
delete process.env.XDG_CONFIG_HOME;
