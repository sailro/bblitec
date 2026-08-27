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

type Fail = (node: ts.Node, message: string) => never;
type Lookup = (identifier: ts.Identifier) => Value;
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

export class StaticEvaluator {
    public constructor(
        private readonly staticConstants: ReadonlyMap<
            ts.Symbol,
            ts.Expression
        >,
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
     * A native vector from a record's x/y/z lanes. A static lane
     * re-formats at the sink's width -- its stored cpp was formatted for
     * a float sink, and a bare float literal would round a double sink's
     * component a step early -- while a runtime lane is a JS double and
     * narrows exactly at a float sink.
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
            return lane.staticNumber !== undefined
                ? precision === "float"
                    ? cppFloatLiteral(lane.staticNumber)
                    : cppDoubleLiteral(lane.staticNumber)
                : this.castNumber(lane, precision);
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
            return value.cpp;
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const value = this.resolveProperty(unwrapped);
            if (value?.kind === "boolean") {
                return value.cpp;
            }
        }
        this.fail(unwrapped, "Expected a boolean literal.");
    }

    public compileNumber(
        expression: ts.Expression,
        precision: "float" | "double" = "float",
    ): string {
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
        if (ts.isPrefixUnaryExpression(unwrapped)) {
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
            const operator = new Map<ts.SyntaxKind, string>([
                [ts.SyntaxKind.PlusToken, "+"],
                [ts.SyntaxKind.MinusToken, "-"],
                [ts.SyntaxKind.AsteriskToken, "*"],
                [ts.SyntaxKind.SlashToken, "/"],
            ]).get(unwrapped.operatorToken.kind);
            if (!operator) {
                this.fail(
                    unwrapped.operatorToken,
                    "Only +, -, *, /, and % are supported in numeric expressions.",
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
            if (
                value?.kind === "number" ||
                (value?.kind === "data" &&
                    value.dataType?.kind === "number")
            ) {
                if (
                    precision === "double" &&
                    value.staticNumber !== undefined
                ) {
                    return this.doubleLiteral(
                        value.staticNumber,
                    );
                }
                return this.castNumber(value, precision);
            }
        }
        if (ts.isElementAccessExpression(unwrapped)) {
            const resolved = this.resolveElement(unwrapped);
            const value = resolved
                ? this.narrowOptional(resolved, unwrapped)
                : undefined;
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
    private castNumber(
        value: Value,
        precision: "float" | "double",
    ): string {
        // A static lane arrives pre-formatted at its width; every
        // runtime number is a JS double and narrows exactly at the
        // float sink, the way the pinned Float32Array store rounds it.
        if (
            precision === "float" &&
            value.staticNumber === undefined
        ) {
            return `static_cast<float>(${value.cpp})`;
        }
        return value.cpp;
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
            ts.isPrefixUnaryExpression(unwrapped) ||
            ts.isBinaryExpression(unwrapped) ||
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
        return (
            unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
            unwrapped.kind === ts.SyntaxKind.FalseKeyword ||
            (ts.isPrefixUnaryExpression(unwrapped) &&
                unwrapped.operator ===
                    ts.SyntaxKind.ExclamationToken)
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
            if (
                value.kind === "string" &&
                value.staticString !== undefined
            ) {
                return value.staticString;
            }
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const value = this.resolveProperty(unwrapped);
            if (
                value?.kind === "string" &&
                value.staticString !== undefined
            ) {
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
            if (owner.kind === "record") {
                const name = left.name.text;
                return owner.recordProperties?.[name] ||
                    owner.recordGetters?.[name]
                    ? expression.left
                    : expression.right;
            }
        }
        return undefined;
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
            this.staticConstants.get(symbol);
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
     * arrives as a `bbl::js::Tuple<3>` — a `std::array<double, 3>`. The
     * components round at the sink, which is where the pin's own
     * `Float32Array` store rounds them.
     */
    private dataTupleComponents(
        expression: ts.Expression,
        length: number,
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
        return tupleComponents(value.cpp, length);
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
            ts.isIdentifier(unwrapped) ||
            ts.isPropertyAccessExpression(unwrapped)
        ) {
            const value = ts.isIdentifier(unwrapped)
                ? this.lookup(unwrapped)
                : this.resolveProperty(unwrapped);
            if (
                value?.kind === "string" &&
                value.staticString !== undefined
            ) {
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
