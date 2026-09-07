#define main generated_main
#include "program.hpp"
#undef main
#include <cassert>
#include <cstdio>
#include "node_factory.hpp"
#include "lifecycle.hpp"

namespace bbl { Engine create_engine(EngineOptions) { return {}; } }

int main() {
    assert(generated_main() == 0);
    const auto before = bbl::js::managed_node_count();
    bbl::NodeInputHandle retained;
    {
        bbl::Engine engine;
        auto scene = bbl::create_scene_context(engine);
        const auto a = bbl::create_node_material(engine, 0, {});
        const auto unused = bbl::create_node_material(engine, 0, {});
        assert(a.value != unused.value && engine.materials[unused.value].shader_textures.empty());
        bbl::PixelsTexture pixels;
        pixels.identity = 19;
        pixels.rgba = std::vector<std::uint8_t>{1, 2, 3, 4};
        pixels.width = pixels.height = 1;
        pixels.srgb = true;
        pixels.uv_invert_y = true;
        pixels.uv_transform.u_offset = .125;
        pixels.sampler.address_u = bbl::TextureAddressMode::mirror;
        const auto b = bbl::create_node_material(engine, 0, {bbl::node_material_texture("albedo", pixels)});
        auto map = bbl::node_material_inputs(engine, a);
        retained = *map.get("albedo");
        const auto other = *bbl::node_material_inputs(engine, b).get("albedo");
        assert(retained != other && !bbl::node_input_texture(retained));
        assert(std::holds_alternative<bbl::PixelsTexture>(*bbl::node_input_texture(other)));
        assert(std::get<bbl::PixelsTexture>(*bbl::node_input_texture(other)).identity == 19);
        engine.meshes.emplace_back(); engine.meshes.back().material = a;
        bbl::add_to_scene(scene, bbl::MeshHandle{0});
        assert(scene.deferred_builders.size() == 1 && engine.materials[a.value].shader_textures.empty());
        const auto solid = bbl::create_solid_texture(engine, .2f, .4f, .6f, 1.f);
        bbl::set_node_input_texture(retained, bbl::solid_texture_file(solid));
        // Public-map replacement does not replace the pin's private binding slot.
        map.set("albedo", other);
        assert(*bbl::node_material_inputs(engine, a).get("albedo") == other);
        engine.meshes.emplace_back(); engine.meshes.back().material = b;
        bbl::add_to_scene(scene, bbl::MeshHandle{1});
        assert(scene.deferred_builders.size() == 2);
        bbl::js::collect_cycles();
        bbl::register_scene(scene);
        assert(engine.materials[a.value].shader_textures[0].identity == solid.identity);
        const auto& bound = engine.materials[b.value].shader_textures[0];
        assert(bound.identity == 19 && bound.srgb && bound.data.uv_invert_y);
        assert(bound.data.uv_transform.u_offset == .125 && bound.data.sampler.address_u == bbl::TextureAddressMode::mirror);
        assert(bound.data.bytes.size() == 4 && bound.data.bytes[2] == 3);
        // Source-level late changes are fenced; the native slot still retains
        // the pin's already captured group when read independently.
        bbl::set_node_input_texture(retained, pixels);
        assert(engine.materials[a.value].shader_textures[0].identity == solid.identity);
        bbl::register_scene(scene);
        assert(engine.registered_scenes.size() == 1);
        bbl::dispose_scene(scene);
    }
    bbl::js::collect_cycles();
    assert(bbl::node_input_type(retained) == "texture2d");
    assert(std::get<bbl::PixelsTexture>(*bbl::node_input_texture(retained)).identity == 19);
    retained.reset();
    bbl::js::collect_cycles();
    assert(bbl::js::managed_node_count() == before);
    {
        bbl::Engine engine;
        auto scene = bbl::create_scene_context(engine);
        const auto missing = bbl::create_node_material(engine, 0, {});
        const auto solid = bbl::create_solid_texture(engine, .5f, .5f, .5f, 1.f);
        const auto valid = bbl::create_node_material(engine, 0, {bbl::node_material_texture("albedo", solid)});
        engine.meshes.emplace_back(); engine.meshes.back().material = missing;
        bbl::add_to_scene(scene, bbl::MeshHandle{0});
        engine.meshes.emplace_back(); engine.meshes.back().material = valid;
        bbl::add_to_scene(scene, bbl::MeshHandle{1});
        bool threw = false;
        try { bbl::register_scene(scene); } catch (const std::runtime_error& error) {
            threw = std::string(error.what()).find("albedo") != std::string::npos;
        }
        assert(threw && engine.registered_scenes.empty());
        assert(engine.materials[missing.value].shader_textures.empty());
        assert(engine.materials[valid.value].shader_textures[0].identity == solid.identity);
    }
    std::puts("node-input-lifecycle: ok");
}
