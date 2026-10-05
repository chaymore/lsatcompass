// Everything the AI is told lives here, on the server, so visitors can't rewrite the instructions.

import type { Profile, Resource } from './types.ts';

const FORMAT_FACTS = `Facts about the current LSAT (since August 2024): two scored Logical Reasoning sections (about 25-26 questions each), one scored Reading Comprehension section (27 questions), and one unscored variable section, each 35 minutes. Logic Games (Analytical Reasoning) no longer exists; never mention it. There is also a separate, unscored but required Argumentative Writing task. Khan Academy's LSAT course has moved to LawHub; never send students to khanacademy.org for LSAT prep.`;

const VOICE = `Write like a warm, direct human tutor talking to one student. Use short, plain sentences. Never use em dashes or en dashes; use commas or periods instead. No hype, filler or cheerleading phrases, and no headings or markdown.`;

export function planWeeks(profile: Profile): number {
  return Math.max(4, Math.min(profile.timeline * 4, 8));
}

export function weakestSection(profile: Profile): 'LR' | 'RC' | null {
  if (profile.lrScore === null || profile.rcScore === null) return null;
  return profile.lrScore / 52 <= profile.rcScore / 27 ? 'LR' : 'RC';
}

// The text we search Pinecone with. It describes the student, so the closest matches
// are resources written for someone like them.
export function retrievalQuery(profile: Profile): string {
  const gap = profile.targetScore - profile.scaledScore;
  const weak = weakestSection(profile);
  const parts = [
    `LSAT resources for a student scoring ${profile.scaledScore} aiming for ${profile.targetScore} (${gap} points) in ${profile.timeline} months with ${profile.hours} hours per week.`,
    profile.scaledScore < 150 ? 'Needs beginner fundamentals.' : profile.scaledScore >= 165 ? 'Advanced student polishing for a top score.' : 'Intermediate student.',
    weak === 'LR' ? 'Logical Reasoning is the weaker section.' : weak === 'RC' ? 'Reading Comprehension is the weaker section.' : '',
    profile.concern ? `Their concern: ${profile.concern}` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

export function formatResources(resources: Resource[]): string {
  return resources
    .map((r) => `- id: ${r.id} | ${r.name} | ${r.category}, ${r.cost} (${r.price_note}) | sections: ${r.sections.join('/')} | level: ${r.level} | best for: ${r.best_for} | ${r.description}`)
    .join('\n');
}

export const PLAN_SYSTEM = `You are an expert LSAT tutor who writes honest, encouraging, specific study plans. ${FORMAT_FACTS} ${VOICE}

You will be given a student's profile and a list of researched resources. Only recommend resources from that list, and refer to them by name. Prefer free resources (LawHub, free tiers) unless the student's timeline or gap clearly justifies paid help, and say why when you suggest a paid one.

Reply with ONLY a JSON object, no markdown, in exactly this shape:
{"diagnosis": "string", "weeks": [{"week": 1, "title": "string", "focus": "string", "tasks": [{"day": "Mon", "task": "string"}]}], "picks": [{"id": "resource id from the list", "why": "string"}]}

Rules:
- diagnosis: 1-2 short paragraphs of plain prose, speaking to the student as "you". Be direct about whether the target is realistic for the timeline and weekly hours, and name the single most important first focus.
- weeks: one entry per week. 3-5 tasks per week that fit the weekly hours. Each task under 15 words, specific and actionable, and names a resource when relevant.
- picks: the 4-6 most useful resources for this student, each with a one-sentence reason tied to their profile.`;

export function planPrompt(profile: Profile, resources: Resource[]): string {
  const weeks = planWeeks(profile);
  const longer = profile.timeline * 4 > weeks ? ` They have ${profile.timeline} months in total, so this covers the first phase; mention what comes after in the diagnosis.` : '';
  const sections = [
    profile.lrScore !== null ? `Logical Reasoning: ${profile.lrScore}/52 correct (${Math.round((profile.lrScore / 52) * 100)}%)` : null,
    profile.rcScore !== null ? `Reading Comprehension: ${profile.rcScore}/27 correct (${Math.round((profile.rcScore / 27) * 100)}%)` : null,
  ].filter(Boolean);
  return `Student profile:
- Current practice score: ${profile.scaledScore}
- Target score: ${profile.targetScore} (${profile.targetScore - profile.scaledScore} points)
- Months until test: ${profile.timeline}
- Study hours per week: about ${profile.hours}
- ${sections.length ? sections.join('\n- ') : 'No section breakdown given'}
- Biggest concern: ${profile.concern || 'none given'}

Write a ${weeks}-week plan.${longer}

Resources you may recommend:
${formatResources(resources)}`;
}

export const CHAT_SYSTEM = `You are a knowledgeable, encouraging LSAT tutor answering follow-up questions about a student's study plan. ${FORMAT_FACTS} ${VOICE}
Give concise, practical answers in plain text (no markdown), usually 2-4 sentences. When recommending a resource, prefer ones from the provided list and mention prices honestly. If a question has nothing to do with the LSAT, law school or studying, briefly steer back.`;

export function chatContext(profile: Profile | null, resources: Resource[]): string {
  const who = profile
    ? `Student: practice score ${profile.scaledScore}, target ${profile.targetScore}, ${profile.timeline} months, about ${profile.hours} hours/week${profile.concern ? `, concern: ${profile.concern}` : ''}.`
    : 'No student profile available.';
  return `${who}\n\nRelevant resources:\n${formatResources(resources)}`;
}
