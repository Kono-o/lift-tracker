import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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

// The harness encodes its own frames: if the simulator and the decoder shared a bug,
// these checks would pass while the real scale still failed.
function cfFrame(weightKg, options = {}) {
	const { status = 0, heartRate = 0, impedanceRaw = 0xb5ba, corrupt = false, handleByte } = options;
	const bytes = new Uint8Array(11);
	const settling = status !== 0x00 && status !== 0x05 && status !== 0x08;
	bytes[0] = 0xcf;
	bytes[1] = handleByte ?? heartRate;
	bytes[2] = settling ? 0x00 : 0xc0;
	const rawWeight = Math.round(weightKg * 100);
	bytes[3] = rawWeight & 0xff;
	bytes[4] = (rawWeight >> 8) & 0xff;
	bytes[5] = impedanceRaw & 0xff;
	bytes[6] = (impedanceRaw >> 8) & 0xff;
	bytes[7] = 0xba;
	bytes[8] = 0xb5;
	bytes[9] = status;
	for (let i = 0; i < 10; i += 1) bytes[10] ^= bytes[i];
	if (corrupt) bytes[10] ^= 0x55;
	return bytes;
}

function beFrame(wholeRaw, segmentRaw = 0) {
	const bytes = new Uint8Array(12);
	bytes[0] = 0xbe;
	bytes[1] = 0x05;
	[segmentRaw, 0, wholeRaw, 0, 0].forEach((value, index) => {
		bytes[2 + index * 2] = value & 0xff;
		bytes[3 + index * 2] = (value >> 8) & 0xff;
	});
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

/** Watch every event a weigh-in produces so the staging can be asserted, not assumed. */
function watch(client) {
	const seen = { states: [], stages: [], settles: [], lives: [], readings: [], errors: [] };
	client.on('state', (state) => seen.states.push(state));
	client.on('stage', (stage) => seen.stages.push(stage));
	client.on('settle', (settle) => seen.settles.push(settle));
	client.on('live', (live) => seen.lives.push(live));
	client.on('complete', (reading) => seen.readings.push(reading));
	client.on('error', (error) => seen.errors.push(error));
	return seen;
}

/** Wait for the first terminal event; the timers are the subject of some of these checks. */
async function awaitTerminal(seen, timeoutMs = 2_000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (seen.readings.length || seen.errors.length) break;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return { reading: seen.readings[0] ?? null, error: seen.errors[0] ?? null };
}

/** Compressed but proportionate windows: frames arrive every 20 ms in the sim. */
const FAST = { weightMs: 4_000, heartMs: 300, compositionMs: 300 };

const SIM_CASES = [
	{
		scenario: 'full-read',
		reading: {
			weightKg: 75.3,
			heartRate: 62,
			impedanceOhms: 500,
			impedanceSource: 'b5b6-x1',
			impedanceRaw: 500,
			quality: { weight: 'locked', heartRate: 'locked', impedance: 'locked' },
		},
		stages: ['heart', 'composition', 'done'],
	},
	{
		scenario: 'weight-only',
		reading: {
			weightKg: 75.3,
			heartRate: null,
			impedanceOhms: null,
			impedanceSource: null,
			quality: { weight: 'locked', heartRate: 'absent', impedance: 'absent' },
		},
	},
	{
		scenario: 'corrupt-frames',
		reading: {
			weightKg: 78.4,
			heartRate: 68,
			impedanceOhms: null,
			quality: { weight: 'locked', heartRate: 'locked', impedance: 'absent' },
		},
	},
	{ scenario: 'drifting-weight', error: /before a stable weight/ },
	{
		scenario: 'pro-8-electrode',
		reading: {
			weightKg: 71.8,
			heartRate: 58,
			impedanceOhms: 455,
			impedanceSource: 'be-wholebody',
			impedanceRaw: 4550,
			quality: { weight: 'locked', heartRate: 'locked', impedance: 'locked' },
		},
	},
	{ scenario: 'never-stable', error: /before a stable weight/ },
];

let server;
try {
	const protocol = await vite.ssrLoadModule('/src/lib/scale/protocol.ts');
	const { StableSignal, largestCluster, median, HEART_RATE_RULE, IMPEDANCE_RULE, WEIGHT_RULE } =
		await vite.ssrLoadModule('/src/lib/scale/stabilize.ts');
	const { ScaleSession } = await vite.ssrLoadModule('/src/lib/scale/session.ts');
	const { BodyScaleClient, NO_SIGNAL_FRAMES } = await vite.ssrLoadModule('/src/lib/scale/client.ts');
	const { ScaleSimTransport, SCENARIO_NAMES } = await vite.ssrLoadModule('/src/lib/scale/sim.ts');
	const { discoverySelfTest } = await vite.ssrLoadModule('/src/lib/scale/discovery.ts');
	const { WebBluetoothTransport } = await vite.ssrLoadModule('/src/lib/scale/transport-web.ts');
	const { toBodyReading } = await vite.ssrLoadModule('/src/lib/bodySanitize.ts');
	const {
		deriveBodyReading,
		metricByKey,
		metricTier,
		metricValueOf,
		formatMetric,
		seriesTier,
	} = await vite.ssrLoadModule('/src/lib/bodyHistory.ts');
	const { bodyCompSelfTest, deriveReading } = await vite.ssrLoadModule('/src/lib/bodyComp.ts');

	check('captured protocol frames pass the decoder regression checks', () => {
		assert.deepEqual(protocol.cultSelfTest(), []);
	});

	check('a body frame publishes pulse and impedance as ranked candidates, not assertions', () => {
		const decoded = protocol.parseScaleFrame(cfFrame(72.34, { heartRate: 68, impedanceRaw: 500 }));
		assert.equal(decoded.weightKg, 72.34);
		assert.equal(decoded.phase, 'body');
		assert.equal(decoded.heartRate, 68);
		// 500 raw is 500 ohms unscaled, 50 under x0.1 and 15.18 under the occult factor:
		// only the reading inside the published data range may survive.
		assert.deepEqual(decoded.impedance.map((c) => [c.hypothesis, c.ohms, c.raw]), [
			['b5b6-x1', 500, 500],
		]);
	});

	check('a disputed flag byte is never a pulse and out-of-range weights are refused', () => {
		const flagged = protocol.parseScaleFrame(cfFrame(72.34, { handleByte: 0x80 }));
		assert.equal(flagged.heartRate, null);
		assert.equal(protocol.parseScaleFrame(cfFrame(72.34, { handleByte: 0xff })).heartRate, null);
		// openScale reads bytes 1-2 big-endian x0.1: 0xc044 would be 4922 ohms, absurd.
		assert.equal(
			protocol.parseScaleFrame(cfFrame(72.34, { heartRate: 68 })).impedance.length,
			0,
		);
	});

	check('0xBE reports a whole-body resistance with its raw device units intact', () => {
		const pro = protocol.parseScaleFrame(beFrame(4550));
		assert.equal(pro.packet, 'be');
		assert.equal(pro.weightKg, null);
		assert.deepEqual(pro.impedance, [{ hypothesis: 'be-wholebody', ohms: 455, raw: 4550 }]);
	});

	check('status bytes outside the verified set are not frames at all', () => {
		assert.equal(protocol.parseScaleFrame(cfFrame(72.34, { status: 0x09 })), null);
		assert.equal(protocol.parseScaleFrame(cfFrame(72.34, { status: 0x05 })).phase, 'weigh');
		assert.equal(protocol.parseScaleFrame(cfFrame(72.34, { status: 0x00 })).phase, 'body');
	});

	check('stabilization publishes the median of an agreeing cluster, never the first frame', () => {
		const signal = new StableSignal(WEIGHT_RULE);
		signal.push(70);
		assert.equal(signal.value, null, 'a single frame must never be a reading');
		signal.push(90);
		// Three frames that agree inside the 0.05 kg tolerance, newest last: the
		// published number is the middle one, so neither the first nor the latest wins.
		signal.push(75.28);
		assert.equal(signal.progress.have, 1);
		signal.push(75.3);
		assert.equal(signal.progress.have, 2);
		signal.push(75.32);
		assert.equal(signal.locked, true);
		assert.equal(signal.value, 75.3);
		assert.deepEqual(signal.agreeing, [75.28, 75.3, 75.32]);
		assert.equal(signal.latest, 75.32, 'the live ticker still shows the newest frame');
	});

	check('one flicker cannot strand the lock, but a drift is refused rather than averaged', () => {
		const signal = new StableSignal(WEIGHT_RULE);
		signal.push(75);
		signal.push(75);
		signal.push(99.9); // a dropout inside the window
		signal.push(75);
		assert.equal(signal.locked, true);
		assert.equal(signal.value, 75);

		const drifting = new StableSignal(WEIGHT_RULE);
		for (let i = 0; i < 20; i += 1) drifting.push(80 + i * 0.1);
		assert.equal(drifting.locked, false, 'a marching weight is not a stable one');
		assert.equal(drifting.value, null);
	});

	check('out-of-band samples are discarded and largestCluster spans only the tolerance', () => {
		const heart = new StableSignal(HEART_RATE_RULE);
		heart.push(62);
		heart.push(300);
		heart.push(0);
		heart.push(62);
		heart.push(63);
		assert.equal(heart.progress.have, 3);
		assert.equal(heart.locked, false);
		heart.push(61);
		assert.equal(heart.locked, true);
		assert.equal(median([61, 62, 62, 63]), 62);
		assert.deepEqual(largestCluster([10, 11, 12, 40, 41], 2), [10, 11, 12]);
		assert.deepEqual(largestCluster([], 1), []);
		assert.equal(median([]), null);
	});

	check('the weight locks before pulse or resistance are collected', () => {
		const session = new ScaleSession();
		const first = session.handle(cfFrame(80, { status: 1 }));
		assert.deepEqual(first.filter((event) => event.kind === 'settle'), [], 'nothing settles while settling');
		assert.equal(session.stage, 'weigh');
		session.handle(cfFrame(80));
		session.handle(cfFrame(80, { heartRate: 62, impedanceRaw: 500 }));
		assert.equal(session.weightLocked, true);
		assert.equal(session.stage, 'heart', 'weight first, then heart rate');
	});

	check('a corrupt frame contributes to no metric at all', () => {
		const session = new ScaleSession();
		assert.deepEqual(session.handle(cfFrame(75, { corrupt: true })), []);
		session.handle(cfFrame(75));
		session.handle(cfFrame(75));
		assert.equal(session.weightLocked, false);
		session.handle(cfFrame(75));
		assert.equal(session.weightLocked, true);
	});

	check('a full read completes the moment pulse and resistance both agree', () => {
		const session = new ScaleSession();
		for (let i = 0; i < 3; i += 1) session.handle(cfFrame(75.3));
		const events = [];
		for (let i = 0; i < 6; i += 1) {
			session.handle(cfFrame(75.3, { heartRate: 62, impedanceRaw: 500 })).forEach((e) => events.push(e));
		}
		const complete = events.find((event) => event.kind === 'complete');
		assert.ok(complete, 'both signals locked, so the reading must close without a timeout');
		assert.equal(complete.reading.weightKg, 75.3);
		assert.equal(complete.reading.heartRate, 62);
		assert.equal(complete.reading.impedanceOhms, 500);
		assert.equal(complete.reading.quality.impedance, 'locked');
		assert.ok(complete.reading.frames > 3);
		const progress = events.filter((event) => event.kind === 'settle' && event.metric === 'heart_rate');
		assert.deepEqual(progress.map((event) => event.have), [1, 2, 3, 4], 'the UI can show a settling bar');
		assert.equal(progress[progress.length - 1].need, HEART_RATE_RULE.needed);
	});

	check('a weight-only plate finishes with nulls instead of invented zeros', () => {
		const session = new ScaleSession();
		for (let i = 0; i < 14; i += 1) session.handle(cfFrame(75.3));
		assert.equal(session.weightLocked, true);
		const events = session.finalize('idle');
		const reading = events.find((event) => event.kind === 'complete').reading;
		assert.equal(reading.heartRate, null);
		assert.equal(reading.impedanceOhms, null);
		assert.equal(reading.impedanceSource, null);
		assert.deepEqual(reading.quality, { weight: 'locked', heartRate: 'absent', impedance: 'absent' });
	});

	check('finalize never invents a reading when the weight never settled', () => {
		const session = new ScaleSession();
		for (let i = 0; i < 8; i += 1) session.handle(cfFrame(80 + i * 0.1));
		assert.deepEqual(session.finalize('timeout'), []);
		assert.equal(session.completed, false);
	});

	check('the 0xBE whole-body value outranks the disputed CF slots', () => {
		const session = new ScaleSession();
		const events = [];
		const feed = (bytes) => session.handle(bytes).forEach((event) => events.push(event));
		for (let i = 0; i < 3; i += 1) feed(cfFrame(71.8));
		for (let i = 0; i < 4; i += 1) {
			feed(cfFrame(71.8, { heartRate: 58 }));
			feed(beFrame(4550));
		}
		assert.equal(session.peek().impedance.value, 455);
		// Both optional signals agreed, so the session closed itself with the best-ranked
		// resistance and the raw units the Pro actually sent.
		const complete = events.find((event) => event.kind === 'complete');
		assert.ok(complete, 'expected the reading to close on its own');
		assert.equal(complete.reading.impedanceSource, 'be-wholebody');
		assert.equal(complete.reading.impedanceOhms, 455);
		assert.equal(complete.reading.impedanceRaw, 4550);
		assert.equal(complete.reading.heartRate, 58);
	});

	check('a resistance that keeps moving is never published', () => {
		const session = new ScaleSession();
		for (let i = 0; i < 3; i += 1) session.handle(cfFrame(75));
		// Each step is 20 ohms apart: outside the 5 ohm tolerance, so no cluster forms
		// and the reading finishes with the impedance marked absent rather than averaged.
		for (let i = 0; i < 8; i += 1) session.handle(cfFrame(75, { impedanceRaw: 400 + i * 20 }));
		assert.equal(session.impedanceLocked, false);
		const reading = session.finalize('timeout').find((event) => event.kind === 'complete').reading;
		assert.equal(reading.impedanceOhms, null);
		assert.equal(reading.quality.impedance, 'absent');
	});

	await checkAsync('staged timeouts still produce a reading, with the missing metric marked absent', async () => {
		const transport = new FakeTransport(async (handlers) => {
			for (let i = 0; i < 4; i += 1) handlers.onFrame(cfFrame(88, { status: 1 }));
			for (let i = 0; i < 8; i += 1) handlers.onFrame(cfFrame(88, { heartRate: 68 }));
			return fakeConnection();
		});
		const client = new BodyScaleClient(transport, FAST);
		const seen = watch(client);
		await client.start();
		const { reading, error } = await awaitTerminal(seen);
		client.dispose();
		assert.equal(error, null);
		assert.equal(reading.weightKg, 88);
		assert.equal(reading.heartRate, 68);
		assert.equal(reading.impedanceOhms, null, 'no resistance was ever offered');
		assert.deepEqual(seen.stages, ['heart', 'composition', 'done']);
	});

	await checkAsync('a stream that carries nothing after the weight closes itself within the quiet limit', async () => {
		let frames = 0;
		const transport = new FakeTransport(async (handlers) => {
			for (let i = 0; i < 3; i += 1) {
				frames += 1;
				handlers.onFrame(cfFrame(70));
			}
			for (let i = 0; i < 30; i += 1) {
				frames += 1;
				handlers.onFrame(cfFrame(70));
			}
			return fakeConnection();
		});
		const client = new BodyScaleClient(transport, { ...FAST, heartMs: 5_000, compositionMs: 5_000 });
		const seen = watch(client);
		await client.start();
		const { reading } = await awaitTerminal(seen);
		client.dispose();
		assert.ok(reading, 'the quiet-frame rule must beat a five-second window');
		assert.ok(seen.lives.length <= 3 + NO_SIGNAL_FRAMES, `took ${seen.lives.length} frames to give up`);
		assert.equal(reading.heartRate, null);
		assert.equal(frames, 33);
	});

	await checkAsync('a scale powering off after a locked weight is a completed reading, not an error', async () => {
		let handlers;
		const transport = new FakeTransport(async (given) => {
			handlers = given;
			return fakeConnection();
		});
		const client = new BodyScaleClient(transport, FAST);
		const seen = watch(client);
		await client.start();
		for (let i = 0; i < 3; i += 1) handlers.onFrame(cfFrame(74.25));
		handlers.onDisconnected();
		const { reading, error } = await awaitTerminal(seen);
		client.dispose();
		assert.equal(error, null);
		assert.equal(reading.weightKg, 74.25);
	});

	await checkAsync('frames delivered during connect are buffered, saved once, and disconnected', async () => {
		let disconnects = 0;
		let batteryReads = 0;
		const transport = new FakeTransport(async (handlers) => {
			handlers.onFrame(cfFrame(74.25, { status: 1 }));
			handlers.onFrame(cfFrame(74.25));
			handlers.onFrame(cfFrame(74.25));
			return fakeConnection({
				onDisconnect: () => { disconnects += 1; },
				readBattery: () => { batteryReads += 1; return 84; },
			});
		});
		const client = new BodyScaleClient(transport, { ...FAST, heartMs: 50, compositionMs: 50 });
		const seen = watch(client);
		await client.start();
		// Nothing else ever arrives, so the composition window has to be what ends it.
		const { reading } = await awaitTerminal(seen);
		client.dispose();
		assert.equal(client.state, 'complete');
		assert.equal(seen.readings.length, 1);
		assert.equal(reading.weightKg, 74.25);
		assert.equal(reading.heartRate, null);
		assert.equal(disconnects, 1);
		assert.equal(batteryReads, 1);
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
		const seen = watch(client);
		await client.start();
		assert.equal(client.state, 'idle');
		assert.equal(seen.errors.length, 0);
		client.dispose();
	});

	await checkAsync('disconnect before a stable weight errors without saving a partial value', async () => {
		let disconnects = 0;
		const transport = new FakeTransport(async (handlers) => {
			handlers.onFrame(cfFrame(75));
			handlers.onDisconnected();
			return fakeConnection({ onDisconnect: () => { disconnects += 1; } });
		});
		const client = new BodyScaleClient(transport, FAST);
		const seen = watch(client);
		await client.start();
		const { reading, error } = await awaitTerminal(seen);
		client.dispose();
		assert.equal(client.state, 'error');
		assert.equal(reading, null);
		assert.match(error.message, /before a stable weight/);
		assert.equal(disconnects, 1);
	});

	await checkAsync('a weight that never settles times out and a retry can then complete', async () => {
		let disconnects = 0;
		const transport = new FakeTransport(async (handlers, call) => {
			if (call === 2) {
				for (let i = 0; i < 3; i += 1) handlers.onFrame(cfFrame(65.5));
				handlers.onDisconnected();
			}
			return fakeConnection({ onDisconnect: () => { disconnects += 1; } });
		});
		const client = new BodyScaleClient(transport, { ...FAST, weightMs: 20 });
		await client.start();
		const first = await awaitTerminal(watch(client), 200);
		assert.equal(client.state, 'error');
		assert.equal(first.reading, null);
		const seen = watch(client);
		await client.start();
		const retry = await awaitTerminal(seen);
		client.dispose();
		assert.equal(retry.reading.weightKg, 65.5);
		assert.equal(disconnects, 2);
	});

	for (const testCase of SIM_CASES) {
		await checkAsync(`simulated scale: ${testCase.scenario}`, async () => {
			const index = ['full-read', 'weight-only', 'corrupt-frames', 'drifting-weight', 'pro-8-electrode', 'never-stable']
				.indexOf(testCase.scenario);
			const transport = new ScaleSimTransport({ startAt: index, tickMs: 20 });
			const client = new BodyScaleClient(transport, FAST);
			const seen = watch(client);
			await client.start();
			const { reading, error } = await awaitTerminal(seen, 3_000);
			client.dispose();
			if (testCase.error) {
				assert.ok(error, 'expected the weigh-in to fail');
				assert.match(error.message, testCase.error);
				assert.equal(reading, null);
				return;
			}
			assert.equal(error, null);
			const picked = {};
			for (const key of Object.keys(testCase.reading)) {
				picked[key] = key === 'quality' ? reading.quality : reading[key];
			}
			assert.deepEqual(picked, testCase.reading);
			if (testCase.stages) assert.deepEqual(seen.stages, testCase.stages);
			assert.ok(reading.frames > 0);
		});
	}

	check('every simulated scenario is covered by a case', () => {
		assert.deepEqual(
			[...SCENARIO_NAMES].sort(),
			SIM_CASES.map((testCase) => testCase.scenario).sort(),
		);
	});

	check('the device board follows rules that can be proved without a radio', () => {
		assert.deepEqual(discoverySelfTest(), []);
	});

	await checkAsync('the board lists scales, drops somebody else’s gadgets, and a row can be connected', async () => {
		const transport = new ScaleSimTransport({ startAt: 0, tickMs: 20 });
		// The sim is gated on `?scalesim=1`, which is a browser URL; in here the roster
		// and the frames are what matter, so report the radio as present.
		transport.isSupported = () => true;
		const client = new BodyScaleClient(transport, FAST);
		const seen = watch(client);
		const labels = [];
		let boards = 0;
		client.on('device', (label) => labels.push(label));
		client.on('devices', () => { boards += 1; });

		await client.scan();
		assert.equal(client.scanning, true);
		// The sim dribbles advertisements in over a few hundred ms; wait for the last
		// one, but leave the scan running so the next block can prove what stops it.
		await new Promise((resolve) => setTimeout(resolve, 400));

		const tails = client.devices.map((device) => device.id);
		// Paired scale first (reconnectable + a real signal), then the saved one, then
		// the advertisers. Headphones and the nameless pairing are never on it.
		assert.deepEqual(tails, [
			'F0:D8:03:2A:BC:01',
			'E8:EB:1B:44:55:66',
			'CF:EE:12:34:56:78',
			'A5:B6:C7:D8:E9:FA',
		], `board was ${tails}`);
		assert.equal(client.devices[0].bonded, true);
		assert.equal(client.devices[1].remembered, true);
		assert.equal(
			client.devices.filter((device) => device.id.endsWith('2A:BC:01')).length,
			1,
			'seen twice, listed once',
		);

		assert.equal(client.canPickById(), true);
		await client.connectTo(client.devices[0]);
		assert.equal(client.state, 'connected');
		assert.equal(client.scanning, false, 'a scan must not keep running into a weigh-in');
		const { reading, error } = await awaitTerminal(seen, 3_000);
		const settled = boards;
		client.stopScan();
		client.stopScan(); // idempotent: a second stop must not re-emit or re-scan
		assert.equal(boards, settled, 'stopping a scan that already stopped publishes nothing');
		client.dispose();
		assert.equal(error, null);
		assert.equal(reading.weightKg, 75.3);
		// Provenance is the row the user tapped, not a generic label.
		assert.match(labels[0], /^Cult Smart Scale/);
	});

	await checkAsync('a browser that cannot enumerate devices still gives an empty board, not an error', async () => {
		const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
		const frames = [];
		try {
			Object.defineProperty(globalThis, 'navigator', {
				configurable: true,
				value: { bluetooth: { requestDevice: async () => { throw new Error('cancelled'); } } },
			});
			const transport = new WebBluetoothTransport();
			assert.deepEqual(await transport.listDevices(), []);
			const stop = await transport.startScan((seed) => frames.push(seed));
			assert.equal(typeof stop, 'function');
			stop();
			assert.equal(frames.length, 0);
			await transport.connectTo('no-such-id').then(
				() => { throw new Error('a saved device that is not saved must not connect'); },
				(err) => assert.match(err.message, /not saved in this browser/),
			);
		} finally {
			if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
			else delete globalThis.navigator;
		}
	});

	await checkAsync('a saved web Bluetooth scale is reachable from its row, without a picker', async () => {
		const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
		const listeners = new Map();
		let frames = 0;
		let watches = 0;
		let stops = 0;
		let starts = 0;
		const emit = (name, event) => {
			for (const fn of listeners.get(name) ?? []) fn(event);
		};
		const characteristic = {
			addEventListener: (name, fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
			removeEventListener: () => {},
			startNotifications: async () => { starts += 1; return characteristic; },
			stopNotifications: async () => characteristic,
			readValue: async () => new DataView(new Uint8Array([84]).buffer),
		};
		const device = {
			// Chrome hands out an opaque per-origin token, never a MAC.
			id: 'token-9f3a',
			name: 'Cult CS-BF01',
			addEventListener: (name, fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
			removeEventListener: () => {},
			watchAdvertisements: async () => {
				watches += 1;
				// Chrome only reports the device it was told to watch.
				setTimeout(() => emit('advertisementreceived', { target: { device, rssi: -55 } }), 5);
			},
			stopAdvertisements: () => { stops += 1; },
			gatt: {
				connected: false,
				connect: async function () { this.connected = true; return this; },
				disconnect: function () { this.connected = false; },
				getPrimaryService: async () => ({ getCharacteristic: async () => characteristic }),
			},
		};
		try {
			Object.defineProperty(globalThis, 'navigator', {
				configurable: true,
				value: {
					bluetooth: {
						getDevices: async () => [device],
						requestDevice: async () => { throw new Error('the row tap must not open a picker'); },
					},
				},
			});
			const transport = new WebBluetoothTransport();
			assert.deepEqual(await transport.listDevices(), [
				{ id: 'token-9f3a', name: 'Cult CS-BF01', remembered: true },
			]);
			const connection = await transport.connectTo('token-9f3a', {
				onFrame: () => { frames += 1; },
				onDisconnected: () => {},
			});
			assert.equal(watches, 1, 'a saved device has to be seen advertising before it can be reached');
			assert.equal(stops, 1, 'the advertisement watcher must not be left running');
			assert.equal(connection.label, 'Cult CS-BF01');
			assert.equal(starts, 1);
			emit('characteristicvaluechanged', { target: { value: new DataView(cfFrame(72).buffer) } });
			assert.equal(frames, 1);
			await connection.disconnect();
		} finally {
			if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
			else delete globalThis.navigator;
		}
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
			listeners.get('characteristicvaluechanged')({ target: { value: new DataView(cfFrame(72).buffer) } });
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

	check('a scale row that declares no provenance keeps its undocumented bytes out of the UI', () => {
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
		assert.equal(oldRow.impedance_ohms, null);
		// Even a caller handing over an unsanitized row gets the same answer: an
		// in-band resistance is still refused, because the row cannot vouch for it.
		const derived = deriveBodyReading({ ...oldRow, heart_rate: 60, impedance_ohms: 500 });
		assert.equal(metricValueOf(derived, 'heart_rate'), null);
		assert.equal(metricValueOf(derived, 'impedance_ohms'), null);
		// The grid still fills in, from weight plus profile, and says so.
		assert.equal(metricTier(derived, 'body_fat_pct'), 'estimate');
		assert.equal(metricValueOf(derived, 'body_fat_pct'), 20.0);
	});

	check('a staged scale row keeps its pulse and resistance and promotes the grid to bia', () => {
		const row = toBodyReading({
			id: 'reading-2',
			user_id: 'user-1',
			// Exactly 30 years before the measurement: the hand-computed anchors apply.
			measured_at: '2026-11-01T12:00:00.000Z',
			weight_kg: 75,
			heart_rate: 62,
			impedance_ohms: 500,
			impedance_source: 'b5b6-x1',
			captured_version: 2,
			source: 'scale',
			device_label: 'Cult Smart Scale',
			profile_snapshot: { sex: 'male', date_of_birth: '1996-11-01', height_cm: 180 },
		});
		assert.equal(row.heart_rate, 62);
		assert.equal(row.impedance_ohms, 500);
		const derived = deriveBodyReading(row);
		const expected = {
			heart_rate: 62,
			impedance_ohms: 500,
			bmi: 23.1,
			body_fat_pct: 20.3,
			fat_mass_kg: 15.3,
			ffm_kg: 59.7,
			body_water_pct: 54.6,
			bone_mass_kg: 3,
			muscle_mass_kg: 56.7,
			smm_pct: 42,
			visceral_fat_level: 10,
			subcutaneous_fat_pct: 14.6,
			protein_pct: 16.6,
			bmr_kcal: 1661,
			body_age: 29,
		};
		for (const [key, value] of Object.entries(expected)) {
			assert.equal(metricValueOf(derived, key), value, `${key}`);
		}
		// Every one of them came off the measured resistance.
		for (const key of ['body_fat_pct', 'ffm_kg', 'body_water_pct', 'bone_mass_kg', 'muscle_mass_kg', 'protein_pct', 'bmr_kcal', 'body_age']) {
			assert.equal(metricTier(derived, key), 'bia', `${key} tier`);
		}
		// Visceral level never sees the resistance, so it cannot claim the tier.
		assert.equal(metricTier(derived, 'visceral_fat_level'), 'estimate');
		// A resistance outside the equations' window is refused, not believed.
		const bogus = deriveBodyReading({ ...row, impedance_ohms: 5000 });
		assert.equal(bogus.ohms, null);
		assert.equal(metricTier(bogus, 'body_fat_pct'), 'estimate');
	});

	check('TDEE waits for an activity level, and every metric has a label and a format', () => {
		const base = { weightKg: 75, heightCm: 180, ageYears: 30, sex: 'male' };
		assert.equal(deriveReading(base).tdeeKcal, null, 'no activity, no TDEE');
		assert.equal(deriveReading({ ...base, activity: 'moderate' }).tdeeKcal, 2682);
		assert.equal(deriveReading({ ...base, activity: 'nonsense' }).tdeeKcal, null);

		const tiers = deriveReading(base).tiers;
		for (const key of Object.keys(tiers)) {
			const metric = metricByKey(key);
			assert.equal(metric.key, key, `${key} must be in the pill registry`);
			assert.ok(metric.label && metric.hint, `${key} needs a label and a hint`);
		}
		const bia = deriveReading({ ...base, resistanceOhms: 500 });
		assert.equal(formatMetric('body_fat_pct', bia.bodyFatPct, 'metric'), '20.3%');
		assert.equal(formatMetric('visceral_fat_level', bia.visceralFatLevel, 'metric'), '10');
		assert.equal(formatMetric('body_age', bia.bodyAge, 'metric'), '29 yr');
		assert.equal(formatMetric('tbw_l', bia.tbwL, 'metric'), '41.0 L');
		assert.equal(formatMetric('impedance_ohms', 500, 'metric'), '500 Ω');
		assert.equal(formatMetric('bmr_kcal', bia.bmrKcal, 'metric'), '1661 kcal');
		assert.equal(formatMetric('muscle_mass_kg', bia.muscleMassKg, 'imperial'), '125 lb');
		assert.equal(formatMetric('body_fat_pct', null, 'metric'), '—');
	});

	check('a series that changes how it was measured is reported as mixed, not as one line', () => {
		const mk = (ohms, dob) =>
			deriveBodyReading(
				toBodyReading({
					id: `r-${ohms ?? 'est'}`,
					user_id: 'user-1',
					measured_at: '2026-11-01T12:00:00.000Z',
					weight_kg: 75,
					impedance_ohms: ohms,
					captured_version: 2,
					source: 'scale',
					profile_snapshot: { sex: 'male', date_of_birth: dob, height_cm: 180 },
				}),
			);
		const estimated = mk(null, '1990-01-01');
		const measured = mk(500, '1996-11-01');
		assert.equal(seriesTier([estimated], 'body_fat_pct'), 'estimate');
		assert.equal(seriesTier([measured], 'body_fat_pct'), 'bia');
		assert.equal(seriesTier([estimated, measured], 'body_fat_pct'), 'mixed');
		// A metric that is absent everywhere has no provenance to claim.
		assert.equal(seriesTier([estimated], 'tdee_kcal'), null);
	});

	check('the body client speaks the schema it is written against', () => {
		const sql = readFileSync('supabase/setup.sql', 'utf8');
		const client = readFileSync('src/lib/db.ts', 'utf8');

		const tableColumns = (name) => {
			const m = new RegExp(`create table ${name} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
			if (!m) return null;
			return new Set(
				m[1]
					.split('\n')
					.map((line) => line.trim().split(/\s+/)[0])
					.filter((word) => /^\w+$/.test(word)),
			);
		};

		// A client keyword that the deployed function does not declare is a Postgres
		// "function not found", and one it does declare but the client omits is a
		// silently-cleared column, so both sets have to be identical.
		const declared = (fn) => {
			const m = new RegExp(`FUNCTION public\\.${fn}\\(([^)]*)\\)`).exec(sql);
			assert.ok(m, `${fn} is not defined in setup.sql`);
			return m[1].split(',').map((arg) => arg.trim().split(/\s+/)[0]).sort();
		};
		const sent = (fn) => {
			const m = new RegExp(`rpc\\("${fn}",\\s*\\{([\\s\\S]*?)\\}\\)`).exec(client);
			assert.ok(m, `${fn} is never called from db.ts`);
			return [...m[1].matchAll(/^\s*(\w+):/gm)].map((k) => k[1]).sort();
		};
		assert.deepEqual(sent('save_profile'), declared('save_profile'), 'save_profile arguments');
		assert.deepEqual(sent('save_body_reading'), declared('save_body_reading'), 'save_body_reading arguments');

		const selected = (constant) => {
			const m = new RegExp(`const ${constant} =\\s*\\n?\\s*"([^"]+)"`).exec(client);
			assert.ok(m, `${constant} missing from db.ts`);
			return m[1].split(',').map((col) => col.trim()).filter(Boolean);
		};
		const profileCols = tableColumns('public.profiles');
		const readingCols = tableColumns('public.body_readings');
		assert.ok(profileCols && readingCols, 'both body tables must be in setup.sql');
		for (const col of selected('PROFILE_COLUMNS')) {
			assert.ok(profileCols.has(col), `profiles.${col} does not exist`);
		}
		const readings = selected('BODY_READING_COLUMNS');
		for (const col of readings) {
			assert.ok(readingCols.has(col), `body_readings.${col} does not exist`);
		}
		// toBodyReading() gates on these, so a select that drops one loses the field
		// without any error to show for it.
		for (const col of ['heart_rate', 'impedance_ohms', 'impedance_source', 'captured_version', 'profile_snapshot']) {
			assert.ok(readings.includes(col), `${col} must be selected`);
		}

		// The live project has drifted from the migrations before; every column a
		// migration adds has to be in the full-init script too.
		for (const file of readdirSync('supabase/migrations').sort()) {
			const migration = readFileSync(`supabase/migrations/${file}`, 'utf8');
			for (const m of migration.matchAll(/alter table (public\.\w+) add column (?:if not exists )?(\w+)/g)) {
				const cols = tableColumns(m[1]);
				assert.ok(cols, `${file}: ${m[1]} is not in setup.sql`);
				assert.ok(cols.has(m[2]), `${file}: ${m[1]}.${m[2]} is missing from setup.sql`);
			}
		}
	});

	check('the body-compensation engine matches its hand-computed anchors', () => {
		assert.deepEqual(bodyCompSelfTest(), []);
	});

	console.log(`Scale sync checks passed: ${checks}`);
} finally {
	await vite.close();
}
