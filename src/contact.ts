// "Work with Caleb" form. Every message is saved in KV first, so nothing is lost,
// then emailed to Caleb through Cloudflare Email Routing when that is set up.

import type { Env } from './types.ts';

export const CONTACT_TO = 'calebhaymore@gmail.com';
export const CONTACT_FROM = 'contact@lsatcompass.com';

export interface ContactMessage {
  name: string;
  email: string;
  score: string;
  message: string;
}

export function emailBody(m: ContactMessage): string {
  return [
    `Name: ${m.name}`,
    `Email: ${m.email}`,
    `Current practice score: ${m.score || 'not given'}`,
    '',
    m.message,
    '',
    '(Sent from the contact form on lsatcompass.com. Reply to this email to answer them.)',
  ].join('\n');
}

export async function deliverContact(env: Env, m: ContactMessage): Promise<{ emailed: boolean }> {
  const key = `contact:${new Date().toISOString()}:${crypto.randomUUID().slice(0, 8)}`;
  await env.DATA.put(key, JSON.stringify(m));
  if (!env.CONTACT_EMAIL) return { emailed: false };
  try {
    await env.CONTACT_EMAIL.send({
      to: CONTACT_TO,
      from: { email: CONTACT_FROM, name: 'LSAT Compass' },
      replyTo: { email: m.email, name: m.name },
      subject: `Coaching request from ${m.name}`,
      text: emailBody(m),
    });
    return { emailed: true };
  } catch (error) {
    console.error('Contact email failed; the message is saved in KV under', key, error);
    return { emailed: false };
  }
}
