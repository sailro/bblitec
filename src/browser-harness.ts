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
//   compute harnesses pass only the WebGPU flag; the canvas2D atlas
//   passes none. The three baked-byte harnesses (HDR, LUT, atlas) feed
//   golden-checked or committed assets, so their flag sets must stay
//   byte-for-byte what shipped: `browserArgs` is exact per caller and
//   never defaulted.
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
// Incidental drift, unified --
// - A non-numeric listen address now closes the server before throwing
//   (the two capture copies threw with it open) and uniformly reads
//   "Unable to start the <serverName>."; the golden capture's message
//   gains its previously missing "the".
// - The launch now happens inside the guarded region: a Chromium that
//   fails to launch closes the server instead of leaking it and hanging
//   the process (the two capture copies launched before their `try`).
// - Teardown is uniformly `await browser?.close()` then an awaited
//   `server.close` whose error propagates -- the shape the two
//   golden-checked compute harnesses already had, so their observable
//   behavior is unchanged. The capture copies used to swallow close
//   errors and the atlas never awaited its close; a close error is only
//   reachable when closing a server that is not running, which none of
//   these paths can produce.
import type { Server } from "node:http";
import { chromium, type Page } from "playwright-core";
import { transpileForBrowser } from "./typescript-transpile.js";
import { resolveBrowserPath } from "./browser-path.js";
import { captureSettleMilliseconds } from "./capture-timing.js";

/** The screenshot harnesses' flags: the sRGB pin keeps golden bytes
 *  independent of the host display profile, and WebGPU is what the
 *  pinned engine renders through. */
export const screenshotCaptureBrowserArgs = [
    "--force-color-profile=srgb",
    "--enable-unsafe-webgpu",
] as const;

/** The compute harnesses' flags: WebGPU alone. They read buffers back
 *  rather than rasterizing the page, but their baked bytes are pinned to
 *  the Chrome that ran them, so the set stays exactly what shipped. */
export const webgpuComputeBrowserArgs = [
    "--enable-unsafe-webgpu",
] as const;

export interface BrowserPageOptions {
    /** What a failed ephemeral listen names:
     *  "Unable to start the <serverName>." */
    serverName: string;
    /** Why the caller cannot proceed without Chromium;
     *  `resolveBrowserPath`'s generic message otherwise. */
    browserRequirement?: string;
    /** Chromium flags, exact per harness (see the catalogue above). */
    browserArgs?: readonly string[];
    /** Pin the page to this viewport at deviceScaleFactor 1. The
     *  screenshot harnesses pass the golden's 1280x720; the compute
     *  harnesses omit it. */
    viewport?: { width: number; height: number };
    /** Log `pageerror` events as `<prefix>: <message>`; silent without. */
    pageErrorPrefix?: string;
    /** Log console error messages as `<prefix>: <text>`; silent
     *  without. */
    consoleErrorPrefix?: string;
}

/**
 * Serve `server` on an ephemeral 127.0.0.1 port, launch the resolved
 * Chromium headless, open one page, run `body` with the page and the
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
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
        browser = await chromium.launch({
            executablePath: resolveBrowserPath(options.browserRequirement),
            headless: true,
            ...(options.browserArgs
                ? { args: [...options.browserArgs] }
                : {}),
        });
        const page = await browser.newPage(
            options.viewport
                ? {
                      viewport: options.viewport,
                      deviceScaleFactor: 1,
                  }
                : undefined,
        );
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
                    console.error(
                        `${consoleErrorPrefix}: ${message.text()}`,
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
): Promise<void> {
    await gotoScenePage(page, origin, search);
    await page.waitForFunction(
        () =>
            document.getElementById("renderCanvas")?.dataset.ready ===
            "true",
        undefined,
        { timeout: 120_000 },
    );
    if (awaitFrozenPose) {
        await page.waitForFunction(
            () =>
                document.getElementById("renderCanvas")?.dataset
                    .animationFrozen === "true",
            undefined,
            { timeout: 120_000 },
        );
    }
    if (fixedAnimationFrame !== undefined) {
        const canvas = page.locator("#renderCanvas");
        const expectedCaptureFrame = String(fixedAnimationFrame);
        const deadline = Date.now() + 120_000;
        try {
            while (
                (await canvas.getAttribute("data-fixed-capture-frame")) !==
                expectedCaptureFrame
            ) {
                if (Date.now() >= deadline) {
                    throw new Error("Timed out waiting for fixed browser RAF.");
                }
                await page.waitForTimeout(25);
            }
        } catch (error) {
            const frame = await canvas.getAttribute(
                "data-fixed-animation-frame",
            );
            const captureFrame = await canvas.getAttribute(
                "data-fixed-capture-frame",
            );
            const callbacks = await canvas.getAttribute(
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
    } else {
        await page.waitForTimeout(captureSettleMilliseconds);
    }
}

/**
 * Hide everything the demo page draws OUTSIDE its canvas, before the shot.
 *
 * This is the CANVAS-ONLY attribution mode's tool. Since retained UI
 * became product support the port DOES reproduce reached DOM/CSS
 * (through RmlUi -- docs/ui.md), and the canonical goldens are full-page
 * by default; `BBLITE_CAPTURE_UI=0` requests the canvas-only capture
 * that subtracts the UI from a residual, and that mode is where this
 * helper runs. Both screenshot harnesses take it through the same
 * `captureUiEnabled()` fork, so the golden and the instrumented capture
 * cannot disagree about what a screenshot contains.
 *
 * Every scene keeps its own page otherwise: this hides siblings of the
 * canvas, it does not touch the scene or anything the scene drew into the
 * canvas. It does suppress the canvas's host focus outline: that decoration
 * is retained UI, not a canvas pixel, and otherwise survives after every
 * sibling was hidden. A scene whose behaviour depends on DOM the port does not
 * reproduce (a control that must be clicked before the frame under test)
 * is out of scope -- see docs/fidelity.md.
 */
export async function hideNonCanvasChrome(page: Page): Promise<void> {
    await page.evaluate(() => {
        const canvas = document.getElementById("renderCanvas");
        if (canvas instanceof HTMLElement) {
            canvas.style.outline = "none";
        }
        for (const element of Array.from(document.body.children)) {
            if (element !== canvas) {
                (element as HTMLElement).style.visibility = "hidden";
            }
        }
    });
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
 * The page-side chunked base64 encoder, as a source fragment.
 *
 * Bytes cross the page boundary as text because the boundary serializes
 * JSON: a number per byte costs about four bytes of wire each and turns a
 * megapixel read-back into ten seconds. The chunking is what keeps
 * `String.fromCharCode` off its argument limit, and it is one copy because
 * four harnesses had grown four.
 */
export const pageBase64Script =
    "const bblBase64 = (bytes) => {\n" +
    "    let binary = \"\";\n" +
    "    for (let index = 0; index < bytes.length; index += 0x8000) {\n" +
    "        binary += String.fromCharCode.apply(\n" +
    "            null,\n" +
    "            bytes.subarray(index, index + 0x8000),\n" +
    "        );\n" +
    "    }\n" +
    "    return btoa(binary);\n" +
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
