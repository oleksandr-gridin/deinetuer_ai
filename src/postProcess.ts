
/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

import { WEBHOOK_URL, OPENAI_API_KEY, SYSTEM_MESSAGE } from "./config.js";


export interface ChatCompletion {
  customerName:        string;
  customerAvailability: string[];
  specialNotes:         string;
  transcriptId?:        string;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

/**
 * Runs post-processing for a single call:  
 *   1. Sends the full transcript to ChatGPT to extract structured data.  
 *   2. Forwards that JSON to the external webhook (if configured).  
 */
export async function processTranscriptAndSend(
  transcript: string,
  id: string
): Promise<void> {
  try {
    const data = await withRetry(() => makeChatGPTCompletion(transcript, id));
    if (WEBHOOK_URL) await withRetry(() => sendToWebhook(data));
    console.log(`[${id}] JSON sent to webhook`);
  } catch (err) {
    console.error(`[${id}] post-process failed:`, err);
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function makeChatGPTCompletion(
  transcript: string,
  id: string
): Promise<ChatCompletion> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization : `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-2024-05-13',
      messages: [
        { role: 'system', content: SYSTEM_MESSAGE },
        { role: 'user',   content: transcript }
      ],
      response_format: { type: 'json_object' }
    })
  });

  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);

  const json     = await res.json() as {
    choices: { message: { content: string } }[];
  };

  const content  = JSON.parse(json.choices[0].message.content) as Partial<ChatCompletion>;

  return {
    customerName        : content.customerName         ?? 'Unknown',
    customerAvailability: content.customerAvailability ?? [],
    specialNotes        : content.specialNotes         ?? '',
    transcriptId        : id
  };
}

async function sendToWebhook(payload: ChatCompletion): Promise<void> {
  const r = await fetch(WEBHOOK_URL, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`Webhook HTTP ${r.status}`);
}

async function withRetry<T>(
  fn: () => Promise<T>,
  delays: readonly number[] = RETRY_DELAYS_MS
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < delays.length)
        await new Promise<void>(res => setTimeout(res, delays[i]));
    }
  }
  throw lastErr;
}
