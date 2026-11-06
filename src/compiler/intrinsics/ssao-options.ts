// `createSsaoTask` and its public enablers.
//
// The task's textures and camera compile as handles; every setting is
// resolved statically and forwarded whole to the pin's own factory, which
// composition runs (`pinned-ssao.ts`), so a default the pin changes is the
// pin's answer. The enablers record what composition has to build for and
// emit the native call that installs the same state at run time.
import ts from "typescript";
import { EmissionSet } from "../emission-transaction.js";
import { argumentAt } from "../syntax.js";
import type {
    GeometryTextureTypeName,
    PostProcessOptionValue,
    SsaoTaskManifest,
    Value,
} from "../types.js";
import {
    compileOptionalStaticBoolean,
    staticNumberValue,
} from "../option-helpers.js";
import { SSAO_MODULE, ssaoPbrPluginManifest } from "../../pinned-ssao.js";
import { isPbrMaterialValue } from "../values/model.js";
import { compileRenderTextureValue } from "./engine-options.js";
import type { EngineIntrinsicContext } from "./engine.js";
import type { LoweringServices } from "../lowering-services.js";
import { compileDescriptorOptions } from "./post-process-options.js";

/** The config members the task reads as handles, or compiles itself. */
const HANDLE_OPTIONS = new EmissionSet([
    "name",
    "depthTexture",
    "normalTexture",
    "camera",
    "temporal",
]);

/** The intrinsics this module compiles. */
export function isSsaoIntrinsic(name: string): boolean {
    return (
        name === "createSsaoTask" ||
        name === "resetSsaoTemporal" ||
        name === "enableSsaoHalfResolution" ||
        name === "enablePbrSsao" ||
        name === "enableSsaoMotionPruning"
    );
}

/** What `config.temporal` compiles to beyond the options composition forwards. */
interface CompiledTemporal {
    options: Record<string, PostProcessOptionValue>;
    /** `velocityTexture` as the factory's argument, with what composition reads of it. */
    velocity?: {
        cpp: string;
        attachment: GeometryTextureTypeName;
        previousDepth: boolean;
    };
    /** A `historySamples` only run time knows, as the factory's argument. */
    historySamples?: string;
}

/** `config.temporal`: a boolean, or the reconstruction options this port carries. */
function compileTemporal(
    context: EngineIntrinsicContext,
    object: ts.ObjectLiteralExpression,
): CompiledTemporal {
    const expression = context.objectProperty(object, "temporal");
    if (!expression) return { options: {} };
    const unwrapped = context.unwrap(expression);
    if (!ts.isObjectLiteralExpression(unwrapped)) {
        return {
            options: {
                temporal: compileOptionalStaticBoolean(
                    context,
                    expression,
                    true,
                    "createSsaoTask temporal",
                ),
            },
        };
    }
    const compiled: CompiledTemporal = { options: {} };
    const options = compiled.options;
    let velocity:
        { cpp: string; attachment: GeometryTextureTypeName } | undefined;
    let previousDepth = false;
    for (const property of unwrapped.properties) {
        const key = ts.isPropertyAssignment(property)
            ? context.propertyName(property.name)
            : undefined;
        if (!key || !ts.isPropertyAssignment(property)) {
            return context.fail(
                property,
                "createSsaoTask temporal options must be named properties.",
            );
        }
        if (key === "enabled") {
            options["temporal.enabled"] = compileOptionalStaticBoolean(
                context,
                property.initializer,
                true,
                "createSsaoTask temporal.enabled",
            );
        } else if (key === "historySamples") {
            // The limit selects no pass: one only run time knows is the
            // factory's argument, validated there as the pin validates it.
            const known = staticNumberValue(context, property.initializer);
            if (known !== undefined) options["temporal.historySamples"] = known;
            else
                compiled.historySamples = context.compileNumber(
                    property.initializer,
                    "double",
                );
        } else if (key === "velocityTexture") {
            const value = context.compileValue(property.initializer);
            if (!value.geometryAttachment) {
                return context.fail(
                    property.initializer,
                    "createSsaoTask temporal.velocityTexture must be a geometry renderer task's attachment.",
                );
            }
            velocity = {
                cpp: compileRenderTextureValue(
                    context,
                    property.initializer,
                    value,
                    "createSsaoTask temporal.velocityTexture",
                    { sampling: "color", sources: ["geometry"] },
                ),
                attachment: value.geometryAttachment,
            };
        } else if (key === "velocityHasPreviousDepth") {
            previousDepth = compileOptionalStaticBoolean(
                context,
                property.initializer,
                false,
                "createSsaoTask temporal.velocityHasPreviousDepth",
            );
        } else {
            return context.fail(
                property,
                `createSsaoTask temporal.${key} is not a reconstruction option the pin declares.`,
            );
        }
    }
    if (velocity) compiled.velocity = { ...velocity, previousDepth };
    else if (previousDepth) {
        // The pin's own refusal: previous depth names the velocity's Z.
        options["temporal.velocityHasPreviousDepth"] = true;
    }
    return compiled;
}

/** What compiling an SSAO normal input reads: values, the condition, refusals. */
export interface SsaoNormalInputContext extends Pick<
    LoweringServices,
    "unwrap" | "compileValue" | "conditions" | "fail"
> {}

/**
 * An SSAO normal input (`config.normalTexture`, a `normalTexture` write): a
 * geometry attachment, or a choice only run time makes between one and none
 * (`checked ? normals : undefined`), which the plan composes both ways.
 */
export function compileNormalInput(
    context: SsaoNormalInputContext,
    expression: ts.Expression,
    what: string,
): { cpp: string; attachment: GeometryTextureTypeName; known: boolean } {
    const unwrapped = context.unwrap(expression);
    const absent = (node: ts.Expression): boolean => {
        const inner = context.unwrap(node);
        return (
            inner.kind === ts.SyntaxKind.NullKeyword ||
            (ts.isIdentifier(inner) && inner.text === "undefined") ||
            ts.isVoidExpression(inner)
        );
    };
    const attachment = (node: ts.Expression) => {
        const value = context.compileValue(node);
        if (!value.geometryAttachment) {
            return context.fail(
                node,
                `${what} must be a geometry renderer task's attachment.`,
            );
        }
        return {
            cpp: compileRenderTextureValue(context, node, value, what, {
                sampling: "color",
                sources: ["geometry"],
            }),
            attachment: value.geometryAttachment,
        };
    };
    if (
        ts.isConditionalExpression(unwrapped) &&
        absent(unwrapped.whenTrue) !== absent(unwrapped.whenFalse)
    ) {
        const condition = context.conditions.compileCondition(
            unwrapped.condition,
        );
        const present = absent(unwrapped.whenTrue)
            ? unwrapped.whenFalse
            : unwrapped.whenTrue;
        const input = attachment(present);
        const some = `std::optional<bbl::RenderTextureRef>{${input.cpp}}`;
        return {
            cpp: absent(unwrapped.whenTrue)
                ? `((${condition}) ? std::optional<bbl::RenderTextureRef>{} : ${some})`
                : `((${condition}) ? ${some} : std::optional<bbl::RenderTextureRef>{})`,
            attachment: input.attachment,
            known: false,
        };
    }
    const input = attachment(expression);
    return { cpp: input.cpp, attachment: input.attachment, known: true };
}

/** The SSAO task a value names, refusing any other. */
function ssaoTaskOf(
    context: EngineIntrinsicContext,
    value: Value,
    site: ts.Node,
    what: string,
): SsaoTaskManifest {
    if (value.kind !== "task" || !value.ssaoTask) {
        return context.fail(site, `${what} requires a createSsaoTask task.`);
    }
    return value.ssaoTask;
}

export function compileSsaoIntrinsic(
    context: EngineIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
    taskEngine: () => Value,
): Value {
    switch (importedName) {
        case "createSsaoTask":
            return compileCreateSsaoTask(context, call, taskEngine());
        case "enableSsaoHalfResolution": {
            context.expectArgumentCount(call, 1, 1);
            const task = context.compileValue(argumentAt(call, 0));
            const manifest = ssaoTaskOf(
                context,
                task,
                call,
                "enableSsaoHalfResolution",
            );
            context.sceneManifest.recordSsaoEnabler("half", manifest);
            const engine = context.requireEngine(task, call);
            return {
                kind: "ssao-half-resolution",
                cpp: `bbl::enable_ssao_half_resolution(${engine}, ${task.cpp})`,
                ssaoTask: manifest,
                engineCpp: engine,
            };
        }
        case "resetSsaoTemporal": {
            context.expectArgumentCount(call, 1, 1);
            const settings = context.compileValue(argumentAt(call, 0));
            if (settings.kind !== "ssao-temporal" || !settings.ssaoTask) {
                return context.fail(
                    call,
                    "resetSsaoTemporal requires a createSsaoTask task's temporal settings.",
                );
            }
            return {
                kind: "void",
                cpp: `bbl::upstream::reset_ssao_temporal(bbl::ssao_temporal_settings(${context.requireEngine(settings, call)}, ${settings.cpp}))`,
            };
        }
        case "enablePbrSsao":
            return compileEnablePbrSsao(context, call);
        case "enableSsaoMotionPruning": {
            context.expectArgumentCount(call, 1, 1);
            const task = context.compileValue(argumentAt(call, 0));
            const manifest = ssaoTaskOf(
                context,
                task,
                call,
                "enableSsaoMotionPruning",
            );
            context.sceneManifest.recordSsaoEnabler("motion-pruning", manifest);
            const engine = context.requireEngine(task, call);
            return {
                kind: "ssao-motion-pruning",
                cpp: `bbl::enable_ssao_motion_pruning(${engine}, ${task.cpp})`,
                ssaoTask: manifest,
                engineCpp: engine,
            };
        }
    }
    return context.fail(call, `'${importedName}' is not an SSAO entry point.`);
}

/**
 * `enablePbrSsao(scene, task, materials?)`: the pin appends its plugin
 * (`ssaoPbrPluginManifest`) to the selected PBR source materials before the
 * scene registers, which is the `plugins = [...plugins, plugin]` growth the
 * composition already composes every reachable state of. The selection is
 * the list given, or the scene's meshes' materials at the call, which the
 * native call walks; composition then covers every PBR material the program
 * made so far and every asset's.
 */
function compileEnablePbrSsao(
    context: EngineIntrinsicContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 2, 3);
    const scene = context.compileValue(argumentAt(call, 0));
    context.expectKind(scene, "scene", argumentAt(call, 0));
    const task = context.compileValue(argumentAt(call, 1));
    const manifest = ssaoTaskOf(context, task, call, "enablePbrSsao");
    context.expectSameEngine(scene, task, call);
    const plugin = ssaoPbrPluginManifest();
    const [binding, ...others] = plugin.samplers ?? [];
    if (!binding || others.length > 0) {
        return context.fail(
            call,
            "The pinned PBR SSAO plugin no longer samples exactly one texture.",
        );
    }
    const id = context.sceneManifest.pbrPluginId(plugin);
    const listExpression = call.arguments[2];
    let materials = "std::nullopt";
    if (listExpression) {
        const list = context.unwrap(listExpression);
        if (!ts.isArrayLiteralExpression(list)) {
            return context.fail(
                listExpression,
                "enablePbrSsao materials must be an array literal of PBR materials.",
            );
        }
        const handles = list.elements.map((element) => {
            if (ts.isSpreadElement(element)) {
                return context.fail(
                    element,
                    "enablePbrSsao materials must list each PBR material.",
                );
            }
            const material = context.compileValue(element);
            context.expectKind(material, "material", element);
            if (!isPbrMaterialValue(material)) {
                return context.fail(
                    element,
                    "enablePbrSsao accepts only PBR source materials.",
                );
            }
            context.sceneManifest.recordPbrStateWrite(material, {
                pluginAppend: id,
            });
            return material.cpp;
        });
        materials = `std::vector<bbl::MaterialHandle>{${handles.join(", ")}}`;
    } else {
        context.sceneManifest.scenePbrMaterials.forEach((material, index) => {
            if (!material.noColorView && !material.esmShadowView) {
                context.sceneManifest.recordPbrStateWrite(
                    { scenePbrMaterialIndex: index },
                    { pluginAppend: id },
                );
            }
        });
        context.sceneManifest.recordPbrStateWrite({}, { pluginAppend: id });
    }
    context.sceneManifest.recordSsaoEnabler("pbr", manifest);
    context.reachFeature("material:pbr", call);
    // The pin's enabler calls `enableMaterialPlugins(scene)` itself.
    context.reachFeature("material:plugins", call);
    context.reachFeature("material:plugin-index", call);
    context.reachFeature("material:plugin-textures", call);
    const engine = context.requireEngine(task, call);
    return {
        kind: "promise",
        cpp:
            `bbl::enable_pbr_ssao(${engine}, ${scene.cpp}, ${task.cpp}, ${materials}, ` +
            `${context.cppString(binding.texture)}, ${context.cppString(binding.sampler)}, ` +
            `[](std::uint8_t signature) { return bblscene::pbr_plugin_signature_append(signature, ${id}u); })`,
        promiseType: "bbl::js::PromiseVoid",
        promiseResult: { kind: "void", cpp: "" },
    };
}

function compileCreateSsaoTask(
    context: EngineIntrinsicContext,
    call: ts.CallExpression,
    engine: Value,
): Value {
    context.reachFeature("renderer:ssao", call);
    const object = context.expectObjectLiteral(argumentAt(call, 0));
    const nameExpression = context.objectProperty(object, "name");
    const name = nameExpression
        ? context.compileStringLiteral(nameExpression)
        : undefined;
    const depthExpression = context.objectProperty(object, "depthTexture");
    if (!depthExpression)
        return context.fail(object, "createSsaoTask requires a depthTexture.");
    const depthValue = context.compileValue(depthExpression);
    if (depthValue.kind === "render-target") {
        return context.fail(
            depthExpression,
            "createSsaoTask depthTexture as a scene render target is not lowered; " +
                "pass a geometry renderer task's geometryDepthTexture.",
        );
    }
    const depth = compileRenderTextureValue(
        context,
        depthExpression,
        depthValue,
        "createSsaoTask depthTexture",
        {
            sources: ["geometry-depth"],
        },
    );
    const normalExpression = context.objectProperty(object, "normalTexture");
    let normalCpp = "std::nullopt";
    let normalAttachment: SsaoTaskManifest["normalAttachment"];
    let normalKnown = true;
    if (normalExpression) {
        const normal = compileNormalInput(
            context,
            normalExpression,
            "createSsaoTask normalTexture",
        );
        normalCpp = normal.cpp;
        normalAttachment = normal.attachment;
        normalKnown = normal.known;
    }
    const cameraExpression = context.objectProperty(object, "camera");
    if (!cameraExpression)
        return context.fail(object, "createSsaoTask requires a camera.");
    const camera = context.compileValue(cameraExpression);
    context.expectKind(camera, "camera", cameraExpression);
    const temporal = compileTemporal(context, object);
    const options = {
        ...compileDescriptorOptions(
            context,
            object,
            { module: SSAO_MODULE, factory: "createSsaoTask" },
            HANDLE_OPTIONS,
        ),
        ...temporal.options,
    };
    if (options.normalSpace !== undefined && options.normalSpace !== "view") {
        context.fail(
            object,
            "createSsaoTask normalSpace 'world' is not lowered; supply view-space normals.",
        );
    }
    const manifest: SsaoTaskManifest = {
        taskIndex: context.sceneManifest.ssaoTasks.length,
        ...(name !== undefined ? { name } : {}),
        options,
        ...(normalAttachment !== undefined ? { normalAttachment } : {}),
        initialNormal: normalAttachment !== undefined,
        ...(temporal.velocity
            ? {
                  velocity: {
                      attachment: temporal.velocity.attachment,
                      previousDepth: temporal.velocity.previousDepth,
                  },
              }
            : {}),
        halfResolution: false,
        pbr: false,
        motionPruning: false,
        live: [],
    };
    context.sceneManifest.recordSsaoTask(manifest);
    if (!normalKnown)
        context.sceneManifest.recordSsaoLiveSetting("normal", manifest);
    const velocityCpp = temporal.velocity?.cpp ?? "std::nullopt";
    const historyCpp = temporal.historySamples ?? "std::nullopt";
    return {
        kind: "task",
        cpp: `bbl::upstream::create_ssao_task_${manifest.taskIndex}(${engine.cpp}, ${depth}, ${normalCpp}, ${camera.cpp}, ${velocityCpp}, ${historyCpp})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
        ssaoTask: manifest,
    };
}
