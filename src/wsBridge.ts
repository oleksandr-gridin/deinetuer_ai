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
  streamSid: string | null;
  transcript: string;
  openAi: WebSocket;
  twilio: WebSocket;
}

const LOG_EVENTS = new Set([
  'response.text.done',
  'response.complete',
  'input.transcription.done',
  'response.content.done',
  'response.done',
  'conversation.item.input_audio_transcription.completed'
]);

const DEBUG_ALL = process.env.DEBUG === 'true';


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
            'OpenAI-Beta': 'realtime=v1'
          }
        }
      );

      sessions.set(sessionId, {
        streamSid: null,
        transcript: '',
        openAi: openAiWs,
        twilio: twilioWs
      });

      /* session.update после открытия соединения */
      openAiWs.once('open', () => {
        console.log(`[${sessionId}] OpenAI WS opened`);

        const update = {
          type: 'session.update',
          session: {
            turn_detection: { type: 'server_vad' },
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice: VOICE,
            instructions: SYSTEM_MESSAGE,
            modalities: ['text', 'audio'],
            temperature: 0.7,
            tools: [
              {
                type: 'web_search',
                domain_allowlist: ['www.deinetuer.de', 'deinetuer.de']
              }
            ],
            input_audio_transcription: { model: 'whisper-1' }
          }
        };

        openAiWs.send(JSON.stringify(update));
      });

      /* -------- сообщения OpenAI → Twilio -------- */
      openAiWs.on('message', raw => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch (e) {
          console.error(`[${sessionId}] JSON-parse error`, e, '\nraw:', raw.toString());
          return;
        }

        if (LOG_EVENTS.has(msg.type))
          console.log(`[${sessionId}] ← OpenAI: ${msg.type}`);
        else if (DEBUG_ALL)
          console.log(`[${sessionId}] ← OTHER: ${msg.type}`);

        const s = sessions.get(sessionId);
        if (!s) return;

        /* --------  user transcription  -------- */
        if (
          msg.type === 'input.transcription.done' ||
          msg.type === 'conversation.item.input_audio_transcription.completed'
        ) {
          const user = msg.transcript?.trim() || '';
          if (user) {
            s.transcript += `User: ${user}\n`;
            console.log(`[${sessionId}] User: ${user}`);
          }
        }

        /* --------  agent final text  -------- */
        if (msg.type === 'response.complete' || msg.type === 'response.done') {
          const agent =
            msg.response?.output?.[0]?.content?.find((c: any) => c.transcript)?.transcript
            ?? msg.response?.text?.[0]                          // новый формат
            ?? '…';
          s.transcript += `Agent: ${agent}\n`;
          console.log(`[${sessionId}] Agent: ${agent}`);
        }

        /* --------  audio chunk  → Twilio  ---- */
        if ((msg.type === 'response.audio.chunk' || msg.type === 'response.audio.delta')
          && msg.delta) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: s.streamSid,
            media: { payload: msg.delta }
          }));
        }
      });

      /* полезно увидеть закрытие сокета и причину */
      openAiWs.on('close', (code, reason) => {
        console.log(`[${sessionId}] OpenAI WS closed`, code, reason.toString());
      });
      openAiWs.on('error', err =>
        console.error(`[${sessionId}] OpenAI WS error`, err)
      );
      const wd = setTimeout(() => {
        console.warn(`[${sessionId}] WATCHDOG 5s: no start/media — closing`);
        const sock: any = connection.socket;

        if (typeof sock.close === 'function') 
          sock.close(1000, 'no start or media');
        else if (typeof sock.terminate === 'function')
          sock.terminate();
        else if (typeof sock.end === 'function') 
          sock.end();
      }, 5000);
      /* ――― первый пакет ――― */
      let gotStart = false;

      /* -------- сообщения Twilio → OpenAI -------- */
      twilioWs.on('message', buf => {
        const evt = JSON.parse(buf.toString());

        /* ---------- start ---------- */
        if (evt.event === 'start') {
          clearTimeout(wd);                  // NEW
          gotStart = true;                   // NEW
          sessions.get(sessionId)!.streamSid = evt.start.streamSid;
          console.log(`[${sessionId}] Twilio stream started`);
          return;
        }

        /* ---------- media ---------- */
        if (evt.event === 'media') {
          if (!gotStart) {                   // NEW
            clearTimeout(wd);
            gotStart = true;
            sessions.get(sessionId)!.streamSid = evt.streamSid; // media-вариант
            console.warn(`[${sessionId}] start missing ⇒ adopted streamSid from media`);
          }
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: evt.media.payload
            }));
          }
          return;
        }
      })

      /* -------- закрываем соединение -------- */
      twilioWs.on('close', async (reason, code) => {
        console.log(`[${sessionId}] Twilio WS closed`);
        console.log(`[${sessionId}] Twilio WS closed`, code, reason.toString());

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
