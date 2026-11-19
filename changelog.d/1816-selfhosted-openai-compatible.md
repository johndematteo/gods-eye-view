- Typed chat and the AI HUD summary can run against a self-hosted
  OpenAI-compatible server: set `OPENAI_BASE_URL` (Provider Settings ▸
  SELF-HOSTED LLM, or the local `.env`) to point `/api/openai/chat` and
  `/api/openai/hud-summary` at Ollama, llama.cpp, vLLM, LM Studio, LocalAI or
  any other compatible endpoint. No API key is required there — a blank
  `OPENAI_API_KEY` sends no `Authorization` header — registry-style model ids
  with `/` are accepted, and the request body drops the OpenAI-only fields
  (`store`, `strict`, `max_completion_tokens`) that stricter servers answer
  400 to. The HUD summary speaks Chat Completions against a self-hosted
  endpoint instead of the Responses API, and `GEV_PREFER_CODEX_OAUTH` no
  longer locks these routes, since no OpenAI key is billed. Voice (OpenAI
  Realtime, Gemini Live) is unchanged and stays on the cloud providers.
