export type AssignmentValueKind =
    | "color3"
    | "number";

export interface DirectPropertyAssignment {
    collection: "lights";
    nativeProperty: string;
    valueKind: AssignmentValueKind;
    supportsCompound: boolean;
}

function emitFrameGraphTransmission(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
    left: ts.PropertyAccessExpression,
): boolean {
    if (
        left.name.text !== "transmission" ||
        !ts.isPropertyAccessExpression(left.expression) ||
        left.expression.name.text !== "_config"
    ) {
        return false;
    }
    const task = context.unwrap(
        left.expression.expression,
    );
    if (
        !ts.isElementAccessExpression(task) ||
        !ts.isPropertyAccessExpression(task.expression) ||
        task.expression.name.text !== "_tasks"
    ) {
        return false;
    }
    const frameGraph = context.unwrap(
        task.expression.expression,
    );
    if (
        !ts.isCallExpression(frameGraph) ||
        !ts.isIdentifier(frameGraph.expression) ||
        context.importedName(frameGraph.expression) !==
            "getFrameGraph" ||
        frameGraph.arguments.length !== 1
    ) {
        return false;
    }
    const options = context.unwrap(expression.right);
    if (!ts.isObjectLiteralExpression(options)) {
        context.fail(
            expression.right,
            "Frame-graph transmission requires an options object.",
        );
    }
    const copyCount = context.objectProperty(
        options,
        "copyCount",
    );
    if (
        !copyCount ||
        context.compileNumber(copyCount) !== "1.0f"
    ) {
        context.fail(
            options,
            "Reached frame-graph transmission requires copyCount: 1.",
        );
    }
    const scene = context.compileValue(
        frameGraph.arguments[0]!,
    );
    context.expectKind(
        scene,
        "scene",
        frameGraph.arguments[0]!,
    );
    context.reachFeature("renderer:pbr");
    context.reachFeature("renderer:transmission");
    context.emit(
        `bbl::enable_scene_transmission(${scene.cpp});`,
    );
    return true;
}

const commonLightProperties: Readonly<
    Record<string, DirectPropertyAssignment>
> = {
    intensity: {
        collection: "lights",
        nativeProperty: "intensity",
        valueKind: "number",
        supportsCompound: true,
    },
};

const lightProperties: Readonly<
    Record<
        LightKind,
        Readonly<Record<string, DirectPropertyAssignment>>
    >
> = {
    directional: {
        ...commonLightProperties,
        diffuse: {
            collection: "lights",
            nativeProperty: "diffuse_color",
            valueKind: "color3",
            supportsCompound: false,
        },
        specular: {
            collection: "lights",
            nativeProperty: "specular_color",
            valueKind: "color3",
            supportsCompound: false,
        },
    },
    hemispheric: {
        ...commonLightProperties,
        diffuseColor: {
            collection: "lights",
            nativeProperty: "diffuse_color",
            valueKind: "color3",
            supportsCompound: false,
        },
        specularColor: {
            collection: "lights",
            nativeProperty: "specular_color",
            valueKind: "color3",
            supportsCompound: false,
        },
    },
    point: {
        ...commonLightProperties,
        diffuse: {
            collection: "lights",
            nativeProperty: "diffuse_color",
            valueKind: "color3",
            supportsCompound: false,
        },
        specular: {
            collection: "lights",
            nativeProperty: "specular_color",
            valueKind: "color3",
            supportsCompound: false,
        },
        range: {
            collection: "lights",
            nativeProperty: "range",
            valueKind: "number",
            supportsCompound: true,
        },
    },
};

export function directPropertyAssignment(
    owner: Value,
    property: string,
): DirectPropertyAssignment | undefined {
    if (owner.kind !== "light" || !owner.lightKind) {
        return undefined;
    }
    return lightProperties[owner.lightKind][property];
}

export interface AssignmentContext {
    lookup(identifier: ts.Identifier): Value;
    compileValue(expression: ts.Expression): Value;
    compileNumber(expression: ts.Expression): string;
    compileBoolean(expression: ts.Expression): string;
    compileColor3(expression: ts.Expression): string;
    compileColor4(expression: ts.Expression): string;
    compileVec3(expression: ts.Expression): string;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    unwrap(expression: ts.Expression): ts.Expression;
    importedName(
        identifier: ts.Identifier,
    ): string | undefined;
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
    requireEngine(value: Value, node: ts.Node): string;
    eraseBrowserInstrumentation(position: number): void;
    isBrowserOnlyExpression(
        expression: ts.Expression,
    ): boolean;
    emit(line: string): void;
    reachFeature(feature: Feature): void;
    fail(node: ts.Node, message: string): never;
}

export function emitPropertyAssignment(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
): void {
    if (!ts.isPropertyAccessExpression(expression.left)) {
        context.fail(
            expression.left,
            "Only property assignments are supported.",
        );
    }

    const operator = assignmentOperator(
        context,
        expression,
    );
    const left = expression.left;
    if (context.isBrowserOnlyExpression(left)) {
        context.eraseBrowserInstrumentation(
            expression.pos,
        );
        return;
    }
    if (
        emitFrameGraphTransmission(
            context,
            expression,
            left,
        )
    ) {
        return;
    }
    if (
        ts.isPropertyAccessExpression(left.expression) &&
        left.expression.name.text === "dataset" &&
        ts.isIdentifier(left.expression.expression)
    ) {
        const target = context.lookup(
            left.expression.expression,
        );
        if (target.kind === "browser") {
            context.eraseBrowserInstrumentation(
                expression.pos,
            );
            return;
        }
    }
    if (
        ts.isPropertyAccessExpression(left.expression) &&
        left.expression.name.text === "imageProcessing" &&
        ts.isIdentifier(left.expression.expression)
    ) {
        const scene = context.lookup(
            left.expression.expression,
        );
        context.expectKind(
            scene,
            "scene",
            left.expression.expression,
        );
        const property = left.name.text;
        if (
            ![
                "exposure",
                "contrast",
                "toneMappingEnabled",
            ].includes(property)
        ) {
            context.fail(
                left.name,
                `Unsupported image-processing property '${property}'.`,
            );
        }
        if (property === "toneMappingEnabled") {
            requireSimpleAssignment(
                context,
                expression,
                `image-processing property '${property}'`,
            );
            context.emit(
                `${scene.cpp}.environment.tone_mapping_enabled = ${context.compileBoolean(expression.right)};`,
            );
            return;
        }
        context.emit(
            `${scene.cpp}.environment.${property} ${operator} ${context.compileNumber(expression.right)};`,
        );
        return;
    }
    if (
        ts.isPropertyAccessExpression(left.expression) &&
        left.expression.name.text === "camera" &&
        ts.isIdentifier(left.expression.expression)
    ) {
        const scene = context.lookup(
            left.expression.expression,
        );
        context.expectKind(
            scene,
            "scene",
            left.expression.expression,
        );
        const property = left.name.text;
        if (
            ![
                "alpha",
                "beta",
                "radius",
                "fov",
                "nearPlane",
                "farPlane",
            ].includes(property)
        ) {
            context.fail(
                left.name,
                `Unsupported camera property '${property}'.`,
            );
        }
        const nativeProperty =
            property === "nearPlane"
                ? "near_plane"
                : property === "farPlane"
                  ? "far_plane"
                  : property;
        context.emit(
            `${context.requireEngine(scene, expression)}.cameras[${scene.cpp}.camera.value].${nativeProperty} ${operator} ${context.compileNumber(expression.right)};`,
        );
        return;
    }
    if (
        ts.isPropertyAccessExpression(left.expression) &&
        ts.isIdentifier(left.expression.expression) &&
        context.lookup(left.expression.expression).kind ===
            "camera" &&
        left.expression.name.text === "target"
    ) {
        // Component writes into the camera target record (the demo
        // renderer's camera shake). The record's properties already
        // carry their native lvalues for reads.
        const record = context.compileValue(left.expression);
        const component =
            record.recordProperties?.[left.name.text];
        if (!component || component.kind !== "number") {
            context.fail(
                left.name,
                `Unsupported camera target component '${left.name.text}'.`,
            );
        }
        context.emit(
            `${component.cpp} ${operator} ${context.compileNumber(expression.right)};`,
        );
        return;
    }
    if (ts.isIdentifier(left.expression)) {
        const target = context.lookup(left.expression);
        const property = left.name.text;

        if (
            target.kind === "scene" &&
            property === "clearColor"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "scene clearColor",
            );
            context.emit(
                `${target.cpp}.clear_color = ${context.compileColor4(expression.right)};`,
            );
            return;
        }

        if (
            target.kind === "scene" &&
            property === "camera"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "scene camera",
            );
            const camera = context.compileValue(
                expression.right,
            );
            context.expectKind(
                camera,
                "camera",
                expression.right,
            );
            context.emit(
                `${target.cpp}.camera = ${camera.cpp};`,
            );
            return;
        }

        if (
            target.kind === "scene" &&
            property === "fixedDeltaMs"
        ) {
            context.emit(
                `${target.cpp}.fixed_delta_ms ${operator} ${context.compileNumber(expression.right)};`,
            );
            return;
        }

        if (
            target.kind === "mesh" &&
            property === "material"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "mesh material",
            );
            const material = context.compileValue(
                expression.right,
            );
            context.expectKind(
                material,
                "material",
                expression.right,
            );
            context.expectSameEngine(
                target,
                material,
                expression,
            );
            context.emit(
                `${context.requireEngine(target, expression)}.meshes[${target.cpp}.value].material = ${material.cpp};`,
            );
            return;
        }

        if (
            target.kind === "material" &&
            property === "diffuseColor"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "material diffuseColor",
            );
            context.emit(
                `${context.requireEngine(target, expression)}.materials[${target.cpp}.value].diffuse_color = ${context.compileColor3(expression.right)};`,
            );
            return;
        }

        if (
            target.kind === "material" &&
            property === "alpha"
        ) {
            context.emit(
                `${context.requireEngine(target, expression)}.materials[${target.cpp}.value].base_color_factor.a ${operator} ${context.compileNumber(expression.right)};`,
            );
            return;
        }

        if (
            target.kind === "material" &&
            property === "specularColor"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "material specularColor",
            );
            context.emit(
                `${context.requireEngine(target, expression)}.materials[${target.cpp}.value].specular_color = ${context.compileColor3(expression.right)};`,
            );
            return;
        }

        if (
            target.kind === "material" &&
            property === "specularPower"
        ) {
            context.emit(
                `${context.requireEngine(target, expression)}.materials[${target.cpp}.value].specular_power ${operator} ${context.compileNumber(expression.right)};`,
            );
            return;
        }

        if (
            target.kind === "material" &&
            property === "emissiveColor"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "material emissiveColor",
            );
            context.emit(
                `${context.requireEngine(target, expression)}.materials[${target.cpp}.value].emissive_factor = ${context.compileColor3(expression.right)};`,
            );
            return;
        }

        if (
            target.kind === "material" &&
            property === "disableLighting"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "material disableLighting",
            );
            context.emit(
                `${context.requireEngine(target, expression)}.materials[${target.cpp}.value].disable_lighting = ${context.compileBoolean(expression.right)};`,
            );
            return;
        }

        if (
            target.kind === "material" &&
            property === "emissiveTexture"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "material emissiveTexture",
            );
            const texture = context.compileValue(
                expression.right,
            );
            context.expectKind(
                texture,
                "render-texture",
                expression.right,
            );
            context.expectSameEngine(
                target,
                texture,
                expression,
            );
            const engine = context.requireEngine(
                target,
                expression,
            );
            context.emit(
                `${engine}.materials[${target.cpp}.value].emissive_render_texture = ${texture.cpp};`,
            );
            context.emit(
                `${engine}.materials[${target.cpp}.value].has_emissive_render_texture = true;`,
            );
            return;
        }

        if (
            target.kind === "camera" &&
            property === "target"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "camera target",
            );
            context.emit(
                `${context.requireEngine(target, expression)}.cameras[${target.cpp}.value].target = ${context.compileVec3(expression.right)};`,
            );
            return;
        }

        if (
            target.kind === "camera" &&
            [
                "alpha",
                "angularSensitivity",
                "beta",
                "radius",
                "fov",
                "nearPlane",
                "farPlane",
                "speed",
            ].includes(property)
        ) {
            const nativeProperty =
                property === "nearPlane"
                    ? "near_plane"
                    : property === "farPlane"
                      ? "far_plane"
                      : property === "angularSensitivity"
                        ? "angular_sensibility"
                      : property;
            context.emit(
                `${context.requireEngine(target, expression)}.cameras[${target.cpp}.value].${nativeProperty} ${operator} ${context.compileNumber(expression.right)};`,
            );
            return;
        }

        const direct = directPropertyAssignment(
            target,
            property,
        );
        if (direct) {
            if (!direct.supportsCompound) {
                requireSimpleAssignment(
                    context,
                    expression,
                    `${target.kind} ${property}`,
                );
            }
            const value =
                direct.valueKind === "color3"
                    ? context.compileColor3(
                          expression.right,
                      )
                    : context.compileNumber(
                          expression.right,
                      );
            context.emit(
                `${context.requireEngine(target, expression)}.${direct.collection}[${target.cpp}.value].${direct.nativeProperty} ${operator} ${value};`,
            );
            return;
        }
    }

    if (
        ts.isPropertyAccessExpression(left.expression) &&
        ts.isIdentifier(left.expression.expression) &&
        ["position", "rotation", "scaling"].includes(
            left.expression.name.text,
        )
    ) {
        const mesh = context.lookup(
            left.expression.expression,
        );
        context.expectKind(
            mesh,
            "mesh",
            left.expression.expression,
        );
        const axis = { x: 0, y: 1, z: 2 }[
            left.name.text as "x" | "y" | "z"
        ];
        if (axis === undefined) {
            context.fail(
                left.name,
                `Unsupported rotation axis '${left.name.text}'.`,
            );
        }
        const component = ["x", "y", "z"][axis]!;
        context.emit(
            `${context.requireEngine(mesh, expression)}.meshes[${mesh.cpp}.value].${left.expression.name.text}.${component} ${operator} ${context.compileNumber(expression.right)};`,
        );
        return;
    }

    context.fail(
        left,
        `Unsupported property assignment '${left.getText()}'.`,
    );
}

function assignmentOperator(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
): "=" | "+=" | "-=" {
    switch (expression.operatorToken.kind) {
        case ts.SyntaxKind.EqualsToken:
            return "=";
        case ts.SyntaxKind.PlusEqualsToken:
            return "+=";
        case ts.SyntaxKind.MinusEqualsToken:
            return "-=";
        default:
            return context.fail(
                expression.operatorToken,
                `Unsupported assignment operator '${expression.operatorToken.getText()}'.`,
            );
    }
}

function requireSimpleAssignment(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
    target: string,
): void {
    if (
        expression.operatorToken.kind !==
        ts.SyntaxKind.EqualsToken
    ) {
        context.fail(
            expression.operatorToken,
            `Compound assignment is not supported for ${target}.`,
        );
    }
}
import ts from "typescript";
import type {
    Feature,
    LightKind,
    Value,
    ValueKind,
} from "./types.js";
