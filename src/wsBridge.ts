import { WebSocket, WebSocketServer } from 'ws';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { webSearchEnabled, OPENAI_API_KEY, currentModel, SYSTEM_MESSAGE, currentVoice } from './config.js';

type ToolDefinitionType = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    domain_allowlist: string[];
  };
};
const tools = webSearchEnabled ? ["web_search"] : [];

function log(sid: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${timestamp}] [${sid}] ${message}`, data);
  } else {
    console.log(`[${timestamp}] [${sid}] ${message}`);
  }
}

export function registerWsBridge(app: FastifyInstance): void {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket, request: any) => {
    const sid = String(request.headers['x-twilio-call-sid'] ?? Date.now());
    log(sid, 'New WebSocket connection established');

    let streamSid: string | undefined;
    let transcript = '';
    let openaiWs: WebSocket | null = null;
    let openaiReady = false;
    let mediaBuffer: any[] = [];
    let sessionConfig: any = null;
    let stopReceived = false;

    // --- Twilio → OpenAI ---
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        log(sid, 'Error parsing Twilio message', { error: err, raw: raw.toString() });
        return;
      }

      switch (msg.event) {
        case 'start':
          if (msg.start) {
            streamSid = msg.start.streamSid;

            openaiWs = new WebSocket(
              `wss://api.openai.com/v1/realtime?model=${currentModel}`,
              {
                headers: {
                  Authorization: `Bearer ${OPENAI_API_KEY}`,
                  'OpenAI-Beta': 'realtime=v1'
                }
              }
            );

            openaiWs.on('open', () => {
              openaiReady = true;
              sessionConfig = {
                modalities: ['text', 'audio'],
                turn_detection: { type: 'server_vad' },
                voice: currentVoice,
                input_audio_transcription: { model: 'whisper-1' },
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                instructions: SYSTEM_MESSAGE,
                temperature: 0.7,
                tools,
              };
              console.log(`[${sid}] OpenAI WS opened`);
              setTimeout(() => {
                openaiWs!.send(JSON.stringify({
                  type: 'session.update',
                  session: sessionConfig
                }));
                if (mediaBuffer.length > 0) {
                  for (const frame of mediaBuffer) {
                    openaiWs!.send(frame);
                  }
                  mediaBuffer = [];
                }
                if (stopReceived) {
                  openaiWs!.send(JSON.stringify({ type: 'input_audio_buffer.end' }));
                  setTimeout(() => openaiWs?.close(), 500);
                }
              }, 250);
            });

            openaiWs.on('message', (data) => {
              let event;
              try {
                event = JSON.parse(data.toString());
              } catch (err) {
                console.error(`[${sid}] Error parsing OpenAI message`, err);
                return;
              }
              console.log(`[${sid}] OpenAI event:`, event);

              // 1. Транскрипция текста
              if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
                console.log(`[${sid}] User: ${event.transcript}`);
              }
              if (event.type === 'response.done') {
                const agent = event.response?.output?.[0]?.content?.find((c: any) => c.transcript)?.transcript;
                if (agent) {
                  console.log(`[${sid}] Agent: ${agent}`);
                }
              }
            });

            openaiWs.on('close', () => {
              openaiReady = false;
              openaiWs = null;
            });
            openaiWs.on('error', (err) => {
              console.error(`[${sid}] OpenAI WebSocket error`, err);
              openaiReady = false;
              openaiWs = null;
            });
          }
          break;

        case 'media':
          const appendMsg = JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload
          });
          if (openaiReady && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(appendMsg);
          } else {
            mediaBuffer.push(appendMsg);
          }
          break;

        case 'stop':
          stopReceived = true;
          if (openaiReady && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.end' }));
            setTimeout(() => openaiWs?.close(), 500);
          }
          break;
      }
    });

    // --- cleanup ---
    const cleanup = () => {
      log(sid, 'Starting cleanup');
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
      log(sid, 'Session cleaned up', { transcriptLength: transcript.length });
    };

    ws.on('close', () => {
      log(sid, 'Twilio WebSocket closed');
      cleanup();
    });
    ws.on('error', (err) => {
      log(sid, 'Twilio WebSocket error', err);
      cleanup();
    });
  });

  // HTTP /media-stream
  app.get('/media-stream', (req: FastifyRequest, reply: FastifyReply) => {
    log('system', 'HTTP request to WebSocket endpoint', { method: req.method, url: req.url });
    reply.raw.writeHead(400);
    reply.raw.end('This route is for WebSocket connections only');
  });

  // WebSocket upgrade
  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    log('system', 'URL FROM MESSAGE', url)
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
