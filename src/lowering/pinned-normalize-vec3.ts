import type { PinnedCallSpelling } from "./pinned-numeric-lowerer.js";
/** Pinned tuple and object normalization, including their distinct degenerate results. */
import type { LoweringContext } from "./context.js";
import {
    vec3MemberBindings,
    lowerPinnedFunction,
    lowerObjectComponents,
    lowerTupleComponents,
} from "./pinned-function-lowerer.js";

import { pinnedHeader } from "./pinned-header.js";

const normalizeModule = "src/math/normalize-vec3-tuple-or-up.ts";
const normalizeObjectModule = "src/math/normalize-vec3.ts";
const lengthModule = "src/math/length-vec3.ts";

/** How a pinned body reaching `normalizeVec3TupleOrUp` spells the call. */
export function normalizeVec3Call(args: readonly string[]): string {
    return `upstream::normalize_vec3(${args.join(", ")})`;
}

/** The header carrying the pinned tuple normalization, whole. */
export function pinnedNormalizeVec3Header(context: LoweringContext): string {
    const mathCalls = new Map<string, PinnedCallSpelling>();
    const normalize = lowerPinnedFunction(
        context,
        normalizeModule,
        "normalizeVec3TupleOrUp",
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
                                "normalizeVec3TupleOrUp",
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
            memberBindings: new Map([...vec3MemberBindings("v")]),
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
            memberBindings: new Map([...vec3MemberBindings("v")]),
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
    return pinnedHeader(
        [
            "<bblite/runtime.hpp>",
            "<bblite/js_data.hpp>",
            "",
            "<array>",
            "<cmath>",
        ],
        `
${normalize}

${length}

${normalizeObject}
`,
    );
}
