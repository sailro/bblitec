import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { sharedPinnedContext } from "../src/lowering/context.js";
import { lowerSpriteCapacity } from "../src/lowering/pinned-sprite-capacity.js";
import { lowerSpriteInstances } from "../src/lowering/pinned-sprite-instances.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import { doctoredContext } from "./doctored-store.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("Sprite2D storage checks numeric boundaries before allocation or mutation", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const context = sharedPinnedContext();
    const lowerer = new SpriteLowerer(context);
    const core = lowerer.lowerCore().source;
    const layerModule = "src/sprite/sprite-2d.ts";
    const source = context.sourceFile(layerModule);
    const constants = [
        ["sprite_instance_floats", "PURE_2D_INSTANCE_FLOATS_PER_SPRITE"],
        ["sprite_depth_instance_floats", "DEPTH_INSTANCE_FLOATS_PER_SPRITE"],
        ["sprite_saved_size_floats", "SAVED_SIZE_FLOATS_PER_SPRITE"],
    ].map(
        ([native, name]) =>
            `constexpr std::uint32_t ${native} = ${context.numericValue(context.variableInitializer(source, name!), source)}u;`,
    );
    const scrollSource = context.sourceFile("src/sprite/sprite-2d-uvscroll.ts");
    constants.push(
        `constexpr std::uint32_t sprite_uvscroll_extra_floats = ${context.numericValue(context.variableInitializer(scrollSource, "UVSCROLL_EXTRA_FLOATS_PER_SPRITE"), scrollSource)}u;`,
    );
    const wrappers = [
        "Sprite2DLayerHandle create_sprite_2d_layer(",
        "double add_sprite_2d_index(",
        "void update_sprite_2d_index(",
        "void ensure_sprite_uv_scroll(",
        "void set_sprite_2d_uv_offset(",
    ].map((signature) => cppFunction(core, signature));
    const mutated = doctoredContext(layerModule, "cap *= 2;", "cap *= 3;");
    const directory = resolve("artifacts/test-sprite-capacity-boundary");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        executable = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `#include <bblite/runtime.hpp>
#include <cassert>
#include <cmath>
#include <span>
#include <iostream>
#undef assert
#define assert(value) do { if (!(value)) { std::cerr << "assertion at " << __LINE__ << ": " << #value << "\\n"; std::exit(1); } } while(false)
namespace bbl::upstream {
${lowerer.lowerFrameResolver()}
}
namespace bbl {
${constants.join("\n")}
${cppFunction(core, "void touch_sprite_instances(")}
${lowerSpriteCapacity(context)}
${lowerSpriteInstances(context)}
${wrappers.join("\n")}
namespace mutated {
${lowerSpriteCapacity(mutated)}
}
}
template<class F> void must_throw(F&& callback) { bool threw=false; try { callback(); } catch(const std::exception&) { threw=true; } assert(threw); }
int main() {
    using namespace bbl;
    const double nan = std::numeric_limits<double>::quiet_NaN();
    const double infinity = std::numeric_limits<double>::infinity();
    for (double value : {0.0, -0.0, -1.0, -infinity, 0.5}) assert(sprite_capacity(value) == 1u);
    for (double value : {1.0, 2.0, 4294967295.0}) assert(sprite_capacity(value) == static_cast<std::uint32_t>(value));
    for (double invalid : {nan, infinity, 1.25, 4294967296.0}) must_throw([&] { (void)sprite_capacity(invalid); });
    Sprite2DLayerRecord layer;
    resize_sprite_storage(layer, 1.0);
    assert(layer.capacity == 1u && layer.instance_data.size() == 13u && layer.saved_size.size() == 2u);
    layer.count = 1;
    for (std::size_t i=0; i<layer.instance_data.size(); ++i) layer.instance_data[i] = static_cast<float>(i) + 0.25f;
    layer.saved_size = {3.25f, -4.5f};
    const auto previous_data = layer.instance_data;
    const auto previous_sizes = layer.saved_size;
    for (double invalid : {nan, infinity, -infinity, -1.0, 1.25, 4294967296.0, 4294967295.0}) {
        must_throw([&] { resize_sprite_storage(layer, invalid); });
        assert(layer.capacity == 1u && layer.instance_data == previous_data && layer.saved_size == previous_sizes);
    }
    for (double invalid : {nan, infinity, -infinity, -1.0, 1.25}) {
        must_throw([&] { grow_sprite_capacity(layer, invalid); });
        assert(layer.capacity == 1u && layer.instance_data == previous_data && layer.saved_size == previous_sizes);
    }
    for (double minimum : {2.0, 3.0}) {
        grow_sprite_capacity(layer, minimum);
        assert(layer.capacity == (minimum == 2.0 ? 2u : 4u));
        assert(layer.instance_data.size() == layer.capacity * 13u && layer.saved_size.size() == layer.capacity * 2u);
        for (std::size_t i=0; i<previous_data.size(); ++i) assert(layer.instance_data[i] == previous_data[i]);
        for (std::size_t i=previous_data.size(); i<layer.instance_data.size(); ++i) assert(layer.instance_data[i] == 0.0f);
        assert(layer.saved_size[0] == 3.25f && layer.saved_size[1] == -4.5f);
        for (std::size_t i=2; i<layer.saved_size.size(); ++i) assert(layer.saved_size[i] == 0.0f);
    }
    Sprite2DLayerRecord changed;
    mutated::resize_sprite_storage(changed, 1.0);
    changed.instance_data[0] = 6.25f; changed.saved_size[0] = 8.5f;
    mutated::grow_sprite_capacity(changed, 2.0); assert(changed.capacity == 3u);
    mutated::grow_sprite_capacity(changed, 4.0); assert(changed.capacity == 9u);
    assert(changed.instance_data[0] == 6.25f && changed.saved_size[0] == 8.5f);
    Sprite2DLayerRecord huge; huge.capacity = 2147483648u;
    must_throw([&] { grow_sprite_capacity(huge, 2147483649.0); });
    assert(huge.capacity == 2147483648u && huge.instance_data.empty() && huge.saved_size.empty());
    Sprite2DLayerRecord zero;
    must_throw([&] { grow_sprite_capacity(zero, 1.0); });
    assert(zero.capacity == 0u && zero.instance_data.empty() && zero.saved_size.empty());
    Sprite2DLayerRecord wide;
    wide.capacity = static_cast<std::uint32_t>(std::numeric_limits<std::uint32_t>::max() / (15u * sizeof(float)) + 1u);
    must_throw([&] { ensure_sprite_uv_scroll(wide); });
    assert(!wide.uv_scroll && wide.instance_data.empty() && wide.instance_floats_per_sprite == 13u);

    Engine engine; engine.sprite_atlases.emplace_back();
    Sprite2DLayerOptions options{}; options.capacity = 1.0; options.depth_mode = Sprite2DDepthMode::test;
    options.layer_z = 1.0 + 1e-9;
    const auto handle = create_sprite_2d_layer(engine, {0}, options);
    assert(engine.sprite_layers[handle.value].layer_z == 1.0 + 1e-9);
    Sprite2DProps props; props.has_position_px = true; props.position_px = {3.5, 4.5};
    props.has_size_px = true; props.size_px = {5.5, 6.5};
    assert(add_sprite_2d_index(engine, handle, props) == 0.0);
    auto& record = engine.sprite_layers[handle.value];
    const auto stored = record.instance_data;
    const auto version = record.version;
    for (double invalid : {nan, infinity, -infinity, -1.0, 0.5, 1.0, 4294967296.0}) {
        must_throw([&] { update_sprite_2d_index(engine, handle, invalid, props); });
        must_throw([&] { set_sprite_2d_uv_offset(engine, handle, invalid, {0.25f, 0.5f}); });
        assert(record.instance_data == stored && !record.uv_scroll && record.version == version);
    }
    Sprite2DProps patch; patch.has_rotation = true; patch.rotation = 0.125;
    update_sprite_2d_index(engine, handle, 0.0, patch); assert(record.instance_data[8] == 0.125f);
    set_sprite_2d_uv_offset(engine, handle, 0.0, {0.25f, 0.5f});
    assert(record.instance_floats_per_sprite == 16u && record.uv_scroll);
    assert(record.instance_data[14] == 0.25f && record.instance_data[15] == 0.5f);
    record.count = std::numeric_limits<std::uint32_t>::max();
    record.capacity = record.count;
    const auto before_overflow = record.instance_data;
    must_throw([&] { (void)add_sprite_2d_index(engine, handle, props); });
    assert(record.count == std::numeric_limits<std::uint32_t>::max() && record.instance_data == before_overflow);
    const auto layers = engine.sprite_layers.size();
    for (double invalid : {nan, infinity, 1.25, 4294967296.0, 4294967295.0}) {
        options.capacity = invalid;
        must_throw([&] { (void)create_sprite_2d_layer(engine, {0}, options); });
        assert(engine.sprite_layers.size() == layers);
    }
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/O2",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        cpp,
    ]);
    execFileSync(executable, [], {
        cwd: directory,
        stdio: "pipe",
        timeout: 15000,
    });
});
