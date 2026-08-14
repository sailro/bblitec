import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import ts from "typescript";
import { chromium } from "playwright-core";
import { readUpstreamPin } from "./upstream-source.js";
import { resolveBrowserPath } from "./browser-path.js";


function mimeType(path: string): string {
    switch (extname(path).toLowerCase()) {
        case ".html":
            return "text/html; charset=utf-8";
        case ".js":
            return "text/javascript; charset=utf-8";
        default:
            return "application/octet-stream";
    }
}

export type SuiteSourceTransform = (source: string) => string;

export function suiteBrowserModule(
    sourcePath: string,
    transform?: SuiteSourceTransform,
    captureTimeSeconds?: number,
    captureFrameRate = 60,
    captureAnimationGroups?: string[],
): string {
    const input = readFileSync(resolve(sourcePath), "utf8");
    const transformed = transform ? transform(input) : input;
    const framed = captureTimeSeconds !== undefined
        ? (
              `import { ` +
              `onBeforeRender as __captureOnBeforeRender, ` +
              `goToFrame as __captureGoToFrame, ` +
              `pauseAnimation as __capturePauseAnimation ` +
              `} from "babylon-lite";\n` +
              transformed
          ).replace(
              "await registerScene(scene);",
              `let __animationSeekFrame = 0;
    __captureOnBeforeRender(scene, () => {
        __animationSeekFrame += 1;
        if (__animationSeekFrame === 10) {
            for (const animationGroup of ${
                captureAnimationGroups?.length
                    ? `[${captureAnimationGroups.join(", ")}]`
                    : "scene.animationGroups"
            }) {
                __captureGoToFrame(animationGroup, ${captureTimeSeconds} * ${captureFrameRate});
                __capturePauseAnimation(animationGroup);
            }
            canvas.dataset.animationFrozen = "true";
        }
    });
    await registerScene(scene);`,
          )
        : transformed;
    const source = framed
        .replaceAll('"@babylonjs/lite"', '"/node_modules/@babylonjs/lite/lib/index.js"')
        .replaceAll('"babylon-lite"', '"/node_modules/@babylonjs/lite/lib/index.js"')
        .replaceAll(
            '"/brdf-lut.png"',
            `"https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/${readUpstreamPin().sourceVersion}/packages/babylon-lite/assets/brdf-lut.png"`,
        );
    const readySource = source.includes("dataset.ready")
        ? source
        : source.replace(
              "await startEngine(engine);",
              'await startEngine(engine); canvas.dataset.ready = "true";',
          );
    return ts.transpileModule(readySource, {
        compilerOptions: {
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2022,
        },
        fileName: sourcePath,
    }).outputText;
}

/**
 * The pinned deterministic Math.random contract: mulberry32 over seed 1,
 * matching bbl::js::random_js in native/include/bblite/js_data.hpp. The
 * stub runs in a plain script before the scene module loads.
 */
export const seededRandomScript =
    "Math.random = (() => { let s = 1 >>> 0; return () => {" +
    " s = (s + 0x6D2B79F5) | 0;" +
    " let t = Math.imul(s ^ (s >>> 15), 1 | s);" +
    " t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;" +
    " return ((t ^ (t >>> 14)) >>> 0) / 4294967296;" +
    " }; })();";

export interface SuiteCaptureOptions {
    seededRandom?: boolean;
}

export function createSuiteSceneServer(
    moduleSource: string,
    options: SuiteCaptureOptions = {},
): ReturnType<typeof createServer> {
    const root = resolve(".");
    const seedScript = options.seededRandom
        ? `<script>${seededRandomScript}</script>\n`
        : "";
    const html = `<!doctype html><html><head><style>
html,body,canvas{margin:0;width:1280px;height:720px;overflow:hidden;display:block}
</style></head><body><canvas id="renderCanvas" width="1280" height="720"></canvas>
${seedScript}<script type="module" src="/scene.js"></script></body></html>`;
    const pinnedAssets = new Map<
        string,
        { bytes: Uint8Array; contentType: string }
    >();
    return createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/scene.html") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(html);
            return;
        }
        if (url.pathname === "/scene.js") {
            response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
            response.end(moduleSource);
            return;
        }
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        const path = resolve(root, relative);
        // Local TypeScript modules referenced with ESM ".js" specifiers
        // (corpus demo modules, example helpers) transpile on demand.
        if (
            url.pathname.endsWith(".js") &&
            (!existsSync(path) || !statSync(path).isFile())
        ) {
            const typescriptPath = `${path.slice(0, -3)}.ts`;
            if (
                typescriptPath.startsWith(`${root}${sep}`) &&
                existsSync(typescriptPath) &&
                statSync(typescriptPath).isFile()
            ) {
                const moduleText = readFileSync(typescriptPath, "utf8")
                    .replaceAll('"@babylonjs/lite"', '"/node_modules/@babylonjs/lite/lib/index.js"')
                    .replaceAll('"babylon-lite"', '"/node_modules/@babylonjs/lite/lib/index.js"');
                response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
                response.end(
                    ts.transpileModule(moduleText, {
                        compilerOptions: {
                            module: ts.ModuleKind.ES2022,
                            target: ts.ScriptTarget.ES2022,
                        },
                        fileName: typescriptPath,
                    }).outputText,
                );
                return;
            }
        }
        if (!path.startsWith(`${root}${sep}`) || !existsSync(path) || !statSync(path).isFile()) {
            // Pinned lab/public assets back every scene source: corpus
            // scenes and project-owned gates share the demo asset roots.
            {
                const cached = pinnedAssets.get(
                    url.pathname,
                );
                if (cached) {
                    response.writeHead(200, {
                        "Content-Type":
                            cached.contentType,
                    });
                    response.end(cached.bytes);
                    return;
                }
                const pin = readUpstreamPin();
                const assetUrl =
                    "https://raw.githubusercontent.com/" +
                    `BabylonJS/Babylon-Lite/${pin.sourceVersion}` +
                    `/lab/public/${relative}`;
                let fetched: Response;
                try {
                    fetched = await fetch(assetUrl, {
                        signal: AbortSignal.timeout(30_000),
                    });
                } catch (error: unknown) {
                    response.writeHead(502);
                    response.end(
                        error instanceof Error
                            ? error.message
                            : String(error),
                    );
                    return;
                }
                if (fetched.ok) {
                    const asset = {
                        bytes: new Uint8Array(
                            await fetched.arrayBuffer(),
                        ),
                        contentType:
                            fetched.headers.get(
                                "content-type",
                            ) ?? mimeType(url.pathname),
                    };
                    pinnedAssets.set(
                        url.pathname,
                        asset,
                    );
                    response.writeHead(200, {
                        "Content-Type":
                            asset.contentType,
                    });
                    response.end(asset.bytes);
                    return;
                }
            }
            response.writeHead(404);
            response.end("Not found");
            return;
        }
        response.writeHead(200, { "Content-Type": mimeType(path) });
        response.end(readFileSync(path));
    });
}

export async function captureSuiteReference(
    sourcePath: string,
    referencePath: string,
    force: boolean,
    transform?: SuiteSourceTransform,
    captureTimeSeconds?: number,
    captureFrameRate?: number,
    captureAnimationGroups?: string[],
    options: SuiteCaptureOptions = {},
): Promise<void> {
    if (existsSync(referencePath) && !force) return;
    const moduleSource = suiteBrowserModule(
        sourcePath,
        transform,
        captureTimeSeconds,
        captureFrameRate,
        captureAnimationGroups,
    );
    const server = createSuiteSceneServer(moduleSource, options);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to start parity server.");
    const browser = await chromium.launch({
        executablePath: resolveBrowserPath(),
        headless: true,
        args: ["--force-color-profile=srgb", "--enable-unsafe-webgpu"],
    });
    try {
        const page = await browser.newPage({
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 1,
        });
        page.on("pageerror", (error) => {
            console.error(`Reference page error: ${error.message}`);
        });
        page.on("console", (message) => {
            if (message.type() === "error") {
                console.error(
                    `Reference console error: ${message.text()}`,
                );
            }
        });
        await page.goto(`http://127.0.0.1:${address.port}/scene.html`, {
            waitUntil: "domcontentloaded",
            timeout: 120_000,
        });
        await page.waitForFunction(
            () => document.getElementById("renderCanvas")?.dataset.ready === "true",
            undefined,
            { timeout: 120_000 },
        );
        if (captureTimeSeconds !== undefined) {
            await page.waitForFunction(
                () =>
                    document.getElementById("renderCanvas")
                        ?.dataset.animationFrozen === "true",
                undefined,
                { timeout: 120_000 },
            );
        }
        await page.waitForTimeout(3000);
        mkdirSync(resolve(referencePath, ".."), { recursive: true });
        await page.locator("#renderCanvas").screenshot({ path: referencePath });
    } finally {
        await browser.close();
        await new Promise<void>((done) => server.close(() => done()));
    }
}
