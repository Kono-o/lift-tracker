import {
	PUBLIC_SUPABASE_ANON_KEY,
	PUBLIC_SUPABASE_URL,
} from '$env/static/public';
import { supabase } from './db';

export type SupabaseProjectInfo = {
	host: string;
	ref: string;
	apiUrl: string;
	restPath: string;
	authPath: string;
	storageHost: string;
};

export type SupabaseHealthProbe = {
	ok: boolean;
	latencyMs: number | null;
	server: string | null;
	projectRef: string | null;
	region: string | null;
	error: string | null;
};

export type UserDataUsage = {
	templates: number;
	exercises: number;
	schedule: number;
	workout_history: number;
	tracked_stats?: number;
	stat_logs?: number;
	estimated_bytes: number;
	exact: boolean;
};

export function getSupabaseProjectInfo(): SupabaseProjectInfo {
	try {
		const url = new URL(PUBLIC_SUPABASE_URL);
		const ref = url.hostname.split('.')[0] ?? url.hostname;
		return {
			host: url.hostname,
			ref,
			apiUrl: PUBLIC_SUPABASE_URL,
			restPath: '/rest/v1',
			authPath: '/auth/v1',
			storageHost: `${ref}.storage.supabase.co`,
		};
	} catch {
		return {
			host: 'unknown',
			ref: 'unknown',
			apiUrl: PUBLIC_SUPABASE_URL,
			restPath: '/rest/v1',
			authPath: '/auth/v1',
			storageHost: 'unknown',
		};
	}
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
	return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatSupabaseLatencyMs(latencyMs: number): string {
	const capped = Math.min(999, Math.max(0, Math.round(latencyMs)));
	return `${String(capped).padStart(3, '0')} ms`;
}

export function formatSessionExpiry(expiresAt: number | undefined | null): string {
	if (!expiresAt) return '—';
	const msLeft = expiresAt * 1000 - Date.now();
	if (msLeft <= 0) return 'Expired';
	if (msLeft < 60_000) return `${Math.max(1, Math.round(msLeft / 1000))}s left`;
	if (msLeft < 3_600_000) return `${Math.round(msLeft / 60_000)}m left`;
	return `${Math.round(msLeft / 3_600_000)}h left`;
}

export async function probeSupabaseHealth(): Promise<SupabaseHealthProbe> {
	const start = performance.now();
	try {
		const res = await fetch(`${PUBLIC_SUPABASE_URL}/rest/v1/`, {
			method: 'HEAD',
			headers: {
				apikey: PUBLIC_SUPABASE_ANON_KEY,
				Authorization: `Bearer ${PUBLIC_SUPABASE_ANON_KEY}`,
			},
		});
		const latencyMs = Math.round(performance.now() - start);
		const header = (name: string) => res.headers.get(name);
		const cfRay = header('cf-ray');
		const regionFromRay = cfRay?.includes('-') ? (cfRay.split('-').pop() ?? null) : null;
		return {
			ok: res.ok || res.status === 401 || res.status === 404,
			latencyMs,
			server: header('server') ?? header('x-served-by'),
			projectRef: header('sb-project-ref'),
			region: header('x-sb-edge-region') ?? regionFromRay ?? null,
			error: null,
		};
	} catch (e) {
		// 401s are common before login / when using only anon key with strict RLS.
		// We still consider the endpoint "reachable".
		const msg = e instanceof Error ? e.message : 'Connection failed';
		return {
			ok: true,
			latencyMs: null,
			server: null,
			projectRef: null,
			region: null,
			error: msg.includes('401') ? null : msg,
		};
	}
}

function estimateBytesFromCounts(counts: Omit<UserDataUsage, 'estimated_bytes' | 'exact'>): number {
	return (
		counts.templates * 250 +
		counts.exercises * 400 +
		counts.schedule * 120 +
		counts.workout_history * 3500 +
		(counts.tracked_stats ?? 0) * 200 +
		(counts.stat_logs ?? 0) * 80
	);
}

async function countTable(
	table: 'templates' | 'exercises' | 'schedule' | 'workout_history' | 'tracked_stats' | 'stat_logs',
): Promise<number> {
	const { count, error } = await supabase
		.from(table)
		.select('*', { count: 'exact', head: true });
	if (error) throw error;
	return count ?? 0;
}

export async function fetchUserDataUsage(): Promise<UserDataUsage | null> {
	const { data: { user } } = await supabase.auth.getUser();
	if (!user) return null;

	const { data, error } = await supabase.rpc('get_own_data_usage');
	if (!error && data && typeof data === 'object') {
		const row = data as Record<string, unknown>;
		return {
			templates: Number(row.templates ?? 0),
			exercises: Number(row.exercises ?? 0),
			schedule: Number(row.schedule ?? 0),
			workout_history: Number(row.workout_history ?? 0),
			tracked_stats: Number(row.tracked_stats ?? 0),
			stat_logs: Number(row.stat_logs ?? 0),
			estimated_bytes: Number(row.estimated_bytes ?? 0),
			exact: true,
		};
	}

	try {
		const [templates, exercises, schedule, workout_history, tracked_stats, stat_logs] = await Promise.all([
			countTable('templates'),
			countTable('exercises'),
			countTable('schedule'),
			countTable('workout_history'),
			countTable('tracked_stats'),
			countTable('stat_logs'),
		]);
		const counts = { templates, exercises, schedule, workout_history, tracked_stats, stat_logs };
		return {
			...counts,
			estimated_bytes: estimateBytesFromCounts(counts),
			exact: false,
		};
	} catch {
		return null;
	}
}

export type SupabasePanelSnapshot = {
	project: SupabaseProjectInfo;
	health: SupabaseHealthProbe;
	sessionOk: boolean;
	sessionError: string | null;
	expiresAt: number | null;
	usage: UserDataUsage | null;
};

export type SupabaseHealthSnapshot = Pick<
	SupabasePanelSnapshot,
	'health' | 'sessionOk' | 'sessionError' | 'expiresAt'
>;

export const SUPABASE_HEALTH_POLL_MS = 5000;

export async function loadSupabaseHealthSnapshot(): Promise<SupabaseHealthSnapshot> {
	const [health, sessionResult] = await Promise.all([
		probeSupabaseHealth(),
		supabase.auth.getSession(),
	]);

	return {
		health,
		sessionOk: !sessionResult.error,
		sessionError: sessionResult.error?.message ?? null,
		expiresAt: sessionResult.data.session?.expires_at ?? null,
	};
}

export async function loadSupabasePanelSnapshot(): Promise<SupabasePanelSnapshot> {
	const [project, healthSnapshot, usage] = await Promise.all([
		Promise.resolve(getSupabaseProjectInfo()),
		loadSupabaseHealthSnapshot(),
		fetchUserDataUsage(),
	]);

	return {
		project,
		...healthSnapshot,
		usage,
	};
}