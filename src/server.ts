import fastify, { FastifyRequest, FastifyReply } from 'fastify';
import formbody from '@fastify/formbody';
import websocket from '@fastify/websocket';
import { registerWsBridge } from './wsBridge';
import { PORT, VOICE } from './config';

const app = fastify();

(async () => {
  await app.register(formbody);
  await app.register(websocket);
})();

app.get('/healthz', async (): Promise<{ status: string }> => {
  return { status: 'alive' };
});

app.get('/', async (): Promise<{ message: string }> => {
  return { message: 'running' };
});

app.all('/incoming-call', async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${VOICE}">Hello, thank you for calling out door shop. How can i help you?.</Say>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`;
  
  reply.header('Content-Type', 'text/xml');
  return twiml;
});

registerWsBridge(app);

app.listen({ port: PORT, host: '0.0.0.0' }, (err: Error | null) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server listening on port ${PORT}`);
});
