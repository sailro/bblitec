import { pageBase64Script } from "../browser-harness.js";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import ts from "typescript";

import { cachedBakeSync, moduleIdentity } from "../bake-cache.js";
import { runGenerationChild } from "./generation-child.js";

interface FetchedCanvasAtlasImage {
    source: string;
    logicalPath: string;
}

interface FetchedCanvasAtlasBake {
    pixels: Uint8Array;
    images: FetchedCanvasAtlasImage[];
}

/**
 * The closed image directory consumed by the fetched-atlas bake. Retained UI
 * in the same application also selects these files by URL, so generation
 * packages the exact source PNGs at those browser-visible paths.
 */
function fetchedCanvasAtlasImages(
    atlasFileName: string,
): FetchedCanvasAtlasImage[] {
    const directory = dirname(atlasFileName);
    const assetDirectory = join(directory, "voxelpack");
    const logicalDirectory = `${basename(directory)}/voxelpack`;
    return readdirSync(assetDirectory)
        .filter((name) => name.toLowerCase().endsWith(".png"))
        .sort()
        .map((name) => ({
            source: join(assetDirectory, name),
            logicalPath: `${logicalDirectory}/${name}`,
        }));
}

/**
 * Execute a fetched-image Canvas2D atlas in the capture browser and return the
 * exact RGBA bytes handed to createTexture2DFromPixels.
 *
 * The bounded shape is the voxel sandbox's source-owned atlas module: its
 * sibling blocks module owns tile order, the atlas module owns Canvas2D
 * scaling/composition, and the only substitution is the final GPU upload,
 * which returns its byte argument to the bake driver.
 */
export function bakeFetchedCanvasAtlas(
    atlasFileName: string,
): FetchedCanvasAtlasBake {
    const directory = dirname(atlasFileName);
    const blocksFileName = join(directory, "blocks.ts");
    const assetDirectory = join(directory, "voxelpack");
    const atlasSource = readFileSync(atlasFileName, "utf8");
    const blocksSource = readFileSync(blocksFileName, "utf8");
    if (
        !atlasSource.includes("createImageBitmap") ||
        !atlasSource.includes("ctx.drawImage") ||
        !atlasSource.includes("ctx.getImageData") ||
        !blocksSource.includes("allReferencedTiles")
    ) {
        throw new Error(
            "Fetched Canvas2D atlas source no longer matches the bounded bake shape.",
        );
    }
    const images = fetchedCanvasAtlasImages(atlasFileName);
    const assets = images.map(
        ({ source, logicalPath }) => ({
            name: logicalPath.split("/").pop()!,
            bytes: readFileSync(source),
        }),
    );
    const transpile = (source: string, fileName: string): string =>
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
            },
            fileName,
        }).outputText;
    const atlasJavascript = transpile(atlasSource, atlasFileName);
    const blocksJavascript = transpile(blocksSource, blocksFileName);
    const inputs = [
        Buffer.from(atlasJavascript, "utf8"),
        Buffer.from(blocksJavascript, "utf8"),
        ...assets.flatMap(({ name, bytes }) => [Buffer.from(name, "utf8"), bytes]),
    ];
    return {
        images,
        pixels: cachedBakeSync(
            {
                kind: "fetched-canvas-atlas",
                version: "1",
                module: moduleIdentity(import.meta.url),
                browser: true,
                parameters: { atlas: atlasFileName },
                inputs,
            },
            () =>
                runFetchedCanvasAtlas(
                    atlasJavascript,
                    blocksJavascript,
                    assetDirectory,
                ),
        ),
    };
}

function runFetchedCanvasAtlas(
    atlasJavascript: string,
    blocksJavascript: string,
    assetDirectory: string,
): Uint8Array {
    const harnessModule = new URL("../browser-harness.js", import.meta.url).href;
    const base64Helper = `${pageBase64Script}globalThis.__bblBase64 = bblBase64;`;
    const script = `
        import { createServer } from "node:http";
        import { readFileSync } from "node:fs";
        import { basename, join } from "node:path";
        import { withBrowserPage } from ${JSON.stringify(harnessModule)};
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const evaluateCommonJs = (code, require) => {
            const module = { exports: {} };
            new Function("module", "exports", "require", code)(module, module.exports, require);
            return module.exports;
        };
        const blocks = evaluateCommonJs(input.blocks, () => ({}));
        const tileNames = blocks.allReferencedTiles();
        const server = createServer((request, response) => {
            const url = new URL(request.url ?? "/", "http://127.0.0.1");
            if (url.pathname.startsWith("/voxelpack/")) {
                const name = basename(decodeURIComponent(url.pathname));
                try {
                    const bytes = readFileSync(join(input.assetDirectory, name));
                    response.writeHead(200, { "Content-Type": "image/png" });
                    response.end(bytes);
                } catch {
                    response.writeHead(404);
                    response.end();
                }
                return;
            }
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end("<!doctype html><title>Fetched Canvas2D atlas</title>");
        });
        const base64 = await withBrowserPage(
            server,
            {
                serverName: "fetched Canvas2D atlas server",
                browserRequirement: "Fetched Canvas2D atlas generation requires Chromium.",
            },
            async (page, origin) => {
                await page.goto(origin);
                await page.addScriptTag({ content: ${JSON.stringify(base64Helper)} });
                return page.evaluate(
                    async ({ code, names, root }) => {
                        const module = { exports: {} };
                        const require = (name) => {
                            if (name !== "babylon-lite") throw new Error("Unexpected atlas import: " + name);
                            return {
                                createTexture2DFromPixels: (_engine, pixels, width, height) => ({ pixels, width, height }),
                            };
                        };
                        new Function("module", "exports", "require", code)(module, module.exports, require);
                        const atlas = await module.exports.buildBlockAtlas({}, root + "/voxelpack", names);
                        return globalThis.__bblBase64(atlas.texture.pixels);
                    },
                    { code: input.atlas, names: tileNames, root: origin },
                );
            },
        );
        process.stdout.write(base64);
    `;
    return new Uint8Array(
        Buffer.from(
            runGenerationChild({
                script,
                label: "Generation-time fetched Canvas2D atlas",
                input: JSON.stringify({
                    atlas: atlasJavascript,
                    blocks: blocksJavascript,
                    assetDirectory,
                }),
            }),
            "base64",
        ),
    );
}
