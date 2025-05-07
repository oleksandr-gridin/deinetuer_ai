import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import type { SocketStream } from 'fastify-websocket';
import { OPENAI_API_KEY, MODEL, VOICE, SYSTEM_MESSAGE } from './config';

export function registerWsBridge(app: FastifyInstance) {

  app.get('/media-stream', { websocket: true },
    (conn: SocketStream, _req) => {

      const twilio = conn.socket;
      const id = Date.now().toString();
      console.log(id, 'WS in');

      // ---- connect OpenAI realtime
      const ai = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=${MODEL}`,
        { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`,
                     'OpenAI-Beta': 'realtime=v1' } });

      ai.once('open', () => {
        ai.send(JSON.stringify({
          type: 'session.update',
          session: {
            turn_detection: { type: 'server_vad',
                              silence_duration_ms: 10000 },
            input_audio_format:  'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice: VOICE,
            instructions: SYSTEM_MESSAGE,
            modalities: ['text', 'audio']
          }
        }));
      });

      // ---- Twilio → OpenAI
      let evtSid: string;
      twilio.on('message', (buf: Buffer) => {
        const evt = JSON.parse(buf.toString()) as {event: string, media?: {payload: string}, streamSid?: string};
        if (evt.event === 'media' && evt.streamSid) {
          evtSid = evt.streamSid;
        }
        if (evt.event === 'media' && evt.media?.payload)
          ai.readyState === WebSocket.OPEN &&
          ai.send(JSON.stringify({ type: 'input_audio_buffer.append',
                                   audio: evt.media.payload }));
      });

      // ---- OpenAI → Twilio (только звук)
      ai.on('message', (raw: Buffer) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'response.audio.delta' && m.delta) {
          twilio.send(JSON.stringify({ event: 'media',
                                       streamSid: evtSid,
                                       media: { payload: m.delta } }));
        }
      });

      twilio.on('close', () => ai.close());
    });
}
