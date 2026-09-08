import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { importPinnedModuleWithExports } from "../src/pinned-shader-composer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const lowerer = new GltfLowerer(new LoweringContext());
const tools = optionalNativeFixtureTools(false);

test("raw normal retention is absent from ordinary glTF loaders", () => {
    assert.doesNotMatch(lowerer.lowerLoaderAdapter().source, /geometry\.local_normals/);
    const local = lowerer.lowerLoaderAdapter({ retainLocalNormals: true }).source;
    assert.match(local, /if \(normals\) \{\s*geometry\.local_normals\.resize\(positions\.count\);/);
    assert.match(local, /geometry\.local_normals\[index\] = local_normal;/);
});

test("raw normal retention refuses a pin that changes the uploaded source", () => {
    const store = new UpstreamSourceStore();
    const modulePath = "src/loader-gltf/load-gltf.ts";
    const original = store.getSourceFile.bind(store);
    const text = store.getSource(modulePath);
    assert.ok(text.includes("createMappedBuffer(engine, meshData._normals"));
    const changed = ts.createSourceFile(modulePath,
        text.replace("createMappedBuffer(engine, meshData._normals", "createMappedBuffer(engine, transformNormals(meshData._normals)"),
        ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    store.getSourceFile = path => path === modulePath ? changed : original(path);
    assert.throws(() => new GltfLowerer(new LoweringContext(store))
        .lowerLoaderAdapter({ retainLocalNormals: true }), /upload source _normals without transformation/);
});

class MappedBuffer {
    readonly bytes: ArrayBuffer;
    constructor(size: number) { this.bytes = new ArrayBuffer(size); }
    getMappedRange(): ArrayBuffer { return this.bytes; }
    unmap(): void {}
}

test("loader retains the actual pin's nonunit and signed-zero normal upload before native transforms", {
    skip: !tools,
}, async () => {
    const pin = await importPinnedModuleWithExports<{
        buildTightGltfMesh(engine: object, data: object, material: object, name: string):
            { _gpu: { normalBuffer: MappedBuffer } };
    }>("loader-gltf/load-gltf.js", ["buildTightGltfMesh"]);
    const normals = new Float32Array([-0, 0.3, 2.75, -4, 0.125, -0.75]);
    const mesh = pin.buildTightGltfMesh({ _device: {
        createBuffer: ({ size }: { size: number }) => new MappedBuffer(size),
    } }, {
        _positions: new Float32Array([-1, 2, 3, 4, 5, 6]),
        _normals: normals, _uvs: new Float32Array(4),
        _indices: new Uint32Array([0, 1, 0]), _flatNormal: false,
    }, {}, "raw normals");
    assert.deepEqual(new Uint8Array(mesh._gpu.normalBuffer.bytes), new Uint8Array(normals.buffer));
    const expected = [...new Uint32Array(mesh._gpu.normalBuffer.bytes)];
    const source = lowerer.lowerLoaderAdapter({ retainLocalNormals: true }).source;
    const begin = source.indexOf("Vec3 live_local_normal = vertex.normal;");
    const end = source.indexOf("Vec4 live_local_tangent", begin);
    assert.ok(begin >= 0 && end > begin);
    // Execute the complete production accessor/store block. The two transform
    // callbacks are deliberate sentinels: retained bytes must precede them.
    const block = source.slice(begin, end);
    const output = resolve("artifacts/node-local-normal-check");
    mkdirSync(output, { recursive: true });
    const fixture = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(fixture, `#include <bblite/runtime.hpp>
#include <bit>
#include <cassert>
#include <iostream>
using namespace bbl;
namespace bbl::upstream {
Vec3 normalize_baked_direction(Vec3) { return {10, 20, 30}; }
}
Vec3 transform_direction(int, Vec3) { return {40, 50, 60}; }
void read_normals(ModelGeometry& geometry, const std::vector<float>& source, bool animated, bool instanced) {
    const auto& buffer = source;
    const int container = 0, views = 0, accessor = 0, matrix = 0;
    const int* normals = &accessor;
    const auto read_component = [&](const auto&, int, int, int, std::size_t i, std::size_t c) {
        return source[i * 3 + c];
    };
    for (std::size_t index = 0; index < geometry.vertices.size(); ++index) {
        ModelVertex& vertex = geometry.vertices[index];
        ${block}
        assert(live_local_normal.x == 10);
        assert(vertex.normal.x == (animated || instanced ? 10 : 40));
    }
}
int main() {
    const std::vector<std::uint32_t> words{${expected.map(word => `${word}u`).join(",")}};
    std::vector<float> source;
    for (auto word : words) source.push_back(std::bit_cast<float>(word));
    for (const bool animated : {false, true}) for (const bool instanced : {false, true}) {
        ModelGeometry geometry;
        geometry.vertices.resize(2);
        geometry.local_normals.resize(2);
        read_normals(geometry, source, animated, instanced);
        for (std::size_t i = 0; i < 2; ++i) {
            const auto n = geometry.local_normals[i];
            assert(std::bit_cast<std::uint32_t>(n.x) == words[i*3]);
            assert(std::bit_cast<std::uint32_t>(n.y) == words[i*3+1]);
            assert(std::bit_cast<std::uint32_t>(n.z) == words[i*3+2]);
        }
        ModelGeometry copy = geometry;
        release_geometry_storage(geometry);
        assert(geometry.local_normals.empty() && geometry.local_normals.capacity() == 0);
        assert(copy.local_normals.size() == 2);
    }
    std::cout << "node local normals: ok\\n";
}
`);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        "/I", "native/include", `/Fo:${output}\\`, `/Fe:${executable}`, fixture]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /node local normals: ok/);
});
