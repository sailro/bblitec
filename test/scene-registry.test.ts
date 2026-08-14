import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { getScene, resolveScene, scenes } from "../src/scene-registry.js";
import { validateReferenceCapture } from "../src/parity-scene.js";

test("registers unique generated scene targets", () => {
    assert.deepEqual(
        scenes.map(({ id }) => id),
        ["primitives", "scene1", "scene3", "scene6", "scene14", "scene24", "scene28", "scene29", "scene31", "scene33", "scene35", "scene216", "scene150", "scene178", "scene210", "scene212", "scene243", "scene246", "scene247", "scene254", "scene255", "scene258", "scene259", "scene265", "scene2", "scene7", "scene8", "scene5", "scene10", "scene13", "scene32", "scene159", "scene161", "scene163", "audit-shader-frame-graph", "regression-runtime-sweep", "regression-instanced-ground", "regression-morph-ground", "regression-compiler-state", "scene168", "scene176", "scene213", "scene151", "scene154", "scene240", "regression-track-clamp", "scene116", "scene145", "scene146", "scene248", "scene245", "scene249", "scene257", "scene266", "scene267", "scene273", "scene274"],
    );
    assert.equal(new Set(scenes.map(({ output }) => output)).size, scenes.length);
    assert.equal(getScene("scene10").parity?.reference.kind, "source");
    assert.equal(getScene("scene2").parity?.maxFullMad, 0.01);
    assert.equal(getScene("scene163").parity?.maxFullMad, 0.001);
    assert.equal(
        getScene("audit-shader-frame-graph").parity?.maxFullMad,
        0.001,
    );
    assert.equal(
        getScene("audit-shader-frame-graph").sourceOrigin,
        "bblitec-regression",
    );
    assert.equal(
        getScene("regression-track-clamp").sourceOrigin,
        "bblitec-regression",
    );
    assert.equal(
        getScene("regression-compiler-state").sourceOrigin,
        "bblitec-regression",
    );
    assert.equal(getScene("scene8").parity?.maxFullMad, 0.2);
    assert.equal(getScene("scene176").parity?.reference.kind, "source");
    assert.equal(getScene("scene213").parity?.reference.kind, "source");
    assert.equal(
        getScene("scene273").parity?.nativeEnvironment?.BBLITE_SCREENSHOT_FRAME,
        "19",
    );
    assert.equal(getScene("scene273").parity?.maxFullMad, 0.001);
    assert.equal(getScene("scene1").parity?.reference.kind, "source");
    assert.throws(() => getScene("missing"), /Unknown scene/);
});

test("derives defaults for an unregistered scene source", () => {
    const source = ".cache/adhoc-scene.ts";
    mkdirSync(".cache", { recursive: true });
    writeFileSync(source, "export {};\n");
    try {
        const scene = resolveScene(source);
        assert.equal(scene.id, "adhoc-scene");
        assert.equal(scene.output, "generated/adhoc-scene");
        assert.equal(scene.buildDirectory, "native/build-adhoc-scene-release");
        assert.equal(
            scene.parity?.reference.path,
            "reference/adhoc-scene/babylon-lite-golden.png",
        );
        assert.equal(scene.parity?.maxFullMad, undefined);
    } finally {
        rmSync(source, { force: true });
    }
});

test("resolves a registered scene by source path", () => {
    assert.equal(resolveScene("corpus/babylon-lite/lab/lite/src/lite/scene10.ts").id, "scene10");
});

test("rejects ad-hoc sources that collide with registered scene ids", () => {
    const source = ".cache/scene10.ts";
    mkdirSync(".cache", { recursive: true });
    writeFileSync(source, "export {};\n");
    try {
        assert.throws(
            () => resolveScene(source),
            /derives registered scene id 'scene10'/,
        );
    } finally {
        rmSync(source, { force: true });
    }
});

test("requires explicit recapture for missing curated references", () => {
    const scene = getScene("scene10");
    const missing = resolve(
        ".cache",
        "missing-curated-reference.png",
    );
    assert.throws(
        () => validateReferenceCapture(scene, missing, false),
        /Curated reference is missing/,
    );
    assert.doesNotThrow(
        () => validateReferenceCapture(scene, missing, true),
    );

    const source = ".cache/reference-policy-adhoc.ts";
    mkdirSync(".cache", { recursive: true });
    writeFileSync(source, "export {};\n");
    try {
        const adHoc = resolveScene(source);
        assert.doesNotThrow(
            () => validateReferenceCapture(adHoc, missing, false),
        );
    } finally {
        rmSync(source, { force: true });
    }
});

test("keeps package scene commands registry-driven", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
        scripts: Record<string, string>;
    };
    const scriptNames = Object.keys(packageJson.scripts);
    assert.deepEqual(
        scriptNames.filter((name) => /^(?:compile|parity):scene\d+$/.test(name)),
        [],
    );
    assert.equal(packageJson.scripts["scenes:compile"], "npm run scene -- compile all");
    assert.equal(packageJson.scripts["scenes:build"], "npm run scene -- build all");
    assert.equal(packageJson.scripts["scenes:process"], "npm run scene -- process all");
    assert.equal(packageJson.scripts["scenes:parity"], "npm run scene -- parity all");
    const sceneCommand = readFileSync("src/scene-command.ts", "utf8");
    assert.match(
        sceneCommand,
        /process\.env\.BBLITE_CMAKE_GENERATOR \?\? "Ninja"/,
    );
    assert.match(sceneCommand, /windowsNinjaEnvironment/);
    assert.match(sceneCommand, /runGeometryOutputDiagnostics/);
    const parityScene = readFileSync("src/parity-scene.ts", "utf8");
    assert.match(parityScene, /windowsHide: true/);
    assert.match(parityScene, /BBLITE_TEST_PASS: "1"/);
});
