declare const __APP_VERSION__: string;

/** App version injected at build time from package.json (matches release APK versionName). */
export const APP_VERSION: string = __APP_VERSION__ ?? '0.0.0';
