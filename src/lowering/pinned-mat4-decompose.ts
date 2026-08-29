/**
 * `mat4Decompose`'s rotation, folded from its own declaration, with the two
 * math helpers it calls folded beside it.
 *
 * None of this is splat behaviour: `src/math/mat4-decompose.ts` and its two
 * dependencies are general matrix maths, and a second consumer already
 * half-exists — `renderer-lowerer.ts` pins `mat4Determinant3`'s text as the
 * marker for the glTF mirrored-winding predicate. So it lives beside
 * `pinned-trs.ts` for the reason that file states: one home, so several
 * emissions cannot drift apart while all claim to be the pin's own.
 *
 * It is SPECIALIZED to the rotation, because that is the only member any
 * reached caller reads. What licenses dropping the translation and the
 * scale is an assertion on that caller's body rather than this file's
 * signature; the caller owns it, and `splat-lowerer.ts` is where it is.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    lowerObjectComponents,
    lowerPinnedFunction,
} from "./pinned-function-lowerer.js";
import type { PinnedNumericLowerer } from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

const DECOMPOSE_MODULE = "src/math/mat4-decompose.ts";
const DETERMINANT_MODULE = "src/math/mat4-determinant3.ts";
const QUAT_BASIS_MODULE = "src/math/quat-from-rotation-matrix.ts";

/** The pin's own `{x, y, z, w}`, as its math helpers return one. */
export const PINNED_QUAT_DECLARATION = `/** The pin's own \`{x, y, z, w}\`, as its math helpers return one. */
struct PinnedQuat {
    double x;
    double y;
    double z;
    double w;
};`;

/** The name the emitted rotation fold answers to. */
export const PINNED_DECOMPOSE_ROTATION = "pinned_mat4_decompose_rotation";

/**
 * The three folds, in dependency order, for a caller to drop into its own
 * translation unit.
 *
 * `Math.hypot` reaches `bbl::js::hypot_js`, the shared home for that
 * recorded adaptation.
 */
/**
 * `mat4Determinant3`, lowered from its own declaration.
 *
 * One home because two callers want the same scalar triple product: this
 * module's decomposition, and the mirrored-mesh watcher, which reads the
 * sign of a mesh's world basis. A second fold of one pinned function is
 * two answers to "is this mirrored" waiting to disagree.
 */
export function lowerMat4Determinant3(
    context: LoweringContext,
    calls?: ReadonlyMap<string, (args: readonly string[]) => string>,
): string {
    return lowerPinnedFunction(
        context,
        DETERMINANT_MODULE,
        "mat4Determinant3",
        [{ pinned: "m", kind: "numberArray", cpp: "m" }],
        {
            cppName: "pinned_mat4_determinant3",
            returns: "double",
            ...(calls ? { calls } : {}),
        },
    );
}

export function lowerMat4DecomposeRotation(context: LoweringContext): string {
    const calls = new Map<string, (args: readonly string[]) => string>([
        ...pinnedNumericMathCalls(),
        ["Math.hypot", (a) => `bbl::js::hypot_js({${a.join(", ")}})`],
    ]);

    const determinant = lowerMat4Determinant3(context, calls);

    const basis = lowerPinnedFunction(
        context,
        QUAT_BASIS_MODULE,
        "_quatFromRotationBasis",
        [
            "m11",
            "m12",
            "m13",
            "m21",
            "m22",
            "m23",
            "m31",
            "m32",
            "m33",
        ].map((pinned) => ({ pinned, kind: "number" as const, cpp: pinned })),
        {
            cppName: "pinned_quat_from_rotation_basis",
            returns: {
                type: "PinnedQuat",
                value: (lowerer, expression) =>
                    `PinnedQuat{${quatComponents(
                        context,
                        lowerer,
                        expression,
                    ).join(", ")}}`,
            },
            calls,
            // The trace method picks its branch with `&&` over numeric
            // comparisons.
            booleanAnd: true,
        },
    );

    const decompose = lowerPinnedFunction(
        context,
        DECOMPOSE_MODULE,
        "mat4Decompose",
        [{ pinned: "m", kind: "mat4Const", cpp: "m" }],
        {
            cppName: PINNED_DECOMPOSE_ROTATION,
            returns: {
                type: "PinnedQuat",
                value: (lowerer, expression) => {
                    const literal = expression
                        ? context.unwrapExpression(expression)
                        : undefined;
                    if (!literal || !ts.isObjectLiteralExpression(literal)) {
                        return context.contractError(
                            expression ?? literal!,
                            "Expected mat4Decompose to return an object " +
                                "literal.",
                        );
                    }
                    return `PinnedQuat{${quatComponents(
                        context,
                        lowerer,
                        context.propertyInitializer(literal, "rotation"),
                    ).join(", ")}}`;
                },
            },
            calls: new Map([
                ...calls,
                [
                    "mat4Determinant3",
                    (a: readonly string[]) =>
                        `pinned_mat4_determinant3(${a[0]})`,
                ],
                [
                    "_quatFromRotationBasis",
                    (a: readonly string[]) =>
                        `pinned_quat_from_rotation_basis(${a.join(", ")})`,
                ],
            ]),
            recordCalls: new Map([
                ["_quatFromRotationBasis", ["x", "y", "z", "w"]],
            ]),
        },
    );

    return [
        PINNED_QUAT_DECLARATION,
        determinant,
        basis,
        // mat4Decompose, specialized to the rotation its one caller reads.
        decompose,
    ].join("\n\n");
}

/** A pinned `{x, y, z, w}` literal's four components, in that order. */
function quatComponents(
    context: LoweringContext,
    lowerer: PinnedNumericLowerer,
    expression: ts.Expression | undefined,
): string[] {
    if (!expression) {
        return context.contractError(
            context.sourceFile(DECOMPOSE_MODULE),
            "Expected a pinned quaternion literal.",
        );
    }
    return lowerObjectComponents(context, lowerer, expression, [
        "x",
        "y",
        "z",
        "w",
    ]);
}
