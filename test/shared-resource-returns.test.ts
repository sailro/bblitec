import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { meshProfileBindingCpp } from "../src/lowering/resource-profiles.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const source = `
    import { createEngine, createBox, createStandardMaterial, type Mesh } from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        function box(size: number): Mesh {
            if (size < 0) throw new Error("shared box body");
            const mesh = createBox(engine, { size });
            mesh.position.x = size;
            return mesh;
        }
        const first = box(2), second = box(3);
        function identity(mesh: Mesh): Mesh {
            if (mesh.name === "missing") throw new Error("shared identity body");
            return mesh;
        }
        const same = identity(first), again = identity(first);
        same.position.y = 7;
        const deferred = (): void => { again.position.z += 1; };
        const callbacks: (() => void)[] = [deferred];
        callbacks[0]!();
        function bundle(mesh: Mesh) { return { mesh, all: [mesh] }; }
        const bundled = bundle(createBox(engine, { size: 4 }));
        const show = true;
        const selected = show ? bundle(bundled.mesh) : null;
        const absent = !show ? bundle(bundled.mesh) : null;
        if (!selected || absent) throw new Error("selected return presence");
        let rebound = show ? bundle(bundled.mesh) : null;
        rebound = null;
        if (rebound) throw new Error("rebound return presence");
        bundled.mesh.position.y = 9;
        if (bundled.all[0]!.position.y !== 9) throw new Error("argument evaluated twice");
        const otherBundle = bundle(bundled.mesh);
        const bundles = [bundled, otherBundle];
        function mark(entry: { mesh: Mesh }): void { entry.mesh.position.x = 12; }
        class Marker { mark(entry: { mesh: Mesh }): void { entry.mesh.position.x += 1; } }
        let index = 0;
        mark(bundles[index++]!);
        const marker = new Marker();
        marker.mark(bundles[index++]!);
        if (index !== 2 || bundled.mesh.position.x !== 13) throw new Error("indexed resource argument capture");
        const mapped = bundles.map(entry => entry.mesh);
        mapped[0]!.position.z = 11;
        if (bundled.mesh.position.z !== 11) throw new Error("mapped return identity");
        class Builder {
            make(size: number): Mesh {
                if (size < 0) throw new Error("shared method factory");
                return createBox(engine, { size });
            }
        }
        const builder = new Builder();
        const third = builder.make(5), fourth = builder.make(6);
        const laterA = () => box(7), laterB = () => box(8);
        const fifth = laterA(), sixth = laterB();
        if (fifth === sixth || fifth.position.x !== 7 || sixth.position.x !== 8)
            throw new Error("factory reused across callback scopes");
        function flatten(points: readonly (readonly [number, number, number])[]) {
            return points.flat();
        }
        const points: [number, number, number][] = [[1, 2, 3], [4, 5, 6]];
        const flattened = flatten(points);
        flattened[0] = 99;
        if (flattened.length !== 6 || flattened[5] !== 6 || points[0]![0] !== 1)
            throw new Error("flat tuple order and copy");
        const nested: number[][][] = [[[1, 2], [3]], [[4]]];
        const all = nested.flat(2), shallow = nested.flat(0);
        shallow[0]![0]![0] = 8;
        if (all.join(",") !== "1,2,3,4" || nested[0]![0]![0] !== 8 || shallow === nested)
            throw new Error("flat depth and nested identity");
        first.material = createStandardMaterial();
        second.material = createStandardMaterial();
        if (first === second || third === fourth || first.position.x !== 2 || second.position.x !== 3 ||
            again.position.y !== 7 || first.position.z !== 1 || first.material === second.material)
            throw new Error("returned resource identity");
        const ranked: Mesh[] = [first, second];
        ranked.sort((left, right) => right.position.x - left.position.x);
        if (ranked[0] !== second || ranked.reduce((sum, mesh) => sum + mesh.position.x, 0) !== 5)
            throw new Error("resource comparator and reducer arguments");
        ranked.forEach((mesh, index) => { mesh.position.z = 20 + index; });
        const lookup = new Map<string, Mesh>();
        lookup.set("first", first); lookup.set("second", second);
        lookup.forEach((mesh, key, all) => {
            mesh.position.z += key.length;
            if (all.size !== 2) throw new Error("resource collection argument");
        });
        if (first.position.z !== 26 || second.position.z !== 26)
            throw new Error("resource collection callback captures");
    }
`;

test("resource factories and forwarding helpers share native bodies", () => {
    const result = compileSource(source);
    for (const marker of ["shared box body", "shared identity body", "shared method factory"]) {
        assert.equal(result.cpp.split(marker).length - 1, 1, marker);
    }
    assert.equal(result.cpp.match(/bbl::create_box\(/g)?.length, 3);
    assert.equal(result.manifest.sceneMeshes.length, 7);
    assert.ok(result.manifest.sceneMeshes.every(mesh => !mesh.runtimeInstances));
});

const tools = optionalNativeFixtureTools(false);
test("shared returns preserve identity, captures and argument evaluation", { skip: !tools }, () => {
    const output = resolve("artifacts/shared-resource-returns-check");
    const includes = join(output, "bblite/upstream");
    mkdirSync(includes, { recursive: true });
    const compiled = compileSource(source);
    writeFileSync(join(output, "program.hpp"), compiled.cpp);
    writeFileSync(join(includes, "renderer_plan.hpp"), `#pragma once
        #include <bblite/runtime.hpp>
        namespace bbl::upstream { MeshHandle bind_scene_mesh_profile(Engine&, MeshHandle, std::uint32_t); }
    `);
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace { unsigned int constructions = 0; }
        namespace bbl {
            Engine create_engine(EngineOptions) { return {}; }
            MeshHandle create_box(Engine& engine, BoxOptions options) {
                const std::array<float, 7> widths{2, 3, 4, 5, 6, 7, 8};
                assert(constructions < widths.size() && options.width == widths[constructions++]);
                engine.meshes.emplace_back();
                return {static_cast<std::uint32_t>(engine.meshes.size() - 1)};
            }
            MaterialHandle create_standard_material(Engine& engine) {
                engine.materials.emplace_back();
                return {static_cast<std::uint32_t>(engine.materials.size() - 1)};
            }
            void mark_mesh_dirty(Engine&, MeshHandle) {}
        }
        namespace bbl::upstream {
            ${meshProfileBindingCpp({ sceneRows: [0, 1, 2], staticRows: [1], rowCount: 3 })}
        }
        int main() { assert(generated_main() == 0); assert(constructions == 7); }
    `);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native\\include", file]);
    execFileSync(executable, { encoding: "utf8" });
});
