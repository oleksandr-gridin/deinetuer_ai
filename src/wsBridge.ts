// src/wsBridge.ts
import { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import {
  MODEL, SYSTEM_MESSAGE, VOICE, OPENAI_API_KEY
} from './config';
import { processTranscriptAndSend } from './postProcess';

interface Session {
  streamSid : string | null;
  transcript: string;
  openAi    : WebSocket;
  twilio    : WebSocket;
}

const LOG_EVENTS = new Set([
  'response.text.done',
  'response.complete',
  'input.transcription.done',
  /* legacy */
  'response.content.done',
  'response.done',
  'conversation.item.input_audio_transcription.completed'
]);

const DEBUG_ALL = process.env.DEBUG === 'true';

export function registerWsBridge(app: FastifyInstance) {

  const sessions = new Map<string, Session>();

  app.get('/media-stream', { websocket: true },
    (connection: any, req: FastifyRequest) => {

      /* ───────── Twilio socket ───────── */
      const twilioWs = connection.socket as WebSocket;
      const sessionId =
        (req.headers['x-twilio-call-sid'] as string) ?? `local_${Date.now()}`;
      console.log(`[${sessionId}] Twilio WS connected`);

      /* ───────── OpenAI realtime ─────── */
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

      /* session.update */
      openAiWs.once('open', () => {
        console.log(`[${sessionId}] OpenAI WS opened`);
        openAiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            turn_detection: { type:'server_vad', silence_duration_ms:10000 },
            input_audio_format : 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice: VOICE,
            instructions: SYSTEM_MESSAGE,
            modalities: ['text','audio'],
            temperature: 0.7,
            tools: [
              { type:'web_search',
                domain_allowlist:['www.deinetuer.de','deinetuer.de'] }
            ],
            input_audio_transcription:{ model:'whisper-1' }
          }
        }));
      });

      /* ───── OpenAI → Twilio ───── */
      openAiWs.on('message', raw => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); }
        catch(e){ console.error(`[${sessionId}] JSON error`, e); return; }

        if (LOG_EVENTS.has(msg.type))
          console.log(`[${sessionId}] ← OpenAI: ${msg.type}`);
        else if (DEBUG_ALL)
          console.log(`[${sessionId}] ← OTHER: ${msg.type}`);

        const s = sessions.get(sessionId);
        if (!s) return;

        /* user text */
        if (msg.type==='input.transcription.done' ||
            msg.type==='conversation.item.input_audio_transcription.completed') {
          const user = msg.transcript?.trim() || '';
          if (user) {
            s.transcript += `User: ${user}\n`;
            console.log(`[${sessionId}] User: ${user}`);
          }
        }

        /* agent final text */
        if (msg.type==='response.complete' || msg.type==='response.done') {
          const agent =
            msg.response?.output?.[0]?.content?.find((c:any)=>c.transcript)?.transcript
            ?? msg.response?.text?.[0]
            ?? '…';
          s.transcript += `Agent: ${agent}\n`;
          console.log(`[${sessionId}] Agent: ${agent}`);
        }

        /* audio → Twilio */
        if ((msg.type==='response.audio.chunk'||msg.type==='response.audio.delta')
            && msg.delta) {
          twilioWs.send(JSON.stringify({
            event:'media',
            streamSid: s.streamSid,
            media:{ payload: msg.delta }
          }));
        }
      });

      openAiWs.on('close', (code, reason) =>
        console.log(`[${sessionId}] OpenAI WS closed`, code, reason.toString()));
      openAiWs.on('error', err =>
        console.error(`[${sessionId}] OpenAI WS error`, err));

      /* ───── watchdog: 5 s тишины ───── */
      const wd = setTimeout(() => {
        console.warn(`[${sessionId}] WATCHDOG 5s: no start/media — closing`);
        const sock: any = connection.socket;
        if (typeof sock.terminate === 'function') sock.terminate();
        else if (typeof sock.end === 'function')  sock.end();
      }, 5_000);

      /* ───── Twilio → OpenAI ───── */
      let gotStart = false;

      twilioWs.on('message', buf => {
        const evt = JSON.parse(buf.toString());

        /* start */
        if (evt.event === 'start') {
          clearTimeout(wd);
          gotStart = true;
          sessions.get(sessionId)!.streamSid = evt.start.streamSid;
          console.log(`[${sessionId}] Twilio stream started`);
          return;
        }

        /* media */
        if (evt.event === 'media') {
          if (!gotStart) {
            clearTimeout(wd);
            gotStart = true;
            sessions.get(sessionId)!.streamSid = evt.streamSid;
            console.warn(`[${sessionId}] adopted streamSid from first media`);
          }
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({
              type:'input_audio_buffer.append',
              audio: evt.media.payload
            }));
          }
          return;
        }
      });

      /* ───── закрытие ───── */
      twilioWs.on('close', async (code, reason) => {
        console.log(`[${sessionId}] Twilio WS closed`, code, reason.toString());

        if (openAiWs.readyState <= WebSocket.CLOSING)
          openAiWs.terminate();

        const s = sessions.get(sessionId);
        if (s) {
          console.log(`[${sessionId}] ---- FULL TRANSCRIPT ----\n${s.transcript}`);
          try { await processTranscriptAndSend(s.transcript, sessionId); }
          catch(e){ console.error(`[${sessionId}] post-process failed`, e); }
          sessions.delete(sessionId);
        }
      });
    });
}
