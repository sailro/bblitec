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
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const lowerer = new GltfLowerer(new LoweringContext());
const tools = optionalNativeFixtureTools(false);

test("the glTF loader stores each primitive's source lanes untransformed", () => {
    const source = lowerer.lowerLoaderAdapter().source;
    assert.match(
        source,
        /if \(normals\) \{\s*vertex\.normal = Vec3\{\s*read_component\(buffer, container, views, \*normals, index, 0\),/,
    );
    assert.match(
        source,
        /vertex\.position = Vec3\{\s*read_component\(buffer, container, views, positions, index, 0\),/,
    );
    assert.doesNotMatch(
        source,
        /transform_point\(|local_normals|bind_vertices/,
    );
    assert.match(source, /record\.parent_world = mesh_world;/);
});

test("the loader refuses a pin that changes the uploaded source lanes", () => {
    const store = new UpstreamSourceStore();
    const modulePath = "src/loader-gltf/load-gltf.ts";
    const original = store.getSourceFile.bind(store);
    const text = store.getSource(modulePath);
    assert.ok(text.includes("createMappedBuffer(engine, meshData._normals"));
    const changed = ts.createSourceFile(
        modulePath,
        text.replace(
            "createMappedBuffer(engine, meshData._normals",
            "createMappedBuffer(engine, transformNormals(meshData._normals)",
        ),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
    store.getSourceFile = (path) =>
        path === modulePath ? changed : original(path);
    assert.throws(
        () => new GltfLowerer(new LoweringContext(store)).lowerLoaderAdapter(),
        /upload source _normals without transformation/,
    );
});

class MappedBuffer {
    readonly bytes: ArrayBuffer;
    constructor(size: number) {
        this.bytes = new ArrayBuffer(size);
    }
    getMappedRange(): ArrayBuffer {
        return this.bytes;
    }
    unmap(): void {}
}

test(
    "loader keeps the actual pin's nonunit and signed-zero normal upload",
    {
        skip: !tools,
    },
    async () => {
        const pin = await importPinnedModuleWithExports<{
            buildTightGltfMesh(
                this: void,
                engine: object,
                data: object,
                material: object,
                name: string,
            ): { _gpu: { normalBuffer: MappedBuffer } };
        }>("loader-gltf/load-gltf.js", ["buildTightGltfMesh"]);
        const normals = new Float32Array([-0, 0.3, 2.75, -4, 0.125, -0.75]);
        const mesh = pin.buildTightGltfMesh(
            {
                _device: {
                    createBuffer: ({ size }: { size: number }) =>
                        new MappedBuffer(size),
                },
            },
            {
                _positions: new Float32Array([-1, 2, 3, 4, 5, 6]),
                _normals: normals,
                _uvs: new Float32Array(4),
                _indices: new Uint32Array([0, 1, 0]),
                _flatNormal: false,
            },
            {},
            "raw normals",
        );
        assert.deepEqual(
            new Uint8Array(mesh._gpu.normalBuffer.bytes),
            new Uint8Array(normals.buffer),
        );
        const expected = [...new Uint32Array(mesh._gpu.normalBuffer.bytes)];
        const source = lowerer.lowerLoaderAdapter().source;
        const begin = source.indexOf("                if (normals) {");
        const end = source.indexOf("                if (tangents) {", begin);
        assert.ok(begin >= 0 && end > begin);
        // Execute the production accessor/store block over the pin's bytes.
        const block = source.slice(begin, end);
        const output = resolve("artifacts/node-local-normal-check");
        mkdirSync(output, { recursive: true });
        const fixture = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        writeFileSync(
            fixture,
            `#include <bblite/runtime.hpp>
#include <bit>
#include <cassert>
#include <iostream>
using namespace bbl;
void read_normals(ModelGeometry& geometry, const std::vector<float>& source) {
    const auto& buffer = source;
    const int container = 0, views = 0, accessor = 0;
    const int* normals = &accessor;
    const auto read_component = [&](const auto&, int, int, int, std::size_t i, std::size_t c) {
        return source[i * 3 + c];
    };
    for (std::size_t index = 0; index < geometry.vertices.size(); ++index) {
        ModelVertex vertex;
        ${block}
        geometry.vertices[index] = vertex;
    }
}
int main() {
    const std::vector<std::uint32_t> words{${expected.map((word) => `${word}u`).join(",")}};
    std::vector<float> source;
    for (auto word : words) source.push_back(std::bit_cast<float>(word));
    ModelGeometry geometry;
    geometry.vertices.resize(2);
    read_normals(geometry, source);
    for (std::size_t i = 0; i < 2; ++i) {
        const auto n = geometry.vertices[i].normal;
        assert(std::bit_cast<std::uint32_t>(n.x) == words[i*3]);
        assert(std::bit_cast<std::uint32_t>(n.y) == words[i*3+1]);
        assert(std::bit_cast<std::uint32_t>(n.z) == words[i*3+2]);
    }
    std::cout << "source normals: ok\\n";
}
`,
        );
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/MD",
            "/I",
            "native/include",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            fixture,
        ]);
        assert.match(
            execFileSync(executable, { encoding: "utf8" }),
            /source normals: ok/,
        );
    },
);
