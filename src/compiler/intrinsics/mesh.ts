import ts from "typescript";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    validateObjectProperties,
    type ObjectValidationContext,
} from "../option-helpers.js";

export interface MeshIntrinsicContext
    extends IntrinsicCallContext,
        ObjectValidationContext {
    compileBoxOptions(
        expression: ts.Expression,
    ): [string, string, string];
    compileGroundOptions(
        expression: ts.Expression,
    ): [string, string, string, string, string];
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
    requireEngine(value: Value, node: ts.Node): string;
    unwrap(expression: ts.Expression): ts.Expression;
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    readonly handleCollections: {
        tupleElements(
            expression: ts.Expression,
        ): readonly Value[] | undefined;
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

export function compileMeshIntrinsic(
    context: MeshIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
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
            context.expectKind(name, "string", call.arguments[1]!);
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
            context.recordSceneMesh("from-data", {
                hasUv2: optional[1] !== "{}",
                hasTangents: optional[2] !== "{}",
                hasColors: optional[3] !== "{}",
            });
            context.reachFeature("mesh:from-data", call);
            return {
                kind: "mesh",
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
            return {
                kind: "void",
                cpp:
                    `bbl::set_thin_instance_count(${context.requireEngine(mesh, call)}, ` +
                    `${mesh.cpp}, ${count})`,
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
            return {
                kind: "void",
                cpp:
                    `bbl::flush_thin_instances(${context.requireEngine(mesh, call)}, ` +
                    `${mesh.cpp})`,
            };
        }

        case "createBox": {
            context.recordSceneMesh("box");
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
                cpp:
                    `bbl::create_box(${engine.cpp}, ` +
                    `bbl::BoxOptions{${options.join(", ")}})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
                directMorphCompatible: true,
            };
        }

        case "createGround": {
            context.recordSceneMesh("ground");
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
                : [
                      "1.0f",
                      "1.0f",
                      "1u",
                      "1.0f",
                      "1.0f",
                  ];
            context.reachFeature("mesh:ground", call);
            return {
                kind: "mesh",
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

        case "createPlane": {
            context.recordSceneMesh("plane");
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
                cpp:
                    `bbl::create_plane(${engine.cpp}, ` +
                    `bbl::PlaneOptions{${options.join(", ")}})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
                directMorphCompatible: true,
            };
        }

        case "createSphere": {
            context.recordSceneMesh("sphere");
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
            context.recordSceneMesh("from-data", {
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
            // The path arrives inline or bound to a local — a
            // compile-time tuple of Vec3 records whose lanes may be
            // runtime reads (a raycast hit point).
            const boundElements =
                context.handleCollections.tupleElements(pathExpression);
            const points = boundElements
                ? boundElements.map((element) =>
                      vec3RecordCpp(context, element, pathExpression),
                  )
                : context
                      .expectStaticArrayLiteral(
                          context.resolveStaticExpression(
                              pathExpression,
                          ),
                      )
                      .elements.map((element) =>
                          context.compileVec3(element, "double"),
                      );
            context.reachFeature("mesh:tube", call);
            context.reachFeature("mesh:from-data", call);
            return {
                kind: "mesh",
                cpp:
                    `bbl::create_tube(${engine.cpp}, ` +
                    `std::vector<bbl::Vec3d>{${points.join(", ")}}, ` +
                    `${context.compileNumber(radius, "double")}, ` +
                    `${context.compileNumber(tessellation, "double")})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
        }

        case "createTorus": {
            context.recordSceneMesh("torus");
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
