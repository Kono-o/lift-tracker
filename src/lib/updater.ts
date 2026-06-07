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
	downloadUrl: string;
	size: number;
	tag: string;
}

export interface UpdaterPlugin {
	installApk(options: { path: string }): Promise<void>;
	openInstallSettings(): Promise<void>;
}

export const UpdaterNative = registerPlugin<UpdaterPlugin>('Updater');

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
			headers: { Accept: 'application/vnd.github+json' },
			cache: 'no-store',
		});
		if (!res.ok) {
			console.warn('[updater] GitHub release fetch failed:', res.status);
			return null;
		}
		const data = (await res.json()) as GitHubRelease;
		if (data.draft || data.prerelease) return null;
		return data;
	} catch (e) {
		console.warn('[updater] Failed to fetch release:', e);
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
	const release = await fetchLatestRelease();
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
	const res = await fetch(info.downloadUrl, { cache: 'no-store' });
	if (!res.ok || !res.body) {
		throw new Error(`Download failed (${res.status})`);
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

	const blob = new Blob(chunks);

	// Convert to base64 for Capacitor Filesystem
	const base64 = await new Promise<string>((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => {
			const result = fr.result as string;
			// Strip the data:...;base64, prefix
			resolve(result.split(',')[1] ?? '');
		};
		fr.onerror = reject;
		fr.readAsDataURL(blob);
	});

	const relativePath = 'updates/lift-tracker-update.apk';
	await Filesystem.writeFile({
		path: relativePath,
		data: base64,
		directory: Directory.Cache,
		recursive: true,
	});

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
