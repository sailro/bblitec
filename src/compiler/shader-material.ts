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
import {
    lowerWgslShaderProgram,
    type ShaderIrProgram,
} from "../shader-ir.js";
import {
    shaderMaterialPrograms,
    shaderUniformValueLayout,
} from "../shader-material-programs.js";
import {
    compileOptionalStaticBoolean,
    type StaticBooleanContext,
    validateObjectProperties,
    type ObjectValidationContext,
} from "./option-helpers.js";
import type {
    CompiledShaderProgram,
    CompiledShaderUniformDefault,
    Value,
} from "./types.js";

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
    compileStringLiteral(
        expression: ts.Expression,
    ): string;
}

export function compileShaderMaterialOptions(
    context: ShaderMaterialContext,
    expression: ts.Expression,
): { name: string; id: number } {
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
            "needAlphaBlending",
            "needAlphaTesting",
            "backFaceCulling",
            "depthWrite",
        ],
        "Reached shader materials support source, attributes, uniforms, alpha state, culling, and depthWrite only.",
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

    const vertexSource =
        context.compileStaticString(vertexExpression);
    const fragmentSource =
        context.compileStaticString(fragmentExpression);
    const attributes = compileStaticStringArray(context, attributesExpression);
    const { signatures: uniforms, defaults: uniformDefaults } =
        compileShaderUniformSignatures(context, uniformsExpression);
    const needAlphaBlending = compileOptionalStaticBoolean(
        context,
        context.objectProperty(object, "needAlphaBlending"),
        false,
    );
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
            needAlphaBlending === program.needAlphaBlending &&
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
                    needAlphaBlending,
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
                    needAlphaBlending: program.needAlphaBlending,
                    needAlphaTesting: program.needAlphaTesting,
                    backFaceCulling: program.backFaceCulling,
                    depthWrite: program.depthWrite,
                    clipDepth: program.clipDepth,
                });
            }
        }
    }

    // Scene-local variant: the entry file's own WGSL compiles through
    // the typed shader IR instead of matching a predeclared program.
    const nameExpression = context.objectProperty(object, "name");
    if (!nameExpression) {
        context.fail(
            object,
            "Scene-local shader materials require a name (it becomes the generated variant identity).",
        );
    }
    const slug = context.compileStaticString(nameExpression)
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
    if (slug.length === 0) {
        context.fail(
            nameExpression,
            "Scene-local shader material names must contain letters or digits.",
        );
    }
    if (
        shaderMaterialPrograms.some(
            ({ name }) => name === slug,
        )
    ) {
        context.fail(
            nameExpression,
            `Shader material name '${slug}' collides with a predeclared variant.`,
        );
    }
    // The reached subset composes the system block from
    // worldViewProjection alone (or none); other system uniforms
    // (view, world, projection splits) stay unreached.
    for (const signature of uniforms) {
        if (
            !signature.includes(":") &&
            signature !== "worldViewProjection"
        ) {
            context.fail(
                uniformsExpression,
                `Reached scene-local shader materials support the worldViewProjection system uniform only, received '${signature}'.`,
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
        needAlphaBlending,
        needAlphaTesting,
        backFaceCulling,
        depthWrite,
        // The pinned prelude clips through the composed matrix when
        // one is requested; matrix-free programs write clip
        // positions directly like the pinned alpha-card.
        clipDepth: uniforms.includes("worldViewProjection")
            ? "matrix"
            : "direct-webgpu",
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
    const reflection =
        lowerWgslShaderProgram(sceneProgram).reflection;
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
        const componentCount =
            declared.endsWith(":f32")
                ? 1
                : declared.endsWith(":vec2<f32>")
                    ? 2
                    : declared.endsWith(":vec3<f32>")
                        ? 3
                        : declared.endsWith(":vec4<f32>")
                            ? 4
                            : 0;
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
    void reflection;
    return reachShaderProgram(context, sceneProgram);
}

function compileShaderUniformSignatures(
    context: ShaderMaterialContext,
    expression: ts.Expression,
): {
    signatures: string[];
    defaults: CompiledShaderUniformDefault[];
} {
    const array = context.expectStaticArrayLiteral(expression);
    const defaults: CompiledShaderUniformDefault[] = [];
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
        const defaultExpression = context.objectProperty(
            resolved,
            "defaultValue",
        );
        if (defaultExpression) {
            const resolvedDefault =
                context.resolveStaticExpression(defaultExpression);
            const values = ts.isArrayLiteralExpression(resolvedDefault)
                ? resolvedDefault.elements.map((entry) =>
                      expectStaticNumber(context, entry),
                  )
                : [expectStaticNumber(context, resolvedDefault)];
            defaults.push({ name: uniformName, values });
        }
        return `${uniformName}:${context.compileStaticString(type)}`;
    });
    return { signatures, defaults };
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
    const existing = context.reachedShaderPrograms.findIndex(
        ({ name }) => name === program.name,
    );
    if (existing >= 0) {
        return { name: program.name, id: existing };
    }
    context.reachedShaderPrograms.push(program);
    return {
        name: program.name,
        id: context.reachedShaderPrograms.length - 1,
    };
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
    context.fail(resolved, "Expected a static numeric literal.");
}

function stringArraysEqual(left: string[], right: string[]): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}
