import ts from "typescript";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import type { CompiledAnisotropyOptions } from "./material-options.js";
import type { CompiledNodeMaterialCall } from "../node-material.js";
import { isToneMappingExport } from "../../pinned-tone-mapping.js";
import type {
    ScenePbrClearCoatManifest,
    ScenePbrAnisotropyManifest,
    ScenePbrIridescenceManifest,
    ScenePbrMetallicReflectanceManifest,
    ScenePbrSheenManifest,
    ScenePbrSubsurfaceManifest,
} from "../types.js";
import type {
    CompiledClearCoatOptions,
    CompiledIridescenceOptions,
    CompiledMetallicReflectanceOptions,
    CompiledPbrMaterialOptions,
    CompiledSheenOptions,
    CompiledSubsurfaceOptions,
} from "./material-options.js";

export interface MaterialIntrinsicContext
    extends IntrinsicCallContext {
    recordScenePbrSheen(
        sheen: ScenePbrSheenManifest,
        index: number | undefined,
    ): void;
    recordScenePbrNoColorView(sourceIndex: number | undefined): number;
    recordScenePbrUnlit(index: number | undefined): void;
    recordScenePbrSkybox(index: number | undefined): void;
    recordScenePbrGammaAlbedo(index: number | undefined): void;
    recordSceneMaterialSlot(): number;
    recordScenePbrClearCoat(
        clearCoat: ScenePbrClearCoatManifest,
        index: number | undefined,
    ): void;
    recordScenePbrIridescence(
        iridescence: ScenePbrIridescenceManifest,
        index: number | undefined,
    ): void;
    recordScenePbrAnisotropy(
        anisotropy: ScenePbrAnisotropyManifest,
        index: number | undefined,
    ): void;
    recordScenePbrEmissive(
        color: readonly number[],
        index: number | undefined,
    ): void;
    recordScenePbrMetallicReflectance(
        reflectance: ScenePbrMetallicReflectanceManifest,
        index: number | undefined,
    ): void;
    recordScenePbrSubsurface(
        subsurface: ScenePbrSubsurfaceManifest,
        index: number | undefined,
    ): void;
    expectSameEngine(
        left: Value,
        right: Value,
        node: ts.Node,
    ): void;
    requireDefaultEngine(node: ts.Node): string;
    requireEngine(value: Value, node: ts.Node): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileBoolean(expression: ts.Expression): string;
    compileVec2(expression: ts.Expression): string;
    compileColor3(expression: ts.Expression): string;
    compileStringLiteral(
        expression: ts.Expression,
    ): string;
    compilePbrMaterialOptions(
        expression: ts.Expression,
    ): CompiledPbrMaterialOptions;
    compileMetallicReflectanceOptions(
        expression: ts.Expression,
    ): CompiledMetallicReflectanceOptions;
    allocateTemporaryCppName(label: string): string;
    emit(line: string): void;
    compileGridMaterialOptions(
        expression: ts.Expression,
    ): string[];
    compileClearCoatOptions(
        expression: ts.Expression,
    ): CompiledClearCoatOptions;
    compileIridescenceOptions(
        expression: ts.Expression,
    ): CompiledIridescenceOptions;
    compileAnisotropyOptions(
        expression: ts.Expression,
    ): CompiledAnisotropyOptions;
    compileSheenOptions(expression: ts.Expression): CompiledSheenOptions;
    compileSubsurfaceOptions(
        expression: ts.Expression,
    ): CompiledSubsurfaceOptions;
    compileShaderMaterialOptions(
        expression: ts.Expression,
    ): { name: string; id: number };
    compileNodeMaterialOptions(
        snippetExpression: ts.Expression,
        optionsExpression: ts.Expression | undefined,
    ): CompiledNodeMaterialCall;
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
    resolveShaderTextureSlot(
        material: Value,
        nameExpression: ts.Expression,
    ): number;
    compileShaderUniformComponents(
        expression: ts.Expression,
        count: number,
    ): string[];
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

/**
 * A pinned tone-mapping record a scene imports by name.
 *
 * Upstream models a tone mapping as a value -- `{ id, helpersWGSL, callWGSL }`
 * -- and `pbr-renderable.ts` composes whichever record the scene assigned, so
 * what the identifier carries here is the export's own name. Generation reads
 * that export's WGSL out of the module that owns it; nothing about the curve
 * reaches run time, which is why the value has no native expression.
 */
export function compileMaterialConstant(
    importedName: string,
): Value | undefined {
    if (!isToneMappingExport(importedName)) return undefined;
    return { kind: "tone-mapping", cpp: "", staticString: importedName };
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
            context.reachFeature("texture:file", call);
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
            const {
                baseColor,
                orm,
                metallicFactor,
                roughnessFactor,
                directIntensity,
                environmentIntensity,
                alpha,
                reflectance,
                unlit,
                doubleSided,
                enableSpecularAA,
                skyboxMode,
                transmission,
                indexOfRefraction,
                thickness,
                useThicknessAsDepth,
                hasVolume,
                attenuationColor,
                attenuationDistance,
                occlusionStrength,
                metallicF0Factor,
                usePhysicalLightFalloff,
                scenePbrMaterialIndex,
            } = context.compilePbrMaterialOptions(
                call.arguments[0]!,
            );
            context.expectSameEngine(baseColor, orm, call);
            context.reachFeature("material:pbr", call);
            context.reachFeature("renderer:pbr", call);
            if (
                skyboxMode !== "false" ||
                transmission !== "0.0f" ||
                thickness !== "0.0f" ||
                attenuationColor !==
                    "bbl::Color3{1.0f, 1.0f, 1.0f}" ||
                attenuationDistance !== "1.0f"
            ) {
                context.reachFeature("renderer:transmission", call);
            }
            if (orm.textureFile) {
                context.fail(
                    call,
                    "Reached file textures support the base color slot only.",
                );
            }
            // A loaded base-color image pairs with the neutral white
            // factor texel and attaches after creation, carrying its own
            // encoding: upstream keeps the sRGB/linear choice on the
            // `Texture2D` `loadTexture2D` built, so the slot samples what
            // the scene asked for rather than what the family assumes.
            const baseColorCpp = baseColor.textureFile
                ? "bbl::SolidTexture{bbl::Color4{1.0f, 1.0f, 1.0f, 1.0f}}"
                : baseColor.cpp;
            // Designated rather than positional: the option list is long
            // enough that a member emitted at the wrong index would compile
            // and shade wrong, which is the hazard `CompiledPbrMaterialOptions`
            // stopped being a tuple to avoid. C++20 requires them in
            // declaration order, so a reordered `PbrMaterialOptions` is a
            // compile error here rather than a silent remap.
            const creation =
                `bbl::create_pbr_material(${engine}, ` +
                `bbl::PbrMaterialOptions{` +
                `.base_color = ${baseColorCpp}, ` +
                `.orm = ${orm.cpp}, ` +
                `.metallic_factor = ${metallicFactor}, ` +
                `.roughness_factor = ${roughnessFactor}, ` +
                `.direct_intensity = ${directIntensity}, ` +
                `.environment_intensity = ${environmentIntensity}, ` +
                `.alpha = ${alpha}, ` +
                `.reflectance = ${reflectance}, ` +
                `.unlit = ${unlit}, ` +
                `.double_sided = ${doubleSided}, ` +
                `.specular_aa = ${enableSpecularAA}, ` +
                `.skybox_mode = ${skyboxMode}, ` +
                `.transmission_factor = ${transmission}, ` +
                `.index_of_refraction = ${indexOfRefraction}, ` +
                `.thickness = ${thickness}, ` +
                `.use_thickness_as_depth = ${useThicknessAsDepth}, ` +
                `.has_volume = ${hasVolume}, ` +
                `.attenuation_color = ${attenuationColor}, ` +
                `.attenuation_distance = ${attenuationDistance}, ` +
                `.occlusion_strength = ${occlusionStrength}, ` +
                `.metallic_f0_factor = ${metallicF0Factor}, ` +
                `.use_physical_light_falloff = ` +
                `${usePhysicalLightFalloff}})`;
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
                    scenePbrMaterialIndex,
                };
            }
            return {
                kind: "material",
                cpp: creation,
                engineCpp: engine,
                scenePbrMaterialIndex,
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
            context.reachFeature("renderer:pbr", call);
            context.reachFeature("renderer:transmission", call);
            return {
                kind: "void",
                cpp: `bbl::enable_scene_transmission(${scene.cpp})`,
            };
        }

        case "createGridMaterial": {
            context.recordSceneMaterialSlot();
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
            context.reachFeature("material:grid", call);
            context.reachFeature("renderer:pbr", call);
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
            const engineCpp = context.requireEngine(source, call);
            context.reachFeature("material:no-color-view", call);
            context.reachFeature("renderer:pbr", call);
            if (
                importedName === "createStandardNoColorMaterialView"
            ) {
                context.recordSceneMaterialSlot();
                return {
                    kind: "material",
                    cpp: `bbl::create_standard_no_color_material_view(${engineCpp}, ${source.cpp})`,
                    engineCpp,
                };
            }
            return {
                kind: "material",
                cpp: `bbl::create_pbr_no_color_material_view(${engineCpp}, ${source.cpp})`,
                engineCpp,
                scenePbrMaterialIndex:
                    context.recordScenePbrNoColorView(
                        source.scenePbrMaterialIndex,
                    ),
            };
        }

        case "setStandardEmissiveTexture": {
            // 1.23 moved the optional Standard textures behind per-texture
            // setters so a scene bundles only the fragments it uses; the
            // record write is what the assignment did, and registering the
            // extension is generation's own (`pinned-standard-variants.ts`
            // registers all eight before composing anything).
            context.expectArgumentCount(call, 2, 2);
            const material = context.compileValue(call.arguments[0]!);
            context.expectKind(material, "material", call.arguments[0]!);
            const texture = context.compileValue(call.arguments[1]!);
            context.expectSameEngine(material, texture, call);
            // The slot takes either source the pin's one Texture2D can be.
            // Which arm the composed variant takes follows from that: only
            // a render target carries `_sampleType === "depth"`, which is
            // what selects the extension's unfilterable-float binding.
            if (texture.kind === "texture" && texture.textureFile) {
                context.reachFeature(
                    "material:standard-emissive-file-texture",
                    call,
                );
                return {
                    kind: "void",
                    cpp:
                        `bbl::set_standard_emissive_file_texture(` +
                        `${context.requireEngine(material, call)}, ` +
                        `${material.cpp}, ${texture.cpp})`,
                };
            }
            context.expectKind(
                texture,
                "render-texture",
                call.arguments[1]!,
            );
            context.reachFeature(
                "material:standard-emissive-render-texture",
                call,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::set_standard_emissive_texture(` +
                    `${context.requireEngine(material, call)}, ` +
                    `${material.cpp}, ${texture.cpp})`,
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
            context.recordSceneMaterialSlot();
            context.expectArgumentCount(call, 1, 1);
            const engine =
                context.requireDefaultEngine(call);
            const variant =
                context.compileShaderMaterialOptions(
                    call.arguments[0]!,
                );
            context.reachFeature("material:shader", call);
            context.reachFeature("renderer:pbr", call);
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

        case "setShaderTexture": {
            // src/material/shader/shader-material.ts: the setter stores the
            // texture on the slot the sampler name owns and bumps the
            // material's resource version so the bind group rebuilds. The
            // slot is settled at generation, and the reached slice binds
            // once before registration, so what stays at run time is the
            // texture itself.
            context.expectArgumentCount(call, 3, 3);
            const material =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            const slot = context.resolveShaderTextureSlot(
                material,
                call.arguments[1]!,
            );
            const texture =
                context.compileValue(call.arguments[2]!);
            context.expectKind(
                texture,
                "texture",
                call.arguments[2]!,
            );
            // The reached slice binds a loaded image. `createSolidTexture2D`
            // and `createTexture2DFromPixels` are the same value kind but
            // different native types, so without this they would compile to
            // a C++ overload error in the generated tree rather than a
            // refusal naming the call.
            if (!texture.textureFile) {
                context.fail(
                    call.arguments[2]!,
                    "Reached shader-material textures come from loadTexture2D.",
                );
            }
            context.expectSameEngine(material, texture, call);
            return {
                kind: "void",
                cpp:
                    `bbl::set_shader_texture(` +
                    `${context.requireEngine(material, call)}, ` +
                    `${material.cpp}, ${slot}u, ${texture.cpp})`,
            };
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
            // the glTF emissiveFactor writes. The colour is recorded as
            // well as emitted, because its presence is what the pinned
            // emissive extension's `detect` reads to compose the arm.
            context.expectArgumentCount(call, 2, 2);
            const material =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            const color = context.compileColor3(call.arguments[1]!);
            const channels = color.match(/[0-9.eE+-]+(?=f)/g);
            if (!channels || channels.length !== 3) {
                context.fail(
                    call.arguments[1]!,
                    "setPbrEmissive requires a static linear RGB colour.",
                );
            }
            context.recordScenePbrEmissive(
                channels.map(Number.parseFloat),
                material.scenePbrMaterialIndex,
            );
            context.reachFeature("material:emissive", call);
            return {
                kind: "void",
                cpp:
                    `bbl::set_pbr_emissive(` +
                    `${context.requireEngine(material, call)}, ` +
                    `${material.cpp}, ${color})`,
            };
        }

        case "setPbrGammaAlbedo": {
            // src/material/pbr/set-gamma-albedo.ts stamps
            // `mat._gammaAlbedo = true` and registers the gamma extension,
            // whose whole contribution is one feature bit and the base
            // template's decode block — "No fragment slot / UBO field /
            // binding of its own", as the pinned ext says. So the mark is
            // composition input and nothing else reaches run time: the
            // material's own variant already carries
            // `pow(baseColorSample.rgb, 2.2)`, and the slot it decodes is
            // linear because the scene loaded a linear texture into it.
            context.expectArgumentCount(call, 1, 1);
            const material = context.compileValue(call.arguments[0]!);
            context.expectKind(material, "material", call.arguments[0]!);
            context.recordScenePbrGammaAlbedo(
                material.scenePbrMaterialIndex,
            );
            context.reachFeature("material:pbr-gamma-albedo", call);
            return { kind: "void", cpp: "" };
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
            if (importedName === "setPbrUnlit") {
                context.recordScenePbrUnlit(
                    material.scenePbrMaterialIndex,
                );
            }
            if (importedName === "setPbrSkybox") {
                context.recordScenePbrSkybox(
                    material.scenePbrMaterialIndex,
                );
                // Skybox mode is composed by the transmission-capable
                // renderer (its uniform block carries the skybox
                // option), which the createPbrMaterial `skyboxMode`
                // option used to reach before it became a setter.
                context.reachFeature("renderer:transmission", call);
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

        case "setPbrMetallicReflectance": {
            // The setter conditionally stamps each supplied option, then
            // registers the reflectance extension even for an empty object.
            // Scene 12 reaches the colour, both linear file-map slots and the
            // alpha-only metallic-map arm; setter-side F0/specular overrides
            // stay outside this bounded slice.
            context.expectArgumentCount(call, 2, 2);
            const material = context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            const reflectance =
                context.compileMetallicReflectanceOptions(
                    call.arguments[1]!,
                );
            for (const texture of [
                reflectance.texture,
                reflectance.reflectanceTexture,
            ]) {
                if (texture) {
                    context.expectSameEngine(material, texture, call);
                }
            }
            context.recordScenePbrMetallicReflectance(
                reflectance.manifest,
                material.scenePbrMaterialIndex,
            );
            context.reachFeature(
                "material:metallic-reflectance",
                call,
            );
            const engine = context.requireEngine(material, call);
            return {
                kind: "void",
                cpp:
                    `bbl::set_pbr_metallic_reflectance(` +
                    `${engine}, ${material.cpp}, ` +
                    `${reflectance.colorCpp ? "true" : "false"}, ` +
                    `${reflectance.colorCpp ?? "bbl::Color3{}"}, ` +
                    `${reflectance.texture?.cpp ?? "bbl::FileTexture{}"}, ` +
                    `${reflectance.reflectanceTexture?.cpp ?? "bbl::FileTexture{}"})`,
            };
        }

        case "setPbrSubsurface": {
            context.expectArgumentCount(call, 2, 2);
            const material = context.compileValue(call.arguments[0]!);
            context.expectKind(material, "material", call.arguments[0]!);
            const subsurface = context.compileSubsurfaceOptions(
                call.arguments[1]!,
            );
            if (subsurface.thicknessTexture) {
                context.expectSameEngine(
                    material,
                    subsurface.thicknessTexture,
                    call,
                );
            }
            context.recordScenePbrSubsurface(
                subsurface.manifest,
                material.scenePbrMaterialIndex,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::set_pbr_subsurface(` +
                    `${context.requireEngine(material, call)}, ` +
                    `${material.cpp}, ${subsurface.intensity}, ` +
                    `${subsurface.color}, ${subsurface.diffusionDistance}, ` +
                    `${subsurface.minimumThickness}, ` +
                    `${subsurface.maximumThickness}, ` +
                    `${subsurface.thicknessTexture?.cpp ?? "bbl::FileTexture{}"})`,
            };
        }

        case "setPbrClearCoat": {
            // src/material/pbr/set-clearcoat.ts assigns the props onto the
            // material and registers the clearcoat fragment extension. The
            // registration is unconditional — it does not consult
            // `isEnabled` — so the call reaches the feature and the
            // `isEnabled` guard stays where the pin keeps it, in the UBO
            // writer.
            context.expectArgumentCount(call, 2, 2);
            const material =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            const clearCoat = context.compileClearCoatOptions(
                call.arguments[1]!,
            );
            context.recordScenePbrClearCoat(
                clearCoat.manifest,
                material.scenePbrMaterialIndex,
            );
            context.reachFeature("material:clearcoat", call);
            // `useF0Remap` is not a reached option, so a scene-code coat
            // always takes the pin's default: the remap is composed. Only
            // `gltf-ext-clearcoat.ts` turns it off.
            context.reachFeature("material:clearcoat-f0-remap", call);
            return {
                kind: "void",
                cpp:
                    `bbl::set_pbr_clearcoat(` +
                    `${context.requireEngine(material, call)}, ` +
                    `${material.cpp}, ${clearCoat.enabled}, ` +
                    `${clearCoat.intensity}, ${clearCoat.roughness}, ` +
                    `${clearCoat.indexOfRefraction}, ` +
                    `${clearCoat.bumpTextureScale})`,
            };
        }

        case "setPbrIridescence": {
            // src/material/pbr/set-iridescence.ts, the same opt-in shape as
            // set-clearcoat.ts and set-sheen.ts beside it: the props land on
            // the material and the fragment extension registers
            // unconditionally, so the call reaches the feature and the
            // `isEnabled` guard stays where the pin keeps it, in the UBO
            // writer.
            context.expectArgumentCount(call, 2, 2);
            const material =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            const iridescence = context.compileIridescenceOptions(
                call.arguments[1]!,
            );
            context.recordScenePbrIridescence(
                iridescence.manifest,
                material.scenePbrMaterialIndex,
            );
            context.reachFeature("material:iridescence", call);
            return {
                kind: "void",
                cpp:
                    `bbl::set_pbr_iridescence(` +
                    `${context.requireEngine(material, call)}, ` +
                    `${material.cpp}, ${iridescence.enabled}, ` +
                    `${iridescence.intensity}, ` +
                    `${iridescence.indexOfRefraction}, ` +
                    `${iridescence.minimumThickness}, ` +
                    `${iridescence.maximumThickness})`,
            };
        }

        case "setPbrAnisotropy": {
            // src/material/pbr/set-anisotropy.ts, the same opt-in shape as
            // its three siblings: the props land on the material and the
            // fragment extension registers unconditionally, so the call
            // reaches the feature and the `isEnabled` guard stays where the
            // pin keeps it, in the UBO writer. The layer carries no
            // capability define because it declares no binding and no
            // texture slot -- its whole arm rides the composed variant --
            // and `KHR_materials_anisotropy` reaches the same extension
            // from an asset, which no corpus asset does today.
            context.expectArgumentCount(call, 2, 2);
            const material = context.compileValue(call.arguments[0]!);
            context.expectKind(material, "material", call.arguments[0]!);
            const anisotropy = context.compileAnisotropyOptions(
                call.arguments[1]!,
            );
            context.recordScenePbrAnisotropy(
                anisotropy.manifest,
                material.scenePbrMaterialIndex,
            );
            context.reachFeature("material:anisotropy", call);
            return {
                kind: "void",
                cpp:
                    `bbl::set_pbr_anisotropy(` +
                    `${context.requireEngine(material, call)}, ` +
                    `${material.cpp}, ${anisotropy.enabled}, ` +
                    `${anisotropy.intensity}, ${anisotropy.direction})`,
            };
        }

        case "installPbrTracking":
        case "installStdTracking": {
            // src/material/tracking/{pbr,std}-tracking.ts. Every primitive
            // they install is `Object.defineProperty` with a
            // value-preserving getter and a setter whose only effect is
            // `markMaterialUboDirty` -- so installing changes no value, and
            // what it buys is that a *later* write re-uploads the UBO.
            // Generation already knows which properties a scene writes and
            // re-uploads for them, so the run-time observer has nothing
            // left to observe. The call reaches its material to keep the
            // argument on the walk, and emits nothing.
            //
            // `enableMaterialTracking`, the entry point that picks between
            // these two by family, is deliberately absent: it is `async`
            // and reaches its material through `getMaterialSource`, and no
            // corpus scene calls it, so it fails by name rather than being
            // lowered on an unmeasured guess.
            context.expectArgumentCount(call, 1, 1);
            const material = context.compileValue(call.arguments[0]!);
            context.expectKind(material, "material", call.arguments[0]!);
            context.reachFeature("material:tracking", call);
            return { kind: "void", cpp: "" };
        }

        case "setPbrSheen": {
            // src/material/pbr/set-sheen.ts, the same opt-in shape as
            // set-clearcoat.ts beside it: the props land on the material and
            // the fragment extension registers unconditionally, so the call
            // reaches the feature and the isEnabled guard stays in the
            // pinned UBO writer.
            context.expectArgumentCount(call, 2, 2);
            const material =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            const sheen = context.compileSheenOptions(
                call.arguments[1]!,
            );
            context.recordScenePbrSheen(
                sheen.manifest,
                material.scenePbrMaterialIndex,
            );
            const engine = context.requireEngine(material, call);
            context.reachFeature("material:sheen", call);
            if (sheen.albedoScaling) {
                context.reachFeature("material:sheen-albedo-scaling", call);
            }
            if (sheen.texture) {
                const texture = context.compileValue(
                    sheen.texture,
                );
                context.expectKind(
                    texture,
                    "texture",
                    sheen.texture,
                );
                context.emit(
                    `bbl::set_pbr_sheen_texture(` +
                        `${engine}, ${material.cpp}, ${texture.cpp});`,
                );
            }
            return {
                kind: "void",
                cpp:
                    `bbl::set_pbr_sheen(${engine}, ${material.cpp}, ` +
                    `${sheen.enabled}, ${sheen.color}, ` +
                    `${sheen.roughness}, ${sheen.intensity})`,
            };
        }

        case "setAlphaToCoverage": {
            context.expectArgumentCount(call, 2, 2);
            const material =
                context.compileValue(call.arguments[0]!);
            if (material.kind !== "material") {
                // Another family owns this target; the registry asks each in
                // turn, so yielding is how a shared name reaches it.
                return undefined;
            }
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
            context.recordSceneMaterialSlot();
            context.expectArgumentCount(call, 0, 0);
            const engine =
                context.requireDefaultEngine(call);
            context.reachFeature("material:standard", call);
            context.reachFeature("renderer:pbr", call);
            return {
                kind: "material",
                cpp: `bbl::create_standard_material(${engine})`,
                engineCpp: engine,
            };
        }

        case "parseNodeMaterialFromSnippet": {
            // The pin parses the graph, walks it through one emitter per
            // block class and compiles the module — all of it at page load,
            // from data the source already carries. Generation runs that
            // same compiler over the same graph
            // (`src/pinned-node-material.ts`), so what the call reaches here
            // is the graph's index in the composed table.
            context.recordSceneMaterialSlot();
            context.expectArgumentCount(call, 2, 3);
            const engine = context.requireEngine(
                context.compileValue(call.arguments[0]!),
                call,
            );
            const graph = context.compileNodeMaterialOptions(
                call.arguments[1]!,
                call.arguments[2],
            );
            context.reachFeature("material:node", call);
            context.reachFeature("renderer:pbr", call);
            // The textures travel under the names the call keyed them by,
            // because that is the join the pin performs: a declared binding
            // reads `options.textures?.[tb._name]`, and which pair a name
            // lands on is the composition's answer rather than this call's.
            // Resolving here would need the composed order the compiler does
            // not have yet, and would put the same lookup in a second place.
            const textures = graph.textures
                .map(
                    (entry) =>
                        `bbl::NodeMaterialTexture{` +
                        `${context.cppString(entry.name)}, ` +
                        `${entry.texture.cpp}}`,
                )
                .join(", ");
            return {
                kind: "material",
                cpp:
                    `bbl::create_node_material(${engine}, ` +
                    `${graph.index}u, {${textures}})`,
                engineCpp: engine,
            };
        }

        case "enableMaterialUvTransform": {
            // src/material/enable-material-uv-transform.ts marks the
            // material and preloads the extension's fragment module. The
            // preload is a bundling concern with no native counterpart --
            // generation composes against the extension either way -- so
            // what reaches the record is the mark, which is exactly what
            // `stdUvTransformExt._meshFeatures` reads back.
            context.expectArgumentCount(call, 1, 1);
            const material = context.compileValue(call.arguments[0]!);
            context.expectKind(material, "material", call.arguments[0]!);
            context.reachFeature("material:standard", call);
            context.reachFeature("material:standard-uv-transform", call);
            context.reachFeature("renderer:pbr", call);
            return {
                kind: "void",
                cpp:
                    `bbl::enable_material_uv_transform(` +
                    `${context.requireEngine(material, call)}, ` +
                    `${material.cpp})`,
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
            context.reachFeature("material:standard", call);
            context.reachFeature("material:standard-vertex-colors", call);
            context.reachFeature("renderer:pbr", call);
            return { kind: "void", cpp: "" };
        }

        default:
            return undefined;
    }
}
