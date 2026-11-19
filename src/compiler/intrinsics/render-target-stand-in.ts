import ts from "typescript";
import { doubleLiteral } from "../../cpp-literals.js";
import {
    cppPrimary,
    numericLogicalValueCpp,
    renderPinnedArithmetic,
    type RenderedCpp,
} from "../../lowering/pinned-numeric-expression.js";
import type { LoweringServices } from "../lowering-services.js";
import {
    MATH_MEMBERS,
    mathArityAccepts,
    mathMemberAccess,
} from "../math-intrinsics.js";
import { namedMember } from "../symbols.js";
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
        const statement = getter?.body?.statements[0];
        if (
            !getter ||
            getter.body?.statements.length !== 1 ||
            !statement ||
            !ts.isReturnStatement(statement) ||
            !statement.expression
        )
            return refuse(getter ?? node);
        let readsExtent = false;
        let logicalIndex = 0;
        const render = (expression: ts.Expression): RenderedCpp => {
            const part = context.unwrap(expression);
            if (
                ts.isPropertyAccessExpression(part) &&
                part.name.text === axis
            ) {
                const source = context.unwrap(part.expression);
                if (
                    !ts.isIdentifier(source) ||
                    context.sharedClosures.identifierIsRebound(source)
                )
                    return refuse(part);
                const canvas =
                    context.browserErasure.evaluateBrowserValue(source);
                const identity =
                    context.bindings.lookupOptional(
                        source,
                    )?.canvasEngineIdentity;
                const retained =
                    identity !== undefined &&
                    context.bindings.variableScopes.some((scope) =>
                        [...scope.values()].some(
                            ({ value }) =>
                                value.kind === "engine" &&
                                context.sameEngineOwner(value.cpp, engine) &&
                                value.engineIdentity === identity,
                        ),
                    );
                if (
                    !retained &&
                    !(
                        canvas?.kind === "object" &&
                        canvas.primaryCanvas &&
                        context.canvasSizeProperty(part) === axis
                    )
                )
                    return refuse(part);
                readsExtent = true;
                return cppPrimary(axis);
            }
            if (ts.isNumericLiteral(part)) {
                const number = Number(part.text);
                if (!Number.isFinite(number)) return refuse(part);
                return cppPrimary(doubleLiteral(number));
            }
            if (
                ts.isBinaryExpression(part) &&
                (part.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                    part.operatorToken.kind ===
                        ts.SyntaxKind.AmpersandAmpersandToken)
            ) {
                context.reachJsData();
                return cppPrimary(
                    numericLogicalValueCpp(
                        render(part.left).text,
                        render(part.right).text,
                        part.operatorToken.kind === ts.SyntaxKind.BarBarToken,
                        `extent_${logicalIndex++}`,
                    ),
                );
            }
            if (
                (ts.isBinaryExpression(part) &&
                    [
                        ts.SyntaxKind.PlusToken,
                        ts.SyntaxKind.MinusToken,
                        ts.SyntaxKind.AsteriskToken,
                        ts.SyntaxKind.SlashToken,
                    ].includes(part.operatorToken.kind)) ||
                (ts.isPrefixUnaryExpression(part) &&
                    (part.operator === ts.SyntaxKind.PlusToken ||
                        part.operator === ts.SyntaxKind.MinusToken))
            ) {
                const lowered = renderPinnedArithmetic(part, render);
                if (lowered) return lowered;
            }
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
                    ["max", "min", "floor", "ceil", "trunc", "abs"].includes(
                        name,
                    ) &&
                    mathArityAccepts(member, part.arguments.length)
                ) {
                    if (member.reach === "js-data") context.reachJsData();
                    return cppPrimary(
                        member.cpp(
                            part.arguments.map(
                                (argument) => render(argument).text,
                            ),
                        ),
                    );
                }
            }
            return refuse(part);
        };
        const result = context.withRecordScopes(
            value,
            () => render(statement.expression!).text,
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
