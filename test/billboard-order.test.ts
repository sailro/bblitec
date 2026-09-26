import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { billboardOrderHelpers } from "../src/lowering/billboard-order-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";
import { doctoredContext } from "./doctored-store.js";

test("billboard centers and mixed transparent draws preserve source distance and order rules", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/billboard-order");
    mkdirSync(resolve(directory, "bblite/upstream"), { recursive: true });
    writeFileSync(
        resolve(directory, "bblite/upstream/billboard_system.hpp"),
        `#pragma once\n#include <bblite/runtime.hpp>\n#include <bblite/js_data.hpp>\n#include <algorithm>\nnamespace bbl::upstream {\n${billboardOrderHelpers(new LoweringContext())}\n}
namespace bbl::changed_order {
${billboardOrderHelpers(
    doctoredContext(
        "src/frame-graph/render-task-base.ts",
        "a.renderable.order - b.renderable.order",
        "b.renderable.order - a.renderable.order",
    ),
)}
}
namespace bbl::changed_center {
${billboardOrderHelpers(
    doctoredContext(
        "src/sprite/billboard-renderable.ts",
        "center[2] = (minZ + maxZ) * 0.5",
        "center[2] = (minZ + maxZ) * 0.25",
    ),
)}
}`,
    );
    const source = resolve(directory, "check.cpp");
    const exe = resolve(directory, "check.exe");
    writeFileSync(
        source,
        `
        #include <bblite/runtime.hpp>
        #include <cassert>
        namespace bbl::upstream {
        std::array<float,16> mesh_world_matrix(const Engine&, const MeshRecord& mesh) {
            std::array<float,16> matrix{}; matrix[14]=static_cast<float>(mesh.position.z); return matrix;
        }
        }
        #include "pal_billboard_order.hpp"
        struct Item { bbl::MeshHandle mesh; double order; };
        struct Command { Item item; };
        struct List { std::vector<Command> commands; };
        struct Pass { bbl::BillboardSystemHandle system; };
        int main() {
            bbl::Engine engine;
            engine.meshes.emplace_back(); engine.meshes[0].position.z = 10;
            engine.meshes.emplace_back(); engine.meshes[1].position.z = 20;
            engine.billboard_systems.emplace_back();
            auto& system=engine.billboard_systems[0];
            system.order=220; system.count=3; system.instance_data.resize(48);
            system.instance_data[2]=6; system.instance_data[3]=1; system.instance_data[4]=1;
            system.instance_data[18]=14; system.instance_data[19]=1; system.instance_data[20]=1;
            system.instance_data[34]=1000; // zero-sized sprite does not affect the center
            std::array<float,16> view{}; view[10]=1;
            List meshes{{{{{0},200}}, {{{1},200}}}};
            std::vector<Pass> passes{{{0}}};
            bbl::CameraRecord camera;
            auto order=bbl::pal::ordered_scene_billboards(meshes,engine,passes,&camera,view);
            assert(system.world_center[2]==10 && system.drawable_count==2);
            assert(order.size()==3 && !order[0].billboard && order[0].index==1);
            assert(!order[1].billboard && order[1].index==0 && order[2].billboard);
            system.order=150;
            order=bbl::pal::ordered_scene_billboards(meshes,engine,passes,&camera,view);
            assert(order[1].billboard && order[2].index==0);
            // The generated comparator and center follow changed source bodies.
            assert(bbl::changed_order::compare_billboard_order({0,false,10,150},{1,true,10,200})>0);
            auto changed=system; changed.center_version=-1;
            bbl::changed_center::refresh_billboard_world_center(changed);
            assert(changed.world_center[2]==5);
            system.order=200;
            bool tied=false;
            try { (void)bbl::pal::ordered_scene_billboards(meshes,engine,passes,&camera,view); }
            catch(const std::runtime_error& error) { tied=std::string(error.what()).find("equal depth and order")!=std::string::npos; }
            assert(tied);
            system.visible=false;
            order=bbl::pal::ordered_scene_billboards(meshes,engine,passes,&camera,view);
            assert(order.size()==2 && order[0].index==0 && order[1].index==1);
            system.visible=true; system.order=220;
            bool camera_required=false;
            try { (void)bbl::pal::ordered_scene_billboards(meshes,engine,passes,nullptr,view); }
            catch(const std::runtime_error& error) { camera_required=std::string(error.what()).find("without a camera")!=std::string::npos; }
            assert(camera_required);
            const auto single=bbl::pal::BorrowedDrawList{meshes.commands[0]};
            assert(single.commands.size()==1 && single.commands.data()==&meshes.commands[0]);
            system.count=0; ++system.instance_version;
            bbl::upstream::refresh_billboard_world_center(system);
            assert(system.world_center[2]==0 && system.drawable_count==0);
            order=bbl::pal::ordered_scene_billboards(meshes,engine,passes,nullptr,view);
            assert(order.size()==2 && order[0].index==0);
            bbl::BillboardSystemOptions options{};
            assert(bbl::upstream::billboard_system_order(options,"transparent")==200);
            assert(bbl::upstream::billboard_system_order(options,"cutout")==100);
            options.has_order=true; options.order=220;
            assert(bbl::upstream::billboard_system_order(options,"transparent")==220);
        }
    `,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_HAS_BILLBOARDS=1",
        `/I${directory}`,
        `/I${resolve("native/include")}`,
        `/I${resolve("native/src")}`,
        source,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8" }), "");
});
