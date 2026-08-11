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
        return this.store.getSourceFile(modulePath);
    }

    public contractError(
        node: ts.Node,
        message: string,
    ): never {
        const file = node.getSourceFile();
        const position = file.getLineAndCharacterOfPosition(
            node.getStart(file, false),
        );
        throw new Error(
            `${file.fileName}:${position.line + 1}:${position.character + 1}: ${message}`,
        );
    }

    public hasNode(
        root: ts.Node,
        predicate: (node: ts.Node) => boolean,
    ): boolean {
        let found = false;
        const visit = (node: ts.Node): void => {
            if (found) {
                return;
            }
            if (predicate(node)) {
                found = true;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(root);
        return found;
    }

    public countNodes(
        root: ts.Node,
        predicate: (node: ts.Node) => boolean,
    ): number {
        let count = 0;
        const visit = (node: ts.Node): void => {
            if (predicate(node)) {
                count += 1;
            }
            ts.forEachChild(node, visit);
        };
        visit(root);
        return count;
    }

    public findNodes<T extends ts.Node>(
        root: ts.Node,
        predicate: (node: ts.Node) => node is T,
    ): T[] {
        const result: T[] = [];
        const visit = (node: ts.Node): void => {
            if (predicate(node)) {
                result.push(node);
            }
            ts.forEachChild(node, visit);
        };
        visit(root);
        return result;
    }

    public propertyName(
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

    public hasNamedImport(
        modulePath: string,
        importedName: string,
    ): boolean {
        return this.sourceFile(modulePath).statements.some(
            (statement) =>
                ts.isImportDeclaration(statement) &&
                statement.importClause?.namedBindings &&
                ts.isNamedImports(
                    statement.importClause.namedBindings,
                ) &&
                statement.importClause.namedBindings.elements.some(
                    (element) =>
                        (element.propertyName?.text ??
                            element.name.text) === importedName,
                ),
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
        if (!declaration?.body) {
            this.contractError(
                file,
                `Expected function '${symbolName}' with a body.`,
            );
        }
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
                node.initializer
            ) {
                const initializer = this.unwrapExpression(
                    node.initializer,
                );
                if (ts.isObjectLiteralExpression(initializer)) {
                    object = initializer;
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration);
        if (!object) {
            this.contractError(
                declaration,
                `Expected variable '${variableName}' with an object-literal initializer.`,
            );
        }
        return object;
    }

    public variableInitializer(
        declaration: ts.Node,
        variableName: string,
    ): ts.Expression {
        let initializer: ts.Expression | undefined;
        const visit = (node: ts.Node): void => {
            if (
                !initializer &&
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === variableName &&
                node.initializer
            ) {
                initializer = node.initializer;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration);
        if (!initializer) {
            this.contractError(
                declaration,
                `Expected variable '${variableName}' with an initializer.`,
            );
        }
        return initializer;
    }

    public returnObject(
        declaration: ts.FunctionDeclaration,
    ): ts.ObjectLiteralExpression {
        let object: ts.ObjectLiteralExpression | undefined;
        const visit = (node: ts.Node): void => {
            if (
                !object &&
                ts.isReturnStatement(node) &&
                node.expression
            ) {
                const expression = this.unwrapExpression(
                    node.expression,
                );
                if (ts.isObjectLiteralExpression(expression)) {
                    object = expression;
                    return;
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration);
        if (!object) {
            this.contractError(
                declaration,
                "Expected an object-literal return value.",
            );
        }
        return object;
    }

    public propertyPath(
        expression: ts.Expression,
    ): string[] | undefined {
        const unwrapped = this.unwrapExpression(expression);
        if (ts.isIdentifier(unwrapped)) {
            return [unwrapped.text];
        }
        if (ts.isPropertyAccessExpression(unwrapped)) {
            const owner = this.propertyPath(
                unwrapped.expression,
            );
            return owner
                ? [...owner, unwrapped.name.text]
                : undefined;
        }
        return undefined;
    }

    public assertExpressionShape(
        actual: ts.Expression,
        expectedSource: string,
        label: string,
    ): void {
        const expectedFile = ts.createSourceFile(
            "expected-expression.ts",
            `const expected = ${expectedSource};`,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const statement = expectedFile.statements[0];
        const declaration =
            statement &&
            ts.isVariableStatement(statement)
                ? statement.declarationList.declarations[0]
                : undefined;
        if (!declaration?.initializer) {
            throw new Error(
                `Invalid expected expression for ${label}.`,
            );
        }
        const actualFingerprint =
            this.nodeFingerprint(actual);
        const expectedFingerprint =
            this.nodeFingerprint(declaration.initializer);
        if (actualFingerprint !== expectedFingerprint) {
            this.contractError(
                actual,
                `${label} changed; expected '${expectedSource}', found '${actual.getText(actual.getSourceFile())}'.`,
            );
        }
    }

    public callExpression(
        declaration: ts.FunctionDeclaration,
        calleeName: string,
    ): ts.CallExpression {
        let result: ts.CallExpression | undefined;
        const visit = (node: ts.Node): void => {
            if (
                !result &&
                ts.isCallExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === calleeName
            ) {
                result = node;
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration);
        if (!result) {
            this.contractError(
                declaration,
                `Expected call '${calleeName}'.`,
            );
        }
        return result;
    }

    public callObjectArgument(
        declaration: ts.FunctionDeclaration,
        calleeName: string,
        argumentIndex = 0,
    ): ts.ObjectLiteralExpression {
        const argument =
            this.callExpression(declaration, calleeName)
                .arguments[argumentIndex];
        if (!argument || !ts.isObjectLiteralExpression(argument)) {
            this.contractError(
                argument ?? declaration,
                `Expected call '${calleeName}' argument ${argumentIndex} to be an object literal.`,
            );
        }
        return argument;
    }

    public hasCall(
        declaration: ts.FunctionDeclaration,
        calleeName: string,
    ): boolean {
        return this.hasNode(
            declaration,
            (node) =>
                ts.isCallExpression(node) &&
                ((ts.isIdentifier(node.expression) &&
                    node.expression.text === calleeName) ||
                    (ts.isPropertyAccessExpression(
                        node.expression,
                    ) &&
                        node.expression.name.text ===
                            calleeName)),
        );
    }

    public stringValue(
        expression: ts.Expression,
        file: ts.SourceFile,
    ): string {
        const unwrapped = this.unwrapExpression(expression);
        if (
            ts.isStringLiteral(unwrapped) ||
            ts.isNoSubstitutionTemplateLiteral(unwrapped)
        ) {
            return unwrapped.text;
        }
        return this.contractError(
            unwrapped,
            `Expected string constant, found ${unwrapped.getText(file)}.`,
        );
    }

    public isNumberMaxValue(expression: ts.Expression): boolean {
        const unwrapped = this.unwrapExpression(expression);
        return (
            ts.isPropertyAccessExpression(unwrapped) &&
            ts.isIdentifier(unwrapped.expression) &&
            unwrapped.expression.text === "Number" &&
            unwrapped.name.text === "MAX_VALUE"
        );
    }

    public propertyInitializer(object: ts.ObjectLiteralExpression, name: string): ts.Expression {
        const property = object.properties.find(
            (candidate) =>
                (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
                ts.isIdentifier(candidate.name) &&
                candidate.name.text === name,
        );
        if (!property) {
            this.contractError(
                object,
                `Expected object property '${name}'.`,
            );
        }
        if (ts.isPropertyAssignment(property)) return property.initializer;
        if (ts.isShorthandPropertyAssignment(property)) return property.name;
        return this.contractError(
            property,
            `Expected object property '${name}'.`,
        );
    }

    public numericValue(expression: ts.Expression, file: ts.SourceFile): number {
        const unwrapped = this.unwrapExpression(expression);
        if (ts.isNumericLiteral(unwrapped)) return Number(unwrapped.text);
        if (ts.isPrefixUnaryExpression(unwrapped) && unwrapped.operator === ts.SyntaxKind.MinusToken) {
            return -this.numericValue(unwrapped.operand, file);
        }
        return this.contractError(
            unwrapped,
            `Expected numeric constant, found ${unwrapped.getText(file)}.`,
        );
    }

    public numericTuple(
        expression: ts.Expression,
        file: ts.SourceFile,
    ): [number, number, number] {
        const unwrapped = this.unwrapExpression(expression);
        if (!ts.isArrayLiteralExpression(unwrapped) || unwrapped.elements.length !== 3) {
            return this.contractError(
                unwrapped,
                `Expected three-element tuple, found ${unwrapped.getText(file)}.`,
            );
        }
        return [
            this.numericValue(unwrapped.elements[0]!, file),
            this.numericValue(unwrapped.elements[1]!, file),
            this.numericValue(unwrapped.elements[2]!, file),
        ];
    }

    public floatLiteral(value: number): string {
        const text = String(value);
        return text.includes(".") || /e/i.test(text) ? `${text}f` : `${text}.0f`;
    }

    public cppColor3(values: [number, number, number]): string {
        return `Color3{${values.map((value) => this.floatLiteral(value)).join(", ")}}`;
    }

    public unwrapExpression(expression: ts.Expression): ts.Expression {
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

    private nodeFingerprint(node: ts.Node): string {
        if (
            ts.isAsExpression(node) ||
            ts.isTypeAssertionExpression(node) ||
            ts.isParenthesizedExpression(node) ||
            ts.isNonNullExpression(node)
        ) {
            return this.nodeFingerprint(node.expression);
        }
        if (ts.isIdentifier(node)) {
            return `identifier:${node.text}`;
        }
        if (ts.isNumericLiteral(node)) {
            return `number:${Number(node.text)}`;
        }
        if (
            ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node)
        ) {
            return `string:${node.text}`;
        }
        const children = node.getChildren(
            node.getSourceFile(),
        ).filter(
            (child) =>
                child.kind !== ts.SyntaxKind.CommaToken &&
                child.kind !== ts.SyntaxKind.SemicolonToken,
        );
        if (children.length === 0) {
            return ts.SyntaxKind[node.kind];
        }
        return `${ts.SyntaxKind[node.kind]}(${children
            .map((child) => this.nodeFingerprint(child))
            .join(",")})`;
    }
}
