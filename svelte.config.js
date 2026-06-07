import adapterAuto from '@sveltejs/adapter-auto';
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
			: adapterAuto()
	}
};

export default config;