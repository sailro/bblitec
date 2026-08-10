import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { getScene, resolveScene, scenes } from "../src/scene-registry.js";

test("registers unique generated scene targets", () => {
    assert.deepEqual(
        scenes.map(({ id }) => id),
        ["primitives", "boombox", "scene8", "scene10", "scene13", "scene32", "scene163", "scene168", "transmission-skybox", "transmission-scene-color", "transmission-ior", "transmission-volume", "scene176", "scene213", "scene116", "scene145", "scene146", "scene248", "scene249", "scene257", "scene266", "scene273", "scene274"],
    );
    assert.equal(new Set(scenes.map(({ output }) => output)).size, scenes.length);
    assert.equal(getScene("scene10").parity?.reference.kind, "source");
    assert.equal(getScene("scene163").parity?.maxFullMad, 0.001);
    assert.equal(getScene("scene8").parity?.maxFullMad, 0.2);
    assert.equal(getScene("scene176").parity?.reference.kind, "source");
    assert.equal(getScene("scene213").parity?.reference.kind, "source");
    assert.equal(
        getScene("scene273").parity?.nativeEnvironment?.BBLITE_SCREENSHOT_FRAME,
        "19",
    );
    assert.equal(getScene("scene273").parity?.maxFullMad, 0.001);
    assert.equal(getScene("boombox").parity?.reference.kind, "source");
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
    assert.equal(resolveScene("examples/scene10-pbr-rough.ts").id, "scene10");
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
    const parityScene = readFileSync("src/parity-scene.ts", "utf8");
    assert.match(parityScene, /windowsHide: true/);
    assert.match(parityScene, /BBLITE_TEST_PASS: "1"/);
});
