#!/usr/bin/env node
/**
 * Build inline muscle diagrams from wger's silhouette + per-muscle overlays.
 *
 * Usage: npm run build:svgs
 *        npm run build:svgs -- --refresh
 *
 * Output: static/svg/front.svg, static/svg/back.svg
 * Each muscle overlay is <g id="muscle-{id}"> so the app can highlight it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CACHE_DIR = path.resolve('.cache/wger/svg');
const OUT_DIR = path.resolve('static/svg');
const MUSCLE_API = 'https://wger.de/api/v2/muscle/?limit=100';
const SILHOUETTES = {
	front: 'https://wger.de/static/images/muscles/muscular_system_front.svg',
	back: 'https://wger.de/static/images/muscles/muscular_system_back.svg'
};
const REFRESH = process.argv.includes('--refresh');

type Muscle = { id: number; name: string; is_front: boolean; image_url_main: string | null };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function download(url: string, file: string) {
	if (!REFRESH) {
		try {
			return await readFile(file, 'utf8');
		} catch {
			// Cache miss.
		}
	}
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const response = await fetch(url, {
			headers: { Accept: 'image/svg+xml', 'User-Agent': 'lift-tracker-svg-build/1.0' }
		});
		if (response.ok) {
			const text = await response.text();
			await writeFile(file, text);
			return text;
		}
		if (response.status === 429 || response.status >= 500) {
			await sleep(1000 * 2 ** attempt);
			continue;
		}
		throw new Error(`${url}: HTTP ${response.status}`);
	}
	throw new Error(`${url}: retries exhausted`);
}

function parseLength(svg: string, name: string) {
	const match = new RegExp(`\\b${name}="([^"]+)"`).exec(svg.slice(0, 2000));
	if (!match) throw new Error(`SVG missing ${name}`);
	return Number.parseFloat(match[1]);
}

function layerTransform(svg: string) {
	const open = /<g\b[^>]*\bid="layer1"[^>]*>/i.exec(svg);
	if (!open) throw new Error('SVG missing layer1 group');
	const translate = /transform="translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)"/i.exec(open[0]);
	if (!translate) throw new Error('layer1 is not a simple translate');
	return { x: Number.parseFloat(translate[1]), y: Number.parseFloat(translate[2]) };
}

function layerInner(svg: string) {
	const open = /<g\b[^>]*\bid="layer1"[^>]*>/i.exec(svg);
	if (!open) throw new Error('SVG missing layer1 group');
	const start = open.index + open[0].length;
	const tag = /<\/?g\b[^>]*>/gi;
	tag.lastIndex = start;
	let depth = 1;
	let match: RegExpExecArray | null;
	while ((match = tag.exec(svg))) {
		if (match[0].startsWith('</')) depth -= 1;
		else depth += 1;
		if (depth === 0) return svg.slice(start, match.index);
	}
	throw new Error('Unbalanced layer1 group');
}

function shadeClass(style: string) {
	const hex = /fill:\s*#([0-9a-f]{6})/i.exec(style)?.[1] ?? 'aaaaaa';
	const lightness = Number.parseInt(hex.slice(0, 2), 16) / 255;
	if (lightness < 0.3) return 'shade-1';
	if (lightness < 0.45) return 'shade-2';
	if (lightness < 0.6) return 'shade-3';
	return 'shade-4';
}

function cleanMarkup(markup: string, body: boolean) {
	return markup.replace(/<([a-z]+)\b([^>]*?)\/?>/gi, (full, name: string, attrs: string) => {
		const shade = body && name.toLowerCase() === 'path' ? shadeClass(attrs) : null;
		const kept: string[] = [];
		const attrPattern = /([:\w-]+)="([^"]*)"/g;
		let attr: RegExpExecArray | null;
		while ((attr = attrPattern.exec(attrs))) {
			const key = attr[1];
			const value = attr[2];
			if (/^(d|transform|fill-rule|clip-rule)$/i.test(key)) {
				kept.push(`${key}="${value}"`);
			} else if (/^points$|^cx$|^cy$|^r$|^x$|^y$|^rx$|^ry$|^width$|^height$/i.test(key)) {
				kept.push(`${key}="${value}"`);
			}
		}
		if (shade) kept.push(`class="${shade}"`);
		const selfClosing = full.endsWith('/>');
		const tagName = name.toLowerCase();
		return `<${tagName}${kept.length ? ' ' + kept.join(' ') : ''}${selfClosing ? '/>' : '>'}`;
	});
}

function wrapGroup(inner: string, transform: { x: number; y: number }) {
	const x = Number(transform.x.toFixed(5));
	const y = Number(transform.y.toFixed(5));
	const attr = x === 0 && y === 0 ? '' : ` transform="translate(${x},${y})"`;
	return { content: cleanMarkup(inner, false), attr };
}

function buildSvg(
	bodySvg: string,
	muscles: { id: number; svg: string }[],
	side: 'front' | 'back'
) {
	const width = parseLength(bodySvg, 'width');
	const height = parseLength(bodySvg, 'height');
	const bodyShift = layerTransform(bodySvg);
	const bodyInner = cleanMarkup(layerInner(bodySvg), true);
	const bodyGroup = `<g class="body-silhouette" transform="translate(${bodyShift.x},${bodyShift.y})">\n${bodyInner}\n  </g>`;

	const overlays: string[] = [];
	for (const muscle of muscles) {
		const muscleWidth = parseLength(muscle.svg, 'width');
		const muscleShift = layerTransform(muscle.svg);
		if (Math.abs(muscleWidth - width) > 1) {
			throw new Error(`muscle ${muscle.id}: width ${muscleWidth} does not match body ${width}`);
		}
		if (Math.abs(muscleShift.x - bodyShift.x) > 0.5) {
			throw new Error(`muscle ${muscle.id}: x origin does not match body`);
		}
		// Inner content is in the shared Inkscape drawing space; both layers only
		// crop that space, so the body's transform places overlays correctly.
		const wrapped = wrapGroup(layerInner(muscle.svg), bodyShift);
		overlays.push(
			`  <g id="muscle-${muscle.id}" class="muscle-overlay"${wrapped.attr}>\n${wrapped.content}\n  </g>`
		);
	}

	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${side} muscle diagram">
  ${bodyGroup}
${overlays.join('\n')}
</svg>
`;
}

async function main() {
	await mkdir(CACHE_DIR, { recursive: true });
	await mkdir(OUT_DIR, { recursive: true });

	const muscleFile = path.join(CACHE_DIR, 'muscles.json');
	let rawMuscles: string;
	try {
		rawMuscles = REFRESH ? '' : await readFile(muscleFile, 'utf8');
	} catch {
		rawMuscles = '';
	}
	if (!rawMuscles) {
		const response = await fetch(MUSCLE_API, {
			headers: { Accept: 'application/json', 'User-Agent': 'lift-tracker-svg-build/1.0' }
		});
		if (!response.ok) throw new Error(`muscle list: HTTP ${response.status}`);
		rawMuscles = await response.text();
		await writeFile(muscleFile, rawMuscles);
	}
	const muscles = (JSON.parse(rawMuscles).results as Muscle[]).filter((m) => m.image_url_main);

	const bodyFront = await download(SILHOUETTES.front, path.join(CACHE_DIR, 'body-front.svg'));
	const bodyBack = await download(SILHOUETTES.back, path.join(CACHE_DIR, 'body-back.svg'));

	const frontMuscles: { id: number; svg: string }[] = [];
	const backMuscles: { id: number; svg: string }[] = [];
	for (const muscle of muscles) {
		const file = path.join(CACHE_DIR, `muscle-${muscle.id}.svg`);
		const svg = await download(muscle.image_url_main!, file);
		(muscle.is_front ? frontMuscles : backMuscles).push({ id: muscle.id, svg });
	}

	const front = buildSvg(bodyFront, frontMuscles, 'front');
	const back = buildSvg(bodyBack, backMuscles, 'back');
	await writeFile(path.join(OUT_DIR, 'front.svg'), front);
	await writeFile(path.join(OUT_DIR, 'back.svg'), back);

	console.log(
		`Wrote ${path.relative(process.cwd(), path.join(OUT_DIR, 'front.svg'))} (${frontMuscles.length} muscles) and ${path.relative(process.cwd(), path.join(OUT_DIR, 'back.svg'))} (${backMuscles.length} muscles).`
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
