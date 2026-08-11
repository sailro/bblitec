import ts from "typescript";
import type { Value } from "./types.js";

type Fail = (node: ts.Node, message: string) => never;
type Lookup = (identifier: ts.Identifier) => Value;
type OnAwait = (expression: ts.AwaitExpression) => void;

export class StaticEvaluator {
    public constructor(
        private readonly sourceFile: ts.SourceFile,
        private readonly staticConstants: ReadonlyMap<
            string,
            ts.Expression
        >,
        private readonly lookup: Lookup,
        private readonly fail: Fail,
        private readonly onAwait: OnAwait,
    ) {}

    public compileVec3(expression: ts.Expression): string {
        const unwrapped = this.unwrap(expression);
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
        const unwrapped = this.unwrap(expression);
        if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) {
            return "true";
        }
        if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) {
            return "false";
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
            const operator = new Map<ts.SyntaxKind, string>([
                [ts.SyntaxKind.PlusToken, "+"],
                [ts.SyntaxKind.MinusToken, "-"],
                [ts.SyntaxKind.AsteriskToken, "*"],
                [ts.SyntaxKind.SlashToken, "/"],
            ]).get(unwrapped.operatorToken.kind);
            if (!operator) {
                this.fail(
                    unwrapped.operatorToken,
                    "Only +, -, *, and / are supported in numeric expressions.",
                );
            }
            return `(${this.compileNumber(
                unwrapped.left,
                precision,
            )} ${operator} ${this.compileNumber(
                unwrapped.right,
                precision,
            )})`;
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
            return `std::sqrt(${this.compileNumber(
                unwrapped.arguments[0]!,
                precision,
            )})`;
        }
        if (ts.isIdentifier(unwrapped)) {
            const value = this.lookup(unwrapped);
            if (value.kind !== "number") {
                this.fail(
                    unwrapped,
                    `Expected number, received ${value.kind}.`,
                );
            }
            return value.cpp;
        }
        this.fail(
            unwrapped,
            `Expected a compileable number, received '${unwrapped.getText(
                this.sourceFile,
            )}'.`,
        );
    }

    public isNumberExpression(
        expression: ts.Expression,
    ): boolean {
        const unwrapped = this.unwrap(expression);
        return (
            ts.isNumericLiteral(unwrapped) ||
            ts.isPrefixUnaryExpression(unwrapped) ||
            ts.isBinaryExpression(unwrapped) ||
            (ts.isPropertyAccessExpression(unwrapped) &&
                ts.isIdentifier(unwrapped.expression) &&
                unwrapped.expression.text === "Math" &&
                unwrapped.name.text === "PI") ||
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
        this.fail(unwrapped, "Expected a string literal.");
    }

    public resolveStaticExpression(
        expression: ts.Expression,
        resolving: ReadonlySet<string> = new Set(),
    ): ts.Expression {
        const unwrapped = this.unwrap(expression);
        if (!ts.isIdentifier(unwrapped)) {
            return unwrapped;
        }
        const initializer =
            this.staticConstants.get(unwrapped.text);
        if (!initializer) {
            return unwrapped;
        }
        if (resolving.has(unwrapped.text)) {
            this.fail(
                unwrapped,
                `Circular static constant '${unwrapped.text}'.`,
            );
        }
        return this.resolveStaticExpression(
            initializer,
            new Set([...resolving, unwrapped.text]),
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
