# LSAT Compass

A free LSAT study-plan generator. A student enters a practice score, a target and a schedule, and gets an honest diagnosis, a week-by-week plan, hand-picked resources and a follow-up tutor chat.

## How it works

```
Browser (public/index.html)
   │  POST /api/plan  { score, target, months, hours, concern }
   ▼
Cloudflare Worker (src/index.ts)
   1. Pinecone: find the ~15 resources that best match this student   (retrieval)
   2. OpenRouter → Gemini: write the plan using only those resources   (generation)
   3. Check the AI's JSON and return diagnosis + weeks + picks
```

This pattern is called **RAG** (retrieval-augmented generation): look things up first, then let the AI write with those facts in front of it, so it recommends real, current resources instead of guessing.

| Piece | What it does |
|---|---|
| `public/index.html` | The whole website (served by Cloudflare as static files) |
| `src/` | The worker: `/api/plan`, `/api/chat`, `/api/resources`, `/api/health` |
| `data/resources.json` | 80 researched LSAT resources (Oct 2026) with prices, sections, level and who each is best for |
| `scripts/seed-pinecone.ts` | Uploads the resource library into Pinecone |
| `wrangler.jsonc` | Cloudflare settings: model names, rate limits, custom domain |
| `test/` | Tests with fake Pinecone/OpenRouter responses (`npm test`) |

If Pinecone is down or not set up yet, the worker falls back to a simple keyword search over the same library, so the site keeps working.

## Setup (one time)

Everything below goes in **GitHub → this repo → Settings → Secrets and variables → Actions → New repository secret**. Keys never go in the code.

1. **`CLOUDFLARE_API_TOKEN`**: in the Cloudflare dashboard, go to My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template.
2. **`CLOUDFLARE_ACCOUNT_ID`**: shown on the right side of the Cloudflare dashboard's Workers & Pages page.
3. **`OPENROUTER_API_KEY`**: openrouter.ai → Keys. Add a few dollars of credit; each plan costs well under a cent.
4. **`PINECONE_API_KEY`**: app.pinecone.io → API Keys. Create a new key rather than reusing one that was ever stored in a document.

Then:

5. **Seed the database**: Actions tab → "Seed Pinecone" → Run workflow. It creates the `lsat-resources` index (using Pinecone's built-in `llama-text-embed-v2` embedding, so no Cohere needed) and uploads the library. It re-runs automatically whenever `data/resources.json` changes.
6. **Deploy**: any push to `main` runs the tests and deploys. The site appears at `https://lsat-compass.<your-subdomain>.workers.dev`.

## Custom domain (lsatcompass.com)

1. Buy the domain in Cloudflare (Domain Registration → Register Domains), or if you already own it elsewhere, add it as a site in Cloudflare and switch its nameservers.
2. Uncomment the `routes` block at the bottom of `wrangler.jsonc` and push. Cloudflare creates the DNS records and HTTPS certificate automatically.

## Changing things

- **Model**: edit `OPENROUTER_MODEL` in `wrangler.jsonc` (any OpenRouter model ID). `OPENROUTER_FALLBACK_MODEL` is used automatically if the first one fails.
- **Resources**: edit `data/resources.json`, then push. Seeding and deploying both happen automatically.
- **Rate limits**: `ratelimits` in `wrangler.jsonc` (plans and chats per visitor per minute).

## Local development

```bash
npm install
npm test            # runs the tests, no keys needed
npm run typecheck
echo 'OPENROUTER_API_KEY=...' > .dev.vars   # .dev.vars is gitignored
echo 'PINECONE_API_KEY=...' >> .dev.vars
npm run dev         # http://localhost:8787
```
