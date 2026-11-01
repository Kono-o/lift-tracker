import assert from 'node:assert/strict';
import { createServer } from 'vite';

const vite = await createServer({
	configFile: false,
	root: process.cwd(),
	appType: 'custom',
	logLevel: 'silent',
	optimizeDeps: { noDiscovery: true, include: [] },
	server: { middlewareMode: true },
});

let checks = 0;
function check(name, run) {
	try {
		run();
		checks += 1;
		console.log(`ok ${checks} - ${name}`);
	} catch (error) {
		console.error(`not ok - ${name}`);
		throw error;
	}
}

async function checkAsync(name, run) {
	try {
		await run();
		checks += 1;
		console.log(`ok ${checks} - ${name}`);
	} catch (error) {
		console.error(`not ok - ${name}`);
		throw error;
	}
}

function frame(weightKg, status = 0, noise = 0x3c, corrupt = false) {
	const bytes = new Uint8Array(11);
	const rawWeight = Math.round(weightKg * 100);
	bytes[0] = 0xcf;
	bytes[1] = noise;
	bytes[2] = 0xc0;
	bytes[3] = rawWeight & 0xff;
	bytes[4] = (rawWeight >> 8) & 0xff;
	bytes[5] = 0xf4;
	bytes[6] = 0x01;
	bytes[7] = 0xba;
	bytes[8] = 0xb5;
	bytes[9] = status;
	for (let i = 0; i < 10; i += 1) bytes[10] ^= bytes[i];
	if (corrupt) bytes[10] ^= 0x55;
	return bytes;
}

function fakeConnection({ label = 'test scale', battery = null, readBattery = null, onDisconnect = () => {} } = {}) {
	return {
		label,
		disconnect: async () => onDisconnect(),
		readBattery: async () => readBattery ? readBattery() : battery,
	};
}

class FakeTransport {
	kind = 'sim';
	connectCalls = 0;
	connectImpl;
	constructor(connectImpl) {
		this.connectImpl = connectImpl;
	}
	isSupported() { return true; }
	unsupportedReason() { return null; }
	async connect(handlers) {
		this.connectCalls += 1;
		return this.connectImpl(handlers, this.connectCalls);
	}
}

let server;
try {
	const protocol = await vite.ssrLoadModule('/src/lib/scale/protocol.ts');
	const { ScaleSession, WEIGHT_LOCK_FRAMES } = await vite.ssrLoadModule('/src/lib/scale/session.ts');
	const { BodyScaleClient } = await vite.ssrLoadModule('/src/lib/scale/client.ts');
	const { WebBluetoothTransport } = await vite.ssrLoadModule('/src/lib/scale/transport-web.ts');
	const { toBodyReading } = await vite.ssrLoadModule('/src/lib/bodySanitize.ts');
	const { deriveBodyReading, metricValueOf } = await vite.ssrLoadModule('/src/lib/bodyHistory.ts');

	check('captured protocol frames pass the decoder regression checks', () => {
		assert.deepEqual(protocol.cultSelfTest(), []);
	});

	check('CF body bytes that resemble heart rate and impedance are ignored', () => {
		const decoded = protocol.parseScaleFrame(frame(72.34, 0, 0x44));
		assert.equal(decoded.weightKg, 72.34);
		assert.equal(decoded.phase, 'body');
		assert.equal(decoded.heartRate, null);
		assert.equal(decoded.impedanceRaw, null);
	});

	check('only a verified zero-status frame can be stable; Pro handle frames stay transitional', () => {
		assert.equal(protocol.parseScaleFrame(frame(72.34, 0x09)), null);
		assert.equal(protocol.parseScaleFrame(frame(72.34, 0x05)).phase, 'weigh');
		assert.equal(protocol.parseScaleFrame(frame(72.34, 0x08)).phase, 'weigh');
		assert.equal(protocol.parseScaleFrame(frame(72.34, 0x01)).phase, 'weigh');
		assert.equal(protocol.parseScaleFrame(frame(72.34, 0x00)).phase, 'body');
		const session = new ScaleSession();
		for (let i = 0; i < 4; i += 1) session.handle(frame(72.34, i % 2 === 0 ? 0x05 : 0x08));
		assert.equal(session.completed, false);
		assert.equal(session.weightLocked, false);
		for (let i = 0; i < 3; i += 1) session.handle(frame(72.34, 0x00));
		assert.equal(session.completed, true);
	});

	check('settling frames cannot lock; stable frames must match three times', () => {
		const session = new ScaleSession();
		for (let i = 0; i < 5; i += 1) session.handle(frame(80, 1));
		assert.equal(session.weightLocked, false);
		assert.equal(session.handle(frame(80, 0)).some((event) => event.kind === 'complete'), false);
		assert.equal(session.handle(frame(80, 0)).some((event) => event.kind === 'complete'), false);
		const final = session.handle(frame(80, 0, 0xf4));
		assert.equal(final.filter((event) => event.kind === 'locked').length, 1);
		assert.deepEqual(final.find((event) => event.kind === 'complete').reading, {
			weightKg: 80,
			heartRate: null,
			impedanceRaw: null,
		});
		assert.equal(session.handle(frame(80, 0)).length, 0);
		assert.equal(WEIGHT_LOCK_FRAMES, 3);
	});

	check('weight changes, settling transitions, corruption, and out-of-range values reset the candidate', () => {
		const session = new ScaleSession();
		session.handle(frame(75, 0));
		session.handle(frame(75, 0));
		session.handle(frame(75, 1));
		session.handle(frame(75, 0));
		session.handle(frame(75, 0));
		session.handle(frame(600, 0));
		session.handle(frame(75, 0));
		session.handle(frame(75, 0, 0x20, true));
		session.handle(frame(75, 0));
		session.handle(frame(75, 0));
		assert.equal(session.weightLocked, false);
		assert.equal(session.handle(frame(75, 0)).some((event) => event.kind === 'complete'), true);
	});

	check('a corrupted frame cannot create a reading', () => {
		const session = new ScaleSession();
		assert.deepEqual(session.handle(frame(75, 0, 0x20, true)), []);
		assert.equal(session.completed, false);
	});

	check('old scale rows cannot expose undocumented bytes as heart rate or impedance', () => {
		const oldRow = toBodyReading({
			id: 'reading-1',
			user_id: 'user-1',
			measured_at: '2026-11-01T12:00:00.000Z',
			weight_kg: 75,
			heart_rate: 60,
			impedance_raw: 14990,
			source: 'scale',
			device_label: 'Cult Smart Scale',
			profile_snapshot: { sex: 'male', date_of_birth: '1990-01-01', height_cm: 180 },
		});
		assert.equal(oldRow.heart_rate, null);
		assert.equal(oldRow.impedance_raw, null);
		const derived = deriveBodyReading({ ...oldRow, heart_rate: 60, impedance_raw: 14990 });
		assert.equal(derived.metrics.smmKg, null);
		assert.equal(metricValueOf(derived, 'heart_rate'), null);
		assert.equal(metricValueOf(derived, 'impedance_ohms'), null);
	});

	await checkAsync('Web Bluetooth connect, notification, battery, and close lifecycle work', async () => {
		const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
		const listeners = new Map();
		const deviceListeners = new Map();
		let starts = 0;
		let stops = 0;
		let batteryReads = 0;
		let disconnected = false;
		const characteristic = {
			addEventListener: (name, fn) => listeners.set(name, fn),
			removeEventListener: (name) => listeners.delete(name),
			startNotifications: async () => { starts += 1; return characteristic; },
			stopNotifications: async () => { stops += 1; return characteristic; },
			readValue: async () => { batteryReads += 1; return new DataView(new Uint8Array([84]).buffer); },
		};
		const device = {
			name: 'Cult CS-BF01',
			addEventListener: (name, fn) => deviceListeners.set(name, fn),
			removeEventListener: (name) => deviceListeners.delete(name),
			gatt: {
				connected: false,
				connect: async function () { this.connected = true; return this; },
				disconnect: function () { this.connected = false; disconnected = true; },
				getPrimaryService: async () => ({ getCharacteristic: async () => characteristic }),
			},
		};
		let frameCount = 0;
		try {
			Object.defineProperty(globalThis, 'navigator', {
				configurable: true,
				value: { bluetooth: { requestDevice: async () => device } },
			});
			const transport = new WebBluetoothTransport();
			const connection = await transport.connect({
				onFrame: () => { frameCount += 1; },
				onDisconnected: () => {},
			});
			assert.equal(connection.label, 'Cult CS-BF01');
			assert.equal(starts, 1);
			listeners.get('characteristicvaluechanged')({ target: { value: new DataView(frame(72).buffer) } });
			assert.equal(frameCount, 1);
			assert.equal(await connection.readBattery(), 84);
			assert.equal(batteryReads, 1);
			await connection.disconnect();
			assert.equal(stops, 1);
			assert.equal(disconnected, true);
			assert.equal(listeners.has('characteristicvaluechanged'), false);
			assert.equal(deviceListeners.has('gattserverdisconnected'), false);
		} finally {
			if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
			else delete globalThis.navigator;
		}
	});

	await checkAsync('Web Bluetooth partial connection failure removes listeners and disconnects', async () => {
		const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
		let disconnected = false;
		let removeCount = 0;
		const device = {
			name: 'Cult CS-BF01',
			addEventListener: () => {},
			removeEventListener: () => { removeCount += 1; },
			gatt: {
				connected: false,
				connect: async function () { this.connected = true; return this; },
				disconnect: function () { this.connected = false; disconnected = true; },
				getPrimaryService: async () => { throw new Error('service unavailable'); },
			},
		};
		try {
			Object.defineProperty(globalThis, 'navigator', {
				configurable: true,
				value: { bluetooth: { requestDevice: async () => device } },
			});
			await assert.rejects(
				new WebBluetoothTransport().connect({ onFrame: () => {}, onDisconnected: () => {} }),
				/service unavailable/,
			);
			assert.equal(disconnected, true);
			assert.equal(removeCount, 1);
		} finally {
			if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
			else delete globalThis.navigator;
		}
	});

	await checkAsync('frames delivered during connect are buffered, saved once, and disconnected', async () => {
		let disconnects = 0;
		let batteryReads = 0;
		const transport = new FakeTransport(async (handlers) => {
			handlers.onFrame(frame(74.25, 0));
			handlers.onFrame(frame(74.25, 0, 0x21));
			handlers.onFrame(frame(74.25, 0, 0xf4));
			return fakeConnection({
				onDisconnect: () => { disconnects += 1; },
				readBattery: () => { batteryReads += 1; return 84; },
			});
		});
		const client = new BodyScaleClient(transport);
		const readings = [];
		client.on('complete', (reading) => readings.push(reading));
		await client.start();
		assert.equal(client.state, 'complete');
		assert.equal(readings.length, 1);
		assert.equal(readings[0].weightKg, 74.25);
		assert.equal(readings[0].heartRate, null);
		assert.equal(readings[0].impedanceRaw, null);
		assert.equal(disconnects, 1);
		assert.equal(batteryReads, 0);
		client.dispose();
	});

	await checkAsync('a second start cannot open a second device picker', async () => {
		let finish;
		const transport = new FakeTransport(() => new Promise((resolve) => { finish = resolve; }));
		const client = new BodyScaleClient(transport);
		const first = client.start();
		await client.start();
		assert.equal(transport.connectCalls, 1);
		client.stop();
		let disconnects = 0;
		finish(fakeConnection({ onDisconnect: () => { disconnects += 1; } }));
		await first;
		assert.equal(disconnects, 1);
		assert.equal(client.state, 'idle');
		client.dispose();
	});

	await checkAsync('a chooser cancel returns to idle without showing an error', async () => {
		const transport = new FakeTransport(async () => { throw new Error('User cancelled the chooser'); });
		const client = new BodyScaleClient(transport);
		let errors = 0;
		client.on('error', () => { errors += 1; });
		await client.start();
		assert.equal(client.state, 'idle');
		assert.equal(errors, 0);
		client.dispose();
	});

	await checkAsync('disconnect before stable weight errors without saving a partial value', async () => {
		let disconnects = 0;
		const transport = new FakeTransport(async (handlers) => {
			handlers.onFrame(frame(75, 0));
			handlers.onDisconnected();
			return fakeConnection({ onDisconnect: () => { disconnects += 1; } });
		});
		const client = new BodyScaleClient(transport);
		let readings = 0;
		let message = '';
		client.on('complete', () => { readings += 1; });
		client.on('error', (error) => { message = error.message; });
		await client.start();
		assert.equal(client.state, 'error');
		assert.equal(readings, 0);
		assert.match(message, /before a stable weight/);
		assert.equal(disconnects, 1);
		client.dispose();
	});

	await checkAsync('no-reading timeout cleans up; retry can then complete normally', async () => {
		let disconnects = 0;
		const transport = new FakeTransport(async (handlers, call) => {
			if (call === 2) {
				handlers.onFrame(frame(65.5, 0));
				handlers.onFrame(frame(65.5, 0));
				handlers.onFrame(frame(65.5, 0));
			}
			return fakeConnection({ onDisconnect: () => { disconnects += 1; } });
		});
		const client = new BodyScaleClient(transport, { timeoutMs: 5 });
		await client.start();
		await new Promise((resolve) => setTimeout(resolve, 15));
		assert.equal(client.state, 'error');
		await client.start();
		assert.equal(client.state, 'complete');
		assert.equal(disconnects, 2);
		client.dispose();
	});

	console.log(`Scale sync checks passed: ${checks}`);
} finally {
	await vite.close();
}
