/**
 * Lowers the pin's exponential tone-mapping constant into a header every
 * scene emits.
 *
 * The composed stages state the forward curve as WGSL text —
 * `c = 1.0 - exp2(-1.590579 * c)` — and the pin inverts it once on the CPU,
 * in `src/frame-graph/transmission.ts` `inverseImageProcessedChannel`
 * (`c = -Math.log2(Math.max(1 - c, 1e-6)) / 1.5905790328979492`), which is
 * the function the PAL's `inverse_image_processed_channel` transcribes for
 * the linear-frame clear color. The constant used to be hand-typed there;
 * it is read here from the pin's own inverse and cross-checked against the
 * forward curve's literal, so a retuned curve regenerates instead of
 * drifting past a comment.
 */
import ts from "typescript";
import { floatLiteral } from "../cpp-literals.js";
import type { LoweringContext } from "./context.js";

const transmissionModule = "src/frame-graph/transmission.ts";
const imageProcessingModule = "src/frame-graph/image-processing-task.ts";

/**
 * The constant, from the pinned inverse's own division. The tone-mapping
 * arm is the one statement in `inverseImageProcessedChannel` that divides
 * by a numeric literal, and its left side is asserted so the value read is
 * the curve's scale and not some future unrelated literal.
 */
function pinnedToneMappingScale(context: LoweringContext): number {
    const { file, declaration } = context.functionDeclaration(
        transmissionModule,
        "inverseImageProcessedChannel",
    );
    const divisions = context.findNodes(
        declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.SlashToken &&
            ts.isNumericLiteral(context.unwrapExpression(node.right)),
    );
    if (divisions.length !== 1) {
        context.contractError(
            declaration,
            "Expected exactly one literal division in the pinned inverse " +
                `tone map, found ${divisions.length}.`,
        );
    }
    const division = divisions[0]!;
    context.assertExpressionShape(
        division.left,
        "-Math.log2(Math.max(1 - c, 1e-6))",
        "Inverse tone-mapping arm",
    );
    return context.numericValue(division.right, file);
}

/**
 * Every forward statement of the curve in the frame's image-processing
 * stage must carry the same scale the inverse divides by: the WGSL literal
 * is f32, so the comparison rounds it to that width first.
 */
function assertForwardCurveScale(
    context: LoweringContext,
    scale: number,
): void {
    const source = context.store.getSource(imageProcessingModule);
    const matches = [...source.matchAll(/exp2\(\s*-\s*([0-9.]+)\s*\*/g)];
    if (matches.length === 0) {
        throw new Error(
            "Pinned image processing no longer states the exponential " +
                "tone map as exp2(-scale * c).",
        );
    }
    for (const match of matches) {
        if (Math.fround(Number(match[1])) !== scale) {
            throw new Error(
                `Pinned forward tone map uses scale ${match[1]}, which is ` +
                    `not the inverse's ${scale}.`,
            );
        }
    }
}

/** The always-emitted header carrying the pinned tone-mapping constant. */
export function pinnedToneMappingHeader(context: LoweringContext): string {
    const scale = pinnedToneMappingScale(context);
    if (Math.fround(scale) !== scale) {
        throw new Error(
            `Pinned inverse tone-mapping scale ${scale} is not an f32 ` +
                "value; the forward curve is stated in f32 WGSL.",
        );
    }
    assertForwardCurveScale(context, scale);
    const provenance = context.provenance(
        transmissionModule,
        "inverseImageProcessedChannel",
    );
    return `#pragma once

// ${provenance}

namespace bbl::upstream {

/**
 * The scale of the pin's exponential tone map, \`1 - exp2(-scale * c)\`:
 * the f32 the composed stages apply forward and the one constant the CPU
 * inverse (\`inverseImageProcessedChannel\`, and the PAL transcription that
 * derives the linear-frame clear color from it) divides by.
 */
inline constexpr float pinned_tone_mapping_scale = ${floatLiteral(scale)};

} // namespace bbl::upstream
`;
}
