import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
    bundledDemoAssetPath,
    captureUiEnabled,
    createSuiteSceneServer,
    flattenedBundledDemoAssetPath,
    fixedAnimationFrameScript,
    pinnedLabPublicAssetPath,
} from "../src/capture-suite-reference.js";
import { gotoScenePage } from "../src/browser-harness.js";
import { goldenFixedFrame } from "../src/parity-scene.js";
import type { SceneDefinition } from "../src/scene-registry.js";

test("captures full page UI unless canvas-only attribution is requested", () => {
    assert.equal(captureUiEnabled({}), true);
    assert.equal(captureUiEnabled({ BBLITE_CAPTURE_UI: "1" }), true);
    assert.equal(captureUiEnabled({ BBLITE_CAPTURE_UI: "0" }), false);
});

// The instrumented capture must compose the page the golden was captured
// from, and the fixed-frame derivation is the piece that can silently
// drift: the golden capture (`runParity` in parity-scene.ts) falls back
// to the native gate's BBLITE_SCREENSHOT_FRAME for a full-page capture
// of a retained-UI application. The end-to-end proof stays with
// `scene -- capture <application>`'s byte-identity line; this pins the
// derivation itself, browser-free.
function applicationScene(options: {
    referenceFrame?: number;
    nativeEnvironment?: Record<string, string>;
} = {}): SceneDefinition {
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
    // BBLITE_SCREENSHOT_FRAME — in the full-page mode only, which is
    // exactly when the golden derives it.
    const application = applicationScene({
        nativeEnvironment: { BBLITE_SCREENSHOT_FRAME: "181" },
    });
    assert.equal(
        goldenFixedFrame(application, true),
        181,
    );
    assert.equal(
        goldenFixedFrame(application, false),
        undefined,
    );
    assert.equal(
        goldenFixedFrame(application, false),
        undefined,
    );
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
            classStyles: [{ className: "hud", style: "color: red" }],
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
        await new Promise<void>((done) =>
            server.listen(0, "127.0.0.1", done),
        );
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const html = await (
            await fetch(
                `http://127.0.0.1:${address.port}/scene.html`,
            )
        ).text();
        const bootstrapIndex = html.indexOf("hostUi.classStyles");
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
        assert.match(html, /"className":"hud"/);
    } finally {
        await new Promise<void>((done) => server.close(() => done()));
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

    await gotoScenePage(
        page,
        "http://127.0.0.1:4173",
        "?seekTime=1.25",
    );

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
    const asset = resolve(
        root,
        "lab/lite/src/demos/librequake/maps/item.bsp",
    );
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

test("relocates the shared Havok binary to pinned lab/public root", () => {
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
    assert.throws(() => fixedAnimationFrameScript(0), /Invalid fixed animation frame/);
    assert.throws(() => fixedAnimationFrameScript(1.5), /Invalid fixed animation frame/);
});

test("serves entry modules from their source-relative URL", async () => {
    const root = mkdtempSync(
        resolve(".capture-suite-reference-"),
    );
    const entry = resolve(root, "nested", "entry.ts");
    const helper = resolve(root, "nested", "helper.ts");
    mkdirSync(resolve(root, "nested"));
    writeFileSync(entry, 'import "./helper.js";\n');
    writeFileSync(helper, "export const value = 1;\n");

    const server = createSuiteSceneServer(
        'import "./helper.js";\n',
        { sourcePath: entry },
    );
    try {
        await new Promise<void>((done) =>
            server.listen(0, "127.0.0.1", done),
        );
        const address = server.address();
        assert.ok(
            address && typeof address !== "string",
        );
        const base = `http://127.0.0.1:${address.port}`;
        const html = await (
            await fetch(`${base}/scene.html`)
        ).text();
        const entryPath = `/${root
            .slice(resolve(".").length + 1)
            .replaceAll("\\", "/")}/nested/entry.js`;
        assert.match(
            html,
            new RegExp(
                `src="${entryPath.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    "\\$&",
                )}"`,
            ),
        );
        const entryResponse = await fetch(
            `${base}${entryPath}`,
        );
        assert.equal(entryResponse.status, 200);
        const helperResponse = await fetch(
            `${base}${entryPath.replace(
                /entry\.js$/,
                "helper.js",
            )}`,
        );
        assert.equal(helperResponse.status, 200);
        assert.match(
            await helperResponse.text(),
            /export const value = 1/,
        );
    } finally {
        await new Promise<void>((done) =>
            server.close(() => done()),
        );
        rmSync(root, { recursive: true, force: true });
    }
});
