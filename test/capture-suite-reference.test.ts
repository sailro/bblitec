import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
    bundledDemoAssetPath,
    captureUiEnabled,
    createSuiteSceneServer,
    flattenedBundledDemoAssetPath,
    fixedAnimationFrameScript,
    pinnedLabPublicAssetPath,
    suiteBrowserModule,
} from "../src/capture-suite-reference.js";
import { gotoScenePage } from "../src/browser-harness.js";
import {
    goldenFixedFrame,
    manifestReadyAfterEntry,
} from "../src/parity-scene.js";
import type { SceneDefinition } from "../src/scene-registry.js";
import {
    configureAdHocScenes,
    resolveScene,
    sceneReferencePage,
} from "../src/scene-registry.js";

test("captures full page UI unless canvas-only attribution is requested", () => {
    assert.equal(captureUiEnabled({}), true);
    assert.equal(captureUiEnabled({ BBLITE_CAPTURE_UI: "1" }), true);
    assert.equal(captureUiEnabled({ BBLITE_CAPTURE_UI: "0" }), false);
});

test("entry readiness follows reached manifest facts", () => {
    for (const features of [
        [],
        ["ui:rml"],
        ["backend:sdl"],
        ["backend:sdl", "ui:rml"],
    ]) {
        for (const canvasReadyGate of [undefined, true] as const) {
            assert.equal(
                manifestReadyAfterEntry({
                    features,
                    adaptations: [],
                    ...(canvasReadyGate ? { canvasReadyGate } : {}),
                }),
                !features.includes("backend:sdl") && !canvasReadyGate,
            );
        }
    }
});

test("device-local capture sizes the host without changing canonical viewport defaults", async () => {
    for (const viewport of [undefined, { width: 667, height: 375 }]) {
        const server = createSuiteSceneServer(
            "export {};",
            viewport ? { viewport } : {},
        );
        try {
            await new Promise<void>((done) =>
                server.listen(0, "127.0.0.1", done),
            );
            const address = server.address();
            assert.ok(address && typeof address !== "string");
            const html = await (
                await fetch(`http://127.0.0.1:${address.port}/scene.html`)
            ).text();
            const { width, height } = viewport ?? { width: 1280, height: 720 };
            assert.ok(html.includes(`width:${width}px;height:${height}px`));
            assert.ok(html.includes(`width="${width}" height="${height}"`));
        } finally {
            await new Promise<void>((done) => server.close(() => done()));
        }
    }
    for (const width of [0, -1, 1.5, NaN]) {
        assert.throws(
            () =>
                createSuiteSceneServer("", {
                    viewport: { width, height: 375 },
                }),
            /positive integer/,
        );
    }
});

// The instrumented capture must compose the page the golden was captured
// from, and the fixed-frame derivation is the piece that can silently
// drift: the golden capture (`runParity` in parity-scene.ts) falls back
// to the native gate's BBLITE_SCREENSHOT_FRAME for a full-page capture
// of a retained-UI application. The end-to-end proof stays with
// `scene -- capture <application>`'s byte-identity line; this pins the
// derivation itself, browser-free.
function applicationScene(
    options: {
        referenceFrame?: number;
        nativeEnvironment?: Record<string, string>;
    } = {},
): SceneDefinition {
    return {
        id: "app",
        name: "App",
        source: "corpus/app.ts",
        output: "generated/app",
        title: "App",
        buildDirectory: "native/build-app",
        parity: {
            reference: {
                kind: "source",
                path: "artifacts/app/browser.png",
            },
            outputDirectory: "artifacts/app",
            backgroundColor: [0, 0, 0],
            backgroundThreshold: 30,
            ...(options.referenceFrame !== undefined
                ? { referenceFrame: options.referenceFrame }
                : {}),
            ...(options.nativeEnvironment
                ? { nativeEnvironment: options.nativeEnvironment }
                : {}),
        },
    };
}

test("derives the instrumented capture's fixed frame exactly as the golden capture", () => {
    // The parity spec's own referenceFrame wins in every mode.
    const pinned = applicationScene({ referenceFrame: 7 });
    assert.equal(goldenFixedFrame(pinned, true), 7);
    assert.equal(goldenFixedFrame(pinned, false), 7);
    // A retained-UI application without one takes the native gate's
    // BBLITE_SCREENSHOT_FRAME in every capture mode, full page or
    // canvas-only; a scene without retained UI derives nothing.
    const application = applicationScene({
        nativeEnvironment: { BBLITE_SCREENSHOT_FRAME: "181" },
    });
    assert.equal(goldenFixedFrame(application, true), 181);
    assert.equal(goldenFixedFrame(application, false), undefined);
    // A non-positive or non-numeric native frame derives nothing.
    assert.equal(
        goldenFixedFrame(
            applicationScene({
                nativeEnvironment: { BBLITE_SCREENSHOT_FRAME: "0" },
            }),
            true,
        ),
        undefined,
    );
    assert.equal(
        goldenFixedFrame(
            applicationScene({
                nativeEnvironment: { BBLITE_SCREENSHOT_FRAME: "soon" },
            }),
            true,
        ),
        undefined,
    );
});

test("serves the host UI bootstrap ahead of the scene module script", async () => {
    const server = createSuiteSceneServer("export {};\n", {
        hostUi: {
            sourcePath: "ui/app-host.json",
            styleRules: [
                { kind: "class", primary: "hud", style: "color: red" },
                {
                    kind: "class",
                    primary: "entry",
                    focusVisible: true,
                    style: "outline: 2px solid cyan",
                },
                {
                    kind: "class",
                    primary: "compact",
                    maxWidth: 800,
                    reducedMotion: true,
                    containerMaxWidth: 320,
                    style: "width:40px",
                },
            ],
            elements: [
                {
                    tag: "div",
                    attributes: { id: "hud" },
                    text: "HUD",
                },
            ],
        },
    });
    try {
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const html = await (
            await fetch(`http://127.0.0.1:${address.port}/scene.html`)
        ).text();
        const bootstrapIndex = html.indexOf("const hostStyleSheet");
        const moduleIndex = html.indexOf('<script type="module"');
        assert.ok(bootstrapIndex >= 0, "host UI bootstrap script missing");
        assert.ok(moduleIndex >= 0, "scene module script missing");
        // The bootstrap is inline HTML ahead of the module script: an
        // instrumented capture's addInitScript hooks run before either,
        // so injecting the UI cannot disturb hook timing.
        assert.ok(
            bootstrapIndex < moduleIndex,
            "host UI must be served ahead of the scene module",
        );
        assert.match(html, /\.hud\{color: red\}/);
        assert.match(
            html,
            /@media\(max-width:800px\)\{@media\(prefers-reduced-motion:reduce\)\{@container\(max-width:320px\)\{\.compact\{width:40px\}\}\}\}/,
        );
        // Plain class rules and generic selector flags share one sheet.
        // Dropping focus-visible paints every button as selected in the
        // reference.
        assert.match(html, /\.entry:focus-visible\{outline: 2px solid cyan\}/);
    } finally {
        await new Promise<void>((done) => server.close(() => done()));
    }
});

test("a host page's inline loader imports the served scene module", async () => {
    const server = createSuiteSceneServer("export {};\n", {
        sourcePath: "examples/regression-host-page/src/main.ts",
        hostPage: "examples/regression-host-page/page.html",
    });
    try {
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const html = await (
            await fetch(`http://127.0.0.1:${address.port}/scene.html`)
        ).text();
        assert.match(
            html,
            /await import\("\/examples\/regression-host-page\/src\/main\.js"\);/,
        );
        assert.doesNotMatch(html, /import\("\/src\/main\.ts"\)/);
        // The loader's other statements stay the page's own.
        assert.match(html, /location\.protocol === "file:"/);
    } finally {
        await new Promise<void>((done) => server.close(() => done()));
    }
});

test("a page outside the repository is served from its site root and public directory", async () => {
    const site = mkdtempSync(resolve(tmpdir(), "bblite-site-"));
    mkdirSync(resolve(site, "src"), { recursive: true });
    mkdirSync(resolve(site, "public/assets"), { recursive: true });
    mkdirSync(resolve(site, "assets"), { recursive: true });
    writeFileSync(
        resolve(site, "page.html"),
        '<!doctype html><html><head></head><body><canvas id="c"></canvas><script type="module">await import("/src/main.ts");</script></body></html>\n',
    );
    writeFileSync(resolve(site, "src/main.ts"), 'import "./dep";\n');
    writeFileSync(
        resolve(site, "src/dep.ts"),
        "export const value: number = 1;\n",
    );
    writeFileSync(resolve(site, "public/assets/data.txt"), "public bytes");
    writeFileSync(resolve(site, "assets/data.txt"), "site bytes");
    writeFileSync(resolve(site, "public/README.md"), "public readme");
    const server = createSuiteSceneServer("export {};\n", {
        sourcePath: resolve(site, "src/main.ts"),
        hostPage: resolve(site, "page.html"),
        siteRoot: site,
        publicDir: resolve(site, "public"),
    });
    try {
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        const html = await (await fetch(`${origin}/scene.html`)).text();
        assert.match(html, /await import\("\/src\/main\.js"\);/);
        const dependency = await (await fetch(`${origin}/src/dep`)).text();
        assert.match(dependency, /export const value = 1;/);
        assert.equal(
            await (await fetch(`${origin}/assets/data.txt`)).text(),
            "public bytes",
        );
        assert.equal(
            await (await fetch(`${origin}/README.md`)).text(),
            "public readme",
        );
        // The repository still serves the pinned package beneath the site.
        assert.equal(
            (await fetch(`${origin}/node_modules/@babylonjs/lite/lib/index.js`))
                .status,
            200,
        );
    } finally {
        await new Promise<void>((done) => server.close(() => done()));
        rmSync(site, { recursive: true, force: true });
    }
});

test("external TypeScript entries and relative imports use the effective source root", async () => {
    const site = mkdtempSync(resolve(tmpdir(), "bblite-source-"));
    mkdirSync(resolve(site, "src"));
    const source = resolve(site, "src/main.ts");
    writeFileSync(source, 'import "./dep.js";');
    writeFileSync(
        resolve(site, "src/dep.ts"),
        "export const value: number = 2;",
    );
    try {
        for (const siteRoot of [undefined, site]) {
            configureAdHocScenes(siteRoot ? { siteRoot } : {});
            const scene = resolveScene(source);
            const server = createSuiteSceneServer(
                'import "./dep.js"; export const entry = true;',
                {
                    sourcePath: scene.source,
                    ...sceneReferencePage(scene),
                },
            );
            try {
                await new Promise<void>((done) =>
                    server.listen(0, "127.0.0.1", done),
                );
                const address = server.address();
                assert.ok(address && typeof address !== "string");
                const origin = `http://127.0.0.1:${address.port}`;
                const html = await (await fetch(`${origin}/scene.html`)).text();
                const entry = /<script type="module" src="([^"]+)"/.exec(
                    html,
                )?.[1];
                assert.equal(entry, siteRoot ? "/src/main.js" : "/main.js");
                assert.match(
                    await (await fetch(new URL(entry, origin))).text(),
                    /export const entry = true/,
                );
                const dependency = new URL("./dep.js", new URL(entry, origin));
                assert.match(
                    await (await fetch(dependency)).text(),
                    /export const value = 2;/,
                );
            } finally {
                await new Promise<void>((done) => server.close(() => done()));
            }
        }
    } finally {
        configureAdHocScenes({});
        rmSync(site, { recursive: true, force: true });
    }
});

test("preserves the reference query when navigating to the suite scene", async () => {
    const navigations: Array<{
        url: string;
        options: { waitUntil: string; timeout: number };
    }> = [];
    const page = {
        goto: async (
            url: string,
            options: { waitUntil: string; timeout: number },
        ) => {
            navigations.push({ url, options });
            return null;
        },
    } as unknown as Parameters<typeof gotoScenePage>[0];

    await gotoScenePage(page, "http://127.0.0.1:4173", "?seekTime=1.25");

    assert.deepEqual(navigations, [
        {
            url: "http://127.0.0.1:4173/scene.html?seekTime=1.25",
            options: {
                waitUntil: "domcontentloaded",
                timeout: 120_000,
            },
        },
    ]);
});

test("maps an unbundled nested demo asset URL to its bundle-relative file", () => {
    assert.equal(
        bundledDemoAssetPath(
            "/corpus/babylon-lite/lab/lite/src/demos/racer/racer/models/track.glb",
        ),
        "corpus/babylon-lite/lab/lite/src/demos/racer/models/track.glb",
    );
    assert.equal(
        bundledDemoAssetPath(
            "/corpus/babylon-lite/lab/lite/src/demos/racer/models/track.glb",
        ),
        undefined,
    );
});

test("maps a nested module asset URL to the bundle directory", () => {
    const root = mkdtempSync(resolve(".capture-suite-flat-"));
    const asset = resolve(root, "lab/lite/src/demos/librequake/maps/item.bsp");
    try {
        mkdirSync(resolve(asset, ".."), { recursive: true });
        writeFileSync(asset, "asset");
        assert.equal(
            flattenedBundledDemoAssetPath(
                "/lab/lite/src/demos/quake/render/librequake/maps/item.bsp",
                root,
            ),
            "lab/lite/src/demos/librequake/maps/item.bsp",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("relocates demo bundle assets and the shared Havok binary to pinned lab/public", () => {
    assert.equal(
        pinnedLabPublicAssetPath(
            "/corpus/babylon-lite/lab/lite/src/demos/HavokPhysics.wasm",
        ),
        "HavokPhysics.wasm",
    );
    assert.equal(
        pinnedLabPublicAssetPath("/textures/environment.env"),
        "textures/environment.env",
    );
    for (const prefix of [
        "/bundle/demos/",
        "/lite/bundle/demos/",
        "/corpus/babylon-lite/lab/lite/src/demos/",
    ])
        assert.equal(
            pinnedLabPublicAssetPath(`${prefix}nested/image.png`),
            "nested/image.png",
        );
});

test("serves assets at the demo bundle root while preferring existing module-relative files", async () => {
    const root = mkdtempSync(resolve(".capture-suite-bundle-root-"));
    const directory = resolve(root, "lab/lite/src/demos");
    mkdirSync(resolve(directory, "nested"), { recursive: true });
    writeFileSync(resolve(directory, "brdf-lut.png"), "shared lut");
    const server = createSuiteSceneServer("export {};");
    try {
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const path = `${root.slice(resolve(".").length + 1).replaceAll("\\", "/")}/lab/lite/src/demos/nested/brdf-lut.png`;
        const url = `http://127.0.0.1:${address.port}/${path}`;
        const shared = await fetch(url);
        assert.equal(shared.status, 200);
        assert.equal(await shared.text(), "shared lut");
        writeFileSync(resolve(directory, "nested/brdf-lut.png"), "local lut");
        assert.equal(await (await fetch(url)).text(), "local lut");
    } finally {
        await new Promise<void>((done) => server.close(() => done()));
        rmSync(root, { recursive: true, force: true });
    }
});

test("builds a registration-ordered fixed browser RAF clock", () => {
    const script = fixedAnimationFrameScript(180);

    assert.match(script, /const target = 180;/);
    assert.match(script, /const due = Array\.from\(callbacks\.entries\(\)\)/);
    assert.match(script, /for \(const \[id, callback\] of due\)/);
    assert.match(script, /value: \(\) => now/);
    assert.match(script, /frame - engineStartFrame/);
    assert.match(script, /fixedEngineStarting/);
    assert.match(script, /queueMicrotask\(\(\) =>/);
    assert.throws(
        () => fixedAnimationFrameScript(0),
        /Invalid fixed animation frame/,
    );
    assert.throws(
        () => fixedAnimationFrameScript(1.5),
        /Invalid fixed animation frame/,
    );
});

test("fixed captures preserve legacy module markers and explicitly select document markers for HTML entries", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "bblite-clock-markers-"));
    const entry = resolve(root, "entry.ts");
    writeFileSync(entry, 'import "./helper.js"; await startEngine(engine);');
    writeFileSync(resolve(root, "helper.ts"), "await startEngine(engine);");
    try {
        for (const documentMarkers of [false, true]) {
            const moduleSource = suiteBrowserModule(
                entry,
                undefined,
                undefined,
                undefined,
                2,
                undefined,
                undefined,
                false,
                documentMarkers,
            );
            const expected = documentMarkers
                ? 'document.documentElement.setAttribute("data-fixed-engine-starting", "true");'
                : 'document.getElementById("renderCanvas")?.setAttribute("data-fixed-engine-starting", "true");';
            assert.ok(moduleSource.includes(expected));
            const server = createSuiteSceneServer(moduleSource, {
                sourcePath: entry,
                siteRoot: root,
                fixedAnimationFrame: 2,
                documentMarkers,
            });
            try {
                await new Promise<void>((done) =>
                    server.listen(0, "127.0.0.1", done),
                );
                const address = server.address();
                assert.ok(address && typeof address !== "string");
                const origin = `http://127.0.0.1:${address.port}`;
                assert.equal(
                    await (await fetch(`${origin}/entry.js`)).text(),
                    moduleSource,
                );
                assert.ok(
                    (
                        await (await fetch(`${origin}/helper.js`)).text()
                    ).includes(expected),
                );
            } finally {
                await new Promise<void>((done) => server.close(() => done()));
            }
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the fixed clock starts and freezes for legacy canvases, HTML canvases and entry readiness", () => {
    for (const convention of ["legacy", "html", "entry"] as const) {
        const frames: Array<() => void> = [];
        const microtasks: Array<() => void> = [];
        const marks: { dataset: Record<string, string> } = { dataset: {} };
        const canvas: { dataset: Record<string, string> } = {
            dataset: { ready: "true" },
        };
        if (convention === "legacy")
            canvas.dataset.fixedEngineStarting = "true";
        else marks.dataset.fixedEngineStarting = "true";
        if (convention === "entry") marks.dataset.captureReady = "true";
        const performance = { now: () => 999 };
        const window = {
            performance,
            requestAnimationFrame: (
                callback: (time: number) => void,
            ): number => {
                frames.push(() => callback(999));
                return frames.length;
            },
            cancelAnimationFrame: (_id: number) => {},
            setTimeout: (_callback: () => void, _delay?: number): number => 0,
            clearTimeout: (_id: number) => {},
            setInterval: (_callback: () => void, _delay?: number): number => 0,
            clearInterval: (_id: number) => {},
        };
        runInNewContext(fixedAnimationFrameScript(2), {
            window,
            performance,
            document: {
                documentElement: marks,
                getElementById: () => (convention === "legacy" ? canvas : null),
                querySelector: () => (convention === "entry" ? null : canvas),
            },
            queueMicrotask: (callback: () => void) => microtasks.push(callback),
        });
        const times: number[] = [];
        const animate = (time: number): void => {
            times.push(time);
            window.requestAnimationFrame(animate);
        };
        window.requestAnimationFrame(animate);
        for (let turn = 0; frames.length > 0 && turn < 10; turn++) {
            frames.shift()!();
            while (microtasks.length > 0) microtasks.shift()!();
        }
        assert.deepEqual(times, [0, 1000 / 60, 2 * (1000 / 60)], convention);
        assert.equal(marks.dataset.fixedCaptureFrame, "2", convention);
        assert.equal(frames.length, 0, convention);
    }
});

test("serves entry modules from their source-relative URL", async () => {
    const root = mkdtempSync(resolve(".capture-suite-reference-"));
    const entry = resolve(root, "nested", "entry.ts");
    const helper = resolve(root, "nested", "helper.ts");
    mkdirSync(resolve(root, "nested"));
    writeFileSync(entry, 'import "./helper.js";\n');
    writeFileSync(helper, "export const value: number = 1;\n");

    const server = createSuiteSceneServer('import "./helper.js";\n', {
        sourcePath: entry,
    });
    try {
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const base = `http://127.0.0.1:${address.port}`;
        const html = await (await fetch(`${base}/scene.html`)).text();
        const entryPath = `/${root
            .slice(resolve(".").length + 1)
            .replaceAll("\\", "/")}/nested/entry.js`;
        assert.match(
            html,
            new RegExp(
                `src="${entryPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
            ),
        );
        const entryResponse = await fetch(`${base}${entryPath}`);
        assert.equal(entryResponse.status, 200);
        const helperResponse = await fetch(
            `${base}${entryPath.replace(/entry\.js$/, "helper.js")}`,
        );
        assert.equal(helperResponse.status, 200);
        assert.match(await helperResponse.text(), /export const value = 1/);
        // Literal Worker(new URL("./helper.ts", import.meta.url)) keeps its
        // extension. Serve executable JavaScript at that URL too.
        const workerResponse = await fetch(
            `${base}${entryPath.replace(/entry\.js$/, "helper.ts")}`,
        );
        assert.equal(workerResponse.status, 200);
        assert.match(
            workerResponse.headers.get("content-type") ?? "",
            /javascript/,
        );
        assert.match(await workerResponse.text(), /export const value = 1/);
    } finally {
        await new Promise<void>((done) => server.close(() => done()));
        rmSync(root, { recursive: true, force: true });
    }
});
