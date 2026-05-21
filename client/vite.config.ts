import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
		proxy: {
			'/api': {
				target: 'http://localhost:3001',
				changeOrigin: true,
				configure: (proxy) => {
					proxy.on('error', (_err, _req, res) => {
						if (!res.headersSent) {
							(res as import('http').ServerResponse).writeHead(503, { 'Content-Type': 'application/json' });
							(res as import('http').ServerResponse).end(JSON.stringify({ error: 'Server unavailable' }));
						}
					});
				},
			},
		},
	},
});
