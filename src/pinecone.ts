// Talks to Pinecone, the vector database that holds the LSAT resource library.
// The index uses Pinecone's built-in embedding model, so we send plain text and
// Pinecone turns it into a vector itself. That's why we no longer need Cohere.

import type { Env, Resource } from './types.ts';

export const PINECONE_API_VERSION = '2026-07';
const DEFAULT_INDEX = 'lsat-resources';
const DEFAULT_NAMESPACE = 'resources';

// Workers reuse memory between requests, so we only look up the index host once.
let cachedHost: { index: string; host: string } | null = null;

export async function indexHost(env: Env): Promise<string> {
  const index = env.PINECONE_INDEX || DEFAULT_INDEX;
  if (cachedHost?.index === index) return cachedHost.host;
  const res = await fetch(`https://api.pinecone.io/indexes/${encodeURIComponent(index)}`, {
    headers: pineconeHeaders(env.PINECONE_API_KEY),
  });
  if (!res.ok) throw new Error(`Pinecone index lookup failed (${res.status})`);
  const data = (await res.json()) as { host?: string };
  if (!data.host) throw new Error('Pinecone index has no host');
  cachedHost = { index, host: data.host };
  return data.host;
}

// Finds the resources whose text is most similar in meaning to `query`.
export async function searchResources(query: string, env: Env, topK: number): Promise<Resource[]> {
  const host = await indexHost(env);
  const namespace = env.PINECONE_NAMESPACE || DEFAULT_NAMESPACE;
  const res = await fetch(`https://${host}/records/namespaces/${encodeURIComponent(namespace)}/search`, {
    method: 'POST',
    headers: { ...pineconeHeaders(env.PINECONE_API_KEY), 'content-type': 'application/json' },
    body: JSON.stringify({ query: { inputs: { text: query }, top_k: topK }, fields: ['resource'] }),
  });
  if (!res.ok) throw new Error(`Pinecone search failed (${res.status})`);
  const data = (await res.json()) as { result?: { hits?: { _id: string; fields?: { resource?: string } }[] } };
  const hits = data.result?.hits ?? [];
  // Each record stores the full resource as a JSON string in its `resource` field.
  return hits.flatMap((hit) => {
    try {
      return hit.fields?.resource ? [JSON.parse(hit.fields.resource) as Resource] : [];
    } catch {
      return [];
    }
  });
}

export function pineconeHeaders(apiKey: string): Record<string, string> {
  return { 'Api-Key': apiKey, 'X-Pinecone-Api-Version': PINECONE_API_VERSION };
}

// The text Pinecone embeds for each resource. Search queries are compared against this.
export function resourceSearchText(r: Resource): string {
  return [
    `${r.name} (${r.provider}).`,
    `Type: ${r.category}. Cost: ${r.cost}, ${r.price_note}.`,
    `Sections: ${r.sections.join(', ')}. Level: ${r.level}.`,
    `Best for: ${r.best_for}`,
    r.description,
  ].join(' ');
}
