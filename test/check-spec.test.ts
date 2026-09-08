import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
    expandTape,
    listCheckIds,
    parseCheckSpec,
    readCheckSpec,
} from "../src/tooling/check-spec.js";
import { readCapturePath } from "../src/tooling/capture-path.js";
import { applyObserveHooks } from "../src/tooling/observe-run.js";
import { checkEnvironmentBase } from "../src/tooling/check-run.js";
import { getScene, resolveScene } from "../src/scene-registry.js";

// The declared-check reader: every field is checked before a native run
// is spent on it, so a mistyped expectation is an error naming the
// field, never a check that silently asserts nothing.

const minimal = {
    scene: "scene1",
    phases: [{ id: "baseline", frame: 10 }, { id: "orbit", frame: 10, tape: ["-*3", "+UiMouseLeft@1:2"] }],
    expect: [
        { kind: "capture-path", phase: "*", path: "meshes.length", equals: 3 },
        { kind: "camera-delta", phase: "orbit", vs: "baseline", key: "alpha", min: 0.1 },
        { kind: "image-mad", phase: "orbit", vs: "golden", max: 0.5 },
        { kind: "plugin", module: "checks/plugins/support.mjs" },
    ],
};

test("parses a declared check and expands tape shorthands", () => {
    const spec = parseCheckSpec(JSON.stringify(minimal), "test");
    assert.equal(spec.scene, "scene1");
    assert.equal(spec.phases.length, 2);
    assert.deepEqual(expandTape(spec.phases[1]!.tape!), ["-", "-", "-", "+UiMouseLeft@1:2"]);
    assert.equal(spec.expect[0]!.kind, "capture-path");
});

test("refuses unknown keys, kinds and undeclared phases by name", () => {
    assert.throws(
        () => parseCheckSpec(JSON.stringify({ ...minimal, frames: [] }), "test"),
        /test: unknown key 'frames'/,
    );
    assert.throws(
        () => parseCheckSpec(JSON.stringify({ ...minimal, expect: [{ kind: "pixel-count", phase: "*" }] }), "test"),
        /unknown expectation kind 'pixel-count'/,
    );
    assert.throws(
        () => parseCheckSpec(JSON.stringify({ ...minimal, expect: [{ kind: "viewport", phase: "resize", equals: [1, 2] }] }), "test"),
        /names phase 'resize', which is not declared/,
    );
    assert.throws(
        () => parseCheckSpec(JSON.stringify({ ...minimal, expect: [{ kind: "capture-same", phase: "orbit", vs: "settled", path: "camera" }] }), "test"),
        /names phase 'settled' \(vs\)/,
    );
    assert.throws(
        () => parseCheckSpec(JSON.stringify({ ...minimal, phases: [{ id: "a", frame: -1 }] }), "test"),
        /'frame' must be a non-negative integer/,
    );
    assert.throws(
        () => parseCheckSpec(JSON.stringify({ ...minimal, phases: [{ id: "a", frame: 1 }, { id: "a", frame: 2 }] }), "test"),
        /phase 'a' is declared twice/,
    );
    assert.throws(
        () => parseCheckSpec(JSON.stringify({ ...minimal, observe: { steps: [{ id: "s", actions: [{ tap: [1, 2] }] }] } }), "test"),
        /actions\[0\]: unknown key 'tap'/,
    );
    assert.throws(() => readCheckSpec("no-such-check"), /No check is declared for 'no-such-check'/);
});

test("reads a capture through the path language", () => {
    const capture = {
        frame: 12,
        camera: { alpha: 1.5 },
        meshes: [{ position: [1, 2, 3] }, { position: [4, 5, 6] }],
        draws: [{ pipeline: "shader", order: 1000 }, { pipeline: "standard", order: 0 }, { pipeline: "shader", order: 1000 }],
        materials: [{ directIntensity: 0, textures: [{ slot: "metallicRoughness", byteLength: 4 }] }, { directIntensity: 1, textures: [] }],
    };
    assert.equal(readCapturePath(capture, "frame"), 12);
    assert.equal(readCapturePath(capture, "camera.alpha"), 1.5);
    assert.equal(readCapturePath(capture, "meshes.length"), 2);
    assert.deepEqual(readCapturePath(capture, "meshes[1].position"), [4, 5, 6]);
    assert.deepEqual(readCapturePath(capture, "meshes[*].position"), [[1, 2, 3], [4, 5, 6]]);
    assert.equal(readCapturePath(capture, "draws[pipeline=shader].length"), 2);
    assert.deepEqual(readCapturePath(capture, "draws[pipeline=shader].order"), [1000, 1000]);
    assert.deepEqual(readCapturePath(capture, "materials[directIntensity=0].textures[slot=metallicRoughness].byteLength"), [[4]]);
    assert.equal(readCapturePath(capture, "camera.missing.deeper"), undefined);
    assert.throws(() => readCapturePath(capture, "draws[bad]"), /must be an index/);
});

test("applies observe hooks once and refuses ambiguous markers", () => {
    const source = "a();\nawait registerScene(scene);\nb();\n";
    assert.equal(
        applyObserveHooks(source, [{ marker: "await registerScene(scene);", inject: "hook();" }]),
        "a();\nawait registerScene(scene);\nhook();\nb();\n",
    );
    assert.equal(
        applyObserveHooks(source, [{ marker: "b();", inject: "hook();", position: "before" }]),
        "a();\nawait registerScene(scene);\nhook();\nb();\n",
    );
    assert.throws(
        () => applyObserveHooks(`${source}b();`, [{ marker: "b();", inject: "hook();" }]),
        /occurs 2 time\(s\), expected once/,
    );
});

test("spreads the registry pose before a check's own clock", () => {
    const scene = getScene("scene46");
    assert.deepEqual(checkEnvironmentBase(scene, { scene: "scene46", phases: [], expect: [] }), { BBLITE_SCREENSHOT_FRAME: "20" });
    assert.deepEqual(
        checkEnvironmentBase(scene, { scene: "scene46", base: "fixed", phases: [], expect: [] }),
        { BBLITE_SCREENSHOT_FRAME: "20", BBLITE_FRAME_DELTA_MS: String(1000 / 60) },
    );
    assert.deepEqual(checkEnvironmentBase(scene, { scene: "scene46", base: "none", phases: [], expect: [] }), {});
});

test("every declared check names a registry scene, existing plugins and unique hook markers", () => {
    const ids = listCheckIds();
    assert.ok(ids.length >= 20, `declared checks: ${ids.join(", ")}`);
    for (const id of ids) {
        const spec = readCheckSpec(id);
        const scene = resolveScene(spec.scene);
        for (const expectation of spec.expect) {
            if (expectation.kind === "plugin") {
                assert.ok(existsSync(resolve(expectation.module)), `${id}: plugin ${expectation.module}`);
            }
        }
        if (spec.observe?.initScriptFile !== undefined) {
            assert.ok(existsSync(resolve(spec.observe.initScriptFile)), `${id}: init script ${spec.observe.initScriptFile}`);
        }
        // A hook marker that no longer occurs exactly once in the corpus
        // source would fail in the browser; it fails here instead.
        const source = readFileSync(scene.source, "utf8");
        for (const hook of spec.observe?.hooks ?? []) {
            assert.equal(source.split(hook.marker).length, 2, `${id}: hook marker '${hook.marker}' in ${scene.source}`);
        }
    }
    // The plugins directory carries nothing a check does not name.
    const named = new Set(ids.flatMap((id) => readCheckSpec(id).expect.flatMap((expectation) => expectation.kind === "plugin" ? [resolve(expectation.module)] : [])));
    const initScripts = new Set(ids.flatMap((id) => { const file = readCheckSpec(id).observe?.initScriptFile; return file === undefined ? [] : [resolve(file)]; }));
    for (const name of readdirSync(resolve("checks", "plugins"))) {
        const path = resolve("checks", "plugins", name);
        assert.ok(named.has(path) || initScripts.has(path) || name === "support.mjs", `checks/plugins/${name} is named by no check`);
    }
});
