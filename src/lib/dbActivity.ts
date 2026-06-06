import { PUBLIC_SUPABASE_URL } from '$env/static/public';

type DbActivityListener = () => void;

export type DbActivitySnapshot = {
	lastPulseAt: number | null;
	lastRequest: string | null;
	totalPulses: number;
};

const listeners = new Set<DbActivityListener>();
const snapshotListeners = new Set<DbActivityListener>();

let snapshot: DbActivitySnapshot = {
	lastPulseAt: null,
	lastRequest: null,
	totalPulses: 0,
};

export function getDbActivitySnapshot(): DbActivitySnapshot {
	return { ...snapshot };
}

export function subscribeDbActivity(listener: DbActivityListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function subscribeDbActivitySnapshot(listener: DbActivityListener): () => void {
	snapshotListeners.add(listener);
	return () => snapshotListeners.delete(listener);
}

export function pulseDbActivity(requestLabel?: string): void {
	snapshot = {
		lastPulseAt: Date.now(),
		lastRequest: requestLabel ?? snapshot.lastRequest,
		totalPulses: snapshot.totalPulses + 1,
	};
	for (const listener of snapshotListeners) {
		listener();
	}
	for (const listener of listeners) {
		listener();
	}
}

function isTrackedRequest(input: RequestInfo | URL): boolean {
	try {
		const raw =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url;
		return raw.includes(PUBLIC_SUPABASE_URL) || raw.startsWith('/api/');
	} catch {
		return false;
	}
}

function labelForRequest(input: RequestInfo | URL): string {
	try {
		const raw =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (raw.startsWith('/api/')) {
			return raw.replace(/^\//, '');
		}
		const url = new URL(raw);
		const parts = url.pathname.split('/').filter(Boolean);
		const restIdx = parts.indexOf('v1');
		if (restIdx >= 0 && parts[restIdx + 1]) {
			const table = parts[restIdx + 1];
			const op = (parts[restIdx + 2] ?? '').split('?')[0];
			return op ? `${table} · ${op}` : table;
		}
		if (parts.includes('auth')) {
			return `auth · ${parts[parts.length - 1] || 'session'}`;
		}
		if (parts.includes('rpc')) {
			return `rpc · ${parts[parts.length - 1] || 'call'}`;
		}
		return parts.slice(-2).join(' · ') || 'supabase';
	} catch {
		return 'supabase';
	}
}

export function createDbTrackingFetch(baseFetch: typeof fetch = fetch): typeof fetch {
	return async (input, init) => {
		if (isTrackedRequest(input)) {
			pulseDbActivity(labelForRequest(input));
		}
		return baseFetch(input, init);
	};
}