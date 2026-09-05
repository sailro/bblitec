/**
 * `src/math/normalize-vec3.ts`, translated whole from its own declaration.
 *
 * The pin's tuple normalization is six lines and three of them are a
 * division, which is exactly the shape a port retypes and then forgets: the
 * `Math.hypot` length, the `<= epsilon` degenerate test, and the `[0, 1, 0]`
 * the degenerate arm answers with. All three come out of the pinned AST
 * here, including the `1e-10` default the pin's own three-argument callers
 * rely on -- `detailed-picking.ts` and `picking-helpers.ts` both spell
 * `normalizeVec3(x, y, z)` and take it.
 *
 * The length goes through `bbl::js::hypot_js` rather than `std::hypot`, the
 * one spelling `fidelity.md` records for `Math.hypot`, so the scene-facing
 * call and the pinned bodies that reach this function agree.
 *
 * `normalize-vec3-object.ts` is the pin's SECOND declaration of the same
 * arithmetic over its `{x, y, z}` record, and the gizmo family lowers that
 * one beside the quaternion helpers that consume it. Two pinned modules,
 * two translations: neither is this port's copy of the other.
 */
import type { LoweringContext } from "./context.js";
import {
    lowerPinnedFunction,
    lowerObjectComponents,
    lowerTupleComponents,
} from "./pinned-function-lowerer.js";
import { pinnedNumericMathCallsWithHypot } from "./pinned-operators.js";

const normalizeModule = "src/math/normalize-vec3.ts";
const normalizeObjectModule =
    "src/math/normalize-vec3-object.ts";
const lengthModule = "src/math/length-vec3.ts";

/** How a pinned body reaching `normalizeVec3` spells the call. */
export function normalizeVec3Call(args: readonly string[]): string {
    return `upstream::normalize_vec3(${args.join(", ")})`;
}

/** The header carrying the pinned tuple normalization, whole. */
export function pinnedNormalizeVec3Header(context: LoweringContext): string {
    const mathCalls = pinnedNumericMathCallsWithHypot();
    const normalize = lowerPinnedFunction(
        context,
        normalizeModule,
        "normalizeVec3",
        [
            { pinned: "x", kind: "number", cpp: "x" },
            { pinned: "y", kind: "number", cpp: "y" },
            { pinned: "z", kind: "number", cpp: "z" },
            {
                pinned: "epsilon",
                kind: "number",
                cpp: "epsilon",
                pinnedDefault: true,
            },
        ],
        {
            cppName: "normalize_vec3",
            inline: true,
            calls: mathCalls,
            returns: {
                // `std::array<double, 3>`, not `js::Tuple<3>`: the pinned
                // bodies that call this bind its result as a fixed tuple
                // and index it, and a scene-facing call wraps it in the
                // JavaScript array identity at the call site instead --
                // which is where that identity actually matters.
                type: "std::array<double, 3>",
                value: (lowerer, expression) =>
                    `std::array<double, 3>{${lowerTupleComponents(
                        context,
                        lowerer,
                        expression,
                        {
                            arity: 3,
                            at: context.functionDeclaration(
                                normalizeModule,
                                "normalizeVec3",
                            ).declaration,
                        },
                    ).join(", ")}}`,
            },
        },
    );
    const length = lowerPinnedFunction(
        context,
        lengthModule,
        "lengthVec3",
        [
            {
                pinned: "v",
                kind: "record",
                cpp: "v",
                cppType: "bbl::Vec3d",
                annotation: "Vec3",
            },
        ],
        {
            cppName: "length_vec3",
            inline: true,
            calls: mathCalls,
            memberBindings: new Map([
                ["v.x", { cpp: "v.x", type: "scalar" as const }],
                ["v.y", { cpp: "v.y", type: "scalar" as const }],
                ["v.z", { cpp: "v.z", type: "scalar" as const }],
            ]),
            returns: "double",
        },
    );
    const normalizeObject = lowerPinnedFunction(
        context,
        normalizeObjectModule,
        "normalizeVec3",
        [
            {
                pinned: "v",
                kind: "record",
                cpp: "v",
                cppType: "bbl::Vec3d",
                annotation: "Vec3",
            },
        ],
        {
            cppName: "normalize_vec3_object",
            inline: true,
            calls: new Map([
                ...mathCalls,
                [
                    "lengthVec3",
                    (args: readonly string[]): string =>
                        `length_vec3(${args.join(", ")})`,
                ],
            ]),
            memberBindings: new Map([
                ["v.x", { cpp: "v.x", type: "scalar" as const }],
                ["v.y", { cpp: "v.y", type: "scalar" as const }],
                ["v.z", { cpp: "v.z", type: "scalar" as const }],
            ]),
            returns: {
                type: "bbl::Vec3d",
                value: (lowerer, expression) =>
                    `bbl::Vec3d{${lowerObjectComponents(
                        context,
                        lowerer,
                        expression ??
                            context.contractError(
                                context.functionDeclaration(
                                    normalizeObjectModule,
                                    "normalizeVec3",
                                ).declaration,
                                "Expected pinned normalizeVec3 object to return a value.",
                            ),
                        ["x", "y", "z"],
                    ).join(", ")}}`,
            },
        },
    );
    return `#pragma once

#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>

#include <array>
#include <cmath>

namespace bbl::upstream {

${normalize}

${length}

${normalizeObject}

} // namespace bbl::upstream
`;
}
