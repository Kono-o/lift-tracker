import adapterVercel from '@sveltejs/adapter-vercel';
import adapterStatic from '@sveltejs/adapter-static';

const capacitor = process.env.CAPACITOR === '1';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: capacitor
			? adapterStatic({
					fallback: 'index.html',
					strict: false,
				})
			: adapterVercel({ runtime: 'nodejs22.x' })
	}
};

export default config;