export const SYSTEM_MESSAGE: string = "Greetings traveler";
export const VOICE: string = process.env.VOICE ?? 'alloy';
export const MODEL: string = process.env.OPENAI_MODEL ?? 'gpt-4o-realtime-preview-2024-10-01';
export const PORT: number = isNaN(Number(process.env.PORT)) ? 5050 : Number(process.env.PORT);
export const WEBHOOK_URL: string | undefined = process.env.WEBHOOK_URL;
