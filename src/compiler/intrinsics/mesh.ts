import { EmissionSet, EmissionMap, EmissionWeakSet } from "../emission-transaction.js";
import type { LoweringServices } from "../lowering-services.js";
import ts from "typescript";
import { argumentAt } from "../syntax.js";
import { compileBakedMesh } from "../baked-mesh.js";



import type { Value } from "../types.js";
import { handleCppType } from "../data-types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    staticNumberValue,
    validateObjectProperties,
    type ObjectValidationContext,
    type PositiveIntegerContext,
} from "../option-helpers.js";
import {
    BOX_OPTION_NAMES,
    GROUND_OPTION_DEFAULTS,
    SPHERE_OPTION_NAMES,
} from "./mesh-options.js";
import {
    transformNodeDefaults,
    type TransformNodeParameter,
} from "../../pinned-mesh-defaults.js";
import { doubleLiteral, floatLiteral } from "../../cpp-literals.js";
import {
    pinnedMeshOptionDefault,
    pinnedMeshOptionFlag,
    pinnedParameterFlag,
} from "../../pinned-mesh-defaults.js";
import {
    pinnedPolyhedron,
    pinnedPolyhedronCount,
} from "../../pinned-polyhedra.js";
import {
    bakeCsgMesh,
    csgBooleanNames,
    type CsgSolidPlan,
    type CsgSourceMesh,
} from "../../pinned-csg.js";
import { bakeCsg2Meshes, csg2BooleanNames, csg2MaterialSlotCount, type Csg2SolidPlan } from "../../pinned-csg2.js";

/**
 * Native math and instance-buffer work: these may record reached stream facts,
 * but allocate no generation-owned mesh/material/asset ordinal. Keep that
 * distinction separate from runtimeOnlyIntrinsics, whose calls record no facts.
 */
export const nativeMeshDataIntrinsics: ReadonlySet<string> = new EmissionSet([
    "createTransformNode",
    "mat4Identity",
    "mat4Compose",
    "mat4Invert",
    "setThinInstanceMatrix",
    "setThinInstanceColors",
    "setThinInstanceColor",
    "setThinInstanceCullBoundsPad",
    "setThinInstanceCount",
    "flushThinInstances",
    "addThinInstance",
    "removeThinInstance",
]);

export interface MeshIntrinsicContext
    extends IntrinsicCallContext,
    ObjectValidationContext,
    PositiveIntegerContext,
    Pick<LoweringServices,
        | "dataTypes"
        | "recordSceneMeshMaterial"
        | "compileBoxOptions"
        | "compileGroundOptions"
        | "compileGroundFromHeightMapOptions"
        | "registerAsset"
        | "cppString"
        | "requireDefaultEngine"
        | "compilePlaneOptions"
        | "compileSphereOptions"
        | "compileTorusOptions"
        | "compileTypedArrayArgument"
        | "compileStringLiteral"
        | "compileVec3"
        | "vec3FromRecord"
        | "compileNumber"
        | "compileCondition"
        | "reachJsData"
        | "expectObjectLiteral"
        | "expectStaticArrayLiteral"
        | "objectProperty"
        | "allocateTemporaryCppName"
        | "emit"
        | "isEntryBodyScope"
        | "recordThinInstanceMesh"
        | "recordThinInstanceColorMesh"
        | "recordThinInstanceGpuCulling"
        | "meshHasThinInstancePool"
        | "meshMayHaveThinInstanceGpuCulling"
        | "requireEngine"
        | "expectSameEngine"
        | "markAssetRootReparented"
        | "assertAssetRootWritable"
        | "unwrap"
        | "resolveStaticExpression"
        | "symbols"
        | "handleCollections"
        | "fail"
    > {}

function writableVec3Lanes(
    context: MeshIntrinsicContext,
    value: Value,
    node: ts.Node,
): [string, string, string] {
    if (value.kind === "record") {
        const lanes = ["x", "y", "z"].map(
            (name) => value.recordProperties?.[name],
        );
        if (
            lanes.every(
                (lane) => lane?.kind === "number" && lane.cpp.length > 0,
            )
        ) {
            return lanes.map((lane) => lane!.cpp) as [
                string,
                string,
                string,
            ];
        }
    }
    if (value.kind === "data" && value.dataType?.kind === "struct") {
        const dataType = value.dataType;
        const separator = context.dataTypes.isReferenceStruct(
            dataType.name,
        )
            ? "->"
            : ".";
        return ["x", "y", "z"].map((name) => {
            const field = context.dataTypes.structField(
                dataType.name,
                name,
                node,
            );
            return `${value.cpp}${separator}${field.name}`;
        }) as [string, string, string];
    }
    return context.fail(
        node,
        "A Vec3 *ToRef output must be a writable Vec3 record.",
    );
}

function writeVec3Lanes(
    context: MeshIntrinsicContext,
    output: Value,
    outputNode: ts.Node,
    components: readonly [string, string, string],
): void {
    const lanes = writableVec3Lanes(context, output, outputNode);
    for (let index = 0; index < 3; index += 1) {
        context.emit(`${lanes[index]} = ${components[index]};`);
    }
}

function compileVec3Temporary(
    context: MeshIntrinsicContext,
    expression: ts.Expression,
    label: string,
): string {
    const value = context.compileValue(expression);
    const temporary =
        context.allocateTemporaryCppName(label);
    context.emit(
        `const bbl::Vec3d ${temporary} = ` +
            `${context.vec3FromRecord(value, expression, "double")};`,
    );
    return temporary;
}

type BinaryVec3Intrinsic =
    | "addVec3"
    | "addVec3ToRef"
    | "subVec3"
    | "subVec3ToRef"
    | "crossVec3"
    | "crossVec3ToRef";

function binaryVec3Components(
    intrinsic: BinaryVec3Intrinsic,
    left: string,
    right: string,
): [string, string, string] {
    if (intrinsic === "addVec3" || intrinsic === "addVec3ToRef") {
        return [
            `${left}.x + ${right}.x`,
            `${left}.y + ${right}.y`,
            `${left}.z + ${right}.z`,
        ];
    }
    if (intrinsic === "subVec3" || intrinsic === "subVec3ToRef") {
        return [
            `${left}.x - ${right}.x`,
            `${left}.y - ${right}.y`,
            `${left}.z - ${right}.z`,
        ];
    }
    return [
        `${left}.y * ${right}.z - ${left}.z * ${right}.y`,
        `${left}.z * ${right}.x - ${left}.x * ${right}.z`,
        `${left}.x * ${right}.y - ${left}.y * ${right}.x`,
    ];
}

function vec3Record(cpp: string): Value {
    return {
        kind: "record",
        cpp: "",
        recordProperties: {
            x: { kind: "number", cpp: `${cpp}.x` },
            y: { kind: "number", cpp: `${cpp}.y` },
            z: { kind: "number", cpp: `${cpp}.z` },
        },
    };
}

function quatRecord(cpp: string): Value {
    return {
        kind: "record",
        cpp: "",
        recordProperties: {
            x: { kind: "number", cpp: `${cpp}[0]` },
            y: { kind: "number", cpp: `${cpp}[1]` },
            z: { kind: "number", cpp: `${cpp}[2]` },
            w: { kind: "number", cpp: `${cpp}[3]` },
        },
    };
}

/** A Vec3d expression from a statically known path element: its x/y/z lanes
 *  at JS-double width, through the compiler's one record-to-vector home. */
function vec3RecordCpp(
    context: MeshIntrinsicContext,
    element: Value,
    node: ts.Node,
): string {
    if (
        element.kind !== "record" &&
        !(
            element.kind === "data" &&
            element.dataType?.kind === "struct"
        )
    ) {
        context.fail(
            node,
            `Tube path elements must be Vec3 records, received ${element.kind}.`,
        );
    }
    return context.vec3FromRecord(element, node, "double");
}

/**
 * One list of Vec3 PATHS, however the scene spelled it.
 *
 * The same two spellings `compileVec3Path` answers for, one level up: rows
 * written inline as compile-time lists, or rows a loop grew under a
 * `Vec3[][]` annotation, which the data model materializes under the
 * scene's own record type.
 */
function compileVec3PathArray(
    context: MeshIntrinsicContext,
    expression: ts.Expression,
): string {
    const rows = context.handleCollections.tupleElements(expression);
    if (rows) {
        return (
            `std::vector<std::vector<bbl::Vec3d>>{${rows
                .map((row) => {
                    const points =
                        row.tupleElements ??
                        row.staticElementsOwner?.staticElements ??
                        row.staticElements;
                    return points
                        ? vec3PointsCpp(
                              context,
                              points,
                              expression,
                          )
                        : context.fail(
                              expression,
                              "Each ribbon path must be a list of Vec3 " +
                                  "records.",
                          );
                })
                .join(", ")}}`
        );
    }
    const value = context.compileValue(expression);
    return value.kind === "data"
        ? `bbl::vec3_paths(${value.cpp})`
        : context.fail(
              expression,
              "A ribbon's pathArray must be a list of Vec3 paths.",
          );
}

/** A braced list of Vec3 records, from compile-time element values. */
function vec3PointsCpp(
    context: MeshIntrinsicContext,
    points: readonly Value[],
    node: ts.Node,
): string {
    return `{${points
        .map((point) => vec3RecordCpp(context, point, node))
        .join(", ")}}`;
}

/**
 * One path of Vec3 points, however the scene spelled it.
 *
 * A compile-time list emits its points as a braced literal; a list the data
 * model materialized converts through `vec3_path`, which reads the same
 * three components off whatever record type the scene's annotation
 * produced.
 */
function compileVec3Path(
    context: MeshIntrinsicContext,
    expression: ts.Expression,
): string {
    const bound =
        context.handleCollections.tupleElements(expression);
    if (bound) {
        return `std::vector<bbl::Vec3d>${vec3PointsCpp(
            context,
            bound,
            expression,
        )}`;
    }
    const value = context.compileValue(expression);
    if (value.kind === "data") {
        return `bbl::vec3_path(${value.cpp})`;
    }
    return (
        `std::vector<bbl::Vec3d>{${context
            .expectStaticArrayLiteral(
                context.resolveStaticExpression(expression),
            )
            .elements.map((element) =>
                context.compileVec3(element, "double"),
            )
            .join(", ")}}`
    );
}

/**
 * The generation-known options a CSG source mesh was built with.
 *
 * The bake replays the pinned factory with these values, so an option that
 * does not settle to a number leaves the descriptor unbuilt and the CSG
 * call refuses by name. The names come from the one list the native
 * builder validates against, so an option this reader silently ignored
 * could not stop reaching the geometry.
 */
function csgOptionBag<Name extends string>(
    context: MeshIntrinsicContext,
    object: ts.ObjectLiteralExpression,
    names: readonly Name[],
): Partial<Record<Name, number>> | undefined {
    const options: Partial<Record<Name, number>> = {};
    for (const name of names) {
        const property = context.objectProperty(object, name);
        if (!property) continue;
        const value = staticNumberValue(
            context,
            context.unwrap(property),
        );
        if (value === undefined) return undefined;
        options[name] = value;
    }
    return options;
}

/**
 * The builder call a CSG source mesh came from, wherever the scene spelled
 * it.
 *
 * `createCsgFromMesh` reads a mesh's retained CPU geometry and bakes its
 * world matrix into every polygon, so generation has to replay the pinned
 * factory that built it AND know the mesh still stands where that factory
 * left it. One question decides both: which call produced this argument.
 *
 * Two spellings answer it. The argument may BE the builder call, which
 * nothing can have moved yet. Or it may name a local binding whose
 * initializer is that call and whose only prior uses assign its material.
 * Material setters do not alter geometry or the world transform; a `position` write, a
 * helper handed the mesh, or a callback closing over it all mention the
 * binding earlier. Naming the builder CALL rather than reading a
 * descriptor off the mesh's own value is what closes the other direction:
 * a helper that creates a mesh, moves it and returns it hands back a value
 * whose builder call this never sees.
 *
 * Everything else -- a parameter, a helper's return, a collection element
 * -- refuses by name rather than being baked at a transform generation
 * would have had to track.
 */
function csgSourceCall(
    context: MeshIntrinsicContext,
    argument: ts.Expression,
): ts.CallExpression | undefined {
    const expression = context.unwrap(argument);
    if (ts.isCallExpression(expression)) return expression;
    if (!ts.isIdentifier(expression)) return undefined;
    const source = expression.getSourceFile();
    const limit = expression.getStart(source);
    const symbol = context.symbols.valueSymbol(expression);
    if (!symbol) return undefined;
    const earlier: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
        // A subtree starting at or after this argument can hold no
        // earlier occurrence, so the walk stops at the call.
        if (node.getStart(source) >= limit) return;
        if (ts.isIdentifier(node) && node.text === expression.text &&
            context.symbols.valueSymbol(node) === symbol) {
            // Material writes cannot change retained geometry or the world
            // transform. Every other previous use still withdraws the proof.
            const property = node.parent;
            const assignment = property?.parent;
            if (!(ts.isPropertyAccessExpression(property) && property.expression === node &&
                property.name.text === "material" && ts.isBinaryExpression(assignment) &&
                assignment.left === property && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken)) {
                earlier.push(node);
            }
        }
        node.forEachChild(visit);
    };
    visit(source);
    const declaration = earlier[0]?.parent;
    if (
        earlier.length !== 1 ||
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        declaration.name !== earlier[0] ||
        !declaration.initializer
    ) {
        return undefined;
    }
    const initializer = context.unwrap(declaration.initializer);
    return ts.isCallExpression(initializer) ? initializer : undefined;
}

/** The descriptor a builder call carries, by its resolved import symbol. */
function csgSourceFromCall(
    context: MeshIntrinsicContext,
    call: ts.CallExpression,
): CsgSourceMesh | undefined {
    const callee = context.unwrap(call.expression);
    const factory = ts.isIdentifier(callee)
        ? context.symbols.importedName(callee)
        : undefined;
    const options = call.arguments[1];
    if (factory === "createBox") {
        if (!options) return { factory, options: 1 };
        const unwrapped = context.unwrap(options);
        if (!ts.isObjectLiteralExpression(unwrapped)) {
            // `createBox(engine, size)`, the pin's own shorthand.
            const size = staticNumberValue(context, unwrapped);
            return size === undefined
                ? undefined
                : { factory, options: size };
        }
        const bag = csgOptionBag(context, unwrapped, BOX_OPTION_NAMES);
        return bag && { factory, options: bag };
    }
    if (factory === "createSphere") {
        if (!options) return { factory, options: {} };
        const unwrapped = context.unwrap(options);
        if (!ts.isObjectLiteralExpression(unwrapped)) return undefined;
        const bag = csgOptionBag(
            context,
            unwrapped,
            SPHERE_OPTION_NAMES,
        );
        return bag && { factory, options: bag };
    }
    return undefined;
}

/** The solid a `CsgSolid`-kinded value stands for, or a refusal. */
function requireCsgSolid(
    context: MeshIntrinsicContext,
    argument: ts.Expression,
): CsgSolidPlan {
    const value = context.compileValue(argument);
    context.expectKind(value, "csg-solid", argument);
    if (!value.csgSolid) {
        context.fail(
            argument,
            "This CSG solid carries no generation-known plan.",
        );
    }
    return value.csgSolid;
}

const initializedCsg2Contexts = new EmissionWeakSet<MeshIntrinsicContext>();
const csg2Intrinsics: ReadonlySet<string> = new EmissionSet([
    "initializeCsg2Async", "isCsg2Ready", "createCsg2FromMesh", "disposeCsg2",
    "createMeshFromCsg2", "createMeshesFromCsg2", ...csg2BooleanNames,
]);

function requireCsg2Solid(context: MeshIntrinsicContext, argument: ts.Expression): Csg2SolidPlan {
    const value = context.compileValue(argument);
    context.expectKind(value, "csg2-solid", argument);
    if (!value.csg2Solid || value.csg2Solid.disposed) {
        context.fail(argument, "CSG2 requires a live generation-known solid; this solid is absent or disposed.");
    }
    return value.csg2Solid.plan;
}

export function compileMeshIntrinsic(
    context: MeshIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    if (csg2Intrinsics.has(importedName) && context.isRuntimeResourceConstruction()) {
        context.fail(call, "CSG2 modelling and lifetime require unconditional generation-known execution; runtime branches, loops and callbacks are unsupported.");
    }
    return meshIntrinsicHandlers.get(importedName)?.(context, call);
}

/**
 * Whether `new Float32Array([...])` names only compile-time constants.
 *
 * The question a static binding turns on: a pool of literals is the same
 * bytes on every evaluation, so binding it once is the whole of its
 * meaning; a pool built from run-time values is not.
 */
function staticFloatArrayArgument(
    context: MeshIntrinsicContext,
    argument: ts.Expression,
): boolean {
    const literal = ts.isNewExpression(argument) &&
        argument.arguments?.length === 1
        ? context.resolveStaticExpression(argumentAt(argument, 0))
        : context.resolveStaticExpression(argument);
    if (!ts.isArrayLiteralExpression(literal)) return false;
    return literal.elements.every((element) => {
        const resolved = context.resolveStaticExpression(element);
        return (
            ts.isNumericLiteral(resolved) ||
            (ts.isPrefixUnaryExpression(resolved) &&
                resolved.operator === ts.SyntaxKind.MinusToken &&
                ts.isNumericLiteral(resolved.operand))
        );
    });
}

function compileInitializeCsg2Async(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 0, 0);
    initializedCsg2Contexts.add(context);
    context.reachFeature("mesh:csg2", call);
    return { kind: "void", cpp: "" };
}

function compileIsCsg2Ready(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 0, 0);
    const ready = initializedCsg2Contexts.has(context);
    return { kind: "boolean", cpp: String(ready), staticBoolean: ready };
}

function compileCreateCsg2FromMesh(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 1, 2);
    if (!initializedCsg2Contexts.has(context))
        context.fail(call, "CSG2 requires initializeCsg2Async before creating a solid.");
    const mesh = context.compileValue(argumentAt(call, 0));
    context.expectKind(mesh, "mesh", argumentAt(call, 0));
    const builder = csgSourceCall(context, argumentAt(call, 0));
    const source = builder && csgSourceFromCall(context, builder);
    if (!source)
        context.fail(argumentAt(call, 0), "createCsg2FromMesh requires an unchanged identity-transform createBox/createSphere with generation-known options; only preceding material assignments are permitted.");
    const materialSlot = call.arguments[1] ? staticNumberValue(context, context.unwrap(call.arguments[1])) : 0;
    const slotCount = csg2MaterialSlotCount();
    if (materialSlot === undefined || !Number.isInteger(materialSlot) || materialSlot < 0 || materialSlot >= slotCount) {
        context.fail(call.arguments[1] ?? call, `A CSG2 material slot must be a generation-known integer in [0, ${slotCount - 1}].`);
    }
    context.reachFeature("mesh:csg2", call);
    return { kind: "csg2-solid", cpp: "", csg2Solid: { plan: { op: "from-mesh", source, materialSlot }, disposed: false } };
}

function compileCsg2Subtract(context: MeshIntrinsicContext, call: ts.CallExpression, importedName: "csg2Subtract" | "csg2Intersect" | "csg2Add"): Value | undefined {
    context.expectArgumentCount(call, 2, 2);
    const left = requireCsg2Solid(context, argumentAt(call, 0));
    const right = requireCsg2Solid(context, argumentAt(call, 1));
    context.reachFeature("mesh:csg2", call);
    return { kind: "csg2-solid", cpp: "", csg2Solid: { plan: { op: importedName, left, right }, disposed: false } };
}

function compileDisposeCsg2(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 1, 1);
    const value = context.compileValue(argumentAt(call, 0));
    context.expectKind(value, "csg2-solid", argumentAt(call, 0));
    if (!value.csg2Solid)
        context.fail(call, "CSG2 disposal requires a generation-known solid.");
    value.csg2Solid.disposed = true;
    context.reachFeature("mesh:csg2", call);
    return { kind: "void", cpp: "" };
}

function compileCreateMeshFromCsg2(context: MeshIntrinsicContext, call: ts.CallExpression, importedName: "createMeshFromCsg2" | "createMeshesFromCsg2"): Value | undefined {
    const partitioned = importedName === "createMeshesFromCsg2";
    context.expectArgumentCount(call, partitioned ? 3 : 2, partitioned ? 4 : 3);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const plan = requireCsg2Solid(context, argumentAt(call, 1));
    const materials = partitioned ? context.handleCollections.staticHandleList(argumentAt(call, 2)) : undefined;
    if (partitioned && !materials)
        context.fail(argumentAt(call, 2), "CSG2 material partitioning requires a generation-known material list.");
    for (const material of materials ?? []) {
        context.expectKind(material.value, "material", material.node);
        context.expectSameEngine(engine, material.value, material.node);
        if (!material.value.standardMaterial)
            context.fail(material.node, "CSG2 material partitioning currently requires Standard materials.");
    }
    const nameArgument = call.arguments[partitioned ? 3 : 2];
    const name = nameArgument ? context.compileValue(nameArgument).staticString : "csg2";
    if (name === undefined)
        context.fail(nameArgument ?? call, "A CSG2 output name must be generation-known.");
    const baked = (() => {
        try {
            return bakeCsg2Meshes({ plan, name, ...(materials ? { materialCount: materials.length } : {}) });
        }
        catch (error) {
            if (error instanceof Error)
                context.fail(call, error.message);
            throw error;
        }
    })();
    const meshes: Value[] = [];
    for (const output of baked) {
        const geometry = compileBakedMesh(context, output.geometry);
        const sceneMeshIndex = context.recordSceneMesh("from-data", { hasUv2: false, hasTangents: false, hasColors: false });
        const cpp = context.allocateTemporaryCppName("csg2_mesh");
        context.emit({ kind: "declaration", type: "auto", name: cpp, initializer: `bbl::create_mesh_from_data(${engine.cpp}, ${context.cppString(output.name)}, ${geometry.positions}, ${geometry.normals}, ${geometry.indices}, ${geometry.uvs}, {}, {}, {})` });
        const material = output.materialSlot === undefined ? undefined : materials?.[output.materialSlot]?.value;
        if (partitioned && !material)
            context.fail(call, "The pinned CSG2 output named an absent material slot.");
        if (material) {
            context.emit(`${engine.cpp}.meshes[${cpp}.value].material = ${material.cpp};`);
            context.recordSceneMeshMaterial(sceneMeshIndex, {
                pbrMaterial: null, nodeMaterial: null, standardMaterial: true,
                standardMaterialPluginIndex: material.standardMaterialPluginIndex,
            });
        }
        meshes.push({ kind: "mesh", cpp, sceneMeshIndex, engineCpp: engine.engineCpp ?? engine.cpp,
            directMorphCompatible: true, ...(material ? { standardMaterial: true, standardMaterialPluginIndex: material.standardMaterialPluginIndex } : {}) });
    }
    context.reachJsData();
    context.reachFeature("mesh:csg2", call);
    context.reachFeature("mesh:from-data", call);
    return partitioned ? { kind: "tuple", cpp: "", tupleElements: meshes } : meshes[0]!;
}

function compileQuatFromLookDirectionRH(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 2, 2);
    context.reachFeature("math:look-direction", call);
    const forward = compileVec3Temporary(context, argumentAt(call, 0), "look_forward");
    const up = compileVec3Temporary(context, argumentAt(call, 1), "look_up");
    const temporary = context.allocateTemporaryCppName("look_quaternion");
    context.emit(`const auto ${temporary} = ` +
        `bbl::upstream::quat_from_look_direction_rh(` +
        `${forward}, ${up});`);
    return quatRecord(temporary);
}

function compileAddVec3(context: MeshIntrinsicContext, call: ts.CallExpression, importedName: "addVec3" | "subVec3" | "crossVec3"): Value | undefined {
    context.expectArgumentCount(call, 2, 2);
    const left = compileVec3Temporary(context, argumentAt(call, 0), "vec3_left");
    const right = compileVec3Temporary(context, argumentAt(call, 1), "vec3_right");
    const temporary = context.allocateTemporaryCppName("vec3_result");
    const components = binaryVec3Components(importedName, left, right);
    context.emit(`const bbl::Vec3d ${temporary}{${components.join(", ")}};`);
    return vec3Record(temporary);
}

function compileAddVec3ToRef(context: MeshIntrinsicContext, call: ts.CallExpression, importedName: "addVec3ToRef" | "subVec3ToRef" | "crossVec3ToRef"): Value | undefined {
    context.expectArgumentCount(call, 3, 3);
    const left = compileVec3Temporary(context, argumentAt(call, 0), "vec3_left");
    const right = compileVec3Temporary(context, argumentAt(call, 1), "vec3_right");
    const output = context.compileValue(argumentAt(call, 2));
    const components = binaryVec3Components(importedName, left, right);
    writeVec3Lanes(context, output, argumentAt(call, 2), components);
    return output;
}

function compileScaleVec3(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 2, 2);
    const vector = compileVec3Temporary(context, argumentAt(call, 0), "scaled_vec3");
    const scalar = context.compileNumber(argumentAt(call, 1), "double");
    const temporary = context.allocateTemporaryCppName("vec3_result");
    context.emit(`const bbl::Vec3d ${temporary}{` +
        `${vector}.x * ${scalar}, ${vector}.y * ${scalar}, ` +
        `${vector}.z * ${scalar}};`);
    return vec3Record(temporary);
}

function compileScaleVec3ToRef(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 3, 3);
    const vector = compileVec3Temporary(context, argumentAt(call, 0), "scaled_vec3");
    const scalarCpp = context.compileNumber(argumentAt(call, 1), "double");
    const scalar = context.allocateTemporaryCppName("vec3_scale");
    context.emit({ kind: "declaration", type: "const double", name: scalar, initializer: scalarCpp });
    const output = context.compileValue(argumentAt(call, 2));
    writeVec3Lanes(context, output, argumentAt(call, 2), [
        `${vector}.x * ${scalar}`,
        `${vector}.y * ${scalar}`,
        `${vector}.z * ${scalar}`,
    ]);
    return output;
}

function compileLerpVec3ToRef(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 4, 4);
    const left = compileVec3Temporary(context, argumentAt(call, 0), "lerp_left");
    const right = compileVec3Temporary(context, argumentAt(call, 1), "lerp_right");
    const amountCpp = context.compileNumber(argumentAt(call, 2), "double");
    const amount = context.allocateTemporaryCppName("lerp_amount");
    context.emit({ kind: "declaration", type: "const double", name: amount, initializer: amountCpp });
    const output = context.compileValue(argumentAt(call, 3));
    writeVec3Lanes(context, output, argumentAt(call, 3), [
        `${left}.x + (${right}.x - ${left}.x) * ${amount}`,
        `${left}.y + (${right}.y - ${left}.y) * ${amount}`,
        `${left}.z + (${right}.z - ${left}.z) * ${amount}`,
    ]);
    return output;
}

function compileLengthVec3(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 1, 1);
    const vector = compileVec3Temporary(context, argumentAt(call, 0), "length_vec3");
    return {
        kind: "number",
        cpp: `std::hypot(${vector}.x, ${vector}.y, ${vector}.z)`,
    };
}

function compileDotVec3(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 2, 2);
    const left = compileVec3Temporary(context, argumentAt(call, 0), "dot_left");
    const right = compileVec3Temporary(context, argumentAt(call, 1), "dot_right");
    return {
        kind: "number",
        cpp: `${left}.x * ${right}.x + ` +
            `${left}.y * ${right}.y + ` +
            `${left}.z * ${right}.z`,
    };
}

function compileSetMeshVisible(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 2, 2);
    const mesh = context.compileValue(argumentAt(call, 0));
    context.expectKind(mesh, "mesh", argumentAt(call, 0));
    context.reachFeature("mesh:visible", call);
    return {
        kind: "void",
        cpp: `bbl::set_mesh_visible(` +
            `${context.requireEngine(mesh, call)}, ${mesh.cpp}, ` +
            `${context.compileCondition(argumentAt(call, 1))})`,
    };
}

function compileMat4Invert(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 1, 1);
    context.reachJsData();
    context.reachFeature("math:mat4-invert", call);
    return {
        kind: "data",
        cpp: `bbl::upstream::mat4_invert_array(${context.compileTypedArrayArgument(argumentAt(call, 0), "f32array")})`,
        dataType: { kind: "optional", inner: { kind: "f32array" } },
        freshData: true,
    };
}

function compileMat4Compose(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 10, 10);
    context.reachJsData();
    return {
        kind: "data",
        cpp: `bbl::js::mat4_compose(` +
            call.arguments
                .map((argument) => context.compileNumber(argument, "double"))
                .join(", ") +
            `)`,
        dataType: { kind: "f32array" },
        freshData: true,
    };
}

function compileNormalizeVec3(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 3, 4);
    context.reachFeature("math:normalize-vec3", call);
    context.reachJsData();
    return {
        kind: "data",
        // The pinned body answers a plain triple; the array
        // IDENTITY a scene sees is added here, where a scene is
        // what holds it.
        cpp: `bbl::js::Tuple<3>(bbl::upstream::normalize_vec3(` +
            call.arguments
                .map((argument) => context.compileNumber(argument, "double"))
                .join(", ") +
            `))`,
        dataType: { kind: "tuple", arity: 3 },
        freshData: true,
    };
}

function compileNormalizeVec3Object(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 1, 1);
    context.reachFeature("math:normalize-vec3", call);
    const input = compileVec3Temporary(context, argumentAt(call, 0), "normalize_input");
    const temporary = context.allocateTemporaryCppName("normalized_vec3");
    context.emit(`const bbl::Vec3d ${temporary} = ` +
        `bbl::upstream::normalize_vec3_object(` +
        `${input});`);
    return vec3Record(temporary);
}

function compileNormalizeVec3ToRef(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 2, 3);
    const input = compileVec3Temporary(context, argumentAt(call, 0), "normalize_input");
    const output = context.compileValue(argumentAt(call, 1));
    const lanes = writableVec3Lanes(context, output, argumentAt(call, 1));
    const epsilonCpp = call.arguments[2]
        ? context.compileNumber(call.arguments[2], "double")
        : "1e-10";
    const epsilon = context.allocateTemporaryCppName("normalize_epsilon");
    const length = context.allocateTemporaryCppName("normalize_length");
    context.emit({ kind: "declaration", type: "const double", name: epsilon, initializer: epsilonCpp });
    context.emit(`const double ${length} = std::hypot(` +
        `${input}.x, ${input}.y, ${input}.z);`);
    context.emit(`if (${length} <= ${epsilon}) {`);
    writeVec3Lanes(context, output, argumentAt(call, 1), ["0.0", "0.0", "0.0"]);
    context.emit("} else {");
    const inverse = context.allocateTemporaryCppName("normalize_inverse");
    context.emit({ kind: "declaration", type: "const double", name: inverse, initializer: `1.0 / ${length}` });
    for (let index = 0; index < 3; index += 1) {
        const component = ["x", "y", "z"][index]!;
        context.emit(`${lanes[index]} = ${input}.${component} * ${inverse};`);
    }
    context.emit("}");
    return output;
}

function compileMat4Identity(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 0, 0);
    context.reachJsData();
    // The pin allocates an identity Float32Array. Neutral translation,
    // rotation, and scale are the exact specialization of the pinned
    // mat4Compose stores, including the fresh array identity.
    return {
        kind: "data",
        cpp: `bbl::js::mat4_compose(` +
            `0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0)`,
        dataType: { kind: "f32array" },
        freshData: true,
    };
}

function compileMat4Translation(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 3, 3);
    context.reachJsData();
    // Pinned mat4Translation starts from mat4Identity and writes only
    // indices 12..14. This is the corresponding neutral-rotation,
    // unit-scale specialization of the already pinned compose path.
    return {
        kind: "data",
        cpp: `bbl::js::mat4_compose(` +
            call.arguments
                .map((argument) => context.compileNumber(argument, "double"))
                .join(", ") +
            `, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0)`,
        dataType: { kind: "f32array" },
        freshData: true,
    };
}

function compileSetParent(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 2, 2);
    const child = context.compileValue(argumentAt(call, 0));
    const parent = context.compileValue(argumentAt(call, 1));
    if (child.kind !== "mesh" && child.kind !== "asset-root") {
        context.fail(argumentAt(call, 0), `setParent's reached scene-graph slice accepts a Mesh or imported root, received ${child.kind}.`);
    }
    if (parent.kind !== "mesh" &&
        parent.kind !== "transform-node" &&
        parent.kind !== "json-null") {
        context.fail(argumentAt(call, 1), `setParent's reached scene-graph slice accepts a Mesh, TransformNode, or null parent, received ${parent.kind}.`);
    }
    if (child.kind === "asset-root" &&
        parent.kind !== "transform-node") {
        context.fail(call, "An imported root is reached only when reparenting it to a TransformNode.");
    }
    if (parent.kind !== "json-null") {
        context.expectSameEngine(child, parent, call);
    }
    context.reachFeature("mesh:parenting", call);
    if (child.kind === "asset-root") {
        context.markAssetRootReparented(child, argumentAt(call, 0));
        return {
            kind: "void",
            cpp: `bbl::set_asset_root_parent(` +
                `${context.requireEngine(child, call)}, ${child.cpp}, ` +
                `${parent.cpp})`,
        };
    }
    return {
        kind: "void",
        cpp: `bbl::set_mesh_parent(` +
            `${context.requireEngine(child, call)}, ${child.cpp}, ` +
            `${parent.kind === "json-null" ? `${handleCppType("mesh")}{}` : parent.cpp})`,
    };
}

function compileCloneTransformNode(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 1, 1);
    const source = context.compileValue(argumentAt(call, 0));
    if (source.kind === "mesh") {
        context.reachFeature("mesh:clone", call);
        // The pin's own `"_gpu" in src` arm: a mesh routes to
        // cloneMeshNode. The clone is a second wrapper over the
        // source's geometry, so it needs a scene-mesh identity of
        // its own -- everything a scene later writes to it (its
        // name, its material, its transform) must land on the
        // clone rather than on the mesh it was taken from.
        const engine = context.requireEngine(source, call);
        const sceneMeshIndex = context.recordSceneMesh("mesh-clone");
        return {
            kind: "mesh",
            sceneMeshIndex,
            cpp: `bbl::clone_mesh_node(${engine}, ` +
                `${source.cpp})`,
            engineCpp: engine,
        };
    }
    if (source.kind !== "asset-root") {
        context.fail(argumentAt(call, 0), "cloneTransformNode is lowered for an imported glTF root hierarchy; another node shape has no native hierarchy representation.");
    }
    const engine = context.requireEngine(source, call);
    return {
        ...source,
        cpp: `bbl::clone_asset_root(${engine}, ` +
            `${source.cpp})`,
        assetRootClone: true,
        assetRootState: { reparented: false },
    };
}

function compileCreateMeshFromData(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 5, 9);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    // The record carries the pinned Mesh name; scene code finds
    // meshes by it.
    const name = context.compileValue(argumentAt(call, 1));
    if (name.kind !== "string" &&
        !(name.kind === "data" &&
            name.dataType?.kind === "string")) {
        context.fail(argumentAt(call, 1), `Mesh names must be strings, received ${name.kind}.`);
    }
    const positions = context.compileTypedArrayArgument(argumentAt(call, 2), "f32array");
    const normals = context.compileTypedArrayArgument(argumentAt(call, 3), "f32array");
    const indices = context.compileTypedArrayArgument(argumentAt(call, 4), "u32array");
    // The demo modules skip optional slots with literal
    // `undefined`, which parses as an identifier expression.
    const isUndefinedArgument = (argument: ts.Expression | undefined): boolean => !argument ||
        argument.kind ===
            ts.SyntaxKind.UndefinedKeyword ||
        (ts.isIdentifier(argument) &&
            argument.text === "undefined");
    // The pin's four optional streams, in its own argument order:
    // uvs, uv2s, tangents, colors. A call that omits one, or hands
    // it a literal `undefined`, settles here. One that hands it a
    // value the data model holds as `Float32Array | undefined`
    // settles at RUN time — scene 86's shared mesh table is three
    // entries of one record type differing in exactly which
    // attributes they carry — and `create_mesh_from_data` reads an
    // empty array as the absent stream either way, which is the
    // same absence the folded `{}` writes.
    const streams = [5, 6, 7, 8].map((index) => {
        const argument = call.arguments[index];
        if (isUndefinedArgument(argument)) {
            return { cpp: "{}", present: false as boolean | undefined };
        }
        const unwrapped = context.unwrap(argument!);
        const value = context.compileValue(argument!);
        if (value.kind === "data" &&
            value.dataType?.kind === "optional" &&
            value.dataType.inner.kind === "f32array") {
            // The select reads the operand twice, so only a path
            // is taken: an identifier or a member chain evaluates
            // to the same storage both times. Anything else --
            // a call, an indexed read whose subscript is itself an
            // expression -- refuses here rather than running twice.
            if (!ts.isIdentifier(unwrapped) &&
                !ts.isPropertyAccessExpression(unwrapped)) {
                context.fail(argument!, "An optional vertex stream must be a local or a " +
                    "member of one: the absent case is selected " +
                    "at run time, which reads the operand twice.");
            }
            context.reachJsData();
            return {
                cpp: `(${value.cpp}.has_value() ? ${value.cpp}.value()` +
                    ` : bbl::js::F32Array{})`,
                present: undefined,
            };
        }
        return {
            cpp: context.compileTypedArrayArgument(argument!, "f32array"),
            present: true as boolean | undefined,
        };
    });
    const optional = streams.map((stream) => stream.cpp);
    // The streams decide the mesh half of the variant key. A
    // run-time one leaves its entry unrecorded: generation cannot
    // answer what the composed Standard or PBR variant would need,
    // so the pairing refuses where it is known — at the material
    // assignment — rather than composing against a guess.
    const sceneMeshIndex = context.recordSceneMesh("from-data", {
        hasUv2: streams[1]!.present === true,
        hasTangents: streams[2]!.present === true,
        hasColors: streams[3]!.present === true,
        ...(streams.some((stream) => stream.present === undefined)
            ? { runtimeStreams: true as const }
            : {}),
    });
    context.reachFeature("mesh:from-data", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_mesh_from_data(${engine.cpp}, ` +
            `${name.cpp}, ` +
            `${positions}, ${normals}, ${indices}, ` +
            `${optional.join(", ")})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
        directMorphCompatible: true,
        ...(streams.some((stream) => stream.present === undefined)
            ? { runtimeMeshStreams: true as const }
            : {}),
    };
}

function compileUpdateMeshPositions(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 3, 6);
    const engine = context.compileValue(argumentAt(call, 0));
    const mesh = context.compileValue(argumentAt(call, 1));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    context.expectKind(mesh, "mesh", argumentAt(call, 1));
    context.expectSameEngine(engine, mesh, call);
    const positions = context.compileTypedArrayArgument(argumentAt(call, 2), "f32array");
    const vertexOffset = call.arguments[3]
        ? context.compileNumber(call.arguments[3], "double")
        : "0.0";
    const vertexCount = call.arguments[4]
        ? context.compileNumber(call.arguments[4], "double")
        : "std::numeric_limits<double>::quiet_NaN()";
    const sourceVertexOffset = call.arguments[5]
        ? context.compileNumber(call.arguments[5], "double")
        : "0.0";
    context.reachFeature("mesh:update-positions", call);
    return {
        kind: "void",
        cpp: `bbl::update_mesh_positions(${engine.cpp}, ${mesh.cpp}, ` +
            `${positions}, ${vertexOffset}, ${vertexCount}, ` +
            `${sourceVertexOffset})`,
    };
}

function compileCreateHierarchyInstancePool(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 2, 2);
    const root = context.compileValue(argumentAt(call, 0));
    if (root.kind !== "asset-root" ||
        !root.assetRootClone) {
        context.fail(argumentAt(call, 0), "createHierarchyInstancePool currently lowers a cloned imported glTF root hierarchy.");
    }
    context.assertAssetRootWritable(root, call);
    const capacity = context.compileNumber(argumentAt(call, 1), "double");
    const engine = context.requireEngine(root, call);
    const pool = context.allocateTemporaryCppName("hierarchy_instance_pool");
    context.reachFeature("mesh:thin-instances", call);
    context.reachFeature("mesh:thin-instances-dynamic", call);
    // The pin materializes the imported hierarchy's parent links before
    // snapshotting mesh worlds. Native loading has already flattened
    // those links, and the scene core owns the same matrix helpers.
    context.reachFeature("mesh:parenting", call);
    context.recordThinInstanceMesh(undefined);
    context.emit(`const ${handleCppType("hierarchy-instance-pool")} ${pool} = ` +
        `bbl::create_hierarchy_instance_pool(` +
        `${engine}, ${root.cpp}, ${capacity});`);
    return {
        kind: "hierarchy-instance-pool",
        cpp: pool,
        engineCpp: engine,
    };
}

function compileAddHierarchyInstance(context: MeshIntrinsicContext, call: ts.CallExpression, importedName: "addHierarchyInstance" | "setHierarchyInstanceMatrix"): Value | undefined {
    const updatesExisting = importedName === "setHierarchyInstanceMatrix";
    context.expectArgumentCount(call, updatesExisting ? 3 : 2, updatesExisting ? 3 : 2);
    const pool = context.compileValue(argumentAt(call, 0));
    context.expectKind(pool, "hierarchy-instance-pool", argumentAt(call, 0));
    const index = updatesExisting
        ? context.compileNumber(argumentAt(call, 1), "double")
        : undefined;
    const matrix = context.compileTypedArrayArgument(argumentAt(call, updatesExisting ? 2 : 1), "f32array");
    const invocation = updatesExisting
        ? `bbl::set_hierarchy_instance_matrix(` +
            `${context.requireEngine(pool, call)}, ${pool.cpp}, ` +
            `${index}, ${matrix})`
        : `bbl::add_hierarchy_instance(` +
            `${context.requireEngine(pool, call)}, ${pool.cpp}, ` +
            `${matrix})`;
    return updatesExisting
        ? { kind: "void", cpp: invocation }
        : {
            kind: "number",
            cpp: invocation,
            dataType: { kind: "number" },
        };
}

function compileSetHierarchyInstanceCount(context: MeshIntrinsicContext, call: ts.CallExpression, importedName: "setHierarchyInstanceCount" | "removeHierarchyInstance"): Value | undefined {
    context.expectArgumentCount(call, 2, 2);
    const pool = context.compileValue(argumentAt(call, 0));
    context.expectKind(pool, "hierarchy-instance-pool", argumentAt(call, 0));
    const value = context.compileNumber(argumentAt(call, 1), "double");
    const helper = importedName === "setHierarchyInstanceCount"
        ? "set_hierarchy_instance_count"
        : "remove_hierarchy_instance";
    return {
        kind: "void",
        cpp: `bbl::${helper}(` +
            `${context.requireEngine(pool, call)}, ${pool.cpp}, ${value})`,
    };
}

function compileSetThinInstances(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 3, 3);
    const mesh = context.compileValue(argumentAt(call, 0));
    context.expectKind(mesh, "mesh", argumentAt(call, 0));
    // The pinned setThinInstances adopts the caller's array by
    // reference so setThinInstanceCount/flushThinInstances can
    // re-read it later, and the native record keeps the same
    // alias. Upstream an inline argument survives because the
    // mesh holds the reference; here the array needs a name whose
    // lifetime is the frame loop, so one that arrives as a
    // temporary is bound to a local first. A block-scoped local
    // does not outlive its block, so it refuses -- unless its
    // initializer is a compile-time constant, which the arm below
    // promotes to a static pool instead. Scene 219 sets its thin
    // instances from a literal identity matrix inside the setup
    // block, and that pool is what gives it a frame-loop lifetime.
    const matricesArgument = context.unwrap(argumentAt(call, 1));
    const matricesExpression = context.compileTypedArrayArgument(argumentAt(call, 1), "f32array");
    let matrices = matricesExpression;
    if (!ts.isIdentifier(matricesArgument)) {
        // A block-scoped local would not outlive its block, so a
        // nested call site needs storage whose lifetime is at
        // least the frame loop's. A pool of COMPILE-TIME
        // constants can have it: bound as a static local it is
        // initialized once, lives for the program, and its
        // address never moves -- which is exactly the alias
        // `setThinInstances` adopts. Anything else still refuses,
        // because a static initializer would freeze the first
        // evaluation of a run-time expression.
        const constantPool = !context.isEntryBodyScope() &&
            staticFloatArrayArgument(context, matricesArgument);
        if (!context.isEntryBodyScope() && !constantPool) {
            context.fail(argumentAt(call, 1), "setThinInstances takes a named Float32Array binding, or a constant one, inside a block; the mesh keeps referencing it for the whole frame loop.");
        }
        matrices = context.allocateTemporaryCppName("thin_instances");
        context.emit(`${constantPool ? "static " : ""}bbl::js::F32Array ` +
            `${matrices} = ${matricesExpression};`);
    }
    const count = context.compileNumber(argumentAt(call, 2));
    context.reachFeature("mesh:thin-instances", call);
    context.recordThinInstanceMesh(mesh.sceneMeshIndex ?? mesh.sceneMeshProfileIndex);
    return {
        kind: "void",
        cpp: `bbl::set_thin_instances(${context.requireEngine(mesh, call)}, ` +
            `${mesh.cpp}, ${matrices}, ${count})`,
    };
}

function compileSetThinInstanceColors(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 2, 2);
    const mesh = context.compileValue(argumentAt(call, 0));
    context.expectKind(mesh, "mesh", argumentAt(call, 0));
    const colors = context.compileTypedArrayArgument(argumentAt(call, 1), "f32array");
    context.reachFeature("mesh:thin-instance-colors", call);
    // The pin's ShaderMaterial reads this stream's presence off the
    // mesh to decide its instanced prelude, so the record notes it.
    context.recordThinInstanceColorMesh(mesh.sceneMeshIndex ?? mesh.sceneMeshProfileIndex);
    return {
        kind: "void",
        cpp: `bbl::set_thin_instance_colors(${context.requireEngine(mesh, call)}, ` +
            `${mesh.cpp}, ${colors})`,
    };
}

function compileSetThinInstanceColor(context: MeshIntrinsicContext, call: ts.CallExpression): Value {
    context.expectArgumentCount(call, 6, 6);
    const mesh = context.compileValue(argumentAt(call, 0));
    context.expectKind(mesh, "mesh", argumentAt(call, 0));
    const args = call.arguments.slice(1).map(argument => context.compileNumber(argument, "double"));
    context.reachFeature("mesh:thin-instance-colors", call);
    context.recordThinInstanceColorMesh(mesh.sceneMeshIndex ?? mesh.sceneMeshProfileIndex);
    return { kind: "void", cpp: `bbl::set_thin_instance_color(${context.requireEngine(mesh, call)}, ${mesh.cpp}, ${args.join(", ")})` };
}

function compileSetThinInstanceCullBoundsPad(context: MeshIntrinsicContext, call: ts.CallExpression): Value {
    context.expectArgumentCount(call, 2, 2);
    const mesh = context.compileValue(argumentAt(call, 0));
    context.expectKind(mesh, "mesh", argumentAt(call, 0));
    const pad = context.compileNumber(argumentAt(call, 1), "double");
    context.reachFeature("mesh:thin-instances", call);
    return { kind: "void", cpp: `bbl::set_thin_instance_cull_bounds_pad(${context.requireEngine(mesh, call)}, ${mesh.cpp}, ${pad})` };
}

function compileSetThinInstanceCount(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 2, 2);
    const mesh = context.compileValue(argumentAt(call, 0));
    context.expectKind(mesh, "mesh", argumentAt(call, 0));
    const count = context.compileNumber(argumentAt(call, 1));
    context.reachFeature("mesh:thin-instances", call);
    context.reachFeature("mesh:thin-instances-dynamic", call);
    context.recordThinInstanceMesh(mesh.sceneMeshIndex ?? mesh.sceneMeshProfileIndex);
    return {
        kind: "void",
        cpp: `bbl::set_thin_instance_count(${context.requireEngine(mesh, call)}, ` +
            `${mesh.cpp}, ${count})`,
    };
}

function compileSetThinInstanceMatrix(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 3, 3);
    const mesh = context.compileValue(argumentAt(call, 0));
    context.expectKind(mesh, "mesh", argumentAt(call, 0));
    const index = context.compileNumber(argumentAt(call, 1), "double");
    const matrix = context.compileTypedArrayArgument(argumentAt(call, 2), "f32array");
    context.reachFeature("mesh:thin-instances-dynamic", call);
    context.recordThinInstanceMesh(mesh.sceneMeshIndex ?? mesh.sceneMeshProfileIndex);
    return {
        kind: "void",
        cpp: `bbl::set_thin_instance_matrix(` +
            `${context.requireEngine(mesh, call)}, ${mesh.cpp}, ` +
            `${index}, ${matrix})`,
    };
}

function compileFlushThinInstances(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 1, 1);
    const mesh = context.compileValue(argumentAt(call, 0));
    context.expectKind(mesh, "mesh", argumentAt(call, 0));
    context.reachFeature("mesh:thin-instances", call);
    context.reachFeature("mesh:thin-instances-dynamic", call);
    context.recordThinInstanceMesh(mesh.sceneMeshIndex ?? mesh.sceneMeshProfileIndex);
    return {
        kind: "void",
        cpp: `bbl::flush_thin_instances(${context.requireEngine(mesh, call)}, ` +
            `${mesh.cpp})`,
    };
}

function compileAddThinInstance(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    // The growing half of the pool. Unlike `setThinInstances`, the
    // matrix is copied rather than aliased -- the pin's own
    // `matrices.set(matrix, index * 16)` reads it once -- so an
    // inline `mat4Identity()` needs no named binding here.
    context.expectArgumentCount(call, 2, 2);
    const mesh = context.compileValue(argumentAt(call, 0));
    context.expectKind(mesh, "mesh", argumentAt(call, 0));
    const matrix = context.compileTypedArrayArgument(argumentAt(call, 1), "f32array");
    context.reachFeature("mesh:thin-instances", call);
    context.reachFeature("mesh:thin-instances-dynamic", call);
    context.recordThinInstanceMesh(mesh.sceneMeshIndex ?? mesh.sceneMeshProfileIndex);
    return {
        kind: "number",
        cpp: `bbl::add_thin_instance(` +
            `${context.requireEngine(mesh, call)}, ${mesh.cpp}, ` +
            `${matrix})`,
        dataType: { kind: "number" },
    };
}

function compileRemoveThinInstance(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 2, 2);
    const mesh = context.compileValue(argumentAt(call, 0));
    context.expectKind(mesh, "mesh", argumentAt(call, 0));
    const index = context.compileNumber(argumentAt(call, 1), "double");
    context.reachFeature("mesh:thin-instances", call);
    context.reachFeature("mesh:thin-instances-dynamic", call);
    context.recordThinInstanceMesh(mesh.sceneMeshIndex ?? mesh.sceneMeshProfileIndex);
    return {
        kind: "void",
        cpp: `bbl::remove_thin_instance(` +
            `${context.requireEngine(mesh, call)}, ${mesh.cpp}, ` +
            `${index})`,
    };
}

function compileEnableThinInstanceGpuCulling(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    // Upstream this is a performance opt-in whose visible output is
    // unchanged, and whose second effect -- routing the renderable
    // to a direct draw, out of the cached opaque bundle -- is what
    // an application relies on for per-frame pool sync. This port
    // records no bundles and syncs every live pool every frame, so
    // the flag lands on the record as an explicit marker and the
    // compute culler itself is a recorded omission.
    context.expectArgumentCount(call, 1, 2);
    const mesh = context.compileValue(argumentAt(call, 0));
    context.expectKind(mesh, "mesh", argumentAt(call, 0));
    const enabled = call.arguments[1]
        ? context.compileCondition(call.arguments[1])
        : pinnedParameterFlag("src/mesh/thin-instance.ts", "enableThinInstanceGpuCulling", "enabled")
            ? "true"
            : "false";
    context.reachFeature("mesh:thin-instances", call);
    // The pin reads `mesh.thinInstances` and throws without one, so
    // a mesh generation resolved and never bound a pool on fails at
    // its own line -- the same failure, at the same call. A mesh
    // arriving as a runtime handle keeps the emitted call's own.
    if (!context.meshHasThinInstancePool(mesh)) {
        context.fail(call, "enableThinInstanceGpuCulling requires a " +
            "thin-instance pool this mesh never establishes; " +
            "bind one with setThinInstances or " +
            "addThinInstance first.");
    }
    if (enabled === "false" &&
        !context.meshMayHaveThinInstanceGpuCulling(mesh)) {
        // `_gpuCullingEnabled` starts false and nothing reached so
        // far on this mesh could have set it, so the pinned body
        // returns at its own idempotence test: there is no culler
        // to omit and no flag to move. Reaching the feature anyway
        // would emit the runtime helper AND record the
        // omitted-culler adaptation against a scene that never
        // asked for the culler, which is a fidelity entry naming a
        // divergence that does not exist.
        return { kind: "void", cpp: "" };
    }
    context.reachFeature("mesh:thin-instance-gpu-culling", call);
    context.recordThinInstanceGpuCulling(mesh.sceneMeshIndex ?? mesh.sceneMeshProfileIndex);
    return {
        kind: "void",
        cpp: `bbl::enable_thin_instance_gpu_culling(` +
            `${context.requireEngine(mesh, call)}, ${mesh.cpp}, ` +
            `${enabled})`,
    };
}

function compileCreateTransformNode(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    // src/scene/transform-node.ts: a SceneNode with a TRS. Every
    // argument past the name is optional and the pin gives each a
    // default, so an omitted one is read off the pinned
    // declaration rather than restated here.
    // The pin's factory takes no engine: a node is plain data
    // upstream, as a light is. This port keeps one record
    // collection per engine, so the node resolves the scene's
    // engine the way every light factory does.
    context.expectArgumentCount(call, 1, 11);
    const engine = context.requireDefaultEngine(call);
    const name = context.compileValue(argumentAt(call, 0));
    if (name.kind !== "string" &&
        !(name.kind === "data" &&
            name.dataType?.kind === "string")) {
        context.fail(argumentAt(call, 0), `TransformNode names must be strings, received ${name.kind}.`);
    }
    const defaults = transformNodeDefaults();
    const argument = (index: number, parameter: TransformNodeParameter, precision: "float" | "double"): string => {
        const supplied = call.arguments[index];
        return supplied
            ? context.compileNumber(supplied, precision)
            : precision === "double"
                ? doubleLiteral(defaults.get(parameter)!)
                : floatLiteral(defaults.get(parameter)!);
    };
    // The position is a JavaScript number upstream and reaches a
    // matrix column, so it keeps the pin's width the way a mesh's
    // own translation does.
    const position = `bbl::Vec3d{${argument(1, "px", "double")}, ` +
        `${argument(2, "py", "double")}, ` +
        `${argument(3, "pz", "double")}}`;
    const rotation = `bbl::Vec4{${argument(4, "qx", "float")}, ` +
        `${argument(5, "qy", "float")}, ` +
        `${argument(6, "qz", "float")}, ` +
        `${argument(7, "qw", "float")}}`;
    const scaling = `bbl::Vec3{${argument(8, "sx", "float")}, ` +
        `${argument(9, "sy", "float")}, ` +
        `${argument(10, "sz", "float")}}`;
    context.reachFeature("mesh:transform-node", call);
    return {
        kind: "transform-node",
        cpp: `bbl::create_transform_node(${engine}, ` +
            `${name.cpp}, ${position}, ${rotation}, ${scaling})`,
        engineCpp: engine,
    };
}

function compileCreateBox(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    const sceneMeshIndex = context.recordSceneMesh("box");
    context.expectArgumentCount(call, 1, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const options = call.arguments[1]
        ? context.compileBoxOptions(call.arguments[1])
        : ["1.0f", "1.0f", "1.0f"];
    context.reachFeature("mesh:box", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_box(${engine.cpp}, ` +
            `bbl::BoxOptions{${options.join(", ")}})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
        directMorphCompatible: true,
    };
}

function compileCreateGround(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    const sceneMeshIndex = context.recordSceneMesh("ground");
    context.expectArgumentCount(call, 1, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const options = call.arguments[1]
        ? context.compileGroundOptions(call.arguments[1])
        : GROUND_OPTION_DEFAULTS;
    context.reachFeature("mesh:ground", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_ground(${engine.cpp}, ` +
            `bbl::GroundOptions{${options[0]}, ` +
            `${options[1]}, ${options[2]}, ` +
            `bbl::Vec2{${options[3]}, ${options[4]}}})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
        directMorphCompatible: true,
    };
}

function compileCreateGroundFromHeightMap(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    const sceneMeshIndex = context.recordSceneMesh("ground");
    context.expectArgumentCount(call, 2, 3);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const asset = context.registerAsset(context.compileStringLiteral(argumentAt(call, 1)), "texture");
    const options = call.arguments[2]
        ? context.compileGroundFromHeightMapOptions(call.arguments[2])
        : [
            ...GROUND_OPTION_DEFAULTS,
            // createGroundFromHeightMap's own two.
            "0.0",
            "1.0",
        ];
    context.reachFeature("mesh:ground-heightmap", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_ground_from_height_map(${engine.cpp}, ` +
            `bbl::GroundOptions{${options[0]}, ` +
            `${options[1]}, ${options[2]}, ` +
            `bbl::Vec2{${options[3]}, ${options[4]}}}, ` +
            `${options[5]}, ${options[6]}, ` +
            `${context.cppString(asset.output)})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
        directMorphCompatible: true,
    };
}

function compileCreatePlane(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    const sceneMeshIndex = context.recordSceneMesh("plane");
    context.expectArgumentCount(call, 1, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const options = call.arguments[1]
        ? context.compilePlaneOptions(call.arguments[1])
        : ["1.0f", "1.0f"];
    context.reachFeature("mesh:plane", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_plane(${engine.cpp}, ` +
            `bbl::PlaneOptions{${options.join(", ")}})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
        directMorphCompatible: true,
    };
}

function compileCreateSphere(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    const sceneMeshIndex = context.recordSceneMesh("sphere");
    context.expectArgumentCount(call, 1, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const options = call.arguments[1]
        ? context.compileSphereOptions(call.arguments[1])
        : ["32u", "1.0", "1.0", "1.0"];
    context.reachFeature("mesh:sphere", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_sphere(${engine.cpp}, ` +
            `bbl::SphereOptions{${options.join(", ")}})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
        directMorphCompatible: true,
    };
}

function compileCreateCsgFromMesh(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 1, 2);
    const mesh = context.compileValue(argumentAt(call, 0));
    context.expectKind(mesh, "mesh", argumentAt(call, 0));
    const builder = csgSourceCall(context, argumentAt(call, 0));
    const source = builder && csgSourceFromCall(context, builder);
    if (!source) {
        context.fail(argumentAt(call, 0), "createCsgFromMesh replays the pinned factory that " +
            "built the mesh's retained CPU geometry and bakes " +
            "its world matrix into every polygon, so the " +
            "reached slice is createBox or createSphere with " +
            "generation-known options, named here or by a " +
            "local binding whose first use is this call.");
    }
    const materialSlot = call.arguments[1]
        ? staticNumberValue(context, context.unwrap(call.arguments[1]))
        : 0;
    if (materialSlot === undefined) {
        context.fail(argumentAt(call, 1), "A CSG material slot tags every polygon the solid " +
            "carries, so it is generation-known.");
    }
    context.reachFeature("mesh:csg", call);
    return {
        kind: "csg-solid",
        cpp: "",
        csgSolid: { op: "from-mesh", source, materialSlot },
    };
}

function compileCsgUnion(context: MeshIntrinsicContext, call: ts.CallExpression, importedName: "csgUnion" | "csgSubtract" | "csgIntersect"): Value | undefined {
    context.expectArgumentCount(call, 2, 2);
    const op = csgBooleanNames.find((name) => name === importedName)!;
    const left = requireCsgSolid(context, argumentAt(call, 0));
    const right = requireCsgSolid(context, argumentAt(call, 1));
    context.reachFeature("mesh:csg", call);
    return {
        kind: "csg-solid",
        cpp: "",
        // The plan names the pin's own export, so the replay
        // looks the boolean up rather than translating it.
        csgSolid: { op, left, right },
    };
}

function compileCreateMeshFromCsg(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 2, 3);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const plan = requireCsgSolid(context, argumentAt(call, 1));
    // `createMeshFromCsg(engine, solid, name = "csg")`: the name
    // reaches `createMeshFromData` and nothing else, so it is the
    // mesh record's name here exactly as it is upstream.
    const name = call.arguments[2]
        ? context.compileValue(call.arguments[2])
        : undefined;
    if (name && name.staticString === undefined) {
        context.fail(argumentAt(call, 2), "A CSG mesh's name is generation-known: the solid is " +
            "replayed at generation and the mesh it produces " +
            "is named there.");
    }
    const meshName = name?.staticString ?? "csg";
    const baked = bakeCsgMesh(plan, meshName);
    const geometry = compileBakedMesh(context, baked);
    context.reachJsData();
    const sceneMeshIndex = context.recordSceneMesh("from-data", {
        hasUv2: false,
        hasTangents: false,
        hasColors: false,
    });
    context.reachFeature("mesh:csg", call);
    context.reachFeature("mesh:from-data", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_mesh_from_data(${engine.cpp}, ` +
            `${context.cppString(meshName)}, ` +
            `${geometry.positions}, ${geometry.normals}, ` +
            `${geometry.indices}, ${geometry.uvs}, {}, {}, {})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
        directMorphCompatible: true,
    };
}

function compileCreateMeshesFromCsg(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    // The multi-material sibling: it partitions the solid's
    // polygons by their material slot and builds one mesh per
    // slot. No corpus scene reaches it, and the slice this port
    // bakes carries one mesh, so it refuses rather than baking
    // the first partition and dropping the rest.
    context.fail(call, "createMeshesFromCsg splits a solid across one mesh per " +
        "material slot; the reached slice is createMeshFromCsg.");
}

function compileCreateBoxData(context: MeshIntrinsicContext, call: ts.CallExpression, importedName: "createBoxData" | "createSphereData"): Value | undefined {
    context.expectArgumentCount(call, 0, 1);
    const box = importedName === "createBoxData";
    const options = box
        ? call.arguments[0]
            ? context.compileBoxOptions(call.arguments[0], "double")
            : ["1.0", "1.0", "1.0"]
        : call.arguments[0]
            ? context.compileSphereOptions(call.arguments[0])
            : ["32u", "1.0", "1.0", "1.0"];
    const temporary = context.allocateTemporaryCppName(box ? "box_data" : "sphere_data");
    context.emit(`bbl::MeshData ${temporary} = ` + (box
        ? `bbl::create_box_data(${options.join(", ")});`
        : `bbl::create_sphere_data(bbl::SphereOptions{${options.join(", ")}});`));
    context.reachFeature(box ? "mesh:box" : "mesh:sphere", call);
    context.reachJsData();
    // A data result owns JavaScript typed arrays. Materialize each
    // stream once so aliases of a returned property share storage.
    const recordProperties: Record<string, Value> = {};
    for (const field of ["positions", "normals", "uvs", "indices"] as const) {
        const cpp = context.allocateTemporaryCppName(field);
        const indices = field === "indices";
        context.emit({ kind: "declaration", type: `bbl::js::${indices ? "U32Array" : "F32Array"}`, name: cpp, initializer: `std::move(${temporary}.${field})` });
        recordProperties[field] = { kind: "data", cpp,
            dataType: { kind: indices ? "u32array" : "f32array" } };
    }
    return {
        kind: "record",
        cpp: "",
        recordProperties: {
            ...recordProperties,
            vertexCount: {
                kind: "number",
                cpp: `static_cast<double>(${temporary}.vertex_count)`,
                dataType: { kind: "number" },
            },
            indexCount: {
                kind: "number",
                cpp: `static_cast<double>(${temporary}.index_count)`,
                dataType: { kind: "number" },
            },
        },
    };
}

function compileCreateMorphTargets(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 4, 4);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const targets = context.expectStaticArrayLiteral(argumentAt(call, 1));
    if (targets.elements.length !== 1) {
        context.fail(targets, "Direct createMorphTargets currently supports exactly one target.");
    }
    const target = context.expectObjectLiteral(targets.elements[0]!);
    for (const property of target.properties) {
        const name = (ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)) &&
            (ts.isIdentifier(property.name) ||
                ts.isStringLiteral(property.name))
            ? property.name.text
            : undefined;
        if (name !== "positions" &&
            name !== "normals") {
            context.fail(property, "Morph targets support positions and normals.");
        }
    }
    const positions = context.objectProperty(target, "positions");
    const normals = context.objectProperty(target, "normals");
    if (!positions || !normals) {
        context.fail(target, "Morph targets require positions and normals.");
    }
    const normalValue = context.unwrap(normals).kind ===
        ts.SyntaxKind.NullKeyword
        ? "{}"
        : context.compileTypedArrayArgument(normals, "f32array");
    const weights = context.unwrap(argumentAt(call, 3));
    let weight = "0.0f";
    if (weights.kind !==
        ts.SyntaxKind.NullKeyword) {
        const values = context.expectStaticArrayLiteral(weights);
        if (values.elements.length !== 1) {
            context.fail(values, "Direct createMorphTargets requires one initial weight.");
        }
        weight = context.compileNumber(values.elements[0]!);
    }
    context.reachFeature("mesh:morph-targets", call);
    return {
        kind: "morph-targets",
        cpp: "",
        engineCpp: engine.engineCpp ?? engine.cpp,
        morphTarget: {
            positionsCpp: context.compileTypedArrayArgument(positions, "f32array"),
            normalsCpp: normalValue,
            vertexCountCpp: context.compileNumber(argumentAt(call, 2)),
            weightCpp: weight,
        },
    };
}

function compileSetMorphTargetWeights(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    context.expectArgumentCount(call, 3, 3);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const morph = context.compileValue(argumentAt(call, 1));
    context.expectKind(morph, "morph-targets", argumentAt(call, 1));
    if (morph.engineCpp !==
        (engine.engineCpp ?? engine.cpp)) {
        context.fail(call, "Morph targets and engine must belong to the same engine.");
    }
    const mesh = morph.morphTarget?.meshCpp;
    if (!mesh) {
        context.fail(argumentAt(call, 1), "Morph targets must be attached to a mesh before their weights are updated.");
    }
    const weights = context.compileTypedArrayArgument(argumentAt(call, 2), "f32array");
    context.reachFeature("mesh:morph-targets", call);
    return {
        kind: "void",
        cpp: `bbl::set_morph_target_weights(${engine.cpp}, ` +
            `${mesh}, ${weights})`,
    };
}

function compileCreateTube(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    // The reached subset: an explicit path, radius and
    // tessellation. The pinned cap/arc/radiusFunction arms are
    // outside it (the lowering pins the defaults that keep them
    // unreachable), and the radius/tessellation defaults stay
    // unduplicated by requiring the scene to name both.
    const sceneMeshIndex = context.recordSceneMesh("from-data", {
        hasUv2: false,
        hasTangents: false,
        hasColors: false,
    });
    context.expectArgumentCount(call, 2, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const options = context.expectObjectLiteral(argumentAt(call, 1));
    validateObjectProperties(context, options, ["path", "radius", "tessellation"], "Reached tubes name their path, radius and tessellation; cap, arc and radiusFunction are not lowered.");
    const pathExpression = context.objectProperty(options, "path");
    const radius = context.objectProperty(options, "radius");
    const tessellation = context.objectProperty(options, "tessellation");
    if (!pathExpression || !radius || !tessellation) {
        context.fail(argumentAt(call, 1), "Reached tubes name their path, radius and tessellation explicitly.");
    }
    // The path arrives in one of three spellings: a compile-time
    // tuple of Vec3 records whose lanes may be runtime reads (a
    // raycast hit point), an array literal at the call site, or a
    // list a loop grew under a `Vec3[]` annotation -- which the
    // data model materializes as the scene's own record type.
    const points = compileVec3Path(context, pathExpression);
    context.reachFeature("mesh:tube", call);
    context.reachFeature("mesh:from-data", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_tube(${engine.cpp}, ` +
            `${points}, ` +
            `${context.compileNumber(radius, "double")}, ` +
            `${context.compileNumber(tessellation, "double")})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
    };
}

function compileCreateExtrudeShape(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    // A 2D shape swept along a 3D path. `cap` is unreached and
    // refuses by name; `scale` and `rotation` take the factory's
    // own `??` defaults.
    const sceneMeshIndex = context.recordSceneMesh("from-data", {
        hasUv2: false,
        hasTangents: false,
        hasColors: false,
    });
    context.expectArgumentCount(call, 2, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const options = context.expectObjectLiteral(argumentAt(call, 1));
    validateObjectProperties(context, options, ["shape", "path", "scale", "rotation"], "Reached extrusions name their shape, path, scale and " +
        "rotation; cap is not lowered.");
    const shape = context.objectProperty(options, "shape");
    const curve = context.objectProperty(options, "path");
    if (!shape || !curve) {
        context.fail(argumentAt(call, 1), "An extrusion needs its shape and its path.");
    }
    const extrudeDefault = (local: string): string => doubleLiteral(pinnedMeshOptionDefault("src/mesh/create-extrude.ts", "createExtrudeShapeData", local));
    const scale = context.objectProperty(options, "scale");
    const rotation = context.objectProperty(options, "rotation");
    context.reachFeature("mesh:extrude", call);
    context.reachFeature("mesh:from-data", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_extrude_shape(${engine.cpp}, ` +
            `${compileVec3Path(context, shape)}, ` +
            `${compileVec3Path(context, curve)}, ` +
            `${scale
                ? context.compileNumber(scale, "double")
                : extrudeDefault("scale")}, ` +
            `${rotation
                ? context.compileNumber(rotation, "double")
                : extrudeDefault("rotation")})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
    };
}

function compileCreateRibbon(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    // The reached subset is the path array alone. `closeArray`,
    // `closePath` and `offset` are the pin's own defaults, folded
    // here so the record carries what the builder reads.
    const sceneMeshIndex = context.recordSceneMesh("from-data", {
        hasUv2: false,
        hasTangents: false,
        hasColors: false,
    });
    context.expectArgumentCount(call, 2, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const options = context.expectObjectLiteral(argumentAt(call, 1));
    validateObjectProperties(context, options, ["pathArray"], "Reached ribbons name their pathArray; closeArray, " +
        "closePath and offset are the pin's own defaults.");
    const pathArray = context.objectProperty(options, "pathArray");
    if (!pathArray) {
        context.fail(argumentAt(call, 1), "A ribbon needs its pathArray.");
    }
    const paths = compileVec3PathArray(context, pathArray);
    context.reachFeature("mesh:ribbon", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_ribbon(${engine.cpp}, ` +
            `bbl::RibbonOptions{` +
            `${paths}, false, false})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
    };
}

function compileCreatePolyhedron(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    // The pin clamps an out-of-range `type` to 0 and resolves the
    // three sizes through `sizeX ?? size ?? 1`. Both happen here,
    // because the type selects a TABLE ROW and the row is what the
    // record carries.
    const sceneMeshIndex = context.recordSceneMesh("from-data", {
        hasUv2: false,
        hasTangents: false,
        hasColors: false,
    });
    context.expectArgumentCount(call, 1, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const polyhedronDefault = (local: string): number => pinnedMeshOptionDefault("src/mesh/create-polyhedron.ts", "createPolyhedronData", local);
    const sizes: Record<string, string> = {
        sizeX: doubleLiteral(polyhedronDefault("sizeX")),
        sizeY: doubleLiteral(polyhedronDefault("sizeY")),
        sizeZ: doubleLiteral(polyhedronDefault("sizeZ")),
    };
    let type = polyhedronDefault("type");
    let flat = pinnedMeshOptionFlag("src/mesh/create-polyhedron.ts", "createPolyhedronData", "flat")
        ? "true"
        : "false";
    if (call.arguments[1]) {
        const options = context.expectObjectLiteral(call.arguments[1]);
        validateObjectProperties(context, options, ["type", "size", "sizeX", "sizeY", "sizeZ", "flat"], "Reached polyhedra name their type, size and flatness.");
        const typeExpression = context.objectProperty(options, "type");
        if (typeExpression) {
            const value = context.compileValue(typeExpression);
            if (value.kind !== "number" ||
                value.staticNumber === undefined) {
                context.fail(typeExpression, "A polyhedron's type selects a pinned table row " +
                    "at generation, so it must be a " +
                    "compile-time number.");
            }
            const named = value.staticNumber;
            // The pin's own guard: a type outside the table is 0.
            type =
                named < 0 || named >= pinnedPolyhedronCount()
                    ? 0
                    : named;
        }
        const size = context.objectProperty(options, "size");
        if (size) {
            const value = context.compileNumber(size, "double");
            sizes["sizeX"] = value;
            sizes["sizeY"] = value;
            sizes["sizeZ"] = value;
        }
        for (const axis of ["sizeX", "sizeY", "sizeZ"] as const) {
            const expression = context.objectProperty(options, axis);
            if (!expression)
                continue;
            sizes[axis] = context.compileNumber(expression, "double");
        }
        const flatExpression = context.objectProperty(options, "flat");
        if (flatExpression) {
            // The emitted body branches on this per build -- both
            // the flat and the smooth arm are lowered -- so it
            // travels as the record field it is rather than being
            // resolved here.
            const value = context.compileValue(flatExpression);
            if (value.kind !== "boolean") {
                context.fail(flatExpression, "A polyhedron's `flat` is a boolean, received " +
                    `${value.kind}.`);
            }
            flat = value.cpp;
        }
    }
    const preset = pinnedPolyhedron(type);
    const rows = (table: readonly (readonly number[])[]): string => `{${table
        .map((row) => `{${row.map((value) => doubleLiteral(value)).join(", ")}}`)
        .join(", ")}}`;
    context.reachFeature("mesh:polyhedron", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_polyhedron(${engine.cpp}, ` +
            `bbl::PolyhedronOptions{` +
            `${sizes["sizeX"]}, ${sizes["sizeY"]}, ` +
            `${sizes["sizeZ"]}, ${flat}, ` +
            `${rows(preset.vertex)}, ${rows(preset.face)}})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
    };
}

function compileCreateCylinder(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    // The pinned option set, with `diameter` resolved here because
    // the emitted record carries the two ends the builder actually
    // reads. Each default is the factory's own `??` value.
    const sceneMeshIndex = context.recordSceneMesh("from-data", {
        hasUv2: false,
        hasTangents: false,
        hasColors: false,
    });
    context.expectArgumentCount(call, 1, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const cylinderDefault = (local: string): string => doubleLiteral(pinnedMeshOptionDefault("src/mesh/create-cylinder.ts", "createCylinderData", local));
    const emitted = [
        "height",
        "diameterTop",
        "diameterBottom",
        "tessellation",
        "subdivisions",
    ] as const;
    const accepted = [...emitted, "diameter"] as const;
    let topIsZero = "false";
    const cylinderResolved: Record<string, string> = {
        height: cylinderDefault("height"),
        diameterTop: cylinderDefault("diameterTop"),
        diameterBottom: cylinderDefault("diameterBottom"),
        tessellation: cylinderDefault("tessellation"),
        subdivisions: cylinderDefault("subdivisions"),
    };
    if (call.arguments[1]) {
        const options = context.expectObjectLiteral(call.arguments[1]);
        validateObjectProperties(context, options, accepted, "Reached cylinders name height, diameter (or its two " +
            "ends), tessellation and subdivisions.");
        // `diameter` is the pin's shorthand for both ends, and each
        // end overrides it -- the `??` chain, in the order the
        // factory writes it.
        const diameter = context.objectProperty(options, "diameter");
        if (diameter) {
            const value = context.compileNumber(diameter, "double");
            cylinderResolved["diameterTop"] = value;
            cylinderResolved["diameterBottom"] = value;
        }
        for (const name of emitted) {
            const expression = context.objectProperty(options, name);
            if (!expression)
                continue;
            cylinderResolved[name] = context.compileNumber(expression, "double");
        }
        // `options.diameterTop === 0` in the pin is a question
        // about the NAMED option: absent answers no however the
        // resolved value ends up, and a named one answers it at
        // whatever width the scene wrote.
        const top = context.objectProperty(options, "diameterTop");
        if (top) {
            topIsZero =
                `(${context.compileNumber(top, "double")} == 0.0)`;
        }
    }
    context.reachFeature("mesh:cylinder", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_cylinder(${engine.cpp}, ` +
            `bbl::CylinderOptions{` +
            `${emitted
                .map((name) => cylinderResolved[name])
                .join(", ")}, ${topIsZero}})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
    };
}

function compileCreateCapsule(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    // The one builder in the family that resolves its options by
    // TRUTHINESS (`options.height ? options.height : 1`) rather
    // than by `??`, so an omitted option and an explicit zero are
    // the same answer to the pin. Nothing is folded here: the
    // record carries zero for an option the scene did not name,
    // which is exactly the value the pinned ternary rejects, and
    // the emitted body supplies every default itself -- including
    // the two that fall back to another resolved local
    // (`radiusTop` to `radius`, each cap to `capSubdivisions`).
    const sceneMeshIndex = context.recordSceneMesh("from-data", {
        hasUv2: false,
        hasTangents: false,
        hasColors: false,
    });
    context.expectArgumentCount(call, 1, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    // The pin's own option order, which is the record's.
    const fields = [
        "height",
        "radius",
        "radiusTop",
        "radiusBottom",
        "tessellation",
        "subdivisions",
        "capSubdivisions",
        "topCapSubdivisions",
        "bottomCapSubdivisions",
    ] as const;
    const resolved: Record<string, string> = Object.fromEntries(fields.map((name) => [name, doubleLiteral(0)]));
    if (call.arguments[1]) {
        const options = context.expectObjectLiteral(call.arguments[1]);
        validateObjectProperties(context, options, fields, "Reached capsules name their height, radius (or its " +
            "two ends), tessellation, subdivisions and cap " +
            "subdivisions.");
        for (const name of fields) {
            const expression = context.objectProperty(options, name);
            if (!expression)
                continue;
            resolved[name] = context.compileNumber(expression, "double");
        }
    }
    context.reachFeature("mesh:capsule", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_capsule(${engine.cpp}, ` +
            `bbl::CapsuleOptions{` +
            `${fields
                .map((name) => resolved[name])
                .join(", ")}})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
    };
}

function compileCreateDisc(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    // The reached subset is the whole pinned option set: radius,
    // tessellation and arc. Each default is the factory's own `??`
    // value, folded into a named constant at generation, so an
    // omitted option is the pin's answer rather than one restated
    // here.
    const sceneMeshIndex = context.recordSceneMesh("from-data", {
        hasUv2: false,
        hasTangents: false,
        hasColors: false,
    });
    context.expectArgumentCount(call, 1, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const fields = ["radius", "tessellation", "arc"] as const;
    const resolved: Record<string, string> = Object.fromEntries(fields.map((name) => [
        name,
        doubleLiteral(pinnedMeshOptionDefault("src/mesh/create-disc.ts", "createDiscData", name)),
    ]));
    if (call.arguments[1]) {
        const options = context.expectObjectLiteral(call.arguments[1]);
        validateObjectProperties(context, options, fields, "Reached discs name their radius, tessellation and arc.");
        for (const name of fields) {
            const expression = context.objectProperty(options, name);
            if (!expression)
                continue;
            resolved[name] = context.compileNumber(expression, "double");
        }
    }
    context.reachFeature("mesh:disc", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_disc(${engine.cpp}, ` +
            `bbl::DiscOptions{` +
            `${fields.map((name) => resolved[name]).join(", ")}})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
    };
}

function compileCreateTorusKnot(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    // The whole pinned option set: the curve's radius and tube, its
    // two segment counts, and the (p, q) winding pair. Each default
    // is the factory's own `??` value folded at generation, the way
    // the rest of the grown-array family resolves one, so an
    // omitted option is the pin's answer rather than one restated
    // here. The mesh arrives through `create_mesh_from_data`, so it
    // carries no primitive of its own.
    const sceneMeshIndex = context.recordSceneMesh("from-data", {
        hasUv2: false,
        hasTangents: false,
        hasColors: false,
    });
    context.expectArgumentCount(call, 1, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const fields = [
        "radius",
        "tube",
        "radialSegments",
        "tubularSegments",
        "p",
        "q",
    ] as const;
    const resolved: Record<string, string> = Object.fromEntries(fields.map((name) => [
        name,
        doubleLiteral(pinnedMeshOptionDefault("src/mesh/create-torus-knot.ts", "createTorusKnotData", name)),
    ]));
    if (call.arguments[1]) {
        const options = context.expectObjectLiteral(call.arguments[1]);
        validateObjectProperties(context, options, fields, "Reached torus knots name their radius, tube, " +
            "segment counts and (p, q) winding.");
        for (const name of fields) {
            const expression = context.objectProperty(options, name);
            if (!expression)
                continue;
            resolved[name] = context.compileNumber(expression, "double");
        }
    }
    context.reachFeature("mesh:torus-knot", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_torus_knot(${engine.cpp}, ` +
            `bbl::TorusKnotOptions{` +
            `${fields.map((name) => resolved[name]).join(", ")}})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
    };
}

function compileCreateTorus(context: MeshIntrinsicContext, call: ts.CallExpression): Value | undefined {
    const sceneMeshIndex = context.recordSceneMesh("torus");
    context.expectArgumentCount(call, 1, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const options = call.arguments[1]
        ? context.compileTorusOptions(call.arguments[1])
        : ["1.0f", "0.5f", "16u"];
    context.reachFeature("mesh:torus", call);
    return {
        kind: "mesh",
        sceneMeshIndex,
        cpp: `bbl::create_torus(${engine.cpp}, ` +
            `bbl::TorusOptions{${options.join(", ")}})`,
        engineCpp: engine.engineCpp ?? engine.cpp,
        directMorphCompatible: true,
    };
}

const meshIntrinsicHandlers = new EmissionMap<string, (context: MeshIntrinsicContext, call: ts.CallExpression) => Value | undefined>([
    ["initializeCsg2Async", compileInitializeCsg2Async],
    ["isCsg2Ready", compileIsCsg2Ready],
    ["createCsg2FromMesh", compileCreateCsg2FromMesh],
    ["csg2Subtract", (context, call) => compileCsg2Subtract(context, call, "csg2Subtract")],
    ["csg2Intersect", (context, call) => compileCsg2Subtract(context, call, "csg2Intersect")],
    ["csg2Add", (context, call) => compileCsg2Subtract(context, call, "csg2Add")],
    ["disposeCsg2", compileDisposeCsg2],
    ["createMeshFromCsg2", (context, call) => compileCreateMeshFromCsg2(context, call, "createMeshFromCsg2")],
    ["createMeshesFromCsg2", (context, call) => compileCreateMeshFromCsg2(context, call, "createMeshesFromCsg2")],
    ["quatFromLookDirectionRH", compileQuatFromLookDirectionRH],
    ["addVec3", (context, call) => compileAddVec3(context, call, "addVec3")],
    ["subVec3", (context, call) => compileAddVec3(context, call, "subVec3")],
    ["crossVec3", (context, call) => compileAddVec3(context, call, "crossVec3")],
    ["addVec3ToRef", (context, call) => compileAddVec3ToRef(context, call, "addVec3ToRef")],
    ["subVec3ToRef", (context, call) => compileAddVec3ToRef(context, call, "subVec3ToRef")],
    ["crossVec3ToRef", (context, call) => compileAddVec3ToRef(context, call, "crossVec3ToRef")],
    ["scaleVec3", compileScaleVec3],
    ["scaleVec3ToRef", compileScaleVec3ToRef],
    ["lerpVec3ToRef", compileLerpVec3ToRef],
    ["lengthVec3", compileLengthVec3],
    ["dotVec3", compileDotVec3],
    ["setMeshVisible", compileSetMeshVisible],
    ["setSubtreeVisible", compileSetMeshVisible],
    ["mat4Invert", compileMat4Invert],
    ["mat4Compose", compileMat4Compose],
    ["normalizeVec3", compileNormalizeVec3],
    ["normalizeVec3Object", compileNormalizeVec3Object],
    ["normalizeVec3ToRef", compileNormalizeVec3ToRef],
    ["mat4Identity", compileMat4Identity],
    ["mat4Translation", compileMat4Translation],
    ["setParent", compileSetParent],
    ["cloneTransformNode", compileCloneTransformNode],
    ["createMeshFromData", compileCreateMeshFromData],
    ["updateMeshPositions", compileUpdateMeshPositions],
    ["createHierarchyInstancePool", compileCreateHierarchyInstancePool],
    ["addHierarchyInstance", (context, call) => compileAddHierarchyInstance(context, call, "addHierarchyInstance")],
    ["setHierarchyInstanceMatrix", (context, call) => compileAddHierarchyInstance(context, call, "setHierarchyInstanceMatrix")],
    ["setHierarchyInstanceCount", (context, call) => compileSetHierarchyInstanceCount(context, call, "setHierarchyInstanceCount")],
    ["removeHierarchyInstance", (context, call) => compileSetHierarchyInstanceCount(context, call, "removeHierarchyInstance")],
    ["setThinInstances", compileSetThinInstances],
    ["setThinInstanceColors", compileSetThinInstanceColors],
    ["setThinInstanceColor", compileSetThinInstanceColor],
    ["setThinInstanceCullBoundsPad", compileSetThinInstanceCullBoundsPad],
    ["setThinInstanceCount", compileSetThinInstanceCount],
    ["setThinInstanceMatrix", compileSetThinInstanceMatrix],
    ["flushThinInstances", compileFlushThinInstances],
    ["addThinInstance", compileAddThinInstance],
    ["removeThinInstance", compileRemoveThinInstance],
    ["enableThinInstanceGpuCulling", compileEnableThinInstanceGpuCulling],
    ["createTransformNode", compileCreateTransformNode],
    ["createBox", compileCreateBox],
    ["createGround", compileCreateGround],
    ["createGroundFromHeightMap", compileCreateGroundFromHeightMap],
    ["createPlane", compileCreatePlane],
    ["createSphere", compileCreateSphere],
    ["createCsgFromMesh", compileCreateCsgFromMesh],
    ["csgUnion", (context, call) => compileCsgUnion(context, call, "csgUnion")],
    ["csgSubtract", (context, call) => compileCsgUnion(context, call, "csgSubtract")],
    ["csgIntersect", (context, call) => compileCsgUnion(context, call, "csgIntersect")],
    ["createMeshFromCsg", compileCreateMeshFromCsg],
    ["createMeshesFromCsg", compileCreateMeshesFromCsg],
    ["createBoxData", (context, call) => compileCreateBoxData(context, call, "createBoxData")],
    ["createSphereData", (context, call) => compileCreateBoxData(context, call, "createSphereData")],
    ["createMorphTargets", compileCreateMorphTargets],
    ["setMorphTargetWeights", compileSetMorphTargetWeights],
    ["createTube", compileCreateTube],
    ["createExtrudeShape", compileCreateExtrudeShape],
    ["createRibbon", compileCreateRibbon],
    ["createPolyhedron", compileCreatePolyhedron],
    ["createCylinder", compileCreateCylinder],
    ["createCapsule", compileCreateCapsule],
    ["createDisc", compileCreateDisc],
    ["createTorusKnot", compileCreateTorusKnot],
    ["createTorus", compileCreateTorus],
]);
