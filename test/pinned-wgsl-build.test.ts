import assert from "node:assert/strict";
import test from "node:test";

import { packagedWgsl } from "../src/pinned-wgsl-build.js";
import { sharedUpstreamStore } from "../src/upstream-source.js";

// The four contracts every converted marker relies on, as literal
// expectations: this is the one place a hand-spelled packaged text is the
// right evidence, because it is what proves the build step ran at all.

test("a marker the build step leaves alone is the same text", () => {
    assert.equal(packagedWgsl`finalAlpha=saturate`, "finalAlpha=saturate");
});

test("a line break in the pin's source packages as one space", () => {
    assert.equal(packagedWgsl`@vertex\nfn vs(`, "@vertex fn vs(");
});

test("a kept placeholder rides through under the build's separator rules", () => {
    assert.equal(
        packagedWgsl`finalWorld = \${worldExpr} * influence;`,
        "finalWorld= ${worldExpr} *influence;",
    );
});

test("a generation-time value is joined in before packaging", () => {
    const name = "fogMode";
    const component = "x";
    const marker = packagedWgsl`let ${name} = scene.vFogInfos.${component};`;
    assert.equal(marker, "let fogMode=scene.vFogInfos.x;");
    // What the pin's own module carries after the same step.
    assert.ok(
        sharedUpstreamStore().getSource("src/shader/wgsl-fog.ts").includes(marker),
    );
});
