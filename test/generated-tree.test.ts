import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { GeneratedTree } from "../src/generated-tree.js";

function scratchTree(): { root: string; tree: GeneratedTree } {
    const root = mkdtempSync(join(tmpdir(), "bblitec-tree-"));
    return { root, tree: new GeneratedTree(root) };
}

/** An mtime far enough in the past to be unambiguous. */
function ageFile(path: string): number {
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(path, past, past);
    return statSync(path).mtimeMs;
}

test("rewrites a generated file only when its bytes change", (t) => {
    const { root, tree } = scratchTree();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    tree.write("upstream/src/engine.cpp", "void engine() {}\n");
    const path = resolve(root, "upstream/src/engine.cpp");
    const aged = ageFile(path);

    tree.write("upstream/src/engine.cpp", "void engine() {}\n");
    assert.equal(
        statSync(path).mtimeMs,
        aged,
        "identical content leaves the file untouched",
    );

    tree.write("upstream/src/engine.cpp", "void engine() { }\n");
    assert.notEqual(statSync(path).mtimeMs, aged);
    assert.equal(
        readFileSync(path, "utf8"),
        "void engine() { }\n",
    );
});

test("treats a truncated or unreadable file as a rewrite", (t) => {
    const { root, tree } = scratchTree();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const path = resolve(root, "main.cpp");
    tree.write("main.cpp", "int main() { return 0; }\n");
    writeFileSync(path, "int main() {");
    ageFile(path);
    tree.write("main.cpp", "int main() { return 0; }\n");
    assert.equal(
        readFileSync(path, "utf8"),
        "int main() { return 0; }\n",
        "a size mismatch always falls through to the write",
    );
});

test("prunes what a run no longer emits", (t) => {
    const { root, tree } = scratchTree();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    tree.write("upstream/src/engine.cpp", "void engine() {}\n");
    tree.write("upstream/src/camera.cpp", "void camera() {}\n");
    tree.prune("upstream");
    assert.ok(existsSync(resolve(root, "upstream/src/camera.cpp")));

    // A second run that no longer reaches the camera source drops it.
    const next = new GeneratedTree(root);
    next.write("upstream/src/engine.cpp", "void engine() {}\n");
    next.prune("upstream");
    assert.ok(existsSync(resolve(root, "upstream/src/engine.cpp")));
    assert.ok(!existsSync(resolve(root, "upstream/src/camera.cpp")));
});

test("keeps shader artifacts whose WGSL is still emitted", (t) => {
    const { root, tree } = scratchTree();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    // Shader compilation runs after generation and writes into the same
    // directory, so pruning must not treat its outputs as orphans.
    tree.write(
        "upstream/shaders/pbr.frag.native.wgsl",
        "@fragment fn mainFragment() {}\n",
    );
    tree.write(
        "upstream/shaders/standard.frag.native.wgsl",
        "@fragment fn mainFragment() {}\n",
    );
    mkdirSync(resolve(root, "upstream/shaders"), {
        recursive: true,
    });
    for (const name of [
        "pbr.frag.dxil",
        "pbr.frag.hlsl",
        "pbr.frag.msl",
        "pbr.frag.spv",
        "pbr.frag.tint-reflection.txt",
        "standard.frag.dxil",
        "shader-compiler.json",
    ]) {
        writeFileSync(
            resolve(root, "upstream/shaders", name),
            name,
        );
    }
    tree.prune("upstream");
    for (const name of [
        "pbr.frag.dxil",
        "pbr.frag.hlsl",
        "pbr.frag.msl",
        "pbr.frag.spv",
        "pbr.frag.tint-reflection.txt",
        "shader-compiler.json",
    ]) {
        assert.ok(
            existsSync(resolve(root, "upstream/shaders", name)),
            `${name} survives while its WGSL is emitted`,
        );
    }

    // When the scene stops reaching a shader, its compiled outputs go
    // with the WGSL instead of lingering in the deployed payload.
    const next = new GeneratedTree(root);
    next.write(
        "upstream/shaders/pbr.frag.native.wgsl",
        "@fragment fn mainFragment() {}\n",
    );
    next.prune("upstream");
    assert.ok(
        existsSync(resolve(root, "upstream/shaders/pbr.frag.dxil")),
    );
    assert.ok(
        !existsSync(
            resolve(root, "upstream/shaders/standard.frag.dxil"),
        ),
    );
    assert.ok(
        !existsSync(
            resolve(
                root,
                "upstream/shaders/standard.frag.native.wgsl",
            ),
        ),
    );
});

test("keeps a file another stage owns when it is claimed", (t) => {
    const { root, tree } = scratchTree();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    mkdirSync(resolve(root, "upstream"), { recursive: true });
    writeFileSync(
        resolve(root, "upstream/gltf-specialization.json"),
        "[]\n",
    );
    tree.write("upstream/src/engine.cpp", "void engine() {}\n");
    tree.keep("upstream/gltf-specialization.json");
    tree.prune("upstream");
    assert.ok(
        existsSync(
            resolve(root, "upstream/gltf-specialization.json"),
        ),
    );
});
