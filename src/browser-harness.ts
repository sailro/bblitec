// The one server-listen -> Chromium-launch -> page-drive -> teardown
// ceremony.
//
// Five tools run a page in a real Chromium: the golden-suite capture
// (`capture-suite-reference.ts`), the instrumented diagnostics capture
// (`capture-instrumented.ts`), the pinned HDR GGX prefilter
// (`hdr-prefilter-gpu.ts`), the drawn sprite-atlas baker
// (`executed-module-assets.ts`), and the pinned BRDF-LUT baker
// (`ibl-brdf-lut.ts`). Each carried its own copy of the ceremony, the
// same way each once carried its own copy of the browser list -- and that
// copy had already drifted once (`browser-path.ts` records it). This
// module is the one copy of the ceremony; `browser-path.ts` stays the one
// copy of where the browser lives. A sixth consumer reaches it across a
// process boundary: the synchronous compiler walk's Canvas2D data-URL
// helper (`compiler/browser-generated-string.ts`) spawns a subprocess
// whose script imports `withBrowserPage` from here, the same
// shared-module-not-inlined shape `compiler/asset-bytes-sync.ts` uses
// for the downloader.
//
// What the five copies disagreed on, and the verdict for each:
//
// Load-bearing differences, kept as explicit options --
// - Chromium flags. The two screenshot harnesses pin
//   `--force-color-profile=srgb` (golden bytes must not depend on the
//   host color profile) plus `--enable-unsafe-webgpu`; the two WebGPU
//   compute harnesses enable WebGPU; Linux also selects Vulkan for both.
//   Linux Canvas2D bakes share the capture renderer; other hosts retain
//   their default Canvas2D flags. The three baked-byte harnesses (HDR,
//   LUT, atlas) feed golden-checked or committed assets: `browserArgs`
//   is exact per caller and never defaulted. Windows flags stay unchanged.
// - Viewport. The screenshot harnesses pin 1280x720 at
//   deviceScaleFactor 1 (the golden's dimensions); the compute harnesses
//   never rasterize the page and set none.
// - Requirement message. Each harness names why it cannot proceed
//   without Chromium (`resolveBrowserPath`'s parameter).
// - Page diagnostics. The golden capture logs `pageerror` and console
//   errors ("Reference ..."); the instrumented capture logs `pageerror`
//   only ("Capture ..."); the compute harnesses log neither -- their
//   failures surface as `page.evaluate` rejections.
// - Navigation and readiness. The scene harnesses load `/scene.html`
//   under a 120s domcontentloaded timeout and wait through the
//   ready / frozen-pose / 3s-settle protocol (`waitForSceneReady`); the
//   compute harnesses load the served root and drive everything through
//   `evaluate`. Navigation therefore stays in the caller's body, which
//   also lets the instrumented capture install its WebGPU hooks with
//   `addInitScript` before any navigation happens.
//
// What every harness shares --
// - A non-numeric listen address closes the server before throwing and
//   reads "Unable to start the <serverName>.".
// - The launch happens inside the guarded region: a Chromium that fails
//   to launch closes the server instead of leaking it and hanging the
//   process.
// - Teardown is `await browser?.close()` then an awaited `server.close`
//   whose error propagates; a close error is only reachable when closing
//   a server that is not running, which none of these paths can produce.
//
// Generation bakes (`shared`) normally connect to the generation's Chromium
// per launch configuration, owned by a detached host until generation exits.
// Headed Linux bakes instead launch separate browsers: multiple isolated
// contexts in one headed Chromium can crash it. Every bake retains its own
// context; teardown closes its connection or its own browser.
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { HOST_PRIMARY_CANVAS_ID } from "./host-primary-canvas.js";
import { transpileForBrowser } from "./typescript-transpile.js";
import { resolveBrowserPath } from "./browser-path.js";
import { captureSettleMilliseconds } from "./capture-timing.js";
import type { ReferenceSettle } from "./scene-registry.js";
import {
    generationBrowserEndpoint,
    launchOptions,
    type GenerationBrowserLaunch,
} from "./generation-browser.js";

/** Enable WebGPU, with Vulkan on Linux. Baked bytes depend on the browser
 *  and GPU; enabling another host does not repin their golden hashes. */
export const webgpuComputeBrowserArgs = [
    "--enable-unsafe-webgpu",
    ...(process.platform === "linux"
        ? ["--use-angle=vulkan", "--enable-features=Vulkan"]
        : []),
] as const;

/** The sRGB pin keeps screenshots independent of the host display profile. */
export const screenshotCaptureBrowserArgs = [
    "--force-color-profile=srgb",
    ...webgpuComputeBrowserArgs,
] as const;

/** Linux Canvas2D producers must use the same rasterizer as reference captures. */
export const canvasBakeBrowserArgs: readonly string[] =
    process.platform === "linux" ? screenshotCaptureBrowserArgs : [];

interface BrowserPageOptions {
    /** A separate visible test window can measure the display's real cadence. */
    headless?: boolean;
    /** Preserve scrollbar layout and painting in headless UI captures. */
    showScrollbars?: boolean;
    /** What a failed ephemeral listen names:
     *  "Unable to start the <serverName>." */
    serverName: string;
    /** Why the caller cannot proceed without Chromium;
     *  `resolveBrowserPath`'s generic message otherwise. */
    browserRequirement?: string;
    /** Chromium flags, exact per harness (see the catalogue above). */
    browserArgs?: readonly string[];
    /** Pin the page to this viewport. The
     *  screenshot harnesses pass the golden's 1280x720; the compute
     *  harnesses omit it. */
    viewport?: { width: number; height: number };
    /** Defaults to 1; mobile diagnostics must match the native display density. */
    deviceScaleFactor?: number;
    /** Log `pageerror` events as `<prefix>: <message>`; silent without. */
    pageErrorPrefix?: string;
    /** Log console error messages as `<prefix>: <text>`; silent
     *  without. */
    consoleErrorPrefix?: string;
    /** A generation bake: use the generation's shared Chromium except
     *  on headed Linux, where each isolated bake owns a browser. */
    shared?: boolean;
}

/**
 * Serve `server` on an ephemeral 127.0.0.1 port, launch the resolved
 * Chromium, open one page, run `body` with the page and the
 * server's origin, and tear both down whatever `body` does.
 *
 * The server's payload is the caller's: the scene harnesses pass the
 * suite scene server, the compute harnesses a one-page shell. `body`
 * owns everything between page creation and teardown -- init scripts,
 * navigation, evaluation, screenshots -- and its return value is the
 * harness's.
 */
export async function withBrowserPage<T>(
    server: Server,
    options: BrowserPageOptions,
    body: (page: Page, origin: string) => Promise<T>,
): Promise<T> {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new Error(`Unable to start the ${options.serverName}.`);
    }
    const origin = `http://127.0.0.1:${address.port}`;
    let browser: Browser | undefined;
    try {
        const launch: GenerationBrowserLaunch = {
            executablePath: resolveBrowserPath(options.browserRequirement),
            // Linux needs a graphical session for reliable WebGPU external
            // image uploads and canvas presentation, including under SSH.
            headless: options.headless ?? process.platform !== "linux",
            args: [...(options.browserArgs ?? [])],
            ignoreDefaultArgs: options.showScrollbars
                ? ["--hide-scrollbars"]
                : [],
        };
        const pageOptions = options.viewport
            ? {
                  viewport: options.viewport,
                  deviceScaleFactor: options.deviceScaleFactor ?? 1,
              }
            : undefined;
        // Closing a shared connection closes the context opened through it,
        // and only that: the page's own crash or failure stays its own.
        const shared =
            options.shared && (process.platform !== "linux" || launch.headless);
        browser = shared
            ? await chromium.connect(await generationBrowserEndpoint(launch), {
                  timeout: 60_000,
              })
            : await chromium.launch(launchOptions(launch));
        const page = await (await browser.newContext(pageOptions)).newPage();
        const pageErrorPrefix = options.pageErrorPrefix;
        if (pageErrorPrefix !== undefined) {
            page.on("pageerror", (error) => {
                console.error(`${pageErrorPrefix}: ${error.message}`);
            });
        }
        const consoleErrorPrefix = options.consoleErrorPrefix;
        if (consoleErrorPrefix !== undefined) {
            page.on("console", (message) => {
                if (message.type() === "error") {
                    // A failed resource load names its request only here.
                    const { url } = message.location();
                    console.error(
                        `${consoleErrorPrefix}: ${message.text()}${url ? ` (${url})` : ""}`,
                    );
                }
            });
        }
        return await body(page, origin);
    } finally {
        await browser?.close();
        await new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
        );
    }
}

/**
 * Drive a suite scene page to its settled frame: navigate to
 * `/scene.html`, wait for the scene module's ready handshake, optionally
 * for the frozen-pose handshake an animation seek arms
 * (`awaitFrozenPose` mirrors "a capture time was requested"), then take
 * the three-second settle every capture has always taken before reading
 * pixels or uploads.
 */
export async function waitForSceneReady(
    page: Page,
    origin: string,
    awaitFrozenPose: boolean,
    search?: string,
    fixedAnimationFrame?: number,
    settle?: ReferenceSettle,
): Promise<void> {
    await gotoScenePage(page, origin, search);
    await waitForCanvasSettles(page, [canvasReadySettle], 120_000);
    if (awaitFrozenPose) {
        await page.waitForFunction(
            (id: string) =>
                document.getElementById(id)?.dataset.animationFrozen === "true",
            HOST_PRIMARY_CANVAS_ID,
            { timeout: 120_000 },
        );
    }
    if (fixedAnimationFrame !== undefined) {
        // The fixed RAF clock keeps its marks on the document element.
        const marks = page.locator("html");
        const expectedCaptureFrame = String(fixedAnimationFrame);
        const deadline = Date.now() + 120_000;
        try {
            while (
                (await marks.getAttribute("data-fixed-capture-frame")) !==
                expectedCaptureFrame
            ) {
                if (Date.now() >= deadline) {
                    throw new Error("Timed out waiting for fixed browser RAF.");
                }
                await page.waitForTimeout(25);
            }
        } catch (error) {
            const frame = await marks.getAttribute(
                "data-fixed-animation-frame",
            );
            const captureFrame = await marks.getAttribute(
                "data-fixed-capture-frame",
            );
            const callbacks = await marks.getAttribute(
                "data-fixed-animation-callbacks",
            );
            throw new Error(
                `Fixed browser RAF did not reach frame ${fixedAnimationFrame}: ` +
                    `schedulerFrame=${frame ?? "unset"}, ` +
                    `captureFrame=${captureFrame ?? "unset"}, ` +
                    `callbacks=${callbacks ?? "unset"}.`,
                { cause: error },
            );
        }
    } else if (settle !== undefined) {
        await waitForCanvasSettles(
            page,
            [canvasReadySettle, settle],
            settleTimeoutMilliseconds,
        );
    } else {
        await page.waitForTimeout(captureSettleMilliseconds);
    }
}

/** How long a settle capture waits for its state, network included. */
const settleTimeoutMilliseconds = 600_000;

/**
 * The data-ready gate as a settle: any canvas marks `data-ready="true"`, at
 * once. The harness's document mark answers it for a program with no canvas
 * of its own to wait for.
 */
const canvasReadySettle: ReferenceSettle = {
    key: "ready",
    values: ["true"],
    settleMilliseconds: 0,
};

/**
 * Wait until every settle holds, each on any canvas's dataset, for the
 * longest settle time, polling the live (unfrozen) page; a canvas's
 * nonempty `data-error` fails the capture at once. The native capture waits
 * on the same settles (`pal_window_realm.cpp`).
 */
async function waitForCanvasSettles(
    page: Page,
    settles: readonly ReferenceSettle[],
    timeoutMilliseconds: number,
): Promise<void> {
    const deadline = Date.now() + timeoutMilliseconds;
    const hold = Math.max(
        ...settles.map((settle) => settle.settleMilliseconds),
    );
    let since: number | undefined;
    for (;;) {
        const state = await page.evaluate(
            (rows) => {
                const canvases = [...document.querySelectorAll("canvas")];
                const error = canvases
                    .map((canvas) => canvas.dataset.error)
                    .find((value) => value);
                const held = rows.map(
                    (row) =>
                        (row.key === "ready" &&
                            document.documentElement.dataset.captureReady ===
                                "true") ||
                        canvases.some((canvas) =>
                            row.values.includes(canvas.dataset[row.key] ?? ""),
                        ),
                );
                return { error, held };
            },
            settles.map(({ key, values }) => ({ key, values: [...values] })),
        );
        if (state.error)
            throw new Error(`A canvas reported data-error: ${state.error}`);
        const now = Date.now();
        if (state.held.every(Boolean)) {
            since ??= now;
            if (now - since >= hold) return;
        } else {
            since = undefined;
        }
        if (now >= deadline) {
            const waiting = settles
                .filter((_, index) => !state.held[index])
                .map(
                    (settle) =>
                        `${settle.key} in [${settle.values.join(", ")}]`,
                );
            throw new Error(
                `Timed out waiting for canvas dataset ${waiting.join(" and ") || "settle time"}.`,
            );
        }
        await page.waitForTimeout(hold > 0 ? 250 : 25);
    }
}

/**
 * Serve one page module, wait for the global it installs, and return what
 * that global's call resolved to.
 *
 * Three generation-time bakes hand a driver module to the page and read one
 * value back — a drawn atlas or a computed buffer
 * (`executed-module-assets.ts`), a frozen node-particle state
 * (`pinned-node-particle.ts`), and a Basis transcode
 * (`basis-transcode.ts`). Each carried its own copy of the same four steps,
 * which is the duplication this module exists to hold once; what differs is
 * the module, the global's name, and the harness options the page needs.
 */
export async function runPageGlobal(
    server: Server,
    globalName: string,
    options: BrowserPageOptions,
): Promise<unknown> {
    return withBrowserPage(server, options, async (page, origin) => {
        await gotoScenePage(page, origin);
        await page.waitForFunction(
            `typeof window.${globalName} === 'function'`,
            null,
            { timeout: 60_000 },
        );
        return page.evaluate(`window.${globalName}()`);
    });
}

/**
 * The page-side base64 encoder, as a source fragment: `bblBase64(bytes)`
 * encodes a `Uint8Array` or `Uint8ClampedArray` with the browser's own
 * `Uint8Array.prototype.toBase64`, and throws in a browser without it.
 *
 * Bytes cross the page boundary as text because the boundary serializes
 * JSON: a number per byte costs about four bytes of wire each and turns a
 * megapixel read-back into ten seconds. `decodePageBase64` is the Node side.
 */
export const pageBase64Script =
    "const bblBase64 = (bytes) => {\n" +
    '    if (typeof Uint8Array.prototype.toBase64 !== "function") {\n' +
    '        throw new Error("bblBase64 needs Uint8Array.prototype.toBase64, which this browser lacks.");\n' +
    "    }\n" +
    "    const tag = Object.prototype.toString.call(bytes);\n" +
    '    if (tag !== "[object Uint8Array]" && tag !== "[object Uint8ClampedArray]") {\n' +
    '        throw new TypeError("bblBase64 encodes a Uint8Array or Uint8ClampedArray, not " + tag + ".");\n' +
    "    }\n" +
    "    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).toBase64();\n" +
    "};\n";

/**
 * A page's `bblBase64` text decoded straight into a payload behind
 * little-endian uint32 `header` words, refusing anything but exactly
 * `expected` bytes. `what` names the bytes in the refusal.
 */
export function decodePageBase64(
    text: string,
    header: readonly number[],
    expected: number,
    what: string,
): Buffer {
    const decoded = Buffer.byteLength(text, "base64");
    if (decoded !== expected)
        throw new Error(`${what} holds ${decoded} bytes, not ${expected}.`);
    const start = header.length * 4;
    const payload = Buffer.alloc(start + expected);
    header.forEach((word, index) => payload.writeUInt32LE(word, index * 4));
    if (payload.write(text, start, "base64") !== expected)
        throw new Error(`${what} is not base64.`);
    return payload;
}

/** The `count` header words of a `decodePageBase64` payload; undefined
 *  when the payload is shorter than its header. */
export function pagePayloadHeader(
    payload: Uint8Array,
    count: number,
): number[] | undefined {
    if (payload.byteLength < count * 4) return undefined;
    const view = new DataView(payload.buffer, payload.byteOffset, count * 4);
    return Array.from({ length: count }, (_, index) =>
        view.getUint32(index * 4, true),
    );
}

/**
 * The page-side texture read-back, as a source fragment:
 * `bblReadTextureLevels(device, texture, bytesPerTexel)` resolves to every mip
 * level of a 2D, 2D-array or cube texture, every layer, as `{ packed }`:
 * one tightly packed buffer (level-major, the copies' 256-byte row pitch
 * removed). All levels copy into one staging
 * buffer at 256-byte-aligned offsets, under one submit and one map. The
 * texture needs `COPY_SRC`.
 */
export const pageTextureLevelsScript =
    "const bblReadTextureLevels = async (device, texture, bytesPerTexel) => {\n" +
    "    const layers = texture.depthOrArrayLayers;\n" +
    "    const copies = [];\n" +
    "    let staged = 0;\n" +
    "    let packedBytes = 0;\n" +
    "    for (let mipLevel = 0; mipLevel < texture.mipLevelCount; mipLevel++) {\n" +
    "        const width = Math.max(1, texture.width >> mipLevel);\n" +
    "        const height = Math.max(1, texture.height >> mipLevel);\n" +
    "        const rowBytes = width * bytesPerTexel;\n" +
    "        const rowPitch = Math.ceil(rowBytes / 256) * 256;\n" +
    "        copies.push({ mipLevel, width, height, rowBytes, rowPitch, staged, packed: packedBytes });\n" +
    "        staged += rowPitch * height * layers;\n" +
    "        packedBytes += rowBytes * height * layers;\n" +
    "    }\n" +
    "    const readback = device.createBuffer({\n" +
    "        size: staged,\n" +
    "        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,\n" +
    "    });\n" +
    "    try {\n" +
    "        const encoder = device.createCommandEncoder();\n" +
    "        for (const copy of copies) {\n" +
    "            encoder.copyTextureToBuffer(\n" +
    "                { texture, mipLevel: copy.mipLevel },\n" +
    "                { buffer: readback, offset: copy.staged, bytesPerRow: copy.rowPitch, rowsPerImage: copy.height },\n" +
    "                { width: copy.width, height: copy.height, depthOrArrayLayers: layers },\n" +
    "            );\n" +
    "        }\n" +
    "        device.queue.submit([encoder.finish()]);\n" +
    "        await readback.mapAsync(GPUMapMode.READ);\n" +
    "        const mapped = new Uint8Array(readback.getMappedRange());\n" +
    "        const packed = new Uint8Array(packedBytes);\n" +
    "        for (const copy of copies) {\n" +
    "            const rows = copy.height * layers;\n" +
    "            if (copy.rowPitch === copy.rowBytes) {\n" +
    "                packed.set(mapped.subarray(copy.staged, copy.staged + rows * copy.rowBytes), copy.packed);\n" +
    "            } else {\n" +
    "                for (let row = 0; row < rows; row++) {\n" +
    "                    const from = copy.staged + row * copy.rowPitch;\n" +
    "                    packed.set(mapped.subarray(from, from + copy.rowBytes), copy.packed + row * copy.rowBytes);\n" +
    "                }\n" +
    "            }\n" +
    "        }\n" +
    "        return { packed };\n" +
    "    } finally {\n" +
    "        readback.destroy();\n" +
    "    }\n" +
    "};\n";

/**
 * Navigate to the page the suite scene server serves.
 *
 * Split out of `waitForSceneReady` because one harness loads that page and
 * then waits for a handshake of its own rather than the scene's: the
 * node-particle bake waits for the driver it was handed, not for a canvas
 * that will never be drawn.
 */
export async function gotoScenePage(
    page: Page,
    origin: string,
    search = "",
): Promise<void> {
    await page.goto(`${origin}/scene.html${search}`, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
    });
}

/**
 * The one browser-module transpile. Every local TypeScript module a
 * harness serves or evaluates goes through the same ES2022/ES2022
 * settings; three copies of this call had grown (the suite scene module,
 * the suite server's on-demand sibling transpile, the sprite-atlas
 * module), and settings drifting between them would make "the same
 * scene" mean different JavaScript per tool.
 */
export { transpileForBrowser };
