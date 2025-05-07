import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { FastifyInstance } from 'fastify';
import { MODEL, OPENAI_API_KEY, VOICE, SYSTEM_MESSAGE } from './config';
import { processTranscriptAndSend } from './postProcess';

interface Session {
  ws: WebSocket;          // Twilio  ⇄ backend
  openAiWs: WebSocket;    // backend ⇄ OpenAI
  transcript: string;
  streamSid?: string;
}

interface TwilioMediaMessage {
  event: 'start' | 'media' | string;
  streamSid?: string;
  start?: { streamSid: string };
  media?: { payload: string };
}

interface OpenAISessionUpdate {
  type: 'session.update';
  session: {
    turn_detection: { type: string };
    input_audio_format: string;
    output_audio_format: string;
    voice: string;
    instructions: string;
    modalities: string[];
    temperature: number;
    input_audio_transcription: { model: string };
    tools: Array<{ type: string, domain_allowlist: string[] }>
  };
}

interface OpenAIAudioAppend {
  type: 'input_audio_buffer.append';
  audio: string;
}

interface OpenAIMessage {
  type: string;
  transcript?: string;
  response?: {
    output?: Array<{
      content?: Array<{ transcript?: string }>;
    }>;
  };
  delta?: string;
}


const sessions = new Map<string, Session>();

export function registerWsBridge(app: FastifyInstance): void {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (twilioSocket: WebSocket, req: http.IncomingMessage) => {
    const sid = String(req.headers['x-twilio-call-sid'] ?? Date.now());

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${MODEL}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );

    const session: Session = { ws: twilioSocket, openAiWs, transcript: '' };
    sessions.set(sid, session);

    openAiWs.once('open', () => {
      const msg: OpenAISessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad' },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ['text', 'audio'],
          temperature: 0.7,
          input_audio_transcription: { model: 'whisper-1' },
          tools: [
            {
              type: 'web_search',
              domain_allowlist: ['www.deinetuer.de', 'deinetuer.de']
            }
          ],
        },
      };
      openAiWs.send(JSON.stringify(msg));
    });

    twilioSocket.on('message', raw => {
      let msg: TwilioMediaMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.event) {
        case 'start':
          session.streamSid = msg.start?.streamSid;
          break;

        case 'media':
          if (
            openAiWs.readyState === WebSocket.OPEN &&
            msg.media?.payload
          ) {
            const append: OpenAIAudioAppend = {
              type: 'input_audio_buffer.append',
              audio: msg.media.payload
            };
            openAiWs.send(JSON.stringify(append));
          }
          break;
      }
    });

    openAiWs.on('message', data => {
      let m: OpenAIMessage;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (
        m.type ===
        'conversation.item.input_audio_transcription.completed' &&
        m.transcript
      ) {
        session.transcript += `User:  ${m.transcript}\n`;
      }

      if (m.type === 'response.done') {
        const agent = m.response?.output?.[0]?.content?.find(
          c => c.transcript
        )?.transcript;
        if (agent) session.transcript += `Agent: ${agent}\n`;
      }

      if (
        m.type === 'response.audio.delta' &&
        m.delta &&
        session.streamSid
      ) {
        const twMsg: TwilioMediaMessage = {
          event: 'media',
          streamSid: session.streamSid,
          media: { payload: m.delta }
        };
        twilioSocket.send(JSON.stringify(twMsg));
      }
    });

    const cleanup = () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      // processTranscriptAndSend(session.transcript, sid).catch(err =>
      //   console.error(`[${sid}] post-process error:`, err)
      // );
      sessions.delete(sid);
    };

    twilioSocket.on('close', cleanup);
    twilioSocket.on('error', cleanup);
    openAiWs.on('close', cleanup);
    openAiWs.on('error', cleanup);
  });

  app.server.on('upgrade', (req, socket, head) => {
    if (req.url === '/media-stream') {
      wss.handleUpgrade(req, socket, head, ws => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });
}
