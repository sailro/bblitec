import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

export class FactoryLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerMeshFactories(): LoweredSource {
        const boxSource = this.context.store.getSource("src/mesh/create-box.ts");
        const groundSource = this.context.store.getSource("src/mesh/create-ground.ts");
        const planeSource = this.context.store.getSource("src/mesh/create-plane.ts");
        const sphereSource = this.context.store.getSource("src/mesh/create-sphere.ts");
        const torusSource = this.context.store.getSource("src/mesh/create-torus.ts");
        const boxDefault = this.context.extractNumber(
            boxSource,
            /createBoxData\(options:[^=]+=\s*([0-9.]+)/,
            "box default size",
        );
        const groundWidth = this.context.extractNumber(
            groundSource,
            /const width = opts\.width \?\? ([0-9.]+)/,
            "ground default width",
        );
        const groundHeight = this.context.extractNumber(
            groundSource,
            /const height = opts\.height \?\? ([0-9.]+)/,
            "ground default height",
        );
        const sphereSegments = this.context.extractNumber(
            sphereSource,
            /options\.segments \?\? ([0-9]+)/,
            "sphere default segments",
        );
        const sphereDiameter = this.context.extractNumber(
            sphereSource,
            /options\.diameter \?\? ([0-9]+)/,
            "sphere default diameter",
        );
        const torusDiameter = this.context.extractNumber(
            torusSource,
            /opts\.diameter \?\? ([0-9.]+)/,
            "torus default diameter",
        );
        const torusThickness = this.context.extractNumber(
            torusSource,
            /opts\.thickness \?\? ([0-9.]+)/,
            "torus default thickness",
        );
        const torusTessellation = this.context.extractNumber(
            torusSource,
            /opts\.tessellation \?\? ([0-9]+)/,
            "torus default tessellation",
        );
        for (const marker of [
            "const BOX_POSITION_SIGNS = [0x4b213fa5, 0xded6426f, 0x80]",
            "Face order matches Babylon exactly: +Z, -Z, +X, -X, +Y, -Y",
            "0,  1,  2,   0,  2,  3",
        ]) {
            if (!boxSource.includes(marker)) {
                throw new Error(`Pinned box generation changed: ${marker}.`);
            }
        }
        for (const marker of [
            "const subdivisions = opts.subdivisions ?? 1",
            "indices[ii++] = bottomRight",
            "indices[ii++] = topRight",
            "indices[ii++] = topLeft",
        ]) {
            if (!groundSource.includes(marker)) {
                throw new Error(`Pinned ground generation changed: ${marker}.`);
            }
        }
        for (const marker of [
            "const width = options.width ?? size",
            "const height = options.height ?? size",
            "-hw, -hh, 0",
            "0, 0, -1",
            "0, 0,\n        1, 0,\n        1, 1,\n        0, 1",
            "new U32([0, 1, 2, 0, 2, 3])",
        ]) {
            if (!planeSource.includes(marker)) {
                throw new Error(`Pinned plane generation changed: ${marker}.`);
            }
        }
        for (const marker of [
            "const outerAngle = (i * TWO_PI) / tessellation - Math.PI / 2",
            "const innerAngle = (j * TWO_PI) / tessellation + Math.PI",
            "indices[ii++] = nextI * stride + j",
        ]) {
            if (!torusSource.includes(marker)) {
                throw new Error(`Pinned torus generation changed: ${marker}.`);
            }
        }
        const modulePath = "src/mesh/mesh-factories.ts";
        const value = (input: number): string => this.context.floatLiteral(input);
        return {
            modulePath,
            symbolName: "createBox,createGround,createPlane,createSphere,createTorus",
            header: "",
            source: `// ${this.context.provenance(
                modulePath,
                "createBox, createGround, createPlane, createSphere, createTorus",
                "src/mesh/create-box.ts, src/mesh/create-ground.ts, src/mesh/create-plane.ts, src/mesh/create-sphere.ts, and src/mesh/create-torus.ts defaults",
            )}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cmath>
#include <utility>

namespace bbl {

MeshHandle create_box(Engine& engine, float size) {
    const float resolved_size = size > 0.0f ? size : ${value(boxDefault)};
    const float half = resolved_size * 0.5f;
    ModelGeometry geometry;
    const auto add_face = [&](
                              Vec3 a,
                              Vec3 b,
                              Vec3 c,
                              Vec3 d,
                              Vec3 normal) {
        geometry.vertices.insert(
            geometry.vertices.end(),
            {
                ModelVertex{a, normal, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{1.0f, 1.0f}},
                ModelVertex{b, normal, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{0.0f, 1.0f}},
                ModelVertex{c, normal, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{0.0f, 0.0f}},
                ModelVertex{d, normal, Vec4{1.0f, 0.0f, 0.0f, 1.0f}, Vec2{1.0f, 0.0f}},
            });
        const std::uint32_t start =
            static_cast<std::uint32_t>(geometry.vertices.size() - 4);
        geometry.indices.insert(
            geometry.indices.end(),
            {start, start + 1, start + 2, start, start + 2, start + 3});
    };
    add_face(
        Vec3{half, -half, half},
        Vec3{-half, -half, half},
        Vec3{-half, half, half},
        Vec3{half, half, half},
        Vec3{0.0f, 0.0f, 1.0f});
    add_face(
        Vec3{half, half, -half},
        Vec3{-half, half, -half},
        Vec3{-half, -half, -half},
        Vec3{half, -half, -half},
        Vec3{0.0f, 0.0f, -1.0f});
    add_face(
        Vec3{half, half, -half},
        Vec3{half, -half, -half},
        Vec3{half, -half, half},
        Vec3{half, half, half},
        Vec3{1.0f, 0.0f, 0.0f});
    add_face(
        Vec3{-half, half, half},
        Vec3{-half, -half, half},
        Vec3{-half, -half, -half},
        Vec3{-half, half, -half},
        Vec3{-1.0f, 0.0f, 0.0f});
    add_face(
        Vec3{-half, half, half},
        Vec3{-half, half, -half},
        Vec3{half, half, -half},
        Vec3{half, half, half},
        Vec3{0.0f, 1.0f, 0.0f});
    add_face(
        Vec3{half, -half, half},
        Vec3{half, -half, -half},
        Vec3{-half, -half, -half},
        Vec3{-half, -half, half},
        Vec3{0.0f, -1.0f, 0.0f});
    geometry.bounds_min = Vec3{-half, -half, -half};
    geometry.bounds_max = Vec3{half, half, half};
    for (ModelVertex& vertex : geometry.vertices) {
        vertex.local_position = vertex.position;
    }
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::box;
    mesh.dimensions = Vec3{resolved_size, resolved_size, resolved_size};
    mesh.geometry =
        static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

MeshHandle create_ground(Engine& engine, GroundOptions options) {
    const float width = options.width > 0.0f ? options.width : ${value(groundWidth)};
    const float height = options.height > 0.0f ? options.height : ${value(groundHeight)};
    const float half_width = width * 0.5f;
    const float half_height = height * 0.5f;
    ModelGeometry geometry;
    geometry.vertices = {
        ModelVertex{
            Vec3{-half_width, 0.0f, half_height},
            Vec3{0.0f, 1.0f, 0.0f},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{0.0f, 1.0f}},
        ModelVertex{
            Vec3{half_width, 0.0f, half_height},
            Vec3{0.0f, 1.0f, 0.0f},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{1.0f, 1.0f}},
        ModelVertex{
            Vec3{-half_width, 0.0f, -half_height},
            Vec3{0.0f, 1.0f, 0.0f},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{0.0f, 0.0f}},
        ModelVertex{
            Vec3{half_width, 0.0f, -half_height},
            Vec3{0.0f, 1.0f, 0.0f},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{1.0f, 0.0f}},
    };
    geometry.indices = {3, 1, 0, 2, 3, 0};
    geometry.bounds_min = Vec3{-half_width, 0.0f, -half_height};
    geometry.bounds_max = Vec3{half_width, 0.0f, half_height};
    for (ModelVertex& vertex : geometry.vertices) {
        vertex.local_position = vertex.position;
    }
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::ground;
    mesh.dimensions = Vec3{width, 0.0f, height};
    mesh.geometry =
        static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

MeshHandle create_plane(Engine& engine, PlaneOptions options) {
    const float half_width = options.width * 0.5f;
    const float half_height = options.height * 0.5f;
    ModelGeometry geometry;
    geometry.vertices = {
        ModelVertex{
            Vec3{-half_width, -half_height, 0.0f},
            Vec3{0.0f, 0.0f, -1.0f},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{0.0f, 0.0f}},
        ModelVertex{
            Vec3{half_width, -half_height, 0.0f},
            Vec3{0.0f, 0.0f, -1.0f},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{1.0f, 0.0f}},
        ModelVertex{
            Vec3{half_width, half_height, 0.0f},
            Vec3{0.0f, 0.0f, -1.0f},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{1.0f, 1.0f}},
        ModelVertex{
            Vec3{-half_width, half_height, 0.0f},
            Vec3{0.0f, 0.0f, -1.0f},
            Vec4{1.0f, 0.0f, 0.0f, 1.0f},
            Vec2{0.0f, 1.0f}},
    };
    geometry.indices = {0, 1, 2, 0, 2, 3};
    geometry.bounds_min = Vec3{-half_width, -half_height, 0.0f};
    geometry.bounds_max = Vec3{half_width, half_height, 0.0f};
    for (ModelVertex& vertex : geometry.vertices) {
        vertex.local_position = vertex.position;
    }
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::gltf;
    mesh.geometry = static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

MeshHandle create_sphere(Engine& engine, SphereOptions options) {
    const std::uint32_t segments =
        std::max<std::uint32_t>(3, options.segments > 0 ? options.segments : ${sphereSegments}u);
    const float diameter = options.diameter > 0.0f ? options.diameter : ${value(sphereDiameter)};
    const float radius = diameter * 0.5f;
    const std::uint32_t z_steps = 2 + segments;
    const std::uint32_t y_steps = 2 * z_steps;
    ModelGeometry geometry;
    geometry.vertices.reserve(
        static_cast<std::size_t>(z_steps + 1) * (y_steps + 1));
    geometry.indices.reserve(
        static_cast<std::size_t>(z_steps) * y_steps * 6);
    for (std::uint32_t z_step = 0; z_step <= z_steps; ++z_step) {
        const float normalized_z =
            static_cast<float>(z_step) / static_cast<float>(z_steps);
        const float angle_z = normalized_z * pi;
        for (std::uint32_t y_step = 0; y_step <= y_steps; ++y_step) {
            const float normalized_y =
                static_cast<float>(y_step) / static_cast<float>(y_steps);
            const float angle_y = normalized_y * pi * 2.0f;
            const Vec3 normal{
                std::sin(angle_z) * std::cos(angle_y),
                std::cos(angle_z),
                -std::sin(angle_z) * std::sin(angle_y),
            };
            geometry.vertices.push_back(ModelVertex{
                Vec3{radius * normal.x, radius * normal.y, radius * normal.z},
                normal,
                Vec4{1.0f, 0.0f, 0.0f, 1.0f},
                Vec2{normalized_y, normalized_z},
            });
        }

    }
    for (std::uint32_t z_step = 0; z_step < z_steps; ++z_step) {
        for (std::uint32_t y_step = 0; y_step < y_steps; ++y_step) {
            const std::uint32_t a = z_step * (y_steps + 1) + y_step;
            const std::uint32_t b = a + y_steps + 1;
            geometry.indices.insert(
                geometry.indices.end(),
                {a, a + 1, b, b, a + 1, b + 1});
        }
    }
    geometry.bounds_min = Vec3{-radius, -radius, -radius};
    geometry.bounds_max = Vec3{radius, radius, radius};
    for (ModelVertex& vertex : geometry.vertices) {
        vertex.local_position = vertex.position;
    }
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::sphere;
    mesh.geometry = static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

MeshHandle create_torus(Engine& engine, TorusOptions options) {
    const float diameter =
        options.diameter > 0.0f ? options.diameter : ${value(torusDiameter)};
    const float thickness =
        options.thickness > 0.0f ? options.thickness : ${value(torusThickness)};
    const std::uint32_t tessellation = std::max<std::uint32_t>(
        3,
        options.tessellation > 0 ? options.tessellation : ${torusTessellation}u);
    const float major_radius = diameter * 0.5f;
    const float minor_radius = thickness * 0.5f;
    const std::uint32_t stride = tessellation + 1;
    ModelGeometry geometry;
    geometry.vertices.reserve(
        static_cast<std::size_t>(stride) * stride);
    geometry.indices.reserve(
        static_cast<std::size_t>(stride) * stride * 6);
    for (std::uint32_t outer_index = 0;
         outer_index <= tessellation;
         ++outer_index) {
        const float outer_angle =
            static_cast<float>(outer_index) * 2.0f * pi /
                static_cast<float>(tessellation) -
            pi * 0.5f;
        const float cos_outer = std::cos(outer_angle);
        const float sin_outer = std::sin(outer_angle);
        for (std::uint32_t inner_index = 0;
             inner_index <= tessellation;
             ++inner_index) {
            const float inner_angle =
                static_cast<float>(inner_index) * 2.0f * pi /
                    static_cast<float>(tessellation) +
                pi;
            const float dx = std::cos(inner_angle);
            const float dy = std::sin(inner_angle);
            const Vec3 position{
                (dx * minor_radius + major_radius) * cos_outer,
                dy * minor_radius,
                -(dx * minor_radius + major_radius) * sin_outer,
            };
            geometry.vertices.push_back(ModelVertex{
                position,
                Vec3{dx * cos_outer, dy, -dx * sin_outer},
                Vec4{1.0f, 0.0f, 0.0f, 1.0f},
                Vec2{
                    static_cast<float>(outer_index) /
                        static_cast<float>(tessellation),
                    1.0f -
                        static_cast<float>(inner_index) /
                            static_cast<float>(tessellation),
                },
                {},
                position,
            });
            const std::uint32_t next_outer =
                (outer_index + 1) % stride;
            const std::uint32_t next_inner =
                (inner_index + 1) % stride;
            geometry.indices.insert(
                geometry.indices.end(),
                {
                    outer_index * stride + inner_index,
                    outer_index * stride + next_inner,
                    next_outer * stride + inner_index,
                    outer_index * stride + next_inner,
                    next_outer * stride + next_inner,
                    next_outer * stride + inner_index,
                });
        }
    }
    const float outer_radius = major_radius + minor_radius;
    geometry.bounds_min =
        Vec3{-outer_radius, -minor_radius, -outer_radius};
    geometry.bounds_max =
        Vec3{outer_radius, minor_radius, outer_radius};
    for (ModelVertex& vertex : geometry.vertices) {
        vertex.local_position = vertex.position;
    }
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::torus;
    mesh.geometry =
        static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{
        static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    public lowerShaderMaterialFactory(): LoweredSource {
        const modulePath = "src/material/shader/shader-material.ts";
        const source = this.context.store.getSource(modulePath);
        for (const marker of [
            "const needAlphaBlending = options.needAlphaBlending ?? !!options.blend",
            "needAlphaTesting: options.needAlphaTesting ?? false",
            "backFaceCulling: options.backFaceCulling ?? true",
            "depthWrite: options.depthWrite ?? !needAlphaBlending",
        ]) {
            if (!source.includes(marker)) {
                throw new Error(`Pinned shader material state changed: ${marker}.`);
            }
        }
        return {
            modulePath,
            symbolName:
                "createShaderMaterial,setShaderUniform,setShaderFloat,setShaderVector3,setAlphaToCoverage",
            header: "",
            source: `// ${this.context.provenance(modulePath, "createShaderMaterial")}
#include <bblite/runtime.hpp>

#include <stdexcept>

namespace bbl {

MaterialHandle create_shader_material(
    Engine& engine,
    ShaderMaterialVariant variant) {
    MaterialRecord material;
    material.shader_material = true;
    material.shader_variant = variant;
    switch (variant) {
        case ShaderMaterialVariant::alpha_card:
            material.double_sided = true;
            material.shader_depth_write = true;
            break;
        case ShaderMaterialVariant::circular_cutout:
            material.alpha_mode = MaterialAlphaMode::blend;
            material.double_sided = true;
            material.shader_alpha_testing = true;
            material.shader_depth_write = false;
            break;
    }
    engine.materials.push_back(material);
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

MaterialRecord& shader_material(Engine& engine, MaterialHandle handle) {
    if (handle.value >= engine.materials.size()) {
        throw std::runtime_error("Invalid shader material handle.");
    }
    MaterialRecord& material = engine.materials[handle.value];
    if (!material.shader_material) {
        throw std::runtime_error("Material is not a shader material.");
    }
    if (material.shader_variant != ShaderMaterialVariant::alpha_card) {
        throw std::runtime_error(
            "Shader uniforms are unsupported for this reached shader variant.");
    }
    return material;
}

void set_shader_center(Engine& engine, MaterialHandle material, Vec2 value) {
    shader_material(engine, material).shader_center = value;
}

void set_shader_float(
    Engine& engine,
    MaterialHandle material,
    const std::string& name,
    float value) {
    MaterialRecord& record = shader_material(engine, material);
    if (name == "angle") record.shader_angle = value;
    else if (name == "depth") record.shader_depth = value;
    else if (name == "opacity") record.shader_opacity = value;
    else throw std::runtime_error("Unsupported shader float uniform: " + name);
}

void set_shader_vector3(
    Engine& engine,
    MaterialHandle material,
    const std::string& name,
    Color3 value) {
    if (name != "color") {
        throw std::runtime_error("Unsupported shader vec3 uniform: " + name);
    }
    shader_material(engine, material).shader_color = value;
}

void set_alpha_to_coverage(
    Engine& engine,
    MaterialHandle material,
    bool enabled) {
    shader_material(engine, material).alpha_to_coverage = enabled;
}

} // namespace bbl
`,
        };
    }

    public lowerPbrMaterialFactory(): LoweredSource {
        const solidModule = "src/texture/solid-texture.ts";
        const pbrModule = "src/material/pbr/pbr-material.ts";
        const solid = this.context.store.getSource(solidModule);
        const pbr = this.context.store.getSource(pbrModule);
        if (!solid.includes("Math.round(r * 255)") || !solid.includes('format: "rgba8unorm"')) {
            throw new Error("Upstream solid texture quantization changed.");
        }
        if (!/return\s*\{\s*\.\.\.props,[\s\S]*_uboVersion:\s*0/.test(pbr)) {
            throw new Error("Upstream PBR material factory changed.");
        }
        return {
            modulePath: pbrModule,
            symbolName: "createPbrMaterial,createSolidTexture2D",
            header: "",
            source: `// ${this.context.provenance(
                pbrModule,
                "createPbrMaterial",
                `${solidModule}#createSolidTexture2D`,
            )}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cmath>

namespace bbl {

SolidTexture create_solid_texture(
    Engine&,
    float r,
    float g,
    float b,
    float a) {
    const auto quantize = [](float value) {
        return static_cast<float>(
            std::lround(std::clamp(value, 0.0f, 1.0f) * 255.0f)) / 255.0f;
    };
    return SolidTexture{Color4{
        quantize(r),
        quantize(g),
        quantize(b),
        quantize(a),
    }};
}

MaterialHandle create_pbr_material(
    Engine& engine,
    PbrMaterialOptions options) {
    MaterialRecord material;
    material.base_color_factor = options.base_color.color;
    material.roughness_factor =
        options.orm.color.g * options.roughness_factor;
    material.metallic_factor =
        options.orm.color.b * options.metallic_factor;
    material.direct_intensity = options.direct_intensity;
    material.environment_intensity = options.environment_intensity;
    material.base_color_factor.a = options.alpha;
    material.reflectance = options.reflectance;
    material.alpha_mode =
        options.alpha < 1.0f
            ? MaterialAlphaMode::blend
            : MaterialAlphaMode::opaque;
    material.unlit = options.unlit;
    material.double_sided = options.double_sided;
    material.skybox_mode = options.skybox_mode;
    material.transmission_factor = options.transmission_factor;
    material.index_of_refraction = options.index_of_refraction;
    material.thickness = options.thickness;
    material.use_thickness_as_depth = options.use_thickness_as_depth;
    material.attenuation_color = options.attenuation_color;
    material.attenuation_distance = options.attenuation_distance;
    material.has_ior = false;
    material.has_volume = options.has_volume;
    if (material.transmission_factor > 0.0f) {
        material.alpha_mode = MaterialAlphaMode::blend;
    }
    material.has_occlusion_texture = true;
    engine.materials.push_back(material);
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    public lowerGridMaterialFactory(): LoweredSource {
        const modulePath = "src/material/grid/grid-material.ts";
        const source = this.context.store.getSource(modulePath);
        for (const marker of [
            "const mainColor = options.mainColor ?? [0, 0, 0]",
            "const lineColor = options.lineColor ?? [0, 0.5, 0.5]",
            "Math.round(majorUnitFrequency)",
            "const transparent = opacity < 1",
            "needAlphaBlending: transparent || hasOpacity",
            "backFaceCulling",
        ]) {
            if (!source.includes(marker)) {
                throw new Error(
                    `Pinned GridMaterial semantics changed: ${marker}.`,
                );
            }
        }
        return {
            modulePath,
            symbolName: "createGridMaterial",
            header: "",
            source: `// ${this.context.provenance(
                modulePath,
                "createGridMaterial",
            )}
#include <bblite/runtime.hpp>

#include <cmath>

namespace bbl {

MaterialHandle create_grid_material(
    Engine& engine,
    GridMaterialOptions options) {
    MaterialRecord material;
    material.grid_material = true;
    material.grid_main_color = options.main_color;
    material.grid_line_color = options.line_color;
    material.grid_control = Vec4{
        options.grid_ratio,
        std::round(options.major_unit_frequency),
        options.minor_unit_visibility,
        options.opacity,
    };
    material.grid_offset = options.grid_offset;
    material.grid_visibility = options.visibility;
    material.grid_antialias = options.antialias;
    material.grid_pre_multiply_alpha =
        options.pre_multiply_alpha;
    material.grid_use_max_line = options.use_max_line;
    material.alpha_mode =
        options.opacity < 1.0f
            ? MaterialAlphaMode::blend
            : MaterialAlphaMode::opaque;
    material.double_sided = !options.back_face_culling;
    engine.materials.push_back(material);
    return MaterialHandle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    public lowerStandardMaterialFactory(): LoweredSource {
        const modulePath = "src/material/standard/create-standard-material.ts";
        const symbolName = "createStandardMaterial";
        const { file, declaration } = this.context.functionDeclaration(modulePath, symbolName);
        const returnStatement = declaration.body!.statements.find(
            (statement): statement is ts.ReturnStatement =>
                ts.isReturnStatement(statement) && statement.expression !== undefined,
        );
        if (!returnStatement?.expression) throw new Error("Upstream standard material return was not found.");
        let object = returnStatement.expression;
        while (ts.isAsExpression(object) || ts.isParenthesizedExpression(object)) object = object.expression;
        if (!ts.isObjectLiteralExpression(object)) throw new Error("Upstream standard material defaults changed.");
        const tuple = (name: string): string =>
            this.context.cppColor3(
                this.context.numericTuple(this.context.propertyInitializer(object, name), file),
            );
        const scalar = (name: string): string =>
            this.context.floatLiteral(
                this.context.numericValue(
                    this.context.propertyInitializer(object, name),
                    file,
                ),
            );
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>

namespace bbl {

MaterialHandle create_standard_material(Engine& engine) {
    MaterialRecord material;
    material.standard_material = true;
    material.diffuse_color = ${tuple("diffuseColor")};
    material.base_color_factor.a = ${scalar("alpha")};
    material.specular_color = ${tuple("specularColor")};
    material.specular_power = ${scalar("specularPower")};
    material.emissive_factor = ${tuple("emissiveColor")};
    material.ambient_color = ${tuple("ambientColor")};
    engine.materials.push_back(material);
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace bbl
`,
        };
    }

    public lowerNoColorMaterialViews(): LoweredSource {
        const standardModule = "src/material/standard/no-color-view.ts";
        const pbrModule = "src/material/pbr/no-color-view.ts";
        const viewModule = "src/material/material-view.ts";
        const dirtyModule = "src/material/material-dirty.ts";
        const standard = this.context.store.getSource(standardModule);
        const pbr = this.context.store.getSource(pbrModule);
        const view = this.context.store.getSource(viewModule);
        const dirty = this.context.store.getSource(dirtyModule);
        for (const [source, marker] of [
            [standard, "features.features | NO_COLOR_OUTPUT"],
            [pbr, "features2: (features.features2 ?? 0) | PBR2_NO_COLOR_OUTPUT"],
            [view, "Object.create(src"],
            [dirty, "source._uboVersion++"],
        ] as const) {
            if (!source.includes(marker)) {
                throw new Error(`Pinned material-view contract changed: ${marker}.`);
            }
        }
        return {
            modulePath: viewModule,
            symbolName:
                "createStandardNoColorMaterialView,createPbrNoColorMaterialView,markMaterialUboDirty",
            header: "",
            source: `// ${this.context.provenance(
                viewModule,
                "createMaterialView",
                `${standardModule}#createStandardNoColorMaterialView, ${pbrModule}#createPbrNoColorMaterialView, and ${dirtyModule}#markMaterialUboDirty`,
            )}
#include <bblite/runtime.hpp>

#include <stdexcept>

namespace bbl {
namespace {

MaterialHandle create_no_color_material_view(
    Engine& engine,
    MaterialHandle source,
    bool standard) {
    if (source.value >= engine.materials.size()) {
        throw std::runtime_error("Invalid source material handle.");
    }
    const MaterialRecord& source_record = engine.materials[source.value];
    if (source_record.standard_material != standard) {
        throw std::runtime_error(
            "No-color material view family does not match its source.");
    }
    MaterialRecord view = source_record;
    view.no_color = true;
    engine.materials.push_back(std::move(view));
    return MaterialHandle{
        static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace

MaterialHandle create_standard_no_color_material_view(
    Engine& engine,
    MaterialHandle source) {
    return create_no_color_material_view(engine, source, true);
}

MaterialHandle create_pbr_no_color_material_view(
    Engine& engine,
    MaterialHandle source) {
    return create_no_color_material_view(engine, source, false);
}

void mark_material_ubo_dirty(
    Engine& engine,
    MaterialHandle material) {
    if (material.value >= engine.materials.size()) {
        throw std::runtime_error("Invalid material handle.");
    }
}

} // namespace bbl
`,
        };
    }
}
