/**
 * Lowers the pin's own inverse image processing to C++, whole.
 *
 * The composed stages state the forward image processing as WGSL — exposure,
 * the exponential tone map `c = 1.0 - exp2(-scale * c)`, gamma, contrast —
 * and the pin inverts the whole chain once on the CPU, in
 * `src/frame-graph/transmission.ts` `inverseImageProcessedChannel` (clamp,
 * the 16-step contrast bisection, the 2.2 gamma, the tone map, exposure), to
 * derive the linear-frame clear color a transmission frame clears to. The
 * PAL used to carry a float-width transcription of that body consuming only
 * a lifted tone-mapping scale; the body is translated here from the pinned
 * declaration's own AST by `PinnedNumericLowerer` instead, so every
 * intermediate keeps the f64 width the pin computes at and an edited
 * bisection or a retuned curve regenerates rather than drifting past a
 * comment.
 *
 * The tone-mapping division's literal is still cross-checked against the
 * forward curve's WGSL scale, so the CPU inverse and the GPU forward pass
 * cannot disagree silently.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    type PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

const transmissionModule = "src/frame-graph/transmission.ts";
const imageProcessingModule = "src/frame-graph/image-processing-task.ts";

/**
 * The scale of the pin's exponential tone map, from the pinned inverse's own
 * division. The tone-mapping arm is the one statement in
 * `inverseImageProcessedChannel` that divides by a numeric literal, and its
 * left side is asserted so the value read is the curve's scale and not some
 * future unrelated literal.
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

/**
 * One pinned function of JavaScript numbers, translated statement by
 * statement. The parameter names and type annotations are asserted against
 * the pinned declaration, so a reshaped signature fails generation instead
 * of binding a parameter to the wrong C++ spelling.
 */
function lowerNumericFunction(
    context: LoweringContext,
    module: string,
    pinnedName: string,
    parameters: readonly {
        pinned: string;
        annotation: "number" | "boolean";
        cpp: string;
    }[],
    cppName: string,
): string {
    const { file, declaration } = context.functionDeclaration(
        module,
        pinnedName,
    );
    if (declaration.parameters.length !== parameters.length) {
        context.contractError(
            declaration,
            `Expected pinned ${pinnedName} to take ` +
                `${parameters.length} parameter(s).`,
        );
    }
    const bindings = new Map<string, PinnedBinding>();
    const signature: string[] = [];
    declaration.parameters.forEach((parameter, index) => {
        const spec = parameters[index]!;
        if (
            !ts.isIdentifier(parameter.name) ||
            parameter.name.text !== spec.pinned ||
            parameter.type?.getText(file) !== spec.annotation
        ) {
            context.contractError(
                parameter,
                `Expected pinned ${pinnedName} parameter ${index} to be ` +
                    `'${spec.pinned}: ${spec.annotation}'.`,
            );
        }
        bindings.set(spec.pinned, {
            cpp: spec.cpp,
            type: spec.annotation === "boolean" ? "bool" : "scalar",
        });
        signature.push(
            `${spec.annotation === "boolean" ? "bool" : "double"} ${spec.cpp}`,
        );
    });
    const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls: new Map([
            ...pinnedNumericMathCalls(),
            ["clamp01", (args) => `clamp01(${args.join(", ")})`],
        ]),
        returnValue: (expression) => {
            if (!expression) {
                return context.contractError(
                    declaration,
                    `Expected pinned ${pinnedName} to return a value.`,
                );
            }
            return lowerer.expression(expression);
        },
    });
    const body = declaration.body!.statements
        .flatMap((statement) => lowerer.statement(statement, "    "))
        .join("\n");
    return (
        `// ${context.provenance(module, pinnedName)}\n` +
        `inline double ${cppName}(\n    ${signature.join(",\n    ")}) {\n` +
        `${body}\n}`
    );
}

/** The always-emitted header carrying the pinned inverse, whole. */
export function pinnedInverseImageProcessingHeader(
    context: LoweringContext,
): string {
    const scale = pinnedToneMappingScale(context);
    if (Math.fround(scale) !== scale) {
        throw new Error(
            `Pinned inverse tone-mapping scale ${scale} is not an f32 ` +
                "value; the forward curve is stated in f32 WGSL.",
        );
    }
    assertForwardCurveScale(context, scale);
    const clamp = lowerNumericFunction(
        context,
        transmissionModule,
        "clamp01",
        [{ pinned: "v", annotation: "number", cpp: "v" }],
        "clamp01",
    );
    const inverse = lowerNumericFunction(
        context,
        transmissionModule,
        "inverseImageProcessedChannel",
        [
            { pinned: "value", annotation: "number", cpp: "value" },
            { pinned: "exposure", annotation: "number", cpp: "exposure" },
            { pinned: "contrast", annotation: "number", cpp: "contrast" },
            { pinned: "toneMapping", annotation: "boolean", cpp: "tone_mapping" },
        ],
        "inverse_image_processed_channel",
    );
    return `#pragma once

// ${context.provenance(transmissionModule, "inverseImageProcessedChannel")}

#include <algorithm>
#include <cmath>

namespace bbl::upstream {

${clamp}

/**
 * The pin's own inverse of the frame's image processing — clamp, the
 * 16-step contrast bisection, the 2.2 gamma, the exponential tone map,
 * exposure — translated whole from the pinned declaration. The linear-frame
 * clear color is this function over each channel of the scene clear color;
 * every intermediate keeps the f64 width the pin computes at, and the
 * tone-mapping division is cross-checked at generation against the forward
 * curve the composed stages state in WGSL.
 */
${inverse}

} // namespace bbl::upstream
`;
}
