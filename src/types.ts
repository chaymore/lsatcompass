// Shared shapes used across the worker.

export interface Env {
  ASSETS: Fetcher;
  // Secrets (set with `wrangler secret put`, never committed)
  OPENROUTER_API_KEY: string;
  PINECONE_API_KEY: string;
  // Plain settings from wrangler.jsonc
  OPENROUTER_MODEL?: string;
  OPENROUTER_FALLBACK_MODEL?: string;
  PINECONE_INDEX?: string;
  PINECONE_NAMESPACE?: string;
  SITE_URL?: string;
  // Rate limiters (optional so local tests can run without them)
  PLAN_LIMITER?: RateLimit;
  CHAT_LIMITER?: RateLimit;
}

export interface Resource {
  id: string;
  name: string;
  provider: string;
  url: string;
  category: string;
  cost: 'free' | 'freemium' | 'paid';
  price_usd: number | null;
  price_note: string;
  sections: string[];
  level: string;
  best_for: string;
  description: string;
}

// What the browser sends about the student. Every field is checked in validateProfile.
export interface Profile {
  scaledScore: number;
  targetScore: number;
  lrScore: number | null;
  rcScore: number | null;
  timeline: number;
  hours: number;
  days: string[];
  concern: string;
}

export interface StudyWeek {
  week: number;
  title: string;
  focus: string;
  tasks: { day: string; task: string }[];
}

export interface Pick {
  resource: Resource;
  why: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
