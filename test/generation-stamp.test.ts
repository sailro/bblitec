import assert from "node:assert/strict";
import {
    mkdirSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
    buildStampHeaderPath,
    buildStampInputsPath,
} from "../src/build-stamp.js";
import {
    generationIsCurrent,
    generationOutputFingerprint,
    generationStampPath,
    recordGeneration,
    refreshBuildStamp,
} from "../src/generation-stamp.js";

// The skip is only as safe as its miss conditions, so each one is
// exercised over a synthetic generated tree: no record, an edited input,
// an edited output, an input written while the compiler ran, and the two
// kinds of output that may move without invalidating the tree (the shader
// compiler's products and the build stamp pair a hit rewrites).

const root = resolve(".cache", "generation-stamp-test");
const scene = {
    id: "generation-stamp-probe",
    output: resolve(root, "generated"),
};
const source = resolve(root, "probe.ts");
const arguments_ = ["dist/src/cli.js", source, "--out", scene.output];

function touchBack(path: string, secondsAgo: number): void {
    const past = new Date(Date.now() - secondsAgo * 1000);
    utimesSync(path, past, past);
}

beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(generationStampPath(scene.id), { force: true });
    mkdirSync(resolve(scene.output, "upstream", "src"), { recursive: true });
    mkdirSync(resolve(scene.output, "upstream", "shaders"), { recursive: true });
    writeFileSync(source, "export const probe = 1;\n");
    writeFileSync(
        resolve(scene.output, "manifest.json"),
        JSON.stringify({
            inputs: [".cache/generation-stamp-test/probe.ts"],
        }),
    );
    writeFileSync(resolve(scene.output, "main.cpp"), "int main() {}\n");
    writeFileSync(
        resolve(scene.output, "upstream", "src", "engine.cpp"),
        "// engine\n",
    );
    writeFileSync(
        resolve(scene.output, "upstream", "shaders", "a.native.wgsl"),
        "// wgsl\n",
    );
    // Written before "the compiler ran", so a record can be taken.
    touchBack(source, 5);
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(generationStampPath(scene.id), { force: true });
});

test("a scene is regenerated until a record proves its inputs and outputs", () => {
    assert.equal(generationIsCurrent(scene, arguments_), false);
    assert.equal(recordGeneration(scene, arguments_, Date.now()), true);
    assert.equal(generationIsCurrent(scene, arguments_), true);

    // The arguments are an input: a different title is a different tree.
    assert.equal(
        generationIsCurrent(scene, [...arguments_, "--title", "x"]),
        false,
    );

    // A source edit is a miss, size kept or not: the identity is the mtime.
    writeFileSync(source, "export const probe = 2;\n");
    assert.equal(generationIsCurrent(scene, arguments_), false);

    // A hand-edited or missing output is a miss: compile keeps undoing
    // instrumentation left under generated/.
    touchBack(source, 5);
    assert.equal(recordGeneration(scene, arguments_, Date.now()), true);
    writeFileSync(resolve(scene.output, "main.cpp"), "int main() { return 1; }\n");
    assert.equal(generationIsCurrent(scene, arguments_), false);
});

test("the shader compiler's products and the stamp pair move without a miss", () => {
    recordGeneration(scene, arguments_, Date.now());
    assert.equal(generationIsCurrent(scene, arguments_), true);

    // compile-shaders.ps1 runs after generation and writes beside the
    // WGSL; those are not generation's outputs.
    for (const name of ["a.dxil", "a.slots", "a.hlsl", "shader-compiler.json"]) {
        writeFileSync(resolve(scene.output, "upstream", "shaders", name), "x");
    }
    assert.equal(generationIsCurrent(scene, arguments_), true);

    // A hit refreshes the build stamp over the unchanged tree; the record
    // stays valid across that rewrite, and a second refresh writes nothing.
    assert.equal(refreshBuildStamp(scene.output), true);
    assert.equal(refreshBuildStamp(scene.output), false);
    assert.equal(generationIsCurrent(scene, arguments_), true);
    const header = readFileSync(
        resolve(scene.output, buildStampHeaderPath),
        "utf8",
    );
    assert.match(header, /#define BBLITE_BUILD_STAMP "[0-9a-f]{64}"/);
    const listing = JSON.parse(
        readFileSync(resolve(scene.output, buildStampInputsPath), "utf8"),
    ) as { inputs: Array<{ path: string }> };
    assert.ok(listing.inputs.some(({ path }) => path === "generated/main.cpp"));
});

test("an input written while generation ran leaves no record", () => {
    const startedAt = Date.now() - 1000;
    // The edit lands after the compiler started.
    writeFileSync(source, "export const probe = 3;\n");
    assert.equal(recordGeneration(scene, arguments_, startedAt), false);
    assert.equal(generationIsCurrent(scene, arguments_), false);

    // A manifest without an input list proves nothing either way.
    writeFileSync(resolve(scene.output, "manifest.json"), "{}");
    assert.equal(recordGeneration(scene, arguments_, Date.now()), false);
});

test("the output digest sees a touched file and ignores what it excludes", () => {
    const first = generationOutputFingerprint(scene.output);
    touchBack(resolve(scene.output, "main.cpp"), 60);
    assert.notEqual(generationOutputFingerprint(scene.output), first);
    const touched = generationOutputFingerprint(scene.output);
    writeFileSync(resolve(scene.output, "upstream", "shaders", "a.dxil"), "x");
    assert.equal(generationOutputFingerprint(scene.output), touched);
});
