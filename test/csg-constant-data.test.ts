import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { packBakedCsgMesh, unpackBakedCsgMesh } from "../src/pinned-csg.js";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("CSG binary transport preserves float bits, integer lanes and empty streams", () => {
    const geometry = {
        positions: Float32Array.of(-0, 0, 1 / 3),
        normals: Float32Array.of(0, 1, 0),
        indices: Uint32Array.of(0, 1, 0xffffffff),
        uvs: new Float32Array(),
    };
    const bytes = packBakedCsgMesh(geometry);
    assert.deepEqual(unpackBakedCsgMesh(bytes), geometry);
    const unaligned = new Uint8Array(bytes.length + 1);
    unaligned.set(bytes, 1);
    assert.deepEqual(unpackBakedCsgMesh(unaligned.subarray(1)), geometry);
    assert.equal(new DataView(bytes.buffer).getUint32(16, true), 0x80000000);
    assert.throws(() => unpackBakedCsgMesh(bytes.subarray(0, 15)), /header/);
    assert.throws(() => unpackBakedCsgMesh(bytes.subarray(0, bytes.length - 1)), /lengths/);
    const badCount = bytes.slice();
    new DataView(badCount.buffer).setUint32(0, 0xffffffff, true);
    assert.throws(() => unpackBakedCsgMesh(badCount), /lengths/);
});

test("repeated CSG geometry shares one packaged asset and constructs distinct meshes", () => {
    const result = compileSource(`
        import { createEngine, createBox, createCsgFromMesh, createMeshFromCsg } from "@babylonjs/lite";
        const engine = await createEngine({});
        const box = createBox(engine, 2);
        const solid = createCsgFromMesh(box);
        const first = createMeshFromCsg(engine, solid, "first");
        const second = createMeshFromCsg(engine, solid, "second");
    `);
    assert.equal(result.manifest.assets.filter(asset => asset.kind === "binary").length, 1);
    assert.equal(result.cpp.match(/bbl::create_mesh_from_data\(/g)?.length, 2);
    assert.equal(result.cpp.match(/bbl::read_baked_mesh\(/g)?.length, 2);
    assert.equal(result.manifest.sceneMeshes.length, 3);
});

test("unchanged Scene 90 packages its baked streams outside the C++ source", () => {
    const path = "corpus/babylon-lite/lab/lite/src/lite/scene90.ts";
    const result = compileSource(readFileSync(path, "utf8"), { fileName: path });
    const main = result.cpp.slice(result.cpp.indexOf("int main()"));
    const payloads = [...result.assetPayloads.values()]
        .filter(value => value.startsWith("data:application/x-bblite-mesh;base64,"))
        .map(value => Buffer.from(value.slice(value.indexOf(",") + 1), "base64"));
    assert.equal(payloads.length, 3);
    assert.ok(payloads.reduce((sum, payload) => sum + payload.byteLength, 0) > 1024 * 1024);
    assert.ok(result.cpp.length < 100000, "baked geometry must not expand into C++ literals");
    assert.ok(main.length < 100000, "immutable geometry data must not be expanded inside the loop body");
    assert.doesNotMatch(main, /static const (?:float|std::uint32_t) \w+\[\]/);
    assert.equal(result.manifest.sceneMeshes.length, 15);
});

const nativeTools = optionalNativeFixtureTools();
test("native baked-mesh transport matches generation bytes and rejects invalid lengths", { skip: !nativeTools }, () => {
    const bytes = packBakedCsgMesh({ positions: Float32Array.of(-0, 1 / 3), normals: Float32Array.of(1),
        uvs: new Float32Array(), indices: Uint32Array.of(0xffffffff) });
    const output = resolve("artifacts/csg-binary-transport-check");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(source, `
        #include <bblite/baked_mesh.hpp>
        #include <cassert>
        int main() {
            const std::vector<std::uint8_t> bytes{${[...bytes].join(",")}};
            const auto mesh = bbl::read_baked_mesh(bytes);
            assert(std::bit_cast<std::uint32_t>(mesh.positions[0]) == 0x80000000u);
            assert(std::bit_cast<std::uint32_t>(mesh.positions[1]) == 0x3eaaaaabu);
            assert(mesh.normals.size() == 1 && mesh.normals[0] == 1.0f);
            assert(mesh.uvs.empty() && mesh.indices[0] == 0xffffffffu);
            assert(bbl::read_baked_mesh(std::array<std::uint8_t, 16>{}).positions.empty());
            const auto refuses = [](std::vector<std::uint8_t> invalid) {
                bool refused = false;
                try { bbl::read_baked_mesh(invalid); } catch (const std::runtime_error&) { refused = true; }
                assert(refused);
            };
            refuses({});
            auto invalid = bytes;
            invalid.pop_back(); refuses(invalid);
            invalid = bytes; invalid.push_back(0); refuses(invalid);
            invalid = bytes; for (int i = 0; i < 4; ++i) invalid[i] = 255; refuses(invalid);
        }
    `);
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", source]);
    execFileSync(executable, { stdio: "pipe" });
});

test("packaged Scene 90 data compiles warning-clean", { skip: !nativeTools }, () => {
    const path = "corpus/babylon-lite/lab/lite/src/lite/scene90.ts";
    const output = resolve("artifacts/csg-constant-data-check");
    const includes = join(output, "bblite", "upstream");
    mkdirSync(includes, { recursive: true });
    writeFileSync(join(includes, "camera_math.hpp"), new CameraLowerer(new LoweringContext()).lowerArcRotateFactory().header);
    const source = join(output, "scene90.cpp");
    writeFileSync(source, compileSource(readFileSync(path, "utf8"), { fileName: path }).cpp);
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2", "/c",
        `/Fo:${output}\\`, "/I", output, "/I", "native\\include", source,
    ]);
});

test("shared literal tables preserve distinct typed-array storage on every evaluation", { skip: !nativeTools }, () => {
    const elements = Array.from({ length: 128 }, (_, index) => index).join(", ");
    const result = compileSource(`
        const first = new Float32Array([${elements}]);
        const second = new Float32Array([${elements}]);
        const integers = new Uint32Array([${elements}]);
        first[0] = 99;
        if (second[0] !== 0 || integers[0] !== 0) throw new Error("shared mutable literal storage");
    `);
    assert.equal(result.cpp.match(/inline const std::array<double, 128>/g)?.length, 1);
    assert.equal(result.cpp.match(/f32_array_from\(bblscene::/g)?.length, 2);
    const output = resolve("artifacts/shared-literal-storage-check");
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(source, result.cpp);
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native\\include", source,
    ]);
    execFileSync(executable, { stdio: "pipe" });
});
