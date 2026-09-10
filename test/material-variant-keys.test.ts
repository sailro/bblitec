import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { cppFunction, cppRecord, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const native = optionalNativeFixtureTools(false);

test("material variant keys follow live shadow receivers, caster views and instance streams", { skip: !native }, async () => {
    const bits = await importPinnedModule<Record<string, number>>("material/mesh-features.js");
    for (const name of ["MSH_RECEIVE_SHADOWS", "MSH_HAS_SKELETON", "MSH_VAT",
        "MSH_HAS_THIN_INSTANCES", "MSH_HAS_INSTANCE_COLOR", "MSH_HAS_MORPH_TARGETS"])
        assert.ok(Number.isInteger(bits[name]), name);
    const output = resolve("artifacts/material-variant-keys");
    mkdirSync(output, { recursive: true });
    const source = readFileSync("native/src/pal_gpu_shared.hpp", "utf8").replaceAll("\r\n", "\n");
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `#define BBLITE_SHADOWS_ESM 1
#include <bblite/runtime.hpp>
#include <cassert>
namespace bbl::upstream {
enum class RenderMaterialKind { pbr, standard };
struct RenderDrawCommand { struct Item {
    RenderMaterialKind material_kind = RenderMaterialKind::pbr;
    MaterialHandle material{0}; MeshHandle mesh{0}; std::uint32_t geometry = invalid_handle;
} item; };
constexpr unsigned pbr_variant_material_count = 1;
constexpr std::size_t pinned_msh_receive_shadows = ${bits.MSH_RECEIVE_SHADOWS};
constexpr std::size_t pinned_msh_has_skeleton = ${bits.MSH_HAS_SKELETON};
constexpr std::size_t pinned_msh_vat = ${bits.MSH_VAT};
constexpr std::size_t pinned_msh_has_thin_instances = ${bits.MSH_HAS_THIN_INSTANCES};
constexpr std::size_t pinned_msh_has_instance_color = ${bits.MSH_HAS_INSTANCE_COLOR};
constexpr auto std_msh_has_thin_instances = pinned_msh_has_thin_instances;
constexpr auto std_msh_has_instance_color = pinned_msh_has_instance_color;
constexpr std::size_t std_msh_has_morph_targets = ${bits.MSH_HAS_MORPH_TARGETS};
constexpr std::size_t base = 1u << 20;
std::array<std::size_t, 1> pbr_renderable_mesh_features{base | pinned_msh_receive_shadows};
std::array<std::size_t, 1> standard_renderable_mesh_features{base | pinned_msh_receive_shadows};
std::size_t pbr_runtime_mesh_features = base, standard_runtime_mesh_features = base;
constexpr unsigned standard_no_color_output_flag = 1, standard_alpha_blend_flag = 2, standard_esm_shadow_output_flag = 4;
unsigned standard_material_features(const MaterialRecord&) { return 0; }
bool light_affects_mesh(const LightRecord&, std::uint32_t) { return false; }
std::string_view pinned_single_light_type(const LightRecord&) { return {}; }
unsigned pinned_pbr_light_mode(unsigned, bool) { return 0; }
}
namespace bbl::pal {
constexpr auto npos = std::size_t(-1);
${["PinnedVariantKey", "StandardVariantKey"].map(name => cppRecord(source, `struct ${name} {`)).join("\n")}
${["inline bool pinned_record_instanced(", "inline bool pinned_record_instance_colored(",
    "inline PinnedVariantKey pinned_variant_key(", "inline StandardVariantKey standard_variant_key("].map(signature => cppFunction(source, signature)).join("\n")}
}
int main() {
    using namespace bbl;
    Engine engine; Scene scene;
    engine.meshes.resize(2); engine.materials.resize(2);
    engine.materials[1].source_material = {0};
    upstream::RenderDrawCommand draw;
    for (unsigned mesh = 0; mesh < 2; ++mesh) {
        draw.item.mesh = {mesh};
        for (bool receiver : {false, true}) for (unsigned view = 0; view < 3; ++view) {
            auto& record = engine.meshes[mesh]; record.receives_shadows = receiver;
            auto& material = engine.materials[1];
            material.no_color = view == 1; material.esm_shadow = view == 2;
            draw.item.material = {1};
            const auto expected = upstream::base | (receiver && view == 0 ? upstream::pinned_msh_receive_shadows : 0);
            draw.item.material_kind = upstream::RenderMaterialKind::pbr;
            const auto pbr = pal::pinned_variant_key(scene, engine, draw);
            assert(pbr.resolved && pbr.material_index == 0 && pbr.material_view == view && pbr.mesh_features == expected);
            draw.item.material_kind = upstream::RenderMaterialKind::standard;
            const auto standard = pal::standard_variant_key(engine, draw);
            assert(standard.resolved && standard.mesh_features == expected);
        }
    }
    draw.item.material = {0}; draw.item.mesh = {1};
    auto& record = engine.meshes[1]; record.receives_shadows = false;
    for (bool pool : {false, true}) for (bool colors : {false, true}) {
        record.thin_instanced = pool;
        record.instance_colors.resize(colors ? 1 : 0);
        const auto expected = upstream::base | (pool ? upstream::pinned_msh_has_thin_instances : 0) |
            (pool && colors ? upstream::pinned_msh_has_instance_color : 0);
        draw.item.material_kind = upstream::RenderMaterialKind::pbr;
        assert(pal::pinned_variant_key(scene, engine, draw).mesh_features == expected);
        draw.item.material_kind = upstream::RenderMaterialKind::standard;
        assert(pal::standard_variant_key(engine, draw).mesh_features == expected);
    }
    record.thin_instanced = false; record.instance_colors.clear();
    record.composition_feature_row = 0;
    upstream::pbr_renderable_mesh_features[0] |= 1u << 21;
    upstream::standard_renderable_mesh_features[0] |= 1u << 21;
    draw.item.material_kind = upstream::RenderMaterialKind::pbr;
    assert(pal::pinned_variant_key(scene, engine, draw).mesh_features == (upstream::base | (1u << 21)));
    draw.item.material_kind = upstream::RenderMaterialKind::standard;
    assert(pal::standard_variant_key(engine, draw).mesh_features == (upstream::base | (1u << 21)));
}
`);
    runNativeFixtureCompiler(native!, ["/nologo", "/std:c++20", "/EHsc", "/W4", "/WX",
        `/I${resolve("native/include")}`, file, `/Fe:${executable}`, `/Fo:${join(output, "check.obj")}`]);
    execFileSync(executable, { stdio: "pipe" });
});
