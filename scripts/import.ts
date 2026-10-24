#!/usr/bin/env node
/**
 * Import the wger exercise catalog into Supabase.
 *
 * Usage: npm run import:wger
 *        npm run import:wger -- --refresh
 *
 * Requires PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.
 * The service-role key is server-only and must never be shipped to the client.
 */

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://wger.de/api/v2';
const LANGUAGE_EN = 2;
const PAGE_LIMIT = 100;
const THROTTLE_MS = 350;
const CACHE_DIR = path.resolve('.cache/wger');
const REFRESH = process.argv.includes('--refresh');

const url = process.env.PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
	console.error(
		'Missing PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Add them to .env (the service key is never exposed to the client).'
	);
	process.exit(1);
}

const supabase = createClient(url, serviceKey, {
	auth: { autoRefreshToken: false, persistSession: false }
});

type WgerMuscle = {
	id: number;
	name: string;
	name_en?: string;
	is_front?: boolean;
	image_url_main?: string | null;
	image_url_secondary?: string | null;
};

type WgerTranslation = {
	language: number;
	name?: string;
	description?: string;
	license_author?: string;
};

type WgerExercise = {
	id: number;
	uuid?: string | null;
	category?: { id: number; name: string } | null;
	muscles?: WgerMuscle[];
	muscles_secondary?: WgerMuscle[];
	equipment?: { id: number; name: string }[];
	license?: { short_name?: string; url?: string; full_name?: string } | null;
	license_author?: string | null;
	last_update?: string | null;
	last_update_global?: string | null;
	translations?: WgerTranslation[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function cachePath(name: string) {
	const digest = createHash('sha1').update(name).digest('hex').slice(0, 12);
	return path.join(CACHE_DIR, `${digest}.json`);
}

async function fetchJson<T>(urlToFetch: string, label: string): Promise<T> {
	await mkdir(CACHE_DIR, { recursive: true });
	const file = await cachePath(label);
	if (!REFRESH) {
		try {
			return JSON.parse(await readFile(file, 'utf8')) as T;
		} catch {
			// Cache miss.
		}
	}

	for (let attempt = 0; attempt < 4; attempt += 1) {
		const response = await fetch(urlToFetch, {
			headers: {
				Accept: 'application/json',
				'User-Agent': 'lift-tracker-catalog-import/1.0'
			}
		});
		if (response.ok) {
			const data = (await response.json()) as T;
			await writeFile(file, JSON.stringify(data));
			return data;
		}
		if (response.status === 429 || response.status >= 500) {
			const wait = 1000 * 2 ** attempt;
			console.warn(`  ${response.status} on ${label}; retrying in ${wait}ms`);
			await sleep(wait);
			continue;
		}
		throw new Error(`${label}: HTTP ${response.status} ${response.statusText}`);
	}
	throw new Error(`${label}: retries exhausted`);
}

function decodeEntities(value: string) {
	const named: Record<string, string> = {
		amp: '&',
		lt: '<',
		gt: '>',
		quot: '"',
		apos: "'",
		nbsp: ' ',
		ndash: '–',
		mdash: '—',
		hellip: '…',
		rsquo: '’',
		lsquo: '‘',
		rdquo: '”',
		ldquo: '“'
	};
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
			String.fromCodePoint(Number.parseInt(hex, 16))
		)
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
		.replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function stripHtml(html: string | undefined) {
	if (!html) return '';
	return decodeEntities(
		html
			.replace(/<\s*br\s*\/?\s*>/gi, '\n')
			.replace(/<\s*li[^>]*>/gi, '• ')
			.replace(/<\s*\/\s*(p|div|li|ul|ol|h[1-6]|tr)\s*>/gi, '\n')
			.replace(/<[^>]*>/g, '')
	)
		.replace(/\r/g, '')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function englishTranslation(exercise: WgerExercise) {
	const translations = exercise.translations ?? [];
	const english = translations.filter(
		(t) => t.language === LANGUAGE_EN && (t.name ?? '').trim().length > 0
	);
	if (english.length === 0) return null;
	english.sort((a, b) => stripHtml(b.description).length - stripHtml(a.description).length);
	return english[0];
}

async function main() {
	console.log('Fetching wger categories, equipment and muscles...');
	const [categoryPage, equipmentPage, musclePage] = await Promise.all([
		fetchJson<{ results: { id: number; name: string }[] }>(
			`${API}/exercisecategory/?limit=100`,
			'categories'
		),
		fetchJson<{ results: { id: number; name: string }[] }>(
			`${API}/equipment/?limit=100`,
			'equipment'
		),
		fetchJson<{ results: WgerMuscle[] }>(`${API}/muscle/?limit=100`, 'muscles')
	]);

	const categories = categoryPage.results;
	const equipment = equipmentPage.results;
	const muscles = musclePage.results;

	const categoryIds = new Set(categories.map((c) => c.id));
	const equipmentIds = new Set(equipment.map((e) => e.id));
	const muscleIds = new Set(muscles.map((m) => m.id));

	console.log(
		`  ${categories.length} categories, ${equipment.length} equipment, ${muscles.length} muscles`
	);

	const exercises: WgerExercise[] = [];
	let offset = 0;
	let total = Infinity;
	while (offset < total) {
		const page = await fetchJson<{ count: number; next: string | null; results: WgerExercise[] }>(
			`${API}/exerciseinfo/?language=${LANGUAGE_EN}&limit=${PAGE_LIMIT}&offset=${offset}`,
			`exerciseinfo-${offset}`
		);
		total = page.count;
		exercises.push(...page.results);
		offset += page.results.length;
		console.log(`  fetched ${Math.min(offset, total)}/${total} exercises`);
		if (page.results.length === 0 || !page.next) break;
		await sleep(THROTTLE_MS);
	}

	const rows: Record<string, unknown>[] = [];
	const equipmentRows: Record<string, unknown>[] = [];
	const muscleRows: Record<string, unknown>[] = [];
	let skipped = 0;

	for (const exercise of exercises) {
		const translation = englishTranslation(exercise);
		if (!translation || !exercise.uuid) {
			skipped += 1;
			continue;
		}
		const categoryId =
			exercise.category?.id && categoryIds.has(exercise.category.id)
				? exercise.category.id
				: null;
		rows.push({
			id: exercise.id,
			uuid: exercise.uuid,
			name: translation.name!.trim(),
			description: stripHtml(translation.description),
			category_id: categoryId,
			license: exercise.license?.short_name ?? exercise.license?.full_name ?? null,
			license_author: exercise.license_author ?? translation.license_author ?? null,
			license_url: exercise.license?.url ?? null,
			wger_updated_at: exercise.last_update ?? exercise.last_update_global ?? null
		});

		const primaryIds = new Set<number>();
		for (const muscle of exercise.muscles ?? []) {
			if (!muscleIds.has(muscle.id) || primaryIds.has(muscle.id)) continue;
			primaryIds.add(muscle.id);
			muscleRows.push({ exercise_id: exercise.id, muscle_id: muscle.id, is_primary: true });
		}
		for (const muscle of exercise.muscles_secondary ?? []) {
			if (!muscleIds.has(muscle.id) || primaryIds.has(muscle.id)) continue;
			primaryIds.add(muscle.id);
			muscleRows.push({ exercise_id: exercise.id, muscle_id: muscle.id, is_primary: false });
		}
		const seenEquipment = new Set<number>();
		for (const item of exercise.equipment ?? []) {
			if (equipmentIds.has(item.id) && !seenEquipment.has(item.id)) {
				seenEquipment.add(item.id);
				equipmentRows.push({ exercise_id: exercise.id, equipment_id: item.id });
			}
		}
	}

	console.log(
		`Prepared ${rows.length} exercises (${skipped} skipped without English text), ${equipmentRows.length} equipment links, ${muscleRows.length} muscle links`
	);

	async function upsert(table: string, data: Record<string, unknown>[], conflict: string) {
		for (let index = 0; index < data.length; index += 200) {
			const chunk = data.slice(index, index + 200);
			const { error } = await supabase.from(table).upsert(chunk, { onConflict: conflict });
			if (error) throw new Error(`${table} upsert failed: ${error.message}`);
		}
	}

	console.log('Upserting reference tables...');
	await upsert('wger_categories', categories, 'id');
	await upsert('wger_equipment', equipment, 'id');
	await upsert(
		'wger_muscles',
		muscles.map((muscle) => ({
			id: muscle.id,
			name: muscle.name,
			name_en: muscle.name_en || null,
			is_front: muscle.is_front ?? true,
			image_url_main: muscle.image_url_main ?? null,
			image_url_secondary: muscle.image_url_secondary ?? null
		})),
		'id'
	);
	await upsert('wger_exercises', rows, 'id');

	console.log('Rebuilding exercise links...');
	const { error: equipmentDeleteError } = await supabase
		.from('wger_exercise_equipment')
		.delete()
		.neq('exercise_id', -1);
	if (equipmentDeleteError) throw new Error(equipmentDeleteError.message);
	const { error: muscleDeleteError } = await supabase
		.from('wger_exercise_muscles')
		.delete()
		.neq('exercise_id', -1);
	if (muscleDeleteError) throw new Error(muscleDeleteError.message);

	await upsert('wger_exercise_equipment', equipmentRows, 'exercise_id,equipment_id');
	await upsert('wger_exercise_muscles', muscleRows, 'exercise_id,muscle_id');

	console.log('Removing exercises no longer published by wger...');
	const keepIds = new Set(rows.map((row) => row.id as number));
	const { data: existing, error: existingError } = await supabase.from('wger_exercises').select('id');
	if (existingError) throw new Error(existingError.message);
	const staleIds = (existing ?? []).map((row) => row.id as number).filter((id) => !keepIds.has(id));
	for (let index = 0; index < staleIds.length; index += 200) {
		const chunk = staleIds.slice(index, index + 200);
		const { error } = await supabase.from('wger_exercises').delete().in('id', chunk);
		if (error) throw new Error(`stale exercise cleanup failed: ${error.message}`);
	}

	const { count, error: countError } = await supabase
		.from('wger_exercises')
		.select('id', { count: 'exact', head: true });
	if (countError) throw new Error(countError.message);
	console.log(`Done. wger_exercises now contains ${count} rows.`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
