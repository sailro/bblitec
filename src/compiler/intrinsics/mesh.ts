import ts from "typescript";



import type { CompileAsset, Value } from "../types.js";
import type { CompilerSymbols } from "../symbols.js";
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
    csgGeometryDeclarations,
    type CsgSolidPlan,
    type CsgSourceMesh,
} from "../../pinned-csg.js";

export interface MeshIntrinsicContext
    extends IntrinsicCallContext,
        ObjectValidationContext,
        PositiveIntegerContext {
    compileBoxOptions(
        expression: ts.Expression,
    ): [string, string, string];
    compileGroundOptions(
        expression: ts.Expression,
    ): [string, string, string, string, string];
    compileGroundFromHeightMapOptions(
        expression: ts.Expression,
    ): [string, string, string, string, string, string, string];
    registerAsset(
        source: string,
        kind: CompileAsset["kind"],
        faceSize?: number,
    ): CompileAsset;
    cppString(value: string): string;
    requireDefaultEngine(node: ts.Node): string;
    compilePlaneOptions(
        expression: ts.Expression,
    ): [string, string];
    compileSphereOptions(
        expression: ts.Expression,
    ): [string, string, string, string];
    compileTorusOptions(
        expression: ts.Expression,
    ): [string, string, string];
    compileTypedArrayArgument(
        expression: ts.Expression,
        kind: "f32array" | "u32array",
    ): string;
    compileStringLiteral(
        expression: ts.Expression,
    ): string;
    compileVec3(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    vec3FromRecord(
        value: Value,
        node: ts.Node,
        precision?: "float" | "double",
    ): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileCondition(expression: ts.Expression): string;
    reachJsData(): void;
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
    allocateTemporaryCppName(label: string): string;
    emit(line: string): void;
    /** Whether a binding emitted now lives as long as the frame loop. */
    isEntryBodyScope(): boolean;
    recordThinInstanceMesh(sceneMeshIndex: number | undefined): void;
    recordThinInstanceColorMesh(
        sceneMeshIndex: number | undefined,
    ): void;
    recordThinInstanceGpuCulling(
        sceneMeshIndex: number | undefined,
    ): void;
    meshHasThinInstancePool(owner: Value): boolean;
    meshMayHaveThinInstanceGpuCulling(owner: Value): boolean;
    requireEngine(value: Value, node: ts.Node): string;
    expectSameEngine(
        left: Value,
        right: Value,
        node: ts.Node,
    ): void;
    markAssetRootReparented(root: Value, node: ts.Node): void;
    unwrap(expression: ts.Expression): ts.Expression;
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    readonly symbols: CompilerSymbols;
    readonly handleCollections: {
        tupleElements(
            expression: ts.Expression,
        ): readonly Value[] | undefined;
        staticHandleList(
            expression: ts.Expression,
        ): readonly { value: Value; node: ts.Node }[] | undefined;
    };
    fail(node: ts.Node, message: string): never;
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
 * initializer is that call and whose FIRST use is this one -- the
 * strongest rule that needs no dataflow, because a `position` write, a
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
    const earlier: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
        // A subtree starting at or after this argument can hold no
        // earlier occurrence, so the walk stops at the call.
        if (node.getStart(source) >= limit) return;
        if (ts.isIdentifier(node) && node.text === expression.text) {
            earlier.push(node);
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

export function compileMeshIntrinsic(
    context: MeshIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "setMeshVisible":
        case "setSubtreeVisible": {
            context.expectArgumentCount(call, 2, 2);
            const mesh = context.compileValue(call.arguments[0]!);
            context.expectKind(mesh, "mesh", call.arguments[0]!);
            context.reachFeature("mesh:visible", call);
            return {
                kind: "void",
                cpp:
                    `bbl::set_mesh_visible(` +
                    `${context.requireEngine(mesh, call)}, ${mesh.cpp}, ` +
                    `${context.compileCondition(call.arguments[1]!)})`,
            };
        }
        case "mat4Compose": {
            context.expectArgumentCount(call, 10, 10);
            context.reachJsData();
            return {
                kind: "data",
                cpp:
                    `bbl::js::mat4_compose(` +
                    call.arguments
                        .map((argument) =>
                            context.compileNumber(argument, "double"),
                        )
                        .join(", ") +
                    `)`,
                dataType: { kind: "f32array" },
                freshData: true,
            };
        }
        // `src/math/normalize-vec3.ts`, beside the pinned matrix helpers
        // above for the same reason they are here: a scene reaches these
        // as plain math, and the emitted body is the pin's own
        // declaration translated whole rather than a formula restated at
        // the call site. The `1e-10` default rides the emitted signature,
        // so a scene that omits the epsilon takes the pin's.
        case "normalizeVec3": {
            context.expectArgumentCount(call, 3, 4);
            context.reachFeature("math:normalize-vec3", call);
            context.reachJsData();
            return {
                kind: "data",
                // The pinned body answers a plain triple; the array
                // IDENTITY a scene sees is added here, where a scene is
                // what holds it.
                cpp:
                    `bbl::js::Tuple<3>(bbl::upstream::normalize_vec3(` +
                    call.arguments
                        .map((argument) =>
                            context.compileNumber(argument, "double"),
                        )
                        .join(", ") +
                    `))`,
                dataType: { kind: "tuple", arity: 3 },
                freshData: true,
            };
        }
        case "mat4Identity": {
            context.expectArgumentCount(call, 0, 0);
            context.reachJsData();
            // The pin allocates an identity Float32Array. Neutral translation,
            // rotation, and scale are the exact specialization of the pinned
            // mat4Compose stores, including the fresh array identity.
            return {
                kind: "data",
                cpp:
                    `bbl::js::mat4_compose(` +
                    `0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0)`,
                dataType: { kind: "f32array" },
                freshData: true,
            };
        }
        case "mat4Translation": {
            context.expectArgumentCount(call, 3, 3);
            context.reachJsData();
            // Pinned mat4Translation starts from mat4Identity and writes only
            // indices 12..14. This is the corresponding neutral-rotation,
            // unit-scale specialization of the already pinned compose path.
            return {
                kind: "data",
                cpp:
                    `bbl::js::mat4_compose(` +
                    call.arguments
                        .map((argument) =>
                            context.compileNumber(argument, "double"),
                        )
                        .join(", ") +
                    `, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0)`,
                dataType: { kind: "f32array" },
                freshData: true,
            };
        }
        case "setParent": {
            context.expectArgumentCount(call, 2, 2);
            const child = context.compileValue(call.arguments[0]!);
            const parent = context.compileValue(call.arguments[1]!);

            if (child.kind !== "mesh" && child.kind !== "asset-root") {
                context.fail(
                    call.arguments[0]!,
                    `setParent's reached scene-graph slice accepts a Mesh or imported root, received ${child.kind}.`,
                );
            }
            if (
                parent.kind !== "mesh" &&
                parent.kind !== "transform-node" &&
                parent.kind !== "json-null"
            ) {
                context.fail(
                    call.arguments[1]!,
                    `setParent's reached scene-graph slice accepts a Mesh, TransformNode, or null parent, received ${parent.kind}.`,
                );
            }
            if (
                child.kind === "asset-root" &&
                parent.kind !== "transform-node"
            ) {
                context.fail(
                    call,
                    "An imported root is reached only when reparenting it to a TransformNode.",
                );
            }
            if (parent.kind !== "json-null") {
                context.expectSameEngine(child, parent, call);
            }
            context.reachFeature("mesh:parenting", call);
            if (child.kind === "asset-root") {
                context.markAssetRootReparented(
                    child,
                    call.arguments[0]!,
                );
                return {
                    kind: "void",
                    cpp:
                        `bbl::set_asset_root_parent(` +
                        `${context.requireEngine(child, call)}, ${child.cpp}, ` +
                        `${parent.cpp})`,
                };
            }
            return {
                kind: "void",
                cpp:
                    `bbl::set_mesh_parent(` +
                    `${context.requireEngine(child, call)}, ${child.cpp}, ` +
                    `${parent.kind === "json-null" ? "bbl::MeshHandle{}" : parent.cpp})`,
            };
        }

        case "cloneTransformNode": {
            context.expectArgumentCount(call, 1, 1);
            const source = context.compileValue(
                call.arguments[0]!,
            );
            if (source.kind === "mesh") {
                // The pin's own `"_gpu" in src` arm: a mesh routes to
                // cloneMeshNode. The clone is a second wrapper over the
                // source's geometry, so it needs a scene-mesh identity of
                // its own -- everything a scene later writes to it (its
                // name, its material, its transform) must land on the
                // clone rather than on the mesh it was taken from.
                const engine = context.requireEngine(source, call);
                const sceneMeshIndex = context.recordSceneMesh(
                    "mesh-clone",
                );
                return {
                    kind: "mesh",
                    sceneMeshIndex,
                    cpp:
                        `bbl::clone_mesh_node(${engine}, ` +
                        `${source.cpp})`,
                    engineCpp: engine,
                };
            }
            if (source.kind !== "asset-root") {
                context.fail(
                    call.arguments[0]!,
                    "cloneTransformNode is lowered for an imported glTF root hierarchy; another node shape has no native hierarchy representation.",
                );
            }
            const engine = context.requireEngine(source, call);
            return {
                ...source,
                cpp:
                    `bbl::clone_asset_root(${engine}, ` +
                    `${source.cpp})`,
                assetRootClone: true,
                assetRootState: { reparented: false },
            };
        }

        case "createMeshFromData": {
            context.expectArgumentCount(call, 5, 9);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            // The record carries the pinned Mesh name; scene code finds
            // meshes by it.
            const name = context.compileValue(call.arguments[1]!);
            if (
                name.kind !== "string" &&
                !(
                    name.kind === "data" &&
                    name.dataType?.kind === "string"
                )
            ) {
                context.fail(
                    call.arguments[1]!,
                    `Mesh names must be strings, received ${name.kind}.`,
                );
            }
            const positions =
                context.compileTypedArrayArgument(
                    call.arguments[2]!,
                    "f32array",
                );
            const normals =
                context.compileTypedArrayArgument(
                    call.arguments[3]!,
                    "f32array",
                );
            const indices =
                context.compileTypedArrayArgument(
                    call.arguments[4]!,
                    "u32array",
                );
            // The demo modules skip optional slots with literal
            // `undefined`, which parses as an identifier expression.
            const isUndefinedArgument = (
                argument: ts.Expression | undefined,
            ): boolean =>
                !argument ||
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
                if (
                    value.kind === "data" &&
                    value.dataType?.kind === "optional" &&
                    value.dataType.inner.kind === "f32array"
                ) {
                    // The select reads the operand twice, so only a path
                    // is taken: an identifier or a member chain evaluates
                    // to the same storage both times. Anything else --
                    // a call, an indexed read whose subscript is itself an
                    // expression -- refuses here rather than running twice.
                    if (
                        !ts.isIdentifier(unwrapped) &&
                        !ts.isPropertyAccessExpression(unwrapped)
                    ) {
                        context.fail(
                            argument!,
                            "An optional vertex stream must be a local or a " +
                                "member of one: the absent case is selected " +
                                "at run time, which reads the operand twice.",
                        );
                    }
                    context.reachJsData();
                    return {
                        cpp:
                            `(${value.cpp}.has_value() ? ${value.cpp}.value()` +
                            ` : bbl::js::F32Array{})`,
                        present: undefined,
                    };
                }
                return {
                    cpp: context.compileTypedArrayArgument(
                        argument!,
                        "f32array",
                    ),
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
                cpp:
                    `bbl::create_mesh_from_data(${engine.cpp}, ` +
                    `${name.cpp}, ` +
                    `${positions}, ${normals}, ${indices}, ` +
                    `${optional.join(", ")})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
                directMorphCompatible: true,
                ...(streams.some((stream) => stream.present === undefined)
                    ? { runtimeMeshStreams: true as const }
                    : {}),
            };
        }

        case "updateMeshPositions": {
            context.expectArgumentCount(call, 3, 6);
            const engine = context.compileValue(call.arguments[0]!);
            const mesh = context.compileValue(call.arguments[1]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            context.expectKind(mesh, "mesh", call.arguments[1]!);
            context.expectSameEngine(engine, mesh, call);
            const positions = context.compileTypedArrayArgument(
                call.arguments[2]!,
                "f32array",
            );
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
                cpp:
                    `bbl::update_mesh_positions(${engine.cpp}, ${mesh.cpp}, ` +
                    `${positions}, ${vertexOffset}, ${vertexCount}, ` +
                    `${sourceVertexOffset})`,
            };
        }

        case "setThinInstances": {
            context.expectArgumentCount(call, 3, 3);
            const mesh =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                mesh,
                "mesh",
                call.arguments[0]!,
            );
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
            const matricesArgument = context.unwrap(
                call.arguments[1]!,
            );
            const matricesExpression =
                context.compileTypedArrayArgument(
                    call.arguments[1]!,
                    "f32array",
                );
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
                const constantPool =
                    !context.isEntryBodyScope() &&
                    staticFloatArrayArgument(context, matricesArgument);
                if (!context.isEntryBodyScope() && !constantPool) {
                    context.fail(
                        call.arguments[1]!,
                        "setThinInstances takes a named Float32Array binding, or a constant one, inside a block; the mesh keeps referencing it for the whole frame loop.",
                    );
                }
                matrices = context.allocateTemporaryCppName(
                    "thin_instances",
                );
                context.emit(
                    `${constantPool ? "static " : ""}bbl::js::F32Array ` +
                        `${matrices} = ${matricesExpression};`,
                );
            }
            const count = context.compileNumber(
                call.arguments[2]!,
            );
            context.reachFeature("mesh:thin-instances", call);
            context.recordThinInstanceMesh(mesh.sceneMeshIndex);
            return {
                kind: "void",
                cpp:
                    `bbl::set_thin_instances(${context.requireEngine(mesh, call)}, ` +
                    `${mesh.cpp}, ${matrices}, ${count})`,
            };
        }

        case "setThinInstanceColors": {
            // The pinned setter stores the caller's array and bumps the
            // colour version. Nothing in the reached slice re-reads it --
            // `setThinInstanceColor`, the per-instance twin, is unlowered --
            // so the record takes a copy rather than the alias
            // `setThinInstances` needs.
            context.expectArgumentCount(call, 2, 2);
            const mesh =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                mesh,
                "mesh",
                call.arguments[0]!,
            );
            const colors =
                context.compileTypedArrayArgument(
                    call.arguments[1]!,
                    "f32array",
                );
            context.reachFeature("mesh:thin-instance-colors", call);
            // The pin's ShaderMaterial reads this stream's presence off the
            // mesh to decide its instanced prelude, so the record notes it.
            context.recordThinInstanceColorMesh(mesh.sceneMeshIndex);
            return {
                kind: "void",
                cpp:
                    `bbl::set_thin_instance_colors(${context.requireEngine(mesh, call)}, ` +
                    `${mesh.cpp}, ${colors})`,
            };
        }

        case "setThinInstanceCount": {
            context.expectArgumentCount(call, 2, 2);
            const mesh =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                mesh,
                "mesh",
                call.arguments[0]!,
            );
            const count = context.compileNumber(
                call.arguments[1]!,
            );
            context.reachFeature("mesh:thin-instances", call);
            context.reachFeature("mesh:thin-instances-dynamic", call);
            context.recordThinInstanceMesh(mesh.sceneMeshIndex);
            return {
                kind: "void",
                cpp:
                    `bbl::set_thin_instance_count(${context.requireEngine(mesh, call)}, ` +
                    `${mesh.cpp}, ${count})`,
            };
        }

        case "setThinInstanceMatrix": {
            context.expectArgumentCount(call, 3, 3);
            const mesh = context.compileValue(call.arguments[0]!);
            context.expectKind(mesh, "mesh", call.arguments[0]!);
            const index = context.compileNumber(
                call.arguments[1]!,
                "double",
            );
            const matrix = context.compileTypedArrayArgument(
                call.arguments[2]!,
                "f32array",
            );
            context.reachFeature("mesh:thin-instances-dynamic", call);
            context.recordThinInstanceMesh(mesh.sceneMeshIndex);
            return {
                kind: "void",
                cpp:
                    `bbl::set_thin_instance_matrix(` +
                    `${context.requireEngine(mesh, call)}, ${mesh.cpp}, ` +
                    `${index}, ${matrix})`,
            };
        }

        case "flushThinInstances": {
            context.expectArgumentCount(call, 1, 1);
            const mesh =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                mesh,
                "mesh",
                call.arguments[0]!,
            );
            context.reachFeature("mesh:thin-instances", call);
            context.reachFeature("mesh:thin-instances-dynamic", call);
            context.recordThinInstanceMesh(mesh.sceneMeshIndex);
            return {
                kind: "void",
                cpp:
                    `bbl::flush_thin_instances(${context.requireEngine(mesh, call)}, ` +
                    `${mesh.cpp})`,
            };
        }

        case "addThinInstance": {
            // The growing half of the pool. Unlike `setThinInstances`, the
            // matrix is copied rather than aliased -- the pin's own
            // `matrices.set(matrix, index * 16)` reads it once -- so an
            // inline `mat4Identity()` needs no named binding here.
            context.expectArgumentCount(call, 2, 2);
            const mesh = context.compileValue(call.arguments[0]!);
            context.expectKind(mesh, "mesh", call.arguments[0]!);
            const matrix = context.compileTypedArrayArgument(
                call.arguments[1]!,
                "f32array",
            );
            context.reachFeature("mesh:thin-instances", call);
            context.reachFeature("mesh:thin-instances-dynamic", call);
            context.recordThinInstanceMesh(mesh.sceneMeshIndex);
            return {
                kind: "number",
                cpp:
                    `bbl::add_thin_instance(` +
                    `${context.requireEngine(mesh, call)}, ${mesh.cpp}, ` +
                    `${matrix})`,
                dataType: { kind: "number" },
            };
        }

        case "removeThinInstance": {
            context.expectArgumentCount(call, 2, 2);
            const mesh = context.compileValue(call.arguments[0]!);
            context.expectKind(mesh, "mesh", call.arguments[0]!);
            const index = context.compileNumber(
                call.arguments[1]!,
                "double",
            );
            context.reachFeature("mesh:thin-instances", call);
            context.reachFeature("mesh:thin-instances-dynamic", call);
            context.recordThinInstanceMesh(mesh.sceneMeshIndex);
            return {
                kind: "void",
                cpp:
                    `bbl::remove_thin_instance(` +
                    `${context.requireEngine(mesh, call)}, ${mesh.cpp}, ` +
                    `${index})`,
            };
        }

        case "enableThinInstanceGpuCulling": {
            // Upstream this is a performance opt-in whose visible output is
            // unchanged, and whose second effect -- routing the renderable
            // to a direct draw, out of the cached opaque bundle -- is what
            // an application relies on for per-frame pool sync. This port
            // records no bundles and syncs every live pool every frame, so
            // the flag lands on the record as an explicit marker and the
            // compute culler itself is a recorded omission.
            context.expectArgumentCount(call, 1, 2);
            const mesh = context.compileValue(call.arguments[0]!);
            context.expectKind(mesh, "mesh", call.arguments[0]!);
            const enabled = call.arguments[1]
                ? context.compileCondition(call.arguments[1])
                : pinnedParameterFlag(
                      "src/mesh/thin-instance.ts",
                      "enableThinInstanceGpuCulling",
                      "enabled",
                  )
                  ? "true"
                  : "false";
            context.reachFeature("mesh:thin-instances", call);
            // The pin reads `mesh.thinInstances` and throws without one, so
            // a mesh generation resolved and never bound a pool on fails at
            // its own line -- the same failure, at the same call. A mesh
            // arriving as a runtime handle keeps the emitted call's own.
            if (!context.meshHasThinInstancePool(mesh)) {
                context.fail(
                    call,
                    "enableThinInstanceGpuCulling requires a " +
                        "thin-instance pool this mesh never establishes; " +
                        "bind one with setThinInstances or " +
                        "addThinInstance first.",
                );
            }
            if (
                enabled === "false" &&
                !context.meshMayHaveThinInstanceGpuCulling(mesh)
            ) {
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
            context.reachFeature(
                "mesh:thin-instance-gpu-culling",
                call,
            );
            context.recordThinInstanceGpuCulling(mesh.sceneMeshIndex);
            return {
                kind: "void",
                cpp:
                    `bbl::enable_thin_instance_gpu_culling(` +
                    `${context.requireEngine(mesh, call)}, ${mesh.cpp}, ` +
                    `${enabled})`,
            };
        }

        case "createTransformNode": {
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
            const name = context.compileValue(call.arguments[0]!);
            if (
                name.kind !== "string" &&
                !(
                    name.kind === "data" &&
                    name.dataType?.kind === "string"
                )
            ) {
                context.fail(
                    call.arguments[0]!,
                    `TransformNode names must be strings, received ${name.kind}.`,
                );
            }
            const defaults = transformNodeDefaults();
            const argument = (
                index: number,
                parameter: TransformNodeParameter,
                precision: "float" | "double",
            ): string => {
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
            const position =
                `bbl::Vec3d{${argument(1, "px", "double")}, ` +
                `${argument(2, "py", "double")}, ` +
                `${argument(3, "pz", "double")}}`;
            const rotation =
                `bbl::Vec4{${argument(4, "qx", "float")}, ` +
                `${argument(5, "qy", "float")}, ` +
                `${argument(6, "qz", "float")}, ` +
                `${argument(7, "qw", "float")}}`;
            const scaling =
                `bbl::Vec3{${argument(8, "sx", "float")}, ` +
                `${argument(9, "sy", "float")}, ` +
                `${argument(10, "sz", "float")}}`;
            context.reachFeature("mesh:transform-node", call);
            return {
                kind: "transform-node",
                cpp:
                    `bbl::create_transform_node(${engine}, ` +
                    `${name.cpp}, ${position}, ${rotation}, ${scaling})`,
                engineCpp: engine,
            };
        }

        case "createBox": {
            const sceneMeshIndex = context.recordSceneMesh("box");
            context.expectArgumentCount(call, 1, 2);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const options = call.arguments[1]
                ? context.compileBoxOptions(call.arguments[1])
                : ["1.0f", "1.0f", "1.0f"];
            context.reachFeature("mesh:box", call);
            return {
                kind: "mesh",
                sceneMeshIndex,
                cpp:
                    `bbl::create_box(${engine.cpp}, ` +
                    `bbl::BoxOptions{${options.join(", ")}})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
                directMorphCompatible: true,
            };
        }

        case "createGround": {
            const sceneMeshIndex = context.recordSceneMesh("ground");
            context.expectArgumentCount(call, 1, 2);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const options = call.arguments[1]
                ? context.compileGroundOptions(call.arguments[1])
                : GROUND_OPTION_DEFAULTS;
            context.reachFeature("mesh:ground", call);
            return {
                kind: "mesh",
                sceneMeshIndex,
                cpp:
                    `bbl::create_ground(${engine.cpp}, ` +
                    `bbl::GroundOptions{${options[0]}, ` +
                    `${options[1]}, ${options[2]}, ` +
                    `bbl::Vec2{${options[3]}, ${options[4]}}})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
                directMorphCompatible: true,
            };
        }

        case "createGroundFromHeightMap": {
            const sceneMeshIndex = context.recordSceneMesh("ground");
            context.expectArgumentCount(call, 2, 3);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const asset = context.registerAsset(
                context.compileStringLiteral(call.arguments[1]!),
                "texture",
            );
            const options = call.arguments[2]
                ? context.compileGroundFromHeightMapOptions(
                      call.arguments[2],
                  )
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
                cpp:
                    `bbl::create_ground_from_height_map(${engine.cpp}, ` +
                    `bbl::GroundOptions{${options[0]}, ` +
                    `${options[1]}, ${options[2]}, ` +
                    `bbl::Vec2{${options[3]}, ${options[4]}}}, ` +
                    `${options[5]}, ${options[6]}, ` +
                    `${context.cppString(asset.output)})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
                directMorphCompatible: true,
            };
        }

        case "createPlane": {
            const sceneMeshIndex = context.recordSceneMesh("plane");
            context.expectArgumentCount(call, 1, 2);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const options = call.arguments[1]
                ? context.compilePlaneOptions(call.arguments[1])
                : ["1.0f", "1.0f"];
            context.reachFeature("mesh:plane", call);
            return {
                kind: "mesh",
                sceneMeshIndex,
                cpp:
                    `bbl::create_plane(${engine.cpp}, ` +
                    `bbl::PlaneOptions{${options.join(", ")}})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
                directMorphCompatible: true,
            };
        }

        case "createSphere": {
            const sceneMeshIndex = context.recordSceneMesh("sphere");
            context.expectArgumentCount(call, 1, 2);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const options = call.arguments[1]
                ? context.compileSphereOptions(call.arguments[1])
                : ["32u", "1.0", "1.0", "1.0"];
            context.reachFeature("mesh:sphere", call);
            return {
                kind: "mesh",
                sceneMeshIndex,
                cpp:
                    `bbl::create_sphere(${engine.cpp}, ` +
                    `bbl::SphereOptions{${options.join(", ")}})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
                directMorphCompatible: true,
            };
        }

        // ── src/mesh/csg.ts ─────────────────────────────────────────
        // A solid is generation-only. `createCsgFromMesh` and the three
        // booleans build a plan; `createMeshFromCsg` replays it against
        // the pin's own modules and bakes the geometry the pin handed
        // `createMeshFromData`, which is where every CSG mesh already
        // ends. Why the value is executed rather than the shape folded is
        // in `src/pinned-csg.ts`.
        case "createCsgFromMesh": {
            context.expectArgumentCount(call, 1, 2);
            const mesh = context.compileValue(call.arguments[0]!);
            context.expectKind(mesh, "mesh", call.arguments[0]!);
            const builder = csgSourceCall(context, call.arguments[0]!);
            const source =
                builder && csgSourceFromCall(context, builder);
            if (!source) {
                context.fail(
                    call.arguments[0]!,
                    "createCsgFromMesh replays the pinned factory that " +
                        "built the mesh's retained CPU geometry and bakes " +
                        "its world matrix into every polygon, so the " +
                        "reached slice is createBox or createSphere with " +
                        "generation-known options, named here or by a " +
                        "local binding whose first use is this call.",
                );
            }
            const materialSlot = call.arguments[1]
                ? staticNumberValue(
                      context,
                      context.unwrap(call.arguments[1]),
                  )
                : 0;
            if (materialSlot === undefined) {
                context.fail(
                    call.arguments[1]!,
                    "A CSG material slot tags every polygon the solid " +
                        "carries, so it is generation-known.",
                );
            }
            context.reachFeature("mesh:csg", call);
            return {
                kind: "csg-solid",
                cpp: "",
                csgSolid: { op: "from-mesh", source, materialSlot },
            };
        }

        case "csgUnion":
        case "csgSubtract":
        case "csgIntersect": {
            context.expectArgumentCount(call, 2, 2);
            const op = csgBooleanNames.find(
                (name) => name === importedName,
            )!;
            const left = requireCsgSolid(context, call.arguments[0]!);
            const right = requireCsgSolid(context, call.arguments[1]!);
            context.reachFeature("mesh:csg", call);
            return {
                kind: "csg-solid",
                cpp: "",
                // The plan names the pin's own export, so the replay
                // looks the boolean up rather than translating it.
                csgSolid: { op, left, right },
            };
        }

        case "createMeshFromCsg": {
            context.expectArgumentCount(call, 2, 3);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const plan = requireCsgSolid(context, call.arguments[1]!);
            // `createMeshFromCsg(engine, solid, name = "csg")`: the name
            // reaches `createMeshFromData` and nothing else, so it is the
            // mesh record's name here exactly as it is upstream.
            const name = call.arguments[2]
                ? context.compileValue(call.arguments[2])
                : undefined;
            if (name && name.staticString === undefined) {
                context.fail(
                    call.arguments[2]!,
                    "A CSG mesh's name is generation-known: the solid is " +
                        "replayed at generation and the mesh it produces " +
                        "is named there.",
                );
            }
            const meshName = name?.staticString ?? "csg";
            const baked = bakeCsgMesh(plan, meshName);
            const prefix =
                context.allocateTemporaryCppName("csg_geometry");
            const geometry = csgGeometryDeclarations(prefix, baked);
            for (const line of geometry.lines) context.emit(line);
            const sceneMeshIndex = context.recordSceneMesh(
                "from-data",
                {
                    hasUv2: false,
                    hasTangents: false,
                    hasColors: false,
                },
            );
            context.reachFeature("mesh:csg", call);
            context.reachFeature("mesh:from-data", call);
            return {
                kind: "mesh",
                sceneMeshIndex,
                cpp:
                    `bbl::create_mesh_from_data(${engine.cpp}, ` +
                    `${context.cppString(meshName)}, ` +
                    `${geometry.positions}, ${geometry.normals}, ` +
                    `${geometry.indices}, ${geometry.uvs}, {}, {}, {})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
                directMorphCompatible: true,
            };
        }

        case "createMeshesFromCsg": {
            // The multi-material sibling: it partitions the solid's
            // polygons by their material slot and builds one mesh per
            // slot. No corpus scene reaches it, and the slice this port
            // bakes carries one mesh, so it refuses rather than baking
            // the first partition and dropping the rest.
            context.fail(
                call,
                "createMeshesFromCsg splits a solid across one mesh per " +
                    "material slot; the reached slice is createMeshFromCsg.",
            );
        }

        case "createSphereData": {
            context.expectArgumentCount(call, 0, 1);
            const options = call.arguments[0]
                ? context.compileSphereOptions(
                      call.arguments[0],
                  )
                : ["32u", "1.0", "1.0", "1.0"];
            const temporary =
                context.allocateTemporaryCppName(
                    "sphere_data",
                );
            context.emit(
                `bbl::SphereMeshData ${temporary} = bbl::create_sphere_data(` +
                    `bbl::SphereOptions{${options.join(", ")}});`,
            );
            context.reachFeature("mesh:sphere", call);
            return {
                kind: "record",
                cpp: "",
                recordProperties: {
                    positions: {
                        kind: "data",
                        cpp: `${temporary}.positions`,
                        dataType: { kind: "f32array" },
                    },
                    normals: {
                        kind: "data",
                        cpp: `${temporary}.normals`,
                        dataType: { kind: "f32array" },
                    },
                    uvs: {
                        kind: "data",
                        cpp: `${temporary}.uvs`,
                        dataType: { kind: "f32array" },
                    },
                    indices: {
                        kind: "data",
                        cpp: `${temporary}.indices`,
                        dataType: { kind: "u32array" },
                    },
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

        case "createMorphTargets": {
            context.expectArgumentCount(call, 4, 4);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const targets =
                context.expectStaticArrayLiteral(
                    call.arguments[1]!,
                );
            if (targets.elements.length !== 1) {
                context.fail(
                    targets,
                    "Direct createMorphTargets currently supports exactly one target.",
                );
            }
            const target = context.expectObjectLiteral(
                targets.elements[0]!,
            );
            for (const property of target.properties) {
                const name =
                    (ts.isPropertyAssignment(property) ||
                        ts.isShorthandPropertyAssignment(
                            property,
                        )) &&
                    (ts.isIdentifier(property.name) ||
                        ts.isStringLiteral(property.name))
                        ? property.name.text
                        : undefined;
                if (
                    name !== "positions" &&
                    name !== "normals"
                ) {
                    context.fail(
                        property,
                        "Morph targets support positions and normals.",
                    );
                }
            }
            const positions = context.objectProperty(
                target,
                "positions",
            );
            const normals = context.objectProperty(
                target,
                "normals",
            );
            if (!positions || !normals) {
                context.fail(
                    target,
                    "Morph targets require positions and normals.",
                );
            }
            const normalValue =
                context.unwrap(normals).kind ===
                ts.SyntaxKind.NullKeyword
                    ? "{}"
                    : context.compileTypedArrayArgument(
                          normals,
                          "f32array",
                      );
            const weights = context.unwrap(
                call.arguments[3]!,
            );
            let weight = "0.0f";
            if (
                weights.kind !==
                ts.SyntaxKind.NullKeyword
            ) {
                const values =
                    context.expectStaticArrayLiteral(
                        weights,
                    );
                if (values.elements.length !== 1) {
                    context.fail(
                        values,
                        "Direct createMorphTargets requires one initial weight.",
                    );
                }
                weight = context.compileNumber(
                    values.elements[0]!,
                );
            }
            context.reachFeature("mesh:morph-targets", call);
            return {
                kind: "morph-targets",
                cpp: "",
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
                morphTarget: {
                    positionsCpp:
                        context.compileTypedArrayArgument(
                            positions,
                            "f32array",
                        ),
                    normalsCpp: normalValue,
                    vertexCountCpp:
                        context.compileNumber(
                            call.arguments[2]!,
                        ),
                    weightCpp: weight,
                },
            };
        }

        case "setMorphTargetWeights": {
            context.expectArgumentCount(call, 3, 3);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const morph =
                context.compileValue(call.arguments[1]!);
            context.expectKind(
                morph,
                "morph-targets",
                call.arguments[1]!,
            );
            if (
                morph.engineCpp !==
                (engine.engineCpp ?? engine.cpp)
            ) {
                context.fail(
                    call,
                    "Morph targets and engine must belong to the same engine.",
                );
            }
            const mesh = morph.morphTarget?.meshCpp;
            if (!mesh) {
                context.fail(
                    call.arguments[1]!,
                    "Morph targets must be attached to a mesh before their weights are updated.",
                );
            }
            const weights =
                context.compileTypedArrayArgument(
                    call.arguments[2]!,
                    "f32array",
                );
            context.reachFeature("mesh:morph-targets", call);
            return {
                kind: "void",
                cpp:
                    `bbl::set_morph_target_weights(${engine.cpp}, ` +
                    `${mesh}, ${weights})`,
            };
        }

        case "createTube": {
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
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const options = context.expectObjectLiteral(
                call.arguments[1]!,
            );
            validateObjectProperties(
                context,
                options,
                ["path", "radius", "tessellation"],
                "Reached tubes name their path, radius and tessellation; cap, arc and radiusFunction are not lowered.",
            );
            const pathExpression = context.objectProperty(
                options,
                "path",
            );
            const radius = context.objectProperty(options, "radius");
            const tessellation = context.objectProperty(
                options,
                "tessellation",
            );
            if (!pathExpression || !radius || !tessellation) {
                context.fail(
                    call.arguments[1]!,
                    "Reached tubes name their path, radius and tessellation explicitly.",
                );
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
                cpp:
                    `bbl::create_tube(${engine.cpp}, ` +
                    `${points}, ` +
                    `${context.compileNumber(radius, "double")}, ` +
                    `${context.compileNumber(tessellation, "double")})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
        }

        case "createExtrudeShape": {
            // A 2D shape swept along a 3D path. `cap` is unreached and
            // refuses by name; `scale` and `rotation` take the factory's
            // own `??` defaults.
            const sceneMeshIndex = context.recordSceneMesh("from-data", {
                hasUv2: false,
                hasTangents: false,
                hasColors: false,
            });
            context.expectArgumentCount(call, 2, 2);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const options = context.expectObjectLiteral(call.arguments[1]!);
            validateObjectProperties(
                context,
                options,
                ["shape", "path", "scale", "rotation"],
                "Reached extrusions name their shape, path, scale and " +
                    "rotation; cap is not lowered.",
            );
            const shape = context.objectProperty(options, "shape");
            const curve = context.objectProperty(options, "path");
            if (!shape || !curve) {
                context.fail(
                    call.arguments[1]!,
                    "An extrusion needs its shape and its path.",
                );
            }
            const extrudeDefault = (local: string): string =>
                doubleLiteral(
                    pinnedMeshOptionDefault(
                        "src/mesh/create-extrude.ts",
                        "createExtrudeShapeData",
                        local,
                    ),
                );
            const scale = context.objectProperty(options, "scale");
            const rotation = context.objectProperty(options, "rotation");
            context.reachFeature("mesh:extrude", call);
            context.reachFeature("mesh:from-data", call);
            return {
                kind: "mesh",
                sceneMeshIndex,
                cpp:
                    `bbl::create_extrude_shape(${engine.cpp}, ` +
                    `${compileVec3Path(context, shape)}, ` +
                    `${compileVec3Path(context, curve)}, ` +
                    `${
                        scale
                            ? context.compileNumber(scale, "double")
                            : extrudeDefault("scale")
                    }, ` +
                    `${
                        rotation
                            ? context.compileNumber(rotation, "double")
                            : extrudeDefault("rotation")
                    })`,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "createRibbon": {
            // The reached subset is the path array alone. `closeArray`,
            // `closePath` and `offset` are the pin's own defaults, folded
            // here so the record carries what the builder reads.
            const sceneMeshIndex = context.recordSceneMesh("from-data", {
                hasUv2: false,
                hasTangents: false,
                hasColors: false,
            });
            context.expectArgumentCount(call, 2, 2);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const options = context.expectObjectLiteral(call.arguments[1]!);
            validateObjectProperties(
                context,
                options,
                ["pathArray"],
                "Reached ribbons name their pathArray; closeArray, " +
                    "closePath and offset are the pin's own defaults.",
            );
            const pathArray = context.objectProperty(options, "pathArray");
            if (!pathArray) {
                context.fail(
                    call.arguments[1]!,
                    "A ribbon needs its pathArray.",
                );
            }
            const paths = compileVec3PathArray(context, pathArray);
            context.reachFeature("mesh:ribbon", call);
            return {
                kind: "mesh",
                sceneMeshIndex,
                cpp:
                    `bbl::create_ribbon(${engine.cpp}, ` +
                    `bbl::RibbonOptions{` +
                    `${paths}, false, false})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "createPolyhedron": {
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
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const polyhedronDefault = (local: string): number =>
                pinnedMeshOptionDefault(
                    "src/mesh/create-polyhedron.ts",
                    "createPolyhedronData",
                    local,
                );
            const sizes: Record<string, string> = {
                sizeX: doubleLiteral(polyhedronDefault("sizeX")),
                sizeY: doubleLiteral(polyhedronDefault("sizeY")),
                sizeZ: doubleLiteral(polyhedronDefault("sizeZ")),
            };
            let type = polyhedronDefault("type");
            let flat = pinnedMeshOptionFlag(
                "src/mesh/create-polyhedron.ts",
                "createPolyhedronData",
                "flat",
            )
                ? "true"
                : "false";
            if (call.arguments[1]) {
                const options = context.expectObjectLiteral(
                    call.arguments[1],
                );
                validateObjectProperties(
                    context,
                    options,
                    ["type", "size", "sizeX", "sizeY", "sizeZ", "flat"],
                    "Reached polyhedra name their type, size and flatness.",
                );
                const typeExpression = context.objectProperty(
                    options,
                    "type",
                );
                if (typeExpression) {
                    const value = context.compileValue(typeExpression);
                    if (
                        value.kind !== "number" ||
                        value.staticNumber === undefined
                    ) {
                        context.fail(
                            typeExpression,
                            "A polyhedron's type selects a pinned table row " +
                                "at generation, so it must be a " +
                                "compile-time number.",
                        );
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
                    if (!expression) continue;
                    sizes[axis] = context.compileNumber(
                        expression,
                        "double",
                    );
                }
                const flatExpression = context.objectProperty(
                    options,
                    "flat",
                );
                if (flatExpression) {
                    // The emitted body branches on this per build -- both
                    // the flat and the smooth arm are lowered -- so it
                    // travels as the record field it is rather than being
                    // resolved here.
                    const value = context.compileValue(flatExpression);
                    if (value.kind !== "boolean") {
                        context.fail(
                            flatExpression,
                            "A polyhedron's `flat` is a boolean, received " +
                                `${value.kind}.`,
                        );
                    }
                    flat = value.cpp;
                }
            }
            const preset = pinnedPolyhedron(type);
            const rows = (
                table: readonly (readonly number[])[],
            ): string =>
                `{${table
                    .map(
                        (row) =>
                            `{${row.map((value) => doubleLiteral(value)).join(", ")}}`,
                    )
                    .join(", ")}}`;
            context.reachFeature("mesh:polyhedron", call);
            return {
                kind: "mesh",
                sceneMeshIndex,
                cpp:
                    `bbl::create_polyhedron(${engine.cpp}, ` +
                    `bbl::PolyhedronOptions{` +
                    `${sizes["sizeX"]}, ${sizes["sizeY"]}, ` +
                    `${sizes["sizeZ"]}, ${flat}, ` +
                    `${rows(preset.vertex)}, ${rows(preset.face)}})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "createCylinder": {
            // The pinned option set, with `diameter` resolved here because
            // the emitted record carries the two ends the builder actually
            // reads. Each default is the factory's own `??` value.
            const sceneMeshIndex = context.recordSceneMesh("from-data", {
                hasUv2: false,
                hasTangents: false,
                hasColors: false,
            });
            context.expectArgumentCount(call, 1, 2);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const cylinderDefault = (local: string): string =>
                doubleLiteral(
                    pinnedMeshOptionDefault(
                        "src/mesh/create-cylinder.ts",
                        "createCylinderData",
                        local,
                    ),
                );
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
                const options = context.expectObjectLiteral(
                    call.arguments[1],
                );
                validateObjectProperties(
                    context,
                    options,
                    accepted,
                    "Reached cylinders name height, diameter (or its two " +
                        "ends), tessellation and subdivisions.",
                );
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
                    if (!expression) continue;
                    cylinderResolved[name] = context.compileNumber(
                        expression,
                        "double",
                    );
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
                cpp:
                    `bbl::create_cylinder(${engine.cpp}, ` +
                    `bbl::CylinderOptions{` +
                    `${emitted
                        .map((name) => cylinderResolved[name])
                        .join(", ")}, ${topIsZero}})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "createDisc": {
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
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const fields = ["radius", "tessellation", "arc"] as const;
            const resolved: Record<string, string> = Object.fromEntries(
                fields.map((name) => [
                    name,
                    doubleLiteral(
                        pinnedMeshOptionDefault(
                            "src/mesh/create-disc.ts",
                            "createDiscData",
                            name,
                        ),
                    ),
                ]),
            );
            if (call.arguments[1]) {
                const options = context.expectObjectLiteral(
                    call.arguments[1],
                );
                validateObjectProperties(
                    context,
                    options,
                    fields,
                    "Reached discs name their radius, tessellation and arc.",
                );
                for (const name of fields) {
                    const expression = context.objectProperty(options, name);
                    if (!expression) continue;
                    resolved[name] = context.compileNumber(
                        expression,
                        "double",
                    );
                }
            }
            context.reachFeature("mesh:disc", call);
            return {
                kind: "mesh",
                sceneMeshIndex,
                cpp:
                    `bbl::create_disc(${engine.cpp}, ` +
                    `bbl::DiscOptions{` +
                    `${fields.map((name) => resolved[name]).join(", ")}})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "createTorusKnot": {
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
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const fields = [
                "radius",
                "tube",
                "radialSegments",
                "tubularSegments",
                "p",
                "q",
            ] as const;
            const resolved: Record<string, string> = Object.fromEntries(
                fields.map((name) => [
                    name,
                    doubleLiteral(
                        pinnedMeshOptionDefault(
                            "src/mesh/create-torus-knot.ts",
                            "createTorusKnotData",
                            name,
                        ),
                    ),
                ]),
            );
            if (call.arguments[1]) {
                const options = context.expectObjectLiteral(
                    call.arguments[1],
                );
                validateObjectProperties(
                    context,
                    options,
                    fields,
                    "Reached torus knots name their radius, tube, " +
                        "segment counts and (p, q) winding.",
                );
                for (const name of fields) {
                    const expression = context.objectProperty(options, name);
                    if (!expression) continue;
                    resolved[name] = context.compileNumber(
                        expression,
                        "double",
                    );
                }
            }
            context.reachFeature("mesh:torus-knot", call);
            return {
                kind: "mesh",
                sceneMeshIndex,
                cpp:
                    `bbl::create_torus_knot(${engine.cpp}, ` +
                    `bbl::TorusKnotOptions{` +
                    `${fields.map((name) => resolved[name]).join(", ")}})`,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "createTorus": {
            const sceneMeshIndex = context.recordSceneMesh("torus");
            context.expectArgumentCount(call, 1, 2);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const options = call.arguments[1]
                ? context.compileTorusOptions(call.arguments[1])
                : ["1.0f", "0.5f", "16u"];
            context.reachFeature("mesh:torus", call);
            return {
                kind: "mesh",
                sceneMeshIndex,
                cpp:
                    `bbl::create_torus(${engine.cpp}, ` +
                    `bbl::TorusOptions{${options.join(", ")}})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
                directMorphCompatible: true,
            };
        }

        default:
            return undefined;
    }
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
        ? context.resolveStaticExpression(argument.arguments[0]!)
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
