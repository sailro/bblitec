import ts from "typescript";
import type { CompileAsset, Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { enclosingLoopControl } from "../statements.js";
import type { CompiledAnisotropyOptions } from "./material-options.js";
import {
    requiredStaticColor3,
    staticColor3Value,
} from "./material-options.js";
import type { CompiledNodeMaterialCall } from "../node-material.js";
import { isToneMappingExport } from "../../pinned-tone-mapping.js";
import { linearDepthDefaultPlanes } from "../linear-depth-material.js";
import {
    compileOptionalStaticBoolean,
    compileStaticNumber,
    staticNumberValue,
    validateObjectProperties,
    type ObjectValidationContext,
    type PositiveIntegerContext,
} from "../option-helpers.js";
import type {
    SceneMeshNamePredicate,
    ScenePbrClearCoatManifest,
    ScenePbrAnisotropyManifest,
    ScenePbrIridescenceManifest,
    ScenePbrLightmapManifest,
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
    extends IntrinsicCallContext,
        ObjectValidationContext,
        PositiveIntegerContext {
    engineHasStarted(): boolean;
    recordScenePbrSheen(
        sheen: ScenePbrSheenManifest,
        index: number | undefined,
    ): void;
    recordScenePbrNoColorView(sourceIndex: number | undefined): number;
    recordScenePbrUnlit(index: number | undefined): void;
    recordAssetSceneUnlit(
        asset: CompileAsset,
        tint: readonly [number, number, number] | undefined,
        node: ts.Node,
    ): void;
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
    recordScenePbrLightmap(
        lightmap: ScenePbrLightmapManifest,
        index: number | undefined,
    ): void;
    /**
     * The lightmap a walk over `scene.meshes` stamped on a loaded
     * container's materials, with the walk's own mesh-name filter. The
     * document evaluates the filter at composition; nothing here reads a
     * name.
     */
    recordAssetSceneLightmap(
        meshNamePredicate: SceneMeshNamePredicate,
        lightmap: ScenePbrLightmapManifest,
        node: ts.Node,
    ): void;
    /** Whether `enablePbrLightmap()` has registered the extension yet. */
    pbrLightmapEnabled(): boolean;
    /**
     * Textures a material slot has already copied. Upstream binds one
     * object, so a `Texture2D` property written after the copy would reach
     * the material there and not here; the write site refuses on this.
     */
    readonly boundPixelsTextures: Set<string>;
    recordScenePbrAnisotropy(
        anisotropy: ScenePbrAnisotropyManifest,
        index: number | undefined,
    ): void;
    recordScenePbrEmissive(
        color: readonly [number, number, number] | undefined,
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
    ): {
        name: string;
        id: number;
        dynamicUniforms?: Array<{
            offset: number;
            components: string[];
        }>;
    };
    reachLinearDepthMaterial(
        node: ts.Node,
        options: { near: number; far: number },
    ): { name: string; id: number };
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
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
 * The mesh-name test a scene's own walk wrote, as the closed predicate
 * generation can evaluate against a document.
 *
 * Nothing here interprets a name: the grammar is equality, `startsWith`
 * and the three boolean operators, which is what the reached filter is
 * written in, and every other shape refuses naming itself. That is the
 * point — the selection decides which materials compose the lightmap arm,
 * and a filter this cannot represent has to fail rather than be
 * approximated into stamping the wrong set.
 */
function compileMeshNamePredicate(
    context: MaterialIntrinsicContext,
    binding: string,
    expression: ts.Expression,
): SceneMeshNamePredicate {
    const node = context.resolveStaticExpression(expression);
    if (ts.isParenthesizedExpression(node)) {
        return compileMeshNamePredicate(context, binding, node.expression);
    }
    if (
        ts.isPrefixUnaryExpression(node) &&
        node.operator === ts.SyntaxKind.ExclamationToken
    ) {
        return {
            kind: "not",
            operand: compileMeshNamePredicate(context, binding, node.operand),
        };
    }
    // `<binding>.name`, the only value the grammar reads.
    const readsName = (candidate: ts.Expression): boolean => {
        const inner = context.resolveStaticExpression(candidate);
        return (
            ts.isPropertyAccessExpression(inner) &&
            inner.name.text === "name" &&
            ts.isIdentifier(inner.expression) &&
            inner.expression.text === binding
        );
    };
    const literal = (candidate: ts.Expression): string | undefined => {
        const inner = context.resolveStaticExpression(candidate);
        return ts.isStringLiteralLike(inner) ? inner.text : undefined;
    };
    if (ts.isBinaryExpression(node)) {
        const operator = node.operatorToken.kind;
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
            return {
                kind: "and",
                operands: [
                    compileMeshNamePredicate(context, binding, node.left),
                    compileMeshNamePredicate(context, binding, node.right),
                ],
            };
        }
        if (operator === ts.SyntaxKind.BarBarToken) {
            return {
                kind: "or",
                operands: [
                    compileMeshNamePredicate(context, binding, node.left),
                    compileMeshNamePredicate(context, binding, node.right),
                ],
            };
        }
        if (
            operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
        ) {
            const value = readsName(node.left)
                ? literal(node.right)
                : readsName(node.right)
                  ? literal(node.left)
                  : undefined;
            if (value !== undefined) {
                const equals: SceneMeshNamePredicate = { kind: "equals", value };
                return operator === ts.SyntaxKind.EqualsEqualsEqualsToken
                    ? equals
                    : { kind: "not", operand: equals };
            }
        }
    }
    if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "startsWith" &&
        node.arguments.length === 1 &&
        readsName(node.expression.expression)
    ) {
        const value = literal(node.arguments[0]!);
        if (value !== undefined) return { kind: "startsWith", value };
    }
    context.fail(
        expression,
        "A lightmap walk's mesh filter is folded into a compile-time " +
            "material selection, so it is read in a closed grammar: " +
            "`mesh.name === \"...\"`, `mesh.name.startsWith(\"...\")`, and " +
            "`!`/`&&`/`||` over those. This test is outside it, and " +
            "approximating it would stamp the wrong materials.",
    );
}

/**
 * The statements a folded walk's body may hold after its filter.
 *
 * The filter is the only selector the fold represents, so a second one —
 * a `continue` further down, a `break`, an early `return` — would make the
 * runtime loop visit a set the fold cannot see. Each refuses by name.
 */
function assertNoSecondSelector(
    context: MaterialIntrinsicContext,
    statement: ts.Statement,
): void {
    // One traversal with the container walk's own guard: it stops at a
    // nested loop, at a function-like and — for an unqualified `break` — at
    // a nested `switch`, so a loop or switch inside the body is not
    // mistaken for a second exit from this one.
    const second = enclosingLoopControl(statement, { returns: true });
    if (second) {
        context.fail(
            second,
            "A lightmap walk's body selects with its leading mesh-name " +
                "filter alone: generation folds that filter into the " +
                "materials it composes, and a second exit would leave " +
                "the run-time loop visiting a different set.",
        );
    }
}

/**
 * The walk a `setPbrLightmap` on a LOADED material sits inside, folded.
 *
 * A loaded material has no scene-side record a setter could name, so the
 * only compile-time identity is the document its container composes — the
 * same position `setPbrUnlit` is in. What differs is the selection: this
 * walk stamps by mesh name, and PBR composition is settled per material at
 * generation, so the filter has to reach generation with it. Hence the
 * licence is minted by the loop itself: `for (const m of scene.meshes)`
 * demonstrably visits every renderable in the scene, and its own leading
 * filter is what narrows that to the materials this returns.
 */
function foldedLightmapMeshWalk(
    context: MaterialIntrinsicContext,
    call: ts.CallExpression,
): SceneMeshNamePredicate {
    let node: ts.Node = call;
    while (node.parent && !ts.isForOfStatement(node.parent)) {
        node = node.parent;
        // A function boundary ends the climb: a `setPbrLightmap` factored
        // into a helper is not lexically inside the walk, so the walk's
        // own proof does not reach it.
        if (ts.isFunctionLike(node)) break;
    }
    const walk = node.parent;
    if (!walk || !ts.isForOfStatement(walk)) {
        context.fail(
            call,
            "setPbrLightmap on a loaded material is lowered only inside a " +
                "`for (const mesh of scene.meshes)` walk: a loaded material " +
                "has no compile-time identity of its own, and the walk is " +
                "the proof that the materials generation stamps are the " +
                "ones the run-time loop reaches.",
        );
    }
    const subject = walk.expression;
    if (
        !ts.isPropertyAccessExpression(subject) ||
        subject.name.text !== "meshes" ||
        !ts.isIdentifier(subject.expression) ||
        context.lookupOptional(subject.expression)?.kind !== "scene"
    ) {
        context.fail(
            walk.expression,
            "A lightmap walk iterates `scene.meshes`, which is what reaches " +
                "every renderable the scene holds; another collection " +
                "carries no such proof.",
        );
    }
    const declarations = ts.isVariableDeclarationList(walk.initializer)
        ? walk.initializer.declarations
        : [];
    const binding = declarations.length === 1 &&
            ts.isIdentifier(declarations[0]!.name)
        ? declarations[0]!.name.text
        : undefined;
    if (binding === undefined) {
        context.fail(
            walk.initializer,
            "A lightmap walk binds each mesh to one identifier.",
        );
    }
    const statements = ts.isBlock(walk.statement)
        ? [...walk.statement.statements]
        : [walk.statement];
    // The filter: a leading `if (<test>) continue;` and nothing else that
    // decides membership. A walk without one stamps every renderable,
    // which is the same shape `setPbrUnlit` over a container takes.
    const head = statements[0];
    const guard = head !== undefined && ts.isIfStatement(head) &&
            !head.elseStatement
        ? head
        : undefined;
    const thenBody = guard === undefined
        ? []
        : ts.isBlock(guard.thenStatement)
        ? [...guard.thenStatement.statements]
        : [guard.thenStatement];
    const filter = thenBody.length === 1 &&
            ts.isContinueStatement(thenBody[0]!)
        ? guard
        : undefined;
    for (const statement of statements.slice(filter ? 1 : 0)) {
        assertNoSecondSelector(context, statement);
    }
    if (!filter) return { kind: "always" };
    return {
        kind: "not",
        operand: compileMeshNamePredicate(
            context,
            binding,
            filter.expression,
        ),
    };
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
    const engine = context.requireEngine(material, call);
    if (material.sceneMaterialSlot !== undefined) {
        return {
            kind: "void",
            cpp:
                `bbl::set_scene_shader_uniform_value(` +
                `${engine}, ${material.sceneMaterialSlot}u, ${offset}u, ` +
                `${components.join(", ")})`,
        };
    }
    return {
        kind: "void",
        cpp:
            `bbl::set_shader_uniform_value(` +
            `${engine}, ${material.cpp}, ${offset}u, ` +
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
                textureStorage: "solid",
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
                baseColorFactor,
                orm,
                metallicFactor,
                roughnessFactor,
                directIntensity,
                environmentIntensity,
                alpha,
                alphaBlend,
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
            context.reachFeature("renderer:scene", call);
            const linearImageProcessing =
                transmission !== "0.0f" ||
                thickness !== "0.0f" ||
                attenuationColor !==
                    "bbl::Color3{1.0f, 1.0f, 1.0f}" ||
                attenuationDistance !== "1.0f";
            if (skyboxMode !== "false" || linearImageProcessing) {
                context.reachFeature("renderer:transmission", call);
            }
            if (linearImageProcessing) {
                context.reachFeature(
                    "material:pbr-linear-image-processing",
                    call,
                );
            }
            if (orm.textureFile?.srgb) {
                context.fail(
                    call,
                    "PBR ORM maps must be linear textures.",
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
            // The pinned PBR fragment always samples its ORM texture. A
            // loaded image therefore uses the same neutral white creation
            // fallback as a missing image, then replaces that slot after the
            // material record exists. loadTexture2D's sampler and invertY
            // remain on the FileTexture that the attachment moves whole.
            const ormCpp = orm.textureFile
                ? "bbl::SolidTexture{bbl::Color4{1.0f, 1.0f, 1.0f, 1.0f}}"
                : orm.cpp;
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
                `.base_color_factor = ${baseColorFactor}, ` +
                `.orm = ${ormCpp}, ` +
                `.metallic_factor = ${metallicFactor}, ` +
                `.roughness_factor = ${roughnessFactor}, ` +
                `.direct_intensity = ${directIntensity}, ` +
                `.environment_intensity = ${environmentIntensity}, ` +
                `.alpha = ${alpha}, ` +
                `.alpha_blend = ${alphaBlend}, ` +
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
            if (baseColor.textureFile || orm.textureFile) {
                const temporary =
                    context.allocateTemporaryCppName(
                        "material",
                    );
                context.emit(
                    `auto ${temporary} = ${creation};`,
                );
                if (baseColor.textureFile) {
                    context.emit(
                        `bbl::set_material_base_color_file(${engine}, ${temporary}, ${baseColor.cpp});`,
                    );
                }
                if (orm.textureFile) {
                    context.emit(
                        `bbl::set_material_orm_file(${engine}, ${temporary}, ${orm.cpp});`,
                    );
                }
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
            context.reachFeature("renderer:scene", call);
            context.reachFeature("renderer:transmission", call);
            context.reachFeature(
                "material:pbr-linear-image-processing",
                call,
            );
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
            context.reachFeature("renderer:scene", call);
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
            context.reachFeature("renderer:scene", call);
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
            const materialSlot = context.recordSceneMaterialSlot();
            context.expectArgumentCount(call, 1, 1);
            const engine =
                context.requireDefaultEngine(call);
            const variant =
                context.compileShaderMaterialOptions(
                    call.arguments[0]!,
                );
            context.reachFeature("material:shader", call);
            context.reachFeature("renderer:scene", call);
            let materialCpp =
                `bbl::remember_scene_material(${engine}, ` +
                `${materialSlot}u, ` +
                `bbl::create_shader_material(${engine}, ${variant.id}u))`;
            if (variant.dynamicUniforms?.length) {
                const material = context.allocateTemporaryCppName(
                    "shader_material",
                );
                context.emit(`const auto ${material} = ${materialCpp};`);
                for (const uniform of variant.dynamicUniforms) {
                    context.emit(
                        `bbl::set_shader_uniform_value(${engine}, ` +
                            `${material}, ${uniform.offset}u, ` +
                            `${uniform.components.join(", ")});`,
                    );
                }
                materialCpp = material;
            }
            return {
                kind: "material",
                cpp: materialCpp,
                engineCpp: engine,
                shaderVariant: variant.name,
                sceneShaderVariant: variant.name,
                sceneMaterialSlot: materialSlot,
            };
        }

        case "createLinearDepthMaterial": {
            // The pin's own `createShaderMaterial` call, folded: two module
            // constants for the stages, the pin's plane defaults, and the
            // fixed-function state read from the properties beside them.
            // What a caller settles is the near/far pair the one custom
            // uniform carries.
            context.recordSceneMaterialSlot();
            context.expectArgumentCount(call, 0, 1);
            const engine = context.requireDefaultEngine(call);
            const defaults = linearDepthDefaultPlanes();
            const options = call.arguments[0]
                ? context.expectObjectLiteral(call.arguments[0]!)
                : undefined;
            if (options) {
                // `name` refuses rather than being accepted and dropped:
                // the pin names every one of these materials `linearDepth`
                // and this port's variant identity is the plane pair, so a
                // caller's name could not reach anything.
                validateObjectProperties(
                    context,
                    options,
                    ["near", "far"],
                    "Reached linear-depth materials support near and far.",
                );
            }
            const plane = (name: "near" | "far"): number => {
                const expression = options
                    ? context.objectProperty(options, name)
                    : undefined;
                if (!expression) return defaults[name];
                const value = staticNumberValue(context, expression);
                if (value === undefined) {
                    context.fail(
                        expression,
                        `A linear-depth material's ${name} plane is a ` +
                            "compile-time number: it is the uniform default " +
                            "the composed variant carries.",
                    );
                }
                return value;
            };
            const variant = context.reachLinearDepthMaterial(call, {
                near: plane("near"),
                far: plane("far"),
            });
            context.reachFeature("material:shader", call);
            context.reachFeature("renderer:scene", call);
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
            const cachedPixelsTexture =
                texture.dataType?.kind === "handle" &&
                texture.dataType.handle === "texture";
            const setter = texture.textureFile
                ? "set_shader_texture"
                : texture.textureStorage === "pixels" ||
                    cachedPixelsTexture
                  ? "set_shader_pixels_texture"
                  : undefined;
            if (!setter) {
                context.fail(
                    call.arguments[2]!,
                    "Reached shader-material textures come from loadTexture2D or createTexture2DFromPixels.",
                );
            }
            context.expectSameEngine(material, texture, call);
            return {
                kind: "void",
                cpp:
                    `bbl::${setter}(` +
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
            const colorExpression = call.arguments[1]!;
            const channels = staticColor3Value(context, colorExpression);
            const color = context.compileColor3(colorExpression);
            context.recordScenePbrEmissive(
                channels,
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

        case "setPbrUnlit": {
            // src/material/pbr/set-unlit.ts: an opt-in setter that flags the
            // material after creation, registers its fragment extension, and
            // stores the linear-RGB tint that fragment multiplies the base
            // colour by — the pin guarding that store, so an omitted tint
            // leaves whatever the material already carries.
            context.expectArgumentCount(call, 1, 2);
            const material = context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            // The setters are emitted into the PBR material factory's own
            // translation unit, so a scene that only stamps a loaded
            // material — never creating one — still needs that unit.
            context.reachFeature("material:pbr", call);
            const tintExpression = call.arguments[1];
            const tint = tintExpression
                ? requiredStaticColor3(
                      context,
                      tintExpression,
                      "setPbrUnlit's tint must be a static linear RGB colour: it is written into the material UBO the fragment reads.",
                  )
                : undefined;
            // A material read off a loaded mesh has no scene-side record to
            // stamp: its unlit arm is composed from the document. The fact
            // is the container's, and `assetWholeMeshList` is the proof that
            // the walk reaching this material reaches every one of them.
            const container = material.assetPbrMaterial
                ? material.assetWholeMeshList
                : undefined;
            if (container) {
                context.recordAssetSceneUnlit(
                    container,
                    tint?.channels,
                    call,
                );
            } else {
                context.recordScenePbrUnlit(
                    material.scenePbrMaterialIndex,
                );
            }
            return {
                kind: "void",
                cpp:
                    "bbl::set_pbr_unlit(" +
                    `${context.requireEngine(material, call)}, ` +
                    material.cpp +
                    (tint ? `, ${tint.cpp}` : "") +
                    ")",
            };
        }

        case "setPbrSkybox": {
            // src/material/pbr/set-skybox.ts: the same shape as
            // `setPbrUnlit` above, taking the material alone.
            context.expectArgumentCount(call, 1, 1);
            const material = context.compileValue(call.arguments[0]!);
            context.expectKind(
                material,
                "material",
                call.arguments[0]!,
            );
            context.reachFeature("material:pbr", call);
            context.recordScenePbrSkybox(
                material.scenePbrMaterialIndex,
            );
            // Skybox mode is composed by the transmission-capable renderer
            // (its uniform block carries the skybox option), which the
            // createPbrMaterial `skyboxMode` option used to reach before it
            // became a setter.
            context.reachFeature("renderer:transmission", call);
            return {
                kind: "void",
                cpp:
                    "bbl::set_pbr_skybox(" +
                    `${context.requireEngine(material, call)}, ` +
                    material.cpp +
                    ")",
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

        case "enablePbrLightmap": {
            // src/material/pbr/enable-pbr-lightmap.ts: the opt-in that
            // imports the lightmap fragment and registers its extension.
            // Upstream the always-loaded PBR core scans for no
            // `lightmapTexture` at all, so this call IS the reach — which
            // is why the feature is recorded here and not at
            // `setPbrLightmap`, exactly as `enableMaterialPlugins` records
            // its bridges rather than the `plugins` write.
            //
            // Generation performs the same registration before it composes
            // (`src/pinned-pbr-variants.ts`), so nothing is emitted; what
            // the feature selects natively is the material record's
            // lightmap lanes, its texture slot and the composed arm.
            context.expectArgumentCount(call, 0, 0);
            context.reachFeature("material:pbr", call);
            context.reachFeature("material:lightmap", call);
            context.reachFeature("renderer:scene", call);
            return { kind: "void", cpp: "" };
        }

        case "setPbrLightmap": {
            // src/material/pbr/enable-pbr-lightmap.ts#setPbrLightmap: the
            // props land on the material and the `_uv2Mask` bit records the
            // TEXCOORD_1 claim. Every one of them is composition input --
            // the extension's own `detect` reads the blend, the UV set, the
            // gamma decode and the texture's `invertY`/`uAng` pair to pick
            // which of the fragment's arms composes -- so they are settled
            // at generation; only the level stays a record lane, because
            // the pin's `writeLightmapUBO` reads it live.
            context.expectArgumentCount(call, 2, 3);
            const material = context.compileValue(call.arguments[0]!);
            context.expectKind(material, "material", call.arguments[0]!);
            const texture = context.compileValue(call.arguments[1]!);
            context.expectKind(texture, "texture", call.arguments[1]!);
            if (texture.textureStorage !== "file") {
                context.fail(
                    call.arguments[1]!,
                    "A reached lightmap is a `loadTexture2D` image: the " +
                        "extension binds the texture's own view and sampler, " +
                        "and its V-flip arm folds the texture-object " +
                        "`invertY` this port only records for a loaded one.",
                );
            }
            context.expectSameEngine(material, texture, call);
            if (!context.pbrLightmapEnabled()) {
                context.fail(
                    call,
                    "setPbrLightmap is reached before `enablePbrLightmap()`. " +
                        "Upstream that setter stamps a material no registered " +
                        "extension detects, so nothing composes and nothing " +
                        "renders; composition is settled where the call sits " +
                        "here, so the opt-in has to precede it.",
                );
            }
            const options = call.arguments[2]
                ? context.expectObjectLiteral(call.arguments[2])
                : undefined;
            if (options) {
                validateObjectProperties(
                    context,
                    options,
                    ["level", "coordIndex", "useAsShadowmap", "gamma"],
                    "Reached lightmap options support level, coordIndex, useAsShadowmap, and gamma.",
                );
            }
            const coordIndexExpression = options &&
                context.objectProperty(options, "coordIndex");
            // The pin's own `options?.coordIndex ?? 1`.
            const coordIndex = coordIndexExpression
                ? compileStaticNumber(
                    context,
                    coordIndexExpression,
                    "A lightmap coordIndex",
                )
                : 1;
            if (coordIndex !== 0 && coordIndex !== 1) {
                context.fail(
                    coordIndexExpression ?? call,
                    "A lightmap samples TEXCOORD_0 or TEXCOORD_1; the pinned " +
                        "extension declares no other UV set.",
                );
            }
            const useAsShadowmap = compileOptionalStaticBoolean(
                context,
                options && context.objectProperty(options, "useAsShadowmap"),
                false,
                "A lightmap's useAsShadowmap",
            );
            const gamma = compileOptionalStaticBoolean(
                context,
                options && context.objectProperty(options, "gamma"),
                false,
                "A lightmap's gamma",
            );
            // `material.lightmapLevel = options?.level ?? 1` — the one
            // runtime lane, so the expression need not settle here.
            const levelExpression = options &&
                context.objectProperty(options, "level");
            const level = levelExpression
                ? context.compileNumber(levelExpression, "float")
                : "1.0f";
            const lightmap: ScenePbrLightmapManifest = {
                coordIndex,
                useAsShadowmap,
                gamma,
                textureInvertY: texture.textureObjectInvertY === true,
                textureUAng: texture.textureUvAng ?? 0,
            };
            context.reachFeature("material:pbr", call);
            // The material record takes a copy of the texture, so a later
            // `uAng`/`invertY` write would move the local where upstream
            // would have moved the bound object — and with it the arm this
            // call just composed.
            context.boundPixelsTextures.add(texture.cpp);
            if (material.assetPbrMaterial) {
                context.recordAssetSceneLightmap(
                    foldedLightmapMeshWalk(context, call),
                    lightmap,
                    call,
                );
            } else {
                context.recordScenePbrLightmap(
                    lightmap,
                    material.scenePbrMaterialIndex,
                );
            }
            return {
                kind: "void",
                cpp:
                    `bbl::set_pbr_lightmap(` +
                    `${context.requireEngine(material, call)}, ` +
                    `${material.cpp}, ${texture.cpp}, ${level})`,
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
            context.reachFeature("renderer:scene", call);
            return {
                kind: "material",
                cpp: `bbl::create_standard_material(${engine})`,
                engineCpp: engine,
                standardMaterial: true,
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
            context.reachFeature("renderer:scene", call);
            // The textures travel under the names the call keyed them by,
            // because that is the join the pin performs: a declared binding
            // reads `options.textures?.[tb._name]`, and which pair a name
            // lands on is the composition's answer rather than this call's.
            // Resolving here would need the composed order the compiler does
            // not have yet, and would put the same lookup in a second place.
            const textures = graph.textures
                .map(
                    (entry) =>
                        `bbl::node_material_texture(` +
                        `${context.cppString(entry.name)}, ` +
                        `${entry.texture.cpp})`,
                )
                .join(", ");
            return {
                kind: "material",
                cpp:
                    `bbl::create_node_material(${engine}, ` +
                    `${graph.index}u, {${textures}})`,
                engineCpp: engine,
                nodeMaterialIndex: graph.index,
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
            context.reachFeature("renderer:scene", call);
            return {
                kind: "void",
                cpp:
                    `bbl::enable_material_uv_transform(` +
                    `${context.requireEngine(material, call)}, ` +
                    `${material.cpp})`,
            };
        }

        case "enableMaterialPlugins": {
            // src/material/plugin/enable-material-plugins.ts registers the
            // two plugin bridges into the global PBR and Standard extension
            // registries, and the pre-existing hook loops then compose the
            // plugin fragment with no shared-code change at all. Generation
            // performs the same registration before it composes
            // (`src/pinned-material-plugins.ts`), so the call reaches the
            // feature and emits nothing -- the same shape
            // `enableStandardVertexColors` takes, and for the same reason.
            //
            // Reaching the feature HERE rather than at the `plugins` write
            // is the pin's own boundary: a scene that attaches plugins and
            // never calls this composes exactly what it composed before,
            // because nothing registered the bridges.
            context.expectArgumentCount(call, 1, 1);
            const scene = context.compileValue(call.arguments[0]!);
            context.expectKind(scene, "scene", call.arguments[0]!);
            context.reachFeature("material:plugins", call);
            return { kind: "void", cpp: "" };
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
            context.reachFeature("renderer:scene", call);
            return { kind: "void", cpp: "" };
        }

        case "rebuildMaterial": {
            context.expectArgumentCount(call, 2, 3);
            const scene = context.compileValue(call.arguments[0]!);
            const material = context.compileValue(call.arguments[1]!);
            context.expectKind(scene, "scene", call.arguments[0]!);
            context.expectKind(material, "material", call.arguments[1]!);
            context.expectSameEngine(scene, material, call);
            if (context.engineHasStarted()) {
                context.fail(
                    call,
                    "rebuildMaterial after startEngine requires live GPU material resource replacement.",
                );
            }
            if (call.arguments[2]) {
                const options = context.expectObjectLiteral(
                    call.arguments[2],
                );
                validateObjectProperties(
                    context,
                    options,
                    ["rebuildViews", "rebuildFrameGraph"],
                    "rebuildMaterial options support rebuildViews and rebuildFrameGraph.",
                );
                for (const name of [
                    "rebuildViews",
                    "rebuildFrameGraph",
                ]) {
                    const property = context.objectProperty(options, name);
                    if (!property) continue;
                    const value = context.compileBoolean(property);
                    if (value !== "true" && value !== "false") {
                        context.fail(
                            property,
                            `${name} must be a static boolean.`,
                        );
                    }
                }
            }
            // Native material records are uploaded when startEngine builds
            // the renderer. A pre-start rebuild therefore observes exactly
            // the final record state without doing any work of its own.
            return { kind: "void", cpp: "" };
        }

        default:
            return undefined;
    }
}
