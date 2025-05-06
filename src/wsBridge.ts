// src/wsBridge.ts
import { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';

import {
  MODEL,
  SYSTEM_MESSAGE,
  VOICE,
  OPENAI_API_KEY
} from './config';
import { processTranscriptAndSend } from './postProcess';

interface Session {
  streamSid:  string | null;
  transcript: string;
  openAi:     WebSocket;
  twilio:     WebSocket;
}

const LOG_EVENTS = new Set([
  'response.content.done',
  'response.done',
  'conversation.item.input_audio_transcription.completed'
]);

export function registerWsBridge(app: FastifyInstance) {

  const sessions = new Map<string, Session>();

  app.get(
    '/media-stream',
    { websocket: true },
    (connection: any, req: FastifyRequest) => {

      /* настоящий WebSocket, присланный Twilio */
      const twilioWs = connection.socket as WebSocket;

      const sessionId =
        (req.headers['x-twilio-call-sid'] as string) ?? `local_${Date.now()}`;
      console.log(`[${sessionId}] Twilio WS connected`);

      /* -------- OpenAI realtime -------- */
      const openAiWs = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=${MODEL}`,
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta' : 'realtime=v1'
          }
        }
      );

      sessions.set(sessionId, {
        streamSid : null,
        transcript: '',
        openAi    : openAiWs,
        twilio    : twilioWs
      });

      /* session.update после открытия соединения */
      openAiWs.once('open', () => {
        console.log(`[${sessionId}] OpenAI WS opened`);

        const update = {
          type: 'session.update',
          session: {
            turn_detection: { type: 'server_vad' },
            input_audio_format : 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice       : VOICE,
            instructions: SYSTEM_MESSAGE,
            modalities  : ['text', 'audio'],
            temperature : 0.7,
            tools: [
              { type: 'web_search',
                domain_allowlist: ['www.deinetuer.de', 'deinetuer.de'] }
            ],
            input_audio_transcription: { model: 'whisper-1' }
          }
        };

        openAiWs.send(JSON.stringify(update));
      });

      /* -------- сообщения OpenAI → Twilio -------- */
      openAiWs.on('message', raw => {
        const msg = JSON.parse(raw.toString());

        if (LOG_EVENTS.has(msg.type))
          console.log(`[${sessionId}] ← OpenAI: ${msg.type}`);

        const s = sessions.get(sessionId);
        if (!s) return;

        if (msg.type === 'conversation.item.input_audio_transcription.completed') {
          const user = msg.transcript.trim();
          s.transcript += `User: ${user}\n`;
          console.log(`[${sessionId}] User: ${user}`);
        }

        if (msg.type === 'response.done') {
          const agent =
            msg.response.output[0]?.content?.find((c: any) => c.transcript)
              ?.transcript ?? '…';
          s.transcript += `Agent: ${agent}\n`;
          console.log(`[${sessionId}] Agent: ${agent}`);
        }

        if (msg.type === 'response.audio.delta' && msg.delta) {
          twilioWs.send(JSON.stringify({
            event:'media',
            streamSid: s.streamSid,
            media:{ payload: msg.delta }          // delta уже base64
          }));
        }
      });

      openAiWs.on('error', err =>
        console.error(`[${sessionId}] OpenAI WS error`, err)
      );

      /* -------- сообщения Twilio → OpenAI -------- */
      twilioWs.on('message', buf => {
        const evt = JSON.parse(buf.toString());

        switch (evt.event) {
          case 'start':
            sessions.get(sessionId)!.streamSid = evt.start.streamSid;
            console.log(`[${sessionId}] Twilio stream started`);
            break;

          case 'media':
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({
                type : 'input_audio_buffer.append',
                audio: evt.media.payload
              }));
            }
            break;

          default:
            break; // heartbeat / dtmf
        }
      });

      /* -------- закрываем соединение -------- */
      twilioWs.on('close', async () => {
        console.log(`[${sessionId}] Twilio WS closed`);

        if (openAiWs.readyState <= WebSocket.CLOSING)
          openAiWs.terminate();

        const s = sessions.get(sessionId);
        if (s) {
          console.log(`[${sessionId}] ---- FULL TRANSCRIPT ----\n${s.transcript}`);
          await processTranscriptAndSend(s.transcript, sessionId);
          sessions.delete(sessionId);
        }
      });
    }
  );
}
