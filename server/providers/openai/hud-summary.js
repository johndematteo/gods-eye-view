import { SNAPSHOT_FEED_STATES } from '../../../src/data/layerSnapshot.js';
import {
  HUD_SUMMARY_MAX_CHARS,
  HUD_SUMMARY_MAX_UNSPACED_CHARS,
  HUD_SUMMARY_RESPONSE_FORMAT,
  hudSummaryInput,
  hudSummaryInstructions,
  hudSummaryIsUnspaced,
  hudSummaryLocale,
  keylessHudSummaryResponse,
} from '../../../src/hudSummaryResponse.js';
import { enforceRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import { OPENAI_HUD_SUMMARY_MODEL_DEFAULT } from './constants.js';
import { resolveOpenAiEndpoint } from './endpoint.js';

function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

/**
 * Chat Completions answers `choices[0].message.content`. Local models often
 * wrap the JSON in a markdown code fence, so a fenced reply is unwrapped.
 */
function extractChatText(data) {
  const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return fenced ? fenced[1].trim() : text;
}

/** Parse the summary and normalize the canonical feed state. */
function parseHudSummaryReply(text, locale) {
  let reply = null;
  try {
    reply = JSON.parse(text);
  } catch {
    /* not JSON: no summary */
  }
  const feedState = SNAPSHOT_FEED_STATES.includes(reply?.feedState)
    ? reply.feedState
    : null;
  return {
    summary: toHudSummary(reply?.summary, locale),
    feedState,
  };
}

function toHudSummary(value, requested) {
  const locale = hudSummaryLocale(requested);
  const words = String(value || '')
    .normalize('NFC')
    // Marks, and apostrophes and dots inside a word, belong to it: ar vowel
    // signs, fr d'Orléans, ja サンフランシスコ・ベイエリア.
    .replace(/[^\p{L}\p{M}\p{N}\s'’·・-]/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^['’·・-]+|['’·・-]+$/gu, ''))
    .filter(Boolean);
  // Characters, not words: the model counts Rue de Rivoli as one word.
  const max = hudSummaryIsUnspaced(locale)
    ? HUD_SUMMARY_MAX_UNSPACED_CHARS
    : HUD_SUMMARY_MAX_CHARS;
  return capAtWord(words.join(' '), max, locale);
}

/**
 * Cut `text` to `max` characters at a word boundary; a first word longer
 * than that is cut where the cap falls.
 */
function capAtWord(text, max, locale) {
  const graphemes = [
    ...new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(text),
  ];
  if (graphemes.length <= max) return text;
  const cut = graphemes[max].index;
  let end = 0;
  for (const { index, segment } of new Intl.Segmenter(locale, {
    granularity: 'word',
  }).segment(text)) {
    if (index + segment.length > cut) break;
    end = index + segment.length;
  }
  return text.slice(0, end).trim() || text.slice(0, cut);
}

async function handleHudSummary(req, res) {
  const endpoint = resolveOpenAiEndpoint(process.env);
  const selfHosted = endpoint?.selfHosted ?? false;
  // Capability probe: lets the HUD skip its paid place lookups when there is
  // no summary to feed them to. A self-hosted endpoint (OPENAI_BASE_URL)
  // counts as configured even with no key: it usually wants none.
  if (req.method === 'GET' && req.url?.split('?')[0] === '/status') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      JSON.stringify({
        configured:
          !keylessHudSummaryResponse(process.env.OPENAI_API_KEY) || selfHosted,
      }),
    );
    return;
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  // The graceful keyless response only applies to the cloud endpoint; a
  // self-hosted one is configured with or without a key.
  const keyless = selfHosted ? null : keylessHudSummaryResponse(apiKey);
  if (keyless) {
    res.statusCode = keyless.statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(keyless.payload));
    return;
  }

  // Per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). On by default; 0 disables.
  // Keyless HUD fallback has no provider cost and resolves above without
  // consuming a paid-endpoint quota slot.
  if (!enforceRateLimit(openAiRateLimiter(), req, res)) return;

  try {
    const body = await readRequestBody(req, 64 * 1024);
    const context = JSON.parse(body || '{}');
    const model =
      process.env.OPENAI_HUD_SUMMARY_MODEL || OPENAI_HUD_SUMMARY_MODEL_DEFAULT;
    // Self-hosted servers implement Chat Completions, not the Responses API,
    // and answer a 400 to OpenAI-only fields — a minimal body, JSON asked for
    // by the prompt alone, with the existing tolerant parse as the safety net.
    const response = await fetch(
      selfHosted
        ? `${endpoint.baseUrl}/chat/completions`
        : 'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        headers: {
          // A keyless self-hosted endpoint gets no Authorization header at all.
          ...(apiKey || !selfHosted
            ? { Authorization: `Bearer ${apiKey}` }
            : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          selfHosted
            ? {
                model,
                stream: false,
                max_tokens: 200,
                // Asks the server for a JSON object; the prompt alone gets prose
                // back from local models. Servers that ignore it still get the
                // tolerant parse.
                response_format: { type: 'json_object' },
                messages: [
                  {
                    role: 'system',
                    content: hudSummaryInstructions(context?.locale),
                  },
                  { role: 'user', content: hudSummaryInput(context) },
                ],
              }
            : {
                model,
                instructions: hudSummaryInstructions(context?.locale),
                input: hudSummaryInput(context),
                text: { format: HUD_SUMMARY_RESPONSE_FORMAT },
                reasoning: { effort: 'minimal' },
                max_output_tokens: 200,
              },
        ),
      },
    );
    const data = await response.json().catch(() => ({}));
    const { summary, feedState } = parseHudSummaryReply(
      selfHosted ? extractChatText(data) : extractOpenAiResponseText(data),
      context?.locale,
    );
    res.statusCode = response.ok && summary ? 200 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!response.ok)
      console.warn(`[hud-summary] upstream HTTP ${response.status}`);
    res.end(
      JSON.stringify({
        summary: summary || null,
        feedState,
        // Never relay `data.error.message`: that is OpenAI's own wording, and
        // it carries request ids, organization hints and quota phrasing.
        error: response.ok ? null : 'OpenAI HUD summary request failed',
      }),
    );
  } catch {
    console.warn('[hud-summary] request failed');
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: 'OpenAI HUD summary request failed',
      }),
    );
  }
}

export { handleHudSummary, parseHudSummaryReply };
