import ts from "typescript";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";

export interface PickingIntrinsicContext
    extends IntrinsicCallContext {
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    requireEngine(value: Value, node: ts.Node): string;
    fail(node: ts.Node, message: string): never;
}

/**
 * GPU picking, at the slice scene 129 reaches.
 *
 * The pin renders the scene into a ONE-PIXEL target through a view
 * projection sheared so the sampled point lands on that pixel
 * (`computePickVP`), writes each candidate's id as a colour and its depth
 * to a second attachment, and reads both back. Nothing about it is a ray
 * cast, which is why the answer is the renderer's rather than the scene
 * graph's -- a splat cloud has no triangles to intersect and still picks.
 *
 * The picker is a handle rather than a value because it owns GPU
 * resources: the two 1x1 attachments, the depth buffer and the two staging
 * buffers the readback maps. `disposePicker` releases them, and a build
 * that never disposes still frees them with the renderer.
 *
 * What refuses here is everything the reached slice does not name: the
 * `filter`, `discard` and `ignore` options each select a different pinned
 * pipeline (`picking-advanced-pipeline.js`, `picking-ignore.js`), and
 * `enableDetailedPicking` adds a third attachment plus the barycentric
 * readback that `detailed-picking.js` owns. Each is its own contract, and
 * composing one from this one would be guessing.
 */
export function compilePickingIntrinsic(
    context: PickingIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "createGpuPicker": {
            context.expectArgumentCount(call, 1, 1);
            const scene = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            context.reachFeature("picking:gpu", call);
            return {
                kind: "gpu-picker",
                cpp: `bbl::create_gpu_picker(${scene.cpp})`,
                engineCpp: scene.engineCpp ?? scene.cpp,
            };
        }

        // Upstream this is a promise because the readback maps a buffer;
        // here the readback is a wait on submitted work, so the value is
        // ready when the call returns and the `await` resolves immediately
        // -- the same shape every materialized asset takes.
        case "pickAsync": {
            context.expectArgumentCount(call, 3, 4);
            if (call.arguments.length === 4) {
                context.fail(
                    call.arguments[3]!,
                    "pickAsync options are not lowered: `filter`, " +
                        "`discard` and `ignore` each select a different " +
                        "pinned picking pipeline, and the reached slice " +
                        "passes none.",
                );
            }
            const picker = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                picker,
                "gpu-picker",
                call.arguments[0]!,
            );
            return {
                kind: "picking-info",
                cpp:
                    `bbl::gpu_pick(` +
                    `${context.requireEngine(picker, call)}, ` +
                    `${picker.cpp}, ` +
                    `${context.compileNumber(call.arguments[1]!, "double")}, ` +
                    `${context.compileNumber(call.arguments[2]!, "double")})`,
                ...(picker.engineCpp === undefined
                    ? {}
                    : { engineCpp: picker.engineCpp }),
            };
        }

        case "disposePicker": {
            context.expectArgumentCount(call, 1, 1);
            const picker = context.compileValue(
                call.arguments[0]!,
            );
            context.expectKind(
                picker,
                "gpu-picker",
                call.arguments[0]!,
            );
            return {
                kind: "void",
                cpp:
                    `bbl::dispose_picker(` +
                    `${context.requireEngine(picker, call)}, ` +
                    `${picker.cpp})`,
            };
        }

        case "enableDetailedPicking":
        case "getPickedNormal":
            context.fail(
                call,
                `'${importedName}' needs the pin's detailed-picking ` +
                    "pipeline: a third rgba32uint attachment, the " +
                    "primitive and barycentric readback, and the CPU " +
                    "position and normal arrays it interpolates. No " +
                    "reached scene composes it.",
            );

        default:
            return undefined;
    }
}
