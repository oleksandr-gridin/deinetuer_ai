import { WebSocket, WebSocketServer } from 'ws';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { processTranscriptAndSend } from './postProcess';
import { webSearchEnabled, currentModel, OPENAI_API_KEY, currentVoice, SYSTEM_MESSAGE } from './config';

function log(sid: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${timestamp}] [${sid}] ${message}`, data);
  } else {
    console.log(`[${timestamp}] [${sid}] ${message}`);
  }
}

interface Session {
  ws: WebSocket; // Twilio <-> backend
  openAiWs: WebSocket; // backend <-> OpenAI
  transcript: string;
  streamSid?: string;
}

const sessions = new Map<string, Session>();
const tools = webSearchEnabled
  ? [{ type: 'web_search', domain_allowlist: [] }]
  : [];

export function registerWsBridge(app: FastifyInstance): void {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket, request: any) => {
    const sid = String(request.headers['x-twilio-call-sid'] ?? Date.now());
    log(sid, 'New WebSocket connection established');

    // OpenAI WebSocket
    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${currentModel}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );
    log(sid, 'Creating OpenAI WebSocket connection');

    const session: Session = { ws, openAiWs, transcript: '' };
    sessions.set(sid, session);

    openAiWs.once('open', () => {
      log(sid, 'OpenAI WebSocket connection opened');
      const msg = {
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad' },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: currentVoice,
          instructions: SYSTEM_MESSAGE,
          modalities: ['text', 'audio'],
          temperature: 0.7,
          input_audio_transcription: { model: 'whisper-1' },
          tools
        }
      };
      log(sid, 'Sending session update to OpenAI');
      openAiWs.send(JSON.stringify(msg));
    });

    // --- Twilio → OpenAI ---
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
        log(sid, `Received message from Twilio: ${msg.event}`, msg);
      } catch (err) {
        log(sid, 'Error parsing Twilio message', { error: err, raw: raw.toString() });
        return;
      }

      switch (msg.event) {
        case 'start':
          if (msg.start) {
            session.streamSid = msg.start.streamSid;
            log(sid, 'Stream started', { streamSid: session.streamSid });
          }
          break;

        case 'media':
          if (openAiWs.readyState === WebSocket.OPEN && msg.media?.payload) {
            openAiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.media.payload
            }));
            log(sid, 'Forwarded media to OpenAI', { payloadLength: msg.media.payload.length });
          } else {
            log(sid, 'Cannot forward media - OpenAI WS not ready', { readyState: openAiWs.readyState });
          }
          break;
      }
    });

    // --- OpenAI → Twilio + transcript ---
    openAiWs.on('message', (data) => {
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch (err) {
        log(sid, 'Error parsing OpenAI message', { error: err, raw: data.toString() });
        return;
      }

      // Log of every replica of user
      if (m.type === 'conversation.item.input_audio_transcription.completed' && m.transcript) {
        session.transcript += `User:  ${m.transcript}\n`;
        log(sid, `User: ${m.transcript}`);
      }

      // Log of every replica of agent
      if (m.type === 'response.done') {
        const agent = m.response?.output?.[0]?.content?.find(c => c.transcript)?.transcript;
        if (agent) {
          session.transcript += `Agent: ${agent}\n`;
          log(sid, `Agent: ${agent}`);
        }
      }

      // Audio response
      if (m.type === 'response.audio.delta' && m.delta && session.streamSid) {
        ws.send(JSON.stringify({
          event: 'media',
          streamSid: session.streamSid,
          media: { payload: m.delta }
        }));
      }
    });

    // --- cleanup ---
    const cleanup = () => {
      log(sid, 'Starting cleanup');
      if (openAiWs.readyState === WebSocket.OPEN) {
        log(sid, 'Closing OpenAI WebSocket');
        openAiWs.close();
      }
      //  post-processing:
      // processTranscriptAndSend(session.transcript, sid).catch(err => {
      //   log(sid, 'Post-process error', err);
      // });
      sessions.delete(sid);
      log(sid, 'Session cleaned up', { transcriptLength: session.transcript.length });
    };

    ws.on('close', () => {
      log(sid, 'Twilio WebSocket closed');
      cleanup();
    });
    ws.on('error', (err) => {
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

  // HTTP-trap for calling /media-stream via http
  app.get('/media-stream', (req: FastifyRequest, reply: FastifyReply) => {
    log('system', 'HTTP request to WebSocket endpoint', { method: req.method, url: req.url });
    reply.raw.writeHead(400);
    reply.raw.end('This route is for WebSocket connections only');
  });

  // WebSocket upgrade
  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    log('system', 'WebSocket upgrade request', { path: url.pathname });

    if (url.pathname === '/media-stream') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      log('system', 'Rejected WebSocket upgrade - invalid path', { path: url.pathname });
      socket.destroy();
    }
  });
}
