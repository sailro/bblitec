import ts from "typescript";
import type {
    Feature,
    Value,
    ValueKind,
} from "../types.js";

export interface MeshIntrinsicContext {
    expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void;
    compileValue(expression: ts.Expression): Value;
    expectKind(
        value: Value,
        kind: ValueKind,
        node: ts.Node,
    ): void;
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
    compileNumber(expression: ts.Expression): string;
    requireEngine(value: Value, node: ts.Node): string;
    reachFeature(feature: Feature): void;
    unwrap(expression: ts.Expression): ts.Expression;
    fail(node: ts.Node, message: string): never;
}

export function compileMeshIntrinsic(
    context: MeshIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createMeshFromData": {
            context.expectArgumentCount(call, 5, 9);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            // Mesh names have no native meaning yet (picking is not part
            // of the supported subset); the name argument is validated as
            // a static string and dropped.
            context.compileStringLiteral(
                call.arguments[1]!,
            );
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
            const optional = [5, 6, 7, 8].map((index) =>
                call.arguments[index] &&
                call.arguments[index]!.kind !==
                    ts.SyntaxKind.UndefinedKeyword
                    ? context.compileTypedArrayArgument(
                          call.arguments[index]!,
                          "f32array",
                      )
                    : "{}",
            );
            context.reachFeature("mesh:from-data");
            return {
                kind: "mesh",
                cpp:
                    `bbl::create_mesh_from_data(${engine.cpp}, ` +
                    `${positions}, ${normals}, ${indices}, ` +
                    `${optional.join(", ")})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
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
            // re-read it later; the native record keeps the same alias,
            // which requires a named binding rather than a temporary.
            if (
                ts.isNewExpression(
                    context.unwrap(call.arguments[1]!),
                )
            ) {
                context.fail(
                    call.arguments[1]!,
                    "setThinInstances requires a named Float32Array binding; the mesh keeps referencing it for per-frame updates.",
                );
            }
            const matrices =
                context.compileTypedArrayArgument(
                    call.arguments[1]!,
                    "f32array",
                );
            const count = context.compileNumber(
                call.arguments[2]!,
            );
            context.reachFeature("mesh:thin-instances");
            return {
                kind: "void",
                cpp:
                    `bbl::set_thin_instances(${context.requireEngine(mesh, call)}, ` +
                    `${mesh.cpp}, ${matrices}, ${count})`,
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
            context.reachFeature("mesh:thin-instances");
            context.reachFeature(
                "mesh:thin-instances-dynamic",
            );
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
            context.reachFeature("mesh:thin-instances");
            context.reachFeature(
                "mesh:thin-instances-dynamic",
            );
            return {
                kind: "void",
                cpp:
                    `bbl::flush_thin_instances(${context.requireEngine(mesh, call)}, ` +
                    `${mesh.cpp})`,
            };
        }

        case "createBox": {
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
            context.reachFeature("mesh:box");
            return {
                kind: "mesh",
                cpp:
                    `bbl::create_box(${engine.cpp}, ` +
                    `bbl::BoxOptions{${options.join(", ")}})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
        }

        case "createGround": {
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
            context.reachFeature("mesh:ground");
            return {
                kind: "mesh",
                cpp:
                    `bbl::create_ground(${engine.cpp}, ` +
                    `bbl::GroundOptions{${options[0]}, ` +
                    `${options[1]}, ${options[2]}, ` +
                    `bbl::Vec2{${options[3]}, ${options[4]}}})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
        }

        case "createPlane": {
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
            context.reachFeature("mesh:plane");
            return {
                kind: "mesh",
                cpp:
                    `bbl::create_plane(${engine.cpp}, ` +
                    `bbl::PlaneOptions{${options.join(", ")}})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
        }

        case "createSphere": {
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
                : ["32u", "1.0f", "1.0f", "1.0f"];
            context.reachFeature("mesh:sphere");
            return {
                kind: "mesh",
                cpp:
                    `bbl::create_sphere(${engine.cpp}, ` +
                    `bbl::SphereOptions{${options.join(", ")}})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
        }

        case "createTorus": {
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
            context.reachFeature("mesh:torus");
            return {
                kind: "mesh",
                cpp:
                    `bbl::create_torus(${engine.cpp}, ` +
                    `bbl::TorusOptions{${options.join(", ")}})`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
        }

        default:
            return undefined;
    }
}
