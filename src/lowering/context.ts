import ts from "typescript";
import { UpstreamSourceStore } from "../upstream-source.js";

export interface LoweredSource {
    header: string;
    source: string;
    modulePath: string;
    symbolName: string;
}

export class LoweringContext {
    public constructor(public readonly store = new UpstreamSourceStore()) {}

    public provenance(modulePath: string, symbolName: string, extra?: string): string {
        const base =
            `Generated from ${this.store.pin.package}@${this.store.pin.version} ` +
            `(${this.store.pin.sourceVersion}) ${modulePath}#${symbolName}`;
        return `${base}${extra ? ` and ${extra}` : ""}.`;
    }

    public sourceFile(modulePath: string): ts.SourceFile {
        return ts.createSourceFile(
            modulePath,
            this.store.getSource(modulePath),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
    }

    public functionDeclaration(modulePath: string, symbolName: string): {
        file: ts.SourceFile;
        declaration: ts.FunctionDeclaration;
    } {
        const file = this.sourceFile(modulePath);
        const declaration = file.statements.find(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) &&
                statement.name?.text === symbolName &&
                statement.body !== undefined,
        );
        if (!declaration?.body) throw new Error(`${modulePath} does not export ${symbolName}.`);
        return { file, declaration };
    }

    public objectInitializer(
        declaration: ts.FunctionDeclaration,
        variableName: string,
    ): ts.ObjectLiteralExpression {
        let object: ts.ObjectLiteralExpression | undefined;
        const visit = (node: ts.Node): void => {
            if (
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === variableName &&
                node.initializer &&
                ts.isObjectLiteralExpression(node.initializer)
            ) {
                object = node.initializer;
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration);
        if (!object) throw new Error(`Upstream variable '${variableName}' object literal was not found.`);
        return object;
    }

    public propertyInitializer(object: ts.ObjectLiteralExpression, name: string): ts.Expression {
        const property = object.properties.find(
            (candidate) =>
                (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
                ts.isIdentifier(candidate.name) &&
                candidate.name.text === name,
        );
        if (!property) throw new Error(`Upstream object is missing '${name}'.`);
        if (ts.isPropertyAssignment(property)) return property.initializer;
        if (ts.isShorthandPropertyAssignment(property)) return property.name;
        throw new Error(`Upstream object is missing '${name}'.`);
    }

    public numericValue(expression: ts.Expression, file: ts.SourceFile): number {
        const unwrapped = this.unwrapExpression(expression);
        if (ts.isNumericLiteral(unwrapped)) return Number(unwrapped.text);
        if (ts.isPrefixUnaryExpression(unwrapped) && unwrapped.operator === ts.SyntaxKind.MinusToken) {
            return -this.numericValue(unwrapped.operand, file);
        }
        throw new Error(`Expected numeric upstream constant, found ${unwrapped.getText(file)}.`);
    }

    public numericTuple(
        expression: ts.Expression,
        file: ts.SourceFile,
    ): [number, number, number] {
        const unwrapped = this.unwrapExpression(expression);
        if (!ts.isArrayLiteralExpression(unwrapped) || unwrapped.elements.length !== 3) {
            throw new Error(`Expected three-element upstream tuple, found ${unwrapped.getText(file)}.`);
        }
        return [
            this.numericValue(unwrapped.elements[0]!, file),
            this.numericValue(unwrapped.elements[1]!, file),
            this.numericValue(unwrapped.elements[2]!, file),
        ];
    }

    public extractNumber(source: string, pattern: RegExp, label: string): number {
        const match = source.match(pattern);
        if (!match?.[1]) throw new Error(`Unable to extract upstream ${label}.`);
        return Number(match[1]);
    }

    public floatLiteral(value: number): string {
        const text = String(value);
        return text.includes(".") || /e/i.test(text) ? `${text}f` : `${text}.0f`;
    }

    public cppColor3(values: [number, number, number]): string {
        return `Color3{${values.map((value) => this.floatLiteral(value)).join(", ")}}`;
    }

    private unwrapExpression(expression: ts.Expression): ts.Expression {
        let current = expression;
        while (
            ts.isAsExpression(current) ||
            ts.isTypeAssertionExpression(current) ||
            ts.isParenthesizedExpression(current) ||
            ts.isNonNullExpression(current)
        ) {
            current = current.expression;
        }
        return current;
    }
}
