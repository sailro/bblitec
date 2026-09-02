import ts from "typescript";
import type { Value } from "../types.js";
import type { Feature } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";

/** What the handle's own methods need. The expression compiler satisfies it. */
export interface VatMethodContext {
    emit(line: string): void;
    increaseIndent(): void;
    decreaseIndent(): void;
    cppString(value: string): string;
    compileValue(expression: ts.Expression): Value;
    compileStringLiteral(expression: ts.Expression): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    requireEngine(value: Value, node: ts.Node): string;
    reachFeature(feature: Feature, site: ts.Node): void;
    unwrap(expression: ts.Expression): ts.Expression;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void;
    fail(node: ts.Node, message: string): never;
}

export interface VatIntrinsicContext
    extends IntrinsicCallContext,
        VatMethodContext {
    allocateTemporaryCppName(label: string): string;
    expectSameEngine(left: Value, right: Value, node: ts.Node): void;
}

/**
 * Vertex animation textures (`src/vat/vat-baker.ts`), the slice scenes 218
 * and 219 reach.
 *
 * Upstream the whole subsystem is a dynamic-import chunk a scene only pulls
 * in by calling `bakeVat`, and the VAT shader extension self-registers from
 * `attachVat` -- so a scene that never bakes one carries none of it. This
 * port reaches it at the same two calls: `mesh:vat` is what puts the bake,
 * the settings block and the per-mesh VAT texture into the build (the
 * per-instance params texture is `mesh:vat-instances`, a separate gate), and
 * a scene without it emits none of them.
 *
 * The bake itself is not re-derived here. Natively it is the ported
 * `go_to_frame` per frame with `MeshRecord::bone_matrices` copied into the
 * row -- the same palette the live skeleton path uploads, which is why
 * `VAT(frame N)` reproduces the live pose exactly.
 */
export function compileVatIntrinsic(
    context: VatIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "bakeVat": {
            // `bakeVat(engine, mesh, groups)`. The optional capture bag is
            // not reached by either scene, and capturing a bone origin or
            // matrix would have to survive into a native record nothing
            // reads, so a fourth argument refuses rather than being
            // silently dropped.
            context.expectArgumentCount(call, 3, 3);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const mesh = context.compileValue(call.arguments[1]!);
            context.expectKind(mesh, "mesh", call.arguments[1]!);
            context.expectSameEngine(engine, mesh, call);
            const groups = context.compileValue(call.arguments[2]!);
            if (
                groups.kind !== "handle-collection" ||
                !groups.handleCollection ||
                groups.handleCollection.elementKind !== "animation-group"
            ) {
                context.fail(
                    call.arguments[2]!,
                    "bakeVat takes the container's own animation-group collection; the bake reads each clip's posed palette frame by frame.",
                );
            }
            context.reachFeature("mesh:vat", call);
            // The baker's own imports: upstream `vat-baker.ts` pulls
            // `stopAnimation` from `animation/animation-group.ts` and
            // carries a CPU-only copy of its `goToFrame`. The bake is
            // exactly those two operations per frame, so reaching the
            // baker reaches the group module -- a scene need not have
            // driven a clip itself.
            context.reachFeature("animation:gltf-groups", call);
            const baked = context.allocateTemporaryCppName("vat_bake");
            context.emit(
                `const bbl::VatBake ${baked} = bbl::bake_vat(` +
                    `${engine.cpp}, ${mesh.cpp}, ` +
                    `${groups.handleCollection.containerCpp});`,
            );
            return {
                kind: "vat-bake",
                cpp: baked,
                engineCpp: engine.cpp,
            };
        }

        case "attachVat": {
            // `attachVat(engine, mesh, baked, clip?)`: sets `mesh.vat`,
            // builds the 32-byte settings block and DROPS the live
            // skeleton, so from here the mesh deforms from the baked
            // texture alone.
            context.expectArgumentCount(call, 3, 4);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const mesh = context.compileValue(call.arguments[1]!);
            context.expectKind(mesh, "mesh", call.arguments[1]!);
            context.expectSameEngine(engine, mesh, call);
            const baked = context.compileValue(call.arguments[2]!);
            context.expectKind(baked, "vat-bake", call.arguments[2]!);
            const clip = call.arguments[3]
                ? context.cppString(
                      context.compileStringLiteral(call.arguments[3]),
                  )
                : "std::string{}";
            context.reachFeature("mesh:vat", call);
            const handle = context.allocateTemporaryCppName("vat_handle");
            context.emit(
                `const bbl::VatHandle ${handle} = bbl::attach_vat(` +
                    `${engine.cpp}, ${mesh.cpp}, ${baked.cpp}, ${clip});`,
            );
            return {
                kind: "vat-handle",
                cpp: handle,
                engineCpp: engine.cpp,
            };
        }

        default:
            return undefined;
    }
}

/**
 * `handle.play(...)`, `handle.update(dt)` and `handle.setInstances(...)`.
 *
 * `VatHandle` is the second pinned surface where a resource carries methods
 * (the Web Audio family is the first), because upstream returns a closure
 * bundle rather than free functions. Natively the handle names the mesh
 * whose VAT record each method writes, so the three methods lower to three
 * writers over that record.
 *
 * Both scenes hold the handle in a nullable local -- it is only attached
 * when the file carried a skinned mesh and clips -- and read it through
 * `?.`, so an optional receiver emits its guard here rather than
 * dereferencing an empty optional.
 */
export function compileVatMethodCall(
    context: VatMethodContext,
    call: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
): Value | undefined {
    const receiverExpression = context.unwrap(callee.expression);
    if (!ts.isIdentifier(receiverExpression)) return undefined;
    const receiver = context.lookupOptional(receiverExpression);
    if (!receiver || receiver.kind !== "vat-handle") return undefined;
    const method = callee.name.text;
    if (!["play", "update", "setInstances"].includes(method)) {
        context.fail(
            callee.name,
            `A VatHandle carries play, update and setInstances; '${method}' is not lowered.`,
        );
    }
    const engine = context.requireEngine(receiver, call);
    // `a?.f(x)` never evaluates `x` when `a` is null, so the arguments are
    // compiled inside the guard rather than before it.
    const guarded = receiver.optionalFoundCpp !== undefined;
    if (guarded) {
        context.emit(`if (${receiver.optionalFoundCpp!}) {`);
        context.increaseIndent();
    }
    try {
        if (method === "play") {
            context.expectArgumentCount(call, 1, 2);
            const clip = context.cppString(
                context.compileStringLiteral(call.arguments[0]!),
            );
            const options = call.arguments[1]
                ? vatPlayOptions(context, call.arguments[1])
                : { offset: undefined, fps: undefined };
            context.emit(
                `bbl::vat_play(${engine}, ${receiver.cpp}, ${clip}, ` +
                    `${optionalDouble(options.offset)}, ` +
                    `${optionalDouble(options.fps)});`,
            );
        } else if (method === "update") {
            context.expectArgumentCount(call, 1, 1);
            const delta = context.compileNumber(
                call.arguments[0]!,
                "double",
            );
            context.emit(
                `bbl::vat_update(${engine}, ${receiver.cpp}, ${delta});`,
            );
        } else {
            context.expectArgumentCount(call, 1, 1);
            const params = context.compileValue(call.arguments[0]!);
            if (
                params.kind !== "data" ||
                params.dataType?.kind !== "f32array"
            ) {
                context.fail(
                    call.arguments[0]!,
                    "VatHandle.setInstances takes the per-instance Float32Array the pin uploads to the params texture.",
                );
            }
            context.reachFeature("mesh:vat-instances", call);
            context.emit(
                `bbl::vat_set_instances(${engine}, ${receiver.cpp}, ` +
                    `${params.cpp});`,
            );
        }
    } finally {
        if (guarded) {
            context.decreaseIndent();
            context.emit("}");
        }
    }
    return { kind: "void", cpp: "" };
}

function optionalDouble(value: string | undefined): string {
    return value === undefined
        ? "std::optional<double>{}"
        : `std::optional<double>{${value}}`;
}

/**
 * `play`'s `{ offset?, fps? }` bag, read from the literal the call site
 * writes. Upstream defaults `offset` to 0 and `fps` to the clip's own rate,
 * and both defaults live natively where the clip row does -- so an omitted
 * field travels as an empty optional rather than as a number this side
 * would have to invent.
 */
function vatPlayOptions(
    context: VatMethodContext,
    expression: ts.Expression,
): { offset: string | undefined; fps: string | undefined } {
    const literal = context.unwrap(expression);
    if (!ts.isObjectLiteralExpression(literal)) {
        context.fail(
            expression,
            "VatHandle.play takes its playback options as an object literal.",
        );
    }
    let offset: string | undefined;
    let fps: string | undefined;
    for (const property of literal.properties) {
        if (
            !ts.isPropertyAssignment(property) ||
            !ts.isIdentifier(property.name)
        ) {
            context.fail(
                property,
                "VatHandle.play options take named offset and fps assignments.",
            );
        }
        const value = context.compileNumber(
            property.initializer,
            "double",
        );
        if (property.name.text === "offset") {
            offset = value;
        } else if (property.name.text === "fps") {
            fps = value;
        } else {
            context.fail(
                property.name,
                `VatHandle.play carries offset and fps; '${property.name.text}' is not lowered.`,
            );
        }
    }
    return { offset, fps };
}
