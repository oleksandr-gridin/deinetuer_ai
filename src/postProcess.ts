import {
  SYSTEM_MESSAGE,
  WEBHOOK_URL,
  OPENAI_API_KEY
} from './config';

interface ChatCompletion {
  customerName:        string;
  customerAvailability: string[];
  specialNotes:         string;
  transcriptId?:        string;
}

const RETRY = [1000, 2000, 4000];

export async function processTranscriptAndSend(
  transcript: string,
  id: string
): Promise<void> {
  try {
    const data = await withRetry(() => makeChatGPTCompletion(transcript, id));
    if (WEBHOOK_URL) await withRetry(() => sendToWebhook(data));
    console.log(`[${id}] JSON sent to webhook`);
  } catch (e) {
    console.error(`[${id}] post-process failed:`, e);
  }
}

async function makeChatGPTCompletion(
  transcript: string,
  id: string
): Promise<ChatCompletion> {

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method : 'POST',
    headers: {
      'Content-Type' : 'application/json',
      Authorization   : `Bearer ${OPENAI_API_KEY}`
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

  if (!res.ok)
    throw new Error(`OpenAI HTTP ${res.status}`);

  const json = await res.json();
  const content = JSON.parse(json.choices[0].message.content);

  return {
    customerName:        content.customerName        ?? 'Unknown',
    customerAvailability: content.customerAvailability ?? [],
    specialNotes:         content.specialNotes        ?? '',
    transcriptId:         id
  };
}

async function sendToWebhook(payload: ChatCompletion) {
  const r = await fetch(WEBHOOK_URL, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`Webhook HTTP ${r.status}`);
}

async function withRetry<T>(
  fn: () => Promise<T>,
  delays = RETRY
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= delays.length; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i < delays.length) await new Promise(r => setTimeout(r, delays[i]));
    }
  }
  throw lastErr;
}
