import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from 'node:fs';
import path from 'node:path';

export default defineConfig({
  clearScreen: false,
  plugins: [react(), {
    name: 'local-examples',
    configureServer(server) {
      if (process.env.VITE_EXAMPLE_DATA !== '1') return;
      server.middlewares.use('/__examples', (request, response) => {
        const relative = decodeURIComponent((request.url ?? '').split('?')[0]).replace(/^\//, '');
        if (!/^(data\.json|images\/[a-f0-9]+\.png|replays\/[\w.-]+\.(rep|json))$/.test(relative)) { response.statusCode = 404; response.end(); return; }
        const file = path.resolve('build/dev-data', relative);
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', relative.endsWith('.json') ? 'application/json' : relative.endsWith('.png') ? 'image/png' : 'application/octet-stream');
        const stream = fs.createReadStream(file);
        stream.on('error', () => { response.statusCode = 404; response.end(); });
        stream.pipe(response);
      });
    },
  }],
  server: {
    strictPort: true,
    port: 5173,
  },
});
