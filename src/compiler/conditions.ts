// Condition lowering: the C++ truth test of a source expression in `if`,
// loop, logical and option positions. Comparisons take their operator table
// and folds from `comparisons.ts`; a value's own truthiness is the data
// lowerer's `truthinessCondition`.
import ts from "typescript";
import { traceSourceNode } from "./source-trace.js";
import { someAnalysisNode } from "./analysis-walk.js";
import {
    compileClassInstanceOf,
    conditionComparison,
    foldBooleanComparison,
    foldSettledComparison,
    type ComparisonContext,
} from "./comparisons.js";
import { BUFFER_VIEW_KINDS, TYPED_ARRAY_KINDS } from "./data-types.js";
import { compileDomInstanceOf } from "./dom-targets.js";
import { ERROR_CONSTRUCTORS } from "./error-values.js";
import type { LoweringServices } from "./lowering-services.js";
import { unwrapExpression } from "./syntax.js";
import { retainTextValue } from "./text-surface.js";
import { isStringValue, sameCompiledValue, type Value } from "./types.js";

/** What condition lowering reads of the compiler. */
interface ConditionContext
    extends
        ComparisonContext,
        Pick<
            LoweringServices,
            | "allocateTemporaryCppName"
            | "captureEmittedLines"
            | "castNumber"
            | "compileBoolean"
            | "compileNumber"
            | "cppString"
            | "dataLowerer"
            | "defaultEngine"
            | "emit"
            | "emitDiscardedValue"
            | "enterRuntimeControlFlow"
            | "expectSameEngine"
            | "handleCollections"
            | "browserErasure"
            | "isCanvasElement"
            | "leaveRuntimeControlFlow"
            | "libraryGlobal"
            | "options"
            | "reachFeature"
            | "reachJsData"
            | "registerNativeBinding"
            | "requireDefaultEngine"
            | "unwrap"
        > {}

export class ConditionLowerer {
    constructor(private readonly context: ConditionContext) {}

    /**
     * An `instanceof` operand naming a global or a class: no local binds
     * it, or the binding is the record a class with static state binds its
     * name to.
     */
    private namesUnboundOrClass(name: ts.Identifier): boolean {
        const bound = this.context.bindings.lookupOptional(name);
        return !bound || bound.classStatics !== undefined;
    }

    /**
     * The C++ condition an expression tests, folded to `true`/`false`
     * where generation settles it.
     */
    public compileCondition(expression: ts.Expression): string {
        traceSourceNode(expression);
        const unwrapped = this.context.options.workers
            ? unwrapExpression(expression)
            : this.context.unwrap(expression);
        if (this.context.options.workers && ts.isAwaitExpression(unwrapped)) {
            const value = this.context.compileValue(unwrapped);
            if (value.kind === "void") {
                this.context.emitDiscardedValue(value);
                return "false";
            }
            return (
                this.context.dataLowerer.truthinessCondition(value) ??
                this.context.fail(
                    unwrapped,
                    "Awaited result has no represented truthiness.",
                )
            );
        }
        if (ts.isConditionalExpression(unwrapped)) {
            const value = this.context.compileValue(unwrapped);
            return (
                this.context.dataLowerer.truthinessCondition(value) ??
                this.context.fail(
                    unwrapped,
                    "Conditional result has no represented truthiness.",
                )
            );
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            (unwrapped.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken ||
                unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        ) {
            const left = this.compileCondition(unwrapped.left);
            // Fold browser-derived constants before lowering the remaining
            // runtime condition. Scene 12 deliberately combines its pinned
            // query pose with a frame counter in one conjunction.
            const isAnd =
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.AmpersandAmpersandToken;
            const identity = isAnd ? "true" : "false";
            const absorbing = isAnd ? "false" : "true";
            // Preserve JavaScript short circuiting: an unreachable right
            // operand may itself be outside the lowering contract.
            if (left === absorbing) {
                return absorbing;
            }
            let right = "";
            let rightLines: string[] = [];
            if (left === identity) {
                right = this.compileCondition(unwrapped.right);
            } else {
                this.context.enterRuntimeControlFlow();
                try {
                    rightLines = this.context.captureEmittedLines(() => {
                        right = this.compileCondition(unwrapped.right);
                    });
                } finally {
                    this.context.leaveRuntimeControlFlow();
                }
            }
            if (rightLines.length > 0) {
                if (
                    this.context.options.workers &&
                    someAnalysisNode(unwrapped.right, ts.isAwaitExpression, {
                        functions: "skip",
                    })
                ) {
                    const result =
                        this.context.allocateTemporaryCppName("logical_result");
                    this.context.emit({
                        kind: "declaration",
                        type: "bool",
                        name: result,
                        initializer: left,
                    });
                    this.context.registerNativeBinding(result);
                    this.context.emit(
                        `if (${isAnd ? result : `!${result}`}) {`,
                    );
                    for (const line of rightLines)
                        this.context.emit(`    ${line}`);
                    this.context.emit(`    ${result} = ${right};`);
                    this.context.emit("}");
                    return result;
                }
                const guardedLines = rightLines
                    .map((line) => `    ${line}`)
                    .join("\n");
                return (
                    `([&]() -> bool {\n` +
                    `    if (${isAnd ? `!(${left})` : left}) return ${absorbing};\n` +
                    `${guardedLines}\n` +
                    `    return ${right};\n` +
                    `}())`
                );
            }
            if (right === absorbing) return absorbing;
            if (left === identity) return right;
            if (right === identity) return left;
            return `(${left} ${isAnd ? "&&" : "||"} ${right})`;
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            (unwrapped.operatorToken.kind ===
                ts.SyntaxKind.EqualsEqualsEqualsToken ||
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.ExclamationEqualsEqualsToken)
        ) {
            const isPointerLockElement = (operand: ts.Expression): boolean => {
                const value = this.context.unwrap(operand);
                return (
                    ts.isPropertyAccessExpression(value) &&
                    value.name.text === "pointerLockElement" &&
                    this.context.libraryGlobal(value.expression) === "document"
                );
            };
            const isCanvas = (operand: ts.Expression): boolean => {
                const value = this.context.unwrap(operand);
                return (
                    ts.isIdentifier(value) &&
                    this.context.isCanvasElement(value)
                );
            };
            if (
                (isPointerLockElement(unwrapped.left) &&
                    isCanvas(unwrapped.right)) ||
                (isCanvas(unwrapped.left) &&
                    isPointerLockElement(unwrapped.right))
            ) {
                const locked = `${this.context.requireDefaultEngine(unwrapped)}.pointer_locked`;
                return unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.EqualsEqualsEqualsToken
                    ? locked
                    : `!(${locked})`;
            }
        }
        const domInstance = compileDomInstanceOf(this.context, unwrapped);
        if (domInstance !== undefined) return domInstance;
        if (
            ts.isPrefixUnaryExpression(unwrapped) &&
            unwrapped.operator === ts.SyntaxKind.ExclamationToken
        ) {
            const operand = this.compileCondition(unwrapped.operand);
            if (operand === "true") return "false";
            if (operand === "false") return "true";
            return `!(${operand})`;
        }
        if (this.context.browserErasure.isBrowserOnlyExpression(unwrapped)) {
            const condition =
                this.context.browserErasure.evaluateBrowserCondition(unwrapped);
            if (condition !== undefined) {
                return condition ? "true" : "false";
            }
            // A browser-only expression that does not fold carries an
            // operand the deployment does not answer: one answered beside a
            // native operand already lowered as native. Name the browser
            // operands of a binary expression so the refusal points at the
            // unanswered one.
            const browserOperands = ts.isBinaryExpression(unwrapped)
                ? [unwrapped.left, unwrapped.right].filter((operand) =>
                      this.context.browserErasure.isBrowserOnlyExpression(
                          operand,
                      ),
                  )
                : [];
            this.context.fail(
                unwrapped,
                "Browser-dependent condition cannot be determined for native AOT lowering " +
                    `(browser operands: ${browserOperands.map((operand) => operand.getText()).join(", ") || unwrapped.getText()}).`,
            );
        }
        if (ts.isBinaryExpression(unwrapped)) {
            if (unwrapped.operatorToken.kind === ts.SyntaxKind.InKeyword) {
                return this.context.dataLowerer.compileInOperator(unwrapped);
            }
            if (
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.InstanceOfKeyword &&
                ts.isIdentifier(unwrapped.right) &&
                this.namesUnboundOrClass(unwrapped.right)
            ) {
                const global =
                    this.context.libraryGlobal(unwrapped.right) ?? "";
                if (ERROR_CONSTRUCTORS.has(global)) {
                    const value = this.context.compileValue(unwrapped.left);
                    if (value.nativeError) {
                        if (global === "Error") return "true";
                        const name = value.recordProperties?.name;
                        if (name)
                            return `(${name.cpp} == ${this.context.cppString(global)})`;
                    }
                }
                const classInstance = compileClassInstanceOf(
                    this.context,
                    unwrapped,
                    unwrapped.right,
                );
                if (classInstance !== undefined) return classInstance;
                // The two buffer views answer `instanceof` beside the
                // typed arrays; neither table alone names every binary kind.
                const expected: string | undefined =
                    BUFFER_VIEW_KINDS.get(global) ??
                    TYPED_ARRAY_KINDS.get(global);
                if (expected) {
                    const value = this.context.compileValue(unwrapped.left);
                    if (value.dataType) {
                        return value.dataType.kind === expected
                            ? "true"
                            : "false";
                    }
                }
            }
            // Engine-handle identity first: `group === sadPose` is
            // upstream object identity, which native handles carry as
            // their creation-ordered `.value`. The probe only looks
            // bindings up, so a miss falls through without emitting.
            const handles =
                this.context.handleCollections.compileHandleEquality(unwrapped);
            if (handles) {
                return handles;
            }
            // Two booleans compared for identity, which is how a shared
            // module normalizes an optional flag its caller may have left
            // out (`opts.useFloatingOrigin === true`). Asked before the
            // arms that would EMIT a comparison, because where both sides
            // settle at generation the answer settles with them -- and an
            // option that decides a lowering needs that answer, not an
            // expression computing it at run time.
            const foldedBoolean = foldBooleanComparison(
                this.context,
                unwrapped,
            );
            if (foldedBoolean) {
                return foldedBoolean;
            }
            // The data equality path has to inspect both operands before it
            // can decide whether it owns the comparison. Calls emit as they
            // are inspected, so discard a declined probe and let the numeric
            // path below perform JavaScript's one evaluation for real.
            const typed = this.context.probeEmission(() =>
                this.context.dataLowerer.equalityComparison(unwrapped),
            );
            if (typed) {
                return typed;
            }
            if (
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken
            ) {
                // `if (a ?? b)`: the value dispatch selects, and the
                // selected value is the condition — the call arm's
                // delegate-and-kind-check shape below.
                const value = this.context.compileValue(unwrapped);
                if (value.staticBoolean !== undefined) {
                    return value.staticBoolean ? "true" : "false";
                }
                if (value.kind === "boolean") {
                    return value.cpp;
                }
                this.context.fail(
                    unwrapped.operatorToken,
                    "'??' in a condition must select a boolean, " +
                        `received ${value.kind}.`,
                );
            }
            const comparison = conditionComparison(
                this.context.checker,
                unwrapped,
            );
            if (comparison === "coercing")
                this.context.fail(
                    unwrapped.operatorToken,
                    "Loose equality between operands of different types " +
                        "coerces them; convert explicitly and compare strictly.",
                );
            if (!comparison) {
                if (this.context.evaluator.isNumberExpression(unwrapped)) {
                    this.context.reachJsData();
                    return `bbl::js::number_truthy(${this.context.compileNumber(unwrapped, "double")})`;
                }
                this.context.fail(
                    unwrapped.operatorToken,
                    "Reached callback conditions support numeric comparisons and logical operators.",
                );
            }
            let leftValue = this.context.compileValue(unwrapped.left);
            const textKind = (value: Value) =>
                ["text-data", "text-renderable", "text-vector"].includes(
                    value.kind,
                );
            if (textKind(leftValue))
                leftValue = retainTextValue(this.context, leftValue);
            let rightValue = this.context.compileValue(unwrapped.right);
            if (textKind(rightValue))
                rightValue = retainTextValue(this.context, rightValue);
            const operator = comparison.cpp;
            const equality =
                comparison.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
                comparison.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
            if (leftValue.kind === "texture" && rightValue.kind === "texture") {
                if (!equality)
                    this.context.fail(
                        unwrapped,
                        "Texture2D values support identity comparisons.",
                    );
                const stored = (value: Value, node: ts.Expression) =>
                    this.context.dataLowerer.compileKnownValueForSink(
                        value,
                        { kind: "handle", handle: "texture" },
                        node,
                    );
                return `${stored(leftValue, unwrapped.left)} ${operator} ${stored(rightValue, unwrapped.right)}`;
            }
            if (textKind(leftValue) || textKind(rightValue)) {
                if (!equality)
                    this.context.fail(
                        unwrapped,
                        "Text entities support strict identity comparisons.",
                    );
                const sameKind =
                    leftValue.kind === rightValue.kind &&
                    leftValue.textTransform === rightValue.textTransform;
                return sameKind
                    ? `${leftValue.cpp} ${operator} ${rightValue.cpp}`
                    : operator === "=="
                      ? "false"
                      : "true";
            }
            if (
                [leftValue.kind, rightValue.kind].some(
                    (kind) => kind === "text-font",
                )
            ) {
                if (!equality) {
                    this.context.fail(
                        unwrapped,
                        "Static font/text data only supports strict identity comparison.",
                    );
                }
                const equal = sameCompiledValue(leftValue, rightValue);
                return (operator === "==" ? equal : !equal) ? "true" : "false";
            }
            const folded = foldSettledComparison(
                comparison.kind,
                leftValue,
                rightValue,
            );
            if (folded !== undefined) {
                return folded ? "true" : "false";
            }
            if (
                equality &&
                isStringValue(leftValue) &&
                isStringValue(rightValue)
            ) {
                return `std::string(${leftValue.cpp}) ${operator} std::string(${rightValue.cpp})`;
            }
            if (
                equality &&
                leftValue.kind === "object-url" &&
                rightValue.kind === "object-url"
            ) {
                this.context.expectSameEngine(leftValue, rightValue, unwrapped);
                return `${leftValue.cpp} ${operator} ${rightValue.cpp}`;
            }
            // The statement emitter supplies the condition's outer
            // parentheses. Comparisons bind more tightly than the logical
            // expressions that compose them, so another pair here is both
            // unnecessary and diagnosed by clang-cl's
            // -Wparentheses-equality for `if ((a == b))`.
            // Both operands were already compiled above to inspect static
            // values and string identity. Reuse them: compiling their ASTs
            // again would duplicate call-shaped numeric operands.
            return `${this.context.castNumber(leftValue, "double")} ${operator} ${this.context.castNumber(rightValue, "double")}`;
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) ||
            ts.isElementAccessExpression(unwrapped)
        ) {
            const data = this.context.dataLowerer.conditionOperand(unwrapped);
            if (data) {
                return data;
            }
        }
        if (ts.isCallExpression(unwrapped)) {
            const value = this.context.compileValue(unwrapped);
            const condition =
                this.context.dataLowerer.truthinessCondition(value);
            if (condition !== undefined) return condition;
            this.context.fail(
                unwrapped,
                `Condition call must produce a boolean, received ${value.kind}.`,
            );
        }
        if (
            unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
            unwrapped.kind === ts.SyntaxKind.FalseKeyword
        ) {
            return this.context.compileBoolean(unwrapped);
        }
        if (ts.isIdentifier(unwrapped)) {
            const value = this.context.bindings.lookupOptional(unwrapped);
            if (value) {
                const dataCondition =
                    this.context.dataLowerer.truthinessCondition(value);
                if (dataCondition !== undefined) {
                    return dataCondition;
                }
                if (value.kind === "callback" || value.kind === "ui-element") {
                    return "true";
                }
                if (value.kind === "json-null") {
                    return "false";
                }
            }
            return this.context.compileBoolean(unwrapped);
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            // A record member in condition position: a boolean member is
            // its own truth (`result.hit`), and a member that carries a
            // found flag — a search result's maybe-absent record
            // (`result.hitPoint`) — is truthy exactly when the search
            // said so.
            const value = this.context.compileValue(unwrapped);
            const condition =
                this.context.dataLowerer.truthinessCondition(value);
            if (condition !== undefined) return condition;
            if (value.kind === "callback") {
                return "true";
            }
            if (value.kind === "json-null") {
                return "false";
            }
            this.context.fail(
                unwrapped,
                "Expected a reached callback condition; property produced " +
                    `${value.kind}${value.dataType ? ` ${JSON.stringify(value.dataType)}` : ""}.`,
            );
        }
        this.context.fail(unwrapped, "Expected a reached callback condition.");
    }
}
