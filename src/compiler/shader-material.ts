import { EmissionSet, EmissionMap } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
// Shader-material lowering: variant matching and uniform resolution.
//
// A createShaderMaterial call either matches a predeclared program --
// proven by lowering both sides through the typed WGSL IR and
// comparing the IR, never the source text -- or registers the scene's
// own WGSL as a scene-local variant. Reached programs are recorded in
// reach order, which is the generated variant table's index order, and
// the uniform setters resolve their offsets from the reflected layout
// of the reached program.
import ts from "typescript";
import { cppIdentifierPattern } from "../cpp-literals.js";
import { sharedPinnedContext } from "../lowering/context.js";
import { nativeBlendFactor } from "../lowering/pinned-blend-table.js";
import {
    pinnedErrorCode,
    pinnedErrorMessageCpp,
} from "../lowering/pinned-error.js";
import {
    isShaderSystemMatrix,
    lowerWgslShaderProgram,
    shaderSystemMatrices,
} from "../shader-ir.js";
import {
    shaderSamplerDeclarations,
    shaderSamplerName,
    shaderUniformValueLayout,
    typeComponents,
} from "../shader-material-programs.js";
import {
    compileOptionalStaticBoolean,
    type StaticBooleanContext,
    validateObjectProperties,
    type ObjectValidationContext,
} from "./option-helpers.js";
import type {
    CompiledShaderBlend,
    CompiledShaderDefine,
    CompiledShaderProgram,
    CompiledShaderSampler,
    CompiledShaderStorageBuffer,
    CompiledShaderUniformDefault,
    SceneMeshManifest,
    Value,
} from "./types.js";
import { isTypedArrayType, tupleComponents } from "./data-types.js";

/**
 * What `createShaderMaterial` accepts as a WGSL identifier
 * (`assertIdentifier` in `src/material/shader/shader-material.ts`). It is
 * the rule behind both the sampler and the define refusal, so it is stated
 * once. WGSL identifiers share the C++ spelling, so the pattern itself
 * is the shared export.
 */
const WGSL_IDENTIFIER = cppIdentifierPattern;

/** Per-stage resource limits for native shader materials. */
const MAX_SHADER_SAMPLERS = 16;
const MAX_SHADER_STORAGE_BUFFERS = 8;

export interface ShaderMaterialContext
    extends
        ObjectValidationContext,
        StaticBooleanContext,
        Pick<
            LoweringServices,
            | "sceneManifest"
            | "expectObjectLiteral"
            | "expectStaticArrayLiteral"
            | "expectStaticArrayElements"
            | "resolveStaticLiteral"
            | "objectProperty"
            | "compileValue"
            | "compileNumber"
            | "compileStaticString"
            | "castNumber"
            | "compileShaderSource"
            | "compileStringLiteral"
            | "bindings"
            | "symbols"
            | "dataLowerer"
            | "emit"
            | "fail"
        > {}

/** The pin defaults nullish declaration lists/maps before iterating them. */
function absentShaderOption(
    context: ShaderMaterialContext,
    expression: ts.Expression | undefined,
): boolean {
    if (!expression) return true;
    const resolved = context.resolveStaticLiteral(expression);
    return (
        context.symbols.isNullishLiteral(resolved) ||
        (ts.isIdentifier(resolved) &&
            context.bindings.lookupOptional(resolved)?.kind === "json-null")
    );
}

export function compileShaderMaterialOptions(
    context: ShaderMaterialContext,
    expression: ts.Expression,
): {
    name: string;
    id: number;
    /** `transmissive`: the renderable that triggers a transmission grab. */
    transmissive: boolean;
    dynamicUniforms?: Array<{
        offset: number;
        components: string[];
    }>;
} {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        [
            "name",
            "vertexSource",
            "fragmentSource",
            "attributes",
            "uniforms",
            "samplers",
            "externalTextures",
            "storageBuffers",
            "defines",
            "needAlphaBlending",
            "blendMode",
            "blend",
            "needAlphaTesting",
            "backFaceCulling",
            "depthWrite",
            "depthCompare",
            "depthOnlyFragment",
            "depthBias",
            "depthBiasSlopeScale",
            "transmissive",
            "useThinInstanceColors",
        ],
        "Reached shader materials support source, attributes, uniforms, samplers, external textures, storage buffers, defines, alpha state and blend settings, culling, depthWrite, depthCompare, depthOnlyFragment, depthBias, depthBiasSlopeScale, transmissive and useThinInstanceColors only.",
    );

    const vertexExpression = context.objectProperty(object, "vertexSource");
    const fragmentExpression = context.objectProperty(object, "fragmentSource");
    const attributesExpression = context.objectProperty(object, "attributes");
    // The pin reads `options.uniforms ?? []`, so an absent list declares
    // none; a refusal about the list then points at the options object.
    const uniformsExpression = context.objectProperty(object, "uniforms");
    const uniformsNode = uniformsExpression ?? object;
    if (!vertexExpression || !fragmentExpression || !attributesExpression) {
        context.fail(
            object,
            "Shader material requires vertexSource, fragmentSource, and attributes.",
        );
    }

    const compiledVertex = context.compileShaderSource(vertexExpression);
    const compiledFragment = context.compileShaderSource(fragmentExpression);
    const vertexSource = compiledVertex.source;
    const fragmentSource = compiledFragment.source;
    const attributes = compileStaticStringArray(context, attributesExpression);
    const {
        signatures: declaredUniforms,
        defaults: uniformDefaults,
        dynamicDefaults,
    } = uniformsExpression && !absentShaderOption(context, uniformsExpression)
        ? compileShaderUniformSignatures(context, uniformsExpression)
        : { signatures: [], defaults: [], dynamicDefaults: [] };
    const dynamicSourceUniforms = [
        ...compiledVertex.dynamicUniforms,
        ...compiledFragment.dynamicUniforms,
    ];
    const uniforms = [
        ...declaredUniforms,
        ...dynamicSourceUniforms.map(({ name, type }) => `${name}:${type}`),
    ];
    const dynamicInitializers = [...dynamicSourceUniforms, ...dynamicDefaults];
    // `createShaderMaterial` asserts one namespace across the uniform,
    // sampler and define names it generates, so the set is built once here
    // and each normalizer adds its own to it.
    const generatedNames = new EmissionSet(
        uniforms.map((signature) => {
            const separator = signature.indexOf(":");
            return separator < 1 ? signature : signature.slice(0, separator);
        }),
    );
    const samplerDeclarations = compileShaderSamplers(
        context,
        context.objectProperty(object, "samplers"),
        generatedNames,
    );
    const samplers = samplerDeclarations.map(({ name }) => name);
    const externalTextures = compileShaderExternalTextures(
        context,
        context.objectProperty(object, "externalTextures"),
        generatedNames,
        samplers.length,
    );
    const storageBuffers = compileShaderStorageBuffers(
        context,
        context.objectProperty(object, "storageBuffers"),
        generatedNames,
    );
    const defines = compileShaderDefines(
        context,
        context.objectProperty(object, "defines"),
        generatedNames,
    );
    const blendExpression = context.objectProperty(object, "blend");
    const blend = blendExpression
        ? compileShaderBlend(context, blendExpression)
        : undefined;
    const needAlphaBlending = compileOptionalStaticBoolean(
        context,
        context.objectProperty(object, "needAlphaBlending"),
        blend !== undefined,
    );
    const blendModeExpression = context.objectProperty(object, "blendMode");
    const blendMode = blendModeExpression
        ? context.compileStaticString(blendModeExpression)
        : "alpha";
    if (blendMode !== "alpha" && blendMode !== "additive") {
        context.fail(
            blendModeExpression ?? object,
            `Shader material blendMode must be 'alpha' or 'additive', received '${blendMode}'.`,
        );
    }
    const needAlphaTesting = compileOptionalStaticBoolean(
        context,
        context.objectProperty(object, "needAlphaTesting"),
        false,
    );
    const backFaceCulling = compileOptionalStaticBoolean(
        context,
        context.objectProperty(object, "backFaceCulling"),
        true,
    );
    const depthWrite = compileOptionalStaticBoolean(
        context,
        context.objectProperty(object, "depthWrite"),
        !needAlphaBlending,
    );
    const depthOnlyFragmentExpression = context.objectProperty(
        object,
        "depthOnlyFragment",
    );
    const depthOnlyFragment = compileOptionalStaticBoolean(
        context,
        depthOnlyFragmentExpression,
        false,
        "Shader depthOnlyFragment",
    );
    const useThinInstanceColorsExpression = context.objectProperty(
        object,
        "useThinInstanceColors",
    );
    const thinInstanceColorOption = useThinInstanceColorsExpression
        ? compileOptionalStaticBoolean(
              context,
              useThinInstanceColorsExpression,
              false,
          )
        : undefined;
    const depthCompareExpression = context.objectProperty(
        object,
        "depthCompare",
    );
    const depthCompare = depthCompareExpression
        ? context.compileStringLiteral(depthCompareExpression)
        : undefined;
    if (
        depthCompare !== undefined &&
        ![
            "never",
            "less",
            "equal",
            "less-equal",
            "greater",
            "not-equal",
            "greater-equal",
            "always",
        ].includes(depthCompare)
    )
        context.fail(
            depthCompareExpression!,
            `Unsupported shader depthCompare '${depthCompare}'.`,
        );
    const depthBiasOptions: {
        depthBias?: number;
        depthBiasSlopeScale?: number;
    } = {};
    for (const option of ["depthBias", "depthBiasSlopeScale"] as const) {
        const expression = context.objectProperty(object, option);
        if (!expression) continue;
        const value = context.compileValue(expression);
        const number = value.kind === "json-null" ? 0 : value.staticNumber;
        if (
            number === undefined ||
            !Number.isFinite(number) ||
            (option === "depthBias"
                ? !Number.isInteger(number) ||
                  number < -2147483648 ||
                  number > 2147483647
                : !Number.isFinite(Math.fround(number)))
        ) {
            context.fail(
                expression,
                `Shader ${option} requires a static ${option === "depthBias" ? "signed 32-bit integer" : "finite float32 number"}.`,
            );
        }
        depthBiasOptions[option] = number;
    }

    // Scene-local variant: the entry file's own WGSL compiles through
    // the typed shader IR instead of matching a predeclared program.
    // The pin's `name` is optional and it carries the string onto the
    // material without reading it back -- nothing upstream composes from
    // it. The identity is this port's own, so a scene that names nothing
    // takes the position the reach order gives it, which is what a name
    // generation cannot settle already took.
    const nameExpression = context.objectProperty(object, "name");
    // An absent name has no node of its own, so the options object is what
    // a refusal about the name points at.
    const nameNode = nameExpression ?? object;
    const staticName = nameExpression
        ? context.compileValue(nameExpression).staticString
        : undefined;
    const slug =
        staticName !== undefined
            ? staticName
                  .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
                  .replace(/[^A-Za-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "")
                  .toLowerCase()
            : `scene-shader-${context.sceneManifest.reachedShaderPrograms.length}`;
    if (slug.length === 0) {
        context.fail(
            nameNode,
            "Scene-local shader material names must contain letters or digits.",
        );
    }
    // The shared system table owns the supported names and their layouts.
    for (const signature of uniforms) {
        if (!signature.includes(":") && !isShaderSystemMatrix(signature)) {
            context.fail(
                uniformsNode,
                `Reached scene-local shader materials support the ${shaderSystemMatrices.join("/")} system uniforms, received '${signature}'.`,
            );
        }
    }
    const sceneProgram: CompiledShaderProgram = {
        name: slug,
        vertexSource,
        fragmentSource,
        attributes,
        uniforms,
        uniformDefaults,
        samplers,
        samplerDeclarations,
        ...(externalTextures.length > 0 ? { externalTextures } : {}),
        storageBuffers,
        defines,
        needAlphaBlending,
        blendMode,
        ...(blend ? { blend } : {}),
        needAlphaTesting,
        backFaceCulling,
        depthWrite,
        ...(depthCompare === undefined ? {} : { depthCompare }),
        ...(depthOnlyFragmentExpression ? { depthOnlyFragment } : {}),
        ...(thinInstanceColorOption === undefined
            ? {}
            : { thinInstanceColorOption }),
        ...depthBiasOptions,
    };
    try {
        lowerWgslShaderProgram(sceneProgram);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        context.fail(
            object,
            `Invalid reached shader material WGSL: ${message}`,
        );
    }
    for (const entry of uniformDefaults) {
        const declared = uniforms.find((signature) =>
            signature.startsWith(`${entry.name}:`),
        );
        if (!declared) {
            context.fail(
                uniformsNode,
                `Shader uniform default '${entry.name}' has no typed declaration.`,
            );
        }
        const componentCount = typeComponents(
            declared.slice(declared.indexOf(":") + 1),
        );
        if (componentCount === 0) {
            context.fail(
                uniformsNode,
                `Shader uniform default '${entry.name}' has an unsupported type.`,
            );
        }
        if (entry.values.length !== componentCount) {
            context.fail(
                uniformsNode,
                `Shader uniform default '${entry.name}' expects ${componentCount} component(s).`,
            );
        }
    }
    const reached = reachShaderProgram(context, sceneProgram);
    const valueLayout = shaderUniformValueLayout(uniforms);
    const transmissive = compileOptionalStaticBoolean(
        context,
        context.objectProperty(object, "transmissive"),
        false,
    );
    return {
        ...reached,
        transmissive,
        ...(dynamicInitializers.length > 0
            ? {
                  dynamicUniforms: dynamicInitializers.map(
                      ({ name, components }) => ({
                          offset: valueLayout.get(name)!.offset,
                          components,
                      }),
                  ),
              }
            : {}),
    };
}

/** The explicit GPUBlendState replaces both default blend components. */
function compileShaderBlend(
    context: ShaderMaterialContext,
    expression: ts.Expression,
): CompiledShaderBlend {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        ["color", "alpha"],
        "Shader blend requires color and alpha components.",
    );
    const component = (side: "color" | "alpha"): [string, string] => {
        const value = context.objectProperty(object, side);
        if (!value) context.fail(object, `Shader blend requires ${side}.`);
        const literal = context.expectObjectLiteral(value);
        validateObjectProperties(
            context,
            literal,
            ["operation", "srcFactor", "dstFactor"],
            "Shader blend components accept operation, srcFactor and dstFactor.",
        );
        const operation = context.objectProperty(literal, "operation");
        if (operation && context.compileStaticString(operation) !== "add") {
            context.fail(
                operation,
                "Shader blend supports the add operation only.",
            );
        }
        const factor = (name: "srcFactor" | "dstFactor"): string => {
            const field = context.objectProperty(literal, name);
            const text = field
                ? context.compileStaticString(field)
                : name === "srcFactor"
                  ? "one"
                  : "zero";
            try {
                nativeBlendFactor(text);
            } catch (error) {
                context.fail(
                    field ?? literal,
                    error instanceof Error ? error.message : String(error),
                );
            }
            return text;
        };
        return [factor("srcFactor"), factor("dstFactor")];
    };
    return [...component("color"), ...component("alpha")];
}

/**
 * The `samplers` list, normalized the way `createShaderMaterial` normalizes
 * it: each name a WGSL identifier, unique against every other generated
 * name, together with the `<name>Sampler` companion the prelude writes
 * beside it (the pin reserves both).
 *
 * A bare string selects the pin's float/2d defaults. A `ShaderSamplerDecl`
 * carries the reached depth, 2d-array and comparison shapes explicitly so
 * reflection and both native backends see the same declaration.
 */
function compileShaderSamplers(
    context: ShaderMaterialContext,
    expression: ts.Expression | undefined,
    used: Set<string>,
): CompiledShaderSampler[] {
    if (!expression || absentShaderOption(context, expression)) {
        return [];
    }
    const samplers: CompiledShaderSampler[] = [];
    for (const element of context.expectStaticArrayElements(expression)) {
        // A typed `ShaderSamplerDecl` names its own sample type, view
        // dimension and comparison mode. Everything else goes through the
        // same static-string resolution `attributes` and `uniforms` take, so
        // a module constant naming a sampler works in all three.
        const resolved = context.resolveStaticLiteral(element);
        let name: string;
        let sampleType: CompiledShaderSampler["sampleType"] = "float";
        let viewDimension: CompiledShaderSampler["viewDimension"] = "2d";
        let comparison = false;
        if (ts.isObjectLiteralExpression(resolved)) {
            validateObjectProperties(
                context,
                resolved,
                ["name", "sampleType", "viewDimension", "comparison"],
                "Shader sampler declaration",
            );
            const nameExpression = context.objectProperty(resolved, "name");
            if (!nameExpression) {
                context.fail(
                    resolved,
                    "Shader sampler declaration requires a name.",
                );
            }
            name = context.compileStaticString(nameExpression);
            const sampleTypeExpression = context.objectProperty(
                resolved,
                "sampleType",
            );
            if (sampleTypeExpression) {
                const candidate =
                    context.compileStaticString(sampleTypeExpression);
                if (
                    candidate !== "float" &&
                    candidate !== "unfilterable-float" &&
                    candidate !== "depth"
                ) {
                    context.fail(
                        sampleTypeExpression,
                        `Unsupported shader sampler sampleType '${candidate}'.`,
                    );
                }
                sampleType = candidate;
            }
            const viewExpression = context.objectProperty(
                resolved,
                "viewDimension",
            );
            if (viewExpression) {
                const candidate = context.compileStaticString(viewExpression);
                if (candidate !== "2d" && candidate !== "2d-array") {
                    context.fail(
                        viewExpression,
                        `Unsupported shader sampler viewDimension '${candidate}'.`,
                    );
                }
                viewDimension = candidate;
            }
            comparison = compileOptionalStaticBoolean(
                context,
                context.objectProperty(resolved, "comparison"),
                false,
            );
            if (comparison && !sampleTypeExpression) {
                sampleType = "depth";
            }
        } else {
            name = context.compileStaticString(element);
        }
        reserveSamplerPair(context, element, "sampler", name, used);
        samplers.push({ name, sampleType, viewDimension, comparison });
    }
    if (samplers.length > MAX_SHADER_SAMPLERS) {
        context.fail(
            expression,
            `Reached shader materials declare at most ${MAX_SHADER_SAMPLERS} samplers; this one declares ${samplers.length}.`,
        );
    }
    return samplers;
}

/**
 * The `externalTextures` list (`createExternalTextureSlots` in
 * shader-external-texture.ts): each name a WGSL identifier, unique together
 * with its `<name>Sampler` companion against every other generated name.
 * The pin asserts this when a binding API first reads the slots; a material
 * that declares one is bound before it draws, so generation asserts it here.
 */
function compileShaderExternalTextures(
    context: ShaderMaterialContext,
    expression: ts.Expression | undefined,
    used: Set<string>,
    samplers: number,
): string[] {
    if (!expression || absentShaderOption(context, expression)) return [];
    const names = context
        .expectStaticArrayElements(expression)
        .map((element) => {
            const name = context.compileStaticString(element);
            reserveSamplerPair(
                context,
                element,
                "external texture",
                name,
                used,
            );
            return name;
        });
    // Each binds a texture/sampler pair after the samplers', in the same slots.
    if (samplers + names.length > MAX_SHADER_SAMPLERS) {
        context.fail(
            expression,
            `Reached shader materials bind at most ${MAX_SHADER_SAMPLERS} sampler and external-texture pairs; this one binds ${samplers + names.length}.`,
        );
    }
    return names;
}

/**
 * A sampler-shaped name the pin's prelude declares beside its `<name>Sampler`
 * companion: a WGSL identifier, both names unique among the generated ones.
 */
function reserveSamplerPair(
    context: ShaderMaterialContext,
    element: ts.Expression,
    kind: "sampler" | "external texture",
    name: string,
    used: Set<string>,
): void {
    if (!WGSL_IDENTIFIER.test(name)) {
        context.fail(
            element,
            `Shader material ${kind} '${name}' is not a valid WGSL identifier.`,
        );
    }
    for (const generated of [name, shaderSamplerName(name)]) {
        if (used.has(generated)) {
            context.fail(
                element,
                `Shader material ${kind} '${name}' collides with another generated identifier.`,
            );
        }
        used.add(generated);
    }
}

function compileShaderStorageBuffers(
    context: ShaderMaterialContext,
    expression: ts.Expression | undefined,
    used: Set<string>,
): CompiledShaderStorageBuffer[] {
    if (!expression || absentShaderOption(context, expression)) return [];
    const buffers = context
        .expectStaticArrayElements(expression)
        .map((element): CompiledShaderStorageBuffer => {
            const resolved = context.resolveStaticLiteral(element);
            if (!ts.isObjectLiteralExpression(resolved)) {
                context.fail(
                    element,
                    "Shader storage-buffer declarations must be object literals.",
                );
            }
            validateObjectProperties(
                context,
                resolved,
                ["name", "type"],
                "Shader storage-buffer declaration",
            );
            const nameExpression = context.objectProperty(resolved, "name");
            const typeExpression = context.objectProperty(resolved, "type");
            if (!nameExpression || !typeExpression) {
                context.fail(
                    resolved,
                    "Shader storage-buffer declaration requires name and type.",
                );
            }
            const name = context.compileStaticString(nameExpression);
            const type = context.compileStaticString(typeExpression);
            if (!WGSL_IDENTIFIER.test(name)) {
                context.fail(
                    nameExpression,
                    `Shader material storage buffer '${name}' is not a valid WGSL identifier.`,
                );
            }
            if (used.has(name)) {
                context.fail(
                    nameExpression,
                    `Shader material storage buffer '${name}' collides with another generated identifier.`,
                );
            }
            // This is the host-shareable read-only shape reached by the
            // racer. Other WGSL storage element layouts require their own
            // minimum-size/alignment validation before they may be bound.
            if (type !== "array<vec4<f32>>" && type !== "array<mat4x4<f32>>") {
                context.fail(
                    typeExpression,
                    `Reached shader storage buffers support types 'array<vec4<f32>>' and 'array<mat4x4<f32>>', received '${type}'.`,
                );
            }
            used.add(name);
            return { name, type };
        });
    if (buffers.length > MAX_SHADER_STORAGE_BUFFERS) {
        context.fail(
            expression,
            `Reached shader materials declare at most ${MAX_SHADER_STORAGE_BUFFERS} storage buffers; this one declares ${buffers.length}.`,
        );
    }
    return buffers;
}

/**
 * The `defines` map, normalized the way `createShaderMaterial` normalizes
 * it: every entry validated as a WGSL identifier, unique against the names
 * the material already generates, and the set sorted by name so two scenes
 * declaring the same defines in different orders compose the same prelude.
 *
 * The value stays a boolean or a number here because that is what decides
 * the emitted `const`'s type and literal, and the pin's own prelude line
 * makes that decision (`pinnedShaderDefineText`).
 */
function compileShaderDefines(
    context: ShaderMaterialContext,
    expression: ts.Expression | undefined,
    used: Set<string>,
): CompiledShaderDefine[] {
    if (!expression || absentShaderOption(context, expression)) {
        return [];
    }
    const object = context.expectObjectLiteral(expression);
    const defines: CompiledShaderDefine[] = [];
    for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property)) {
            context.fail(
                property,
                "Shader material defines must be plain name/value properties.",
            );
        }
        const name = context.propertyName(property.name);
        if (!name || !WGSL_IDENTIFIER.test(name)) {
            context.fail(
                property,
                `Shader material define '${name ?? property.name.getText()}' is not a valid WGSL identifier.`,
            );
        }
        if (used.has(name)) {
            context.fail(
                property,
                `Shader material define '${name}' collides with another generated identifier.`,
            );
        }
        used.add(name);
        const resolved = context.resolveStaticExpression(property.initializer);
        const value =
            resolved.kind === ts.SyntaxKind.TrueKeyword
                ? true
                : resolved.kind === ts.SyntaxKind.FalseKeyword
                  ? false
                  : expectStaticNumber(context, resolved);
        defines.push({ name, value });
    }
    // src/material/shader/shader-material.ts sorts the normalized set the
    // same way before storing it, and the prelude emits it in that order.
    defines.sort((left, right) => left.name.localeCompare(right.name));
    return defines;
}

function compileShaderUniformSignatures(
    context: ShaderMaterialContext,
    expression: ts.Expression,
): {
    signatures: string[];
    defaults: CompiledShaderUniformDefault[];
    dynamicDefaults: Array<{ name: string; components: string[] }>;
} {
    const elements = context.expectStaticArrayElements(expression);
    const defaults: CompiledShaderUniformDefault[] = [];
    const dynamicDefaults: Array<{
        name: string;
        components: string[];
    }> = [];
    const signatures = elements.map((element) => {
        const resolved = context.resolveStaticLiteral(element);
        if (
            ts.isStringLiteral(resolved) ||
            ts.isNoSubstitutionTemplateLiteral(resolved)
        ) {
            return resolved.text;
        }
        if (!ts.isObjectLiteralExpression(resolved)) {
            context.fail(
                resolved,
                "Shader uniforms must be string or typed object literals.",
            );
        }
        for (const property of resolved.properties) {
            const propertyName =
                ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property)
                    ? context.propertyName(property.name)
                    : undefined;
            if (
                !propertyName ||
                !["name", "type", "defaultValue"].includes(propertyName)
            ) {
                context.fail(
                    property,
                    "Typed shader uniforms support name, type, and defaultValue.",
                );
            }
        }
        const name = context.objectProperty(resolved, "name");
        const type = context.objectProperty(resolved, "type");
        if (!name || !type) {
            context.fail(
                resolved,
                "Typed shader uniforms require name and type.",
            );
        }
        const uniformName = context.compileStaticString(name);
        const uniformType = context.compileStaticString(type);
        const defaultExpression = context.objectProperty(
            resolved,
            "defaultValue",
        );
        if (defaultExpression) {
            const resolvedDefault =
                context.resolveStaticExpression(defaultExpression);
            const componentCount = typeComponents(uniformType);
            if (componentCount === 0) {
                context.fail(
                    type,
                    `Shader uniform default '${uniformName}' has an unsupported type.`,
                );
            }
            const candidates = ts.isArrayLiteralExpression(resolvedDefault)
                ? [...resolvedDefault.elements]
                : [resolvedDefault];
            // Only a literal of the uniform's own lanes can fold; a spread
            // or another value is compiled once, below.
            const staticValues =
                candidates.length === componentCount &&
                !candidates.some(ts.isSpreadElement)
                    ? candidates.map((entry) => staticNumber(context, entry))
                    : undefined;
            if (
                staticValues?.every(
                    (value): value is number => value !== undefined,
                )
            ) {
                defaults.push({ name: uniformName, values: staticValues });
            } else {
                dynamicDefaults.push({
                    name: uniformName,
                    components: compileShaderUniformComponents(
                        context,
                        defaultExpression,
                        {
                            count: componentCount,
                            name: uniformName,
                            type: uniformType,
                        },
                        "normalizeUniformValue",
                    ),
                });
            }
        }
        return `${uniformName}:${uniformType}`;
    });
    return { signatures, defaults, dynamicDefaults };
}

/**
 * Registers a reached shader program (predeclared or scene-local)
 * and returns its stable generated variant identity: the id indexes
 * the emitted variant table in reach order.
 */
function reachShaderProgram(
    context: ShaderMaterialContext,
    program: CompiledShaderProgram,
): { name: string; id: number } {
    const identity = ({ name: _name, ...candidate }: CompiledShaderProgram) =>
        JSON.stringify(candidate);
    const programIdentity = identity(program);
    const existing = context.sceneManifest.reachedShaderPrograms.findIndex(
        (candidate) => identity(candidate) === programIdentity,
    );
    if (existing >= 0) {
        return {
            name: context.sceneManifest.reachedShaderPrograms[existing]!.name,
            id: existing,
        };
    }
    let name = program.name;
    let suffix = 1;
    while (
        context.sceneManifest.reachedShaderPrograms.some(
            (candidate) => candidate.name === name,
        )
    )
        name = `${program.name}-${suffix++}`;
    context.sceneManifest.reachedShaderPrograms.push(
        name === program.name ? program : { ...program, name },
    );
    return {
        name,
        id: context.sceneManifest.reachedShaderPrograms.length - 1,
    };
}

/**
 * Registers a program folded out of a pinned factory, composing it at most
 * once per variant name.
 *
 * Pinned factories have deterministic variant names. Memoizing those names
 * avoids repeating their AST composition before structural registration.
 */
export function reachFoldedShaderProgram(
    context: ShaderMaterialContext,
    node: ts.Node,
    name: string,
    family: string,
    compose: () => CompiledShaderProgram,
): { name: string; id: number } {
    const reached = context.sceneManifest.reachedShaderPrograms.findIndex(
        (candidate) => candidate.name === name,
    );
    if (reached >= 0) {
        return { name, id: reached };
    }
    const program = compose();
    try {
        lowerWgslShaderProgram(program);
    } catch (error: unknown) {
        context.fail(
            node,
            `The pinned ${family} material does not lower through the ` +
                `shader IR: ${
                    error instanceof Error ? error.message : String(error)
                }`,
        );
    }
    return reachShaderProgram(context, program);
}

export function resolveShaderUniform(
    context: ShaderMaterialContext,
    material: Value,
    nameExpression: ts.Expression,
    expectedCounts: number[],
    compiledName?: string,
): ShaderUniformSlot {
    if (!material.shaderVariant) {
        context.fail(
            nameExpression,
            "Shader uniform writes require a shader material.",
        );
    }
    const program = context.sceneManifest.reachedShaderProgram(
        material.shaderVariant,
        nameExpression,
    );
    const name = compiledName ?? context.compileStringLiteral(nameExpression);
    const entry = shaderUniformValueLayout(program.uniforms).get(name);
    if (!entry) {
        context.fail(
            nameExpression,
            `Shader variant '${program.name}' declares no custom uniform '${name}'.`,
        );
    }
    if (!expectedCounts.includes(entry.count)) {
        context.fail(
            nameExpression,
            `Shader uniform '${name}' has ${entry.count} component(s); this setter expects ${expectedCounts.join(" or ")}.`,
        );
    }
    const signature = program.uniforms.find((uniform) =>
        uniform.startsWith(`${name}:`),
    );
    return {
        ...entry,
        name,
        type: signature ? signature.slice(name.length + 1) : "",
    };
}

/** A custom uniform's layout entry with the declaration the pin reports. */
export interface ShaderUniformSlot {
    readonly offset: number;
    readonly count: number;
    readonly name: string;
    readonly type: string;
}

/**
 * Which of a shader material's sampler slots a `setShaderTexture` name
 * binds. The pin looks the name up in the material's own `_textureSlots`
 * map at run time; here the declaration order is the binding order and the
 * map is settled at generation, so the write lowers to an index.
 */
export function resolveShaderTextureSlot(
    context: ShaderMaterialContext,
    material: Value,
    nameExpression: ts.Expression,
): number {
    if (!material.shaderVariant) {
        context.fail(
            nameExpression,
            "Shader texture writes require a shader material.",
        );
    }
    const program = context.sceneManifest.reachedShaderProgram(
        material.shaderVariant,
        nameExpression,
    );
    const name = context.compileStringLiteral(nameExpression);
    const slot = program.samplers.indexOf(name);
    if (slot < 0) {
        context.fail(
            nameExpression,
            `Shader variant '${program.name}' declares no sampler '${name}'.`,
        );
    }
    return slot;
}

/**
 * The native slot a `setShaderExternalTexture` name addresses: the pin's
 * `_externalTextureSlots` map, settled at generation, at the pair's
 * position in the binding order.
 */
export function resolveShaderExternalTextureSlot(
    context: ShaderMaterialContext,
    material: Value,
    nameExpression: ts.Expression,
): number {
    if (!material.shaderVariant) {
        context.fail(
            nameExpression,
            "Shader external-texture bindings require a shader material.",
        );
    }
    const program = context.sceneManifest.reachedShaderProgram(
        material.shaderVariant,
        nameExpression,
    );
    const name = context.compileStringLiteral(nameExpression);
    const slot = shaderSamplerDeclarations(program).findIndex(
        (decl) => decl.external && decl.name === name,
    );
    if (slot < 0) {
        context.fail(
            nameExpression,
            `Shader variant '${program.name}' declares no external texture '${name}'.`,
        );
    }
    return slot;
}

export function resolveShaderStorageBufferSlot(
    context: ShaderMaterialContext,
    material: Value,
    nameExpression: ts.Expression,
): number {
    if (!material.shaderVariant) {
        context.fail(
            nameExpression,
            "Shader storage-buffer writes require a shader material.",
        );
    }
    const program = context.sceneManifest.reachedShaderProgram(
        material.shaderVariant,
        nameExpression,
    );
    const name = context.compileStringLiteral(nameExpression);
    const slot = program.storageBuffers.findIndex(
        (buffer) => buffer.name === name,
    );
    if (slot < 0) {
        context.fail(
            nameExpression,
            `Shader variant '${program.name}' declares no storage buffer '${name}'.`,
        );
    }
    return slot;
}

/** The pinned uniform writers whose array-length check a component list mirrors. */
export type ShaderUniformLengthCheck =
    "normalizeUniformValue" | "setUniformValue";

export function compileShaderUniformComponents(
    context: ShaderMaterialContext,
    expression: ts.Expression,
    uniform: Pick<ShaderUniformSlot, "count" | "name" | "type">,
    /** The pinned function whose length check this mirrors: the setter's, or a default's. */
    lengthCheck: ShaderUniformLengthCheck,
): string[] {
    const { count } = uniform;
    if (count === 1) {
        return [context.compileNumber(expression)];
    }
    const resolved = context.resolveStaticExpression(expression);
    if (
        ts.isArrayLiteralExpression(resolved) &&
        resolved.elements.length === count &&
        !resolved.elements.some(ts.isSpreadElement)
    ) {
        return resolved.elements.map((element) =>
            context.compileNumber(element),
        );
    }
    // `[...rgb, 1]`: each element in order, a numeric tuple spread as its
    // lanes.
    if (
        ts.isArrayLiteralExpression(resolved) &&
        resolved.elements.some(ts.isSpreadElement)
    ) {
        const lanes = context.dataLowerer.spreadLaneValues(
            resolved.elements,
            (element) =>
                context.bindings.pinValueToTemporary(
                    context.compileValue(element),
                    "uniform_lane",
                    element,
                ),
            "A shader uniform value spreads a numeric tuple.",
        );
        if (lanes.length !== count)
            context.fail(
                expression,
                `Expected a ${count}-component array value.`,
            );
        return lanes.map(({ value }) => context.castNumber(value, "float"));
    }
    // A tuple's lanes are double values -- a `?? [0.7, 0.82, 0.92]` default
    // lowers each literal as one -- while the setter takes floats, and the
    // pin stores the value into a Float32Array. `castNumber` is the one
    // rule for a number at a float sink: a static lane becomes a float
    // literal, a runtime lane a `static_cast<float>`.
    const value = context.compileValue(expression);
    if (value.kind === "tuple" && value.tupleElements?.length === count) {
        return value.tupleElements.map((element) =>
            context.castNumber(element, "float"),
        );
    }
    if (
        value.kind === "data" &&
        value.dataType?.kind === "tuple" &&
        value.dataType.arity === count
    ) {
        return tupleComponents(value.cpp, count);
    }
    const numericArray =
        value.dataType?.kind === "vector" &&
        value.dataType.element.kind === "number";
    if (
        value.kind === "data" &&
        (isTypedArrayType(value.dataType) || numericArray)
    ) {
        // The pin's setter takes any ArrayLike: a length other than the
        // declared count throws (the pinned length check), then each lane is stored
        // through Math.fround.
        const array = context.bindings.pinValueToTemporary(
            value,
            "uniform_values",
        ).cpp;
        const pinned = sharedPinnedContext();
        const messageArguments = [
            uniform.name,
            uniform.type,
            count,
            { cpp: `std::to_string(${array}.size())` },
        ];
        const message = pinnedErrorMessageCpp(
            pinned,
            pinnedErrorCode(
                pinned,
                pinned.functionDeclaration(
                    "src/material/shader/shader-material.ts",
                    lengthCheck,
                ).declaration,
                messageArguments.length,
            ),
            messageArguments,
        );
        context.emit({
            kind: "expression",
            code: `if (${array}.size() != ${count}u) throw std::runtime_error(${message});`,
        });
        const float = value.dataType?.kind === "f32array";
        return Array.from({ length: count }, (_, index) =>
            numericArray
                ? `static_cast<float>(${array}[${index}u])`
                : float
                  ? `${array}.load(${index}u)`
                  : `static_cast<float>(${array}.load(${index}u))`,
        );
    }
    context.fail(expression, `Expected a ${count}-component array value.`);
}

function compileStaticStringArray(
    context: ShaderMaterialContext,
    expression: ts.Expression,
): string[] {
    return context
        .expectStaticArrayElements(expression)
        .map((element) => context.compileStaticString(element));
}

function expectStaticNumber(
    context: ShaderMaterialContext,
    expression: ts.Expression,
): number {
    const value = staticNumber(context, expression);
    if (value === undefined) {
        context.fail(
            context.resolveStaticExpression(expression),
            "Expected a static numeric literal.",
        );
    }
    return value;
}

function staticNumber(
    context: ShaderMaterialContext,
    expression: ts.Expression,
): number | undefined {
    const resolved = context.resolveStaticExpression(expression);
    if (ts.isNumericLiteral(resolved)) {
        return Number(resolved.text);
    }
    if (
        ts.isPrefixUnaryExpression(resolved) &&
        resolved.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(resolved.operand)
    ) {
        return -Number(resolved.operand.text);
    }
    const value = context.compileValue(expression);
    return value.staticNumber;
}

/**
 * Which scene-local shader programs draw instanced, and which of those also
 * bind the per-instance colour stream.
 *
 * The pin builds one pipeline per renderable and keys it `"" + +hasColor`,
 * where `hasColor` is `!!ti.colors && material._tic != 0`. This port bakes
 * one variant into the material record, which is why a material whose meshes
 * disagree on either axis refuses rather than picking a side: the pin would
 * compose two programs there. Shader source does not select the layout.
 */
export function shaderThinInstanceLanes(
    meshes: readonly SceneMeshManifest[],
    programs: readonly CompiledShaderProgram[],
    fail: (message: string) => never,
): ReadonlyMap<string, boolean> {
    const lanes = new EmissionMap<string, boolean>();
    const seen = new EmissionMap<string, SceneMeshManifest>();
    const colorOptions = new Map(
        programs.map((program) => [
            program.name,
            program.thinInstanceColorOption,
        ]),
    );
    for (const mesh of meshes) {
        if (mesh.shaderVariant === undefined && !mesh.shaderVariants?.length)
            continue;
        const variants = new EmissionSet([
            ...(mesh.shaderVariant === undefined ? [] : [mesh.shaderVariant]),
            ...(mesh.shaderVariants ?? []),
        ]);
        for (const variant of variants) {
            const colors =
                mesh.thinInstanceColors === true &&
                colorOptions.get(variant) !== false;
            if (mesh.thinInstances === "possible") {
                fail(
                    `Shader material '${variant}' is on a mesh that may acquire ` +
                        "thin instances from a frame callback; the instanced " +
                        "lanes are declared in the prelude the stage compiles " +
                        "against, so the form has to be settled before the draw " +
                        "exists.",
                );
            }
            const first = seen.get(variant);
            if (first === undefined) {
                seen.set(variant, mesh);
                if (mesh.thinInstances !== undefined) {
                    lanes.set(variant, colors);
                }
                continue;
            }
            // Every possible program must agree on the two instance lanes
            // across all meshes that can select that program.
            if (
                first.thinInstances !== mesh.thinInstances ||
                (mesh.thinInstances !== undefined &&
                    lanes.get(variant) !== colors)
            ) {
                fail(
                    `Shader material '${variant}' is drawn on meshes that ` +
                        "disagree about thin instances; the lanes are declared " +
                        "in the prelude the stage compiles against, so one " +
                        "baked variant cannot serve both.",
                );
            }
        }
    }
    return lanes;
}
