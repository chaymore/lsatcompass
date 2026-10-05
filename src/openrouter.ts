// Sends prompts to OpenRouter, which forwards them to the chosen model (Gemini by default).

import type { Env } from './types.ts';

// Used when the settings in wrangler.jsonc are missing. Keep in sync with wrangler.jsonc.
export const DEFAULT_MODEL = 'google/gemini-3.5-flash-lite';
export const DEFAULT_FALLBACK_MODEL = 'google/gemini-2.5-flash-lite';

interface CompleteOptions {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  json?: boolean;
}

export async function complete(env: Env, opts: CompleteOptions): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'content-type': 'application/json',
      // OpenRouter shows these on its dashboard so you can see which app spent what.
      'HTTP-Referer': env.SITE_URL || 'https://lsatcompass.com',
      'X-Title': 'LSAT Compass',
    },
    body: JSON.stringify({
      // OpenRouter tries these in order, so one model's outage doesn't break the site.
      models: [env.OPENROUTER_MODEL || DEFAULT_MODEL, env.OPENROUTER_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL],
      max_tokens: opts.maxTokens,
      temperature: 0.4,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'system', content: opts.system }, ...opts.messages],
    }),
  });
  if (!res.ok) {
    console.error('OpenRouter error', res.status, await res.text());
    throw new Error(`AI request failed (${res.status})`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// Models sometimes wrap JSON in ```code fences``` or add a sentence. Pull out the object.
export function parseJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object in model output');
  return JSON.parse(raw.slice(start, end + 1));
}
