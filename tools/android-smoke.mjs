import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PNG } from 'pngjs';
import { writeJsonRecord } from '../dist/src/validation-resume.js';

const { values } = parseArgs({ options: {
    adb: { type: 'string' }, device: { type: 'string' },
    output: { type: 'string' }, apk: { type: 'string' },
    scene: { type: 'string' },
    app: { type: 'string', default: 'org.bblite.prototype' },
} });
if (!values.adb || !values.output || !values.apk) throw new Error('Use --adb, --output, --apk and optionally --device.');
const output = resolve(values.output);
mkdirSync(output, { recursive: true });
const selector = values.device ? ['-s', values.device] : [];
function adb(...args) {
    return execFileSync(values.adb, [...selector, ...args], { timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
}
const runId = randomUUID();
const app = values.app;
if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(app)) throw new Error('Invalid application ID.');
let captureEnvironment = { BBLITE_MAX_FRAMES: '8' };
let captureFrame = '5';
if (values.scene) {
    const { resolveScene } = await import('../dist/src/scene-registry.js');
    const { nativeCaptureFrameBudget } = await import('../dist/src/tooling/native-run.js');
    const scene = resolveScene(values.scene);
    captureEnvironment = { ...scene.parity?.nativeEnvironment, BBLITE_TEST_PASS: '1' };
    captureFrame = captureEnvironment.BBLITE_SCREENSHOT_FRAME ?? '0';
    captureEnvironment.BBLITE_MAX_FRAMES = String(nativeCaptureFrameBudget(captureEnvironment));
    delete captureEnvironment.BBLITE_SCREENSHOT_FRAME;
}
const receipt = {
    runId, apkSha256: createHash('sha256').update(readFileSync(values.apk)).digest('hex'),
    device: adb('get-serialno').toString().trim(),
    model: adb('shell', 'getprop', 'ro.product.model').toString().trim(),
    api: adb('shell', 'getprop', 'ro.build.version.sdk').toString().trim(),
    passed: false,
    ...(values.scene ? { scene: values.scene, captureFrame, captureEnvironment } : {}),
};
try {
    adb('shell', 'am', 'force-stop', app);
    adb('shell', 'run-as', app, 'rm', '-f', 'files/capture.png');
    let log = '';
    const logChunks = [];
    let logLength = 0;
    let markerTail = '';
    const exitMarker = `run=${runId}`;
    function appendLog(text) {
        logChunks.push(text);
        logLength += text.length;
        while (logLength > 16 * 1024 * 1024 && logChunks.length > 1) logLength -= logChunks.shift().length;
    }
    const logger = spawn(values.adb, [...selector, 'logcat', '-s', 'bblite:I', 'SDL:E', 'AndroidRuntime:E'], { windowsHide: true });
    let timer;
    try {
        const finished = new Promise(resolve => {
            timer = setTimeout(resolve, 90000);
            logger.on('error', error => { appendLog(error.message); resolve(); });
            logger.on('exit', resolve);
            logger.stdout.on('data', chunk => {
                const text = chunk.toString();
                appendLog(text);
                const recent = markerTail + text;
                if (recent.includes(exitMarker)) resolve();
                markerTail = recent.slice(-exitMarker.length);
            });
            logger.stderr.on('data', chunk => appendLog(chunk.toString()));
        });
        adb('shell', 'am', 'start', '-W', '-n', `${app}/org.bblite.prototype.MainActivity`,
            '--es', 'BBLITE_RUN_ID', runId, '--es', 'captureFrame', captureFrame,
            ...Object.entries(captureEnvironment).flatMap(([key, value]) => ['--es', key, value]),
            '--ez', 'capture', 'true');
        await finished;
    } finally {
        clearTimeout(timer);
        logger.kill();
        log = logChunks.join('');
        writeFileSync(join(output, 'logcat.txt'), log);
    }
    if (!log.includes(`Native exit: 0 run=${runId}`)) {
        throw new Error('Native smoke did not exit successfully within 90 seconds; inspect logcat.txt and ensure the device is unlocked.');
    }
    const bytes = adb('exec-out', 'run-as', app, 'cat', 'files/capture.png');
    const png = PNG.sync.read(bytes);
    writeFileSync(join(output, 'capture.png'), bytes);
    Object.assign(receipt, { passed: true, width: png.width, height: png.height });
    console.log(`Android smoke passed on ${receipt.model}: ${png.width}x${png.height}. ${output}`);
} catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error);
    throw error;
} finally {
    writeJsonRecord(join(output, 'report.json'), receipt);
    adb('shell', 'am', 'force-stop', app);
}
