import fastify from 'fastify';
import { PORT } from './config.js';
import { registerWsBridge } from './wsBridge.js';


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
