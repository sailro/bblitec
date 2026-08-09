#!/usr/bin/env node

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";

interface CompileAsset {
    source: string;
    output: string;
    kind: "environment" | "gltf" | "texture";
}

interface CompileManifest {
    assets: CompileAsset[];
}

const diagnosticTypes = [
    "world-normal",
    "albedo",
    "reflectivity",
    "irradiance",
    "normalized-depth",
] as const;

function browserCandidates(): string[] {
    if (process.platform === "win32") {
        return [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ];
    }
    if (process.platform === "darwin") {
        return [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ];
    }
    return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
}

function resolveBrowserPath(): string {
    const candidates = [process.env.CHROME_PATH, ...browserCandidates()]
        .filter((value): value is string => !!value);
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) throw new Error("No Chromium browser found. Set CHROME_PATH.");
    return found;
}

function mimeType(path: string): string {
    switch (extname(path).toLowerCase()) {
        case ".html":
            return "text/html; charset=utf-8";
        case ".js":
            return "text/javascript; charset=utf-8";
        case ".json":
            return "application/json";
        case ".png":
            return "image/png";
        case ".glb":
            return "model/gltf-binary";
        default:
            return "application/octet-stream";
    }
}

function assetBySuffix(manifest: CompileManifest, suffix: string): string {
    const asset = manifest.assets.find(({ source }) => source.toLowerCase().endsWith(suffix));
    if (!asset) throw new Error(`Generated manifest is missing ${suffix}.`);
    return `/generated/boombox/assets/${asset.output}`;
}

function diagnosticModule(manifest: CompileManifest): string {
    const glb = assetBySuffix(manifest, "boombox.glb");
    const environment = assetBySuffix(manifest, "environmentspecular.env");
    const brdf = assetBySuffix(manifest, "brdf-lut.png");
    return `
import {
    addTask,
    addTaskAtStart,
    addToScene,
    createCopyToTextureTask,
    createDefaultCamera,
    createEngine,
    createGeometryRendererTask,
    createHemisphericLight,
    createRenderTarget,
    createSceneContext,
    GeometryTextureType,
    loadEnvironment,
    loadGltf,
    registerScene,
    startEngine,
} from "/node_modules/@babylonjs/lite/lib/index.js";

const canvas = document.getElementById("renderCanvas");
const type = new URLSearchParams(location.search).get("type") ?? "world-normal";
try {
    const adapter = await navigator.gpu.requestAdapter();
    canvas.dataset.adapter = JSON.stringify(adapter?.info ?? {});
    const engine = await createEngine(canvas, {
        requiredLimits: { maxColorAttachmentBytesPerSample: 64 },
    });
    const scene = createSceneContext(engine, { defaultRenderTask: false });
    addToScene(scene, await loadGltf(engine, ${JSON.stringify(glb)}));
    await loadEnvironment(scene, ${JSON.stringify(environment)}, {
        brdfUrl: ${JSON.stringify(brdf)},
        skipGround: true,
        skipSkybox: true,
    });
    const camera = createDefaultCamera(scene);
    camera.alpha = 1.77538;
    scene.camera = camera;
    addToScene(scene, createHemisphericLight());

    const typeMap = {
        "world-normal": GeometryTextureType.WORLD_NORMAL,
        "albedo": GeometryTextureType.ALBEDO,
        "reflectivity": GeometryTextureType.REFLECTIVITY,
        "irradiance": GeometryTextureType.IRRADIANCE,
        "normalized-depth": GeometryTextureType.NORMALIZED_VIEW_DEPTH,
    };
    const geometry = createGeometryRendererTask(
        {
            name: "bblitec-diagnostic-" + type,
            samples: engine.msaaSamples,
            textureDescriptions: [{ type: typeMap[type] }],
        },
        engine,
        scene,
    );
    const sourceMap = {
        "world-normal": geometry.geometryWorldNormalTexture,
        "albedo": geometry.geometryAlbedoTexture,
        "reflectivity": geometry.geometryReflectivityTexture,
        "irradiance": geometry.geometryIrradianceTexture,
        "normalized-depth": geometry.geometryNormalizedViewDepthTexture,
    };
    const output = createRenderTarget({
        lbl: "bblitec-diagnostic-output",
        format: engine.format,
        samples: 1,
        size: engine,
    });
    addTaskAtStart(scene, geometry);
    addTask(scene, createCopyToTextureTask(
        {
            name: "bblitec-diagnostic-copy",
            sourceTexture: sourceMap[type],
            targetTexture: output,
        },
        engine,
        scene,
    ));
    addTask(scene, createCopyToTextureTask(
        {
            name: "bblitec-diagnostic-present",
            sourceTexture: output,
            targetTexture: engine.scRT,
        },
        engine,
        scene,
    ));
    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";
} catch (error) {
    canvas.dataset.error = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(error);
}
`;
}

async function main(): Promise<void> {
    const root = resolve(".");
    const outputDirectory = resolve("artifacts/parity/lite-diagnostics");
    const manifest = JSON.parse(
        readFileSync(resolve("generated/boombox/manifest.json"), "utf8"),
    ) as CompileManifest;
    const moduleSource = diagnosticModule(manifest);
    const html = `<!doctype html>
<html><head><style>
html,body,canvas{margin:0;width:1280px;height:720px;overflow:hidden;display:block}
</style></head><body><canvas id="renderCanvas" width="1280" height="720"></canvas>
<script type="module" src="/diagnostic.js"></script></body></html>`;
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/diagnostic.html") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(html);
            return;
        }
        if (url.pathname === "/diagnostic.js") {
            response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
            response.end(moduleSource);
            return;
        }
        const decoded = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        const path = resolve(root, decoded);
        if (!path.startsWith(`${root}${sep}`) || !existsSync(path) || !statSync(path).isFile()) {
            response.writeHead(404);
            response.end("Not found");
            return;
        }
        response.writeHead(200, {
            "Content-Type": mimeType(path),
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
        });
        response.end(readFileSync(path));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to start diagnostic server.");
    const browser = await chromium.launch({
        executablePath: resolveBrowserPath(),
        headless: true,
        args: ["--force-color-profile=srgb", "--enable-unsafe-webgpu"],
    });
    try {
        mkdirSync(outputDirectory, { recursive: true });
        const metadata: Record<string, unknown> = {
            browser: await browser.version(),
            capturedAt: new Date().toISOString(),
            outputs: {},
        };
        for (const type of diagnosticTypes) {
            const context = await browser.newContext({
                viewport: { width: 1280, height: 720 },
                deviceScaleFactor: 1,
            });
            const page = await context.newPage();
            await page.goto(
                `http://127.0.0.1:${address.port}/diagnostic.html?type=${type}`,
                { waitUntil: "domcontentloaded", timeout: 120_000 },
            );
            await page.waitForFunction(
                () => {
                    const canvas = document.getElementById("renderCanvas");
                    return canvas?.dataset.ready === "true" || !!canvas?.dataset.error;
                },
                undefined,
                { timeout: 120_000 },
            );
            const state = await page.locator("#renderCanvas").evaluate((canvas) => ({
                error: (canvas as HTMLCanvasElement).dataset.error,
                adapter: (canvas as HTMLCanvasElement).dataset.adapter,
            }));
            if (state.error) throw new Error(`${type}: ${state.error}`);
            await page.waitForTimeout(250);
            const output = resolve(outputDirectory, `babylon-lite-${type}.png`);
            await page.locator("#renderCanvas").screenshot({ path: output });
            (metadata.outputs as Record<string, unknown>)[type] = {
                output,
                adapter: state.adapter ? JSON.parse(state.adapter) : {},
            };
            await context.close();
            console.log(`Captured ${output}`);
        }
        writeFileSync(
            resolve(outputDirectory, "metadata.json"),
            `${JSON.stringify(metadata, null, 2)}\n`,
        );
    } finally {
        await browser.close();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
