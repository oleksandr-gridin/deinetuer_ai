import { WebSocket, WebSocketServer } from 'ws';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { processTranscriptAndSend } from './postProcess';
import { currentModel, currentVoice, OPENAI_API_KEY, SYSTEM_MESSAGE } from './config';

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
  mediaBuffer: string[]; // буфер аудиофреймов
  openAiReady: boolean;
}

const sessions = new Map<string, Session>();

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

    const session: Session = {
      ws,
      openAiWs,
      transcript: '',
      mediaBuffer: [],
      openAiReady: false
    };
    sessions.set(sid, session);

    openAiWs.once('open', () => {
      session.openAiReady = true;
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
          input_audio_transcription: { model: 'whisper-1' }
        }
      };
      log(sid, 'Sending session update to OpenAI');
      openAiWs.send(JSON.stringify(msg));

      // Отправить все накопленные аудиофреймы
      if (session.mediaBuffer.length > 0) {
        log(sid, `Flushing ${session.mediaBuffer.length} buffered audio frames to OpenAI`);
        for (const frame of session.mediaBuffer) {
          openAiWs.send(frame);
        }
        session.mediaBuffer = [];
      }
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
          const appendMsg = JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload
          });
          if (session.openAiReady && openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(appendMsg);
          } else {
            session.mediaBuffer.push(appendMsg);
            log(sid, 'Buffering audio frame, OpenAI WS not ready', { bufferLength: session.mediaBuffer.length });
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

      // Логируем каждую реплику пользователя
      if (m.type === 'conversation.item.input_audio_transcription.completed' && m.transcript) {
        session.transcript += `User:  ${m.transcript}\n`;
        log(sid, `User: ${m.transcript}`);
      }

      // Логируем каждую реплику агента
      if (m.type === 'response.done') {
        const agent = m.response?.output?.[0]?.content?.find(c => c.transcript)?.transcript;
        if (agent) {
          session.transcript += `Agent: ${agent}\n`;
          log(sid, `Agent: ${agent}`);
        }
      }

      // Аудио-ответ агента
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
      // Можно раскомментировать для post-processing:
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

  // HTTP-заглушка для /media-stream
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
