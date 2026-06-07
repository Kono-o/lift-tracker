import { networkInterfaces } from 'node:os';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

/** First private IPv4 (e.g. 192.168.x.x) for HMR when opening the app from a phone. */
function lanIpv4(): string | undefined {
	for (const nets of Object.values(networkInterfaces())) {
		if (!nets) continue;
		for (const net of nets) {
			if (net.family !== 'IPv4' || net.internal) continue;
			const { address } = net;
			if (
				address.startsWith('192.168.') ||
				address.startsWith('10.') ||
				address.startsWith('172.')
			) {
				return address;
			}
		}
	}
	return undefined;
}

const lanHost = lanIpv4();

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
	},
	server: {
		host: '0.0.0.0',
		port: 5173,
		strictPort: true,
		allowedHosts: true,
		...(lanHost
			? {
					hmr: {
						host: lanHost,
						port: 5173,
						clientPort: 5173,
					},
				}
			: {}),
	},
	preview: {
		host: '0.0.0.0',
		port: 5173,
		strictPort: true,
		allowedHosts: true,
	},
});
