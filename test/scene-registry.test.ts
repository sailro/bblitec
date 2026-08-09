import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { getScene, resolveScene, scenes } from "../src/scene-registry.js";

test("registers unique generated scene targets", () => {
    assert.deepEqual(
        scenes.map(({ id }) => id),
        ["primitives", "boombox", "scene10", "scene13", "scene32", "scene163", "scene168", "scene116", "scene145", "scene146", "scene248", "scene257", "scene266", "scene273", "scene274"],
    );
    assert.equal(new Set(scenes.map(({ output }) => output)).size, scenes.length);
    assert.equal(getScene("scene10").parity?.reference.kind, "source");
    assert.equal(getScene("scene163").parity?.maxFullMad, 0.001);
    assert.equal(
        getScene("scene273").parity?.nativeEnvironment?.BBLITE_SCREENSHOT_FRAME,
        "19",
    );
    assert.equal(getScene("scene273").parity?.maxFullMad, 0.001);
    assert.equal(getScene("boombox").parity?.reference.kind, "playground");
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
