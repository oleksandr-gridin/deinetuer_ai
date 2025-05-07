import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { FastifyInstance } from 'fastify';
import { MODEL, OPENAI_API_KEY, VOICE, SYSTEM_MESSAGE } from './config';
import { processTranscriptAndSend } from './postProcess';

function log(sid: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${sid}] ${message}`, data || '');
}

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
    log(sid, 'New WebSocket connection established');

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${MODEL}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );
    log(sid, 'Creating OpenAI WebSocket connection');

    const session: Session = { ws: twilioSocket, openAiWs, transcript: '' };
    sessions.set(sid, session);
    log(sid, 'New session created', { sessionId: sid });

    openAiWs.once('open', () => {
      log(sid, 'OpenAI WebSocket connection opened');
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
      log(sid, 'Sending session update to OpenAI', msg);
      openAiWs.send(JSON.stringify(msg));
    });

    twilioSocket.on('message', raw => {
      let msg: TwilioMediaMessage;
      try {
        msg = JSON.parse(raw.toString());
        log(sid, 'Received message from Twilio', msg);
      } catch (err) {
        log(sid, 'Error parsing Twilio message', { error: err, raw: raw.toString() });
        return;
      }

      switch (msg.event) {
        case 'start':
          if (msg.start?.streamSid) {
            session.streamSid = msg.start.streamSid;
            log(sid, 'Stream started', { streamSid: session.streamSid });
          }
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
            log(sid, 'Forwarding media to OpenAI', { payloadLength: msg.media.payload.length });
            openAiWs.send(JSON.stringify(append));
          } else {
            log(sid, 'Cannot forward media - OpenAI WS not ready', { readyState: openAiWs.readyState });
          }
          break;
      }
    });

    openAiWs.on('message', data => {
      let m: OpenAIMessage;
      try {
        m = JSON.parse(data.toString());
        log(sid, 'Received message from OpenAI', m);
      } catch (err) {
        log(sid, 'Error parsing OpenAI message', { error: err, raw: data.toString() });
        return;
      }

      if (
        m.type ===
        'conversation.item.input_audio_transcription.completed' &&
        m.transcript
      ) {
        session.transcript += `User:  ${m.transcript}\n`;
        log(sid, 'Added user transcript to session', { transcript: m.transcript });
      }

      if (m.type === 'response.done') {
        const agent = m.response?.output?.[0]?.content?.find(
          c => c.transcript
        )?.transcript;
        if (agent) {
          session.transcript += `Agent: ${agent}\n`;
          log(sid, 'Added agent response to session', { response: agent });
        }
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
        log(sid, 'Sending audio to Twilio', { deltaLength: m.delta.length });
        twilioSocket.send(JSON.stringify(twMsg));
      } else if (m.type === 'response.audio.delta' && !session.streamSid) {
        log(sid, 'Cannot send audio - missing streamSid');
      }
    });

    const cleanup = () => {
      log(sid, 'Starting cleanup');
      if (openAiWs.readyState === WebSocket.OPEN) {
        log(sid, 'Closing OpenAI WebSocket');
        openAiWs.close();
      }
      // processTranscriptAndSend(session.transcript, sid).catch(err => {
      //   log(sid, 'Post-process error', err);
      // });
      sessions.delete(sid);
      log(sid, 'Session cleaned up', { transcriptLength: session.transcript.length });
    };

    twilioSocket.on('close', () => {
      log(sid, 'Twilio WebSocket closed');
      cleanup();
    });
    twilioSocket.on('error', (err) => {
      log(sid, 'Twilio WebSocket error', err);
      cleanup();
    });
    openAiWs.on('close', () => {
      log(sid, 'OpenAI WebSocket closed');
      cleanup();
    });
    openAiWs.on('error', (err) => {
      log(sid, 'OpenAI WebSocket error', err);
      cleanup();
    });
  });

  app.server.on('upgrade', (req, socket, head) => {
    log('system', 'WebSocket upgrade request', { url: req.url });
    if (req.url === '/media-stream') {
      wss.handleUpgrade(req, socket, head, ws => {
        wss.emit('connection', ws, req);
      });
    } else {
      log('system', 'Rejected WebSocket upgrade - invalid path', { url: req.url });
      socket.destroy();
    }
  });
}
