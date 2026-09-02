import ts from "typescript";
import type { Value } from "./types.js";
import {
    isDataTuple,
    tupleComponents,
} from "./data-types.js";
import {
    doubleLiteral as cppDoubleLiteral,
    floatLiteral as cppFloatLiteral,
} from "../cpp-literals.js";
import { staticNumberValue } from "./option-helpers.js";

type Fail = (node: ts.Node, message: string) => never;
type Lookup = (identifier: ts.Identifier) => Value;
type LookupOptional = (
    identifier: ts.Identifier,
) => Value | undefined;
type OnAwait = (expression: ts.AwaitExpression) => void;
type ResolveSymbol = (
    identifier: ts.Identifier,
) => ts.Symbol | undefined;
type ResolveProperty = (
    expression: ts.PropertyAccessExpression,
) => Value | undefined;
type ResolveElement = (
    expression: ts.ElementAccessExpression,
) => Value | undefined;
type ResolveCall = (
    expression: ts.CallExpression,
) => Value;
type ResolveValue = (expression: ts.Expression) => Value;
type CompileCondition = (
    expression: ts.Expression,
) => string;
type EvaluateBrowserValue = (
    expression: ts.Expression,
) => Value["browserValue"] | undefined;
type IsBrowserOnlyExpression = (
    expression: ts.Expression,
) => boolean;
/**
 * A nullable the source guarded, as the value it narrowed to; unchanged
 * when it did not. `DataLowerer.narrowOptional` owns the rule.
 */
type NarrowOptional = (
    value: Value,
    expression: ts.Expression,
) => Value;

const bitwiseFunctions = new Map<ts.SyntaxKind, string>([
    [ts.SyntaxKind.AmpersandToken, "bitwise_and"],
    [ts.SyntaxKind.BarToken, "bitwise_or"],
    [ts.SyntaxKind.CaretToken, "bitwise_xor"],
    [ts.SyntaxKind.LessThanLessThanToken, "shift_left"],
    [ts.SyntaxKind.GreaterThanGreaterThanToken, "shift_right"],
    [
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
        "shift_right_unsigned",
    ],
]);

const arithmeticOperators = new Map<ts.SyntaxKind, string>([
    [ts.SyntaxKind.PlusToken, "+"],
    [ts.SyntaxKind.MinusToken, "-"],
    [ts.SyntaxKind.AsteriskToken, "*"],
    [ts.SyntaxKind.SlashToken, "/"],
]);

export class StaticEvaluator {
    public constructor(
        private readonly staticConstants: ReadonlyMap<
            ts.Symbol,
            ts.Expression
        >,
        private readonly checker: ts.TypeChecker,
        private readonly resolveSymbol: ResolveSymbol,
        private readonly resolveProperty: ResolveProperty,
        private readonly resolveElement: ResolveElement,
        private readonly resolveCall: ResolveCall,
        private readonly resolveValue: ResolveValue,
        private readonly compileCondition: CompileCondition,
        private readonly evaluateBrowserValue: EvaluateBrowserValue,
        private readonly isBrowserOnlyExpression: IsBrowserOnlyExpression,
        private readonly narrowOptional: NarrowOptional,
        private readonly lookup: Lookup,
        private readonly lookupOptional: LookupOptional,
        private readonly fail: Fail,
        private readonly onAwait: OnAwait,
        private readonly onJsData: () => void,
    ) {}

    /**
     * `precision` selects the native vector the components land in. The
     * camera is the one sink that asks for `double`: upstream keeps its
     * position and target as plain JavaScript numbers and rounds only at
     * the `Float32Array` matrix caches, so a float literal here would
     * round a scene's own target a step early.
     */
    public compileVec3(
        expression: ts.Expression,
        precision: "float" | "double" = "float",
    ): string {
        const type = precision === "float" ? "bbl::Vec3" : "bbl::Vec3d";
        // A vector written once as a module constant and passed by name is
        // the same literal to a compile-time reader, so the binding is
        // followed before the shapes below are matched -- the same
        // resolution every other static sink already does.
        const unwrapped = this.unwrap(
            this.resolveStaticExpression(expression),
        );
        // A record reaching a vector sink resolves the same three ways a
        // tuple does, so it takes the same dispatch: a navmesh query's
        // snapped point is handed to the next query by its local, and
        // `raycast`'s hit point is reached through `result.hitPoint`. A
        // non-record result leaves the literal branches below to run,
        // which is what keeps the domain error the message a scene
        // passing something else deserves.
        const resolved =
            ts.isIdentifier(unwrapped) ||
            ts.isElementAccessExpression(unwrapped) ||
            ts.isPropertyAccessExpression(unwrapped)
                ? this.resolveValue(unwrapped)
                : undefined;
        if (resolved?.kind === "record") {
            return this.vec3FromRecord(resolved, unwrapped, precision);
        }
        // A `[number, number, number]` local whose elements are computed --
        // scene 166 draws each component from a PRNG -- is a data tuple
        // rather than a compile-time one, so its lanes are read by index at
        // the sink's own width rather than folded.
        const dataTuple = this.dataTupleComponents(unwrapped, 3, precision);
        if (dataTuple) {
            return `${type}{${dataTuple.join(", ")}}`;
        }
        const tuple = this.tupleElements(unwrapped, 3);
        if (tuple) {
            return `${type}{${tuple
                .map((value) =>
                    this.numberValue(value, unwrapped, precision),
                )
                .join(", ")}}`;
        }
        if (
            ts.isArrayLiteralExpression(unwrapped) &&
            unwrapped.elements.length === 3
        ) {
            return `${type}{${unwrapped.elements
                .map((element) =>
                    this.compileNumber(element, precision),
                )
                .join(", ")}}`;
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
            return `${type}{${this.requiredObjectNumber(
                unwrapped,
                "x",
                precision,
            )}, ${this.requiredObjectNumber(
                unwrapped,
                "y",
                precision,
            )}, ${this.requiredObjectNumber(
                unwrapped,
                "z",
                precision,
            )}}`;
        }
        this.fail(
            unwrapped,
            "Expected a Vec3 array [x, y, z] or object { x, y, z }.",
        );
    }

    /**
     * A native vector from a record's x/y/z lanes, each written at the
     * sink's own width by `castNumber`.
     */
    public vec3FromRecord(
        value: Value,
        node: ts.Node,
        precision: "float" | "double" = "float",
    ): string {
        const type = precision === "float" ? "bbl::Vec3" : "bbl::Vec3d";
        const lanes = ["x", "y", "z"].map((name) => {
            const lane = value.recordProperties?.[name];
            if (!lane || lane.kind !== "number") {
                this.fail(
                    node,
                    `Vec3 record is missing numeric '${name}'.`,
                );
            }
            return this.castNumber(lane, precision);
        });
        return `${type}{${lanes.join(", ")}}`;
    }

    public compileVec2(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        const tuple = this.tupleElements(unwrapped, 2);
        if (tuple) {
            return `bbl::Vec2{${tuple
                .map((value) =>
                    this.numberValue(value, unwrapped),
                )
                .join(", ")}}`;
        }
        if (
            ts.isArrayLiteralExpression(unwrapped) &&
            unwrapped.elements.length === 2
        ) {
            return `bbl::Vec2{${unwrapped.elements
                .map((element) => this.compileNumber(element))
                .join(", ")}}`;
        }
        this.fail(unwrapped, "Expected a Vec2 array [x, y].");
    }

    public compileVec4(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        const tuple = this.tupleElements(unwrapped, 4);
        if (tuple) {
            return `bbl::Vec4{${tuple
                .map((value) =>
                    this.numberValue(value, unwrapped),
                )
                .join(", ")}}`;
        }
        if (
            ts.isArrayLiteralExpression(unwrapped) &&
            unwrapped.elements.length === 4
        ) {
            return `bbl::Vec4{${unwrapped.elements
                .map((element) => this.compileNumber(element))
                .join(", ")}}`;
        }
        this.fail(
            unwrapped,
            "Expected a Vec4 array [x, y, z, w].",
        );
    }

    public compileColor3(expression: ts.Expression): string {
        // Through the static resolver first, so a module-level constant
        // holding the colour reads as the literal it initializes to -- the
        // same step the Vec3 compiler beside this one already takes.
        const unwrapped = this.unwrap(
            this.resolveStaticExpression(expression),
        );
        const tuple = this.tupleElements(unwrapped, 3);
        if (tuple) {
            return `bbl::Color3{${tuple
                .map((value) =>
                    this.numberValue(value, unwrapped),
                )
                .join(", ")}}`;
        }
        const data = this.dataTupleComponents(unwrapped, 3);
        if (data) {
            return `bbl::Color3{${data.join(", ")}}`;
        }
        if (
            ts.isArrayLiteralExpression(unwrapped) &&
            unwrapped.elements.length === 3
        ) {
            return `bbl::Color3{${unwrapped.elements
                .map((element) => this.compileNumber(element))
                .join(", ")}}`;
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
            return `bbl::Color3{${this.requiredObjectNumber(
                unwrapped,
                "r",
            )}, ${this.requiredObjectNumber(
                unwrapped,
                "g",
            )}, ${this.requiredObjectNumber(
                unwrapped,
                "b",
            )}}`;
        }
        this.fail(
            unwrapped,
            "Expected a Color3 array [r, g, b] or object { r, g, b }.",
        );
    }

    public compileColor4(expression: ts.Expression): string {
        // Through the static resolver first, so a module-level constant
        // holding the colour reads as the literal it initializes to -- the
        // same step the Vec3 compiler beside this one already takes.
        const unwrapped = this.unwrap(
            this.resolveStaticExpression(expression),
        );
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const value = this.resolveProperty(unwrapped);
            if (value?.kind === "color4") {
                return value.cpp;
            }
        }
        const tuple = this.tupleElements(unwrapped, 4);
        if (tuple) {
            return `bbl::Color4{${tuple
                .map((value) =>
                    this.numberValue(value, unwrapped),
                )
                .join(", ")}}`;
        }
        if (
            ts.isArrayLiteralExpression(unwrapped) &&
            unwrapped.elements.length === 4
        ) {
            return `bbl::Color4{${unwrapped.elements
                .map((element) => this.compileNumber(element))
                .join(", ")}}`;
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
            return `bbl::Color4{${this.requiredObjectNumber(
                unwrapped,
                "r",
            )}, ${this.requiredObjectNumber(
                unwrapped,
                "g",
            )}, ${this.requiredObjectNumber(
                unwrapped,
                "b",
            )}, ${this.requiredObjectNumber(
                unwrapped,
                "a",
            )}}`;
        }
        this.fail(
            unwrapped,
            "Expected a Color4 array [r, g, b, a] or object { r, g, b, a }.",
        );
    }

    public compileBoolean(expression: ts.Expression): string {
        const unwrapped =
            this.resolveStaticExpression(expression);
        if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) {
            return "true";
        }
        if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) {
            return "false";
        }
        if (
            ts.isPrefixUnaryExpression(unwrapped) &&
            unwrapped.operator ===
                ts.SyntaxKind.ExclamationToken
        ) {
            return `!(${this.compileBoolean(unwrapped.operand)})`;
        }
        if (ts.isIdentifier(unwrapped)) {
            const value = this.lookup(unwrapped);
            if (value.kind === "node-particle-system") {
                // `set.systems[i]` is typed optional upstream, so the corpus
                // guards it. This compiler has already resolved the index:
                // the element access refuses a non-static one and the bake
                // refuses an index the graph built no system for, so by the
                // time generation succeeds the guard is settled.
                return "true";
            }
            if (value.truthinessCpp) {
                return value.truthinessCpp;
            }
            if (value.optionalFoundCpp) {
                // A handle a search produced: upstream's `find` returns
                // `undefined` when nothing matched, so the truthiness a
                // scene tests is whether it did.
                return value.optionalFoundCpp;
            }
            if (value.kind !== "boolean") {
                this.fail(
                    unwrapped,
                    `Expected boolean, received ${value.kind}.`,
                );
            }
            if (value.staticBoolean !== undefined) {
                return value.staticBoolean ? "true" : "false";
            }
            return value.cpp;
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const value = this.resolveProperty(unwrapped);
            if (value?.kind === "boolean") {
                if (value.staticBoolean !== undefined) {
                    return value.staticBoolean ? "true" : "false";
                }
                return value.cpp;
            }
        }
        // A comparison is one lowerer's job, and this file already reaches
        // it for a conditional's own test: `compileCondition` folds the
        // static string, number and boolean arms alike, so asking it here
        // is what keeps an option position and an `if` reading the same
        // expression the same way.
        //
        // Only a SETTLED answer is taken. Callers here read the returned
        // text as a decision -- the line family selects a variant on
        // `=== "true"` -- so handing one an unsettled comparison would read
        // as a silent `false` where the refusal below names the expression.
        if (ts.isBinaryExpression(unwrapped)) {
            const condition = this.compileCondition(unwrapped);
            if (condition === "true" || condition === "false") {
                return condition;
            }
        }
        this.fail(unwrapped, "Expected a boolean literal.");
    }

    public compileNumber(
        expression: ts.Expression,
        precision: "float" | "double" = "float",
    ): string {
        const castOptionalNumber = (
            value: Value,
            uncheckedElement = false,
        ): string | undefined => {
            if (
                value.kind !== "data" ||
                value.dataType?.kind !== "optional" ||
                value.dataType.inner.kind !== "number" ||
                (!value.preserveUncheckedLookup && !uncheckedElement)
            ) {
                return undefined;
            }
            this.onJsData();
            const compiled = `bbl::js::number_from_optional(${value.cpp})`;
            return precision === "float"
                ? `static_cast<float>(${compiled})`
                : compiled;
        };
        if (
            ts.isAsExpression(expression) ||
            ts.isTypeAssertionExpression(expression)
        ) {
            const asserted = this.resolveValue(expression);
            if (
                asserted.kind === "number" ||
                (asserted.kind === "data" &&
                    asserted.dataType?.kind === "number")
            ) {
                return this.castNumber(asserted, precision);
            }
        }
        const unwrapped =
            this.resolveStaticExpression(expression);
        const browserValue = this.isBrowserOnlyExpression(
            unwrapped,
        )
            ? this.evaluateBrowserValue(unwrapped)
            : undefined;
        if (browserValue?.kind === "number") {
            const type = precision === "float"
                ? "float"
                : "double";
            if (Number.isNaN(browserValue.value)) {
                return `std::numeric_limits<${type}>::quiet_NaN()`;
            }
            if (browserValue.value === Infinity) {
                return `std::numeric_limits<${type}>::infinity()`;
            }
            if (browserValue.value === -Infinity) {
                return `-std::numeric_limits<${type}>::infinity()`;
            }
            return precision === "float"
                ? this.floatLiteral(browserValue.value)
                : this.doubleLiteral(browserValue.value);
        }
        if (ts.isNumericLiteral(unwrapped)) {
            const value = Number(unwrapped.text);
            if (!Number.isFinite(value)) {
                this.fail(
                    unwrapped,
                    `Invalid numeric literal '${unwrapped.text}'.`,
                );
            }
            return precision === "float"
                ? this.floatLiteral(value)
                : this.doubleLiteral(value);
        }
        if (
            ts.isIdentifier(unwrapped) &&
            (unwrapped.text === "Infinity" ||
                unwrapped.text === "NaN")
        ) {
            const type = precision === "float"
                ? "float"
                : "double";
            return unwrapped.text === "Infinity"
                ? `std::numeric_limits<${type}>::infinity()`
                : `std::numeric_limits<${type}>::quiet_NaN()`;
        }
        if (ts.isPostfixUnaryExpression(unwrapped)) {
            const value = this.resolveValue(unwrapped);
            if (value.kind === "number") {
                return this.castNumber(value, precision);
            }
            this.fail(
                unwrapped,
                `Postfix numeric expression produced ${value.kind}.`,
            );
        }
        if (ts.isPrefixUnaryExpression(unwrapped)) {
            if (
                unwrapped.operator === ts.SyntaxKind.PlusPlusToken ||
                unwrapped.operator === ts.SyntaxKind.MinusMinusToken
            ) {
                const value = this.resolveValue(unwrapped);
                if (value.kind === "number") {
                    return this.castNumber(value, precision);
                }
                this.fail(
                    unwrapped,
                    `Prefix numeric expression produced ${value.kind}.`,
                );
            }
            if (
                unwrapped.operator ===
                ts.SyntaxKind.TildeToken
            ) {
                const compiled = `bbl::js::bitwise_not(${this.compileNumber(
                    unwrapped.operand,
                    "double",
                )})`;
                this.onJsData();
                return precision === "float"
                    ? `static_cast<float>(${compiled})`
                    : compiled;
            }
            if (
                unwrapped.operator !==
                    ts.SyntaxKind.MinusToken &&
                unwrapped.operator !== ts.SyntaxKind.PlusToken
            ) {
                this.fail(
                    unwrapped,
                    "Only unary plus and minus are supported in numeric expressions.",
                );
            }
            const operator =
                unwrapped.operator === ts.SyntaxKind.MinusToken
                    ? "-"
                    : "+";
            return `(${operator}${this.compileNumber(
                unwrapped.operand,
                precision,
            )})`;
        }
        if (ts.isBinaryExpression(unwrapped)) {
            if (
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.EqualsToken
            ) {
                const value = this.resolveValue(unwrapped);
                if (value.kind === "number") {
                    return this.castNumber(value, precision);
                }
                this.fail(
                    unwrapped,
                    `Numeric assignment expression produced ${value.kind}.`,
                );
            }
            if (
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken
            ) {
                // The general `??` in a numeric position, through the one
                // dispatch every value position owns — the
                // delegate-and-kind-check shape `resolveCall` uses below.
                // The static record fold already ran inside
                // `resolveStaticExpression` above, so this resolves the
                // run-time arms; a rung added to the value dispatch
                // reaches numeric positions without a second copy here.
                const value = this.resolveValue(unwrapped);
                if (value.kind === "number") {
                    return this.castNumber(value, precision);
                }
                this.fail(
                    unwrapped.operatorToken,
                    "'??' in a numeric position must select a number, " +
                        `received ${value.kind}.`,
                );
            }
            if (
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.BarBarToken
            ) {
                // Numeric `a || b`: JavaScript falls through on 0 and NaN.
                // Both operands evaluate eagerly (reached uses are pure).
                const compiled = `bbl::js::or_number(${this.compileNumber(
                    unwrapped.left,
                    "double",
                )}, ${this.compileNumber(
                    unwrapped.right,
                    "double",
                )})`;
                this.onJsData();
                return precision === "float"
                    ? `static_cast<float>(${compiled})`
                    : compiled;
            }
            if (
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.PercentToken
            ) {
                // JavaScript % keeps the dividend sign, exactly like fmod.
                const compiled = `std::fmod(${this.compileNumber(
                    unwrapped.left,
                    "double",
                )}, ${this.compileNumber(
                    unwrapped.right,
                    "double",
                )})`;
                return precision === "float"
                    ? `static_cast<float>(${compiled})`
                    : compiled;
            }
            if (
                unwrapped.operatorToken.kind ===
                ts.SyntaxKind.AsteriskAsteriskToken
            ) {
                const compiled = `std::pow(${this.compileNumber(
                    unwrapped.left,
                    "double",
                )}, ${this.compileNumber(
                    unwrapped.right,
                    "double",
                )})`;
                return precision === "float"
                    ? `static_cast<float>(${compiled})`
                    : compiled;
            }
            const bitwiseFunction = bitwiseFunctions.get(
                unwrapped.operatorToken.kind,
            );
            if (bitwiseFunction) {
                const compiled = `bbl::js::${bitwiseFunction}(${this.compileNumber(
                    unwrapped.left,
                    "double",
                )}, ${this.compileNumber(
                    unwrapped.right,
                    "double",
                )})`;
                this.onJsData();
                return precision === "float"
                    ? `static_cast<float>(${compiled})`
                    : compiled;
            }
            const operator = arithmeticOperators.get(
                unwrapped.operatorToken.kind,
            );
            if (!operator) {
                this.fail(
                    unwrapped.operatorToken,
                    "Unsupported operator in numeric expression.",
                );
            }
            const compiled = `(${this.compileNumber(
                unwrapped.left,
                "double",
            )} ${operator} ${this.compileNumber(
                unwrapped.right,
                "double",
            )})`;
            return precision === "float"
                ? `static_cast<float>(${compiled})`
                : compiled;
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === "Math" &&
            unwrapped.name.text === "PI"
        ) {
            return precision === "float"
                ? "bbl::pi"
                : this.doubleLiteral(Math.PI);
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === "Math" &&
            unwrapped.name.text === "SQRT2"
        ) {
            return precision === "float"
                ? "std::sqrt(2.0f)"
                : this.doubleLiteral(Math.SQRT2);
        }
        if (
            ts.isPropertyAccessExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === "Math" &&
            unwrapped.name.text === "SQRT1_2"
        ) {
            return precision === "float"
                ? "std::sqrt(0.5f)"
                : this.doubleLiteral(Math.SQRT1_2);
        }
        if (
            ts.isCallExpression(unwrapped) &&
            ts.isPropertyAccessExpression(
                unwrapped.expression,
            ) &&
            ts.isIdentifier(
                unwrapped.expression.expression,
            ) &&
            unwrapped.expression.expression.text === "Math" &&
            unwrapped.expression.name.text === "sqrt" &&
            unwrapped.arguments.length === 1
        ) {
            const compiled = `std::sqrt(${this.compileNumber(
                unwrapped.arguments[0]!,
                "double",
            )})`;
            return precision === "float"
                ? `static_cast<float>(${compiled})`
                : compiled;
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const resolved = this.resolveProperty(unwrapped);
            const value = resolved
                ? this.narrowOptional(resolved, unwrapped)
                : undefined;
            const optionalNumber = value
                ? castOptionalNumber(value)
                : undefined;
            if (optionalNumber !== undefined) {
                return optionalNumber;
            }
            if (
                value?.kind === "number" ||
                (value?.kind === "data" &&
                    value.dataType?.kind === "number")
            ) {
                return this.castNumber(value, precision);
            }
        }
        if (ts.isElementAccessExpression(unwrapped)) {
            const resolved = this.resolveElement(unwrapped);
            const value = resolved
                ? this.narrowOptional(resolved, unwrapped)
                : undefined;
            const optionalNumber = value
                ? castOptionalNumber(value, true)
                : undefined;
            if (optionalNumber !== undefined) {
                return optionalNumber;
            }
            if (
                value?.kind === "number" ||
                (value?.kind === "data" &&
                    value.dataType?.kind === "number")
            ) {
                return this.castNumber(value, precision);
            }
        }
        if (ts.isCallExpression(unwrapped)) {
            const resolved = this.resolveCall(unwrapped);
            const value = this.narrowOptional(
                resolved,
                unwrapped,
            );
            const optionalNumber = castOptionalNumber(value);
            if (optionalNumber !== undefined) {
                return optionalNumber;
            }
            if (
                value.kind !== "number" &&
                !(
                    value.kind === "data" &&
                    value.dataType?.kind === "number"
                )
            ) {
                this.fail(
                    unwrapped,
                    `Expected number, received ${value.kind}.`,
                );
            }
            return precision === "float"
                ? `static_cast<float>(${value.cpp})`
                : value.cpp;
        }
        if (ts.isConditionalExpression(unwrapped)) {
            const condition = this.compileCondition(
                unwrapped.condition,
            );
            if (condition === "true" || condition === "false") {
                return this.compileNumber(
                    condition === "true"
                        ? unwrapped.whenTrue
                        : unwrapped.whenFalse,
                    precision,
                );
            }
            const compiled = `(${condition} ? ${this.compileNumber(
                unwrapped.whenTrue,
                "double",
            )} : ${this.compileNumber(
                unwrapped.whenFalse,
                "double",
            )})`;
            return precision === "float"
                ? `static_cast<float>(${compiled})`
                : compiled;
        }
        if (ts.isIdentifier(unwrapped)) {
            const value = this.lookup(unwrapped);
            // A nullable number the source has already guarded reads as
            // the number it was narrowed to -- the unwrap, not a refusal.
            // An UNguarded read narrows to nothing and still fails by
            // name below rather than dereferencing an empty optional.
            const narrowed = this.narrowOptional(value, unwrapped);
            const optionalNumber = castOptionalNumber(narrowed);
            if (optionalNumber !== undefined) {
                return optionalNumber;
            }
            if (
                narrowed !== value &&
                narrowed.dataType?.kind === "number"
            ) {
                return this.castNumber(narrowed, precision);
            }
            if (
                value.kind !== "number" &&
                !(
                    value.kind === "data" &&
                    value.dataType?.kind === "number"
                )
            ) {
                this.fail(
                    unwrapped,
                    `Expected number, received ${value.kind}.`,
                );
            }
            return precision === "float"
                ? `static_cast<float>(${value.cpp})`
                : value.cpp;
        }
        this.fail(
            unwrapped,
            `Expected a compileable number, received '${unwrapped.getText()}'.`,
        );
    }

    /**
     * Data-model numbers are native doubles; float contexts insert an
     * explicit cast. Legacy engine-record numbers keep their own float
     * expressions untouched.
     */
    public castNumber(
        value: Value,
        precision: "float" | "double",
    ): string {
        // A static lane re-formats from its own value at the sink's
        // width. Its stored cpp was formatted for whichever sink
        // materialized it -- an array literal's lanes compile at the
        // default float width -- so handing that text to a double sink
        // rounds a step early, which at large-world coordinates is half
        // a unit and moves a silhouette. The static number IS the pin's
        // JavaScript double, so writing it out is the same value the pin
        // holds, and a float sink then gets the one rounding the pinned
        // `Float32Array` store performs.
        // A materialized binding reads through its native variable, as the
        // identifier arm of `compileNumber` already does: folding its
        // static value here would leave the emitted local unread, which the
        // warning-as-error native build refuses.
        if (
            value.staticNumber !== undefined &&
            !value.parameterBinding &&
            !value.nativeBinding
        ) {
            return precision === "float"
                ? cppFloatLiteral(value.staticNumber)
                : cppDoubleLiteral(value.staticNumber);
        }
        // Every runtime number is a JS double and narrows exactly at the
        // float sink, the way that same store rounds it.
        return precision === "float"
            ? `static_cast<float>(${value.cpp})`
            : value.cpp;
    }

    /**
     * A comparison produces a boolean, not a number. `||` stays out: the
     * numeric fall-through form above owns it, and no reached source writes
     * a logical `||` where a value is expected.
     */
    public isComparisonExpression(
        expression: ts.Expression,
    ): boolean {
        const unwrapped = this.unwrap(expression);
        return (
            ts.isBinaryExpression(unwrapped) &&
            [
                ts.SyntaxKind.EqualsEqualsEqualsToken,
                ts.SyntaxKind.ExclamationEqualsEqualsToken,
                ts.SyntaxKind.LessThanToken,
                ts.SyntaxKind.LessThanEqualsToken,
                ts.SyntaxKind.GreaterThanToken,
                ts.SyntaxKind.GreaterThanEqualsToken,
            ].includes(unwrapped.operatorToken.kind)
        );
    }

    public isNumberExpression(
        expression: ts.Expression,
    ): boolean {
        const unwrapped = this.unwrap(expression);
        if (
            this.isComparisonExpression(unwrapped) ||
            (ts.isBinaryExpression(unwrapped) &&
                unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken)
        ) {
            return false;
        }
        return (
            ts.isNumericLiteral(unwrapped) ||
            (ts.isIdentifier(unwrapped) &&
                (unwrapped.text === "Infinity" ||
                    unwrapped.text === "NaN")) ||
            (ts.isPrefixUnaryExpression(unwrapped) &&
                (unwrapped.operator === ts.SyntaxKind.PlusToken ||
                    unwrapped.operator === ts.SyntaxKind.MinusToken ||
                    unwrapped.operator === ts.SyntaxKind.TildeToken ||
                    unwrapped.operator === ts.SyntaxKind.PlusPlusToken ||
                    unwrapped.operator === ts.SyntaxKind.MinusMinusToken)) ||
            (ts.isBinaryExpression(unwrapped) &&
                [
                    ts.SyntaxKind.PlusToken,
                    ts.SyntaxKind.MinusToken,
                    ts.SyntaxKind.AsteriskToken,
                    ts.SyntaxKind.AsteriskAsteriskToken,
                    ts.SyntaxKind.SlashToken,
                    ts.SyntaxKind.PercentToken,
                    ts.SyntaxKind.AmpersandToken,
                    ts.SyntaxKind.BarToken,
                    ts.SyntaxKind.CaretToken,
                    ts.SyntaxKind.LessThanLessThanToken,
                    ts.SyntaxKind.GreaterThanGreaterThanToken,
                    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
                    // Reached value-position `a || b` is the JavaScript
                    // numeric fallback form compiled by compileNumber.
                    ts.SyntaxKind.BarBarToken,
                ].includes(unwrapped.operatorToken.kind) &&
                !this.isBooleanExpression(unwrapped)) ||
            (ts.isPropertyAccessExpression(unwrapped) &&
                ts.isIdentifier(unwrapped.expression) &&
                unwrapped.expression.text === "Math" &&
                (unwrapped.name.text === "PI" ||
                    unwrapped.name.text === "SQRT1_2")) ||
            (ts.isCallExpression(unwrapped) &&
                ts.isPropertyAccessExpression(
                    unwrapped.expression,
                ) &&
                ts.isIdentifier(
                    unwrapped.expression.expression,
                ) &&
                unwrapped.expression.expression.text === "Math" &&
                unwrapped.expression.name.text === "sqrt" &&
                unwrapped.arguments.length === 1)
        );
    }

    public isBooleanExpression(
        expression: ts.Expression,
    ): boolean {
        const unwrapped = this.unwrap(expression);
        const type = this.checker.getTypeAtLocation(unwrapped);
        const booleanType = (candidate: ts.Type): boolean =>
            (candidate.flags &
                (ts.TypeFlags.Boolean |
                    ts.TypeFlags.BooleanLiteral)) !==
                0 ||
            ((candidate.flags & ts.TypeFlags.Union) !== 0 &&
                (candidate as ts.UnionType).types.every(
                    booleanType,
                ));
        if (booleanType(type)) {
            return true;
        }
        if (this.isComparisonExpression(unwrapped)) {
            return true;
        }
        if (ts.isIdentifier(unwrapped)) {
            return this.lookupOptional(unwrapped)?.kind === "boolean";
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            return this.resolveProperty(unwrapped)?.kind === "boolean";
        }
        return (
            unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
            unwrapped.kind === ts.SyntaxKind.FalseKeyword ||
            (ts.isPrefixUnaryExpression(unwrapped) &&
                unwrapped.operator ===
                    ts.SyntaxKind.ExclamationToken) ||
            (ts.isBinaryExpression(unwrapped) &&
                (unwrapped.operatorToken.kind ===
                    ts.SyntaxKind.AmpersandAmpersandToken ||
                    unwrapped.operatorToken.kind ===
                        ts.SyntaxKind.BarBarToken) &&
                this.isBooleanExpression(unwrapped.left) &&
                this.isBooleanExpression(unwrapped.right))
        );
    }

    public expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression {
        const resolved =
            this.resolveStaticExpression(expression);
        if (!ts.isArrayLiteralExpression(resolved)) {
            this.fail(
                resolved,
                "Expected a static array literal.",
            );
        }
        return resolved;
    }

    public compileStringLiteral(
        expression: ts.Expression,
    ): string {
        const unwrapped =
            this.resolveStaticExpression(expression);
        if (
            ts.isStringLiteral(unwrapped) ||
            ts.isNoSubstitutionTemplateLiteral(unwrapped)
        ) {
            return unwrapped.text;
        }
        if (ts.isIdentifier(unwrapped)) {
            const value = this.lookup(unwrapped);
            if (value.staticString !== undefined) {
                return value.staticString;
            }
            this.fail(
                unwrapped,
                `Expected a string literal; '${unwrapped.text}' is bound as ${value.kind} without a static string.`,
            );
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const value = this.resolveProperty(unwrapped);
            if (value?.staticString !== undefined) {
                return value.staticString;
            }
        }
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind ===
                ts.SyntaxKind.PlusToken
        ) {
            return (
                this.compileStringLiteral(unwrapped.left) +
                this.compileStringLiteral(unwrapped.right)
            );
        }
        if (ts.isTemplateExpression(unwrapped)) {
            let result = unwrapped.head.text;
            for (const span of unwrapped.templateSpans) {
                const value = this.staticText(
                    span.expression,
                );
                result += value;
                result += span.literal.text;
            }
            return result;
        }
        if (
            ts.isCallExpression(unwrapped) &&
            ts.isPropertyAccessExpression(unwrapped.expression) &&
            unwrapped.expression.name.text === "join" &&
            unwrapped.arguments.length <= 1
        ) {
            const owner = this.resolveStaticExpression(
                unwrapped.expression.expression,
            );
            if (ts.isArrayLiteralExpression(owner)) {
                const separator = unwrapped.arguments[0]
                    ? this.compileStringLiteral(unwrapped.arguments[0])
                    : ",";
                return owner.elements
                    .map((element) => {
                        if (ts.isOmittedExpression(element)) return "";
                        if (ts.isSpreadElement(element)) {
                            this.fail(
                                element,
                                "A static string array join does not support spread elements.",
                            );
                        }
                        return this.compileStringLiteral(element);
                    })
                    .join(separator);
            }
        }
        this.fail(unwrapped, "Expected a string literal.");
    }

    /**
     * `options.x ?? fallback` over a static record, or undefined.
     *
     * Babylon Lite reads its option records this way throughout, and a
     * record literal settles the question at compile time: the property
     * is either written in the literal, in which case the left operand is
     * the value and the fallback is dead, or it is absent, in which case
     * the property is `undefined` and the fallback is the value. Neither
     * arm needs a native null, and resolving to the winning *expression*
     * rather than to a value keeps its precision for whichever consumer
     * asked. A `??` over anything else returns undefined: the value path
     * lowers it over the data model instead, and a genuinely static
     * position that then needs a compile-time answer fails as that
     * position, naming what it needed.
     */
    public tryResolveNullish(
        expression: ts.BinaryExpression,
    ): ts.Expression | undefined {
        const left = this.unwrap(expression.left);
        if (ts.isPropertyAccessExpression(left)) {
            // Records are identifier-bound, so only those owners are
            // probed: the probe is a full value compile with emit
            // authority, and an owner shape whose compilation emits
            // statements (a call's arguments) must not emit them here
            // first and again on the value path.
            const ownerNode = this.unwrap(left.expression);
            if (
                !ts.isIdentifier(ownerNode) &&
                ownerNode.kind !== ts.SyntaxKind.ThisKeyword
            ) {
                return undefined;
            }
            const owner = this.resolveValue(left.expression);
            const name = left.name.text;
            const property = owner.recordProperties?.[name];
            if (property) {
                if (property.kind === "json-null") {
                    return expression.right;
                }
                if (
                    property.optionalFoundCpp !== undefined ||
                    (property.kind === "data" &&
                        property.dataType?.kind === "optional")
                ) {
                    return undefined;
                }
                return expression.left;
            }
            if (owner.recordGetters?.[name]) {
                return expression.left;
            }
            if (owner.kind === "record") {
                return expression.right;
            }
        }
        return undefined;
    }

    /**
     * The literal a `const` binding was declared with, when that is all it
     * is.
     *
     * The pre-pass collects module-scope declarations; a bag or list a
     * function names before passing it -- `const agentParams = {...}`
     * inside `main()` -- is the same spelling one scope down, and refusing
     * it refuses a spelling rather than a feature. Read off the SYMBOL's
     * own declaration rather than a second pre-pass, because the checker
     * can hand back distinct symbol instances for a declaration name and a
     * use of it, and a map keyed by identity then misses.
     *
     * Deliberately narrow, on three counts:
     *   - `const` only, so no later assignment reseated the binding.
     *   - an object literal only. Resolution hands the INITIALIZER to the
     *     use site, so a `const n = expensive()` would move the call and
     *     two use sites would run it twice; a literal has no such body.
     *   - and only one nothing writes through; see `isWrittenThrough`.
     */
    private constLiteralInitializer(
        symbol: ts.Symbol,
    ): ts.Expression | undefined {
        const declarations = symbol.declarations ?? [];
        if (declarations.length !== 1) {
            return undefined;
        }
        const declaration = declarations[0]!;
        if (
            !ts.isVariableDeclaration(declaration) ||
            !ts.isVariableDeclarationList(declaration.parent) ||
            (declaration.parent.flags & ts.NodeFlags.Const) === 0
        ) {
            return undefined;
        }
        // Top-level declarations belong to the pre-pass, which also
        // REMOVES them once a materialized module's storage supersedes the
        // initializer. Answering for one here would restore exactly what
        // that removal took away, so this fallback only ever adds scopes
        // the pre-pass does not walk.
        const statement = declaration.parent.parent;
        if (
            !ts.isVariableStatement(statement) ||
            ts.isSourceFile(statement.parent)
        ) {
            return undefined;
        }
        const initializer = declaration.initializer;
        // The object-literal test comes FIRST on purpose: it settles all
        // but a handful of candidates, and the scan behind it walks a whole
        // function body. Measured over the corpus, the scan runs four times.
        if (
            !initializer ||
            !ts.isObjectLiteralExpression(initializer) ||
            this.isWrittenThrough(declaration)
        ) {
            return undefined;
        }
        return initializer;
    }

    /**
     * Whether anything in the binding's scope writes through it.
     *
     * `const` freezes the BINDING, not the object: `const p = {n: 1}`
     * followed by `p.n = 2`, `p.n++`, `delete p.n` or `reset(p)` all leave
     * the initializer stale, and answering it would hand back the declared
     * contents rather than the current ones.
     *
     * The compiler's own `inferredObjectIsMutated` looks like the right
     * thing to call and is NOT: it answers "is this object's identity
     * observable", so it counts storing anything reachable from the name
     * into a container -- `scaling.set(params.radius * 2, ...)` marks
     * `params` mutated, because `set` is a storing method and the alias
     * test scans the whole argument subtree. That is correct for reference
     * storage and wrong for this question.
     *
     * The call arm below is the load-bearing one: this compiler inlines
     * every reached function and binds an object parameter by reference,
     * so a bag handed to scene-local code can come back changed. A bag
     * handed to an INTRINSIC cannot -- those declare no body to inline --
     * which is what makes `addAgent(crowd, spawn, params)` still foldable.
     */
    private isWrittenThrough(
        declaration: ts.VariableDeclaration,
    ): boolean {
        const name = ts.isIdentifier(declaration.name)
            ? declaration.name.text
            : undefined;
        if (name === undefined) {
            return true;
        }
        let scope: ts.Node = declaration;
        while (scope.parent && !ts.isFunctionLike(scope)) {
            scope = scope.parent;
        }
        const namesBinding = (node: ts.Node): boolean =>
            ts.isIdentifier(node) && node.text === name;
        const throughBinding = (node: ts.Node): boolean =>
            (ts.isPropertyAccessExpression(node) ||
                ts.isElementAccessExpression(node)) &&
            namesBinding(node.expression);
        let written = false;
        const visit = (node: ts.Node): void => {
            if (written) {
                return;
            }
            const parent = node.parent;
            if (throughBinding(node)) {
                const assigned =
                    ts.isBinaryExpression(parent) &&
                    parent.left === node &&
                    parent.operatorToken.kind >=
                        ts.SyntaxKind.FirstAssignment &&
                    parent.operatorToken.kind <=
                        ts.SyntaxKind.LastAssignment;
                const stepped =
                    (ts.isPrefixUnaryExpression(parent) ||
                        ts.isPostfixUnaryExpression(parent)) &&
                    (parent.operator ===
                        ts.SyntaxKind.PlusPlusToken ||
                        parent.operator ===
                            ts.SyntaxKind.MinusMinusToken);
                const deleted =
                    ts.isDeleteExpression(parent);
                const called =
                    ts.isCallExpression(parent) &&
                    parent.expression === node;
                if (assigned || stepped || deleted || called) {
                    written = true;
                    return;
                }
            }
            if (
                ts.isCallExpression(node) &&
                node.arguments.some(namesBinding) &&
                this.callReachesABody(node)
            ) {
                written = true;
                return;
            }
            ts.forEachChild(node, visit);
        };
        ts.forEachChild(scope, visit);
        return written;
    }

    /**
     * Whether a call could run scene-local code over its arguments.
     *
     * An intrinsic resolves to a declaration in a `.d.ts`, which has no
     * body for the inliner to reach; anything declared in source does.
     */
    private callReachesABody(call: ts.CallExpression): boolean {
        const declaration = this.checker
            .getResolvedSignature(call)
            ?.declaration;
        return (
            declaration !== undefined &&
            !declaration.getSourceFile().isDeclarationFile
        );
    }

    public resolveStaticExpression(
        expression: ts.Expression,
        resolving: ReadonlySet<ts.Symbol> = new Set(),
    ): ts.Expression {
        const unwrapped = this.unwrap(expression);
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken
        ) {
            // A static record settles the `??` here; anything else stays
            // unresolved so the value path can lower it over the data
            // model. A position that genuinely needs a compile-time
            // number then fails as that position, naming what it needed.
            const resolved = this.tryResolveNullish(unwrapped);
            if (resolved) {
                return this.resolveStaticExpression(
                    resolved,
                    resolving,
                );
            }
            return unwrapped;
        }
        if (!ts.isIdentifier(unwrapped)) {
            return unwrapped;
        }
        const symbol = this.resolveSymbol(unwrapped);
        if (!symbol) {
            return unwrapped;
        }
        const initializer =
            this.staticConstants.get(symbol) ??
            this.constLiteralInitializer(symbol);
        if (!initializer) {
            return unwrapped;
        }
        if (resolving.has(symbol)) {
            this.fail(
                unwrapped,
                `Circular static constant '${unwrapped.text}'.`,
            );
        }
        return this.resolveStaticExpression(
            initializer,
            new Set([...resolving, symbol]),
        );
    }

    private objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined {
        for (const property of object.properties) {
            if (
                ts.isPropertyAssignment(property) &&
                this.propertyName(property.name) === name
            ) {
                return property.initializer;
            }
            if (
                ts.isShorthandPropertyAssignment(property) &&
                property.name.text === name
            ) {
                return property.name;
            }
        }
        return undefined;
    }

    private tupleElements(
        expression: ts.Expression,
        length: number,
    ): Value[] | undefined {
        // An identifier binds, or resolves through a module-level
        // initializer; an element or property access reaches an entry of
        // a static table, which is how an indexed color table feeds a
        // Color3 sink. A non-tuple result leaves the caller's remaining
        // literal branches to run.
        const value =
            ts.isIdentifier(expression) ||
            ts.isElementAccessExpression(expression) ||
            ts.isPropertyAccessExpression(expression)
                ? this.resolveValue(expression)
                : undefined;
        if (value?.kind !== "tuple") {
            return undefined;
        }
        if (value.tupleElements?.length !== length) {
            this.fail(
                expression,
                `Expected a ${length}-element tuple.`,
            );
        }
        return value.tupleElements;
    }

    /**
     * The components of a plain-data numeric tuple, as native expressions.
     *
     * A colour table written with an explicit `[number, number, number][]`
     * annotation is data rather than a compile-time table, so its element
     * arrives as a `bbl::js::Tuple<3>`. The components round at the sink,
     * which is where the pin's own `Float32Array` store rounds them.
     */
    private dataTupleComponents(
        expression: ts.Expression,
        length: number,
        precision: "float" | "double" = "float",
    ): string[] | undefined {
        if (
            !ts.isIdentifier(expression) &&
            !ts.isElementAccessExpression(expression) &&
            !ts.isPropertyAccessExpression(expression)
        ) {
            return undefined;
        }
        const value = this.resolveValue(expression);
        if (!isDataTuple(value, length)) {
            return undefined;
        }
        return tupleComponents(value.cpp, length, precision);
    }

    private numberValue(
        value: Value,
        node: ts.Node,
        precision: "float" | "double" = "float",
    ): string {
        if (value.kind !== "number") {
            this.fail(
                node,
                `Expected numeric tuple element, received ${value.kind}.`,
            );
        }
        return this.castNumber(value, precision);
    }

    public staticTextValue(
        expression: ts.Expression,
    ): string | undefined {
        const unwrapped =
            this.resolveStaticExpression(expression);
        if (
            ts.isStringLiteral(unwrapped) ||
            ts.isNoSubstitutionTemplateLiteral(unwrapped)
        ) {
            return unwrapped.text;
        }
        if (ts.isNumericLiteral(unwrapped)) {
            return String(Number(unwrapped.text));
        }
        if (
            ts.isCallExpression(unwrapped) &&
            ts.isPropertyAccessExpression(
                unwrapped.expression,
            ) &&
            ["toFixed", "toPrecision", "toExponential"].includes(
                unwrapped.expression.name.text,
            ) &&
            unwrapped.arguments.length <= 1
        ) {
            const staticContext = {
                resolveStaticExpression: (
                    value: ts.Expression,
                ) => this.resolveStaticExpression(value),
                lookup: (identifier: ts.Identifier) =>
                    this.lookup(identifier),
                lookupOptional: (identifier: ts.Identifier) =>
                    this.lookupOptional(identifier),
                fail: (node: ts.Node, message: string): never =>
                    this.fail(node, message),
            };
            const number = staticNumberValue(
                staticContext,
                unwrapped.expression.expression,
            );
            const digits = unwrapped.arguments[0]
                ? staticNumberValue(
                      staticContext,
                      unwrapped.arguments[0],
                  )
                : undefined;
            const method = unwrapped.expression.name.text;
            if (number !== undefined && digits === undefined) {
                return method === "toFixed"
                    ? number.toFixed()
                    : method === "toPrecision"
                      ? number.toPrecision()
                      : number.toExponential();
            }
            if (
                number !== undefined &&
                digits !== undefined &&
                Number.isInteger(digits)
            ) {
                if (method === "toFixed" && digits >= 0 && digits <= 100) {
                    return number.toFixed(digits);
                }
                if (
                    method === "toPrecision" &&
                    digits >= 1 &&
                    digits <= 100
                ) {
                    return number.toPrecision(digits);
                }
                if (
                    method === "toExponential" &&
                    digits >= 0 &&
                    digits <= 100
                ) {
                    return number.toExponential(digits);
                }
            }
        }
        if (
            ts.isIdentifier(unwrapped) ||
            ts.isPropertyAccessExpression(unwrapped)
        ) {
            const value = ts.isIdentifier(unwrapped)
                ? this.lookup(unwrapped)
                : this.resolveProperty(unwrapped);
            if (value?.staticString !== undefined) {
                return value.staticString;
            }
            if (
                value?.kind === "number" &&
                value.staticNumber !== undefined
            ) {
                return String(value.staticNumber);
            }
        }
        return undefined;
    }

    private staticText(
        expression: ts.Expression,
    ): string {
        const value = this.staticTextValue(expression);
        if (value !== undefined) return value;
        this.fail(
            expression,
            "Template substitutions must be static strings or numbers.",
        );
    }

    private requiredObjectNumber(
        object: ts.ObjectLiteralExpression,
        name: string,
        precision: "float" | "double" = "float",
    ): string {
        const value = this.objectProperty(object, name);
        if (!value) {
            this.fail(
                object,
                `Object literal is missing numeric property '${name}'.`,
            );
        }
        return this.compileNumber(value, precision);
    }

    private propertyName(
        name: ts.PropertyName,
    ): string | undefined {
        if (
            ts.isIdentifier(name) ||
            ts.isStringLiteral(name) ||
            ts.isNumericLiteral(name)
        ) {
            return name.text;
        }
        return undefined;
    }

    private unwrap(
        expression: ts.Expression,
    ): ts.Expression {
        let current = expression;
        while (
            ts.isAsExpression(current) ||
            ts.isTypeAssertionExpression(current) ||
            ts.isParenthesizedExpression(current) ||
            ts.isNonNullExpression(current) ||
            ts.isAwaitExpression(current)
        ) {
            if (ts.isAwaitExpression(current)) {
                this.onAwait(current);
            }
            current = current.expression;
        }
        return current;
    }

    private floatLiteral(value: number): string {
        return cppFloatLiteral(value);
    }

    private doubleLiteral(value: number): string {
        return cppDoubleLiteral(value);
    }
}
