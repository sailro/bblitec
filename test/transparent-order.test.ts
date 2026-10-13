import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { billboardOrderHelpers } from "../src/lowering/billboard-order-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { assertExternalRenderableContracts } from "../src/lowering/external-renderable-contract.js";
import { transparentOrderHeader } from "../src/lowering/transparent-order-lowerer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { doctoredContext } from "./doctored-store.js";

/** The generated headers the merge reads, and doctored twins in their own namespaces. */
function writeOrderHeaders(directory: string): void {
    mkdirSync(resolve(directory, "bblite/upstream"), { recursive: true });
    writeFileSync(
        resolve(directory, "bblite/upstream/transparent_order.hpp"),
        transparentOrderHeader(new LoweringContext()),
    );
    writeFileSync(
        resolve(directory, "bblite/upstream/changed_order.hpp"),
        transparentOrderHeader(
            doctoredContext(
                "src/frame-graph/render-task-base.ts",
                "a.renderable.order - b.renderable.order",
                "b.renderable.order - a.renderable.order",
            ),
        ).replace("namespace bbl::upstream", "namespace bbl::changed_order"),
    );
    writeFileSync(
        resolve(directory, "bblite/upstream/billboard_system.hpp"),
        `#pragma once\n#include <bblite/runtime.hpp>\n#include <bblite/js_data.hpp>\n#include <algorithm>\nnamespace bbl::upstream {\n${billboardOrderHelpers(new LoweringContext())}\n}
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
}

/** A pinned stand-in for a mesh's world matrix: its position.z is the translation. */
const meshWorld = `
namespace bbl::upstream {
std::array<float,16> mesh_world_matrix(const Engine&, const MeshRecord& mesh) {
    std::array<float,16> matrix{}; matrix[14]=static_cast<float>(mesh.position.z); return matrix;
}
}`;

test("billboard centers and mixed transparent draws preserve source distance and order rules", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/transparent-order");
    writeOrderHeaders(directory);
    runGeneratedProgram(
        tools,
        "transparent-order",
        `
        #include <bblite/runtime.hpp>
        #include <cassert>
        ${meshWorld}
        #include "pal_transparent_order.hpp"
        #include <bblite/upstream/changed_order.hpp>
        struct Item { bbl::MeshHandle mesh; double order; };
        struct Command { Item item; };
        struct List { std::vector<Command> commands; };
        struct Pass { bbl::BillboardSystemHandle system; };
        using Kind = bbl::pal::TransparentDrawKind;
        template <class View>
        std::vector<bbl::pal::TransparentDraw> merged(const List& meshes, bbl::Engine& engine,
                const std::vector<Pass>& passes, const bbl::CameraRecord* camera, const View& view) {
            bbl::pal::TransparentOrder order(camera, view);
            order.add_meshes(meshes, engine);
            order.add_billboards(engine, passes);
            return order.sorted();
        }
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
            auto order=merged(meshes,engine,passes,&camera,view);
            assert(system.world_center[2]==10 && system.drawable_count==2);
            assert(order.size()==3 && order[0].kind==Kind::mesh && order[0].index==1);
            assert(order[1].kind==Kind::mesh && order[1].index==0 && order[2].kind==Kind::billboard);
            system.order=150;
            order=merged(meshes,engine,passes,&camera,view);
            assert(order[1].kind==Kind::billboard && order[2].index==0);
            // The generated comparator and center follow changed source bodies.
            assert(bbl::changed_order::compare_transparent_order(
                bbl::pal::TransparentDraw{0,Kind::mesh,10,150},
                bbl::pal::TransparentDraw{1,Kind::billboard,10,200})>0);
            auto changed=system; changed.center_version=-1;
            bbl::changed_center::refresh_billboard_world_center(changed);
            assert(changed.world_center[2]==5);
            system.order=200;
            bool tied=false;
            try { (void)merged(meshes,engine,passes,&camera,view); }
            catch(const std::runtime_error& error) { tied=std::string(error.what()).find("equal depth and order")!=std::string::npos; }
            assert(tied);
            system.visible=false;
            order=merged(meshes,engine,passes,&camera,view);
            assert(order.size()==2 && order[0].index==0 && order[1].index==1);
            system.visible=true; system.order=220;
            bool camera_required=false;
            try { (void)merged(meshes,engine,passes,nullptr,view); }
            catch(const std::runtime_error& error) { camera_required=std::string(error.what()).find("without a camera")!=std::string::npos; }
            assert(camera_required);
            const auto single=bbl::pal::BorrowedDrawList{meshes.commands[0]};
            assert(single.commands.size()==1 && single.commands.data()==&meshes.commands[0]);
            system.count=0; ++system.instance_version;
            bbl::upstream::refresh_billboard_world_center(system);
            assert(system.world_center[2]==0 && system.drawable_count==0);
            order=merged(meshes,engine,passes,nullptr,view);
            assert(order.size()==2 && order[0].index==0);
            bbl::BillboardSystemOptions options{};
            assert(bbl::upstream::billboard_system_order(options,"transparent")==200);
            assert(bbl::upstream::billboard_system_order(options,"cutout")==100);
            options.has_order=true; options.order=220;
            assert(bbl::upstream::billboard_system_order(options,"transparent")==220);
        }
    `,
        {
            flags: [
                "/DBBLITE_HAS_BILLBOARDS=1",
                `/I${directory}`,
                `/I${resolve("native/src")}`,
            ],
            expectedOutput: "",
        },
    );
});

test("external renderables bind, release and sort in the transparent bucket as render tasks do", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/external-renderables");
    writeOrderHeaders(directory);
    runGeneratedProgram(
        tools,
        "external-renderables",
        `
        #include <bblite/runtime.hpp>
        #include <cassert>
        #include <functional>
        ${meshWorld}
        #include "pal_transparent_order.hpp"
        std::vector<std::string> events;
        std::vector<bbl::pal::GpuRetirement> retiring;
        namespace bbl {
        // The lowered retirement: queued behind the GPU until the test drains it.
        void retire_gpu_resources(std::shared_ptr<pal::GpuRetirementState>, pal::GpuRetirement retirement) {
            retiring.push_back(std::move(retirement));
        }
        void dispose_gpu_resource_retirements(std::shared_ptr<pal::GpuRetirementState>) {}
        void run_gpu_resource_callbacks(pal::GpuRetirementBatch disposers) {
            for (const auto& dispose : *disposers) dispose();
        }
        }
        struct Batch final : bbl::GpuDrawUpdateBatch {
            std::string name; bool retired_flag=false, destroyed=false; int flushes=0;
            explicit Batch(std::string value) : name(std::move(value)) {}
            bool retired() const override { return retired_flag; }
            void mark_retired() override { retired_flag=true; }
            void reset() override { events.push_back("reset " + name); }
            void flush() override { ++flushes; events.push_back("flush " + name); }
            void destroy() override { destroyed=true; }
        };
        struct Binding final : bbl::GpuDrawBinding {
            std::string name; bbl::GpuHandle pipeline_value=std::make_shared<bbl::GpuObject>();
            std::vector<bbl::GpuDrawUpdateBatchHandle> batches;
            bbl::GpuHandle pipeline() const override { return pipeline_value; }
            void update(const bbl::GpuDrawUpdateContext&) override { events.push_back("update " + name); }
            double draw(const bbl::GpuEncoderHandle&) override { events.push_back("draw " + name); return 1; }
            std::vector<bbl::GpuDrawUpdateBatchHandle> update_batches() const override { return batches; }
        };
        struct Renderable final : bbl::GpuExternalRenderable {
            std::string name; double order_value=200; bool fail=false;
            std::optional<std::array<double,3>> center;
            std::shared_ptr<Batch> shared, latest;
            int binds=0;
            double order() const override { return order_value; }
            bool transparent() const override { return true; }
            std::optional<std::array<double,3>> world_center() const override { return center; }
            bbl::GpuDrawBindingHandle bind(const bbl::GpuRenderTargetSignature&) override {
                ++binds;
                if (fail) throw std::runtime_error("bind failed");
                auto binding=std::make_shared<Binding>(); binding->name=name;
                latest=std::make_shared<Batch>(name + std::to_string(binds));
                binding->batches={latest};
                if (shared) binding->batches.push_back(shared);
                return binding;
            }
        };
        struct Encoder final : bbl::GpuEncoder {
            void set_pipeline(const bbl::GpuHandle&) override { events.push_back("pipeline"); }
            void set_vertex_buffer(double, const bbl::GpuHandle&) override {}
            void set_bind_group(double index, const bbl::GpuHandle&) override { events.push_back("group " + std::to_string(static_cast<int>(index))); }
            void draw(double, double, double, double) override {}
        };
        struct Item { bbl::MeshHandle mesh; double order; };
        struct Command { Item item; };
        struct List { std::vector<Command> commands; };
        using Kind = bbl::pal::TransparentDrawKind;
        int main() {
            bbl::Engine engine;
            engine.meshes.emplace_back(); engine.meshes[0].position.z = 10;
            auto scene = bbl::Scene::from_state(std::make_shared<bbl::SceneState>());
            auto a = std::make_shared<Renderable>(); a->name="a";
            auto b = std::make_shared<Renderable>(); b->name="b"; b->order_value=100;
            b->shared = std::make_shared<Batch>("shared");
            scene.state->external_renderables = {a, b};
            scene.state->renderable_version = 1;
            const bbl::GpuRenderTargetSignature signature{"bgra8unorm", std::string("depth24plus-stencil8"), {}, 4};
            bbl::pal::ExternalRenderablePass pass;
            pass.follow(engine, scene, signature);
            assert(pass.size()==2 && a->binds==1 && b->binds==1);
            // prepareRenderTaskPass: every batch resets, every binding updates, every batch flushes.
            events.clear();
            pass.prepare(engine, {640, 480, std::nullopt}, nullptr);
            assert((events==std::vector<std::string>{"reset a1","reset b1","reset shared","update a","update b","flush a1","flush b1","flush shared"}));
            assert(!engine.current_encoder);
            // The bucket: a mesh 10 units deep, a renderable without a center at
            // distance 0 (order 200), one with order 100, one centered 20 deep.
            std::array<float,16> view{}; view[10]=1;
            bbl::CameraRecord camera;
            List meshes{{{{{0},200}}}};
            const auto bucket = [&](const bbl::CameraRecord* with) {
                bbl::pal::TransparentOrder order(with, view);
                order.add_meshes(meshes, engine);
                order.add_externals(pass, scene);
                return order.sorted();
            };
            auto order = bucket(&camera);
            assert(order.size()==3 && order[0].kind==Kind::mesh);
            assert(order[1].kind==Kind::external && order[1].index==1);
            assert(order[2].kind==Kind::external && order[2].index==0);
            // Each binding draws at its place: group 0, its pipeline, its draw.
            events.clear();
            const auto encoder_pass = std::make_shared<Encoder>();
            assert(pass.draw(encoder_pass, std::make_shared<bbl::GpuObject>(), order[1].index)==1);
            assert((events==std::vector<std::string>{"group 0","pipeline","draw b"}));
            // _worldCenter sorts: b at 20 draws before the mesh at 10. Read live each frame.
            b->center = std::array<double,3>{0,0,20};
            order = bucket(&camera);
            assert(order[0].kind==Kind::external && order[0].index==1 && order[1].kind==Kind::mesh);
            // Equal depth and order across families has no retained source order.
            b->center.reset(); engine.meshes[0].position.z = 0; meshes.commands[0].item.order = 100;
            bool tied=false;
            try { (void)bucket(&camera); }
            catch (const std::runtime_error& error) { tied=std::string(error.what()).find("equal depth and order")!=std::string::npos; }
            assert(tied);
            bool camera_required=false;
            try { (void)bucket(nullptr); }
            catch (const std::runtime_error& error) { camera_required=std::string(error.what()).find("without a camera")!=std::string::npos; }
            assert(camera_required);
            // Without a camera the renderables alone keep binding order.
            meshes.commands.clear();
            order = bucket(nullptr);
            assert(order.size()==2 && order[0].index==0 && order[1].index==1);
            // An unchanged version keeps the generation, but every frame checks the families
            // the bucket cannot order: a later splat cloud refuses.
            pass.follow(engine, scene, signature);
            assert(a->binds==1);
            scene.splat_meshes.push_back(bbl::SplatMeshHandle{0});
            bool unmerged=false;
            try { (void)bucket(&camera); }
            catch (const std::runtime_error& error) { unmerged=std::string(error.what()).find("draw outside that order")!=std::string::npos; }
            assert(unmerged);
            scene.splat_meshes.clear();
            // A failed bind releases the candidate generation at once, keeping the
            // published generation's batches.
            const auto a1 = a->latest; const auto b1 = b->latest;
            b->fail = true; scene.state->renderable_version = 2;
            bool failed=false;
            try { pass.follow(engine, scene, signature); }
            catch (const std::runtime_error& error) { failed=std::string(error.what())=="bind failed"; }
            assert(failed && a->latest!=a1 && a->latest->retired_flag && a->latest->destroyed);
            assert(!a1->retired_flag && !b1->retired_flag && !b->shared->retired_flag && retiring.empty());
            assert(pass.size()==2);
            // A published generation retires the previous one's dropped batches behind the GPU.
            b->fail = false;
            pass.follow(engine, scene, signature);
            assert(a1->retired_flag && b1->retired_flag && !a1->destroyed && !b->shared->retired_flag);
            assert(retiring.size()==1);
            retiring[0](); retiring.clear();
            assert(a1->destroyed && b1->destroyed && !b->shared->destroyed);
            // The renderer's end retires every batch.
            pass.release(engine);
            assert(pass.empty() && b->shared->retired_flag && retiring.size()==1);
            retiring[0]();
            assert(b->shared->destroyed && a->latest->destroyed);
        }
    `,
        {
            flags: [
                "/DBBLITE_HAS_BILLBOARDS=0",
                "/DBBLITE_EXTERNAL_RENDERABLES=1",
                `/I${directory}`,
                `/I${resolve("native/src")}`,
            ],
            expectedOutput: "",
        },
    );
});

test("the transcribed render-task protocol refuses a changed pin", () => {
    assertExternalRenderableContracts(new LoweringContext());
    assert.throws(
        () =>
            assertExternalRenderableContracts(
                doctoredContext(
                    "src/render/draw-update-batches.ts",
                    "if (engine) {\n        retireGpuResources",
                    "if (!engine) {\n        retireGpuResources",
                ),
            ),
        /draw-update-batches\.ts#releaseBatches external-renderable contract statement/,
    );
});
