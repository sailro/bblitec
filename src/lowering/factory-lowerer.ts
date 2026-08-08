import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

export class FactoryLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerMeshFactories(): LoweredSource {
        const boxSource = this.context.store.getSource("src/mesh/create-box.ts");
        const groundSource = this.context.store.getSource("src/mesh/create-ground.ts");
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
        const modulePath = "src/mesh/mesh-factories.ts";
        const value = (input: number): string => this.context.floatLiteral(input);
        return {
            modulePath,
            symbolName: "createBox,createGround",
            header: "",
            source: `// ${this.context.provenance(
                modulePath,
                "createBox, createGround",
                "src/mesh/create-box.ts and src/mesh/create-ground.ts defaults",
            )}
#include <bblite/runtime.hpp>

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
        const numeric = (name: string): string =>
            this.context.floatLiteral(
                this.context.numericValue(this.context.propertyInitializer(object, name), file),
            );
        const tuple = (name: string): string =>
            this.context.cppColor3(
                this.context.numericTuple(this.context.propertyInitializer(object, name), file),
            );
        const bool = (name: string): string => {
            const expression = this.context.propertyInitializer(object, name);
            if (expression.kind === ts.SyntaxKind.TrueKeyword) return "true";
            if (expression.kind === ts.SyntaxKind.FalseKeyword) return "false";
            throw new Error(`Upstream standard material '${name}' is not boolean.`);
        };
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
    material.alpha = ${numeric("alpha")};
    material.specular_color = ${tuple("specularColor")};
    material.specular_power = ${numeric("specularPower")};
    material.emissive_color = ${tuple("emissiveColor")};
    material.ambient_color = ${tuple("ambientColor")};
    material.back_face_culling = ${bool("backFaceCulling")};
    material.disable_lighting = ${bool("disableLighting")};
    engine.materials.push_back(material);
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace bbl
`,
        };
    }
}
