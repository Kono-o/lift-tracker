import { Capacitor } from '@capacitor/core';
import { registerPlugin } from '@capacitor/core';
import { APP_VERSION } from './version';
import { isNativeApp } from './native';

export interface GitHubReleaseAsset {
	name: string;
	browser_download_url: string;
	size: number;
	content_type: string;
}

export interface GitHubRelease {
	tag_name: string;
	name: string | null;
	body: string | null;
	assets: GitHubReleaseAsset[];
	prerelease: boolean;
	draft: boolean;
	published_at: string;
}

export interface UpdateInfo {
	version: string;
	notes: string;
	downloadUrl: string;      // browser_download_url (good for web <a> and UI)
	size: number;
	tag: string;
}

export interface UpdaterPlugin {
	installApk(options: { path: string }): Promise<void>;
	openInstallSettings(): Promise<void>;
	/**
	 * Download the update APK natively (more reliable than JS fetch for binaries on Android).
	 * Emits "downloadProgress" events with { progress: number } (0-100).
	 * Resolves with { path: string } (relative cache path) on success.
	 */
	downloadUpdate(options: { url: string; expectedSize?: number }): Promise<{ path: string }>;
	/**
	 * Returns whether the app currently has the "Install unknown apps" permission (Android 8+).
	 * On web / older Android this will typically return true (irrelevant).
	 */
	canInstallFromUnknownSources(): Promise<{ canInstall: boolean }>;

	// Capacitor plugin listener methods (available on the registered plugin at runtime)
	addListener(eventName: string, listenerFunc: (data?: any) => void): Promise<any>;
	removeListener(eventName: string, listenerFunc: (data?: any) => void): Promise<any>;
	removeAllListeners(eventName?: string): Promise<any>;
}

// Register only once to avoid "already registered" warnings during HMR / dev reloads.
let _updaterNative: UpdaterPlugin | null = null;

export const UpdaterNative: UpdaterPlugin = ((): UpdaterPlugin => {
	if (_updaterNative) return _updaterNative;

	if (typeof window !== 'undefined' && (window as any).__UPDATER_REGISTERED__) {
		// Fallback stub if somehow re-evaluated
		_updaterNative = {
			async installApk() { throw new Error('Updater plugin not available (web stub)'); },
			async openInstallSettings() {},
			async downloadUpdate() { throw new Error('Updater plugin not available (web stub)'); },
			async canInstallFromUnknownSources() { return { canInstall: true }; },
			async addListener() { return { remove: async () => {} }; },
			async removeListener() {},
			async removeAllListeners() {},
		};
		return _updaterNative;
	}

	try {
		_updaterNative = registerPlugin<UpdaterPlugin>('Updater');
		if (typeof window !== 'undefined') {
			(window as any).__UPDATER_REGISTERED__ = true;
		}
	} catch (e) {
		// In pure web / test environments the native plugin won't exist.
		_updaterNative = {
			async installApk() { throw new Error('Updater plugin is only available on Android'); },
			async openInstallSettings() {},
			async downloadUpdate() { throw new Error('Updater plugin is only available on Android'); },
			async canInstallFromUnknownSources() { return { canInstall: true }; },
			async addListener() { return { remove: async () => {} }; },
			async removeListener() {},
			async removeAllListeners() {},
		};
	}
	return _updaterNative;
})();

/** GitHub repo for release checks (public, no auth needed for basic rate limit). */
const GITHUB_OWNER = 'Kono-o';
const GITHUB_REPO = 'lift-tracker';
const RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

/** In-memory guard so the prompt only appears on fresh process start (not resume from background). */
let hasCheckedThisLaunch = false;
let dismissedVersionThisLaunch: string | null = null;

/** Persisted key for "what version did the user last run and acknowledge". */
const LAST_SEEN_VERSION_KEY = 'lift-tracker:last-seen-version';

function getStoredLastSeenVersion(): string {
	if (typeof localStorage === 'undefined') return '0.0.0';
	return localStorage.getItem(LAST_SEEN_VERSION_KEY) || '0.0.0';
}

export function setLastSeenVersion(v: string): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(LAST_SEEN_VERSION_KEY, v);
}

/** Simple semver compare. Returns true if a > b (both 'x.y.z' or 'vX.Y.Z'). */
export function isNewerVersion(a: string, b: string): boolean {
	const pa = a.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
	const pb = b.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const na = pa[i] ?? 0;
		const nb = pb[i] ?? 0;
		if (na > nb) return true;
		if (na < nb) return false;
	}
	return false;
}

/** Fetch latest GitHub release (non-prerelease). */
export async function fetchLatestRelease(): Promise<GitHubRelease | null> {
	try {
		const res = await fetch(RELEASE_API, {
			headers: {
				Accept: 'application/vnd.github+json',
				'User-Agent': `LiftTracker/${APP_VERSION} (Capacitor; https://github.com/Kono-o/lift-tracker)`,
				'X-GitHub-Api-Version': '2022-11-28',
			},
			cache: 'no-store',
		});
		if (!res.ok) {
			console.warn('[updater] GitHub release fetch failed with HTTP status:', res.status, 'for', RELEASE_API);
			// Try to read error body for more info (rate limit, etc.)
			try {
				const errBody = await res.text();
				console.warn('  response body:', errBody.slice(0, 200));
			} catch {}
			return null;
		}
		const data = (await res.json()) as GitHubRelease;
		if (data.draft || data.prerelease) return null;
		return data;
	} catch (e) {
		console.error('[updater] Failed to fetch release from GitHub:', e);
		if (e instanceof Error) {
			console.error('  name:', e.name);
			console.error('  message:', e.message);
			if (e.stack) console.error('  stack:', e.stack);
		}
		// On phone this is often transient (network not fully ready at startup) or GitHub being strict.
		// We now send a proper User-Agent on every call and the caller does a one-time retry.
		return null;
	}
}

/** Pick the APK asset from a release (prefers the lift-tracker-vX.Y.Z.apk name from our build script). */
function pickApkAsset(release: GitHubRelease): GitHubReleaseAsset | null {
	// Prefer exact build output name pattern
	const preferred = release.assets.find((a) => /lift-tracker-v.*\.apk$/i.test(a.name));
	if (preferred) return preferred;
	// Fallback: any .apk
	return release.assets.find((a) => a.name.toLowerCase().endsWith('.apk')) ?? null;
}

/** Convert a GitHub release into our UpdateInfo if it has a usable APK. */
export function releaseToUpdateInfo(release: GitHubRelease): UpdateInfo | null {
	const asset = pickApkAsset(release);
	if (!asset) return null;
	const version = release.tag_name.replace(/^v/i, '');
	return {
		version,
		notes: release.body ?? '',
		downloadUrl: asset.browser_download_url,
		size: asset.size,
		tag: release.tag_name,
	};
}

/**
 * Check for updates (only meaningful on native Android).
 * Returns UpdateInfo if a newer release with APK exists, otherwise null.
 * Safe to call multiple times; network is cheap.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
	if (!isNativeApp() || Capacitor.getPlatform() !== 'android') {
		return null;
	}

	// Simple one-retry to handle transient "Failed to fetch" at app startup
	// (network not quite ready, brief hiccup, etc.).
	let release = await fetchLatestRelease();
	if (!release) {
		await new Promise((r) => setTimeout(r, 1200));
		release = await fetchLatestRelease();
	}

	if (!release) return null;
	const info = releaseToUpdateInfo(release);
	if (!info) return null;
	if (isNewerVersion(info.version, APP_VERSION)) {
		return info;
	}
	return null;
}

/** Ask the native side to launch the system package installer for the downloaded APK. */
export async function promptInstallApk(relativeCachePath: string): Promise<void> {
	await UpdaterNative.installApk({ path: relativeCachePath });
}

/** Open the OS "install unknown apps" settings page for this package. */
export async function openInstallPermissionSettings(): Promise<void> {
	await UpdaterNative.openInstallSettings();
}

/**
 * High-level helper: should we show the update prompt on this launch?
 * Respects the in-memory "dismissed this launch" so X only hides until full restart.
 */
export async function shouldShowUpdatePrompt(): Promise<UpdateInfo | null> {
	if (hasCheckedThisLaunch) {
		return null;
	}
	hasCheckedThisLaunch = true;

	const info = await checkForUpdate();
	if (!info) return null;

	if (dismissedVersionThisLaunch && dismissedVersionThisLaunch === info.version) {
		return null;
	}
	return info;
}

export function dismissUpdateThisLaunch(version: string): void {
	dismissedVersionThisLaunch = version;
}

/** For post-update "what's new" detection. Call on startup; returns the release notes if we just upgraded. */
export async function checkForPostUpdateChangelog(): Promise<{ version: string; notes: string } | null> {
	if (!isNativeApp() || Capacitor.getPlatform() !== 'android') return null;

	const lastSeen = getStoredLastSeenVersion();
	const isFirstRun = lastSeen === '0.0.0' || !lastSeen;

	if (isFirstRun) {
		// Fresh install — record the version but don't show a "just updated" popup.
		setLastSeenVersion(APP_VERSION);
		return null;
	}

	if (!isNewerVersion(APP_VERSION, lastSeen)) {
		// Same or downgrade — just ensure lastSeen is current.
		if (APP_VERSION !== lastSeen) setLastSeenVersion(APP_VERSION);
		return null;
	}

	// We are newer than last seen — fetch the notes for the current version (via latest, which should be us)
	const release = await fetchLatestRelease();
	const info = release ? releaseToUpdateInfo(release) : null;

	// Record that user has now seen this version (even if we couldn't fetch notes)
	setLastSeenVersion(APP_VERSION);

	if (info && info.version === APP_VERSION.replace(/^v/i, '')) {
		return { version: info.version, notes: info.notes };
	}
	// Fallback: still tell them they updated, even without notes
	return { version: APP_VERSION.replace(/^v/i, ''), notes: '' };
}
