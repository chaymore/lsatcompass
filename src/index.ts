// LSAT Compass worker. Cloudflare serves everything in public/ as the website, and
// sends requests that start with /api/ here.
//
//   POST /api/plan       profile -> diagnosis, weekly plan and picked resources (RAG)
//   POST /api/chat       follow-up question -> tutor answer (RAG)
//   GET  /api/resources  the full researched resource library
//   GET  /api/health     quick check that the worker is up

import catalogFile from '../data/resources.json' with { type: 'json' };
import { complete, parseJsonObject } from './openrouter.ts';
import { searchResources } from './pinecone.ts';
import { CHAT_SYSTEM, PLAN_SYSTEM, chatContext, planPrompt, planWeeks, retrievalQuery } from './prompts.ts';
import type { ChatMessage, Env, Pick, Profile, Resource, StudyWeek } from './types.ts';

const catalog = catalogFile.resources as Resource[];
const catalogById = new Map(catalog.map((r) => [r.id, r]));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/plan' && request.method === 'POST') return await plan(request, env);
      if (url.pathname === '/api/chat' && request.method === 'POST') return await chat(request, env);
      if (url.pathname === '/api/resources' && request.method === 'GET') {
        return json({ researched: catalogFile.researched, resources: catalog }, 200, { 'cache-control': 'public, max-age=3600' });
      }
      if (url.pathname === '/api/health') return json({ ok: true, resources: catalog.length });
      if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof BadRequest) return json({ error: error.message }, 400);
      console.error(error);
      return json({ error: 'Something went wrong on our side. Try again in 1 minute.' }, 500);
    }
  },
};

async function plan(request: Request, env: Env): Promise<Response> {
  if (!(await allowed(env.PLAN_LIMITER, request))) return json({ error: 'You made too many plans in 1 minute. Wait 1 minute, then try again.' }, 429);
  const body = await readJson(request);
  const profile = validateProfile(body.profile);

  // RAG step 1: retrieve the resources most relevant to this student.
  const resources = await retrieve(retrievalQuery(profile), env, 15);
  // RAG step 2: hand them to the model so its advice is grounded in real, current resources.
  const raw = await complete(env, {
    system: PLAN_SYSTEM,
    messages: [{ role: 'user', content: planPrompt(profile, resources) }],
    maxTokens: 3000,
    json: true,
  });

  const parsed = parseJsonObject(raw) as { diagnosis?: unknown; weeks?: unknown; picks?: unknown };
  const allowedIds = new Set(resources.map((r) => r.id));
  return json({
    diagnosis: noDashes(cleanText(parsed.diagnosis, 2500)),
    weeks: cleanWeeks(parsed.weeks, planWeeks(profile), profile.days),
    picks: cleanPicks(parsed.picks, allowedIds),
  });
}

async function chat(request: Request, env: Env): Promise<Response> {
  if (!(await allowed(env.CHAT_LIMITER, request))) return json({ error: 'You sent too many questions in 1 minute. Wait 1 minute, then try again.' }, 429);
  const body = await readJson(request);
  const message = cleanText(body.message, 800);
  if (!message) throw new BadRequest('Type a question.');
  let profile: Profile | null = null;
  try {
    profile = body.profile ? validateProfile(body.profile) : null;
  } catch {
    profile = null;
  }
  const history = cleanHistory(body.history);
  const resources = await retrieve(message, env, 6);

  const reply = await complete(env, {
    system: `${CHAT_SYSTEM}\n\n${chatContext(profile, resources)}`,
    messages: [...history, { role: 'user', content: message }],
    maxTokens: 700,
  });
  return json({ text: noDashes(reply) || 'I could not write an answer. Ask the question in a different way.' });
}

// Searches Pinecone. If Pinecone is down or not set up yet, falls back to a simple
// keyword match over the bundled library so the site keeps working.
export async function retrieve(query: string, env: Env, topK: number): Promise<Resource[]> {
  if (env.PINECONE_API_KEY) {
    try {
      const hits = await searchResources(query, env, topK);
      if (hits.length) return hits;
    } catch (error) {
      console.error('Pinecone search failed, using keyword fallback', error);
    }
  }
  return keywordSearch(query, topK);
}

export function keywordSearch(query: string, topK: number): Resource[] {
  const words = new Set(query.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const lrWords = ['logical', 'reasoning', 'assumption', 'flaw', 'strengthen', 'weaken'];
  const rcWords = ['reading', 'comprehension', 'passage', 'passages'];
  const wantsLR = lrWords.some((w) => words.has(w));
  const wantsRC = rcWords.some((w) => words.has(w));
  const scored = catalog.map((r) => {
    const text = `${r.name} ${r.best_for} ${r.description} ${r.category}`.toLowerCase();
    let score = 0;
    for (const word of words) if (text.includes(word)) score += 1;
    if (wantsLR && r.sections.includes('LR')) score += 2;
    if (wantsRC && r.sections.includes('RC')) score += 2;
    if (r.cost === 'free') score += 0.5;
    return { r, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, topK).map((s) => s.r);
}

// ---------- input checks ----------

class BadRequest extends Error {}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (body && typeof body === 'object') return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new BadRequest('Request body must be JSON.');
}

function int(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// "monday", "MON" and "Mon." all become "Mon". Anything else becomes "".
export function normalizeDay(value: unknown): string {
  if (typeof value !== 'string') return '';
  const short = value.trim().slice(0, 3).toLowerCase();
  return WEEK_DAYS.find((d) => d.toLowerCase() === short) ?? '';
}

export function validateProfile(value: unknown): Profile {
  const p = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const scaledScore = int(p.scaledScore, 120, 180);
  const targetScore = int(p.targetScore, 120, 180);
  const timeline = int(p.timeline, 1, 24);
  const hours = int(p.hours, 1, 80);
  if (scaledScore === null) throw new BadRequest('Enter a practice score from 120 to 180.');
  if (targetScore === null) throw new BadRequest('Enter a target score from 120 to 180.');
  if (timeline === null) throw new BadRequest('Select the time until your test.');
  if (hours === null) throw new BadRequest('Select your study hours each week.');
  const days = Array.isArray(p.days) ? WEEK_DAYS.filter((d) => (p.days as unknown[]).map(normalizeDay).includes(d)) : [];
  if (!days.length) throw new BadRequest('Select the days you can study.');
  return {
    scaledScore,
    targetScore,
    lrScore: int(p.lrScore, 0, 52),
    rcScore: int(p.rcScore, 0, 27),
    timeline,
    hours,
    days,
    concern: cleanText(p.concern, 400),
  };
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Our house style has no em or en dashes, so swap any the model slips in for commas.
export function noDashes(text: string): string {
  return text.replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/ ,/g, ',');
}

function cleanHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is ChatMessage => !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }));
}

// ---------- output checks (never trust the model's JSON blindly) ----------

function cleanWeeks(value: unknown, maxWeeks: number, studyDays: string[]): StudyWeek[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxWeeks).map((w, i) => {
    const week = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>;
    const tasks = Array.isArray(week.tasks) ? week.tasks : [];
    return {
      week: i + 1,
      title: noDashes(cleanText(week.title, 80)) || `Week ${i + 1}`,
      focus: noDashes(cleanText(week.focus, 60)),
      tasks: tasks.slice(0, 7).map((t) => {
        const task = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
        return { day: normalizeDay(task.day), task: noDashes(cleanText(task.task, 200)) };
      }).filter((t) => t.task && studyDays.includes(t.day))
        .sort((a, b) => WEEK_DAYS.indexOf(a.day) - WEEK_DAYS.indexOf(b.day)),
    };
  });
}

function cleanPicks(value: unknown, allowedIds: Set<string>): Pick[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const picks: Pick[] = [];
  for (const p of value) {
    const pick = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const id = cleanText(pick.id, 80);
    const resource = catalogById.get(id);
    // Only accept resources we actually retrieved, so the model can't invent links.
    if (!resource || !allowedIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    picks.push({ resource, why: noDashes(cleanText(pick.why, 300)) });
    if (picks.length === 6) break;
  }
  return picks;
}

// ---------- helpers ----------

async function allowed(limiter: RateLimit | undefined, request: Request): Promise<boolean> {
  if (!limiter) return true;
  const key = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await limiter.limit({ key });
  return success;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
