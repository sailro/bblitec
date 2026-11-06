import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { materialShadowReceiverCpp } from "../src/lowering/material-shadow-receiver.js";
import { lowerMeshFeatures } from "../src/lowering/mesh-attribute-features.js";
import { rightHandedContext } from "./doctored-store.js";
import { pbrMaterialBlendsCpp } from "../src/pinned-pbr-variant-cpp.js";
import {
    cppFunction,
    cppRecord,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    sharedGpuSource,
} from "./native-fixture.js";

const native = optionalNativeFixtureTools(false);

test("a right-handed build's winding bit stays out of the native mesh feature word", () => {
    // `_computeMeshFeatures` ORs in the loader's winding bit right-handed;
    // the mesh's front face carries it natively, as for the mirrored opt-in.
    assert.equal(
        lowerMeshFeatures(rightHandedContext()),
        lowerMeshFeatures(new LoweringContext()),
    );
    assert.throws(
        () =>
            lowerMeshFeatures(
                rightHandedContext(
                    new Map([
                        [
                            "src/material/mesh-features.ts",
                            [
                                "._primitiveFeatures ?? 0) & (1 << 11);",
                                "._primitiveFeatures ?? 0) & (1 << 12);",
                            ],
                        ],
                    ]),
                ),
            ),
        /_primitiveFeatures/,
    );
});

test(
    "material variant keys follow live shadow receivers, caster views and instance streams",
    { skip: !native },
    async () => {
        const bits = await importPinnedModule<Record<string, number>>(
            "material/mesh-features.js",
        );
        for (const name of [
            "MSH_RECEIVE_SHADOWS",
            "MSH_HAS_SKELETON",
            "MSH_VAT",
            "MSH_HAS_THIN_INSTANCES",
            "MSH_HAS_INSTANCE_COLOR",
            "MSH_HAS_MORPH_TARGETS",
        ])
            assert.ok(Number.isInteger(bits[name]), name);
        const output = resolve("artifacts/material-variant-keys");
        mkdirSync(output, { recursive: true });
        const source = sharedGpuSource().replaceAll("\r\n", "\n");
        const file = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        writeFileSync(
            file,
            `#define BBLITE_SHADOWS_ESM 1
#define BBLITE_STANDARD_SKELETON 0
#define BBLITE_STANDARD_VERTEX_ALPHA 0
#define BBLITE_RECT_AREA_LIGHTS 0
#include <bblite/runtime.hpp>
#include <cassert>
namespace bbl::upstream {
${materialShadowReceiverCpp(new LoweringContext())}
${lowerMeshFeatures(new LoweringContext())}
enum class RenderMaterialKind { pbr, standard };
struct RenderDrawCommand { struct Item {
    RenderMaterialKind material_kind = RenderMaterialKind::pbr;
    MaterialHandle material{0}; MeshHandle mesh{0}; std::uint32_t geometry = invalid_handle;
} item; };
constexpr unsigned pbr_variant_material_count = 4;
constexpr std::array<std::uint32_t, 1> pbr_scene_material_indices{0};
struct PbrMaterialStateRow { std::uint32_t source_row; bool blend; std::uint8_t plugin_signature; bool base_color_factor_written; bool bent_normal_texture; std::uint32_t row; };
// Row 0's own state, its blending state, its state holding plugin list 1
// and its state holding a bent normal texture.
constexpr std::array<PbrMaterialStateRow, 4> pbr_material_state_rows{{
    {0u, false, 0u, false, false, 0u}, {0u, true, 0u, false, false, 1u}, {0u, false, 1u, false, false, 2u},
    {0u, false, 0u, false, true, 3u}}};
${pbrMaterialBlendsCpp(new LoweringContext())}
constexpr std::size_t pinned_msh_receive_shadows = ${bits.MSH_RECEIVE_SHADOWS};
constexpr std::size_t pinned_msh_has_skeleton = ${bits.MSH_HAS_SKELETON};
constexpr std::size_t pinned_msh_vat = ${bits.MSH_VAT};
constexpr std::size_t pinned_msh_has_thin_instances = ${bits.MSH_HAS_THIN_INSTANCES};
constexpr std::size_t pinned_msh_has_instance_color = ${bits.MSH_HAS_INSTANCE_COLOR};
constexpr std::size_t std_msh_has_morph_targets = ${bits.MSH_HAS_MORPH_TARGETS};
constexpr std::size_t base = 1u << 20;
std::array<std::size_t, 1> pbr_renderable_mesh_features{base | pinned_msh_receive_shadows};
std::array<std::size_t, 1> standard_renderable_mesh_features{base | pinned_msh_receive_shadows};
std::size_t pbr_runtime_mesh_features = base, standard_runtime_mesh_features = base;
constexpr unsigned standard_no_color_output_flag = 1, standard_alpha_blend_flag = 2, standard_esm_shadow_output_flag = 4;
unsigned standard_material_features(const MaterialRecord&) { return 0; }
bool light_affects_mesh(const LightRecord&, MeshHandle) { return false; }
std::string_view pinned_light_type(LightKind) { return {}; }
struct MeshLightSelection { std::uint32_t count = 0; std::string_view single_type; };
MeshLightSelection mesh_light_selection(const Engine&, const Scene&, MeshHandle) { return {}; }
unsigned pinned_pbr_light_mode(unsigned, bool) { return 0; }
}
namespace bbl::pal {
constexpr auto npos = std::size_t(-1);
${["PinnedVariantKey", "StandardVariantKey", "PinnedPbrMaterialRow"].map((name) => cppRecord(source, `struct ${name} {`)).join("\n")}
${[
    "inline bool pinned_record_instanced(",
    "inline bool pinned_record_instance_colored(",
    "PinnedPbrMaterialRow pinned_pbr_material_row(",
    "PinnedVariantKey pinned_variant_key(",
    "StandardVariantKey standard_variant_key(",
]
    .map((signature) => cppFunction(source, signature))
    .join("\n")}
}
int main() {
    using namespace bbl;
    Engine engine; Scene scene;
    engine.lights.emplace_back(); scene.lights.push_back(LightHandle{0u});
    engine.meshes.resize(2); engine.materials.resize(2);
    engine.materials[1].source_material = {0};
    upstream::RenderDrawCommand draw;
    for (unsigned mesh = 0; mesh < 2; ++mesh) {
        draw.item.mesh = {mesh};
        for (bool shadows : {false, true}) for (bool receiver : {false, true}) for (unsigned view = 0; view < 3; ++view) {
            engine.lights[0].shadow_generator = ShadowGeneratorHandle{shadows ? 0u : invalid_handle};
            auto& record = engine.meshes[mesh]; record.receives_shadows = receiver;
            auto& material = engine.materials[1];
            material.no_color = view == 1; material.esm_shadow = view == 2;
            draw.item.material = {1};
            const auto expected = upstream::base | (shadows && receiver && view == 0 ? upstream::pinned_msh_receive_shadows : 0);
            draw.item.material_kind = upstream::RenderMaterialKind::pbr;
            const auto pbr = pal::pinned_variant_key(scene, engine, draw);
            assert(pbr.resolved && pbr.material_index == 0 && pbr.material_view == view && pbr.mesh_features == expected);
            draw.item.material_kind = upstream::RenderMaterialKind::standard;
            const auto standard = pal::standard_variant_key(scene, engine, draw);
            assert(standard.resolved && standard.mesh_features == expected);
        }
    }
    draw.item.material = {0}; draw.item.mesh = {1};
    auto& record = engine.meshes[1]; record.receives_shadows = false;
    for (bool pool : {false, true}) for (bool colors : {false, true}) {
        record.thin_instances = pool ? std::make_shared<ThinInstancePoolData>() : nullptr;
        if (pool && colors) record.thin_instances->colors = js::F32Array(4);
        const auto expected = upstream::base | (pool ? upstream::pinned_msh_has_thin_instances : 0) |
            (pool && colors ? upstream::pinned_msh_has_instance_color : 0);
        draw.item.material_kind = upstream::RenderMaterialKind::pbr;
        assert(pal::pinned_variant_key(scene, engine, draw).mesh_features == expected);
        draw.item.material_kind = upstream::RenderMaterialKind::standard;
        assert(pal::standard_variant_key(scene, engine, draw).mesh_features == expected);
    }
    record.thin_instances.reset();
    record.composition_feature_row = 0;
    upstream::pbr_renderable_mesh_features[0] |= 1u << 21;
    upstream::standard_renderable_mesh_features[0] |= 1u << 21;
    draw.item.material_kind = upstream::RenderMaterialKind::pbr;
    assert(pal::pinned_variant_key(scene, engine, draw).mesh_features == (upstream::base | (1u << 21)));
    draw.item.material_kind = upstream::RenderMaterialKind::standard;
    assert(pal::standard_variant_key(scene, engine, draw).mesh_features == (upstream::base | (1u << 21)));
    // A runtime material's physical handle can exceed every composed row.
    engine.materials.resize(6);
    engine.materials[4].pbr_composition_profile = 0;
    engine.materials[5].source_material = {4};
    engine.materials[5].no_color = true;
    draw.item.material_kind = upstream::RenderMaterialKind::pbr;
    for (unsigned physical : {4u, 5u}) {
        draw.item.material = {physical};
        const auto key = pal::pinned_variant_key(scene, engine, draw);
        assert(key.resolved && key.material_index == 0);
        assert(key.material_view == (physical == 5u ? 1u : 0u));
    }
    // A record keeps the row its first draw resolved, as the pin keeps
    // \`_renderFeatures\`, so each refusal below draws a record of its own.
    engine.materials[4].pbr_composition_profile = 2;
    assert(pal::pinned_variant_key(scene, engine, draw).resolved);
    engine.materials.resize(13);
    engine.materials[6].pbr_composition_profile = 2;
    engine.materials[7].source_material = {13};
    for (unsigned physical : {6u, 7u}) {
        draw.item.material = {physical};
        assert(!pal::pinned_variant_key(scene, engine, draw).resolved);
    }
    // A written row selects the row composed for the drawn record's state. A
    // copy composes as its original and holds its own state; a view draws the
    // row its source's state selects.
    engine.materials[8].composition_source = {0};
    engine.materials[8].alpha_mode = MaterialAlphaMode::blend;
    engine.materials[9].composition_source = {0};
    engine.materials[9].plugin_signature_index = 1;
    engine.materials[10].source_material = {8};
    engine.materials[10].no_color = true;
    engine.materials[11].composition_source = {0};
    engine.materials[11].alpha = 0.5f;
    engine.materials[12].composition_source = {0};
    engine.materials[12].base_color_factor_written = true;
    const auto row_of = [&](unsigned physical) {
        draw.item.material = {physical};
        return pal::pinned_variant_key(scene, engine, draw);
    };
    assert(row_of(8).material_index == 1 && row_of(9).material_index == 2);
    const auto view = row_of(10);
    assert(view.resolved && view.material_index == 1 && view.material_view == 1);
    assert(row_of(11).material_index == 1);
    assert(!row_of(12).resolved);
    engine.materials[8].alpha_mode = MaterialAlphaMode::opaque;
    assert(row_of(8).material_index == 1);
    engine.materials.resize(14);
    engine.materials[13].composition_source = {0};
    engine.materials[13].bent_normal_texture.bytes = SharedTextureBytes::Storage{0};
    assert(row_of(13).material_index == 3);
}
`,
        );
        runNativeFixtureCompiler(native!, [
            file,
            `/Fe:${executable}`,
            `/Fo:${join(output, "check.obj")}`,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);
