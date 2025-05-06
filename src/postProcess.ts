import fetch from 'node-fetch';
import { SYSTEM_MESSAGE, WEBHOOK_URL } from './config';

interface ChatCompletion {
  customerName: string;
  customerAvailability: string[];
  specialNotes: string;
  transcriptId?: string;
}

const RETRY_DELAYS = [1000, 2000, 4000];

export async function processTranscriptAndSend(transcript: string, id: string): Promise<void> {
  try {
    const completion = await withRetry(() => makeChatGPTCompletion(transcript, id));
    if (WEBHOOK_URL) {
      await withRetry(() => sendToWebhook(completion));
    }
  } catch (error) {
    console.error(`Error processing transcript ${id}:`, error);
  }
}

async function makeChatGPTCompletion(transcript: string, id: string): Promise<ChatCompletion> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-2024-05-13',
      messages: [
        { role: 'system', content: SYSTEM_MESSAGE },
        { role: 'user', content: transcript }
      ],
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.statusText}`);
  }

  const data = await response.json() as {
    choices: Array<{
      message: {
        content: string
      }
    }>
  };
  const content = JSON.parse(data.choices[0].message.content) as {
    customerName?: string;
    customerAvailability?: string[];
    specialNotes?: string;
  };
  
  return {
    customerName: content.customerName ?? 'Unknown',
    customerAvailability: content.customerAvailability ?? [],
    specialNotes: content.specialNotes ?? '',
    transcriptId: id
  };
}

async function sendToWebhook(json: ChatCompletion): Promise<void> {
  if (!WEBHOOK_URL) {
    throw new Error('WEBHOOK_URL is not defined');
  }
  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(json)
  });

  if (!response.ok) {
    throw new Error(`Webhook error: ${response.statusText}`);
  }
}

async function withRetry<T>(fn: () => Promise<T>, retries: number[] = RETRY_DELAYS): Promise<T> {
  let lastError;
  
  for (let i = 0; i <= retries.length; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < retries.length) {
        await new Promise(resolve => setTimeout(resolve, retries[i]));
      }
    }
  }
  
  throw lastError;
}
