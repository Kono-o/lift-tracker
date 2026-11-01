/**
 * Transport selection for a weigh-in, and the only place the three of them meet.
 *
 * The sim wins when explicitly asked for (`?scalesim=1`) so the flow can be
 * rehearsed on a laptop; inside the app the native plugin is the only option,
 * because the Capacitor WebView has no Web Bluetooth; everywhere else it is the
 * browser's own API.
 */

import { BodyScaleClient } from "./client";
import { simTransport } from "./sim";
import type { ScaleTransport } from "./transport";
import { nativeTransport } from "./transport-native";
import { webTransport } from "./transport-web";

export function pickScaleTransport(): ScaleTransport {
	if (simTransport.isSupported()) return simTransport;
	if (nativeTransport.isSupported()) return nativeTransport;
	return webTransport;
}

export function createScaleClient(): BodyScaleClient {
	return new BodyScaleClient(pickScaleTransport());
}
