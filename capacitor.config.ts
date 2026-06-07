import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Native shell config. Web assets come from `npm run build:capacitor` (adapter-static → build/).
 *
 * Live reload during native dev (optional):
 *   CAPACITOR_DEV_SERVER_URL=http://YOUR_LAN_IP:5173 npm run cap:sync
 */
const devServerUrl = process.env.CAPACITOR_DEV_SERVER_URL;

const config: CapacitorConfig = {
	appId: 'com.lifttracker.app',
	appName: 'Lift Tracker',
	webDir: 'build',
	server: {
		androidScheme: 'https',
		...(devServerUrl ? { url: devServerUrl, cleartext: devServerUrl.startsWith('http://') } : {}),
	},
	plugins: {
		SplashScreen: {
			launchAutoHide: true,
			backgroundColor: '#0a0a0a',
			androidScaleType: 'CENTER_CROP',
			showSpinner: false,
		},
		StatusBar: {
			style: 'DARK',
			backgroundColor: '#0a0a0a',
		},
	},
};

export default config;