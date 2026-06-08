import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
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
	apiAssetUrl?: string;     // https://api.github.com/.../assets/XXX  (reliable for native fetch)
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
		apiAssetUrl: asset.url,   // api endpoint for reliable download
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

/**
 * Download the APK for the given UpdateInfo and return the relative cache path we wrote it to.
 * Updates the provided onProgress (0..100).
 * Throws on failure.
 */
export async function downloadApkToCache(
	info: UpdateInfo,
	onProgress: (pct: number) => void
): Promise<string> {
	if (!isNativeApp()) {
		// On web / non-native we cannot directly fetch GitHub release assets
		// due to CORS restrictions on direct download URLs.
		// Always open the human-friendly releases page instead.
		const releasesPage = info.downloadUrl.includes('/download/')
			? 'https://github.com/Kono-o/lift-tracker/releases'
			: info.downloadUrl;

		if (typeof window !== 'undefined') {
			window.open(releasesPage, '_blank');
		}
		throw new Error('Direct APK download only works inside the Android app. Opened the GitHub releases page instead.');
	}

	// Always use the browser_download_url for the actual binary fetch.
	// The apiAssetUrl (with octet-stream) can sometimes return small error bodies
	// or hit stricter limits; the direct download URL + good UA is more reliable
	// for getting the full APK binary in practice.
	const fetchUrl = info.downloadUrl;
	let res: Response | null = null;
	let lastError: any = null;

	// Retry up to 3 times with backoff for transient network or GitHub hiccups
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			// GitHub is strict on User-Agent for asset downloads. Use a realistic one
			// plus Accept to encourage binary response.
			// Use a browser-like User-Agent for direct asset downloads.
			// GitHub serves the actual binary file to browser UAs; API-like UAs can get HTML or limited responses.
			res = await fetch(fetchUrl, {
				cache: 'no-store',
				headers: {
					'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
					'Accept': 'application/octet-stream, */*',
				},
				redirect: 'follow',
			});

			if (!res.ok || !res.body) {
				lastError = new Error(`Download failed (${res.status})`);
				if (attempt < 3) {
					await new Promise(r => setTimeout(r, 1000 * attempt));
					continue;
				}
				throw lastError;
			}

			// Detect if we got an error page or non-binary instead of the APK (common "Failed to fetch" root cause)
			const contentType = res.headers.get('content-type') || '';
			if (contentType.includes('text/') || contentType.includes('html') || contentType.includes('json')) {
				const text = await res.text();
				lastError = new Error(`GitHub returned non-binary content (${contentType}): ${text.substring(0, 400)}`);
				if (attempt < 3) {
					await new Promise(r => setTimeout(r, 1000 * attempt));
					continue;
				}
				throw lastError;
			}

			// If content length is very small, likely error
			const cl = res.headers.get('content-length');
			if (cl && parseInt(cl) < 10000) {
				const text = await res.text();
				lastError = new Error(`GitHub returned suspiciously small response (${cl} bytes): ${text.substring(0, 400)}`);
				if (attempt < 3) {
					await new Promise(r => setTimeout(r, 1000 * attempt));
					continue;
				}
				throw lastError;
			}

			// Good response — break and use res below
			break;
		} catch (e) {
			lastError = e;
			if (attempt < 3) {
				await new Promise(r => setTimeout(r, 1000 * attempt));
				continue;
			}
			throw lastError;
		}
	}

	if (!res) {
		throw lastError || new Error('Download failed after retries');
	}

	const contentLength = Number(res.headers.get('Content-Length') || info.size || 0);
	let received = 0;
	const chunks: BlobPart[] = [];
	const reader = res.body.getReader();

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			received += value.length;
			if (contentLength > 0) {
				onProgress(Math.min(99, Math.round((received / contentLength) * 100)));
			}
		}
	}
	onProgress(100);

	// Convert chunks to single Uint8Array (more reliable than Blob + FileReader for binary in WebView)
	let totalLength = 0;
	for (const chunk of chunks) totalLength += chunk.length;
	const allBytes = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		allBytes.set(chunk, offset);
		offset += chunk.length;
	}

	// Pure JS base64 (avoids FileReader issues on large binaries in Capacitor WebView)
	const base64 = btoa(
		allBytes.reduce((data, byte) => data + String.fromCharCode(byte), '')
	);

	const relativePath = 'updates/lift-tracker-update.apk';
	await Filesystem.writeFile({
		path: relativePath,
		data: base64,
		directory: Directory.Cache,
		recursive: true,
	});

	// Verify size to catch incomplete/corrupted downloads (common cause of "parsing file" errors on Android installer)
	if (info.size > 0) {
		const stat = await Filesystem.stat({
			path: relativePath,
			directory: Directory.Cache,
		});
		if (stat.size !== info.size) {
			// Clean up bad file
			try {
				await Filesystem.deleteFile({ path: relativePath, directory: Directory.Cache });
			} catch {}
			throw new Error(`Download corrupted (size mismatch: got ${stat.size} bytes, expected ${info.size}). The APK file is invalid and cannot be installed. Please try again with a stable connection.`);
		}
	}

	// Optional extra validation: check ZIP magic bytes (APK is a ZIP file). First 2 bytes should be "PK"
	try {
		const header = await Filesystem.readFile({
			path: relativePath,
			directory: Directory.Cache,
			encoding: 'base64',
		});
		// Decode first few bytes
		const firstBytes = atob(header.data).slice(0, 4);
		if (!firstBytes.startsWith('PK')) {
			try {
				await Filesystem.deleteFile({ path: relativePath, directory: Directory.Cache });
			} catch {}
			throw new Error('Downloaded file is not a valid APK (wrong format). This usually means a network error or GitHub serving an error page. Please try again.');
		}
	} catch (e) {
		// If read fails, the size check already passed, so let it proceed (or surface)
		console.warn('[updater] Could not validate APK magic bytes, proceeding anyway:', e);
	}

	// Best effort cleanup of old chunks isn't needed; we overwrite.
	return relativePath;
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
