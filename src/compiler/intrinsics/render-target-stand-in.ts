import ts from "typescript";
import { PinnedNumericLowerer } from "../../lowering/pinned-numeric-lowerer.js";
import { PINNED_ARITHMETIC_OPERATORS } from "../../lowering/pinned-operators.js";
import type { LoweringServices } from "../lowering-services.js";
import {
    MATH_MEMBERS,
    mathArityAccepts,
    mathMemberAccess,
} from "../math-intrinsics.js";
import { namedMember } from "../symbols.js";
import { soleReturnedExpression, truthinessSelection } from "../syntax.js";
import type { Value } from "../types.js";

type Context = Pick<
    LoweringServices,
    | "unwrap"
    | "fail"
    | "checker"
    | "libraryGlobal"
    | "browserErasure"
    | "canvasSizeProperty"
    | "withRecordScopes"
    | "requireDefaultEngine"
    | "reachJsData"
    | "sharedClosures"
    | "bindings"
    | "sameEngineOwner"
>;

/** A getter's canvas must still be the engine's primary backing store. */
function readsEngineCanvas(
    context: Context,
    member: ts.PropertyAccessExpression,
    engine: string,
): boolean {
    const source = context.unwrap(member.expression);
    if (
        !ts.isIdentifier(source) ||
        context.sharedClosures.identifierIsRebound(source)
    )
        return false;
    const identity =
        context.bindings.lookupOptional(source)?.canvasEngineIdentity;
    if (
        identity !== undefined &&
        context.bindings.variableScopes.some((scope) =>
            [...scope.values()].some(
                ({ value }) =>
                    value.kind === "engine" &&
                    context.sameEngineOwner(value.cpp, engine) &&
                    value.engineIdentity === identity,
            ),
        )
    )
        return true;
    const canvas = context.browserErasure.evaluateBrowserValue(source);
    return (
        canvas?.kind === "object" &&
        canvas.primaryCanvas === true &&
        context.canvasSizeProperty(member) === member.name.text
    );
}

const extentMath = new Set(["max", "min", "floor", "ceil", "trunc", "abs"]);

/**
 * A direct target's stand-in is read by buildRenderTarget, not its factory.
 * Only pure getter expressions over the primary canvas and numeric literals
 * can use the PAL's source-extent resolver. Keep the arithmetic itself:
 * division by an arbitrary divisor is not multiplication by its reciprocal.
 */
export function renderTargetStandIn(
    context: Context,
    value: Value,
    node: ts.Expression,
): { surface: Value; resolver: string } {
    const refuse = (site: ts.Node): never =>
        context.fail(
            site,
            "A render target surface stand-in requires pure width/height getters of the engine canvas's backing extents and numeric literals.",
        );
    if (
        value.kind !== "record" ||
        value.cpp ||
        Object.keys(value.recordProperties ?? {}).length ||
        Object.keys(value.recordMethods ?? {}).length ||
        Object.keys(value.recordSetters ?? {}).length ||
        Object.keys(value.recordGetters ?? {}).length !== 2
    )
        refuse(node);
    const engine = context.requireDefaultEngine(node);
    const dimensions = ["width", "height"].map((axis) => {
        const getter = value.recordGetters?.[axis];
        const returned = getter?.body && soleReturnedExpression(getter.body);
        if (!getter || !returned) return refuse(getter ?? node);
        let readsExtent = false;
        const lowerer = new PinnedNumericLowerer(getter.getSourceFile(), {
            bindings: new Map(),
            calls: new Map(),
            foldConditions: false,
            expression(part, numeric) {
                if (
                    ts.isPropertyAccessExpression(part) &&
                    part.name.text === axis
                ) {
                    if (!readsEngineCanvas(context, part, engine))
                        return refuse(part);
                    readsExtent = true;
                    return axis;
                }
                if (ts.isNumericLiteral(part)) {
                    if (!Number.isFinite(Number(part.text)))
                        return refuse(part);
                    return undefined;
                }
                if (truthinessSelection(part)) {
                    context.reachJsData();
                    return undefined;
                }
                if (
                    (ts.isBinaryExpression(part) &&
                        PINNED_ARITHMETIC_OPERATORS.has(
                            part.operatorToken.kind,
                        )) ||
                    (ts.isPrefixUnaryExpression(part) &&
                        (part.operator === ts.SyntaxKind.PlusToken ||
                            part.operator === ts.SyntaxKind.MinusToken))
                )
                    return undefined;
                if (ts.isCallExpression(part)) {
                    const access = mathMemberAccess(
                        context.unwrap(part.expression),
                        (candidate) => context.libraryGlobal(candidate),
                        (candidate) => namedMember(context.checker, candidate),
                    );
                    const name = access?.name;
                    const member = name && MATH_MEMBERS.get(name);
                    if (
                        name &&
                        member &&
                        extentMath.has(name) &&
                        mathArityAccepts(member, part.arguments.length)
                    ) {
                        if (member.reach === "js-data") context.reachJsData();
                        return member.cpp(
                            part.arguments.map((arg) =>
                                numeric.expression(arg),
                            ),
                        );
                    }
                }
                return refuse(part);
            },
        });
        const result = context.withRecordScopes(
            value,
            () => lowerer.expression(returned),
            getter,
        );
        if (!readsExtent) return refuse(getter);
        return `static_cast<double>(bbl::render_target_dimension(${result}))`;
    });
    return {
        surface: { kind: "engine", cpp: engine, engineCpp: engine },
        resolver: `[](double width, double height, double) -> std::array<double, 2> { return {${dimensions.join(", ")}}; }`,
    };
}
