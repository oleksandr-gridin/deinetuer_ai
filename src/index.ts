import fastify from 'fastify';
import { registerWsBridge } from './wsBridge';
import { PORT } from './config';

const app = fastify();

// Register WebSocket bridge
registerWsBridge(app);

// Start the server
app.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server listening at ${address}`);
});
