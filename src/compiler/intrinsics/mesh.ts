import ts from "typescript";



import type { CompileAsset, Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    validateObjectProperties,
    type ObjectValidationContext,
} from "../option-helpers.js";
import { GROUND_OPTION_DEFAULTS } from "./mesh-options.js";
import {
    transformNodeDefaults,
    type TransformNodeParameter,
} from "../../pinned-mesh-defaults.js";
import { doubleLiteral, floatLiteral } from "../../cpp-literals.js";
import {
    pinnedMeshOptionDefault,
    pinnedMeshOptionFlag,
} from "../../pinned-mesh-defaults.js";
import {
    pinnedPolyhedron,
    pinnedPolyhedronCount,
} from "../../pinned-polyhedra.js";

export interface MeshIntrinsicContext
    extends IntrinsicCallContext,
        ObjectValidationContext {
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
    requireEngine(value: Value, node: ts.Node): string;
    expectSameEngine(
        left: Value,
        right: Value,
        node: ts.Node,
    ): void;
    unwrap(expression: ts.Expression): ts.Expression;
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
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

/** A Vec3d expression from a tuple element: a record's x/y/z lanes at
 *  JS-double width, through the evaluator's one record-to-vector home. */
function vec3RecordCpp(
    context: MeshIntrinsicContext,
    element: Value,
    node: ts.Node,
): string {
    if (element.kind !== "record") {
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
                .map((row) =>
                    row.tupleElements
                        ? vec3PointsCpp(
                              context,
                              row.tupleElements,
                              expression,
                          )
                        : context.fail(
                              expression,
                              "Each ribbon path must be a list of Vec3 " +
                                  "records.",
                          ),
                )
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

export function compileMeshIntrinsic(
    context: MeshIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
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
        case "setParent": {
            context.expectArgumentCount(call, 2, 2);
            const child = context.compileValue(call.arguments[0]!);
            context.expectKind(child, "mesh", call.arguments[0]!);
            const parent = context.compileValue(call.arguments[1]!);
            if (parent.kind !== "mesh" && parent.kind !== "json-null") {
                context.fail(
                    call.arguments[1]!,
                    `setParent's reached scene-graph slice accepts a Mesh or null, received ${parent.kind}.`,
                );
            }
            if (parent.kind === "mesh") {
                context.expectSameEngine(child, parent, call);
            }
            context.reachFeature("mesh:parenting", call);
            return {
                kind: "void",
                cpp:
                    `bbl::set_mesh_parent(` +
                    `${context.requireEngine(child, call)}, ${child.cpp}, ` +
                    `${parent.kind === "mesh" ? parent.cpp : "bbl::MeshHandle{}"})`,
            };
        }

        case "cloneTransformNode": {
            context.expectArgumentCount(call, 1, 1);
            const source = context.compileValue(
                call.arguments[0]!,
            );
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
            const optional = [5, 6, 7, 8].map((index) =>
                !isUndefinedArgument(call.arguments[index])
                    ? context.compileTypedArrayArgument(
                          call.arguments[index]!,
                          "f32array",
                      )
                    : "{}",
            );
            // The streams decide the mesh half of the variant key, in the
            // pin's own argument order: uvs, uv2s, tangents, colors.
            const sceneMeshIndex = context.recordSceneMesh("from-data", {
                hasUv2: optional[1] !== "{}",
                hasTangents: optional[2] !== "{}",
                hasColors: optional[3] !== "{}",
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
            // would not outlive its block, so that refuses instead.
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
                if (!context.isEntryBodyScope()) {
                    context.fail(
                        call.arguments[1]!,
                        "setThinInstances takes a named Float32Array binding inside a block; the mesh keeps referencing it for the whole frame loop.",
                    );
                }
                matrices = context.allocateTemporaryCppName(
                    "thin_instances",
                );
                context.emit(
                    `bbl::js::F32Array ${matrices} = ${matricesExpression};`,
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
                    `${context.cppString(
                        context.compileStringLiteral(
                            call.arguments[0]!,
                        ),
                    )}, ${position}, ${rotation}, ${scaling})`,
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
