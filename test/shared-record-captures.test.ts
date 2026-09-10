import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { NavigationLowerer } from "../src/lowering/navigation-lowerer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const source = `
    import { createEngine, createBox, createNavigationPluginAsync, raycast, getClosestPoint } from "@babylonjs/lite";
    async function main() {
        const engine = await createEngine({});
        function marker(position: { x: number; y: number; z: number }) {
            const mesh = createBox(engine);
            mesh.position.set(position.x, position.y, position.z);
            return mesh;
        }
        let raise = 2;
        const first = marker({ x: 1, y: raise + .25, z: 3 });
        raise = 4;
        const second = marker({ x: raise - 1, y: raise + .25, z: raise + 2 });
        if (first.position.x !== 1 || first.position.y !== 2.25 || first.position.z !== 3 ||
            second.position.x !== 3 || second.position.y !== 4.25 || second.position.z !== 6)
            throw new Error("record lane dependencies");
        const nav = await createNavigationPluginAsync();
        const callbacks: (() => void)[] = [];
        {
            const hit = raycast(nav, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
            if (hit.hit && hit.hitPoint) {
                const direct = marker({ x: hit.hitPoint.x, y: hit.hitPoint.y + raise, z: hit.hitPoint.z });
                if (direct.position.x !== 11 || direct.position.y !== 16 || direct.position.z !== 13)
                    throw new Error("query record argument");
            }
            callbacks.push(() => {
                if (!hit.hit || !hit.hitPoint) throw new Error("retained hit presence");
                const later = marker({ x: hit.hitPoint.x, y: hit.hitPoint.y + raise, z: hit.hitPoint.z });
                if (later.position.x !== 11 || later.position.y !== 16 || later.position.z !== 13)
                    throw new Error("retained hit coordinates");
            });
            const miss = raycast(nav, { x: -1, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
            callbacks.push(() => { if (miss.hitPoint) throw new Error("retained miss presence"); });
            const closest = getClosestPoint(nav, { x: 1, y: 2, z: 3 });
            callbacks.push(() => {
                const later = marker(closest);
                if (later.position.x !== 21 || later.position.y !== 22 || later.position.z !== 23)
                    throw new Error("retained vector query");
            });
        }
        for (const callback of callbacks) callback();
    }
`;

const tools = optionalNativeFixtureTools(false);
test("shared record arguments retain expression and navigation query owners", { skip: !tools }, () => {
    const output = resolve("artifacts/shared-record-captures-check");
    const includes = join(output, "bblite/upstream");
    mkdirSync(includes, { recursive: true });
    writeFileSync(join(output, "program.hpp"), compileSource(source).cpp);
    writeFileSync(join(includes, "navigation.hpp"), new NavigationLowerer(new LoweringContext()).lowerNavigation(false).header);
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace { unsigned int constructions = 0, plugins = 0, rays = 0, closest_queries = 0; }
        namespace bbl {
            Engine create_engine(EngineOptions) { return {}; }
            MeshHandle create_box(Engine& engine, BoxOptions) {
                ++constructions;
                engine.meshes.emplace_back();
                return {static_cast<std::uint32_t>(engine.meshes.size() - 1)};
            }
            void mark_mesh_dirty(Engine&, MeshHandle) {}
        }
        namespace bbl::upstream {
            bbl::pal::NavigationHandle create_navigation_plugin() { ++plugins; return {}; }
            NavRaycastResult nav_raycast(bbl::pal::NavigationHandle, Vec3d start, Vec3d end) {
                ++rays;
                assert(end.x == 10 && end.y == 0 && end.z == 0);
                return {start.x == 0, {11, 12, 13}};
            }
            Vec3d nav_closest_point(bbl::pal::NavigationHandle, Vec3d position) {
                ++closest_queries;
                assert(position.x == 1 && position.y == 2 && position.z == 3);
                return {21, 22, 23};
            }
        }
        int main() {
            assert(generated_main() == 0);
            assert(constructions == 5 && plugins == 1 && rays == 2 && closest_queries == 1);
        }
    `);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native/include", file]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
