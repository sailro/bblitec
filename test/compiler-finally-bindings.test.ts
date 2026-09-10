import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("finally sees a generation-only binding assigned within each static loop scope", () => {
    const result = compileSource(`
        import { createEngine, createBox, createCsgFromMesh, createMeshFromCsg } from "@babylonjs/lite";
        const engine = await createEngine({});
        for (const size of [1, 2]) {
            let solid: ReturnType<typeof createCsgFromMesh> | undefined;
            try {
                solid = createCsgFromMesh(createBox(engine, size));
            } finally {
                if (solid) {
                    createMeshFromCsg(engine, solid, "reached");
                } else {
                    throw new Error("unreachable missing solid");
                }
            }
        }
    `);
    assert.equal(result.manifest.sceneMeshes.length, 4);
    assert.equal(result.cpp.match(/bbl::create_mesh_from_data\(/g)?.length, 2);
    assert.doesNotMatch(result.cpp, /unreachable missing solid/);
});

test("a nested loop cannot establish an outer generation-only binding", () => {
    assert.throws(() => compileSource(`
        import { createEngine, createBox, createCsgFromMesh } from "@babylonjs/lite";
        const engine = await createEngine({});
        let solid: ReturnType<typeof createCsgFromMesh> | undefined;
        for (const size of [1, 2]) {
            solid = createCsgFromMesh(createBox(engine, size));
        }
    `), /assigned inside a ForOfStatement/);
});

test("hoisted finally refuses a generation record containing a try-local native handle", () => {
    assert.throws(() => compileSource(`
        import { createEngine, createBox } from "@babylonjs/lite";
        const engine = await createEngine({});
        let saved;
        try {
            const box = createBox(engine);
            saved = { box };
        } finally {
            saved.box.position.x = 1;
        }
    `), /input\.ts:\d+:\d+: A hoisted finally guard cannot reference native local 'v_\w+_box'/);
});

test("hoisted finally accepts a pure CSG plan produced from a try-local native mesh", () => {
    const result = compileSource(`
        import { createEngine, createBox, createCsgFromMesh, createMeshFromCsg } from "@babylonjs/lite";
        const engine = await createEngine({});
        let solid;
        try {
            const box = createBox(engine);
            solid = createCsgFromMesh(box);
        } finally {
            createMeshFromCsg(engine, solid, "cleanup");
        }
    `);
    assert.equal(result.manifest.sceneMeshes.length, 2);
    assert.match(result.cpp, /bbl::create_mesh_from_data\(/);
});

const nativeTools = optionalNativeFixtureTools();
function runNativeProgram(name: string, cpp: string): void {
    const output = resolve("artifacts/compiler-finally-bindings", name);
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(source, cpp);
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native\\include", source,
    ]);
    execFileSync(executable, { stdio: "pipe" });
}

test("native finally preserves return, catch, break and cleanup order", { skip: !nativeTools }, () => {
    const result = compileSource(`
        const seen: number[] = [];
        function settle(mode: number, seen: number[]): number {
            let value = 1;
            try {
                if (mode === 1) return value;
                if (mode === 2) throw new Error("caught");
                value = 3;
            } catch {
                value = 4;
            } finally {
                value += 10;
                seen.push(value);
            }
            return value;
        }
        if (settle(0, seen) !== 13 || settle(1, seen) !== 1 || settle(2, seen) !== 14) throw new Error("finally results");
        if (seen.length !== 3 || seen[0] !== 13 || seen[1] !== 11 || seen[2] !== 14) throw new Error("finally order");
        function abort(seen: number[]): void {
            try {
                throw new Error("unwind");
            } finally {
                seen.push(99);
            }
        }
        try { abort(seen); } catch {}
        if (seen.length !== 4 || seen[3] !== 99) throw new Error("unwind cleanup");
        let cleanup = 0;
        for (let i = 0; i < 3; i++) {
            try {
                if (i === 1) break;
                cleanup += i;
            } finally {
                cleanup += 10;
            }
        }
        if (cleanup !== 20) throw new Error("break cleanup");
    `);
    runNativeProgram("control-flow", result.cpp);
});

test("static-loop finally runs complete nested cleanup and can override break with continue", { skip: !nativeTools }, () => {
    const result = compileSource(`
        import { createEngine, createBox } from "@babylonjs/lite";
        const engine = await createEngine({});
        for (const size of [1, 2]) {
            try {
                createBox(engine, size);
                if (size === 1) { if (size === 1) break; }
                createBox(engine, 99);
            } finally {
                { createBox(engine, 10); createBox(engine, 20); }
            }
        }
        for (const size of [3, 4]) {
            try {
                createBox(engine, size);
                break;
            } finally {
                { createBox(engine, 30); createBox(engine, 40); continue; }
            }
        }
    `);
    assert.equal(result.manifest.sceneMeshes.length, 9);
    runNativeProgram("static-cleanup", `
#define main generated_scene_main
${result.cpp}
#undef main
#include <cassert>
namespace { unsigned calls = 0; }
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
MeshHandle create_box(Engine&, BoxOptions options) {
    constexpr float expected[]{1, 10, 20, 3, 30, 40, 4, 30, 40};
    assert(calls < std::size(expected));
    assert(options.width == expected[calls]);
    ++calls;
    return {};
}
}
int main() { assert(generated_scene_main() == 0); assert(calls == 9); }
`);
});

test("hoisted finally builds with outer native captures and its own local declarations", { skip: !nativeTools }, () => {
    const result = compileSource(`
        import { createEngine, createBox } from "@babylonjs/lite";
        const engine = await createEngine({});
        const box = createBox(engine);
        let saved;
        try {
            saved = { box };
        } finally {
            const second = createBox(engine);
            saved.box.position.x = 1;
            second.position.x = 2;
        }
        if (box.position.x !== 1) throw new Error("cleanup did not write outer box");
    `);
    runNativeProgram("visible-captures", `
#define main generated_scene_main
${result.cpp}
#undef main
#include <cassert>
namespace { unsigned writes = 0; }
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
MeshHandle create_box(Engine& engine, BoxOptions) {
    const auto index = static_cast<std::uint32_t>(engine.meshes.size());
    engine.meshes.emplace_back();
    return {index};
}
void mark_mesh_dirty(Engine& engine, MeshHandle mesh) {
    assert(engine.meshes[mesh.value].position.x == static_cast<double>(mesh.value + 1));
    ++writes;
}
}
int main() { assert(generated_scene_main() == 0); assert(writes == 2); }
`);
});

test("pure CSG and CSG2 plans build and materialize in hoisted finally guards", { skip: !nativeTools }, () => {
    for (const version of ["", "2"]) {
        const result = compileSource(`
            import { createEngine, createBox, initializeCsg2Async,
                createCsg${version}FromMesh, createMeshFromCsg${version} } from "@babylonjs/lite";
            const engine = await createEngine({});
            ${version ? "await initializeCsg2Async();" : ""}
            let solid;
            try {
                const box = createBox(engine);
                solid = createCsg${version}FromMesh(box);
            } finally {
                createMeshFromCsg${version}(engine, solid, "cleanup");
            }
        `);
        const payloads = [...result.assetPayloads.values()].filter(value => value.startsWith("data:application/x-bblite-mesh;base64,"));
        assert.equal(payloads.length, 1);
        const payload = payloads[0]!;
        const bytes = Buffer.from(payload.slice(payload.indexOf(",") + 1), "base64");
        runNativeProgram(`csg${version}-plan`, `
#define main generated_scene_main
${result.cpp}
#undef main
#include <cassert>
namespace { unsigned boxes = 0; unsigned materialized = 0; }
namespace bbl {
std::string asset_path(const std::string& path) { return path; }
namespace pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    assert(path == ${JSON.stringify(result.manifest.assets[0]!.output)});
    return {${[...bytes].join(",")}};
}
}
Engine create_engine(EngineOptions) { return {}; }
MeshHandle create_box(Engine&, BoxOptions) { ++boxes; return {}; }
MeshHandle create_mesh_from_data(Engine&, const std::string& name,
    const std::vector<float>& positions, const std::vector<float>& normals,
    const std::vector<std::uint32_t>& indices, const std::vector<float>& uvs,
    const std::vector<float>&, const std::vector<float>&, const std::vector<float>&) {
    assert(boxes == 1 && name == "cleanup");
    assert(positions.size() == 108 && normals.size() == positions.size());
    assert(indices.size() == 36 && uvs.size() == 72);
    for (const float component : positions) assert(std::abs(component) == 0.5f);
    ++materialized;
    return {};
}
}
int main() { assert(generated_scene_main() == 0); assert(materialized == 1); }
`);
    }
});
