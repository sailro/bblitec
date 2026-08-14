import ts from "typescript";
import type {
    Feature,
    Value,
    ValueKind,
} from "../types.js";

type CompiledPbrMaterialOptions = [
    Value,
    Value,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
];

export interface MaterialIntrinsicContext {
    expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void;
    compileValue(expression: ts.Expression): Value;
    expectKind(
        value: Value,
        kind: ValueKind,
        node: ts.Node,
    ): void;
    expectSameEngine(
        left: Value,
        right: Value,
        node: ts.Node,
    ): void;
    requireDefaultEngine(node: ts.Node): string;
    requireEngine(value: Value, node: ts.Node): string;
    compileNumber(expression: ts.Expression): string;
    compileBoolean(expression: ts.Expression): string;
    compileVec2(expression: ts.Expression): string;
    compileColor3(expression: ts.Expression): string;
    compileStringLiteral(
        expression: ts.Expression,
    ): string;
    compilePbrMaterialOptions(
        expression: ts.Expression,
    ): CompiledPbrMaterialOptions;
    allocateTemporaryCppName(label: string): string;
    emit(line: string): void;
    compileGridMaterialOptions(
        expression: ts.Expression,
    ): string[];
    compileShaderMaterialOptions(
        expression: ts.Expression,
    ): { name: string; id: number };
    expectShaderVariant(
        material: Value,
        variant: string,
        node: ts.Node,
    ): void;
    resolveShaderUniform(
        material: Value,
        nameExpression: ts.Expression,
        expectedCounts: number[],
    ): { offset: number; count: number };
    compileShaderUniformComponents(
        expression: ts.Expression,
        count: number,
    ): string[];
    reachFeature(feature: Feature): void;
    cppString(value: string): string;
    fail(node: ts.Node, message: string): never;
}

/**
 * Shared lowering for setShaderUniform/setShaderFloat/setShaderVector3:
 * the uniform name resolves through the variant's reflected value layout
 * at compile time and the write emits the generic offset setter.
 */
function compileShaderUniformWrite(
    context: MaterialIntrinsicContext,
    material: Value,
    call: ts.CallExpression,
    expectedCounts: number[],
): Value {
    const { offset, count } = context.resolveShaderUniform(
        material,
        call.arguments[1]!,
        expectedCounts,
    );
    const components =
        context.compileShaderUniformComponents(
            call.arguments[2]!,
            count,
        );
    return {
        kind: "void",
        cpp:
            `bbl::set_shader_uniform_value(` +
            `${context.requireEngine(material, call)}, ` +
            `${material.cpp}, ${offset}u, ` +
            `${components.join(", ")})`,
    };
}

export function compileMaterialIntrinsic(
    context: MaterialIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createSolidTexture2D": {
            context.expectArgumentCount(call, 4, 5);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const channels = call.arguments
                .slice(1)
                .map((argument) =>
                    context.compileNumber(argument),
                );
            if (channels.length === 3) {
                channels.push("1.0f");
            }
            context.reachFeature("material:pbr");
            return {
                kind: "texture",
                cpp:
                    `bbl::create_solid_texture(` +
                    `${engine.cpp}, ${channels.join(", ")})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
        }

        case "createPbrMaterial": {
            context.expectArgumentCount(call, 1, 1);
            const engine =
                context.requireDefaultEngine(call);
            const [
                baseColor,
                orm,
                metallic,
                roughness,
                direct,
                environment,
                alpha,
                reflectance,
                unlit,
                doubleSided,
                skyboxMode,
                transmission,
                ior,
                thickness,
                useThicknessAsDepth,
                hasVolume,
                attenuationColor,
                attenuationDistance,
            ] = context.compilePbrMaterialOptions(
                call.arguments[0]!,
            );
            context.expectSameEngine(baseColor, orm, call);
            context.reachFeature("material:pbr");
            context.reachFeature("renderer:pbr");
            if (
                skyboxMode !== "false" ||
                transmission !== "0.0f" ||
                thickness !== "0.0f" ||
                attenuationColor !==
                    "bbl::Color3{1.0f, 1.0f, 1.0f}" ||
                attenuationDistance !== "1.0f"
            ) {
                context.reachFeature(
                    "renderer:transmission",
                );
            }
            if (orm.textureFile) {
                context.fail(
                    call,
                    "Reached file textures support the base color slot only.",
                );
            }
            // A loaded base-color image pairs with the neutral white
            // factor texel and attaches after creation; the base color
            // slot always samples sRGB natively, so the load must have
            // requested srgb: true.
            const baseColorCpp = baseColor.textureFile
                ? "bbl::SolidTexture{bbl::Color4{1.0f, 1.0f, 1.0f, 1.0f}}"
                : baseColor.cpp;
            if (
                baseColor.textureFile &&
                !baseColor.textureFile.srgb
            ) {
                context.fail(
                    call,
                    "Base-color file textures require srgb: true (the native base color slot always samples sRGB).",
                );
            }
            const creation =
                `bbl::create_pbr_material(${engine}, ` +
                `bbl::PbrMaterialOptions{${baseColorCpp}, ` +
                `${orm.cpp}, ${metallic}, ${roughness}, ` +
                `${direct}, ${environment}, ${alpha}, ` +
                `${reflectance}, ${unlit}, ${doubleSided}, ` +
                `${skyboxMode}, ${transmission}, ${ior}, ` +
                `${thickness}, ${useThicknessAsDepth}, ` +
                `${hasVolume}, ${attenuationColor}, ` +
                `${attenuationDistance}})`;
            if (baseColor.textureFile) {
                const temporary =
                    context.allocateTemporaryCppName(
                        "material",
                    );
                context.emit(
                    `auto ${temporary} = ${creation};`,
                );
                context.emit(
                    `bbl::set_material_base_color_file(${engine}, ${temporary}, ${baseColor.cpp});`,
                );
                return {
                    kind: "material",
                    cpp: temporary,
                    engineCpp: engine,
                };
            }
            return {
                kind: "material",
                cpp: creation,
                engineCpp: engine,
            };
        }

        case "enableSceneTransmission": {
            context.expectArgumentCount(call, 2, 2);
            const scene =
                context.compileValue(call.arguments[0]!);
            const engine =
                context.compileValue(call.arguments[1]!);
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            context.expectKind(
                engine,
                "engine",
                call.arguments[1]!,
            );
            context.expectSameEngine(scene, engine, call);
            context.reachFeature("renderer:pbr");
            context.reachFeature("renderer:transmission");
            return {
                kind: "void",
                cpp: `bbl::enable_scene_transmission(${scene.cpp})`,
            };
        }

        case "createGridMaterial": {
            context.expectArgumentCount(call, 0, 1);
            const engine =
                context.requireDefaultEngine(call);
            const options = call.arguments[0]
                ? context.compileGridMaterialOptions(
                      call.arguments[0],
                  )
                : [
                      "bbl::Color3{0.0f, 0.0f, 0.0f}",
                      "bbl::Color3{0.0f, 0.5f, 0.5f}",
                      "1.0f",
                      "bbl::Vec3{}",
                      "10.0f",
                      "0.33f",
                      "1.0f",
                      "1.0f",
                      "true",
                      "false",
                      "false",
                      "true",
                  ];
            context.reachFeature("material:grid");
            context.reachFeature("renderer:pbr");
            return {
                kind: "material",
                cpp:
                    `bbl::create_grid_material(${engine}, ` +
                    `bbl::GridMaterialOptions{` +
                    `${options.join(", ")}})`,
                engineCpp: engine,
            };
        }

        case "createStandardNoColorMaterialView":
        case "createPbrNoColorMaterialView": {
            context.expectArgumentCount(call, 1, 1);
            const source =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                source,
                "material",
                call.arguments[0]!,
            );
            context.reachFeature("material:no-color-view");
            context.reachFeature("renderer:pbr");
            return {
                kind: "material",
                cpp:
                    importedName ===
                    "createStandardNoColorMaterialView"
                        ? `bbl::create_standard_no_color_material_view(${context.requireEngine(source, call)}, ${source.cpp})`
                        : `bbl::create_pbr_no_color_material_view(${context.requireEngine(source, call)}, ${source.cpp})`,
                engineCpp: context.requireEngine(
                    source,
                    call,
                ),
            };
        }

        case "markMaterialUboDirty": {
            context.expectArgumentCount(call, 1, 1);
            const material =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::mark_material_ubo_dirty(` +
                    `${context.requireEngine(
                        material,
                        call,
                    )}, ${material.cpp})`,
            };
        }

        case "createShaderMaterial": {
            context.expectArgumentCount(call, 1, 1);
            const engine =
                context.requireDefaultEngine(call);
            const variant =
                context.compileShaderMaterialOptions(
                    call.arguments[0]!,
                );
            context.reachFeature("material:shader");
            context.reachFeature("renderer:pbr");
            return {
                kind: "material",
                cpp:
                    `bbl::create_shader_material(${engine}, ` +
                    `${variant.id}u)`,
                engineCpp: engine,
                shaderVariant: variant.name,
            };
        }

        case "setShaderUniform": {
            context.expectArgumentCount(call, 3, 3);
            const material =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            return compileShaderUniformWrite(
                context,
                material,
                call,
                [1, 2, 3, 4],
            );
        }

        case "setShaderFloat": {
            context.expectArgumentCount(call, 3, 3);
            const material =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            return compileShaderUniformWrite(
                context,
                material,
                call,
                [1],
            );
        }

        case "setShaderVector3": {
            context.expectArgumentCount(call, 3, 3);
            const material =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            return compileShaderUniformWrite(
                context,
                material,
                call,
                [3],
            );
        }

        case "setPbrEmissive": {
            // src/material/pbr/set-emissive.ts: the linear-RGB emissive
            // color became an opt-in setter over the same material field
            // the glTF emissiveFactor writes.
            context.expectArgumentCount(call, 2, 2);
            const material =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::set_pbr_emissive(` +
                    `${context.requireEngine(material, call)}, ` +
                    `${material.cpp}, ` +
                    `${context.compileColor3(call.arguments[1]!)})`,
            };
        }

        case "setPbrUnlit":
        case "setPbrSkybox": {
            // src/material/pbr/set-unlit.ts and set-skybox.ts: the
            // optional PBR features are opt-in setters that flag the
            // material after creation and register their fragment
            // extension. The reached subset takes the material alone
            // (setPbrUnlit's optional unlitColor tint is unreached).
            context.expectArgumentCount(call, 1, 1);
            const material =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            if (importedName === "setPbrSkybox") {
                // Skybox mode is composed by the transmission-capable
                // renderer (its uniform block carries the skybox
                // option), which the createPbrMaterial `skyboxMode`
                // option used to reach before it became a setter.
                context.reachFeature("renderer:transmission");
            }
            const nativeSetter =
                importedName === "setPbrUnlit"
                    ? "set_pbr_unlit"
                    : "set_pbr_skybox";
            return {
                kind: "void",
                cpp:
                    `bbl::${nativeSetter}(` +
                    `${context.requireEngine(
                        material,
                        call,
                    )}, ${material.cpp})`,
            };
        }

        case "setAlphaToCoverage": {
            context.expectArgumentCount(call, 2, 2);
            const material =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            context.expectShaderVariant(
                material,
                "alpha-card",
                call.arguments[0]!,
            );
            const enabled =
                context.compileBoolean(call.arguments[1]!);
            return {
                kind: "void",
                cpp:
                    `bbl::set_alpha_to_coverage(` +
                    `${context.requireEngine(
                        material,
                        call,
                    )}, ${material.cpp}, ${enabled})`,
            };
        }

        case "createStandardMaterial": {
            context.expectArgumentCount(call, 0, 0);
            const engine =
                context.requireDefaultEngine(call);
            context.reachFeature("material:standard");
            context.reachFeature("renderer:pbr");
            return {
                kind: "material",
                cpp: `bbl::create_standard_material(${engine})`,
                engineCpp: engine,
            };
        }

        case "enableStandardVertexColors": {
            // src/material/standard/enable-standard-vertex-colors.ts
            // installs the vertex-colour fragment factory globally, and
            // standard-renderable.ts then composes it for every mesh
            // carrying a colour buffer. Nothing is created at run time,
            // so the call reaches the feature and emits no statement:
            // the generated Standard fragment carries the pinned slot.
            context.expectArgumentCount(call, 0, 0);
            context.reachFeature("material:standard");
            context.reachFeature(
                "material:standard-vertex-colors",
            );
            context.reachFeature("renderer:pbr");
            return { kind: "void", cpp: "" };
        }

        default:
            return undefined;
    }
}
