// Loads data/resources.json into Pinecone. Safe to run again whenever the library changes:
// it creates the index if needed, clears old records and uploads the current ones.
//
// Run locally:  PINECONE_API_KEY=... npm run seed
// Or from GitHub: Actions tab -> "Seed Pinecone" -> Run workflow

import { readFile } from 'node:fs/promises';
import { pineconeHeaders, resourceSearchText } from '../src/pinecone.ts';
import type { Resource } from '../src/types.ts';

const apiKey = process.env.PINECONE_API_KEY;
const indexName = process.env.PINECONE_INDEX || 'lsat-resources';
const namespace = process.env.PINECONE_NAMESPACE || 'resources';
// Pinecone's hosted embedding model. Free on the Starter plan.
const embedModel = 'llama-text-embed-v2';

if (!apiKey) {
  console.error('Set PINECONE_API_KEY first.');
  process.exit(1);
}
const headers = pineconeHeaders(apiKey);

async function call(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
}

// Returns the index host and the name of the field Pinecone embeds (set when the index was created).
async function ensureIndex(): Promise<{ host: string; textField: string }> {
  let res = await call(`https://api.pinecone.io/indexes/${indexName}`);
  if (res.status === 404) {
    console.log(`Creating index "${indexName}" with integrated embedding (${embedModel})...`);
    const created = await call('https://api.pinecone.io/indexes/create-for-model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: indexName,
        cloud: 'aws',
        region: 'us-east-1',
        embed: { model: embedModel, field_map: { text: 'chunk_text' } },
      }),
    });
    if (!created.ok) throw new Error(`Create index failed: ${created.status} ${await created.text()}`);
    res = await call(`https://api.pinecone.io/indexes/${indexName}`);
  }
  // A new index takes a little while to be ready.
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!res.ok) throw new Error(`Describe index failed: ${res.status} ${await res.text()}`);
    const info = (await res.json()) as { host: string; status?: { ready?: boolean }; embed?: { model?: string; field_map?: { text?: string } } };
    const textField = info.embed?.field_map?.text;
    if (!textField) {
      throw new Error(`Index "${indexName}" exists but has no built-in embedding model. Delete it in the Pinecone console (or set PINECONE_INDEX to a new name) and run this again.`);
    }
    if (info.status?.ready) {
      console.log(`Using index "${indexName}" (model ${info.embed?.model}, text field "${textField}")`);
      return { host: info.host, textField };
    }
    console.log('Waiting for index to be ready...');
    await new Promise((r) => setTimeout(r, 5000));
    res = await call(`https://api.pinecone.io/indexes/${indexName}`);
  }
  throw new Error('Index never became ready');
}

async function main() {
  const file = JSON.parse(await readFile(new URL('../data/resources.json', import.meta.url), 'utf8'));
  const resources = file.resources as Resource[];
  const { host, textField } = await ensureIndex();
  console.log(`Index host: ${host}`);

  // Clear old records so deleted resources don't linger. A brand-new namespace returns 404, which is fine.
  const cleared = await call(`https://${host}/vectors/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deleteAll: true, namespace }),
  });
  if (!cleared.ok && cleared.status !== 404) throw new Error(`Clearing namespace failed: ${cleared.status} ${await cleared.text()}`);

  const records = resources.map((r) => ({
    _id: r.id,
    [textField]: resourceSearchText(r),
    resource: JSON.stringify(r),
    category: r.category,
    cost: r.cost,
    sections: r.sections,
    ...(r.price_usd === null ? {} : { price_usd: r.price_usd }),
  }));

  // Pinecone accepts up to 96 text records per upload.
  for (let i = 0; i < records.length; i += 90) {
    const batch = records.slice(i, i + 90);
    const res = await call(`https://${host}/records/namespaces/${namespace}/upsert`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: batch.map((r) => JSON.stringify(r)).join('\n'),
    });
    if (!res.ok) throw new Error(`Upsert failed: ${res.status} ${await res.text()}`);
    console.log(`Uploaded ${Math.min(i + 90, records.length)}/${records.length}`);
  }

  // New records take a few seconds to become searchable. Then run one test search.
  await new Promise((r) => setTimeout(r, 10000));
  const test = await call(`https://${host}/records/namespaces/${namespace}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: { inputs: { text: 'free reading comprehension practice for a beginner' }, top_k: 3 }, fields: ['category'] }),
  });
  if (!test.ok) throw new Error(`Test search failed: ${test.status} ${await test.text()}`);
  const hits = ((await test.json()) as { result: { hits: { _id: string; _score: number }[] } }).result.hits;
  console.log('Test search "free reading comprehension practice for a beginner":');
  for (const hit of hits) console.log(`  ${hit._score.toFixed(3)}  ${hit._id}`);
  console.log('Done.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
