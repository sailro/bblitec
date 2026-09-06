import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test("transparent bindings observe bare hide/show each frame while opaque bundles defer", { skip: !tools }, () => {
    const output = resolve("artifacts/transparent-visibility");
    mkdirSync(output, { recursive: true });
    emitUpstreamGenerated(output, ["camera:free", "renderer:scene"]);
    writeFileSync(join(output, "check.cpp"), `
        #include "renderer_plan.cpp"
        #include <cassert>
        namespace bbl::upstream {
        std::array<CameraMatrixScalar, 16> camera_world_matrix(const CameraRecord&) {
            return {1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1};
        }
        }
        int main() {
            bbl::Engine engine;
            engine.meshes.resize(3);
            engine.meshes[0].visible = false;
            engine.meshes[1].visible = false;
            engine.meshes[2].visible = false;
            bbl::upstream::RenderDrawLists lists;
            bbl::upstream::RenderItem opaque;
            opaque.mesh.value = 0;
            bbl::upstream::RenderItem alpha = opaque;
            alpha.mesh.value = 1;
            alpha.bucket = bbl::upstream::RenderBucket::alpha_blend;
            bbl::upstream::RenderItem transmission = opaque;
            transmission.mesh.value = 2;
            transmission.transmissive = true;
            bbl::upstream::append_draw(lists, 0, opaque, engine);
            bbl::upstream::append_draw(lists, 1, alpha, engine);
            bbl::upstream::append_draw(lists, 2, transmission, engine);
            assert(lists.opaque.commands.empty() && lists.transparent.commands.empty());
            const bbl::CameraRecord camera;
            for (const bool visible : {true, false, true}) {
                for (auto& mesh : engine.meshes) mesh.visible = visible;
                bbl::upstream::sort_transparent_draws(lists.transparent, engine, camera);
                assert(lists.opaque.commands.empty());
                assert(lists.transparent.commands.size() == (visible ? 2u : 0u));
                if (visible) {
                    assert(lists.transparent.commands[0].item.mesh.value == 1);
                    assert(lists.transparent.commands[1].item.mesh.value == 2);
                }
            }
            engine.meshes[1].thin_instanced = true;
            engine.meshes[1].instance_count = 0;
            bbl::upstream::sort_transparent_draws(lists.transparent, engine, camera);
            assert(lists.transparent.commands.size() == 1);
            engine.meshes[1].instance_count = 1;
            bbl::upstream::sort_transparent_draws(lists.transparent, engine, camera);
            assert(lists.transparent.commands.size() == 2);
        }
    `);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", "/Gy", "/permissive-",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include",
        "/I", join(output, "upstream/include"), "/I", join(output, "upstream/src"),
        join(output, "check.cpp"), "/link", "/OPT:REF",
    ]);
    execFileSync(executable, { encoding: "utf8" });
});
