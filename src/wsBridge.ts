import { WebSocket, WebSocketServer } from 'ws';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { MODEL, OPENAI_API_KEY, VOICE, SYSTEM_MESSAGE } from './config';
import { processTranscriptAndSend } from './postProcess';


interface Session {
  ws: WebSocket; // Twilio <-> backend
  openAiWs: WebSocket; // backend <-> OpenAI
  transcript: string;
  streamSid?: string;
}

interface TwilioMediaMessage {
  event: string;
  streamSid?: string;
  start?: {
    streamSid: string;
  };
  media?: {
    payload: string; // base64 μ-Law 8 kHz
  };
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
  };
}

interface OpenAIAudioBuffer {
  type: 'input_audio_buffer.append';
  audio: string; // base64 payload
}

interface OpenAIResponseMessage {
  type: string;
  transcript?: string;
  response?: {
    output?: Array<{
      content?: Array<{
        transcript?: string;
      }>;
    }>;
  };
  delta?: string;
}

const sessions = new Map<string, Session>();

export function registerWsBridge(app: FastifyInstance): void {
  // Create a WebSocket server instance
  const wss = new WebSocketServer({ noServer: true });
  
  // Handle WebSocket connections
  wss.on('connection', (ws: WebSocket, request: any) => {
    // Extract the call SID from headers or use timestamp
    const sid = String(
      request.headers['x-twilio-call-sid'] ?? Date.now()
    );
    
    // Create OpenAI WebSocket connection
    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${MODEL}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );
    
    // Initialize session
    const session: Session = {
      ws,
      openAiWs,
      transcript: ''
    };
    sessions.set(sid, session);
    
    /* ──────────────── OpenAI ⇾ session update ──────────────── */
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
          input_audio_transcription: { model: 'whisper-1' }
        }
      };
      openAiWs.send(JSON.stringify(msg));
    });
    
    /* ──────────────── Twilio → OpenAI ──────────────── */
    ws.on('message', (raw) => {
      let msg: TwilioMediaMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      
      switch (msg.event) {
        case 'start':
          if (msg.start) {
            session.streamSid = msg.start.streamSid;
          }
          break;
          
        case 'media':
          if (openAiWs.readyState === WebSocket.OPEN && msg.media?.payload) {
            const appendMsg: OpenAIAudioBuffer = {
              type: 'input_audio_buffer.append',
              audio: msg.media.payload // base64 μ-Law 8 kHz
            };
            openAiWs.send(JSON.stringify(appendMsg));
          }
          break;
      }
    });
    
    /* ──────────────── OpenAI → Twilio + transcript ──────────────── */
    openAiWs.on('message', (data) => {
      const m = JSON.parse(data.toString()) as OpenAIResponseMessage;
      
      // User text (Whisper transcription)
      if (m.type === 'conversation.item.input_audio_transcription.completed' && m.transcript) {
        session.transcript += `User:  ${m.transcript}\n`;
      }
      
      // Agent text (final)
      if (m.type === 'response.done') {
        const agent =
          m.response?.output?.[0]?.content?.find(
            (c) => c.transcript
          )?.transcript;
        if (agent) session.transcript += `Agent: ${agent}\n`;
      }
      
      // Agent audio
      if (
        m.type === 'response.audio.delta' &&
        m.delta &&
        session.streamSid
      ) {
        const twilioMedia: TwilioMediaMessage = {
          event: 'media',
          streamSid: session.streamSid,
          media: { payload: m.delta } // base64 μ-Law
        };
        ws.send(JSON.stringify(twilioMedia));
      }
    });
    
    /* ──────────────── cleanup ──────────────── */
    const cleanup = (): void => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      // processTranscriptAndSend(session.transcript, sid).catch(err =>
      //   console.error(`[${sid}] post-process error:`, err)
      // );
      sessions.delete(sid);
    };
    
    ws.on('close', cleanup);
    ws.on('error', cleanup);
    openAiWs.on('close', cleanup);
    openAiWs.on('error', (err) => {
      console.error('OpenAI WS error', err);
      cleanup();
    });
  });
  
  // Register HTTP route for WebSocket upgrade
  app.get('/media-stream', (req: FastifyRequest, reply: FastifyReply) => {
    // This route will handle the HTTP part of the WebSocket handshake
    reply.raw.writeHead(400);
    reply.raw.end('This route is for WebSocket connections only');
  });
  
  // Handle WebSocket upgrade
  app.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    
    // Only handle WebSocket connections to our endpoint
    if (url.pathname === '/media-stream') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      // Close the connection when not matching our endpoint
      socket.destroy();
    }
  });
}
