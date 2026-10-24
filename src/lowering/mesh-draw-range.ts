import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { absentBinding, type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { type WriteSite } from "../compiler/syntax.js";

const checked = new WeakSet<LoweringContext>();

/**
 * Exact active draw ranges (`MeshGPU._firstIndex` and `_drawRangeSource`)
 * exist only after `setMeshDrawRange`, which no program reaches (the
 * compiler admits no call to it). Asserted once per context over every
 * pinned writer and installer in `src/`:
 *
 * - mesh-factories selects both in `setMeshDrawRange` and clears them to
 *   `undefined` in `retainMeshGeometry`;
 * - `setMeshDrawRangeSource` installs the source, called only by
 *   `setMeshDrawRange` and by device recovery;
 * - recovery copies the first index from the retired GPU record, under that
 *   record's own draw-range source;
 * - GPU culling copies a mesh's first index into its own state.
 */
export function assertDrawRangesUnreached(context: LoweringContext): void {
    if (checked.has(context)) return;
    const site = (node: ts.Node) =>
        `${node.getSourceFile().fileName}#${ts.findAncestor(node, ts.isFunctionDeclaration)?.name?.text}`;
    const factories = "src/mesh/mesh-factories.ts";
    // A write that computes its value (`++`, `+=`, a pattern leaf) stores
    // nothing these shapes name, so it is an unexpected writer.
    const stores = (write: WriteSite, shape: string): boolean =>
        write.stored !== undefined &&
        context.expressionMatchesShape(write.stored, shape);
    const clears = (write: WriteSite) =>
        site(write.node) === `${factories}#retainMeshGeometry` &&
        (stores(write, "undefined") ||
            stores(write, "gpu._baseVertex = undefined"));
    for (const write of context.writersOf("_firstIndex"))
        if (
            !clears(write) &&
            site(write.node) !== `${factories}#setMeshDrawRange` &&
            !(
                site(write.node) ===
                    "src/engine/recovery-rebuild.ts#uploadRetainedMesh" &&
                stores(write, "old._firstIndex")
            ) &&
            !stores(write, "gpu._firstIndex ?? 0")
        )
            context.contractError(
                write.node,
                "Expected only setMeshDrawRange to select a mesh's first index.",
            );
    for (const write of context.writersOf("_drawRangeSource"))
        if (
            !clears(write) &&
            site(write.node) !==
                "src/mesh/mesh-draw-range-state.ts#setMeshDrawRangeSource"
        )
            context.contractError(
                write.node,
                "Expected setMeshDrawRangeSource alone to install a draw-range source.",
            );
    // A caller names the installer, so only modules spelling it are parsed.
    const installs = context.store
        .listSources()
        .filter(
            (module) =>
                module.startsWith("src/") &&
                context.store
                    .getSource(module)
                    .includes("setMeshDrawRangeSource("),
        )
        .flatMap((module) =>
            context.findNodes(
                context.sourceFile(module),
                (node): node is ts.CallExpression =>
                    ts.isCallExpression(node) &&
                    context.expressionMatchesShape(
                        node.expression,
                        "setMeshDrawRangeSource",
                    ),
            ),
        );
    if (
        installs.map(site).sort().join(",") !==
        `src/engine/recovery-rebuild.ts#uploadRetainedMesh,${factories}#setMeshDrawRange`
    )
        context.contractError(
            context.sourceFile(factories),
            "Expected setMeshDrawRange and recovery alone to install draw-range sources.",
        );
    checked.add(context);
}

/** A draw-range field a lowered body reads: always absent (`assertDrawRangesUnreached`). */
export function absentDrawRangeBinding(
    context: LoweringContext,
): PinnedBinding {
    assertDrawRangesUnreached(context);
    return absentBinding("undefined");
}
