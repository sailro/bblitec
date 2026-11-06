import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { evaluatedEntryPath } from "../src/bake-cache.js";
import { buildConditionsEnvironment } from "../src/pinned-build-conditions.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

const store = new UpstreamSourceStore();

test("a right-handed build reads the pin's right-handed arms", () => {
    assert.equal(store.rightHanded([]), false);
    assert.equal(store.rightHanded(["babylon-lite-rh"]), true);
    const module = "src/camera/camera.ts";
    const mirror = "v[10] = -v[10]!;";
    assert.ok(!store.getSource(module, []).includes(mirror));
    assert.ok(store.getSource(module, ["babylon-lite-rh"]).includes(mirror));
    // The fold leaves no test of the constant, nor its import, behind.
    assert.doesNotMatch(
        store.getSource(module, ["babylon-lite-rh"]),
        /_rightHanded|#coordinate-system/,
    );
});

test("a program's conditions reach Node's own import resolution", () => {
    const environment = buildConditionsEnvironment(["babylon-lite-rh"], {
        NODE_OPTIONS: "--conditions=stale --max-old-space-size=4096",
    });
    assert.equal(environment.BBLITE_BUILD_CONDITIONS, "babylon-lite-rh");
    assert.equal(
        environment.NODE_OPTIONS,
        "--max-old-space-size=4096 --conditions=babylon-lite-rh",
    );
    assert.equal(buildConditionsEnvironment([], {}).NODE_OPTIONS, "");
});

test("a side-effect entry evaluates the module it imports", () => {
    const lab = "corpus/babylon-lite/lab/lite/src/lite";
    assert.equal(
        evaluatedEntryPath(resolve(lab, "scene321.ts")),
        resolve(lab, "scene2.ts"),
    );
    assert.equal(
        evaluatedEntryPath(resolve(lab, "scene2.ts")),
        resolve(lab, "scene2.ts"),
    );
});
