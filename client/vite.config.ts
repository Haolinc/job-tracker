import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
	plugins: [react()],
	test: {
		environment: 'jsdom',
		setupFiles: ['./src/test-setup.ts'],
		css: false,
	},
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
