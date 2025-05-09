import { WebSocket, WebSocketServer } from 'ws';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { webSearchEnabled, OPENAI_API_KEY, currentModel, SYSTEM_MESSAGE, currentVoice } from './config.js';

const LOG_EVENT_TYPES = [
  'response.content.done',
  'rate_limits.updated',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created',
  'response.text.done',
  'conversation.item.input_audio_transcription.completed',
  'response.audio.delta'
];

function log(sid: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${timestamp}] [${sid}] ${message}`, data);
  } else {
    console.log(`[${timestamp}] [${sid}] ${message}`);
  }
}

// Функция для отправки обновления сессии
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
      tools: webSearchEnabled ? ["web_search"] : [],
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
    log(sid, 'New WebSocket connection established');

    let streamSid: string | undefined;
    let openaiWs: WebSocket | null = null;
    let openaiReady = false;
    let mediaBuffer: any[] = [];
    let stopReceived = false;
    let awaitingResponse = false;
    let responseTimeout: NodeJS.Timeout | null = null;

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
              const sessionUpdate = createSessionUpdate();
              console.log(`[${sid}] Sending session update:`, sessionUpdate);
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
                console.error(`[${sid}] Error parsing OpenAI message`, err);
                return;
              }

              if (LOG_EVENT_TYPES.includes(event.type)) {
                console.log(`[${sid}] OpenAI event:`, event);
              }

              // Обработка аудиоответов
              if (event.type === 'response.audio.delta' && event.delta) {
                const audioDelta = {
                  event: 'media',
                  streamSid: streamSid,
                  media: { payload: event.delta }
                };
                ws.send(JSON.stringify(audioDelta));
                console.log(`[${sid}] Sent audio back to Twilio`);
              }

              // Обработка завершения ответа
              if (event.type === 'response.done') {
                const agent = event.response?.output?.[0]?.content?.find((c: any) => c.transcript)?.transcript;
                if (agent) {
                  console.log(`[${sid}] Agent: ${agent}`);
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
              openaiReady = false;
              openaiWs = null;
              if (responseTimeout) {
                clearTimeout(responseTimeout);
                responseTimeout = null;
              }
            });

            openaiWs.on('error', (err) => {
              console.error(`[${sid}] OpenAI WebSocket error`, err);
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
      log(sid, 'Twilio WebSocket closed');
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

    ws.on('error', (err) => {
      log(sid, 'Twilio WebSocket error', err);
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });
  });

  app.get('/media-stream', (req: FastifyRequest, reply: FastifyReply) => {
    log('system', 'HTTP request to WebSocket endpoint', { method: req.method, url: req.url });
    reply.raw.writeHead(400);
    reply.raw.end('This route is for WebSocket connections only');
  });

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
