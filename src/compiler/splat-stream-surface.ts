/**
 * The members of a streamed Gaussian-splat cloud the application reads and
 * writes: the lowered `GaussianSplatStream` record and its stats
 * (`bblite/upstream_splat_stream.hpp`). `stats`' members are the pin's own
 * getters over the stream's mutable snapshot; `rotation` is the stream
 * node's Euler proxy (scene-node.ts `createEulerProxy`), whose writes
 * update the quaternion the world matrix composes.
 */
import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { DataType } from "./data-types.js";
import type { Value } from "./types.js";
import { isPinnedType } from "./data-types.js";

export interface SplatStreamSurfaceContext extends Pick<
    LoweringServices,
    | "checker"
    | "compileValue"
    | "compileNumber"
    | "dataLowerer"
    | "bindings"
    | "emit"
    | "fail"
> {}

const number: DataType = { kind: "number" };

/** The stats getters by pinned name and the value each reads as. */
const STATS: ReadonlyMap<string, readonly [string, DataType]> = new Map([
    ["phase", ["phase", { kind: "string" }]],
    ["visibleLeaves", ["visible_leaves", number]],
    ["coveredLeaves", ["covered_leaves", number]],
    ["targetLeaves", ["target_leaves", number]],
    ["selectedSplats", ["selected_splats", number]],
    ["residentFiles", ["resident_files", number]],
    ["queuedFiles", ["queued_files", number]],
    ["pendingRequests", ["pending_requests", number]],
    ["residentGpuBytes", ["resident_gpu_bytes", number]],
    ["allocatedGpuBytes", ["allocated_gpu_bytes", number]],
    ["fetchedBytes", ["fetched_bytes", number]],
    ["firstFrameMs", ["first_frame_ms", { kind: "optional", inner: number }]],
    ["error", ["error", { kind: "optional", inner: { kind: "error" } }]],
]);

/** `stream.<member>` and `stream.stats.<member>`. */
export function readSplatStreamProperty(
    context: SplatStreamSurfaceContext,
    owner: Value,
    name: string,
    site: ts.Node,
): Value | undefined {
    if (owner.kind === "gaussian-splat-stream") {
        switch (name) {
            case "maxSplats":
                return { kind: "number", cpp: `(${owner.cpp})->max_splats` };
            case "screenError":
                return { kind: "number", cpp: `(${owner.cpp})->screen_error` };
            case "stats":
                return {
                    kind: "splat-stream-stats",
                    cpp: `(${owner.cpp})->stats`,
                    dataType: { kind: "handle", handle: "splat-stream-stats" },
                };
            case "firstFrameReady":
                return {
                    kind: "promise",
                    cpp: `(${owner.cpp})->first_frame_ready`,
                    promiseType: "bbl::js::PromiseVoid",
                    promiseResult: { kind: "void", cpp: "" },
                };
            default:
                return context.fail(
                    site,
                    `GaussianSplatStream.${name} is not a public stream member read natively.`,
                );
        }
    }
    if (owner.kind === "splat-stream-stats") {
        const member = STATS.get(name);
        if (!member)
            return context.fail(
                site,
                `GaussianSplatStreamStats.${name} is not a public stats member.`,
            );
        const [field, dataType] = member;
        const read = `(${owner.cpp})->get_${field}()`;
        return context.dataLowerer.leafValue(
            name === "error" ? `bbl::splat_stream::stats_error(${read})` : read,
            dataType,
        );
    }
    return undefined;
}

const EULER_AXES = ["x", "y", "z"];

/**
 * `stream.screenError = v`, `stream.maxSplats = v` and `stream.rotation.<axis>
 * = v`: plain writes of the record's fields, and the Euler proxy's setter.
 */
export function emitSplatStreamAssignment(
    context: SplatStreamSurfaceContext,
    expression: ts.BinaryExpression,
): boolean {
    const left = expression.left;
    if (!ts.isPropertyAccessExpression(left)) return false;
    const streamOwner = (node: ts.Expression): boolean =>
        isPinnedType(context.checker.getTypeAtLocation(node), [
            "GaussianSplatStream",
        ]);
    const rotation =
        ts.isPropertyAccessExpression(left.expression) &&
        left.expression.name.text === "rotation" &&
        streamOwner(left.expression.expression);
    if (!rotation && !streamOwner(left.expression)) return false;
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
        context.fail(
            expression.operatorToken,
            "A stream member takes a simple assignment natively.",
        );
    if (rotation) {
        const axis = EULER_AXES.indexOf(left.name.text);
        if (axis < 0)
            context.fail(
                left.name,
                `GaussianSplatStream.rotation has no axis '${left.name.text}'.`,
            );
        const stream = context.bindings.pinValueToTemporary(
            context.compileValue(left.expression.expression),
            "stream",
            left.expression,
        );
        context.emit({
            kind: "expression",
            code: `bbl::splat_stream::node_euler_write(*${stream.cpp}, ${axis}, ${context.compileNumber(expression.right, "double")});`,
        });
        return true;
    }
    const field =
        left.name.text === "screenError"
            ? "screen_error"
            : left.name.text === "maxSplats"
              ? "max_splats"
              : context.fail(
                    left.name,
                    `GaussianSplatStream.${left.name.text} is not a writable stream member.`,
                );
    const stream = context.bindings.pinValueToTemporary(
        context.compileValue(left.expression),
        "stream",
        left.expression,
    );
    context.emit({
        kind: "expression",
        code: `(${stream.cpp})->${field} = ${context.compileNumber(expression.right, "double")};`,
    });
    return true;
}
