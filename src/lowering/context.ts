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

    /** Every `<target>[...] = ...` store inside a pinned writer, in order. */
    public pinnedElementStores(
        declaration: ts.Node,
        target: string,
    ): Array<{ left: ts.ElementAccessExpression; right: ts.Expression }> {
        return this.findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isElementAccessExpression(node.left) &&
                ts.isIdentifier(node.left.expression) &&
                node.left.expression.text === target,
        ).map((store) => {
            if (!ts.isElementAccessExpression(store.left)) {
                this.contractError(store, "Expected an element store.");
            }
            return { left: store.left, right: store.right };
        });
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
    /**
     * The mesh name a pinned factory finishes under.
     *
     * `createSphere(engine, options)` returns
     * `createMeshFromData(engine, "sphere", ...)`, and that literal is what
     * scene code finds the mesh by — so every emitter reads it from the
     * factory rather than restating it.
     */
    public pinnedFactoryMeshName(symbolName: string): string {
        const { declaration } = this.functionDeclaration(
            "src/mesh/mesh-factories.ts",
            symbolName,
        );
        const call = this.callExpression(
            declaration,
            "createMeshFromData",
        );
        const name = call.arguments[1]
            ? this.unwrapExpression(call.arguments[1])
            : undefined;
        return name && ts.isStringLiteral(name)
            ? name.text
            : this.contractError(
                  declaration,
                  `Expected ${symbolName} to pass its literal mesh name ` +
                      "to createMeshFromData.",
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
        declaration: ts.Node,
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
     * The count form of the contract above: the pinned body states the
     * shape `count` times, no more and no fewer. One home so every
     * lowerer counts the same way.
     */
    public expectShapeCount(
        root: ts.Node,
        expected: string,
        label: string,
        count = 1,
    ): void {
        const found = this.findNodes(
            root,
            (node): node is ts.Expression =>
                this.expressionMatchesShape(
                    node as ts.Expression,
                    expected,
                ),
        ).length;
        if (found !== count) {
            this.contractError(
                root,
                `Expected ${label} (${expected}) ${count} time(s), found ${found}.`,
            );
        }
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

    /**
     * The `createShaderMaterial({ ... })` argument a pinned factory passes.
     *
     * Two families fold such a factory (`createLineMaterial`,
     * `createLinearDepthMaterial`) and both start here, so the reach is
     * stated once rather than per lowerer.
     */
    public pinnedShaderMaterialCall(
        modulePath: string,
        factory: string,
    ): ts.ObjectLiteralExpression {
        return this.callObjectArgument(
            this.functionDeclaration(modulePath, factory).declaration,
            "createShaderMaterial",
        );
    }

    /**
     * A pinned array literal of string constants, in its own order.
     *
     * The peer of `numericTuple` for the lists a pinned factory writes --
     * a `ShaderMaterial`'s attributes, its system-uniform names -- read
     * through `stringValue` so a template literal is accepted where the
     * pin writes one.
     */
    public stringArrayValue(
        expression: ts.Expression,
        file: ts.SourceFile,
    ): string[] {
        const array = this.unwrapExpression(expression);
        if (!ts.isArrayLiteralExpression(array)) {
            this.contractError(
                expression,
                "Expected a static string array.",
            );
        }
        return array.elements.map((element) =>
            this.stringValue(element, file),
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
        if (ts.isIdentifier(unwrapped)) {
            const bound = this.moduleConstant(file, unwrapped.text);
            if (bound) return this.numericValue(bound.initializer, bound.file);
        }
        return this.contractError(
            unwrapped,
            `Expected numeric constant, found ${unwrapped.getText(file)}.`,
        );
    }

    /**
     * The module-scope `const` a pinned module declares under a name, or the
     * one it imports that name from.
     *
     * The pin names a value the moment a second module needs it — the HDR
     * loader's LOD generation scale became `HDR_LOD_GENERATION_SCALE` in the
     * pipeline module beside it — and a constant is no less a compile-time
     * constant for having a name. Reading it where the pin declares it keeps
     * the value the pin's; refusing the name instead would have to be
     * answered by restating the number here, which is the copy that drifts.
     *
     * An aliased import resolves to nothing rather than to a guess.
     */
    private moduleConstant(
        file: ts.SourceFile,
        name: string,
    ): { initializer: ts.Expression; file: ts.SourceFile } | undefined {
        const local = this.moduleScopeConstant(file, name);
        if (local) return { initializer: local, file };
        const declaringPath = this.moduleOfImport(file.fileName, name);
        if (!declaringPath) return undefined;
        const declaring = this.sourceFile(declaringPath);
        const initializer = this.moduleScopeConstant(declaring, name);
        return initializer
            ? { initializer, file: declaring }
            : undefined;
    }

    /**
     * The initializer of a module-scope `const` a pinned module declares.
     *
     * Two things narrow it, and both are the point. Only the file's own top
     * level is consulted, so a same-named local inside some function is a
     * different binding. And the declaration has to be `const`: the module
     * this rule first reached is the demonstration — `hdr-ibl-pipeline.ts`
     * declares `HDR_LOD_GENERATION_SCALE` on one line and a mutable
     * `let _prefilteredEnvironmentExtraUsage = 0` counter on the next, and a
     * scan that folded the second would bake a value the pin means to change.
     */
    public moduleScopeConstant(
        file: ts.SourceFile,
        name: string,
    ): ts.Expression | undefined {
        for (const statement of file.statements) {
            if (
                !ts.isVariableStatement(statement) ||
                (statement.declarationList.flags & ts.NodeFlags.Const) === 0
            ) {
                continue;
            }
            for (const declaration of statement.declarationList.declarations) {
                if (
                    ts.isIdentifier(declaration.name) &&
                    declaration.name.text === name &&
                    declaration.initializer
                ) {
                    return declaration.initializer;
                }
            }
        }
        return undefined;
    }

    /**
     * The initializer of a named property, wherever in a module it is
     * written.
     *
     * `moduleScopeConstant` reaches a top-level `const`; this reaches a
     * property of an object literal nested anywhere inside one — the shape
     * `spotSupport._create` returns, whose `_stride` decides a data layout
     * both sides of the port read. The first match wins, and a module that
     * declares the name twice is a contract error at the caller rather than
     * a silent choice here.
     */
    public namedPropertyInitializer(
        file: ts.SourceFile,
        name: string,
    ): ts.Expression | undefined {
        let found: ts.Expression | undefined;
        const visit = (node: ts.Node): void => {
            if (found) return;
            if (
                ts.isPropertyAssignment(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === name
            ) {
                found = node.initializer;
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
        return found;
    }

    /**
     * The two sides of a pinned `<left> ?? <right>` default.
     *
     * Every lowerer that anchors a pinned default splits this expression, and
     * each hand-rolled copy carries its own spelling of the same two tests.
     * `coalescedPropertyDefault` in the glTF lowerers is the specialization
     * that additionally names the property on the left; this is the general
     * form, for the defaults whose left side is a bare parameter.
     */
    public nullishDefault(
        expression: ts.Expression,
    ): { left: ts.Expression; right: ts.Expression } | undefined {
        const node = this.unwrapExpression(expression);
        if (
            !ts.isBinaryExpression(node) ||
            node.operatorToken.kind !==
                ts.SyntaxKind.QuestionQuestionToken
        ) {
            return undefined;
        }
        return { left: node.left, right: node.right };
    }

    /**
     * The interface a pinned module declares under a name.
     *
     * The peer of `functionDeclaration` for the contracts that are types
     * rather than bodies. A pinned options interface is the only description
     * of an object this port hands a pinned factory — the package's bundled
     * declarations do not carry the internal ones — so reading its members is
     * how a supplied bag is checked against what the pin reads.
     */
    public interfaceDeclaration(
        modulePath: string,
        name: string,
    ): { file: ts.SourceFile; declaration: ts.InterfaceDeclaration } {
        const file = this.sourceFile(modulePath);
        const declaration = file.statements.find(
            (statement): statement is ts.InterfaceDeclaration =>
                ts.isInterfaceDeclaration(statement) &&
                statement.name.text === name,
        );
        if (!declaration) {
            throw new Error(
                `${modulePath} no longer declares interface '${name}'.`,
            );
        }
        return { file, declaration };
    }

    /**
     * The keys this port supplies for a pinned options object, against the
     * members the pin declares for it.
     *
     * These bags are untyped on this side — their members are pinned values,
     * so the object crosses over as a `Record<string, unknown>` — which makes
     * a RENAME silent: the old key is ignored and the new one destructures to
     * its parameter default. 1.25.0 folded `createPbrComposer`'s
     * `_toneMappingHelpers`/`_toneMappingCall` into one `_tm` record and every
     * composed PBR fragment came out with no tone mapping and no exposure,
     * which nothing at generation could see.
     *
     * The rule is deliberately not set equality. A member the pin declares
     * OPTIONAL is one the caller may legitimately omit — the composer's own
     * `_tm` is optional, for a scene with tone mapping off — so what has to
     * hold is that every supplied key is declared, and every REQUIRED
     * declared key is supplied. An additive optional dependency upstream
     * therefore passes, and a renamed or dropped one fails naming it.
     */
    public assertSuppliedOptions(
        modulePath: string,
        interfaceName: string,
        supplied: readonly string[],
    ): void {
        const { declaration } = this.interfaceDeclaration(
            modulePath,
            interfaceName,
        );
        const members = declaration.members.flatMap((member) => {
            const key = member.name
                ? this.propertyName(member.name)
                : undefined;
            return key === undefined
                ? []
                : [{ key, required: member.questionToken === undefined }];
        });
        const declared = new Set(members.map(({ key }) => key));
        const missing = members
            .filter(({ key, required }) => required && !supplied.includes(key))
            .map(({ key }) => key);
        const unread = supplied.filter((key) => !declared.has(key));
        if (missing.length === 0 && unread.length === 0) return;
        this.contractError(
            declaration,
            `${interfaceName} declares [${[...declared].join(", ")}]; this ` +
                `port supplies [${[...supplied].sort().join(", ")}]. ` +
                (missing.length > 0
                    ? `Required but unsupplied: ${missing.join(", ")}. `
                    : "") +
                (unread.length > 0
                    ? `Supplied but undeclared: ${unread.join(", ")}. `
                    : "") +
                "A dependency the pin reads and this port does not supply " +
                "takes its default silently, which is why the key set is " +
                "checked rather than the values.",
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
