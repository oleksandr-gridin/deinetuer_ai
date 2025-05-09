import { WebSocket, WebSocketServer } from 'ws';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { webSearchEnabled, OPENAI_API_KEY, currentModel, SYSTEM_MESSAGE, currentVoice } from './config.js';

// Simplified log function to match the requested format
function log(sid: string, message: string) {
  console.log(`[${sid}] ${message}`);
}

type ToolDefinitionType = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: {
      query: {
        type: "string";
        description: string;
      };
    };
    required: string[];
  };
};

const tools: ToolDefinitionType[] = webSearchEnabled ? [{
  type: "function",
  name: "deinetuer_search",
  description: "Search for information on deinetuer.de website to find door-related products and information",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search terms to look for on deinetuer.de (e.g., 'wooden doors', 'door handles', 'installation guide')"
      }
    },
    required: ["query"]
  }
}] : [];

function createSessionUpdate() {
  return {
    type: 'session.update',
    session: {
      turn_detection: { type: 'server_vad' },
      input_audio_format: 'g711_ulaw',
      output_audio_format: 'g711_ulaw',
      voice: currentVoice,
      instructions: SYSTEM_MESSAGE,
      modalities: ["text", "audio"],
      temperature: 0.8,
      tools,
      input_audio_transcription: {
        "model": "whisper-1"
      }
    }
  };
}

export function registerWsBridge(app: FastifyInstance): void {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket, request: any) => {
    const sid = String(request.headers['x-twilio-call-sid'] ?? Date.now());
    log(sid, 'Connection established between Twilio and server');

    let streamSid: string | undefined;
    let openaiWs: WebSocket | null = null;
    let openaiReady = false;
    let mediaBuffer: any[] = [];
    let stopReceived = false;
    let awaitingResponse = false;
    let responseTimeout: NodeJS.Timeout | null = null;
    let startTime: number;

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return;
      }

      switch (msg.event) {
        case 'start':
          if (msg.start) {
            streamSid = msg.start.streamSid;
            log(sid, 'Connection starting from Twilio to OpenAI');

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
              const sessionUpdate = createSessionUpdate();
              openaiWs!.send(JSON.stringify(sessionUpdate));

              if (mediaBuffer.length > 0) {
                for (const frame of mediaBuffer) {
                  openaiWs!.send(frame);
                }
                mediaBuffer = [];
              }
              if (stopReceived) {
                openaiWs!.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
                awaitingResponse = true;
                startTime = Date.now();
                responseTimeout = setTimeout(() => {
                  if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                    openaiWs.close();
                  }
                }, 10000);
              }
            });

            openaiWs.on('message', (data) => {
              let event;
              try {
                event = JSON.parse(data.toString());
              } catch (err) {
                return;
              }

              if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcription?.text) {
                log(sid, `[User]: ${event.transcription.text}`);
              }

              // Обработка аудиоответов
              if (event.type === 'response.audio.delta' && event.delta) {
                const audioDelta = {
                  event: 'media',
                  streamSid: streamSid,
                  media: { payload: event.delta }
                };
                ws.send(JSON.stringify(audioDelta));
              }

              // Обработка завершения ответа
              if (event.type === 'response.done') {
                const agent = event.response?.output?.[0]?.content?.find((c: any) => c.transcript)?.transcript;
                if (agent) {
                  log(sid, `[Agent]: ${agent}`);
                  const responseTime = Date.now() - startTime;
                  log(sid, `Response time: ${responseTime}ms`);
                }
                if (awaitingResponse && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                  setTimeout(() => openaiWs?.close(), 500);
                  awaitingResponse = false;
                  if (responseTimeout) {
                    clearTimeout(responseTimeout);
                    responseTimeout = null;
                  }
                }
              }
            });

            openaiWs.on('close', () => {
              log(sid, 'Connection closed between server and OpenAI');
              openaiReady = false;
              openaiWs = null;
              if (responseTimeout) {
                clearTimeout(responseTimeout);
                responseTimeout = null;
              }
            });

            openaiWs.on('error', () => {
              log(sid, 'Error in connection with OpenAI');
              openaiReady = false;
              openaiWs = null;
              if (responseTimeout) {
                clearTimeout(responseTimeout);
                responseTimeout = null;
              }
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
          log(sid, 'Media recording stopped, committing audio buffer');
          startTime = Date.now();
          if (openaiReady && openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            awaitingResponse = true;
            responseTimeout = setTimeout(() => {
              if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.close();
              }
            }, 10000);
          }
          break;
      }
    });

    ws.on('close', () => {
      log(sid, 'Connection closed between Twilio and server');
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

    ws.on('error', () => {
      log(sid, 'Error in connection with Twilio');
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });
  });

  app.get('/media-stream', (req: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(400);
    reply.raw.end('This route is for WebSocket connections only');
  });

  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname === '/media-stream') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });
}
