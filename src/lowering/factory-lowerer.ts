import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

export class FactoryLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerMeshFactories(): LoweredSource {
        const boxSource = this.context.store.getSource("src/mesh/create-box.ts");
        const groundSource = this.context.store.getSource("src/mesh/create-ground.ts");
        const sphereSource = this.context.store.getSource("src/mesh/create-sphere.ts");
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
        const modulePath = "src/mesh/mesh-factories.ts";
        const value = (input: number): string => this.context.floatLiteral(input);
        return {
            modulePath,
            symbolName: "createBox,createGround,createSphere",
            header: "",
            source: `// ${this.context.provenance(
                modulePath,
                "createBox, createGround, createSphere",
                "src/mesh/create-box.ts, src/mesh/create-ground.ts, and src/mesh/create-sphere.ts defaults",
            )}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cmath>
#include <utility>

namespace bbl {

MeshHandle create_box(Engine& engine, float size) {
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::box;
    const float resolved_size = size > 0.0f ? size : ${value(boxDefault)};
    mesh.dimensions = Vec3{resolved_size, resolved_size, resolved_size};
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
}

MeshHandle create_ground(Engine& engine, GroundOptions options) {
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::ground;
    const float width = options.width > 0.0f ? options.width : ${value(groundWidth)};
    const float height = options.height > 0.0f ? options.height : ${value(groundHeight)};
    mesh.dimensions = Vec3{width, 0.0f, height};
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
    engine.geometries.push_back(std::move(geometry));
    MeshRecord mesh;
    mesh.primitive = PrimitiveKind::sphere;
    mesh.geometry = static_cast<std::uint32_t>(engine.geometries.size() - 1);
    engine.meshes.push_back(mesh);
    return MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)};
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
    SolidTexture base_color,
    SolidTexture orm) {
    MaterialRecord material;
    material.base_color_factor = base_color.color;
    material.roughness_factor = orm.color.g;
    material.metallic_factor = orm.color.b;
    material.has_occlusion_texture = true;
    engine.materials.push_back(material);
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
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
        return {
            modulePath,
            symbolName,
            header: "",
            source: `// ${this.context.provenance(modulePath, symbolName)}
#include <bblite/runtime.hpp>

namespace bbl {

MaterialHandle create_standard_material(Engine& engine) {
    MaterialRecord material;
    material.diffuse_color = ${tuple("diffuseColor")};
    engine.materials.push_back(material);
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace bbl
`,
        };
    }
}
