/**
 * `quatFromLookDirectionRH`, translated whole from its pinned declaration.
 *
 * The public helper normalizes two record vectors and delegates the final
 * basis conversion to the same pinned quaternion fold used by matrix
 * decomposition. Keeping both functions in this generated header preserves
 * the pin's value-selecting `Math.hypot(...) || 1` and removes the native
 * runtime's second handwritten copy of the rotation-basis branches.
 */
import type { LoweringContext } from "./context.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import { lowerQuatFromRotationBasis } from "./pinned-mat4-decompose.js";
import { pinnedNumericMathCallsWithHypot } from "./pinned-operators.js";

const LOOK_DIRECTION_MODULE =
    "src/math/quat-from-look-direction-rh.ts";

/** The header carrying the pin's right-handed look-direction quaternion. */
export function pinnedLookDirectionHeader(context: LoweringContext): string {
    const mathCalls = pinnedNumericMathCallsWithHypot();
    const basis = lowerQuatFromRotationBasis(
        context,
        mathCalls,
        "quat_from_rotation_basis",
        "std::array<double, 4>",
        true,
    );
    const lookDirection = lowerPinnedFunction(
        context,
        LOOK_DIRECTION_MODULE,
        "quatFromLookDirectionRH",
        [
            {
                pinned: "forward",
                kind: "record",
                cpp: "forward",
                cppType: "bbl::Vec3d",
                annotation: "Vec3",
            },
            {
                pinned: "up",
                kind: "record",
                cpp: "up",
                cppType: "bbl::Vec3d",
                annotation: "Vec3",
            },
        ],
        {
            cppName: "quat_from_look_direction_rh",
            inline: true,
            calls: new Map([
                ...mathCalls,
                [
                    "_quatFromRotationBasis",
                    (args: readonly string[]): string =>
                        `quat_from_rotation_basis(${args.join(", ")})`,
                ],
            ]),
            memberBindings: new Map(
                ["forward", "up"].flatMap((record) =>
                    ["x", "y", "z"].map(
                        (component): [
                            string,
                            { cpp: string; type: "scalar" },
                        ] => [
                            `${record}.${component}`,
                            {
                                cpp: `${record}.${component}`,
                                type: "scalar",
                            },
                        ],
                    ),
                ),
            ),
            returns: {
                type: "std::array<double, 4>",
                value: (lowerer, expression) =>
                    expression
                        ? lowerer.expression(expression)
                        : context.contractError(
                              context.functionDeclaration(
                                  LOOK_DIRECTION_MODULE,
                                  "quatFromLookDirectionRH",
                              ).declaration,
                              "Expected pinned quatFromLookDirectionRH to return a value.",
                          ),
            },
        },
    );

    return `#pragma once

#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>

#include <array>
#include <cmath>

namespace bbl::upstream {

${basis}

${lookDirection}

} // namespace bbl::upstream
`;
}
