import { WebSocket, WebSocketServer } from 'ws';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { webSearchEnabled, OPENAI_API_KEY, currentModel, SYSTEM_MESSAGE, currentVoice } from './config.js';

function log(sid: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${timestamp}] [${sid}] ${message}`, data);
  } else {
    console.log(`[${timestamp}] [${sid}] ${message}`);
  }
}

type ToolDefinitionType = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    domain_allowlist: string[];
  };
};

let RealtimeClient: typeof import('@openai/realtime-api-beta').RealtimeClient;

const tools: ToolDefinitionType[] = webSearchEnabled
  ? [
    {
      type: "function",
      name: "web_search",
      description: "Searches the web for information within allowed domains.",
      parameters: {
        domain_allowlist: ["https://deinetuer.de", "deinetuer.de"]
      }
    }
  ]
  : [];

export function registerWsBridge(app: FastifyInstance): void {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', async (ws: WebSocket, request: any) => {
    const sid = String(request.headers['x-twilio-call-sid'] ?? Date.now());
    log(sid, 'New WebSocket connection established');

    // --- OpenAI Realtime Client ---
    if (!RealtimeClient) {
      const module = await import('@openai/realtime-api-beta');
      RealtimeClient = module.RealtimeClient;
    }
    const client = new RealtimeClient({ apiKey: OPENAI_API_KEY });

    // --- Twilio → OpenAI ---
    let streamSid: string | undefined;
    let transcript = '';

    ws.on('message', async (raw) => {
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
            streamSid = msg.start.streamSid;
            log(sid, 'Stream started', { streamSid });
            await client.updateSession({
              model: currentModel,
              instructions: SYSTEM_MESSAGE,
              voice: currentVoice,
              turn_detection: { type: 'server_vad' },
              input_audio_transcription: { model: 'whisper-1' },
              input_audio_format: 'g711_ulaw',
              output_audio_format: 'g711_ulaw',
              modalities: ['text', 'audio'],
              temperature: 0.7,
              tools
            });
            await client.connect();
          }
          break;

        case 'media':
          if (client.isConnected()) {
            const audioBuf = Buffer.from(msg.media.payload, 'base64');
            const audioUint8 = new Uint8Array(audioBuf.buffer, audioBuf.byteOffset, audioBuf.byteLength);
            client.appendInputAudio(audioUint8);
          }
          break;

        case 'stop':
          if (client.isConnected()) {
            await client.createResponse(); // commit audio
            await client.disconnect();
          }
          break;
      }
    });

    // --- OpenAI → Twilio + transcript ---
    client.on('conversation.updated', ({ delta }: { delta: { transcript?: string; response?: { output?: Array<{ content?: Array<{ transcript?: string }> }> }; audio?: Uint8Array } }) => {
      if (delta?.transcript) {
        transcript += `User:  ${delta.transcript}\n`;
        log(sid, `User: ${delta.transcript}`);
      }
      if (delta?.response?.output) {
        const agent = delta.response.output[0]?.content?.find((c: { transcript?: string }) => c.transcript)?.transcript;
        if (agent) {
          transcript += `Agent: ${agent}\n`;
          log(sid, `Agent: ${agent}`);
        }
      }
      if (delta?.audio && streamSid) {
        ws.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: Buffer.from(delta.audio).toString('base64') }
        }));
      }
    });

    // --- cleanup ---
    const cleanup = () => {
      log(sid, 'Starting cleanup');
      if (client.isConnected()) {
        client.disconnect()
      }
      // Uncomment for post-processing:
      // processTranscriptAndSend(transcript, sid).catch(err => {
      //   log(sid, 'Post-process error', err);
      // });
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
    client.on('error', (err: any) => {
      log(sid, 'OpenAI Client error', err);
      cleanup();
    });
    client.on('close', () => {
      log(sid, 'OpenAI Client closed');
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
