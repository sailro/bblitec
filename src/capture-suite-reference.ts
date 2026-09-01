import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import {
    extname,
    relative,
    resolve,
    sep,
} from "node:path";
import type { NativeHostUi } from "./compiler/types.js";

// ---------------------------------------------------------------------------
// Lazy module loads
//
// This module sits on the parity path's import chain, and the cached-
// reference path — every parity child in a matrix run — used to pay 431 of
// its 544 ms import cost loading playwright-core and typescript through the
// static imports here (browser-harness, upstream-source, compiler/symbols)
// without ever calling them: `captureSuiteReference` returns before touching
// a browser when the golden is already on disk. Each module is loaded on
// first use instead. The loads are synchronous (`require` of an ES module,
// which Node supports unflagged from 22.12 — `package.json` pins the
// engine) because the composers that need them (`suiteBrowserModule`,
// the suite server's on-demand transpile) are synchronous exports with
// callers outside this module.
// ---------------------------------------------------------------------------

const requireModule = createRequire(import.meta.url);

function lazyModule<T>(specifier: string): () => T {
    let loaded: T | undefined;
    return () => (loaded ??= requireModule(specifier) as T);
}

const browserHarness =
    lazyModule<typeof import("./browser-harness.js")>(
        "./browser-harness.js",
    );
const upstreamSource =
    lazyModule<typeof import("./upstream-source.js")>(
        "./upstream-source.js",
    );
const compilerSymbols =
    lazyModule<typeof import("./compiler/symbols.js")>(
        "./compiler/symbols.js",
    );


/** The types this table is confident about, or undefined. */
function knownMimeType(path: string): string | undefined {
    const known = mimeType(path);
    return known === "application/octet-stream" ? undefined : known;
}

function mimeType(path: string): string {
    switch (extname(path).toLowerCase()) {
        case ".html":
            return "text/html; charset=utf-8";
        case ".js":
            return "text/javascript; charset=utf-8";
        case ".wasm":
            // Emscripten instantiates through `WebAssembly.instantiateStreaming`,
            // which requires this exact type and otherwise falls back to a
            // buffered instantiate with a console warning.
            return "application/wasm";
        default:
            return "application/octet-stream";
    }
}

/** The path a requested browser asset has under the pinned lab/public tree. */
export function pinnedLabPublicAssetPath(requestPath: string): string {
    const relative = requestPath.replace(/^\/+/, "");
    // Physics demos resolve this file beside their bundled demo module, but
    // the pinned lab publishes the shared binary once at public root. The
    // source-relative parity URL therefore needs the same bundler relocation.
    return relative.endsWith("/HavokPhysics.wasm") ||
        relative === "HavokPhysics.wasm"
        ? "HavokPhysics.wasm"
        : relative;
}

/**
 * Recover a demo-public URL when an unbundled nested module repeats the demo
 * directory. Upstream serves every demo module from one bundle URL, so
 * `racer/track.ts` resolving `./racer/models/...` lands beside `racer.ts`.
 * The reference harness serves the exact modules separately; that same URL
 * consequently contains `.../demos/racer/racer/...`. Prefer the literal path
 * first, because applications such as Tetris intentionally commit that shape,
 * and use this bundle-equivalent alias only when the repeated path is absent.
 */
export function bundledDemoAssetPath(requestPath: string): string | undefined {
    const relative = requestPath.replace(/^\/+/, "").replaceAll("\\", "/");
    const marker = "lab/lite/src/demos/";
    const markerIndex = relative.indexOf(marker);
    if (markerIndex < 0) return undefined;
    const prefix = relative.slice(0, markerIndex + marker.length);
    const parts = relative.slice(prefix.length).split("/");
    if (parts.length < 3 || parts[0] !== parts[1]) return undefined;
    return `${prefix}${[parts[0], ...parts.slice(2)].join("/")}`;
}

/**
 * Recover an asset URL emitted by a nested module when the upstream demo
 * bundler would have given every module the demo bundle's directory.
 *
 * Unlike the repeated-directory case above, a module such as
 * `quake/render/items.ts` can resolve `./librequake/maps/...` as
 * `quake/render/librequake/maps/...` in the unbundled harness even though the
 * bundle resolves it as `librequake/maps/...`. The source text does not expose
 * where its module directory ends and its asset path begins, so test each
 * progressively flattened path and accept only an existing repository file.
 * Literal and repeated-directory paths are still preferred by the server.
 */
export function flattenedBundledDemoAssetPath(
    requestPath: string,
    root = resolve("."),
): string | undefined {
    const relativePath = requestPath
        .replace(/^\/+/, "")
        .replaceAll("\\", "/");
    const marker = "lab/lite/src/demos/";
    const markerIndex = relativePath.indexOf(marker);
    if (markerIndex < 0) return undefined;
    const prefix = relativePath.slice(
        0,
        markerIndex + marker.length,
    );
    const parts = relativePath.slice(prefix.length).split("/");
    for (let omitted = 1; omitted < parts.length - 1; omitted += 1) {
        const candidate = `${prefix}${parts.slice(omitted).join("/")}`;
        const candidatePath = resolve(root, candidate);
        if (
            candidatePath.startsWith(`${root}${sep}`) &&
            existsSync(candidatePath) &&
            statSync(candidatePath).isFile()
        ) {
            return candidate;
        }
    }
    return undefined;
}

export type SuiteSourceTransform = (source: string) => string;

const fixedEngineStartMarker =
    'document.getElementById("renderCanvas")?.setAttribute("data-fixed-engine-starting", "true");\n    await startEngine(engine);';

/**
 * Arm the deterministic RAF clock in whichever module actually starts the
 * engine. Application entry points may delegate startup to a source-relative
 * helper, so this projection is applied both to the entry module and to every
 * TypeScript module the suite server transpiles on demand.
 */
function markFixedEngineStart(source: string): string {
    return source.replace("await startEngine(engine);", fixedEngineStartMarker);
}

/**
 * The served URL of the pinned package's index module — what every page
 * the suite server hosts imports the pin as. `pinnedPackageSpecifiers`
 * rewrites bare package names to it, and the drivers that write their own
 * page modules (basis transcode, node particles, the geometry impostor
 * shim) import the same spelling rather than retyping it.
 */
export const pinnedBrowserEntryUrl =
    "/node_modules/@babylonjs/lite/lib/index.js";

/**
 * The scene source as the reference capture runs it: transpiled for the
 * browser, with the pinned package and asset URLs rewritten, and — for a
 * scene pinned to a pose — the seek the registry describes injected
 * before `registerScene`.
 *
 * The seek is a time write plus a pause, which is what the corpus
 * scenes' own frozen branches do: the pose then lands on the next tick,
 * from whoever drives the group. `goToFrame` is the other spelling and
 * it does not serve every scene — it converts frames through the group's
 * own rate, so one number cannot seek groups of different rates to one
 * time, and it applies the pose itself, which a skinned glTF group
 * refuses unless its controller has already seen an engine (pinned error
 * #378: a weighted-mixer scene's controller never has). So the registry
 * pins a pose in seconds and the harness writes seconds.
 */
export function suiteBrowserModule(
    sourcePath: string,
    transform?: SuiteSourceTransform,
    captureTimeSeconds?: number,
    captureAnimationGroups?: string[],
    fixedAnimationFrame?: number,
): string {
    const input = readFileSync(resolve(sourcePath), "utf8");
    const transformed = transform ? transform(input) : input;
    const framed = captureTimeSeconds !== undefined
        ? (
              `import { ` +
              `onBeforeRender as __captureOnBeforeRender, ` +
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
                animationGroup.currentTime = ${captureTimeSeconds};
                __capturePauseAnimation(animationGroup);
            }
            canvas.dataset.animationFrozen = "true";
        }
    });
    await registerScene(scene);`,
          )
        : transformed;
    const source = pinnedPackageSpecifiers(framed)
        .replaceAll(
            '"/brdf-lut.png"',
            `"https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/${upstreamSource().readUpstreamPin().sourceVersion}/packages/babylon-lite/assets/brdf-lut.png"`,
        );
    const readySource = source.includes("dataset.ready")
        ? source
        : source.replace(
              "await startEngine(engine);",
              'await startEngine(engine); canvas.dataset.ready = "true";',
          );
    const fixedFrameSource = fixedAnimationFrame === undefined
        ? readySource
        : markFixedEngineStart(readySource);
    return browserHarness().transpileForBrowser(fixedFrameSource, sourcePath);
}

/**
 * The sha256 hex digest of the module `suiteBrowserModule` composes for
 * these inputs — the identity of "the scene as the browser runs it": the
 * scene source, the injected pose, and the pinned package the transpile
 * resolves against. The golden-provenance manifest records the same
 * digest (`corpus-scenes.test.ts` checks it), and the instrumented
 * capture writes it into `capture-meta.json` so a reuse path can refuse
 * a capture taken from a scene module that has since moved.
 */
export function suiteBrowserModuleDigest(
    sourcePath: string,
    captureTimeSeconds?: number,
    captureAnimationGroups?: string[],
    fixedAnimationFrame?: number,
): string {
    return createHash("sha256")
        .update(
            suiteBrowserModule(
                sourcePath,
                undefined,
                captureTimeSeconds,
                captureAnimationGroups,
                fixedAnimationFrame,
            ),
        )
        .digest("hex");
}

/**
 * The pinned package's own specifiers, as the served page resolves them.
 *
 * A corpus scene imports the package two ways: by its bare name, and by a
 * SUBPATH for an entry point the index does not re-export — the PBR
 * tracking installer and the DDS background builder are both written that
 * way. A browser resolves neither, so both are rewritten to the published
 * module, and a subpath keeps its own path under `lib/` with the `.js` the
 * package ships (a specifier that already carries one keeps it).
 *
 * The names are `compiler/symbols.ts`'s `babylonPackages`, spelled here as a
 * literal because the alternation has to be escaped for a regex. A test
 * asserts every name in that list is rewritten, so the two cannot drift.
 */
export function pinnedPackageSpecifiers(source: string): string {
    const { physicsEngineModulePackage } = compilerSymbols();
    return source
        .replace(
            /"(?:@babylonjs\/lite|babylon-lite)(\/[^"]*)?"/g,
            (_match, subpath?: string) =>
                subpath
                    ? `"/node_modules/@babylonjs/lite/lib${
                          subpath.endsWith(".js") ? subpath : `${subpath}.js`
                      }"`
                    : `"${pinnedBrowserEntryUrl}"`,
        )
        .replaceAll(
            `"${physicsEngineModulePackage}"`,
            `"/node_modules/${physicsEngineModulePackage}/lib/esm/HavokPhysics_es.js"`,
        )
        // The navigation wrapper the pin dynamic-imports, resolved the
        // way Havok is: each bare specifier to its package's own ESM
        // entry. The wasm binary itself comes off the pinned lab/public
        // proxy through the scene's `locateFile`.
        .replaceAll(
            '"@recast-navigation/core"',
            '"/node_modules/@recast-navigation/core/dist/index.mjs"',
        )
        .replaceAll(
            '"@recast-navigation/generators"',
            '"/node_modules/@recast-navigation/generators/dist/index.mjs"',
        )
        .replaceAll(
            '"@recast-navigation/wasm/wasm"',
            '"/node_modules/@recast-navigation/wasm/dist/recast-navigation.wasm.js"',
        );
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
    sourcePath?: string;
    /** Freeze requestAnimationFrame at an exact positive native 60 Hz frame. */
    fixedAnimationFrame?: number;
    /**
     * Extra modules served by path, ahead of the repository lookup. A
     * diagnostic that has to intercept a pinned entry point re-exports the
     * pinned module from one of these instead of editing the package, so the
     * capture still runs the pinned code.
     */
    virtualModules?: Readonly<Record<string, string>>;
    /**
     * Extra binary payloads served by path. A pinned loader that fetches its
     * own asset is handed a loopback URL to these rather than the remote one,
     * so the bytes come from the same download cache every other asset uses
     * and a recompile asks the network for nothing it already has.
     */
    virtualAssets?: Readonly<Record<string, Uint8Array>>;
    /**
     * The query string the page is served at, when the scene's own parity
     * spec serves one (`"?seekTime=0"`). The compiler folds the same text,
     * so the native scene takes the branch the reference page takes.
     */
    search?: string;
    /** Audited host-page elements that surround the immutable scene module. */
    hostUi?: NativeHostUi;
}

/** Full-page capture is the product default; zero requests a canvas-only
 * attribution capture. */
export function captureUiEnabled(
    environment: NodeJS.ProcessEnv = process.env,
): boolean {
    return environment.BBLITE_CAPTURE_UI !== "0";
}

function hostUiBootstrapScript(
    hostUi: NonNullable<SuiteCaptureOptions["hostUi"]>,
): string {
    const payload = JSON.stringify(hostUi).replaceAll("</script", "<\\/script");
    return `<script>(() => {
const hostUi = ${payload};
if (hostUi.classStyles?.length) {
    const style = document.createElement("style");
    style.textContent = hostUi.classStyles
        .map((rule) => "." + rule.className + "{" + rule.style + "}")
        .join("\\n");
    document.head.appendChild(style);
}
const create = (record) => {
    const element = document.createElement(record.tag);
    for (const [name, value] of Object.entries(record.attributes ?? {})) {
        element.setAttribute(name, value);
    }
    if (record.text !== undefined) element.textContent = record.text;
    for (const child of record.children ?? []) element.appendChild(create(child));
    return element;
};
for (const element of hostUi.elements) document.body.appendChild(create(element));
})();</script>\n`;
}

export function createSuiteSceneServer(
    moduleSource: string,
    options: SuiteCaptureOptions = {},
): ReturnType<typeof createServer> {
    const root = resolve(".");
    const entryPath = options.sourcePath
        ? `/${relative(root, resolve(options.sourcePath))
              .split(sep)
              .join("/")
              .replace(/\.ts$/, ".js")}`
        : "/scene.js";
    const seedScript = options.seededRandom
        ? `<script>${seededRandomScript}</script>\n`
        : "";
    const fixedFrameScript = options.fixedAnimationFrame === undefined
        ? ""
        : `<script>${fixedAnimationFrameScript(options.fixedAnimationFrame)}</script>\n`;
    const hostUiScript = options.hostUi
        ? hostUiBootstrapScript(options.hostUi)
        : "";
    const hideNonCanvasAtFixedFrame =
        options.fixedAnimationFrame !== undefined &&
        !captureUiEnabled();
    const html = `<!doctype html><html><head><style>
html,body,canvas{margin:0;width:1280px;height:720px;overflow:hidden;display:block}
${hideNonCanvasAtFixedFrame ? "body>:not(#renderCanvas){visibility:hidden!important}" : ""}
</style></head><body><canvas id="renderCanvas" width="1280" height="720"></canvas>
${seedScript}${fixedFrameScript}${hostUiScript}<script type="module" src="${entryPath}"></script></body></html>`;
    const pinnedAssets = new Map<
        string,
        { bytes: Uint8Array; contentType: string }
    >();
    return createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        // Chromium asks for this on every page it opens. Without an arm it
        // falls all the way through to the pinned-asset fetch below, so each
        // capture pays a raw.githubusercontent.com round trip to be told the
        // lab has no favicon either, and then logs the 404 through the
        // console-error hook as though a scene had failed.
        if (url.pathname === "/favicon.ico") {
            response.writeHead(204);
            response.end();
            return;
        }
        if (url.pathname === "/scene.html") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(html);
            return;
        }
        if (url.pathname === entryPath) {
            response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
            response.end(moduleSource);
            return;
        }
        const virtualModule = options.virtualModules?.[url.pathname];
        if (virtualModule !== undefined) {
            response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
            response.end(virtualModule);
            return;
        }
        const virtualAsset = options.virtualAssets?.[url.pathname];
        if (virtualAsset !== undefined) {
            response.writeHead(200, {
                "Content-Type": mimeType(url.pathname),
            });
            response.end(virtualAsset);
            return;
        }
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        const path = resolve(root, relative);
        // Local TypeScript modules transpile on demand. Corpus scenes
        // write both specifier styles: the ESM ".js" one the demo build
        // rewrites, and the bare extensionless one bundlers resolve (the
        // sprite scenes import `../_shared/sprite-atlas-image`), so the
        // sibling to compile is found either way.
        if (
            !existsSync(path) ||
            !statSync(path).isFile()
        ) {
            const typescriptPath = url.pathname.endsWith(".js")
                ? `${path.slice(0, -3)}.ts`
                : `${path}.ts`;
            if (
                typescriptPath.startsWith(`${root}${sep}`) &&
                existsSync(typescriptPath) &&
                statSync(typescriptPath).isFile()
            ) {
                const sourceText = readFileSync(typescriptPath, "utf8");
                const fixedFrameSource =
                    options.fixedAnimationFrame === undefined
                        ? sourceText
                        : markFixedEngineStart(sourceText);
                const moduleText = pinnedPackageSpecifiers(fixedFrameSource);
                response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
                response.end(
                    browserHarness().transpileForBrowser(
                        moduleText,
                        typescriptPath,
                    ),
                );
                return;
            }
        }
        const bundledRelative = bundledDemoAssetPath(relative);
        const bundledPath = bundledRelative === undefined
            ? undefined
            : resolve(root, bundledRelative);
        if (
            bundledPath !== undefined &&
            bundledPath.startsWith(`${root}${sep}`) &&
            existsSync(bundledPath) &&
            statSync(bundledPath).isFile()
        ) {
            response.writeHead(200, {
                "Content-Type": mimeType(bundledPath),
            });
            response.end(readFileSync(bundledPath));
            return;
        }
        const flattenedRelative = flattenedBundledDemoAssetPath(
            relative,
            root,
        );
        const flattenedPath = flattenedRelative === undefined
            ? undefined
            : resolve(root, flattenedRelative);
        if (flattenedPath !== undefined) {
            response.writeHead(200, {
                "Content-Type": mimeType(flattenedPath),
            });
            response.end(readFileSync(flattenedPath));
            return;
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
                const pin = upstreamSource().readUpstreamPin();
                const publicAsset =
                    pinnedLabPublicAssetPath(relative);
                const assetUrl =
                    "https://raw.githubusercontent.com/" +
                    `BabylonJS/Babylon-Lite/${pin.sourceVersion}` +
                    `/lab/public/${publicAsset}`;
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
                        // raw.githubusercontent.com serves every blob as
                        // octet-stream, which `WebAssembly.instantiateStreaming`
                        // refuses; the extension is the better authority
                        // wherever this table knows the type.
                        contentType:
                            knownMimeType(url.pathname) ??
                            fetched.headers.get(
                                "content-type",
                            ) ??
                            mimeType(url.pathname),
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

/**
 * A deterministic browser RAF turn queue. It retains browser registration
 * order (engine render first, application callback second), pins
 * `performance.now()` to the same 60 Hz clock, and stops only after every
 * callback on the requested frame has run.
 */
export function fixedAnimationFrameScript(targetFrame: number): string {
    if (!Number.isInteger(targetFrame) || targetFrame < 1) {
        throw new Error(`Invalid fixed animation frame '${targetFrame}'.`);
    }
    return `(() => {
const nativeRaf = window.requestAnimationFrame.bind(window);
const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
const nativeSetTimeout = window.setTimeout.bind(window);
const nativeClearTimeout = window.clearTimeout.bind(window);
const nativeSetInterval = window.setInterval.bind(window);
const nativeClearInterval = window.clearInterval.bind(window);
const step = 1000 / 60;
const target = ${targetFrame};
let frame = -1;
let engineStartFrame = -1;
let now = 0;
let nextId = 1;
let scheduled = false;
let flushing = false;
let nativeId = 0;
let done = false;
const callbacks = new Map();
const timeouts = new Map();
const intervals = new Map();
let nextTimerId = 1000000000;
const schedule = () => {
    if (
        scheduled || flushing || done ||
        (callbacks.size === 0 && timeouts.size === 0 && intervals.size === 0)
    ) return;
    scheduled = true;
    nativeId = nativeRaf(() => {
        scheduled = false;
        flushing = true;
        frame += 1;
        const canvas = document.getElementById("renderCanvas");
        if (
            engineStartFrame < 0 &&
            canvas?.dataset.fixedEngineStarting === "true"
        ) {
            engineStartFrame = frame;
        }
        // Native initialization is synchronous and its deterministic clock
        // starts with the render loop. Keep browser initialization at the
        // same zero epoch even when async pipeline work consumes RAF turns.
        now = engineStartFrame < 0
            ? 0
            : (frame - engineStartFrame) * step;
        const due = Array.from(callbacks.entries());
        callbacks.clear();
        for (const [id, callback] of due) {
            if (id > 0) callback(now);
        }
        // Native drains browser timers after the frame's render callbacks,
        // against this same deterministic clock. Virtualize timers once the
        // engine epoch is known so UI state and CSS-adjacent application
        // state do not continue on wall time while rendering runs at 60 Hz.
        const dueTimeouts = Array.from(timeouts.entries()).filter(
            ([, timer]) => timer.due <= now
        );
        for (const [id, timer] of dueTimeouts) {
            timeouts.delete(id);
            timer.callback(...timer.args);
        }
        const dueIntervals = Array.from(intervals.entries()).filter(
            ([, timer]) => timer.due <= now
        );
        for (const [, timer] of dueIntervals) {
            timer.due += timer.period;
            timer.callback(...timer.args);
        }
        if (canvas) {
            const captureFrame = engineStartFrame < 0
                ? -1
                : frame - engineStartFrame;
            canvas.dataset.fixedAnimationFrame = String(frame);
            canvas.dataset.fixedCaptureFrame = String(captureFrame);
            canvas.dataset.fixedAnimationCallbacks = String(due.length);
        }
        if (
            canvas?.dataset.ready === "true" &&
            engineStartFrame >= 0 &&
            frame - engineStartFrame >= target
        ) {
            flushing = false;
            done = true;
        } else {
            // startEngine resolves inside its first RAF. Let that promise
            // continuation register application RAF callbacks before the
            // engine's already-rearmed callback starts the following turn.
            queueMicrotask(() => {
                flushing = false;
                schedule();
            });
        }
    });
};
window.requestAnimationFrame = (callback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    schedule();
    return id;
};
window.cancelAnimationFrame = (id) => {
    callbacks.delete(id);
    if (scheduled && callbacks.size === 0) {
        nativeCancelRaf(nativeId);
        scheduled = false;
    }
};
window.setTimeout = (callback, delay = 0, ...args) => {
    if (engineStartFrame < 0) {
        return nativeSetTimeout(callback, delay, ...args);
    }
    const id = nextTimerId++;
    timeouts.set(id, {
        callback: typeof callback === "function" ? callback : () => eval(callback),
        args,
        due: now + Math.max(0, Number(delay) || 0),
    });
    schedule();
    return id;
};
window.clearTimeout = (id) => {
    if (!timeouts.delete(id)) nativeClearTimeout(id);
};
window.setInterval = (callback, delay = 0, ...args) => {
    if (engineStartFrame < 0) {
        return nativeSetInterval(callback, delay, ...args);
    }
    const id = nextTimerId++;
    const period = Math.max(1, Number(delay) || 0);
    intervals.set(id, {
        callback: typeof callback === "function" ? callback : () => eval(callback),
        args,
        due: now + period,
        period,
    });
    schedule();
    return id;
};
window.clearInterval = (id) => {
    if (!intervals.delete(id)) nativeClearInterval(id);
};
Object.defineProperty(window.performance, "now", {
    configurable: true,
    value: () => now,
});
})();`;
}

export async function captureSuiteReference(
    sourcePath: string,
    referencePath: string,
    force: boolean,
    transform?: SuiteSourceTransform,
    captureTimeSeconds?: number,
    captureAnimationGroups?: string[],
    options: SuiteCaptureOptions = {},
): Promise<void> {
    if (existsSync(referencePath) && !force) return;
    // Past the cached-reference early return, the browser is genuinely
    // needed; only now does the harness (playwright + typescript) load.
    const {
        hideNonCanvasChrome,
        screenshotCaptureBrowserArgs,
        waitForSceneReady,
        withBrowserPage,
    } =
        browserHarness();
    const moduleSource = suiteBrowserModule(
        sourcePath,
        transform,
        captureTimeSeconds,
        captureAnimationGroups,
        options.fixedAnimationFrame,
    );
    const server = createSuiteSceneServer(moduleSource, {
        ...options,
        sourcePath,
    });
    await withBrowserPage(
        server,
        {
            serverName: "parity server",
            browserArgs: screenshotCaptureBrowserArgs,
            viewport: { width: 1280, height: 720 },
            pageErrorPrefix: "Reference page error",
            consoleErrorPrefix: "Reference console error",
        },
        async (page, origin) => {
            await waitForSceneReady(
                page,
                origin,
                captureTimeSeconds !== undefined,
                options.search,
                options.fixedAnimationFrame,
            );
            mkdirSync(resolve(referencePath, ".."), { recursive: true });
            if (captureUiEnabled()) {
                if (options.fixedAnimationFrame !== undefined) {
                    // requestAnimationFrame and performance.now() are pinned
                    // by the deterministic harness above, but CSS animations
                    // use the document timeline directly. Freeze them at the
                    // same requested frame so animated DOM UI has a stable,
                    // backend-comparable reference phase.
                    await page.evaluate((elapsedMilliseconds) => {
                        for (const animation of document.getAnimations()) {
                            animation.pause();
                            animation.currentTime = elapsedMilliseconds;
                        }
                    }, options.fixedAnimationFrame * (1000 / 60));
                }
                await page.screenshot({ path: referencePath });
            } else {
                await hideNonCanvasChrome(page);
                await page
                    .locator("#renderCanvas")
                    .screenshot({ path: referencePath });
            }
        },
    );
}
