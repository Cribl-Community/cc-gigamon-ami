// The GenAI / LLM app_name values the Shadow AI tab pivots on.
//
// It lives here, in a plain data module with no React imports, so the query
// freeze can load it under Node: AI_IN builds the `app_name in (...)` list
// straight from this array, so an edit here rewrites two queries. The tab
// imports it back for the client-side shadow-vs-known split.

// GenAI / LLM apps AMI can identify from the wire.
export const AI_APPS = [
  'openai', 'chatgpt', 'claude', 'anthropic', 'perplexity-ai', 'midjourney', 'elevenlabs-io', 'stability-ai',
  'runway', 'descript', 'copy-ai', 'jasper-ai', 'writesonic', 'poe', 'bard', 'meta-ai', 'ms-copilot',
  'codewhisperer', 'mistral-ai', 'deepseek', 'deepseek-net', 'google-gen', 'notebooklm', 'personal-ai',
  'inflection-ai', 'muse-ai', 'mem-ai', 'aiva', 'lasco-ai', 'emailtree-ai', 'murf-ai', 'llm-stats',
  'swe-bench', 'anyword', 'pixlr',
]
