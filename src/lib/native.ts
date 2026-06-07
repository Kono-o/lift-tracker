import { Capacitor } from '@capacitor/core';

export const NATIVE_APP_ID = 'com.lifttracker.app';

export function isNativeApp(): boolean {
	return Capacitor.isNativePlatform();
}

/** OAuth redirect registered in Supabase for the native shell (custom URL scheme). */
export function getNativeOAuthRedirectUrl(): string {
	return `${NATIVE_APP_ID}://auth/callback`;
}

function inAppPathFromDeepLink(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol === `${NATIVE_APP_ID}:`) {
			const path = `/${parsed.host}${parsed.pathname}`.replace(/\/+/g, '/');
			return `${path}${parsed.search}${parsed.hash}`;
		}
		if (parsed.pathname.includes('/auth/callback')) {
			return `${parsed.pathname}${parsed.search}${parsed.hash}`;
		}
	} catch {
		/* ignore malformed URLs */
	}
	return null;
}

let nativeShellReady = false;

/** Status bar, keyboard, and OAuth deep-link handling in the native WebView. */
export async function initNativeShell(): Promise<void> {
	if (!isNativeApp() || nativeShellReady) return;
	nativeShellReady = true;

	const [{ App }, { StatusBar, Style }, { Keyboard }] = await Promise.all([
		import('@capacitor/app'),
		import('@capacitor/status-bar'),
		import('@capacitor/keyboard'),
	]);

	try {
		await StatusBar.setStyle({ style: Style.Dark });
		await StatusBar.setBackgroundColor({ color: '#0a0a0a' });
	} catch {
		/* Status bar APIs vary by platform/version */
	}

	try {
		Keyboard.setAccessoryBarVisible({ isVisible: false });
	} catch {
		/* iOS-only */
	}

	App.addListener('appUrlOpen', (event) => {
		const target = inAppPathFromDeepLink(event.url);
		if (!target || typeof window === 'undefined') return;
		window.location.href = target;
	});
}