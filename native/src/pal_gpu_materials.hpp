// The material families' shared selection: the material texture slots,
// the variant pipeline keys, each family's variant key and blocks, their
// shadow rows, the node graph slots, and the bone and VAT palettes.
#pragma once
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_standard_uv_transform.hpp>
#include "pal_gpu_vertex.hpp"

namespace bbl::pal {

#if BBLITE_HAS_PBR_RENDERER
/**
 * A pipeline cache key over a variant, its pipeline kind and the per-pass
 * flags that change fixed-function state.
 *
 * The multiplier separating the variant from the kind is the enum's own
 * size, so a kind added upstream widens every key instead of colliding with
 * one -- which the hand-rolled multipliers could not promise: the tightest
 * of them left five spare kinds, and nothing would have failed at the
 * sixth.
 */
inline std::size_t variant_pipeline_key(std::size_t variant, upstream::RenderPipelineKind kind,
                                        std::initializer_list<bool> flags) {
    std::size_t key =
        variant * upstream::render_pipeline_kind_count + static_cast<std::size_t>(kind);
    for (const bool flag : flags)
        key = key * 2 + (flag ? 1 : 0);
    return key;
}

/**
 * The variant an ESM caster pipeline is keyed by.
 *
 * A caster's colour format is its own generator's recorded row, so two
 * generators whose factories returned different formats must not share a
 * pipeline. Folding the generator's ESM ordinal into the VARIANT rather
 * than into the key is what keeps that fold independent of how many flags
 * `variant_pipeline_key` happens to pack.
 */
inline std::size_t esm_keyed_variant(std::size_t variant, std::size_t variant_count,
                                     std::uint32_t esm_shadow_index) {
    return esm_shadow_index == invalid_handle ? variant
                                              : variant + (esm_shadow_index + 1) * variant_count;
}
#endif

// The generated `material_texture_slots` table's enums, translated against
// the record once for both backends. Everything a slot *means* — which
// field, which sRGB view, which fallback texel, which pinned names — is
// table data; what stays per backend is upload mechanics and the
// enum→API residue.

/** The record field one slot reads, or nullptr when the family has none. */
#if BBLITE_HAS_PBR_RENDERER
inline const TextureData* material_slot_texture(const MaterialRecord& material,
                                                upstream::MaterialTextureSource source,
                                                bool standard_material) {
    using Source = upstream::MaterialTextureSource;
    switch (source) {
    case Source::base_color:
        return &material.base_color_texture;
    case Source::specular_or_metallic_roughness:
        return standard_material ? &material.specular_texture
                                 : &material.metallic_roughness_texture;
    case Source::opacity_or_normal:
        return standard_material ? &material.opacity_texture : &material.normal_texture;
    case Source::ambient_or_emissive:
        return standard_material ? &material.ambient_texture : &material.emissive_texture;
    case Source::standard_emissive:
        return standard_material ? &material.emissive_texture : nullptr;
    case Source::spec_gloss:
        return standard_material ? nullptr : &material.spec_gloss_texture;
    case Source::transmission:
        return standard_material ? nullptr : &material.transmission_texture;
    case Source::thickness:
        return standard_material ? nullptr : &material.thickness_texture;
    case Source::clearcoat:
        return standard_material ? nullptr : &material.clearcoat_texture;
    case Source::clearcoat_roughness:
        return standard_material ? nullptr : &material.clearcoat_roughness_texture;
    case Source::clearcoat_normal:
        return standard_material ? nullptr : &material.clearcoat_normal_texture;
    case Source::sheen_color:
        return standard_material ? nullptr : &material.sheen_color_texture;
    case Source::sheen_roughness:
        return standard_material ? nullptr : &material.sheen_roughness_texture;
    case Source::iridescence:
        return standard_material ? nullptr : &material.iridescence_texture;
    case Source::iridescence_thickness:
        return standard_material ? nullptr : &material.iridescence_thickness_texture;
    case Source::lightmap:
        return &material.lightmap_texture;
    case Source::metallic_reflectance:
        return standard_material ? nullptr : &material.metallic_reflectance_texture;
    case Source::reflectance:
        return standard_material ? nullptr : &material.reflectance_texture;
    case Source::anisotropy:
        return standard_material ? nullptr : &material.anisotropy_texture;
    case Source::translucency_color:
        return standard_material ? nullptr : &material.translucency_color_texture;
    case Source::translucency_intensity:
        return standard_material ? nullptr : &material.translucency_intensity_texture;
    case Source::occlusion_uv2:
        return !standard_material && material.occlusion_texture_uv2 ? &material.occlusion_texture
                                                                    : nullptr;
    case Source::standard_bump:
        return standard_material ? &material.bump_texture : nullptr;
    case Source::standard_reflection:
        return standard_material ? &material.reflection_texture : nullptr;
    // Scene-owned resources carry no record field. The two VAT rows
    // are the mesh's own, like the bone palette beside them.
    case Source::environment_cube:
    case Source::local_probe_cube:
    case Source::brdf_lut:
    case Source::scene_color:
    case Source::bone_palette:
    case Source::vat_palette:
    case Source::vat_instance_params:
    case Source::clustered_lights:
    case Source::clustered_cells:
    case Source::clustered_indices:
        return nullptr;
    }
    return nullptr;
}

/** Whether one slot uploads through an sRGB view, per the table's rule. */
inline bool material_slot_srgb(upstream::MaterialTextureSrgb rule, const MaterialRecord* material,
                               bool standard_material) {
    switch (rule) {
    case upstream::MaterialTextureSrgb::linear:
        return false;
    case upstream::MaterialTextureSrgb::srgb:
        return true;
    case upstream::MaterialTextureSrgb::srgb_unless_standard:
        return !standard_material;
    case upstream::MaterialTextureSrgb::lightmap:
        return material != nullptr && material->lightmap_texture_srgb;
    case upstream::MaterialTextureSrgb::base_color:
        // The slot's encoding is its TEXTURE's, which upstream stores as
        // the `Texture2D`'s own format: the record carries it for the
        // image and the fallback texel alike, so an image is not assumed
        // to be sRGB because it is an image. A transferred texture keeps
        // the same encoding when a Standard diffuse slot takes it.
        return standard_material ? material != nullptr && material->diffuse_texture_srgb
                                 : material == nullptr || material->base_color_srgb;
    }
    return false;
}

/** The 1x1 texel an image-less slot uploads, per the table's rule. */
inline std::array<std::uint8_t, 4> material_slot_fallback(upstream::MaterialTextureFallback rule,
                                                          const MaterialRecord* material,
                                                          bool standard_material) {
    constexpr std::array<std::uint8_t, 4> white_texel{255, 255, 255, 255};
    constexpr std::array<std::uint8_t, 4> black_texel{0, 0, 0, 255};
    // A flat tangent-space normal, so a material with no map reads
    // (0, 0, 1) out of the sample and keeps its interpolated normal.
    constexpr std::array<std::uint8_t, 4> flat_normal_texel{128, 128, 255, 255};
    switch (rule) {
    case upstream::MaterialTextureFallback::white:
        return white_texel;
    case upstream::MaterialTextureFallback::black:
        return black_texel;
    case upstream::MaterialTextureFallback::flat_normal:
        return flat_normal_texel;
    case upstream::MaterialTextureFallback::white_or_flat_normal:
        return standard_material ? white_texel : flat_normal_texel;
    case upstream::MaterialTextureFallback::base_color_record:
        return !standard_material && material ? material->base_color_fallback : white_texel;
    case upstream::MaterialTextureFallback::orm_record:
        // The pinned ORM factor texel, so an animated metallic or
        // roughness factor multiplies the authored value rather than
        // white. Standard materials never carry one.
        return !standard_material && material ? material->orm_fallback : white_texel;
    case upstream::MaterialTextureFallback::white_or_emissive_factor: {
        if (standard_material)
            return white_texel;
        const bool has_emissive_factor = material && (material->emissive_factor.r != 0.0f ||
                                                      material->emissive_factor.g != 0.0f ||
                                                      material->emissive_factor.b != 0.0f);
        return has_emissive_factor ? white_texel : black_texel;
    }
    }
    return white_texel;
}

/**
 * The table row serving one of the pin's own binding names, or nullptr.
 *
 * The names are Babylon's, the rows are generated, and this is where the
 * two meet for both backends' pinned bind paths. A variant that declares a
 * resource the table does not know fails by name rather than sampling
 * whatever sat at that index.
 */
inline const upstream::MaterialTextureSlot* material_slot_for_binding(std::string_view name) {
    for (const upstream::MaterialTextureSlot& slot : upstream::material_texture_slots) {
        if (slot.texture_name.empty())
            continue;
        if (name == slot.texture_name || name == slot.sampler_name) {
            return &slot;
        }
    }
    return nullptr;
}

/**
 * The table row serving one slot source, or nullptr.
 *
 * The Standard family's generated `standard_binding_resources` rows carry
 * the pin's own std binding names (`dT`, `oT`, `rT`, ...) while the slot
 * table's names are the PBR pinned bindings, so a Standard row cannot be
 * resolved by name -- its declared `source` is the join key (the row
 * comment in pinned-standard-variants.ts says exactly that: a
 * "material_texture_slots row source").
 */
inline const upstream::MaterialTextureSlot*
material_slot_for_source(upstream::MaterialTextureSource source) {
    for (const upstream::MaterialTextureSlot& slot : upstream::material_texture_slots) {
        if (slot.source == source) {
            return &slot;
        }
    }
    return nullptr;
}

#endif

/**
 * Whether a task's draw lists contain a draw the pinned path owns — a PBR
 * draw, a Standard one now that both families run Babylon's own composed
 * stages, or a node one in a build that composed geometry views. A geometry
 * task with none writes no pinned blocks at all. It lives here rather than in
 * the backend that asks: SDL_GPU stopped needing it when the depth convention
 * collapsed and the matrix seam went with it, and the question is the
 * backends' shared one whenever either asks it again.
 *
 * The node arm matters for the FRAME PROLOGUE rather than for any block this
 * predicate's callers write: the task's scene block and its gpUniforms are
 * written by whichever family writer runs first, so a task whose list is all
 * node draws still has to reach one of them — which is also why this sits
 * outside the two material families' guard rather than inside it.
 */
#if BBLITE_PINNED_MATERIALS
inline bool pinned_lists_have_pinned_draws(const upstream::RenderDrawLists& lists) {
    for (const upstream::RenderDrawList* list : {&lists.opaque, &lists.transparent}) {
        for (const upstream::RenderDrawCommand& draw : list->commands) {
            if (draw.item.material_kind == upstream::RenderMaterialKind::pbr ||
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
                draw.item.material_kind == upstream::RenderMaterialKind::node ||
#endif
                draw.item.material_kind == upstream::RenderMaterialKind::standard) {
                return true;
            }
        }
    }
    return false;
}

#endif

#if BBLITE_STANDARD_SHADOWS
/**
 * The composed group-2 rows one variant declares.
 *
 * `createShadowFragment` emits three per shadow-casting light and the
 * generated table stores them contiguously, so the slice is the variant's
 * own half-open range -- spelled here rather than at each backend's every
 * lookup. Both material families wrap that one core, so their rows are one
 * shape and a backend builds either family's group 2 from one walk.
 */
inline std::span<const upstream::PinnedShadowBinding> standard_shadow_rows(std::size_t variant) {
    const upstream::StandardVariantEntry& entry = upstream::standard_variants[variant];
    return {
        upstream::standard_shadow_bindings.data() + entry.first_shadow_binding,
        entry.shadow_binding_count,
    };
}

/** Whether a composed Standard variant carries the pin's shadow fragment. */
inline bool standard_variant_receives_shadows(std::size_t variant) {
    return upstream::standard_variants[variant].shadow_binding_count != 0;
}
#else
inline bool standard_variant_receives_shadows(std::size_t) { return false; }
#endif

#if BBLITE_PBR_SHADOWS
/** The same slice over the PBR family's own composed rows. */
inline std::span<const upstream::PinnedShadowBinding> pbr_shadow_rows(std::size_t variant) {
    const upstream::PbrVariantEntry& entry = upstream::pbr_variants[variant];
    return {
        upstream::pbr_shadow_bindings.data() + entry.first_shadow_binding,
        entry.shadow_binding_count,
    };
}

/** Whether a composed PBR variant carries the pin's shadow fragment. */
inline bool pbr_variant_receives_shadows(std::size_t variant) {
    return upstream::pbr_variants[variant].shadow_binding_count != 0;
}
#else
inline bool pbr_variant_receives_shadows(std::size_t) { return false; }
#endif

#if BBLITE_NODE_SHADOWS
/**
 * One node graph's receiver rows, the third family in the shared shape.
 *
 * `emitShadow` appends them to the GRAPH's own group 1 rather than opening
 * a group of its own, so they are bound beside the graph's textures rather
 * than as their own group -- but each row is the same reflected shape the
 * two composed families' are, and resolves through the same builders.
 */
inline std::span<const upstream::PinnedShadowBinding>
node_shadow_rows(const upstream::NodeVariantEntry& entry) {
    return {
        upstream::node_shadow_bindings.data() + entry.first_shadow_binding,
        entry.shadow_binding_count,
    };
}
#endif

/** Restore source winding after a loader baked a reflected node transform. */
inline std::span<const std::uint32_t> node_source_indices(const ModelGeometry& geometry,
                                                          std::vector<std::uint32_t>& scratch) {
    if (!geometry.source_indices_reversed)
        return geometry.indices;
    scratch = geometry.indices;
    for (std::size_t index = 0; index < scratch.size(); index += 3) {
        std::swap(scratch.at(index + 1), scratch.at(index + 2));
    }
    return scratch;
}

#if BBLITE_NODE_VARIANTS > 0
/**
 * A node graph's two compiled views, as one index.
 *
 * `buildNodeRenderables` compiles the receiver and, for a graph that casts,
 * an ESM caster from the same bodies. They differ by one binding row and by
 * their modules, so each backend keeps a resource per view rather than per
 * graph, and both agree on which slot is which here.
 */
#if BBLITE_NODE_SHADOWS
inline constexpr std::size_t node_variant_slot(std::size_t variant, bool caster) {
    return variant * 2 + (caster ? 1 : 0);
}

inline std::size_t node_view_slots() { return upstream::node_variants.size() * 2; }

/** The graph one slot names, and which of its two views. */
inline constexpr std::size_t node_slot_variant(std::size_t slot) { return slot / 2; }

inline constexpr bool node_slot_is_caster(std::size_t slot) { return slot % 2 == 1; }
#else
// A build composing no node caster has one view per graph, so the slot IS
// the variant and every backend's per-slot table keeps its old size.
inline constexpr std::size_t node_variant_slot(std::size_t variant, [[maybe_unused]] bool caster) {
    return variant;
}

inline std::size_t node_view_slots() { return upstream::node_variants.size(); }

inline constexpr std::size_t node_slot_variant(std::size_t slot) { return slot; }

inline constexpr bool node_slot_is_caster(std::size_t) { return false; }
#endif

/** No geometry view: what both PALs pass for a colour or caster draw, and
 *  what the generated lookup returns for a pair it composed none for. Stated
 *  outside the guard because every node draw site names it, and checked
 *  against the generated spelling where that exists. */
inline constexpr std::size_t no_node_geometry_variant = npos;

#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
static_assert(no_node_geometry_variant == upstream::node_no_geometry_variant,
              "The PAL sentinel must be the generated table's own.");

/**
 * A graph's geometry-output views, continuing the same slot run.
 *
 * They are not a third view of the pair above: one graph composes ONE
 * geometry module per task it is drawn in, so a geometry view is a
 * `node_variants` row of its own after every graph's, and its slot is that
 * row's -- with the caster half of the pair unused, because a geometry view
 * never casts. Each backend's per-slot module, layout and `.slots` tables
 * then serve all three kinds unchanged.
 */
inline std::size_t node_geometry_slot(std::size_t geometry_variant) {
    return node_variant_slot(upstream::node_geometry_entry(geometry_variant), false);
}

/**
 * The view one graph composed for one task, or a refusal naming both.
 *
 * A geometry task draws every mesh the scene admits and composition walks
 * every task the scene registered, so a node draw reaching a task with no
 * composed view is a generation gap rather than a scene mistake -- and it is
 * the same gap on either backend, so the message is stated once here beside
 * `require_geometry_target_count`.
 */
inline std::size_t require_node_geometry_variant(std::size_t variant, std::size_t geometry_task) {
    const std::size_t geometry_variant =
        upstream::node_geometry_variant_for(variant, geometry_task);
    if (geometry_variant != no_node_geometry_variant) {
        return geometry_variant;
    }
    throw std::runtime_error("node graph " + std::to_string(variant) + " draws in geometry task " +
                             std::to_string(geometry_task) + " with no composed geometry view.");
}
#endif

/**
 * How many `node_variants` rows are graphs.
 *
 * The render plan's `shader_variant` names a GRAPH, so this rather than
 * `node_variants.size()` is what an out-of-range plan item is refused
 * against: the geometry views a scene composed continue the same table
 * after every graph.
 */
inline std::size_t node_graph_count() {
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    return upstream::node_graph_count;
#else
    return upstream::node_variants.size();
#endif
}

/**
 * The slot one node draw's resources live in.
 *
 * A geometry view is keyed by the composed view rather than by the graph --
 * one graph drawn in two tasks composed two modules -- so the callers that
 * know which view a draw is agree here rather than each spelling it out.
 */
inline std::size_t node_draw_slot(std::size_t variant, bool caster,
                                  [[maybe_unused]] std::size_t geometry_variant) {
#if BBLITE_NODE_GEOMETRY_VARIANTS > 0
    if (geometry_variant != no_node_geometry_variant) {
        return node_geometry_slot(geometry_variant);
    }
#endif
    return node_variant_slot(variant, caster);
}

/** Every per-slot table both backends size: the colour and caster views of
 *  every row `node_variants` carries, graphs and geometry views alike. */
inline std::size_t node_variant_slots() { return node_view_slots(); }

/**
 * The compiled view one slot names.
 *
 * A graph's three modules are separate emits — the geometry one walks the
 * graph again from its own terminal — so their vertex inputs, texture pairs
 * and uniform blocks are separate ranges into the same tables, carried by
 * separate rows of the one table. Both backends bind a draw from the row
 * its slot names rather than from a per-view branch at every use.
 */
inline const upstream::NodeVariantEntry& node_slot_view(std::size_t slot) {
    return upstream::node_variants[node_slot_variant(slot)];
}

/**
 * The two stems one slot's modules deploy under.
 *
 * Which of a graph's compiled views a slot names decides both, so the pair
 * travels together rather than as a ternary per load site.
 */
inline upstream::NodeVariantStems node_variant_stems(std::size_t slot) {
    const upstream::NodeVariantEntry& entry = node_slot_view(slot);
#if BBLITE_NODE_SHADOWS
    if (node_slot_is_caster(slot)) {
        return {entry.caster.vertex_stem, entry.caster.fragment_stem};
    }
#endif
    return {entry.vertex_stem, entry.fragment_stem};
}
#endif

#if BBLITE_PBR_VARIANTS > 0

/**
 * The variant a draw composes, or `npos` when this scene cannot resolve one.
 *
 * The key is the pin's own: the material, the mesh's attributes, the light mode
 * with its single-light kind, and whether tone mapping is on. Two halves come
 * from generation because a PAL cannot recover them — the glTF material index,
 * which is a MaterialHandle only while every material comes from the composed
 * asset, and the attribute set, because our geometry record does not carry uv2
 * or vertex-colour presence. Both are checked rather than assumed: an
 * unresolved draw returns `npos` and takes the transcribed path.
 */
/** Whether a variant's vertex stage samples the bone palette. */
inline bool pinned_variant_skeleton(std::size_t variant) {
    return upstream::pbr_variants[variant].key.find("skeleton") != std::string_view::npos;
}

/**
 * Whether a variant deforms from a BAKED vertex-animation texture.
 *
 * The key carries the composed fragment ids, so this reads the same way
 * the skeleton test above does. The two are mutually exclusive by
 * construction: `_computeMeshFeatures` writes MSH_VAT where it would have
 * written MSH_HAS_SKELETON, never both. A baked draw reads the VAT rows --
 * the palettes the live path uploads, copied by the bake -- and neither arm
 * changes the world the mesh block carries.
 */
inline bool pinned_variant_vat(std::size_t variant) {
    return upstream::pbr_variants[variant].key.find("vat") != std::string_view::npos;
}

/**
 * The key one PBR draw composes under.
 *
 * Split from the lookup for the reason the Standard family's own key is: a
 * miss reports what it asked for, and recomputing the key at the error site
 * would print something subtly different -- the pin's own
 * `lightCount === 1 && !receiveShadows ? 1 : 2` fold and the mesh row's
 * feature-source redirect both happen here, after the raw reads.
 */
struct PinnedVariantKey {
    std::uint32_t material_index = 0;
    std::uint32_t material_view = 0;
    std::size_t mesh_features = 0;
    std::uint32_t light_mode = 0;
    std::string_view single_light_type;
    bool tone_mapping = false;
    /** Why the key is unusable, when it is; empty once `resolved`. */
    std::string refusal;
    bool resolved = false;
};

inline PinnedVariantKey pinned_variant_key(const Scene& scene, const Engine& engine,
                                           const upstream::RenderDrawCommand& draw) {
    PinnedVariantKey key;
    if (draw.item.material_kind != upstream::RenderMaterialKind::pbr) {
        key.refusal = "the draw names no PBR material";
        return key;
    }
    // The table names the FIRST `pbr_variant_material_count` handles: the
    // assets' materials in document order, then every scene-code creation in
    // creation order. What has to hold is that a handle the table names is
    // still the material generation composed for -- so what is checked is
    // the handle, not the count. Records appended past the table are the
    // shadow caster VIEWS `registerSceneWithShadowSupport` builds, and one
    // of those draws through its own no-colour variant rather than a row
    // here; a miss is then reported by the selector rather than guessed at.
    if (draw.item.material.value >= engine.materials.size()) {
        key.refusal = "the draw material handle is invalid";
        return key;
    }
    const MaterialRecord& draw_material = handle_at(engine.materials, draw.item.material);
    key.material_view = draw_material.esm_shadow ? 2u : draw_material.no_color ? 1u : 0u;
    key.material_index = draw_material.source_material.value == invalid_handle
                             ? draw.item.material.value
                             : draw_material.source_material.value;
    if (key.material_index >= upstream::pbr_variant_material_count) {
        key.refusal = "material " + std::to_string(key.material_index) + " is past the " +
                      std::to_string(upstream::pbr_variant_material_count) +
                      " the composed table names";
        return key;
    }
    // The mesh half of the key comes per original renderable. Renderer
    // startup assigns its stable generated-table row and gives every clone
    // the same row, even when clone handles precede later imported meshes.
    const std::uint32_t feature_mesh = composition_feature_mesh(engine, draw.item.mesh);
    key.mesh_features = feature_mesh < upstream::pbr_renderable_mesh_features.size()
                            ? upstream::pbr_renderable_mesh_features[feature_mesh]
                            // Scene code can keep creating meshes after registration, all
                            // from the fixed-set builders; a scene whose builders disagree
                            // publishes npos here and such a draw refuses.
                            : upstream::pbr_runtime_mesh_features;
    if (key.mesh_features == npos) {
        key.refusal = "the scene's runtime meshes carry no single attribute set";
        return key;
    }
    // Scene-code pools attach after generation recorded the mesh's static
    // attribute word. Match the pin's _computeMeshFeatures result at draw
    // time; EXT_mesh_gpu_instancing already carries the bit in the table, so
    // this idempotent OR covers both origins with one rule.
    if (draw.item.mesh.value < engine.meshes.size()) {
        const MeshRecord& record = handle_at(engine.meshes, draw.item.mesh);
        // `_computeMeshFeatures` writes MSH_VAT INSTEAD of
        // MSH_HAS_SKELETON for a baked mesh -- attachVat dropped the live
        // skeleton -- so this is a swap on the static row rather than an
        // OR beside it. Generation composed the swapped row.
        if (record.has_vat) {
            key.mesh_features &= ~static_cast<std::size_t>(upstream::pinned_msh_has_skeleton);
            key.mesh_features |= static_cast<std::size_t>(upstream::pinned_msh_vat);
        }
        if (pinned_record_instanced(record)) {
            key.mesh_features |= upstream::pinned_msh_has_thin_instances;
            // `_computeMeshFeatures` nests this under the pool and reads the
            // mesh's colour stream. Use the binding predicate too, so the
            // selected PBR stage and the stream each backend binds cannot
            // disagree about `instanceColor`.
            if (pinned_record_instance_colored(record)) {
                key.mesh_features |= upstream::pinned_msh_has_instance_color;
            }
        }
        const std::size_t receive_shadows =
            static_cast<std::size_t>(upstream::pinned_msh_receive_shadows);
        if (upstream::pinned_material_receives_shadows(
                key.material_view != 0u, record.receives_shadows,
                upstream::pinned_scene_has_shadows(engine, scene))) {
            key.mesh_features |= receive_shadows;
        } else {
            key.mesh_features &= ~receive_shadows;
        }
    }
    // The light mode, walked the way `writeMeshLightSelection` walks it: how
    // many of the scene's lights affect this mesh decides which arm the pin
    // composed.
    std::uint32_t light_count = 0;
    for (const LightHandle handle : scene.lights) {
        if (handle.value >= engine.lights.size())
            continue;
        const LightRecord& light = handle_at(engine.lights, handle);
        if (!upstream::light_affects_mesh(light, draw.item.mesh)) {
            continue;
        }
        ++light_count;
        key.single_light_type = upstream::pinned_single_light_type(light);
    }
    // The receive bit rides the mesh row rather than the material, which is
    // why it is read back from the mesh half of the key; the arm it selects
    // comes from the generated lookup generation composed against, so the
    // two cannot disagree about which variants exist.
    key.light_mode = upstream::pinned_pbr_light_mode(
        light_count,
        (key.mesh_features & static_cast<std::size_t>(upstream::pinned_msh_receive_shadows)) != 0);
    if (key.light_mode != 1)
        key.single_light_type = "";
    key.tone_mapping = scene.environment.tone_mapping_enabled;
    key.resolved = true;
    return key;
}

/**
 * What a failed PBR variant lookup was asked for.
 *
 * The same diagnostic the Standard family carries, built from the key the
 * lookup actually used rather than from a second derivation: a miss means
 * the runtime derivation and the composed selector table disagree, and a key
 * that differed from the one that missed would name the wrong half.
 */
inline std::string pinned_variant_request(const PinnedVariantKey& key,
                                          std::size_t geometry_task = npos) {
    if (!key.resolved)
        return "no key: " + key.refusal;
    return "material " + std::to_string(key.material_index) + ", view " +
           std::to_string(key.material_view) + ", mesh features " +
           std::to_string(key.mesh_features) + ", light mode " + std::to_string(key.light_mode) +
           ", single light '" + std::string(key.single_light_type) + "'" + ", tone mapping " +
           (key.tone_mapping ? "on" : "off") + ", geometry task " +
           (geometry_task == npos ? std::string("none") : std::to_string(geometry_task));
}

inline std::size_t
pinned_variant_for_draw(const Scene& scene, const Engine& engine,
                        const upstream::RenderDrawCommand& draw,
                        // The geometry-output task the draw belongs to, npos for the colour
                        // passes: the selector table keys on it, so a geometry draw resolves
                        // its own MRT arm and never a colour variant.
                        std::size_t geometry_task = npos,
                        // Filled with the key the lookup used, so a miss reports that key
                        // rather than a second derivation of it.
                        PinnedVariantKey* key_out = nullptr) {
    if (upstream::pbr_variants.empty()) {
        return npos;
    }
    // An animated node moves through its world, which every variant's mesh
    // block carries; an instanced mesh resolves the pin's own thin-instance
    // arm -- its renderable features carry MSH_HAS_THIN_INSTANCES -- and the
    // draw binds the per-instance matrix buffer as the arm's second stream.
    const bool has_bones = draw.item.mesh.value < engine.meshes.size() &&
                           !handle_at(engine.meshes, draw.item.mesh).bone_matrices.empty();
    const PinnedVariantKey key = pinned_variant_key(scene, engine, draw);
    if (!key.resolved)
        return npos;
    if (key_out)
        *key_out = key;
    // Every light mode. All three read the same lights block, whose writers index
    // the pin's own light world matrix; the block itself was diffed against the
    // browser's (`artifacts/capture/scene7/buffers.json`, 1040 bytes beside the
    // 368-byte scene block).
    // A transmission scene resolves the same table: its materials compose
    // with `_linearImageProcessing` (the pin's markPbrMaterialsLinear), so
    // every fragment guards its processing tail on `vImageInfos.w >= 0` and
    // the linear main pass runs with the lane at -1; the refraction arms
    // bind the existing 1024x1024 scene-colour grab through the variant's
    // own `refractionTexture` slot. The earlier 17.8-MAD refusal here was
    // the guard missing from the composed fragments, not pass structure.
    const std::size_t variant = upstream::pbr_variant_for(
        key.material_index, key.material_view, static_cast<std::uint32_t>(key.mesh_features),
        key.light_mode, key.single_light_type, key.tone_mapping, geometry_task);
    if (variant == npos) {
        return npos;
    }
    // A skeleton variant needs the palette to exist or the deformation is
    // lost.
    const bool skeleton_variant = pinned_variant_skeleton(variant);
    if (skeleton_variant && !has_bones) {
        return npos;
    }
    return variant;
}

/**
 * The baked texture's shape: the bone palette's own row, `frame_count`
 * rows tall. Both backends size and fill from this; only the upload
 * mechanics stay per API.
 */
struct VatTextureLayout {
    std::uint32_t width;
    std::uint32_t height;
    std::uint32_t row_bytes;
    std::uint32_t bytes;
};

inline VatTextureLayout vat_texture_layout(std::uint32_t bones, std::uint32_t frames) {
    const std::uint32_t width = bones * 4u;
    return VatTextureLayout{width, frames, width * 16u, width * 16u * frames};
}

template <class Mesh, class Bake, class Settings, class Instances, class UploadInstances>
void sync_pinned_vat(Mesh& mesh, const MeshRecord& record, const Engine& engine, Bake&& upload_bake,
                     Settings&& upload_settings, [[maybe_unused]] Instances&& recreate_instances,
                     [[maybe_unused]] UploadInstances&& upload_instances) {
    if (!record.has_vat || record.vat.bake >= engine.vat_bakes.size())
        return;
    const auto& bake = engine.vat_bakes[record.vat.bake];
    if (bake.bone_count == 0 || bake.frame_count == 0)
        return;
    if (mesh.pinned_vat_bones != bake.bone_count || mesh.pinned_vat_frames != bake.frame_count) {
        upload_bake(bake, vat_texture_layout(bake.bone_count, bake.frame_count));
        mesh.pinned_vat_bones = bake.bone_count;
        mesh.pinned_vat_frames = bake.frame_count;
    }
    upload_settings(record.vat);
#if BBLITE_VAT_INSTANCES
    const auto& vat = record.vat;
    if (vat.instance_texels == 0)
        return;
    if (mesh.pinned_vat_instance_texels != vat.instance_texels) {
        recreate_instances(vat);
        mesh.pinned_vat_instance_texels = vat.instance_texels;
        mesh.pinned_vat_instance_version = 0;
    }
    if (mesh.pinned_vat_instance_version != vat.instance_version) {
        upload_instances(vat, VatTextureLayout{vat.instance_texels, 1u, vat.instance_texels * 16u,
                                               vat.instance_texels * 16u});
        mesh.pinned_vat_instance_version = vat.instance_version;
    }
#endif
}
#endif

#if BBLITE_PBR_VARIANTS > 0 || BBLITE_STANDARD_SKELETON
/**
 * The pin's bone-palette texture shape: `skeleton-updater.ts` writes
 * `invMeshWorld * jointWorld * IBM` per bone into one rgba32float row,
 * four 16-byte texels per bone. Both backends size and fill their
 * palette texture from this; only the upload mechanics stay per API.
 */
struct BonePaletteLayout {
    std::uint32_t width;
    std::uint32_t height;
    // The whole palette, which for the single row is also the row pitch.
    std::uint32_t bytes;
};

inline BonePaletteLayout bone_palette_layout(std::uint32_t bones) {
    const std::uint32_t width = bones * 4u;
    return BonePaletteLayout{width, 1u, width * 16u};
}

/** A palette texture whose bytes no record version has been streamed to yet. */
inline constexpr std::uint64_t unsynced_bone_palette = ~std::uint64_t{0};

/**
 * One mesh's pinned bone palette, brought in step with its record: the
 * texture is rebuilt when the bone count moved and rewritten when the
 * palette's version did. `MeshRecord::bone_matrices` already holds the
 * pin's `invMeshWorld * jointWorld * IBM` product, so the bytes travel
 * unchanged. The backend supplies its texture creation
 * (`recreate(layout)`, releasing the previous texture) and its upload
 * (`upload(floats, layout)`).
 */
template <typename GpuMesh, typename Recreate, typename Upload>
inline void sync_pinned_bone_palette(GpuMesh& mesh, const MeshRecord& record, Recreate&& recreate,
                                     Upload&& upload) {
    const auto bones = static_cast<std::uint32_t>(record.bone_matrices.size());
    if (bones == 0)
        return;
    const BonePaletteLayout palette = bone_palette_layout(bones);
    if (mesh.pinned_bone_count != bones) {
        recreate(palette);
        mesh.pinned_bone_count = bones;
        mesh.pinned_bone_version = unsynced_bone_palette;
    }
    if (mesh.pinned_bone_version == record.bone_matrices_version)
        return;
    upload(record.bone_matrices.data()->data(), palette);
    mesh.pinned_bone_version = record.bone_matrices_version;
}
#endif

#if BBLITE_HAS_PBR_RENDERER
/**
 * A shader material carrying fewer textures than its stage samples.
 *
 * Both backends raise it through their own error function, so the message
 * is composed once here the way `standard_variant_request` already is. It
 * describes a generation bug -- the record is filled by the compiled
 * `setShaderTexture` calls -- rather than a draw to skip.
 */
inline std::string shader_sampler_shortfall(const upstream::ShaderVariantInfo& info,
                                            std::size_t carried) {
    return "shader variant '" + std::string(info.name) + "' declares " +
           std::to_string(info.samplers.size()) + " sampler(s); the material carries " +
           std::to_string(carried) + " texture(s).";
}

/** A compiled stage keeping a register the material never declared. */
inline std::string shader_sampler_unmapped(const upstream::ShaderVariantInfo& info,
                                           const std::string& texture_name) {
    return "shader variant '" + std::string(info.name) + "' binds texture '" + texture_name +
           "', which its samplers option never declared.";
}
#endif

#if BBLITE_STANDARD_VARIANTS > 0
/** The pair `standard_variant_for` looks a draw up by, or none. */
struct StandardVariantKey {
    std::uint32_t features = 0;
    std::uint32_t plugin_index = 0;
    std::size_t mesh_features = 0;
    bool resolved = false;
};

/**
 * The key a draw composes under.
 *
 * Split from the lookup so a miss can report what it asked for: the two
 * numbers are the whole diagnosis, and recomputing them at the error site
 * would print something subtly different -- the no-color pass bit and the
 * thin-instance and morph mesh bits are ORed on here, after the raw reads.
 */
inline StandardVariantKey standard_variant_key(const Scene& scene, const Engine& engine,
                                               const upstream::RenderDrawCommand& draw) {
    StandardVariantKey key;
    if (draw.item.material_kind != upstream::RenderMaterialKind::standard ||
        draw.item.material.value >= engine.materials.size()) {
        return key;
    }
    const MaterialRecord& material = handle_at(engine.materials, draw.item.material);
    key.features = upstream::standard_material_features(material);
    key.plugin_index = material.plugin_signature_index;
    if (material.no_color) {
        key.features |= upstream::standard_no_color_output_flag;
    }
#if BBLITE_SHADOWS_ESM
    if (material.esm_shadow) {
        // `createStandardEsmShadowMaterialView` clears the blend bit before
        // setting its own, so the key says both.
        key.features = (key.features & ~upstream::standard_alpha_blend_flag) |
                       upstream::standard_esm_shadow_output_flag;
    }
#endif
    const std::uint32_t feature_mesh = composition_feature_mesh(engine, draw.item.mesh);
    key.mesh_features = feature_mesh < upstream::standard_renderable_mesh_features.size()
                            ? upstream::standard_renderable_mesh_features[feature_mesh]
                            : upstream::standard_runtime_mesh_features;
    if (key.mesh_features == npos) {
        return key;
    }
    if (draw.item.mesh.value < engine.meshes.size()) {
        const MeshRecord& record = handle_at(engine.meshes, draw.item.mesh);
        if (pinned_record_instanced(record)) {
            key.mesh_features |= upstream::std_msh_has_thin_instances;
            // `_computeMeshFeatures` reads `mesh.thinInstances.colors`, so
            // the colour bit arrives with the pool rather than with the
            // material: a coloured pool composes the Standard family's own
            // final-colour slot, an uncoloured one the plain fragment.
            if (pinned_record_instance_colored(record)) {
                key.mesh_features |= upstream::std_msh_has_instance_color;
            }
        }
        const std::size_t receive_shadows =
            static_cast<std::size_t>(upstream::pinned_msh_receive_shadows);
        if (upstream::pinned_material_receives_shadows(
                material.no_color
#if BBLITE_SHADOWS_ESM
                    || material.esm_shadow
#endif
                ,
                record.receives_shadows, upstream::pinned_scene_has_shadows(engine, scene))) {
            key.mesh_features |= receive_shadows;
        } else {
            key.mesh_features &= ~receive_shadows;
        }
    }
    // `rebuildSingle` computes `receiveShadows` as `!shadowOutput && ...`,
    // so a depth-only view of a mesh that also receives is composed without
    // the shadow fragment and its key carries no receive bit.
    if (material.no_color
#if BBLITE_SHADOWS_ESM
        || material.esm_shadow
#endif
    ) {
        key.mesh_features &= ~static_cast<std::size_t>(upstream::pinned_msh_receive_shadows);
    }
    if (draw.item.geometry < engine.geometries.size() &&
        !engine.geometries[draw.item.geometry].morph_positions.empty()) {
        key.mesh_features |= upstream::std_msh_has_morph_targets;
    }
#if BBLITE_STANDARD_SKELETON
    key.features |=
        upstream::standard_skeleton_features(static_cast<std::uint32_t>(key.mesh_features));
#endif
#if BBLITE_STANDARD_VERTEX_ALPHA
    if (draw.item.mesh.value < engine.meshes.size()) {
        const MeshRecord& record = handle_at(engine.meshes, draw.item.mesh);
        key.features |= upstream::standard_color_alpha_features(
            material.no_color || material.esm_shadow, record.has_vertex_alpha,
            upstream::standard_vertex_colors_enabled &&
                draw.item.geometry < engine.geometries.size() &&
                engine.geometries[draw.item.geometry].has_vertex_colors,
            has_instance_colors(record));
    }
#endif
    key.resolved = true;
    return key;
}

/**
 * What a failed Standard variant lookup was asked for.
 *
 * A miss means the runtime derivation and the composed selector table
 * disagree, which is what an upstream feature-derivation change looks like
 * from here.
 */
inline std::string standard_variant_request(const Scene& scene, const Engine& engine,
                                            const upstream::RenderDrawCommand& draw) {
    const StandardVariantKey key = standard_variant_key(scene, engine, draw);
    if (!key.resolved) {
        if (draw.item.material.value >= engine.materials.size()) {
            return "no key: material handle " + std::to_string(draw.item.material.value) +
                   " exceeds " + std::to_string(engine.materials.size()) + " runtime materials";
        }
        return "no key: runtime material flags standard=" +
               std::to_string(handle_at(engine.materials, draw.item.material).standard_material) +
               ", shader=" +
               std::to_string(handle_at(engine.materials, draw.item.material).shader_material) +
               ", draw kind=" + std::to_string(static_cast<std::uint32_t>(draw.item.material_kind));
    }
    return "features " + std::to_string(key.features) + ", mesh features " +
           std::to_string(key.mesh_features);
}

/**
 * The Standard variant a draw composes, or `npos` when none was emitted.
 *
 * The key is the pin's own feature word, derived from the record by the
 * generated `standard_material_features` — the same pinned
 * `_computeStandardMaterialFeatures` generation executed to compose — plus
 * the mesh bits: the static per-handle table with the pool and deformation
 * bits ORed on at draw time, because thin instances attach and morph
 * weights arrive after mesh creation. A no-color view's record ORs the
 * pass bit the composition keyed its depth-only rows on.
 */
inline std::size_t
standard_variant_for_draw(const Scene& scene, const Engine& engine,
                          const upstream::RenderDrawCommand& draw, std::size_t geometry_task = npos,
                          // Filled with the derived key when the caller passes one, so the draw
                          // can consume `key.features` instead of re-deriving it.
                          StandardVariantKey* key_out = nullptr) {
    const StandardVariantKey key = standard_variant_key(scene, engine, draw);
    if (key_out)
        *key_out = key;
    if (!key.resolved) {
        return npos;
    }
    return upstream::standard_variant_for(key.features,
                                          static_cast<std::uint32_t>(key.mesh_features),
                                          geometry_task, key.plugin_index);
}

/**
 * The Standard material block for one draw: the pin's own writer over the
 * record-filled props. A material-less item keeps the pin's defaults, the
 * way `createStandardMaterial` seeds them.
 */
inline upstream::StandardMaterialUniforms standard_material_block(const MaterialRecord* material,
                                                                  std::uint32_t features) {
    const upstream::StandardMaterialProps props =
        material ? upstream::standard_material_props(*material) : upstream::StandardMaterialProps{};
    upstream::StandardMaterialUniforms block{};
    upstream::write_standard_material(props, upstream::standard_texture_level(features), block);
    return block;
}

/** The vertex-stage UV block for one draw, by the pin's own writer. */
inline upstream::StandardUvTransformUniforms standard_uv_block(const MaterialRecord* material,
                                                               std::uint32_t features) {
    const upstream::StandardMaterialProps props =
        material ? upstream::standard_material_props(*material) : upstream::StandardMaterialProps{};
    upstream::StandardUvTransformUniforms block{};
    upstream::write_standard_uv_transform(
        props, material != nullptr && upstream::standard_uv_inverted(features, *material), block);
    return block;
}

#if BBLITE_HAS_STANDARD_UV_TRANSFORM
/**
 * `stdUvTransformExt`'s own block, by the pin's own per-channel writer.
 *
 * The extension replaces the base `up` block's assignment in the vertex
 * stage rather than removing it, so both blocks bind on a marked material
 * and this one is what the varyings actually read.
 */
inline upstream::StandardUvTxUniforms standard_uv_transform_block(const MaterialRecord* material) {
    upstream::StandardUvTxUniforms block{};
    if (!material)
        return block;
    upstream::write_std_uv_transform_data(*material, upstream::standard_material_props(*material),
                                          block);
    return block;
}
#endif
#endif

} // namespace bbl::pal
