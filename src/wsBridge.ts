import { WebSocket } from 'ws';
import fetch from 'node-fetch';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { MODEL } from './config';
import { processTranscriptAndSend } from './postProcess';

interface Session {
  ws: WebSocket;
  openAiWs: WebSocket;
  transcript: string;
  inputAudioBuffer: Buffer[];
}

export function registerWsBridge(fastify: FastifyInstance) {
  const sessions = new Map<string, Session>();

  fastify.get('/media-stream', { websocket: true }, (connection: WebSocket, request: FastifyRequest) => {
    const twilioSessionId = request.headers['x-twilio-session-id'];
    const sessionId = typeof twilioSessionId === 'string' ? twilioSessionId : 
                     Array.isArray(twilioSessionId) ? twilioSessionId[0] : Date.now().toString();
    const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    sessions.set(sessionId, {
      ws: connection,
      openAiWs,
      transcript: '',
      inputAudioBuffer: []
    });

    // Send initial session update
    openAiWs.on('open', () => {
      openAiWs.send(JSON.stringify({
        type: 'session.update',
        session_id: sessionId,
        audio_settings: {
          sample_rate: 8000,
          encoding: 'mulaw'
        }
      }));
    });

    // Handle Twilio media stream
    connection.on('message', (message: string) => {
      const msg = JSON.parse(message);
      if (msg.event === 'media') {
        const session = sessions.get(sessionId);
        if (session) {
          session.inputAudioBuffer.push(Buffer.from(msg.media.payload, 'base64'));
        }
      }
    });

    // Handle OpenAI responses
    openAiWs.on('message', (data: string) => {
      const response = JSON.parse(data);
      if (response.audio?.delta) {
        const session = sessions.get(sessionId);
        if (session) {
          session.ws.send(JSON.stringify({
          event: 'media',
          media: {
            payload: response.audio.delta
          }
        }));

          if (response.transcript && session) {
            session.transcript += `Agent: ${response.transcript}\n`;
          }
        }
      }
    });

    // Cleanup on close
    connection.on('close', () => {
      const session = sessions.get(sessionId);
      if (session) {
        session.openAiWs.close();
        sessions.delete(sessionId);
        
        // Save transcript
        if (session.transcript) {
          const fs = require('fs');
          const path = require('path');
          const transcriptPath = path.join('tmp', 'transcripts', `${typeof sessionId === 'string' ? sessionId : sessionId[0]}.txt`);
          fs.writeFileSync(transcriptPath, session.transcript);
          
          // Process transcript
          processTranscriptAndSend(session.transcript, sessionId);
        }
      }
    });
  });
}
