import ts from "typescript";
import { UpstreamSourceStore } from "../upstream-source.js";
import {
    doubleLiteral as cppDoubleLiteral,
    floatLiteral as cppFloatLiteral,
} from "../cpp-literals.js";

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
        return (
            this.namedImport(modulePath, importedName) !== undefined
        );
    }
    /**
     * The declaration that brings a named import into a module.
     *
     * Shared because two questions are asked of it: whether a module imports
     * a symbol at all, and which module it comes from.
     */
    private namedImport(
        modulePath: string,
        importedName: string,
    ): ts.ImportDeclaration | undefined {
        return this.sourceFile(modulePath).statements.find(
            (statement): statement is ts.ImportDeclaration =>
                ts.isImportDeclaration(statement) &&
                statement.importClause?.namedBindings !== undefined &&
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

    /**
     * The module a named import comes from, as a store path.
     *
     * The pin splits a composer across modules — the sprite custom shader's
     * prologue lives in the pipeline module and its extra-texture bindings in
     * the shared custom-shader core — so following the import is what lets a
     * builder be read where the pin actually declares it rather than only
     * where it is called.
     */
    public moduleOfImport(
        modulePath: string,
        importedName: string,
    ): string | undefined {
        const declaration = this.namedImport(modulePath, importedName);
        if (
            !declaration ||
            !ts.isStringLiteral(declaration.moduleSpecifier)
        ) {
            return undefined;
        }
        return this.store.resolveImport(
            modulePath,
            declaration.moduleSpecifier.text,
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

    /**
     * A function-like the pin declares as a member of a module-level object,
     * by `object.member`.
     *
     * Several pinned extensions expose their contract that way — the
     * uv-transform extension's `writeUbo` is a method on the exported
     * `pbrExt` literal rather than a top-level declaration — so a lowerer
     * that walks pinned bodies has to reach both shapes. The body may be a
     * block or a single expression: a Standard extension states `_detect`
     * both ways, and a caller that needs a block says so itself.
     */
    public methodDeclaration(modulePath: string, path: string): {
        file: ts.SourceFile;
        declaration: ts.FunctionLikeDeclarationBase;
    } {
        const file = this.sourceFile(modulePath);
        const [objectName, memberName] = path.split(".");
        if (!objectName || !memberName) {
            this.contractError(
                file,
                `Expected an object member path such as 'pbrExt.writeUbo', ` +
                    `got '${path}'.`,
            );
        }
        let found: ts.FunctionLikeDeclarationBase | undefined;
        const visit = (node: ts.Node): void => {
            if (
                found === undefined &&
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === objectName &&
                node.initializer &&
                ts.isObjectLiteralExpression(node.initializer)
            ) {
                for (const property of node.initializer.properties) {
                    const named = property.name;
                    if (!named || !ts.isIdentifier(named)) continue;
                    if (named.text !== memberName) continue;
                    // `writeUbo(...) {}`, `writeUbo: (...) => {}` and
                    // `_detect: (mat) => (mat._x ? FLAG : 0)` all qualify.
                    const initializer = ts.isPropertyAssignment(property)
                        ? this.unwrapExpression(property.initializer)
                        : undefined;
                    const candidate = ts.isMethodDeclaration(property)
                        ? property
                        : initializer &&
                                (ts.isFunctionExpression(initializer) ||
                                    ts.isArrowFunction(initializer))
                            ? initializer
                            : undefined;
                    if (candidate?.body) {
                        found = candidate;
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
        if (!found) {
            this.contractError(
                file,
                `Expected '${path}' to be a function with a body.`,
            );
        }
        return { file, declaration: found };
    }

    /**
     * A function-like the pin assigns to a property of an object literal built
     * inside a named function.
     *
     * The light factories are shaped that way: `createPointLight` hands a
     * factory an object carrying `_writeLightUbo: (data, offset) => { ... }`, so
     * the writer is neither top-level nor a member of a module-level literal.
     * Searches the whole declaration, because which object literal holds it is
     * the pin's business rather than a contract worth pinning.
     */
    public propertyFunction(
        modulePath: string,
        functionName: string,
        propertyName: string,
    ): {
        file: ts.SourceFile;
        declaration: ts.FunctionLikeDeclarationBase & { body: ts.Block };
    } {
        const { file, declaration } = this.functionDeclaration(
            modulePath,
            functionName,
        );
        let found:
            | (ts.FunctionLikeDeclarationBase & { body: ts.Block })
            | undefined;
        const visit = (node: ts.Node): void => {
            if (found !== undefined) return;
            if (
                (ts.isPropertyAssignment(node) ||
                    ts.isMethodDeclaration(node)) &&
                node.name &&
                ts.isIdentifier(node.name) &&
                node.name.text === propertyName
            ) {
                const candidate = ts.isMethodDeclaration(node)
                    ? node
                    : ts.isFunctionExpression(node.initializer) ||
                            ts.isArrowFunction(node.initializer)
                        ? node.initializer
                        : undefined;
                if (candidate?.body && ts.isBlock(candidate.body)) {
                    found = candidate as ts.FunctionLikeDeclarationBase & {
                        body: ts.Block;
                    };
                    return;
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(declaration);
        if (!found) {
            this.contractError(
                declaration,
                `Expected '${functionName}' to build an object carrying ` +
                    `'${propertyName}' as a function with a body.`,
            );
        }
        return { file, declaration: found };
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

    /**
     * Whether an expression has the given shape, without failing when it
     * does not. `assertExpressionShape` answers "this expression is still
     * the pin's"; this answers "which of these expressions is the one I
     * mean", which is what a lowerer needs when the pinned body states a
     * contract several times over different operands and only the count
     * of matches is the contract.
     */
    public expressionMatchesShape(
        actual: ts.Expression,
        expectedSource: string,
    ): boolean {
        return (
            this.nodeFingerprint(actual) ===
            this.expectedFingerprint(expectedSource)
        );
    }

    /**
     * The fingerprint of an expected shape, parsed once per process: it is
     * a pure function of the string, and the shape helpers ask for the
     * same handful of strings across every scene compiled in one run.
     */
    private expectedFingerprint(expectedSource: string): string {
        const cached =
            LoweringContext.expectedFingerprints.get(
                expectedSource,
            );
        if (cached !== undefined) return cached;
        const expectedFile = ts.createSourceFile(
            "expected-expression.ts",
            `const expected = ${expectedSource};`,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const statement = expectedFile.statements[0];
        const declaration =
            statement && ts.isVariableStatement(statement)
                ? statement.declarationList.declarations[0]
                : undefined;
        if (!declaration?.initializer) {
            throw new Error(
                `Invalid expected expression '${expectedSource}'.`,
            );
        }
        const fingerprint = this.nodeFingerprint(
            declaration.initializer,
        );
        LoweringContext.expectedFingerprints.set(
            expectedSource,
            fingerprint,
        );
        return fingerprint;
    }

    private static readonly expectedFingerprints = new Map<
        string,
        string
    >();

    public assertExpressionShape(
        actual: ts.Expression,
        expectedSource: string,
        label: string,
    ): void {
        if (
            !this.expressionMatchesShape(
                actual,
                expectedSource,
            )
        ) {
            this.contractError(
                actual,
                `${label} changed; expected '${expectedSource}', found '${actual.getText(actual.getSourceFile())}'.`,
            );
        }
    }

    /**
     * The first call to `calleeName`, whether the pin writes it as a bare
     * function or as a method on something.
     *
     * Both spellings are the same fact to a caller asserting a contract --
     * `device.createRenderPipeline({...})` and `align4(x)` are each "the pin
     * calls this" -- and `hasCall` already answers the question that way, so
     * the two would otherwise disagree about what a call is.
     */
    public callExpression(
        declaration: ts.Node,
        calleeName: string,
    ): ts.CallExpression {
        let result: ts.CallExpression | undefined;
        const visit = (node: ts.Node): void => {
            if (
                !result &&
                ts.isCallExpression(node) &&
                ((ts.isIdentifier(node.expression) &&
                    node.expression.text === calleeName) ||
                    (ts.isPropertyAccessExpression(node.expression) &&
                        node.expression.name.text === calleeName))
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
        declaration: ts.Node,
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
        return cppFloatLiteral(value);
    }

    /**
     * The same constant where the pinned value is a JavaScript number the
     * generated code must reach at that precision — camera scalars, and any
     * term a pinned writer computes before its single `Float32Array` store.
     */
    public doubleLiteral(value: number): string {
        return cppDoubleLiteral(value);
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
