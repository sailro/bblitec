import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { BillboardLowerer } from "../src/lowering/billboard-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import { cppFunction, cppRecord, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test("billboard mutations invalidate uploads without discarding capacity or handle identity", { skip: !tools }, () => {
    const output = resolve("artifacts/billboard-upload");
    mkdirSync(output, { recursive: true });
    const context = new LoweringContext();
    const core = new BillboardLowerer(context, "").lowerCore();
    const sprite = new SpriteLowerer(context).lowerCore();
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8").replaceAll("\r\n", "\n");
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    const definitions = [
        "BillboardSystemHandle create_billboard_system(", "double add_billboard_sprite_index(",
        "BillboardSpriteHandle add_billboard_sprite(", "void update_billboard_sprite(",
        "void set_billboard_sprite_frame(", "bool billboard_sprite_alive(",
        "void remove_billboard_sprite(", "void clear_billboard_sprites(",
    ].map(signature => cppFunction(core.source, signature)).join("\n");
    writeFileSync(file, `
        #include <bblite/runtime.hpp>
        #include <algorithm>
        #include <cmath>
        #include <cassert>
        namespace bbl::upstream {
            ${cppFunction(sprite.header!, "inline std::uint32_t resolve_sprite_frame(")}
        }
        namespace bbl {
            ${definitions}
            ${cppRecord(shared, "struct BillboardUploadStamp {")}
            ${cppFunction(shared, "inline bool billboard_needs_upload(")}
            ${cppFunction(shared, "inline void stamp_billboard_upload(")}
        }
        int main() {
            bbl::Engine engine;
            engine.sprite_atlases.emplace_back();
            auto& atlas = engine.sprite_atlases[0];
            atlas.frames.resize(2);
            atlas.frames[0].uv_max = {1, 1};
            atlas.frames[1].uv_min = {.25f, .5f};
            atlas.frames[1].uv_max = {.75f, 1};
            bbl::BillboardSystemOptions options;
            options.capacity = 1;
            const auto handle = bbl::create_billboard_system(engine, {0}, bbl::BillboardOrientation::facing, {}, options);
            auto& system = engine.billboard_systems[handle.value];
            bbl::BillboardUploadStamp stamp;
            std::array<float, 16> view{};
            bbl::Vec3d eye{};
            const auto dirty = [&] { return bbl::billboard_needs_upload(system, stamp, view, eye); };
            const auto uploaded = [&] { bbl::stamp_billboard_upload(stamp, system, view, eye); assert(!dirty()); };
            assert(!dirty());
            bbl::BillboardSpriteProps props;
            props.has_position = true;
            props.position = {1, 2, 3};
            const auto first = bbl::add_billboard_sprite(engine, handle, props);
            assert(dirty()); uploaded();
            const auto second = bbl::add_billboard_sprite(engine, handle, props);
            assert(dirty() && system.count == 2 && system.capacity >= 2); uploaded();
            props.position = {4, 5, 6};
            bbl::update_billboard_sprite(engine, first, props);
            assert(dirty() && system.count == 2 && system.instance_data[0] == 4); uploaded();
            bbl::set_billboard_sprite_frame(engine, second, 1);
            assert(dirty() && system.count == 2); uploaded();
            view[0] = 2;
            assert(dirty()); uploaded();
            system.depth_mode = bbl::BillboardDepthMode::cutout;
            view[0] = 3;
            assert(!dirty());
            eye.x = 1000000.125;
            assert(dirty() == static_cast<bool>(BBLITE_FLOATING_ORIGIN)); uploaded();
            bbl::remove_billboard_sprite(engine, first);
            assert(dirty() && system.count == 1 && !bbl::billboard_sprite_alive(engine, first)); uploaded();
            assert(bbl::billboard_sprite_alive(engine, second));
            props.position.x = 9;
            bbl::update_billboard_sprite(engine, second, props);
            assert(system.instance_data[0] == 9 && dirty()); uploaded();
            bbl::remove_billboard_sprite(engine, first);
            assert(!dirty());
            const auto capacity = system.instance_data.capacity();
            bbl::clear_billboard_sprites(engine, handle);
            assert(!dirty() && !bbl::billboard_sprite_alive(engine, second));
            assert(system.instance_data.capacity() == capacity);
            const auto version = system.instance_version;
            bbl::clear_billboard_sprites(engine, handle);
            assert(system.instance_version == version);
            bbl::add_billboard_sprite_index(engine, handle, props);
            assert(system.count == 1 && dirty() && system.instance_data[0] == 9);
            assert(system.instance_data.capacity() == capacity); uploaded();
        }
    `);
    for (const floatingOrigin of [0, 1]) {
        runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
            `/DBBLITE_FLOATING_ORIGIN=${floatingOrigin}`, `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", file]);
        execFileSync(executable, { stdio: "pipe" });
    }
});
