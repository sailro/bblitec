// Shader-material lowering: variant matching and uniform resolution.
//
// A createShaderMaterial call either matches a predeclared program --
// proven by lowering both sides through the typed WGSL IR and
// comparing the IR, never the source text -- or registers the scene's
// own WGSL as a scene-local variant. Reached programs are recorded in
// reach order, which is the generated variant table's index order, and
// the uniform setters resolve their offsets from the reflected layout
// of the reached program.
import { typeComponents } from "../shader-ir.js";
import ts from "typescript";
import { cppIdentifierPattern } from "../cpp-literals.js";
import {
    isShaderSystemMatrix,
    lowerWgslShaderProgram,
    shaderSystemMatrices,
    type ShaderIrProgram,
} from "../shader-ir.js";
import {
    shaderMaterialPrograms,
    shaderSamplerName,
    shaderUniformValueLayout,
} from "../shader-material-programs.js";
import {
    compileOptionalStaticBoolean,
    type StaticBooleanContext,
    validateObjectProperties,
    type ObjectValidationContext,
} from "./option-helpers.js";
import type {
    CompiledShaderDefine,
    CompiledShaderProgram,
    CompiledShaderUniformDefault,
    SceneMeshManifest,
    Value,
} from "./types.js";
import { tupleComponents } from "./data-types.js";

/**
 * What `createShaderMaterial` accepts as a WGSL identifier
 * (`assertIdentifier` in `src/material/shader/shader-material.ts`). It is
 * the rule behind both the sampler and the define refusal, so it is stated
 * once. WGSL identifiers share the C++ spelling, so the pattern itself
 * is the shared export.
 */
const WGSL_IDENTIFIER = cppIdentifierPattern;

/**
 * How many sampler pairs a shader material may declare.
 *
 * The Dawn backend binds every mesh pipeline outside the composed material
 * families through one superset group-2 layout, whose fifth pair is the
 * environment/reflection cube (`pal_dawn.cpp`, the `pair == 4` arm of the
 * layout's `viewDimension`). A fifth 2D pair would land in that entry and
 * fail inside `wgpuDeviceCreateBindGroup` at run time, on one backend only,
 * so the reached slice stops at four and says so here instead. Lifting it
 * means a per-variant layout, the way the composed families already build
 * one.
 */
const MAX_SHADER_SAMPLERS = 4;

export interface ShaderMaterialContext
    extends ObjectValidationContext,
        StaticBooleanContext {
    readonly reachedShaderPrograms: CompiledShaderProgram[];
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    compileValue(expression: ts.Expression): Value;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileStaticString(
        expression: ts.Expression,
    ): string;
    compileShaderSource(expression: ts.Expression): {
        source: string;
        dynamicUniforms: Array<{
            name: string;
            type: "f32";
            components: string[];
        }>;
    };
    compileStringLiteral(
        expression: ts.Expression,
    ): string;
}

export function compileShaderMaterialOptions(
    context: ShaderMaterialContext,
    expression: ts.Expression,
): {
    name: string;
    id: number;
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
            "defines",
            "needAlphaBlending",
            "blendMode",
            "needAlphaTesting",
            "backFaceCulling",
            "depthWrite",
        ],
        "Reached shader materials support source, attributes, uniforms, samplers, defines, alpha state and blend mode, culling, and depthWrite only.",
    );

    const vertexExpression = context.objectProperty(object, "vertexSource");
    const fragmentExpression = context.objectProperty(object, "fragmentSource");
    const attributesExpression = context.objectProperty(object, "attributes");
    const uniformsExpression = context.objectProperty(object, "uniforms");
    if (
        !vertexExpression ||
        !fragmentExpression ||
        !attributesExpression ||
        !uniformsExpression
    ) {
        context.fail(
            object,
            "Shader material requires vertexSource, fragmentSource, attributes, and uniforms.",
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
    } = compileShaderUniformSignatures(context, uniformsExpression);
    const dynamicSourceUniforms = [
        ...compiledVertex.dynamicUniforms,
        ...compiledFragment.dynamicUniforms,
    ];
    const uniforms = [
        ...declaredUniforms,
        ...dynamicSourceUniforms.map(({ name, type }) => `${name}:${type}`),
    ];
    const dynamicInitializers = [
        ...dynamicSourceUniforms,
        ...dynamicDefaults,
    ];
    // `createShaderMaterial` asserts one namespace across the uniform,
    // sampler and define names it generates, so the set is built once here
    // and each normalizer adds its own to it.
    const generatedNames = new Set(
        uniforms.map((signature) => {
            const separator = signature.indexOf(":");
            return separator < 1 ? signature : signature.slice(0, separator);
        }),
    );
    const samplers = compileShaderSamplers(
        context,
        context.objectProperty(object, "samplers"),
        generatedNames,
    );
    const defines = compileShaderDefines(
        context,
        context.objectProperty(object, "defines"),
        generatedNames,
    );
    const needAlphaBlending = compileOptionalStaticBoolean(
        context,
        context.objectProperty(object, "needAlphaBlending"),
        false,
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

    for (const program of shaderMaterialPrograms) {
        if (
            stringArraysEqual(attributes, program.attributes) &&
            stringArraysEqual(uniforms, program.uniforms) &&
            stringArraysEqual(samplers, program.samplers ?? []) &&
            definesEqual(defines, program.defines ?? []) &&
            needAlphaBlending === program.needAlphaBlending &&
            blendMode === (program.blendMode ?? "alpha") &&
            needAlphaTesting === program.needAlphaTesting &&
            backFaceCulling === program.backFaceCulling &&
            depthWrite === program.depthWrite
        ) {
            let candidate: ShaderIrProgram;
            try {
                candidate = lowerWgslShaderProgram({
                    ...program,
                    vertexSource,
                    fragmentSource,
                    attributes,
                    uniforms,
                    samplers,
                    defines,
                    needAlphaBlending,
                    blendMode,
                    needAlphaTesting,
                    backFaceCulling,
                    depthWrite,
                });
            } catch (error: unknown) {
                const message =
                    error instanceof Error
                        ? error.message
                        : String(error);
                context.fail(
                    object,
                    `Invalid reached shader material WGSL: ${message}`,
                );
            }
            const expected =
                lowerWgslShaderProgram(program);
            if (
                JSON.stringify(candidate) ===
                JSON.stringify(expected)
            ) {
                return reachShaderProgram(context, {
                    name: program.name,
                    vertexSource: program.vertexSource,
                    fragmentSource: program.fragmentSource,
                    attributes: program.attributes,
                    uniforms: program.uniforms,
                    uniformDefaults: [],
                    samplers: [...(program.samplers ?? [])],
                    defines: [...(program.defines ?? [])],
                    needAlphaBlending: program.needAlphaBlending,
                    blendMode: program.blendMode ?? "alpha",
                    needAlphaTesting: program.needAlphaTesting,
                    backFaceCulling: program.backFaceCulling,
                    depthWrite: program.depthWrite,
                });
            }
        }
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
    const slug = staticName !== undefined
        ? staticName
              .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
              .replace(/[^A-Za-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "")
              .toLowerCase()
        : `scene-shader-${context.reachedShaderPrograms.length}`;
    if (slug.length === 0) {
        context.fail(
            nameNode,
            "Scene-local shader material names must contain letters or digits.",
        );
    }
    if (
        shaderMaterialPrograms.some(
            ({ name }) => name === slug,
        )
    ) {
        context.fail(
            nameNode,
            `Shader material name '${slug}' collides with a predeclared variant.`,
        );
    }
    // The pin names nine system uniforms; the reached subset is the three
    // that name a matrix a draw already holds, so serving one is a copy
    // rather than a derivation. `cameraPosition`, `screenSize` and
    // `alphaCutoff` refuse by name.
    for (const signature of uniforms) {
        if (
            !signature.includes(":") &&
            !isShaderSystemMatrix(signature)
        ) {
            context.fail(
                uniformsExpression,
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
        defines,
        needAlphaBlending,
        blendMode,
        needAlphaTesting,
        backFaceCulling,
        depthWrite,
    };
    try {
        lowerWgslShaderProgram(sceneProgram);
    } catch (error: unknown) {
        const message =
            error instanceof Error
                ? error.message
                : String(error);
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
                uniformsExpression,
                `Shader uniform default '${entry.name}' has no typed declaration.`,
            );
        }
        const componentCount = declaredVectorComponents(
            declared.slice(declared.indexOf(":") + 1),
        );
        if (componentCount === 0) {
            context.fail(
                uniformsExpression,
                `Shader uniform default '${entry.name}' has an unsupported type.`,
            );
        }
        if (entry.values.length !== componentCount) {
            context.fail(
                uniformsExpression,
                `Shader uniform default '${entry.name}' expects ${componentCount} component(s).`,
            );
        }
    }
    const reached = reachShaderProgram(context, sceneProgram);
    const valueLayout = shaderUniformValueLayout(uniforms);
    return {
        ...reached,
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

/**
 * The `samplers` list, normalized the way `createShaderMaterial` normalizes
 * it: each name a WGSL identifier, unique against every other generated
 * name, together with the `<name>Sampler` companion the prelude writes
 * beside it (the pin reserves both).
 *
 * The reached slice is the bare-string form. The pin also takes a
 * `ShaderSamplerDecl` object naming a sample type, a view dimension or a
 * comparison sampler, and each of those changes the declared WGSL texture
 * type and the sampler's own kind, so one refuses by name rather than
 * compiling to the float/2d pair a plain string means.
 */
function compileShaderSamplers(
    context: ShaderMaterialContext,
    expression: ts.Expression | undefined,
    used: Set<string>,
): string[] {
    if (!expression) {
        return [];
    }
    const samplers: string[] = [];
    for (const element of context.expectStaticArrayLiteral(expression)
        .elements) {
        // A typed `ShaderSamplerDecl` names its own sample type, view
        // dimension or comparison mode, each of which changes the declared
        // WGSL texture and sampler types, so it refuses rather than
        // compiling to the float/2d pair a plain string means. Everything
        // else goes through the same static-string resolution `attributes`
        // and `uniforms` take, so a module constant naming a sampler works
        // in all three.
        if (
            ts.isObjectLiteralExpression(
                context.resolveStaticExpression(element),
            )
        ) {
            context.fail(
                element,
                "Reached shader-material samplers are named by a string; a typed sampler declaration is not lowered.",
            );
        }
        const name = context.compileStaticString(element);
        if (!WGSL_IDENTIFIER.test(name)) {
            context.fail(
                element,
                `Shader material sampler '${name}' is not a valid WGSL identifier.`,
            );
        }
        for (const generated of [name, shaderSamplerName(name)]) {
            if (used.has(generated)) {
                context.fail(
                    element,
                    `Shader material sampler '${name}' collides with another generated identifier.`,
                );
            }
            used.add(generated);
        }
        samplers.push(name);
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
 * The `defines` map, normalized the way `createShaderMaterial` normalizes
 * it: every entry validated as a WGSL identifier, unique against the names
 * the material already generates, and the set sorted by name so two scenes
 * declaring the same defines in different orders compose the same prelude.
 *
 * The value stays a boolean or a number here because that is what decides
 * the emitted `const`'s type and literal, and the pin's own prelude line
 * makes that decision (`pinnedShaderDefineLines`).
 */
function compileShaderDefines(
    context: ShaderMaterialContext,
    expression: ts.Expression | undefined,
    used: Set<string>,
): CompiledShaderDefine[] {
    if (!expression) {
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
        const resolved = context.resolveStaticExpression(
            property.initializer,
        );
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

function definesEqual(
    left: readonly CompiledShaderDefine[],
    right: readonly { name: string; value: boolean | number }[],
): boolean {
    return (
        left.length === right.length &&
        left.every(
            (entry, index) =>
                entry.name === right[index]!.name &&
                entry.value === right[index]!.value,
        )
    );
}

function compileShaderUniformSignatures(
    context: ShaderMaterialContext,
    expression: ts.Expression,
): {
    signatures: string[];
    defaults: CompiledShaderUniformDefault[];
    dynamicDefaults: Array<{ name: string; components: string[] }>;
} {
    const array = context.expectStaticArrayLiteral(expression);
    const defaults: CompiledShaderUniformDefault[] = [];
    const dynamicDefaults: Array<{
        name: string;
        components: string[];
    }> = [];
    const signatures = array.elements.map((element) => {
        const resolved = context.resolveStaticExpression(element);
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
            const componentCount = declaredVectorComponents(uniformType);
            if (componentCount === 0) {
                context.fail(
                    type,
                    `Shader uniform default '${uniformName}' has an unsupported type.`,
                );
            }
            const candidates = ts.isArrayLiteralExpression(resolvedDefault)
                ? [...resolvedDefault.elements]
                : [resolvedDefault];
            const staticValues = candidates.map((entry) =>
                staticNumber(context, entry),
            );
            if (
                candidates.length === componentCount &&
                staticValues.every(
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
                        componentCount,
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
export function reachShaderProgram(
    context: ShaderMaterialContext,
    program: CompiledShaderProgram,
): { name: string; id: number } {
    const identity = ({ name: _name, ...candidate }: CompiledShaderProgram) =>
        JSON.stringify(candidate);
    const programIdentity = identity(program);
    const existing = context.reachedShaderPrograms.findIndex(
        (candidate) =>
            candidate.name === program.name ||
            identity(candidate) === programIdentity,
    );
    if (existing >= 0) {
        return {
            name: context.reachedShaderPrograms[existing]!.name,
            id: existing,
        };
    }
    context.reachedShaderPrograms.push(program);
    return {
        name: program.name,
        id: context.reachedShaderPrograms.length - 1,
    };
}

/**
 * Registers a program folded out of a pinned factory, composing it at most
 * once per variant name.
 *
 * `reachShaderProgram` already dedupes by name, but composing is the
 * expensive half -- it walks the pinned factory's own AST -- so the two
 * pinned-material families (`createLineMaterial`,
 * `createLinearDepthMaterial`) both memoized it before calling. That memo,
 * the shader-IR validation and its refusal wording live here instead of
 * once per family.
 */
export function reachFoldedShaderProgram(
    context: ShaderMaterialContext,
    node: ts.Node,
    name: string,
    family: string,
    compose: () => CompiledShaderProgram,
): { name: string; id: number } {
    const reached = context.reachedShaderPrograms.findIndex(
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

export function reachedShaderProgram(
    context: ShaderMaterialContext,
    name: string,
    node: ts.Node,
): CompiledShaderProgram {
    const program = context.reachedShaderPrograms.find(
        (candidate) => candidate.name === name,
    );
    if (!program) {
        context.fail(
            node,
            `Shader variant '${name}' was not created in this scene.`,
        );
    }
    return program;
}

export function resolveShaderUniform(
    context: ShaderMaterialContext,
    material: Value,
    nameExpression: ts.Expression,
    expectedCounts: number[],
): { offset: number; count: number } {
    if (!material.shaderVariant) {
        context.fail(
            nameExpression,
            "Shader uniform writes require a shader material.",
        );
    }
    const program = reachedShaderProgram(
        context,
        material.shaderVariant,
        nameExpression,
    );
    const name =
        context.compileStringLiteral(nameExpression);
    const entry = shaderUniformValueLayout(
        program.uniforms,
    ).get(name);
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
    return entry;
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
    const program = reachedShaderProgram(
        context,
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

export function compileShaderUniformComponents(
    context: ShaderMaterialContext,
    expression: ts.Expression,
    count: number,
): string[] {
    if (count === 1) {
        return [context.compileNumber(expression)];
    }
    const resolved =
        context.resolveStaticExpression(expression);
    if (
        ts.isArrayLiteralExpression(resolved) &&
        resolved.elements.length === count
    ) {
        return resolved.elements.map((element) =>
            context.compileNumber(element),
        );
    }
    const value = context.compileValue(expression);
    if (
        value.kind === "tuple" &&
        value.tupleElements?.length === count
    ) {
        return value.tupleElements.map(
            (element) => element.cpp,
        );
    }
    if (
        value.kind === "data" &&
        value.dataType?.kind === "tuple" &&
        value.dataType.arity === count
    ) {
        return tupleComponents(value.cpp, count);
    }
    context.fail(
        expression,
        `Expected a ${count}-component array value.`,
    );
}

function compileStaticStringArray(
    context: ShaderMaterialContext,
    expression: ts.Expression,
): string[] {
    return context.expectStaticArrayLiteral(expression).elements.map(
        (element) => context.compileStaticString(element),
    );
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

/**
 * The scalar or vector float types a custom uniform default may fill, as a
 * component count -- zero for anything else, so the caller names the type.
 */
function declaredVectorComponents(type: string): number {
    return type === "f32" ||
        type === "vec2<f32>" ||
        type === "vec3<f32>" ||
        type === "vec4<f32>"
        ? typeComponents(type)
        : 0;
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

function stringArraysEqual(left: string[], right: string[]): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}

/**
 * Which scene-local shader programs draw instanced, and which of those also
 * read the per-instance colour stream.
 *
 * The pin builds one pipeline per renderable and keys it `"" + +hasColor`,
 * where `hasColor` is `!!ti.colors && material._tic != 0` -- so both axes
 * are the mesh's, `_tic` being an opt-out this port refuses. This port bakes
 * one variant into the material record, which is why a material whose meshes
 * disagree on either axis refuses rather than picking a side: the pin would
 * compose two programs there. The line family shows the shape a
 * generalization would take, naming each permutation (`-ti`, `-tic`) as its
 * own variant; nothing reached needs it.
 */
export function shaderThinInstanceLanes(
    meshes: readonly SceneMeshManifest[],
    fail: (message: string) => never,
): ReadonlyMap<string, boolean> {
    const lanes = new Map<string, boolean>();
    const seen = new Map<string, SceneMeshManifest>();
    for (const mesh of meshes) {
        const variant = mesh.shaderVariant;
        if (variant === undefined) continue;
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
                lanes.set(variant, mesh.thinInstanceColors === true);
            }
            continue;
        }
        // Both axes decide the prelude, so both have to agree across the
        // meshes one baked variant serves.
        if (
            first.thinInstances !== mesh.thinInstances ||
            first.thinInstanceColors !== mesh.thinInstanceColors
        ) {
            fail(
                `Shader material '${variant}' is drawn on meshes that ` +
                    "disagree about thin instances; the lanes are declared " +
                    "in the prelude the stage compiles against, so one " +
                    "baked variant cannot serve both.",
            );
        }
    }
    return lanes;
}
