import ts from "typescript";
import type { Value } from "./types.js";

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
        private readonly lookup: Lookup,
        private readonly fail: Fail,
        private readonly onAwait: OnAwait,
        private readonly onJsData: () => void,
    ) {}

    public compileVec3(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const value = this.resolveProperty(unwrapped);
            if (value?.kind === "record") {
                return `bbl::Vec3{${["x", "y", "z"]
                    .map((name) =>
                        this.numberValue(
                            value.recordProperties?.[name] ??
                                this.fail(
                                    unwrapped,
                                    `Vec3 record is missing '${name}'.`,
                                ),
                            unwrapped,
                        ),
                    )
                    .join(", ")}}`;
            }
        }
        const tuple = this.tupleElements(unwrapped, 3);
        if (tuple) {
            return `bbl::Vec3{${tuple
                .map((value) =>
                    this.numberValue(value, unwrapped),
                )
                .join(", ")}}`;
        }
        if (
            ts.isArrayLiteralExpression(unwrapped) &&
            unwrapped.elements.length === 3
        ) {
            return `bbl::Vec3{${unwrapped.elements
                .map((element) => this.compileNumber(element))
                .join(", ")}}`;
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
            return `bbl::Vec3{${this.requiredObjectNumber(
                unwrapped,
                "x",
            )}, ${this.requiredObjectNumber(
                unwrapped,
                "y",
            )}, ${this.requiredObjectNumber(
                unwrapped,
                "z",
            )}}`;
        }
        this.fail(
            unwrapped,
            "Expected a Vec3 array [x, y, z] or object { x, y, z }.",
        );
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

    public compileColor3(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
        const tuple = this.tupleElements(unwrapped, 3);
        if (tuple) {
            return `bbl::Color3{${tuple
                .map((value) =>
                    this.numberValue(value, unwrapped),
                )
                .join(", ")}}`;
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
        const unwrapped = this.unwrap(expression);
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
            const value = this.resolveProperty(unwrapped);
            if (value?.kind === "number") {
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
            const value = this.resolveElement(unwrapped);
            if (value?.kind === "number") {
                return this.castNumber(value, precision);
            }
        }
        if (ts.isCallExpression(unwrapped)) {
            const value = this.resolveCall(unwrapped);
            if (value.kind !== "number") {
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
            const compiled = `(${this.compileCondition(
                unwrapped.condition,
            )} ? ${this.compileNumber(
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
            if (value.kind !== "number") {
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
        if (
            precision === "float" &&
            value.dataType?.kind === "number"
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
     * `options.x ?? fallback` over a static record.
     *
     * Babylon Lite reads its option records this way throughout, and a
     * record literal settles the question at compile time: the property
     * is either written in the literal, in which case the left operand is
     * the value and the fallback is dead, or it is absent, in which case
     * the property is `undefined` and the fallback is the value. Neither
     * arm needs a native null, and resolving to the winning *expression*
     * rather than to a value keeps its precision for whichever consumer
     * asked. A `??` over anything else fails rather than being lowered to
     * a runtime test that nothing reaches.
     */
    public resolveNullish(
        expression: ts.BinaryExpression,
    ): ts.Expression {
        const left = this.unwrap(expression.left);
        if (ts.isPropertyAccessExpression(left)) {
            const owner = this.resolveValue(left.expression);
            if (owner.kind === "record") {
                const name = left.name.text;
                return owner.recordProperties?.[name] ||
                    owner.recordGetters?.[name]
                    ? expression.left
                    : expression.right;
            }
        }
        this.fail(
            expression.operatorToken,
            "'??' is lowered over a static record property, whose presence decides the value at compile time.",
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
            return this.resolveStaticExpression(
                this.resolveNullish(unwrapped),
                resolving,
            );
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

    private numberValue(
        value: Value,
        node: ts.Node,
    ): string {
        if (value.kind !== "number") {
            this.fail(
                node,
                `Expected numeric tuple element, received ${value.kind}.`,
            );
        }
        return value.cpp;
    }

    private staticText(
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
        this.fail(
            unwrapped,
            "Template substitutions must be static strings or numbers.",
        );
    }

    private requiredObjectNumber(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): string {
        const value = this.objectProperty(object, name);
        if (!value) {
            this.fail(
                object,
                `Object literal is missing numeric property '${name}'.`,
            );
        }
        return this.compileNumber(value);
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
        if (Number.isInteger(value)) {
            return `${value}.0f`;
        }
        return `${value}f`;
    }

    private doubleLiteral(value: number): string {
        if (Number.isInteger(value)) {
            return `${value}.0`;
        }
        return `${value}`;
    }
}
