/**
 * Sprite atlases that are DRAWN rather than fetched.
 *
 * `lab/lite/src/_shared/sprite-atlas-image.ts` builds its 256x128 atlas with
 * canvas2D and returns a data URL, so there is no file to download and no
 * pixels to lower. The pixels are a browser rasterizer's: `arc`, the rotated
 * wedge and `hsl` all antialias in ways nothing outside a browser reproduces.
 *
 * So the module is executed rather than reimplemented. Generation already
 * launches headless Chromium for the pinned GGX prefilter, the golden capture
 * and the instrumented capture; this serves the pinned module from a local
 * server, calls its exported factory in the page, and bakes the PNG bytes the
 * data URL carries as a generated asset.
 *
 * The tradeoff is the HDR prefilter's, and it is the same one: the baked
 * bytes depend on the Chrome that compiled them.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
    transpileForBrowser,
    withBrowserPage,
} from "./browser-harness.js";

/** A drawn atlas: the module that draws it and the factory that returns it. */
export interface SpriteAtlasSource {
    /** Absolute path of the pinned `.ts` module. */
    modulePath: string;
    /** Exported zero-argument function returning a PNG data URL. */
    exportName: string;
}

/** The `source` string a drawn atlas carries through the asset list. */
export const spriteAtlasSourcePrefix = "generated:sprite-atlas:";

export function spriteAtlasAssetSource(
    repositoryRelativeModulePath: string,
    exportName: string,
): string {
    return `${spriteAtlasSourcePrefix}${repositoryRelativeModulePath}#${exportName}`;
}

function parseGeneratedSource(
    source: string,
    prefix: string,
    repositoryRoot: string,
    label: string,
): SpriteAtlasSource {
    const rest = source.slice(prefix.length);
    const separator = rest.lastIndexOf("#");
    if (separator < 0) {
        throw new Error(
            `Malformed generated ${label} asset source '${source}'.`,
        );
    }
    return {
        modulePath: resolve(repositoryRoot, rest.slice(0, separator)),
        exportName: rest.slice(separator + 1),
    };
}

export function parseSpriteAtlasAssetSource(
    source: string,
    repositoryRoot: string,
): SpriteAtlasSource {
    return parseGeneratedSource(
        source,
        spriteAtlasSourcePrefix,
        repositoryRoot,
        "drawn sprite-atlas",
    );
}

function decodeDataUrl(dataUrl: string): Uint8Array {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match?.[1]) {
        throw new Error(
            "A drawn sprite atlas must return a base64 image/png data URL.",
        );
    }
    return new Uint8Array(Buffer.from(match[1], "base64"));
}

/** The `source` string baked pixel bytes carry through the asset list. */
export const pixelsSourcePrefix = "generated:pixels:";

export function pixelsAssetSource(
    repositoryRelativeModulePath: string,
    exportName: string,
): string {
    return `${pixelsSourcePrefix}${repositoryRelativeModulePath}#${exportName}`;
}

export function parsePixelsAssetSource(
    source: string,
    repositoryRoot: string,
): SpriteAtlasSource {
    return parseGeneratedSource(
        source,
        pixelsSourcePrefix,
        repositoryRoot,
        "pixels",
    );
}

/**
 * Run a scene-adjacent module in headless Chromium and return what its
 * zero-argument export produced.
 *
 * Both compile-time module assets go through here. They are baked for
 * different reasons — an atlas because only a browser rasterizer draws those
 * pixels, a palette because its bytes are `Math.sin` rounded to integers and
 * a last-ulp difference between one libm and another flips an entry — but
 * the answer is the same in both cases: run the module the golden runs, in
 * the engine the golden runs it in, and keep what it returned.
 */
async function evaluateModuleExport(
    source: SpriteAtlasSource,
    label: string,
    browserRequirement: string,
): Promise<unknown> {
    const moduleName = basename(source.modulePath).replace(/\.ts$/, ".js");
    const moduleSource = transpileForBrowser(
        readFileSync(source.modulePath, "utf8"),
        source.modulePath,
    );
    const html =
        `<!doctype html><html><head><title>${label}</title></head>` +
        "<body></body></html>";

    const server = createServer((request, response) => {
        if ((request.url ?? "/") === `/${moduleName}`) {
            response.writeHead(200, {
                "Content-Type": "text/javascript; charset=utf-8",
            });
            response.end(moduleSource);
            return;
        }
        response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
        });
        response.end(html);
    });
    return withBrowserPage(server, {
        serverName: `${label} server`,
        browserRequirement,
    }, async (page, origin) => {
        await page.goto(`${origin}/`);
        return page.evaluate(
            `import("/${moduleName}").then((module) => {
                const factory = module[${JSON.stringify(source.exportName)}];
                if (typeof factory !== "function") {
                    throw new Error(
                        "Module export ${source.exportName} is not a function."
                    );
                }
                const value = factory();
                // A typed array does not survive the page boundary as one.
                return ArrayBuffer.isView(value)
                    ? Array.from(new Uint8Array(
                          value.buffer,
                          value.byteOffset,
                          value.byteLength))
                    : value;
            })`,
        );
    });
}

/**
 * Run the pinned atlas module in headless Chromium and return the PNG bytes
 * its factory draws.
 */
export async function drawSpriteAtlasPng(
    source: SpriteAtlasSource,
): Promise<Uint8Array> {
    const dataUrl = await evaluateModuleExport(
        source,
        "Sprite atlas",
        "Drawing a canvas2D sprite atlas requires Chrome or Edge.",
    );
    if (typeof dataUrl !== "string") {
        throw new Error(
            `Sprite atlas export ${source.exportName} did not return a data URL.`,
        );
    }
    return decodeDataUrl(dataUrl);
}

/**
 * Run a pixel-buffer module in headless Chromium and return the bytes its
 * factory built, as the texture upload takes them.
 */
export async function bakePixelBytes(
    source: SpriteAtlasSource,
): Promise<Uint8Array> {
    const bytes = await evaluateModuleExport(
        source,
        "Pixel buffer",
        "Baking a computed pixel buffer requires Chrome or Edge.",
    );
    if (
        !Array.isArray(bytes) ||
        bytes.some(
            (byte) =>
                typeof byte !== "number" ||
                !Number.isInteger(byte) ||
                byte < 0 ||
                byte > 255,
        )
    ) {
        throw new Error(
            `Pixel buffer export ${source.exportName} did not return a byte array.`,
        );
    }
    return new Uint8Array(bytes as number[]);
}

