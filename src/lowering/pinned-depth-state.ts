/**
 * Lowers the pin's own depth convention into a header both backends execute.
 *
 * `src/engine/render-target.ts` names one compare — `REVERSE_DEPTH_COMPARE` —
 * and every pinned family defaults to it, so the value belongs to the pin and
 * not to this port. Typing it into the PALs would agree with the pin only
 * until the next bump; reading it here means a pin that changes it changes
 * what we emit, and a spelling this runtime has no enumerator for fails
 * generation rather than silently picking a neighbour.
 *
 * That is the same contract `pinned-blend-table.ts` holds for the pin's blend
 * factors. The projection half of the same convention is anchored here too:
 * the depth rows of every pinned projection writer this port translates map
 * near -> 1 and far -> 0, checked beside the clear value they pair with.
 */
import ts from "typescript";
import { floatLiteral } from "../cpp-literals.js";
import type { LoweringContext } from "./context.js";

/**
 * The `GPUCompareFunction` spellings this runtime has an enumerator for. The
 * pin can name any of them; the ones outside the reached slice cost nothing
 * to carry and mean a pin that starts using one still generates.
 */
const compareEnumerators: Readonly<Record<string, string>> = {
    never: "never",
    less: "less",
    equal: "equal",
    "less-equal": "less_equal",
    greater: "greater",
    "not-equal": "not_equal",
    "greater-equal": "greater_equal",
    always: "always",
};

/** A WebGPU compare function as this runtime's own enumerator. */
export function nativeDepthCompare(compare: string): string {
    const mapped = compareEnumerators[compare];
    if (!mapped) {
        throw new Error(
            `Pinned depth uses compare '${compare}', which this runtime ` +
                "has no enumerator for.",
        );
    }
    return mapped;
}

const renderTargetModule = "src/engine/render-target.ts";
const renderPassModule = "src/frame-graph/render-pass.ts";

/**
 * The pin's own depth-clear fallback, read from its declaration.
 *
 * `render-target.ts` declares `_depthClearValue` as an optional descriptor
 * field ("Defaults to reverse-Z far depth `0`") with no named constant, so
 * the readable authority is where the pin applies the default:
 * `render-pass.ts` builds every depth attachment with
 * `_depthClearValue ?? 0`. Every such fallback in the module must agree —
 * a second site with another value would mean the convention forked.
 */
function pinnedDepthClearValue(context: LoweringContext): number {
    const file = context.sourceFile(renderPassModule);
    const fallbacks = context
        .findNodes(
            file,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken &&
                (ts.isPropertyAccessExpression(node.left) ||
                    ts.isPropertyAccessChain(node.left)) &&
                node.left.name.text === "_depthClearValue",
        )
        .map((node) => context.numericValue(node.right, file));
    if (fallbacks.length === 0) {
        context.contractError(
            file,
            "Pinned render-pass no longer defaults _depthClearValue.",
        );
    }
    const value = fallbacks[0]!;
    if (fallbacks.some((candidate) => candidate !== value)) {
        context.contractError(
            file,
            "Pinned render-pass defaults _depthClearValue inconsistently: " +
                `${fallbacks.join(", ")}.`,
        );
    }
    return value;
}

/**
 * The projection half of the convention, anchored beside its clear value.
 *
 * The projection writers themselves are translated whole from their own
 * ASTs (`lowerPinnedFunction`), so their emissions cannot drift from the
 * pin. What this guards is the CONVENTION this header's consumers assume —
 * the dither seeds and near-plane handling are keyed to a far plane of 0 —
 * so a pin that remapped the depth range would lower faithfully while those
 * consumers went quietly stale. It fails generation by name instead, for
 * the perspective writer and the orthographic one alike.
 */
const projectionWriters: readonly {
    module: string;
    symbol: string;
    rows: readonly (readonly [number, string])[];
}[] = [
    {
        module: "src/math/mat4-perspective-lh-to-ref.ts",
        symbol: "mat4PerspectiveLHToRef",
        rows: [
            [10, "-near / range"],
            [14, "(far * near) / range"],
        ],
    },
    {
        module: "src/math/mat4-ortho-lh-to-ref.ts",
        symbol: "mat4OrthoOffCenterLHToRef",
        rows: [
            [10, "-1 / range"],
            [14, "far / range"],
        ],
    },
];

function assertReverseZProjectionRows(context: LoweringContext): void {
    for (const writer of projectionWriters) {
        const { file, declaration } = context.functionDeclaration(
            writer.module,
            writer.symbol,
        );
        context.assertExpressionShape(
            context.variableInitializer(declaration, "range"),
            "far - near",
            `Pinned ${writer.symbol} depth range`,
        );
        const rows = new Map(writer.rows);
        for (const store of context.pinnedElementStores(
            declaration,
            "out",
        )) {
            const index = context.numericValue(
                store.left.argumentExpression,
                file,
            );
            const shape = rows.get(index);
            if (shape === undefined) continue;
            context.assertExpressionShape(
                store.right,
                shape,
                `Pinned ${writer.symbol} reverse-Z row ${index}`,
            );
            rows.delete(index);
        }
        if (rows.size !== 0) {
            context.contractError(
                declaration,
                `Pinned ${writer.symbol} no longer stores the reverse-Z ` +
                    `depth rows (${[...rows.keys()].join(", ")}).`,
            );
        }
    }
}

/**
 * The pin's reverse-depth compare, read from its own declaration.
 *
 * Emitted for every scene: a sprite-only scene registers no SceneContext and
 * so has no render plan, but its billboard pass still draws under the same
 * convention.
 */
export function pinnedDepthStateHeader(context: LoweringContext): string {
    const file = context.sourceFile(renderTargetModule);
    const compare = context.stringValue(
        context.variableInitializer(file, "REVERSE_DEPTH_COMPARE"),
        file,
    );
    const provenance = context.provenance(
        renderTargetModule,
        "REVERSE_DEPTH_COMPARE",
    );
    // The pin's own clear value, read like the compare above. The reached
    // slice is reverse-Z — the projection writer, the dither arms and the
    // near-plane handling are all keyed to a far plane of 0 — so a pin
    // that moves it needs those consumers revisited, not a silently
    // different emitted constant.
    const depthClear = pinnedDepthClearValue(context);
    if (depthClear !== 0) {
        throw new Error(
            `Pinned _depthClearValue default is ${depthClear}; this port's ` +
                "reverse-Z consumers assume the far plane clears to 0.",
        );
    }
    assertReverseZProjectionRows(context);
    return `#pragma once

// ${provenance}

#include <bblite/runtime.hpp>

namespace bbl::upstream {

/**
 * The depth compare every pinned family defaults to.
 *
 * \`createDefaultPipelineDescriptor\` and each family's pipeline builder read
 * \`sig._depthCompare ?? REVERSE_DEPTH_COMPARE\`, so this is the compare a
 * draw carries unless its own signature names another. The pin's shadow
 * targets do name another (\`less-equal\`, standard-Z), which is why this is
 * the reached slice's convention rather than the library's only one.
 *
 * The matching projections map near to 1 and far to 0: the render plan's
 * \`mat4_perspective_lh_to_ref\` and \`mat4_ortho_off_center_lh_to_ref\` are
 * the pinned writers translated whole, and generation anchors both writers'
 * depth rows beside this header's clear value.
 */
inline constexpr DepthCompare pinned_depth_compare =
    DepthCompare::${nativeDepthCompare(compare)};

/** The far plane under that convention, which is what a pass clears to. */
inline constexpr float pinned_depth_clear = ${floatLiteral(depthClear)};

} // namespace bbl::upstream
`;
}
