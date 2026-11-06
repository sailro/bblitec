import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { evaluatedEntryPath } from "../src/bake-cache.js";
import { buildConditionsEnvironment } from "../src/compiler-node-flags.js";
import type { JsonScalar } from "../src/compiler/syntax.js";
import { foldPackageImportConstants } from "../src/pinned-build-conditions.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { probeValue, rightHandedProbes } from "./right-handed-process.js";

const store = new UpstreamSourceStore();

test("a right-handed build reads the pin's right-handed arms", () => {
    const module = "src/camera/camera.ts";
    const mirror = "v[10] = -v[10]!;";
    assert.equal(store.rightHanded(), false);
    assert.ok(!store.getSource(module).includes(mirror));
    const [rightHanded, source] = rightHandedProbes([
        { probe: "rightHanded" },
        { probe: "pinnedSource", argument: module },
    ]);
    assert.equal(probeValue(rightHanded), true);
    const folded = String(probeValue(source));
    assert.ok(folded.includes(mirror));
    // The fold leaves no test of the constant, nor its import, behind.
    assert.doesNotMatch(folded, /_rightHanded|#coordinate-system/);
});

test("the fold keeps the branches the constants select and reads each as its literal", () => {
    const constants = new Map<string, JsonScalar>([
        ["flag", true],
        ["offset", -1],
    ]);
    assert.equal(
        foldPackageImportConstants(
            [
                'import { flag, offset } from "#constants";',
                "export const a = flag ? 1 : 2;",
                "export const b = offset.toFixed();",
                "export const c = { ...(!flag && { d: 1 }), e: 2 };",
                "if (flag) {",
                "    run();",
                "} else {",
                "    skip();",
                "}",
                "",
            ].join("\n"),
            "module.ts",
            (specifier) => (specifier === "#constants" ? constants : undefined),
        ),
        [
            "export const a = 1;",
            "export const b = (-1).toFixed();",
            "export const c = { e: 2 };",
            "run();",
            "",
        ].join("\n"),
    );
});

test("a program's conditions reach Node's own import resolution", () => {
    const environment = buildConditionsEnvironment(["babylon-lite-rh"], {
        NODE_OPTIONS: "--conditions=stale -C older --max-old-space-size=4096",
    });
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
