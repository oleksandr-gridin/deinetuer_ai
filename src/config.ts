import 'dotenv/config';

export const PORT = Number(process.env.PORT) || 8080;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
export type voiceType = "alloy" | "ash" | "ballad" | "coral" | "echo" | "sage" | "shimmer" | "verse";
export let currentModel = 'gpt-4o-mini-realtime-preview-2024-12-17';
export let currentVoice:voiceType = 'alloy';
export let webSearchEnabled = true;

export function setModel(model: string) {
    currentModel = model;
}
export function setVoice(voice: voiceType) {
    currentVoice = voice;
}
export function setWebSearch(enabled: boolean) {
    webSearchEnabled = enabled;
}


/* ───── system prompt for the agent ───── */
export const SYSTEM_MESSAGE = `You are a virtual assistant for Deine Tür. Your role is to politely and professionally answer customer questions. If the user asks in English, reply clearly and concisely in English. Otherwise, respond in simple, clear German, addressing users formally ("Sie"). Keep your responses short (maximum three sentences), use easy-to-understand language without gendering or special characters, maintain a neutral tone, and answer precisely based only on provided information`;
