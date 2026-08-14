import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    buildStampHeader,
    buildStampHeaderPath,
    comparePayload,
    computeBuildStamp,
    readCacheConfiguration,
} from "../src/build-stamp.js";

function scratchRepository(): string {
    const root = mkdtempSync(join(tmpdir(), "bblitec-stamp-"));
    mkdirSync(resolve(root, "native/src"), { recursive: true });
    mkdirSync(resolve(root, "native/include/bblite"), {
        recursive: true,
    });
    writeFileSync(
        resolve(root, "native/CMakeLists.txt"),
        "project(bblite)\n",
    );
    writeFileSync(
        resolve(root, "native/src/pal.cpp"),
        "int pal() { return 0; }\n",
    );
    writeFileSync(
        resolve(root, "native/include/bblite/runtime.hpp"),
        "#pragma once\n",
    );
    mkdirSync(
        resolve(root, "generated/scene/upstream/src"),
        { recursive: true },
    );
    mkdirSync(
        resolve(root, "generated/scene/upstream/shaders"),
        { recursive: true },
    );
    writeFileSync(
        resolve(root, "generated/scene/main.cpp"),
        "int main() { return 0; }\n",
    );
    writeFileSync(
        resolve(root, "generated/scene/features.cmake"),
        "set(BBLITE_FEATURES core)\n",
    );
    writeFileSync(
        resolve(root, "generated/scene/upstream/src/engine.cpp"),
        "void engine() {}\n",
    );
    return root;
}

test("digests the compiled inputs of a generated scene", (t) => {
    const root = scratchRepository();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const generated = resolve(root, "generated/scene");

    const first = computeBuildStamp(generated, root);
    assert.match(first.stamp, /^[0-9a-f]{64}$/);
    assert.deepEqual(
        computeBuildStamp(generated, root).stamp,
        first.stamp,
        "the same tree digests identically",
    );

    // Both halves of the compiled input set move the stamp.
    writeFileSync(
        resolve(generated, "upstream/src/engine.cpp"),
        "void engine() { return; }\n",
    );
    const afterGenerated = computeBuildStamp(generated, root);
    assert.notEqual(afterGenerated.stamp, first.stamp);

    writeFileSync(
        resolve(root, "native/src/pal.cpp"),
        "int pal() { return 1; }\n",
    );
    assert.notEqual(
        computeBuildStamp(generated, root).stamp,
        afterGenerated.stamp,
    );
});

test("keeps the stamp independent of the payload and of itself", (t) => {
    const root = scratchRepository();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const generated = resolve(root, "generated/scene");
    const before = computeBuildStamp(generated, root).stamp;

    // Shaders and assets are deployed rather than compiled, and the stamp
    // header is derived from the digest, so none of them may feed it.
    writeFileSync(
        resolve(generated, "upstream/shaders/pbr.frag.native.wgsl"),
        "@fragment fn mainFragment() {}\n",
    );
    mkdirSync(resolve(generated, "assets"), { recursive: true });
    writeFileSync(
        resolve(generated, "assets/model.glb"),
        "glTF",
    );
    mkdirSync(
        resolve(
            generated,
            "upstream/include/bblite/upstream",
        ),
        { recursive: true },
    );
    writeFileSync(
        resolve(generated, buildStampHeaderPath),
        buildStampHeader(before),
    );
    assert.equal(
        computeBuildStamp(generated, root).stamp,
        before,
    );
});

test("compares a deployed payload against its generated source", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblitec-payload-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = resolve(root, "generated/upstream/shaders");
    const deployed = resolve(root, "build/shaders");
    mkdirSync(source, { recursive: true });
    mkdirSync(deployed, { recursive: true });
    writeFileSync(resolve(source, "pbr.frag.dxil"), "DXBC-1");
    writeFileSync(resolve(deployed, "pbr.frag.dxil"), "DXBC-1");
    assert.deepEqual(comparePayload(source, deployed), []);

    // The build's own marker files are not payload.
    writeFileSync(resolve(deployed, ".snapshot-stamp"), "");
    assert.deepEqual(comparePayload(source, deployed), []);

    writeFileSync(resolve(deployed, "pbr.frag.dxil"), "DXBC-2");
    assert.deepEqual(comparePayload(source, deployed), [
        { path: "pbr.frag.dxil", reason: "changed" },
    ]);

    rmSync(resolve(deployed, "pbr.frag.dxil"));
    assert.deepEqual(comparePayload(source, deployed), [
        { path: "pbr.frag.dxil", reason: "missing" },
    ]);

    writeFileSync(resolve(source, "pbr.frag.dxil"), "DXBC-1");
    writeFileSync(resolve(deployed, "pbr.frag.dxil"), "DXBC-1");
    writeFileSync(resolve(deployed, "orphan.dxil"), "DXBC-0");
    assert.deepEqual(comparePayload(source, deployed), [
        { path: "orphan.dxil", reason: "unexpected" },
    ]);
});

test("reads the cache values that shape a build directory", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bblitec-cache-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.equal(readCacheConfiguration(root), undefined);
    writeFileSync(
        resolve(root, "CMakeCache.txt"),
        [
            "# comment",
            "BBLITE_BACKEND:STRING=BOTH",
            "CMAKE_GENERATOR:INTERNAL=Ninja",
            "BBLITE_GENERATED_DIR:PATH=C:/Dev/generated/scene1",
            "",
        ].join("\n"),
    );
    const cache = readCacheConfiguration(root);
    assert.equal(cache?.BBLITE_BACKEND, "BOTH");
    assert.equal(cache?.CMAKE_GENERATOR, "Ninja");
    assert.equal(
        cache?.BBLITE_GENERATED_DIR,
        "C:/Dev/generated/scene1",
    );
});
