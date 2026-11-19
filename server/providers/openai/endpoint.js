/**
 * The OpenAI-compatible endpoint GEV's typed chat and HUD summary call.
 *
 * `OPENAI_BASE_URL` points both at a self-hosted OpenAI-compatible server —
 * Ollama, llama.cpp, vLLM, LM Studio, LocalAI, a corporate gateway — instead
 * of api.openai.com. Voice (OpenAI Realtime, Gemini Live) is NOT affected:
 * speech-to-speech needs cloud-hosted realtime models no self-hosted stack
 * serves yet.
 *
 * Pure and unit-tested; the chat handler, the HUD summary handler and the
 * Provider Settings registry all resolve through this module, so their
 * notions of "self-hosted" cannot drift apart.
 */

export const OPENAI_BASE_URL_DEFAULT = 'https://api.openai.com/v1';

/**
 * Parse and normalize `OPENAI_BASE_URL`.
 *
 * A self-hosted endpoint is the operator's own machine or network — typed
 * there into the Provider Settings panel or a local .env — so the SSRF
 * posture is different from a browser-supplied value and no host allowlist
 * applies. What IS enforced: http(s) only, no embedded credentials, no query
 * or fragment (a URL that round-trips differently would make the
 * redirect-check below impossible to reason about).
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{baseUrl: string, selfHosted: boolean}|null}
 *   The normalized endpoint, or null when the configured value is unusable.
 */
export function resolveOpenAiEndpoint(env = process.env) {
  const raw = String(env.OPENAI_BASE_URL ?? '').trim();
  if (!raw) return { baseUrl: OPENAI_BASE_URL_DEFAULT, selfHosted: false };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    return null;
  // One trailing slash is cosmetic noise every server accepts either way;
  // normalizing keeps `…/v1/` and `…/v1` the same endpoint and keeps the
  // redirect guard's exact-URL comparison stable.
  const baseUrl = parsed.href.replace(/\/+$/, '') || OPENAI_BASE_URL_DEFAULT;
  return {
    baseUrl,
    selfHosted: baseUrl !== OPENAI_BASE_URL_DEFAULT,
  };
}
