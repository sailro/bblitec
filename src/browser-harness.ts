// The one server-listen -> Chromium-launch -> page-drive -> teardown
// ceremony.
//
// Five tools run a page in a real Chromium: the golden-suite capture
// (`capture-suite-reference.ts`), the instrumented diagnostics capture
// (`capture-instrumented.ts`), the pinned HDR GGX prefilter
// (`hdr-prefilter-gpu.ts`), the drawn sprite-atlas baker
// (`sprite-atlas-packager.ts`), and the pinned BRDF-LUT baker
// (`ibl-brdf-lut.ts`). Each carried its own copy of the ceremony, the
// same way each once carried its own copy of the browser list -- and that
// copy had already drifted once (`browser-path.ts` records it). This
// module is the one copy of the ceremony; `browser-path.ts` stays the one
// copy of where the browser lives.
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
import ts from "typescript";
import { resolveBrowserPath } from "./browser-path.js";

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
): Promise<void> {
    await page.goto(`${origin}/scene.html`, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
    });
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
    await page.waitForTimeout(3000);
}

/**
 * The one browser-module transpile. Every local TypeScript module a
 * harness serves or evaluates goes through the same ES2022/ES2022
 * settings; three copies of this call had grown (the suite scene module,
 * the suite server's on-demand sibling transpile, the sprite-atlas
 * module), and settings drifting between them would make "the same
 * scene" mean different JavaScript per tool.
 */
export function transpileForBrowser(
    source: string,
    fileName: string,
): string {
    return ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2022,
        },
        fileName,
    }).outputText;
}
