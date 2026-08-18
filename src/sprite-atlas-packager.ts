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
import { chromium } from "playwright-core";
import ts from "typescript";
import { resolveBrowserPath } from "./browser-path.js";

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

export function parseSpriteAtlasAssetSource(
    source: string,
    repositoryRoot: string,
): SpriteAtlasSource {
    const rest = source.slice(spriteAtlasSourcePrefix.length);
    const separator = rest.lastIndexOf("#");
    if (separator < 0) {
        throw new Error(
            `Malformed drawn sprite-atlas asset source '${source}'.`,
        );
    }
    return {
        modulePath: resolve(repositoryRoot, rest.slice(0, separator)),
        exportName: rest.slice(separator + 1),
    };
}

function transpileModule(modulePath: string): string {
    return ts.transpileModule(readFileSync(modulePath, "utf8"), {
        compilerOptions: {
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2022,
        },
        fileName: modulePath,
    }).outputText;
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

/**
 * Run the pinned atlas module in headless Chromium and return the PNG bytes
 * its factory draws.
 */
export async function drawSpriteAtlasPng(
    source: SpriteAtlasSource,
): Promise<Uint8Array> {
    const moduleName = basename(source.modulePath).replace(/\.ts$/, ".js");
    const moduleSource = transpileModule(source.modulePath);
    const html =
        "<!doctype html><html><head><title>Sprite atlas</title></head>" +
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
    await new Promise<void>((ready) =>
        server.listen(0, "127.0.0.1", ready),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new Error("Unable to start the sprite-atlas server.");
    }

    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
        browser = await chromium.launch({
            executablePath: resolveBrowserPath(
                "Drawing a canvas2D sprite atlas requires Chrome or Edge.",
            ),
            headless: true,
        });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${address.port}/`);
        const dataUrl: unknown = await page.evaluate(
            `import("/${moduleName}").then((module) => {
                const factory = module[${JSON.stringify(source.exportName)}];
                if (typeof factory !== "function") {
                    throw new Error(
                        "Pinned sprite atlas export ${source.exportName} is not a function."
                    );
                }
                return factory();
            })`,
        );
        if (typeof dataUrl !== "string") {
            throw new Error(
                `Pinned sprite atlas export ${source.exportName} did not return a data URL.`,
            );
        }
        return decodeDataUrl(dataUrl);
    } finally {
        await browser?.close();
        server.close();
    }
}

