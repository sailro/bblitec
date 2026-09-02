import ts from "typescript";
import type {
    Feature,
    ShadowCasterMeshManifest,
    Value,
} from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    compilePositiveInteger,
    validateObjectProperties,
    type ObjectValidationContext,
    type PositiveIntegerContext,
} from "../option-helpers.js";

export interface ShadowIntrinsicContext
    extends IntrinsicCallContext,
        ObjectValidationContext,
        PositiveIntegerContext {
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    readonly handleCollections: {
        tupleElements(
            expression: ts.Expression,
        ): readonly Value[] | undefined;
        /** An inline array or a compile-time tuple, as one list. */
        staticHandleList(
            expression: ts.Expression,
        ): readonly { value: Value; node: ts.Node }[] | undefined;
    };
    requireEngine(value: Value, node: ts.Node): string;
    ensureDefaultRenderTask(
        scene: Value,
        node: ts.Node,
    ): string | undefined;
    fail(node: ts.Node, message: string): never;
    recordShadowGenerator(entry: {
        kind:
            | "pcf-spot"
            | "pcf-directional"
            | "csm-directional"
            | "esm-directional";
        lightIndex: number;
        esm?: {
            mapSize?: number;
            blurKernel?: number;
            blurScale?: number;
        };
    }): number;
    recordShadowCasters(
        generatorIndex: number,
        casters: readonly ShadowCasterMeshManifest[],
    ): void;
    shadowGeneratorHasRecordedCasters(generatorIndex: number): boolean;
    recordDynamicShadowCasters(generatorIndex: number): void;
    esmGeneratorOrdinal(): number;
}

/**
 * The options `createPcfSpotlightShadowGenerator` takes.
 *
 * `mapSize`, `bias` and `darkness` size the generator's own resources, so
 * they are resolved at generation; `near` and `far` are the projection
 * volume and stay run-time expressions, because scene 18 reads them off the
 * camera it just configured. `normalBias` and `forceRefreshEveryFrame` are
 * unreached and refuse by name rather than compiling to a value the pin
 * would have used differently.
 */
const spotOptions = [
    "mapSize",
    "bias",
    "darkness",
    "near",
    "far",
] as const;

/**
 * The options `createPcfDirectionalShadowGenerator` takes.
 *
 * The spot factory's first three, then the ortho pair that replaces its
 * `near`/`far`: a directional light has no position to project from, so the
 * volume is fitted to the casters and these two are the depth range that fit
 * projects into. `normalBias` and `forceRefreshEveryFrame` are unreached and
 * refuse by name, exactly as they do on the spot factory.
 */
const pcfDirectionalOptions = [
    "mapSize",
    "bias",
    "darkness",
    "orthoMinZ",
    "orthoMaxZ",
] as const;

/**
 * The CSM factory's public configuration, as far as this port builds it.
 *
 * `mapSize` and `numCascades` size the layered map, so they resolve at
 * generation; the rest ride into the record, where the cascade fit and the
 * receiver's 320-byte block read them. `stabilizeCascades` (the
 * bounding-sphere fit and its light-axis anchor grid) and `worldSpaceBias`
 * (the far-plane reserve and its per-cascade clip offset) are the two arms
 * this port does not build, so they refuse by name rather than compiling to
 * a value the pin would have used differently.
 */
const csmDirectionalOptions = [
    "mapSize",
    "numCascades",
    "lambda",
    "cascadeBlendPercentage",
    "shadowMaxZ",
    "bias",
    "darkness",
    "frustumEdgeFalloff",
    "forceRefreshEveryFrame",
] as const;

/**
 * The options `createEsmDirectionalShadowGenerator` takes.
 *
 * Three of them decide generated artifacts rather than run-time values:
 * `mapSize` and `blurScale` size four GPU textures, and `blurKernel` is
 * folded into the blur fragment's own tap table by
 * `createShadowBlurFragmentWGSL`. The rest stay run-time expressions,
 * because scene 4 reads the two ortho bounds off the camera it just
 * configured. `forceRefreshEveryFrame` rides into the record, where it
 * disables the pinned render gate (break-meshes reaches it: its
 * physics-driven pieces move the map every frame).
 */
const esmDirectionalOptions = [
    "mapSize",
    "depthScale",
    "bias",
    "blurKernel",
    "blurScale",
    "darkness",
    "frustumEdgeFalloff",
    "orthoMinZ",
    "orthoMaxZ",
    "forceRefreshEveryFrame",
] as const;

/** The ESM ordinal is generation's, not an option the scene passes. */
const esmDirectionalEmitted = [
    "mapSize",
    "depthScale",
    "bias",
    "blurKernel",
    "blurScale",
    "darkness",
    "frustumEdgeFalloff",
    "orthoMinZ",
    "orthoMaxZ",
    "forceRefreshEveryFrame",
    "esmIndex",
] as const;

/**
 * What separates one pinned generator factory from another.
 *
 * The three resolve identically -- engine, light of the right kind, a light
 * already added to the scene, an optional config validated against the
 * factory's own option list, each option either resolved at generation or
 * kept as a run-time expression, then a manifest record and a call. Only
 * these rows differ, so the shape is written once and a fourth family is a
 * fourth row rather than a fourth copy.
 */
interface ShadowGeneratorFactory {
    kind:
        | "pcf-spot"
        | "pcf-directional"
        | "csm-directional"
        | "esm-directional";
    lightKind: "spot" | "directional";
    /** How a refusal names this family, e.g. "A PCF spotlight". */
    article: string;
    options: readonly string[];
    /** The struct's field order, which the ESM extends with its ordinal. */
    emitted: readonly string[];
    defaults: Readonly<Record<string, string>>;
    /**
     * Options that decide a GENERATED artifact -- a texture extent, a folded
     * blur table -- and so must resolve to a literal here. Everything else
     * stays a run-time expression, because a scene may read it off the
     * camera it just configured.
     */
    generationResolved: readonly string[];
    factory: string;
    optionsStruct: string;
    features: readonly Feature[];
}

const shadowGeneratorFactories: Readonly<
    Record<string, ShadowGeneratorFactory>
> = {
    createPcfSpotlightShadowGenerator: {
        kind: "pcf-spot",
        lightKind: "spot",
        article: "A PCF spotlight shadow generator",
        options: spotOptions,
        emitted: spotOptions,
        // `far` resolves against the light's own range, which a scene-code
        // spot leaves at MAX_VALUE.
        defaults: {
            mapSize: "bbl::upstream::pcf_spot_default_map_size",
            bias: "bbl::upstream::pcf_spot_default_bias",
            darkness: "bbl::upstream::pcf_spot_default_darkness",
            near: "bbl::upstream::pcf_spot_default_near",
            far: "bbl::upstream::pcf_spot_unbounded_far",
        },
        generationResolved: ["mapSize"],
        factory: "bbl::create_pcf_spotlight_shadow_generator",
        optionsStruct: "bbl::PcfSpotShadowOptions",
        features: ["shadow:pcf"],
    },
    createPcfDirectionalShadowGenerator: {
        kind: "pcf-directional",
        lightKind: "directional",
        article: "A PCF directional shadow generator",
        options: pcfDirectionalOptions,
        emitted: pcfDirectionalOptions,
        defaults: {
            mapSize: "bbl::upstream::pcf_directional_default_map_size",
            bias: "bbl::upstream::pcf_directional_default_bias",
            darkness: "bbl::upstream::pcf_directional_default_darkness",
            orthoMinZ: "bbl::upstream::pcf_directional_default_ortho_min_z",
            orthoMaxZ: "bbl::upstream::pcf_directional_default_ortho_max_z",
        },
        generationResolved: ["mapSize"],
        factory: "bbl::create_pcf_directional_shadow_generator",
        optionsStruct: "bbl::PcfDirectionalShadowOptions",
        // Both: the resources, the receiver arm and the caster pass are the
        // PCF family's, and the second names which factory to emit.
        features: ["shadow:pcf", "shadow:pcf-directional"],
    },
    createCsmDirectionalShadowGenerator: {
        // Its own kind, because its own `_shadowType: "csm"` is what sends
        // both receiver families down the cascaded arm -- and because the
        // resource it binds is a `texture_depth_2d_array`, not the 2D map
        // the two PCF families share.
        kind: "csm-directional",
        lightKind: "directional",
        article: "A CSM directional shadow generator",
        options: csmDirectionalOptions,
        emitted: csmDirectionalOptions,
        defaults: {
            mapSize: "bbl::upstream::csm_default_map_size",
            numCascades: "bbl::upstream::csm_default_num_cascades",
            lambda: "bbl::upstream::csm_default_lambda",
            cascadeBlendPercentage:
                "bbl::upstream::csm_default_cascade_blend_percentage",
            // `cfg._shadowMaxZ ?? null`, which `_computeCsmCascades` then
            // resolves against the CAMERA's far plane -- a value generation
            // cannot see, so the absence itself is what is carried.
            shadowMaxZ: "std::optional<double>{}",
            bias: "bbl::upstream::csm_default_bias",
            darkness: "bbl::upstream::csm_default_darkness",
            frustumEdgeFalloff:
                "bbl::upstream::csm_default_frustum_edge_falloff",
            // The pin's `cfg.forceRefreshEveryFrame ?? false`, whose shape
            // the shadow lowerer asserts against the factory.
            forceRefreshEveryFrame: "false",
        },
        // The two that size the layered map: its extent and its layer count.
        generationResolved: ["mapSize", "numCascades"],
        factory: "bbl::create_csm_directional_shadow_generator",
        optionsStruct: "bbl::CsmDirectionalShadowOptions",
        features: ["shadow:pcf", "shadow:csm"],
    },
    createEsmDirectionalShadowGenerator: {
        kind: "esm-directional",
        lightKind: "directional",
        article: "An ESM directional shadow generator",
        options: esmDirectionalOptions,
        emitted: esmDirectionalEmitted,
        defaults: {
            mapSize: "bbl::upstream::esm_default_map_size",
            depthScale: "bbl::upstream::esm_default_depth_scale",
            bias: "bbl::upstream::esm_default_bias",
            blurKernel: "bbl::upstream::esm_default_blur_kernel",
            blurScale: "bbl::upstream::esm_default_blur_scale",
            darkness: "bbl::upstream::esm_default_darkness",
            frustumEdgeFalloff:
                "bbl::upstream::esm_default_frustum_edge_falloff",
            orthoMinZ: "bbl::upstream::esm_default_ortho_min_z",
            orthoMaxZ: "bbl::upstream::esm_default_ortho_max_z",
            // The pin's `cfg.forceRefreshEveryFrame ?? false`, whose shape
            // the shadow lowerer asserts against the factory.
            forceRefreshEveryFrame: "false",
        },
        // These three decide the blur shader's own text and the four
        // textures' extents.
        generationResolved: ["mapSize", "blurKernel", "blurScale"],
        factory: "bbl::create_esm_directional_shadow_generator",
        optionsStruct: "bbl::EsmDirectionalShadowOptions",
        features: ["shadow:esm"],
    },
};

/** One pinned generator factory call, against its own row above. */
function compileShadowGeneratorFactory(
    context: ShadowIntrinsicContext,
    call: ts.CallExpression,
    spec: ShadowGeneratorFactory,
): Value {
    context.expectArgumentCount(call, 2, 3);
    const engine = context.compileValue(call.arguments[0]!);
    context.expectKind(engine, "engine", call.arguments[0]!);
    const light = context.compileValue(call.arguments[1]!);
    context.expectKind(light, "light", call.arguments[1]!);
    if (light.lightKind !== spec.lightKind) {
        context.fail(
            call.arguments[1]!,
            `${spec.article} takes a ${spec.lightKind} light, received a ` +
                `${light.lightKind ?? "unknown"} light.`,
        );
    }
    // Each option's pinned default, in the order the emitted options struct
    // takes them. An option the scene omits keeps the folded constant, which
    // is the factory's own `??` value read out of the pin.
    const resolved: Record<string, string> = { ...spec.defaults };
    // What the ESM family's own resources are sized by. Filled only for the
    // options that resolve here, so an option the scene omits stays omitted
    // and the pinned factory applies its own default when generation runs
    // it -- restating one here would be a second copy of a pinned default.
    const sizes: Record<string, number> = {};
    if (call.arguments[2]) {
        const options = context.expectObjectLiteral(call.arguments[2]);
        validateObjectProperties(
            context,
            options,
            spec.options,
            `${spec.article} options`,
        );
        for (const name of spec.options) {
            const expression = context.objectProperty(options, name);
            if (!expression) continue;
            if (name === "forceRefreshEveryFrame") {
                const value = context.compileValue(expression);
                context.expectKind(value, "boolean", expression);
                const fixed =
                    value.staticBoolean ??
                    (value.cpp === "true"
                        ? true
                        : value.cpp === "false"
                          ? false
                          : undefined);
                if (fixed === undefined) {
                    context.fail(
                        expression,
                        "forceRefreshEveryFrame must be generation-known.",
                    );
                }
                // Into the record: the flag disables the pinned render
                // gate, so the map re-renders every frame the way
                // `renderEsmShadowMap` / `renderCsmShadowMap` would.
                resolved[name] = fixed ? "true" : "false";
                continue;
            }
            if (spec.generationResolved.includes(name)) {
                const literal = compilePositiveInteger(context, expression);
                resolved[name] = literal;
                sizes[name] = Number.parseInt(literal, 10);
                continue;
            }
            const number = context.compileNumber(expression, "double");
            // A row whose pinned DEFAULT is an optional carries an absence,
            // so a value the scene does pass is wrapped to match it rather
            // than named here: `shadowMaxZ`'s default is `null`, and the
            // split formula resolves an absent one against the camera's
            // own far plane rather than a sentinel generation would pick.
            resolved[name] =
                spec.defaults[name]?.startsWith("std::optional<") === true
                    ? `std::optional<double>{${number}}`
                    : number;
        }
    }
    if (spec.kind === "esm-directional") {
        // The row this generator's recorded resources sit at, which is
        // generation's answer rather than an option the scene passes.
        resolved["esmIndex"] = `${context.esmGeneratorOrdinal()}u`;
    }
    const index = context.recordShadowGenerator({
        kind: spec.kind,
        // The generator may precede addToScene, but an unresolved slot must
        // never alias the valid first light. addSceneLight patches this
        // sentinel before composition or manifest finalization.
        lightIndex: light.lightIdentity?.sceneLightIndex ?? -1,
        ...(spec.kind === "esm-directional" ? { esm: sizes } : {}),
    });
    for (const feature of spec.features) {
        context.reachFeature(feature, call);
    }
    return {
        kind: "shadow-generator",
        cpp:
            `${spec.factory}(${engine.cpp}, ${light.cpp}, ` +
            `${spec.optionsStruct}{` +
            `${spec.emitted.map((name) => resolved[name]).join(", ")}})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
        shadowGeneratorIndex: index,
    };
}

export function compileShadowIntrinsic(
    context: ShadowIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createPcfSpotlightShadowGenerator":
        case "createPcfDirectionalShadowGenerator":
        case "createCsmDirectionalShadowGenerator":
        case "createEsmDirectionalShadowGenerator":
            return compileShadowGeneratorFactory(
                context,
                call,
                shadowGeneratorFactories[importedName]!,
            );

        // The pin keeps the caster list as a lazy task input rather than on
        // the generator, so this is a registration and not a property write;
        // what it decides here is which materials compose a no-colour view.
        case "setShadowTaskCasterMeshes": {
            context.expectArgumentCount(call, 2, 2);
            const generator = context.compileValue(call.arguments[0]!);
            context.expectKind(
                generator,
                "shadow-generator",
                call.arguments[0]!,
            );
            if (generator.shadowGeneratorIndex === undefined) {
                context.fail(
                    call.arguments[0]!,
                    "This shadow generator was not created in this scene.",
                );
            }
            // An array literal at the call site, or a local the scene grew
            // with `push` inside a loop generation unrolls -- which is how
            // scene 207 writes it. One reader answers for both.
            const listNode = call.arguments[1]!;
            const entries =
                context.handleCollections.staticHandleList(listNode);
            if (!entries) {
                const list = context.compileValue(listNode);
                if (
                    list.kind !== "data" ||
                    list.dataType?.kind !== "vector" ||
                    list.dataType.element.kind !== "handle" ||
                    list.dataType.element.handle !== "mesh"
                ) {
                    context.fail(
                        listNode,
                        "A shadow generator's caster list must be an array of meshes.",
                    );
                }
                // A runtime list selects from the generator's dynamically
                // composed caster-view universe. The first registration may
                // itself be runtime-built (Break Meshes fills allPieces in a
                // native loop), and later registrations filter that list.
                context.recordDynamicShadowCasters(
                    generator.shadowGeneratorIndex,
                );
                context.reachFeature("material:no-color-view", call);
                return {
                    kind: "void",
                    cpp:
                        `bbl::set_shadow_task_caster_meshes(` +
                        `${context.requireEngine(generator, call)}, ` +
                        `${generator.cpp}, bbl::js::array_to_vector(${list.cpp}))`,
                };
            }
            const emitted: string[] = [];
            const casters: ShadowCasterMeshManifest[] = [];
            let hasDynamicCaster = false;
            for (const { value: mesh, node } of entries) {
                context.expectKind(mesh, "mesh", node);
                if (mesh.sceneMeshIndex === undefined) {
                    hasDynamicCaster = true;
                } else {
                    casters.push({ meshIndex: mesh.sceneMeshIndex });
                }
                emitted.push(mesh.cpp);
                // Only WHICH mesh casts. Which material it carries is read
                // at the manifest, from what the mesh finally holds --
                // upstream resolves `mesh.material` lazily when the pass
                // builds, and a scene naming its casters before assigning
                // their materials (scene 65) would otherwise record none.
            }
            if (emitted.length === 0) {
                context.fail(
                    call.arguments[1]!,
                    "A shadow generator with no casters renders an empty " +
                        "map; no reached scene registers one.",
                );
            }
            context.recordShadowCasters(
                generator.shadowGeneratorIndex,
                casters,
            );
            if (hasDynamicCaster) {
                context.recordDynamicShadowCasters(
                    generator.shadowGeneratorIndex,
                );
            }
            // The caster pass draws each mesh through its material's own
            // no-colour view, which is the same composition arm scene 116
            // reaches from scene code.
            context.reachFeature("material:no-color-view", call);
            const storedList = context.compileValue(listNode);
            const casterListCpp =
                storedList.kind === "data" &&
                storedList.dataType?.kind === "vector" &&
                storedList.dataType.element.kind === "handle" &&
                storedList.dataType.element.handle === "mesh"
                    ? `bbl::js::array_to_vector(${storedList.cpp})`
                    : `{${emitted.join(", ")}}`;
            return {
                kind: "void",
                cpp:
                    `bbl::set_shadow_task_caster_meshes(` +
                    `${context.requireEngine(generator, call)}, ` +
                    `${generator.cpp}, ${casterListCpp})`,
            };
        }

        // `registerSceneWithShadowSupport` is `registerScene` plus the
        // scene-owned `ShadowTask`, unshifted ahead of the render task the
        // scene already carries. Upstream splits the two entry points so an
        // ordinary bundle retains no shadow scheduling code, and the split
        // survives here as a different generated call.
        case "registerSceneWithShadowSupport": {
            context.expectArgumentCount(call, 1, 1);
            const scene = context.compileValue(call.arguments[0]!);
            context.expectKind(scene, "scene", call.arguments[0]!);
            context.reachFeature("shadow:task", call);
            context.reachFeature("frame-graph:resources", call);
            // The pin's shadow task is a frame-graph task unshifted ahead of
            // the scene's own render task, so a scene that reaches one has a
            // frame graph -- the same thing `addTask` says by materializing
            // the default render task before adding to it.
            const defaultTask = context.ensureDefaultRenderTask(scene, call);
            const registerCall =
                `bbl::register_scene_with_shadow_support(${scene.cpp})`;
            return {
                kind: "void",
                cpp: defaultTask
                    ? `${defaultTask};
        ${registerCall}`
                    : registerCall,
            };
        }

        default:
            return undefined;
    }
}
