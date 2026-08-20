export type AssignmentValueKind =
    | "color3"
    | "number";

export interface DirectPropertyAssignment {
    collection: "lights";
    nativeProperty: string;
    valueKind: AssignmentValueKind;
    supportsCompound: boolean;
}

/**
 * Property writes that store one value into one field of an engine
 * record. They differ only in which record, which field, and how the
 * right-hand side compiles, so they are declared rather than repeated:
 * the ceremony around them (resolving the engine, rejecting a compound
 * assignment where JavaScript semantics need a fresh value) was identical
 * in every copy.
 *
 * `simpleOnly` marks the fields where `+=` has no meaning because the
 * value is a colour or a flag rather than an accumulating number.
 */
interface RecordFieldAssignment {
    kind: "material" | "camera-ortho";
    property: string;
    collection: "materials" | "cameras";
    field: string;
    value: "color3" | "number" | "boolean";
    simpleOnly?: boolean;
    /** Stored as the logical inverse of what the source assigns. */
    invert?: boolean;
}

const recordFieldAssignments: readonly RecordFieldAssignment[] = [
    {
        kind: "material",
        property: "diffuseColor",
        collection: "materials",
        field: "diffuse_color",
        value: "color3",
        simpleOnly: true,
    },
    {
        kind: "material",
        property: "specularColor",
        collection: "materials",
        field: "specular_color",
        value: "color3",
        simpleOnly: true,
    },
    {
        kind: "material",
        property: "emissiveColor",
        collection: "materials",
        field: "emissive_factor",
        value: "color3",
        simpleOnly: true,
    },
    {
        kind: "material",
        property: "alpha",
        collection: "materials",
        field: "base_color_factor.a",
        value: "number",
    },
    {
        kind: "material",
        property: "specularPower",
        collection: "materials",
        field: "specular_power",
        value: "number",
    },
    {
        kind: "material",
        property: "disableLighting",
        collection: "materials",
        field: "disable_lighting",
        value: "boolean",
        simpleOnly: true,
    },
    {
        // src/material/standard/create-standard-material.ts defaults
        // `backFaceCulling: true`, and standard-pipeline.ts culls with
        // `features & DOUBLE_SIDED ? "none" : "back"`, so the flag is the
        // native `double_sided` inverted.
        kind: "material",
        property: "backFaceCulling",
        collection: "materials",
        field: "double_sided",
        value: "boolean",
        simpleOnly: true,
        invert: true,
    },
    {
        // src/camera/orthographic.ts: the bounds stay live, and its setter
        // only stores the extent and invalidates the projection cache. The
        // native projection is rebuilt from the record every frame, so
        // storing it is the whole contract.
        kind: "camera-ortho",
        property: "halfHeight",
        collection: "cameras",
        field: "ortho_half_height",
        value: "number",
    },
];

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
    context.reachFeature("renderer:pbr", expression);
    context.reachFeature("renderer:transmission", expression);
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
    // A spot light carries the same colour pair as the other positional
    // kinds. Its `angle`, `exponent` and `range` are settable upstream and
    // are not written by any reached scene, so they stay unlowered and fail
    // explicitly rather than being accepted and ignored.
    spot: {
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

/**
 * The light vectors a scene may write after creation, beside the scalar and
 * colour properties above and for the same reason: a kind carries the vectors
 * its pinned type declares, and one no reached scene writes stays unlowered
 * and fails explicitly rather than being accepted and ignored.
 *
 * `light.position.set(x, y, z)` is not a record-field write like the entries
 * above — an `ObservableVec3` write also marks the light's local matrix
 * dirty — so each of these lowers to its own kind's emitted entry point
 * rather than to a `DirectPropertyAssignment`. `LightLowerer` emits exactly
 * these, checked against the pinned factory's own `ObservableVec3`
 * properties.
 */
const lightVectors: Readonly<Record<LightKind, readonly string[]>> = {
    // No reached scene writes a hemispheric direction or a point position.
    hemispheric: [],
    point: [],
    directional: ["position"],
    spot: ["position", "direction"],
};

/** The emitted entry point for `light.<vector>.set(...)`, if there is one. */
export function lightVectorSetter(
    owner: Value,
    vector: string,
): string | undefined {
    if (owner.kind !== "light" || !owner.lightKind) {
        return undefined;
    }
    return lightVectors[owner.lightKind].includes(vector)
        ? `set_${owner.lightKind}_light_${vector}`
        : undefined;
}

export interface AssignmentContext {
    lookup(identifier: ts.Identifier): Value;
    compileValue(expression: ts.Expression): Value;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileBoolean(expression: ts.Expression): string;
    compileColor3(expression: ts.Expression): string;
    compileColor4(expression: ts.Expression): string;
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
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
    /**
     * Records the feature and its first reaching scene-source call
     * site (here the assignment expression), so the activation
     * inventory can cite file:line.
     */
    reachFeature(feature: Feature, site: ts.Node): void;
    fail(node: ts.Node, message: string): never;
}

/**
 * `scene.lights.length = 0` empties the scene's light list, which is how a
 * scene drops the lights a loaded asset brought with it and lights itself
 * from the environment alone. Only the clear is lowered: truncating to a
 * non-zero length would have to decide which handles survive, and no reached
 * scene asks for it.
 */
function emitSceneLightListClear(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
    left: ts.PropertyAccessExpression,
): boolean {
    if (
        left.name.text !== "length" ||
        !ts.isPropertyAccessExpression(left.expression) ||
        left.expression.name.text !== "lights"
    ) {
        return false;
    }
    const owner = context.compileValue(
        left.expression.expression,
    );
    if (owner.kind !== "scene") {
        return false;
    }
    requireSimpleAssignment(
        context,
        expression,
        "scene light list length",
    );
    if (
        !ts.isNumericLiteral(expression.right) ||
        Number(expression.right.text) !== 0
    ) {
        context.fail(
            expression.right,
            "Reached scene light list assignment supports clearing to zero.",
        );
    }
    context.emit(`${owner.cpp}.lights.clear();`);
    return true;
}

/**
 * A post-process effect's own settable option.
 *
 * The pin gives each one a `defineProperty` pair over the factory's `params`
 * record, so a write is a store into that record and nothing else -- the
 * uniform block moves only when `updateUniforms` runs. Native keeps the same
 * split: the parameter vector takes the value here, and the backend rewrites
 * the block when the pass is next recorded.
 */
function emitPostProcessOptionAssignment(
    context: AssignmentContext,
    expression: ts.BinaryExpression,
    left: ts.PropertyAccessExpression,
    owner: Value,
): boolean {
    if (owner.kind === "task" && owner.postProcessComposite) {
        // The pin publishes setters on a composite too, but each writes a
        // parameter on a pass its own factory built, and generation baked
        // those in. Refusing says so rather than writing a slot that is not
        // the one the pin would have moved.
        context.fail(
            left,
            `'${left.name.text}' is a setter on a composite post-process ` +
                "task, which this port bakes at generation.",
        );
    }
    if (owner.kind !== "task" || !owner.postProcessTask) {
        return false;
    }
    const effect = postProcessEffect(owner.postProcessTask.intrinsic);
    const slot = effect?.params.findIndex(
        (candidate) => candidate.path === left.name.text,
    );
    if (!effect || slot === undefined || slot < 0) {
        context.fail(
            left,
            `Post-process effect '${
                owner.postProcessTask.intrinsic
            }' has no settable option '${left.name.text}'.`,
        );
    }
    requireSimpleAssignment(
        context,
        expression,
        "post-process option",
    );
    // A plain effect is a task recording one pass, so its parameter vector is
    // that pass's. A composite's would be several, which is why a setter on
    // one is refused above.

    context.emit(
        `${context.requireEngine(owner, expression)}.frame_tasks[${
            owner.cpp
        }.value].post_process.passes[0].params[${slot}] = ${context.compileNumber(
            expression.right,
            "double",
        )};`,
    );
    return true;
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
    if (emitSceneLightListClear(context, expression, left)) {
        return;
    }
    if (
        ts.isIdentifier(left.expression) &&
        emitPostProcessOptionAssignment(
            context,
            expression,
            left,
            context.lookup(left.expression),
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
        const nativeProperty =
            cameraRecordField(property);
        if (!nativeProperty) {
            context.fail(
                left.name,
                `Unsupported camera property '${property}'.`,
            );
        }
        context.emit(
            `${context.requireEngine(scene, expression)}.cameras[${scene.cpp}.camera.value].${nativeProperty} ${operator} ${context.compileNumber(expression.right, "double")};`,
        );
        return;
    }
    if (
        left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
        // A resource field write — the engine, the scene, a material.
        // Data fields never reach here: they resolve as data paths
        // above and assign through the local that holds them.
        //
        // A resource field has no storage to assign through, only a
        // compile-time binding, so it may be written exactly once. A
        // second write inside a branch would otherwise make the new
        // value visible on every path, which is a different program.
        const instance = context.compileValue(
            left.expression,
        );
        const fields = instance.recordProperties;
        if (!fields) {
            context.fail(
                left,
                "'this' does not resolve to a class instance here.",
            );
        }
        if (fields[left.name.text]) {
            context.fail(
                expression,
                `Field '${left.name.text}' is already bound; a class field that holds a resource is wired once and cannot be reassigned.`,
            );
        }
        fields[left.name.text] = context.compileValue(
            expression.right,
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
            `${component.cpp} ${operator} ${context.compileNumber(expression.right, "double")};`,
        );
        return;
    }
    // A scene may widen the target before writing a property the narrow
    // type does not carry -- `(sphere as { material?: unknown }).material`
    // is how the corpus assigns a node material to a mesh. The cast is a
    // type-level annotation with no value, so the target it names is the
    // expression underneath it.
    const targetExpression = context.unwrap(left.expression);
    if (ts.isIdentifier(targetExpression)) {
        const target = context.lookup(targetExpression);
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
            // The pin's opt-in setters take the material back off the mesh
            // (`setPbrSkybox(box.material)`) and mutate the same object, so
            // the mesh carries which scene material it was given and a
            // later read of `mesh.material` resolves that record.
            if (material.scenePbrMaterialIndex !== undefined) {
                target.scenePbrMaterialIndex =
                    material.scenePbrMaterialIndex;
            }
            return;
        }

        if (
            target.kind === "mesh" &&
            property === "morphTargets"
        ) {
            requireSimpleAssignment(
                context,
                expression,
                "mesh morphTargets",
            );
            if (!target.directMorphCompatible) {
                context.fail(
                    left.expression,
                    "Direct morph targets require a compiler-created mesh.",
                );
            }
            const morph = context.compileValue(
                expression.right,
            );
            context.expectKind(
                morph,
                "morph-targets",
                expression.right,
            );
            context.expectSameEngine(
                target,
                morph,
                expression,
            );
            if (!morph.morphTarget) {
                context.fail(
                    expression.right,
                    "Morph target data is incomplete.",
                );
            }
            if (morph.morphTarget.meshCpp) {
                context.fail(
                    expression.right,
                    "Direct morph target data can be attached to one mesh.",
                );
            }
            const engine = context.requireEngine(
                target,
                expression,
            );
            context.emit(
                `bbl::attach_morph_target(${engine}, ${target.cpp}, ` +
                    `${morph.morphTarget.positionsCpp}, ` +
                    `${morph.morphTarget.normalsCpp}, ` +
                    `${morph.morphTarget.vertexCountCpp}, ` +
                    `${morph.morphTarget.weightCpp});`,
            );
            morph.morphTarget.meshCpp = target.cpp;
            context.reachFeature("mesh:morph-targets", expression);
            return;
        }

        const recordField = recordFieldAssignments.find(
            (candidate) =>
                candidate.kind === target.kind &&
                candidate.property === property,
        );
        if (recordField) {
            if (recordField.simpleOnly) {
                requireSimpleAssignment(
                    context,
                    expression,
                    `${recordField.kind} ${recordField.property}`,
                );
            }
            const value =
                recordField.value === "color3"
                    ? context.compileColor3(expression.right)
                    : recordField.value === "boolean"
                      ? context.compileBoolean(expression.right)
                      : context.compileNumber(
                            expression.right,
                            recordField.collection === "cameras"
                                ? "double"
                                : "float",
                        );
            const stored = recordField.invert
                ? `!(${value})`
                : value;
            context.emit(
                `${context.requireEngine(target, expression)}.${recordField.collection}[${target.cpp}.value].${recordField.field} ` +
                    `${recordField.simpleOnly ? "=" : operator} ${stored};`,
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
                `${context.requireEngine(target, expression)}.cameras[${target.cpp}.value].target = ${context.compileVec3(expression.right, "double")};`,
            );
            return;
        }

        if (target.kind === "camera") {
            const nativeProperty =
                cameraRecordField(property);
            if (nativeProperty) {
                context.emit(
                    `${context.requireEngine(target, expression)}.cameras[${target.cpp}.value].${nativeProperty} ${operator} ${context.compileNumber(expression.right, "double")};`,
                );
                return;
            }
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
        ["position", "rotation", "scaling"].includes(
            left.expression.name.text,
        )
    ) {
        // The owner is compiled rather than looked up, so a mesh read
        // out of the data model (a handle stored in a struct or array)
        // writes its transform exactly like a mesh local.
        const mesh = context.compileValue(
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
        const engine = context.requireEngine(
            mesh,
            expression,
        );
        context.emit(
            `${engine}.meshes[${mesh.cpp}.value].${left.expression.name.text}.${component} ${operator} ${context.compileNumber(expression.right)};`,
        );
        // The transform version is what the backends gate their baked
        // vertex re-upload on (the pinned property-animation evaluator
        // bumps it the same way), so a transform written outside the
        // animation path has to mark itself dirty too.
        context.emit(
            `++${engine}.meshes[${mesh.cpp}.value].transform_version;`,
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
import { cameraRecordField } from "./properties.js";
import { postProcessEffect } from "../post-process-effects.js";
import type {
    Feature,
    LightKind,
    Value,
    ValueKind,
} from "./types.js";
