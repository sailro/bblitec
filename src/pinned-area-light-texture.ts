/**
 * A rect area light's emission image, processed at generation.
 *
 * `processAreaLightTexture(engine, source)` is a closed function of the
 * source image, the options its `loadTexture2D` upload took, and the pin: it
 * renders a scaled, mirror-repeated copy of the source into a 1024x1024
 * `rgba8unorm` target, reads it back, runs the exact CPU Gaussian
 * (`area-light-blur.js`), uploads the result and fills the mip chain with the
 * GPU mipmap blitter. The scale pass and the mips are GPU render passes, so
 * generation runs the pin's own `loadTexture2D` and `processAreaLightTexture`
 * on the pin's engine in headless Chromium and reads back every level of the
 * texture the processor returned. The bytes depend on the Chrome that ran
 * them, as the HDR prefilter's do.
 *
 * Each image is cached on its own; the images that miss share one page. The
 * first miss opens it, every miss queued while it starts or processes joins
 * it, and it closes once the queue is empty.
 */
import type { Texture2DOptions } from "@babylonjs/lite";
import type { Page } from "playwright-core";
import {
    createSuiteSceneServer,
    pinnedBrowserEntryUrl,
} from "./capture-suite-reference.js";
import {
    decodePageBase64,
    gotoScenePage,
    pageBase64Script,
    pagePayloadHeader,
    pageTextureLevelsScript,
    webgpuComputeBrowserArgs,
    withBrowserPage,
} from "./browser-harness.js";
import { cachedBake, moduleIdentity } from "./bake-cache.js";
import { HOST_PRIMARY_CANVAS_ID } from "./host-primary-canvas.js";
import { mipChainBytes, mipChainViews } from "./mip-chain.js";

/** The processed emission image: the texture `processAreaLightTexture`
 *  returned, read back. */
export interface ProcessedAreaLightTexture {
    width: number;
    height: number;
    /** Every mip level, level zero first: tightly packed `rgba8unorm`
     *  texels in texture storage row order (row 0 samples source V=0). */
    levels: Uint8Array[];
}

/** The page global the driver installs: it processes one image. */
const areaLightTexturePageGlobal = "__processAreaLightTexture";

/** The page global a test observer stores what it recorded in. */
export const areaLightTextureObservedGlobal = "__areaLightTextureObserved";

/** One image to process. */
interface SourceImage {
    source: Uint8Array;
    loaderOptions: Texture2DOptions;
}

/** One image as it crosses into the page: the served path of its bytes. */
interface PageImage {
    url: string;
    loaderOptions: Texture2DOptions;
}

type ProcessImage = (image: SourceImage) => Promise<unknown>;

/** The driver: one engine per page, each image through the pinned loader and
 *  processor in call order, the returned texture's whole chain read back.
 *  Calls run one at a time, so a result crosses back while the next image
 *  processes. */
const processModule = `import { createEngine, loadTexture2D, processAreaLightTexture, releaseTexture } from ${JSON.stringify(pinnedBrowserEntryUrl)};

${pageBase64Script}${pageTextureLevelsScript}
let bblEngine;
let bblPrevious = Promise.resolve();
const bblProcess = async (image) => {
    bblEngine ??= createEngine(document.getElementById(${JSON.stringify(HOST_PRIMARY_CANVAS_ID)}));
    const engine = await bblEngine;
    const source = await loadTexture2D(engine, image.url, image.loaderOptions);
    const processed = await processAreaLightTexture(engine, source);
    const texture = processed.texture;
    if (texture.format !== "rgba8unorm") {
        throw new Error("processAreaLightTexture returned a " + texture.format + " texture; the read-back reads rgba8unorm texels.");
    }
    const { packed } = await bblReadTextureLevels(engine._device, texture, 4);
    releaseTexture(processed);
    releaseTexture(source);
    return { width: processed.width, height: processed.height, levels: texture.mipLevelCount, chain: bblBase64(packed) };
};
window.${areaLightTexturePageGlobal} = (image) => {
    const run = bblPrevious.then(() => bblProcess(image));
    bblPrevious = run.catch(() => undefined);
    return run;
};
`;

/** Open one driver page, `observer` appended to its module, and run `body`
 *  with the per-image call. Each image's bytes are served while its call
 *  runs: the suite server looks a virtual asset up per request. */
async function withDriverPage<T>(
    observer: string,
    body: (process: ProcessImage, page: Page) => Promise<T>,
): Promise<T> {
    const served: Record<string, Uint8Array> = {};
    let next = 0;
    return withBrowserPage(
        createSuiteSceneServer(processModule + observer, {
            virtualAssets: served,
        }),
        {
            serverName: "area light texture server",
            shared: true,
            browserRequirement:
                "Processing a rect area light emission texture requires Chrome or Edge.",
            browserArgs: webgpuComputeBrowserArgs,
        },
        async (page, origin) => {
            await gotoScenePage(page, origin);
            await page.waitForFunction(
                `typeof window.${areaLightTexturePageGlobal} === 'function'`,
                null,
                { timeout: 60_000 },
            );
            const process: ProcessImage = async ({ source, loaderOptions }) => {
                const url = `/area-light-texture-source/${next++}`;
                served[url] = source;
                try {
                    return await page.evaluate(
                        ({ name, image }) =>
                            (
                                globalThis as typeof globalThis &
                                    Record<
                                        string,
                                        (image: PageImage) => Promise<unknown>
                                    >
                            )[name]!(image),
                        {
                            name: areaLightTexturePageGlobal,
                            image: { url, loaderOptions },
                        },
                    );
                } finally {
                    delete served[url];
                }
            };
            return body(process, page);
        },
    );
}

/** The cached payload's header words: width, height, level count; the chain
 *  follows, levels concatenated. */
const headerWords = 3;

/** One page result as the cached payload, the chain decoded straight into
 *  it. */
function cachePayload(result: unknown): Uint8Array {
    if (
        typeof result !== "object" ||
        result === null ||
        !("width" in result) ||
        !("height" in result) ||
        !("levels" in result) ||
        !("chain" in result)
    )
        throw new Error(
            "The pinned area light texture processor returned no texture record.",
        );
    const { width, height, levels, chain } = result;
    if (
        typeof width !== "number" ||
        typeof height !== "number" ||
        typeof levels !== "number" ||
        typeof chain !== "string" ||
        ![width, height, levels].every(
            (value) => Number.isSafeInteger(value) && value >= 1,
        )
    )
        throw new Error(
            "The pinned area light texture processor returned a malformed texture record.",
        );
    return decodePageBase64(
        chain,
        [width, height, levels],
        mipChainBytes(width, height, levels, 4),
        `The pinned area light texture's ${width}x${height} rgba8unorm ` +
            `chain of ${levels} levels`,
    );
}

/** A cached payload as levels: views into its one buffer. */
function decodeProcessed(payload: Uint8Array): ProcessedAreaLightTexture {
    const [width = 0, height = 0, levelCount = 0] =
        pagePayloadHeader(payload, headerWords) ?? [];
    if (
        levelCount < 1 ||
        levelCount > 32 ||
        payload.byteLength !==
            headerWords * 4 + mipChainBytes(width, height, levelCount, 4)
    )
        throw new Error(
            "A processed area light texture payload does not hold its chain.",
        );
    const levels = mipChainViews(
        payload.subarray(headerWords * 4),
        width,
        height,
        levelCount,
        4,
    ).map(([level]) => level!);
    return { width, height, levels };
}

/** An image waiting for the shared page. */
interface QueuedImage {
    image: SourceImage;
    resolve: (payload: Uint8Array) => void;
    reject: (error: unknown) => void;
}

const queue: QueuedImage[] = [];
let draining = false;

/** Feed the queue to one page until it is empty: everything queued goes to
 *  the page at once, and what was queued meanwhile follows. Each image
 *  settles on its own; a page that fails to open rejects what waited on it,
 *  and an image queued while the page closes starts the next one. */
async function drainQueue(): Promise<void> {
    try {
        await withDriverPage("", async (process) => {
            while (queue.length > 0) {
                await Promise.all(
                    queue.splice(0).map(async ({ image, resolve, reject }) => {
                        try {
                            resolve(cachePayload(await process(image)));
                        } catch (error) {
                            reject(error);
                        }
                    }),
                );
            }
        });
    } catch (error) {
        for (const { reject } of queue.splice(0)) reject(error);
    } finally {
        draining = false;
        if (queue.length > 0) startDrain();
    }
}

function startDrain(): void {
    if (draining) return;
    draining = true;
    void drainQueue();
}

/**
 * One uncached run of the driver page over one image. `observer` is page
 * code appended to the driver module, in its scope; what it stores in
 * `window[areaLightTextureObservedGlobal]` comes back as `observed` (the
 * contract test records the pin's scaled intermediate so).
 */
export async function runAreaLightTexturePage(
    source: Uint8Array,
    loaderOptions: Texture2DOptions,
    observer: string,
): Promise<{ processed: ProcessedAreaLightTexture; observed: unknown }> {
    return withDriverPage(observer, async (process, page) => {
        const result = await process({ source, loaderOptions });
        return {
            processed: decodeProcessed(cachePayload(result)),
            observed: await page.evaluate(
                `window.${areaLightTextureObservedGlobal}`,
            ),
        };
    });
}

/**
 * `processAreaLightTexture(engine, await loadTexture2D(engine, url,
 * loaderOptions))` for the image bytes behind `url`, every mip level read
 * back. Deterministic in (source, loader options, pin, browser), the
 * bake-cache key, so a repeat compile replays the levels from one read.
 */
export async function bakeAreaLightTexture(
    source: Uint8Array,
    loaderOptions: Texture2DOptions,
): Promise<ProcessedAreaLightTexture> {
    return decodeProcessed(
        await cachedBake(
            {
                kind: "area-light-texture",
                version: "2",
                module: moduleIdentity(import.meta.url),
                browser: true,
                parameters: { loaderOptions },
                inputs: [source],
            },
            () =>
                new Promise<Uint8Array>((resolve, reject) => {
                    queue.push({
                        image: { source, loaderOptions },
                        resolve,
                        reject,
                    });
                    startDrain();
                }),
        ),
    );
}
