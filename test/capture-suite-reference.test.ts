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

test("captures full page UI unless canvas-only attribution is requested", () => {
    assert.equal(captureUiEnabled({}), true);
    assert.equal(captureUiEnabled({ BBLITE_CAPTURE_UI: "1" }), true);
    assert.equal(captureUiEnabled({ BBLITE_CAPTURE_UI: "0" }), false);
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
