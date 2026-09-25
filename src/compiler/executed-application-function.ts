/**
 * An application function whose result generation needs, executed.
 *
 * A scene writes some of what the pin consumes as code rather than data: a
 * shader builder returning the WGSL a `createShaderMaterial` compiles
 * (`vertexSource(mode)`), a material plugin's `getCustomCode(shaderType)`
 * returning the WGSL it injects. The pin calls each once with values
 * generation already knows, so running the function IS the result -- the
 * text the browser compiles -- with no second reading of its branches.
 *
 * What runs is the function and exactly the declarations it reaches: the
 * module-scope `const`s and functions of its own file and of the repository
 * modules it imports, in source order, each file in a scope of its own;
 * bindings of an enclosing function the compiler folds to a value; and the
 * pin's `wgsl` tag, the executed pinned function. The rest of a scene module
 * (its imports of the engine, its `main()`) is never evaluated. It runs in a
 * fresh ECMAScript realm holding the language's own globals and nothing of
 * the host, so a function reaching a browser or engine API throws, and so
 * does any other reach this closure does not carry: every refusal names the
 * node that made it.
 *
 * The result must be plain data, compared through a JSON round trip, for
 * the reason the in-process module passes give: anything else is a value two
 * engines need not agree on.
 */
import { isDeepStrictEqual } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import {
    aliasTarget,
    CompilerSymbols,
    declarationOrigin,
    declaredSymbol,
} from "./symbols.js";
import { rootIdentifier, statementDeclaredNames } from "./syntax.js";
import { typeCanCarryReference } from "./type-facts.js";
import { writesThroughTrackedRoot } from "./user-functions.js";
import { pinnedModuleBinding } from "../lowering/pinned-shader-builders.js";
import { syntaxKindName } from "../source-location.js";
import { transpileCommonJs } from "../typescript-transpile.js";
import { sharedUpstreamStore } from "../upstream-source.js";

/** A value generation hands the function or binds to a name it closes over. */
export type ExecutedScalar = string | number | boolean;

interface ExecutedFunctionContext {
    readonly checker: ts.TypeChecker;
    fail(node: ts.Node, message: string): never;
    /**
     * The generation-known value of a binding the function closes over from
     * an enclosing function, or undefined when the compiler cannot fold it.
     */
    foldEnclosing(identifier: ts.Identifier): ExecutedScalar | undefined;
}

/** The pinned imports an executed closure may reach, by imported name. */
const pinnedTags: ReadonlySet<string> = new Set(["wgsl"]);

/** Where a name one file part imports is bound from. */
type ImportSource =
    | { kind: "pinned"; name: string }
    | { kind: "sibling"; file: ts.SourceFile; name: string };

/** The declarations one file contributes to the executed closure. */
interface FilePart {
    index: number;
    statements: Set<ts.Statement>;
    imports: Map<string, ImportSource>;
}

/** A function-like node the closure can call as a value. */
type ExecutedTarget = ts.FunctionLikeDeclaration;

/**
 * Execute `target` with `args` and return its plain-data result. `label`
 * names the function in refusals.
 */
export function executeApplicationFunction(
    context: ExecutedFunctionContext,
    target: ExecutedTarget,
    args: readonly (ExecutedScalar | undefined)[],
    label: string,
): unknown {
    const closure = new ExecutedClosure(context, target, label);
    const program = closure.program();
    const realm = vm.createContext(
        {},
        {
            name: `generation function ${label}`,
            microtaskMode: "afterEvaluate",
        },
    );
    const parse: unknown = vm.runInContext("JSON.parse", realm);
    if (typeof parse !== "function") {
        throw new Error("A generation function realm has no JSON.parse.");
    }
    let result: unknown;
    try {
        const build: unknown = vm.runInContext(program.javascript, realm, {
            filename: target.getSourceFile().fileName,
        });
        if (typeof build !== "function") {
            throw new Error(
                "The executed closure did not compile to a function.",
            );
        }
        const executed: unknown = Reflect.apply(build, undefined, [
            program.bindings,
        ]);
        if (typeof executed !== "function") {
            throw new Error(`${label} is not a function once executed.`);
        }
        result = Reflect.apply(executed, undefined, [...args]);
    } catch (error: unknown) {
        return context.fail(
            target,
            `${label} threw at generation: ${errorMessage(error)}`,
        );
    }
    let text: string | undefined;
    try {
        text = JSON.stringify(result);
    } catch (error: unknown) {
        return context.fail(
            target,
            `${label} returned a value with no JSON form: ${errorMessage(error)}`,
        );
    }
    if (
        text === undefined ||
        !isDeepStrictEqual(Reflect.apply(parse, undefined, [text]), result)
    ) {
        return context.fail(
            target,
            `${label} returned a value that is not plain data, which ` +
                "generation cannot carry.",
        );
    }
    const value: unknown = JSON.parse(text);
    return value;
}

function errorMessage(error: unknown): string {
    return typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
        ? error.message
        : String(error);
}

/** The node's declared name, when it is a declaration's own name. */
function isDeclaredName(identifier: ts.Identifier): boolean {
    const parent = identifier.parent;
    return (
        (ts.isVariableDeclaration(parent) ||
            ts.isParameter(parent) ||
            ts.isFunctionDeclaration(parent) ||
            ts.isFunctionExpression(parent) ||
            ts.isClassDeclaration(parent) ||
            ts.isClassExpression(parent) ||
            ts.isBindingElement(parent) ||
            ts.isPropertyAssignment(parent) ||
            ts.isPropertyDeclaration(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isGetAccessorDeclaration(parent) ||
            ts.isSetAccessorDeclaration(parent) ||
            ts.isEnumMember(parent)) &&
        parent.name === identifier
    );
}

/** Whether an identifier names a member or a label rather than a binding. */
function isNonReference(identifier: ts.Identifier): boolean {
    const parent = identifier.parent;
    return (
        isDeclaredName(identifier) ||
        (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
        (ts.isBindingElement(parent) && parent.propertyName === identifier) ||
        ((ts.isLabeledStatement(parent) ||
            ts.isBreakStatement(parent) ||
            ts.isContinueStatement(parent)) &&
            parent.label === identifier)
    );
}

function contains(outer: ts.Node, inner: ts.Node): boolean {
    return (
        outer.getSourceFile() === inner.getSourceFile() &&
        inner.pos >= outer.pos &&
        inner.end <= outer.end
    );
}

/** The top-level statement declaring `declaration`, when it is module scope. */
function moduleScopeStatement(
    declaration: ts.Declaration,
): ts.Statement | undefined {
    if (ts.isFunctionDeclaration(declaration)) {
        return ts.isSourceFile(declaration.parent) ? declaration : undefined;
    }
    let node: ts.Node = declaration;
    while (
        ts.isBindingElement(node) ||
        ts.isArrayBindingPattern(node) ||
        ts.isObjectBindingPattern(node)
    ) {
        node = node.parent;
    }
    if (
        ts.isVariableDeclaration(node) &&
        ts.isVariableDeclarationList(node.parent) &&
        ts.isVariableStatement(node.parent.parent) &&
        ts.isSourceFile(node.parent.parent.parent)
    ) {
        return node.parent.parent;
    }
    if (
        (ts.isClassDeclaration(declaration) ||
            ts.isEnumDeclaration(declaration)) &&
        ts.isSourceFile(declaration.parent)
    ) {
        return declaration;
    }
    return undefined;
}

/** The names a closure statement binds in its file's scope. */
function declaredNames(statement: ts.Statement): string[] {
    return statementDeclaredNames(statement).map((name) => name.text);
}

/** The analysis of one execution: what runs, and the text that runs it. */
class ExecutedClosure {
    private readonly symbols: CompilerSymbols;
    /** @unjournaled Scratch of one execution's analysis, discarded with it. */
    private readonly parts = new Map<ts.SourceFile, FilePart>();
    /** @unjournaled Scratch of one execution's analysis, discarded with it. */
    private readonly enclosing = new Map<
        string,
        { declaration: ts.Declaration; value: ExecutedScalar }
    >();
    /** @unjournaled Scratch of one execution's analysis, discarded with it. */
    private readonly queue: Array<{ root: ts.Node; file: ts.SourceFile }> = [];

    public constructor(
        private readonly context: ExecutedFunctionContext,
        private readonly target: ExecutedTarget,
        private readonly label: string,
    ) {
        this.symbols = new CompilerSymbols(context.checker);
    }

    public program(): { javascript: string; bindings: object } {
        const targetFile = this.target.getSourceFile();
        const targetStatement =
            ts.isFunctionDeclaration(this.target) &&
            ts.isSourceFile(this.target.parent)
                ? this.target
                : undefined;
        this.part(targetFile);
        if (targetStatement) {
            this.include(targetStatement);
        } else {
            this.queue.push({ root: this.target, file: targetFile });
        }
        for (let next = this.queue.shift(); next; next = this.queue.shift()) {
            this.walk(next.root, next.file);
        }
        const pinned: Record<string, unknown> = {};
        const enclosing: Record<string, ExecutedScalar> = {};
        for (const [name, { value }] of this.enclosing) enclosing[name] = value;
        const files: string[] = [];
        for (const [file, part] of this.parts) {
            const prologue: string[] = [];
            for (const [local, source] of part.imports) {
                if (source.kind === "pinned") {
                    pinned[source.name] = pinnedExport(source.name);
                    prologue.push(
                        `const ${local} = __bblBindings.pinned[${JSON.stringify(source.name)}];`,
                    );
                } else {
                    const sibling = this.parts.get(source.file)!;
                    prologue.push(
                        `const ${local} = __bblScope(${sibling.index})[${JSON.stringify(source.name)}];`,
                    );
                }
            }
            const statements = [...part.statements].sort(
                (left, right) => left.pos - right.pos,
            );
            const names = statements.flatMap(declaredNames);
            const body = statements.map((statement) =>
                this.statementText(statement),
            );
            if (file === targetFile && !targetStatement) {
                const bound = [...this.enclosing.keys()];
                body.push(
                    `const __bblTarget = ((${bound.join(", ")}) => (${this.targetExpression()}))(${bound
                        .map(
                            (name) =>
                                `__bblBindings.enclosing[${JSON.stringify(name)}]`,
                        )
                        .join(", ")});`,
                );
                names.push("__bblTarget");
            }
            files[part.index] =
                `function __bblFile${part.index}() {\n${[...prologue, ...body].join("\n")}\nreturn { ${names.join(", ")} };\n}`;
        }
        const root = targetStatement
            ? JSON.stringify(targetStatement.name!.text)
            : JSON.stringify("__bblTarget");
        const source = `(function (__bblBindings) {
"use strict";
const __bblFiles = [${files.map((_file, index) => `__bblFile${index}`).join(", ")}];
const __bblScopes = [];
function __bblScope(index) {
    if (__bblScopes[index] === null) throw new Error("A generation closure's modules import each other in a cycle.");
    if (__bblScopes[index] === undefined) {
        __bblScopes[index] = null;
        __bblScopes[index] = __bblFiles[index]();
    }
    return __bblScopes[index];
}
${files.join("\n")}
return __bblScope(${this.parts.get(targetFile)!.index})[${root}];
})`;
        return {
            javascript: transpileCommonJs(
                source,
                `${targetFile.fileName}.executed.ts`,
            ),
            bindings: { pinned, enclosing },
        };
    }

    private part(file: ts.SourceFile): FilePart {
        let part = this.parts.get(file);
        if (!part) {
            part = {
                index: this.parts.size,
                statements: new Set(),
                imports: new Map(),
            };
            this.parts.set(file, part);
        }
        return part;
    }

    private include(statement: ts.Statement): void {
        const part = this.part(statement.getSourceFile());
        if (part.statements.has(statement)) return;
        if (
            ts.isClassDeclaration(statement) ||
            ts.isEnumDeclaration(statement)
        ) {
            this.context.fail(
                statement,
                `${this.label} reaches a module-scope ${ts.isClassDeclaration(statement) ? "class" : "enum"}, which a generation closure does not carry.`,
            );
        }
        if (
            ts.isVariableStatement(statement) &&
            (statement.declarationList.flags & ts.NodeFlags.Const) === 0
        ) {
            this.context.fail(
                statement,
                `${this.label} reads a module-scope 'let' or 'var', which the scene may reassign after generation ran it.`,
            );
        }
        part.statements.add(statement);
        this.queue.push({ root: statement, file: statement.getSourceFile() });
    }

    /** Every binding `root` reaches, resolved into the closure or refused. */
    private walk(root: ts.Node, file: ts.SourceFile): void {
        const isTargetWalk = root === this.target;
        forEachAnalysisNode(
            root,
            (node) => {
                if (
                    node.kind === ts.SyntaxKind.ThisKeyword ||
                    node.kind === ts.SyntaxKind.SuperKeyword
                ) {
                    this.context.fail(
                        node,
                        `${this.label} reads '${node.getText()}', which a function executed alone does not have.`,
                    );
                }
                if (
                    writesThroughTrackedRoot(node, (expression) => {
                        const identifier = rootIdentifier(expression);
                        return (
                            identifier !== undefined &&
                            this.namesClosureBinding(identifier, root)
                        );
                    })
                ) {
                    this.context.fail(
                        node,
                        `${this.label} writes a module-scope binding, so one execution would not describe every call.`,
                    );
                }
                if (ts.isIdentifier(node) && !isNonReference(node)) {
                    this.resolve(node, root, file, isTargetWalk);
                }
            },
            { types: "skip", skip: ts.isTypeAliasDeclaration },
        );
    }

    /**
     * Whether an identifier names a binding outside `root` (module scope or
     * an enclosing function) that a write could reach: a primitive has no
     * state a method call could change.
     */
    private namesClosureBinding(
        identifier: ts.Identifier,
        root: ts.Node,
    ): boolean {
        const checker = this.context.checker;
        // The binding in scope where the write is: its declaration, an
        // import's own specifier included, is what lies outside `root`.
        const symbol = declaredSymbol(checker, identifier);
        const declaration = symbol?.declarations?.[0];
        return (
            declaration !== undefined &&
            !contains(root, declaration) &&
            declarationOrigin(declaration) === "program" &&
            typeCanCarryReference(checker.getTypeAtLocation(identifier))
        );
    }

    private resolve(
        identifier: ts.Identifier,
        root: ts.Node,
        file: ts.SourceFile,
        isTargetWalk: boolean,
    ): void {
        const checker = this.context.checker;
        const symbol = declaredSymbol(checker, identifier);
        if (!symbol) {
            if (identifier.text === "undefined") return;
            this.context.fail(
                identifier,
                `${this.label} reads '${identifier.text}', which resolves to no declaration.`,
            );
        }
        if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
            this.resolveImport(identifier, symbol, file);
            return;
        }
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
        if (!declaration && identifier.text === "undefined") return;
        if (!declaration) {
            this.context.fail(
                identifier,
                `${this.label} reads '${identifier.text}', which has no value declaration.`,
            );
        }
        const origin = declarationOrigin(declaration);
        if (origin === "default-lib") return;
        if (
            origin !== "program" ||
            declaration.getSourceFile().isDeclarationFile
        ) {
            this.context.fail(
                identifier,
                `${this.label} reads '${identifier.text}' from the ${origin === "babylon" ? "pinned engine" : "host"}, which generation does not run.`,
            );
        }
        if (contains(root, declaration)) return;
        const statement = moduleScopeStatement(declaration);
        if (statement) {
            if (statement.getSourceFile() !== file) {
                this.context.fail(
                    identifier,
                    `${this.label} reads '${identifier.text}' from another module without importing it.`,
                );
            }
            this.include(statement);
            return;
        }
        if (!isTargetWalk) {
            this.context.fail(
                identifier,
                `${this.label} reaches '${identifier.text}', a binding no module scope carries.`,
            );
        }
        const known = this.enclosing.get(identifier.text);
        if (known) {
            if (known.declaration !== declaration) {
                this.context.fail(
                    identifier,
                    `${this.label} closes over two bindings named '${identifier.text}'.`,
                );
            }
            return;
        }
        const value = this.context.foldEnclosing(identifier);
        if (value === undefined) {
            this.context.fail(
                identifier,
                `${this.label} closes over '${identifier.text}', whose value generation does not know.`,
            );
        }
        this.enclosing.set(identifier.text, { declaration, value });
    }

    private resolveImport(
        identifier: ts.Identifier,
        symbol: ts.Symbol,
        file: ts.SourceFile,
    ): void {
        const part = this.part(file);
        if (part.imports.has(identifier.text)) return;
        const pinned = this.symbols.babylonImportName(identifier);
        if (pinned !== undefined) {
            if (!pinnedTags.has(pinned)) {
                this.context.fail(
                    identifier,
                    `${this.label} reaches pinned '${pinned}', which generation does not run; only the ${[...pinnedTags].join(", ")} tag executes with it.`,
                );
            }
            part.imports.set(identifier.text, { kind: "pinned", name: pinned });
            return;
        }
        const specifier = symbol.declarations?.find(ts.isImportSpecifier);
        const imported = aliasTarget(this.context.checker, symbol);
        const declaration =
            imported.valueDeclaration ?? imported.declarations?.[0];
        const statement = declaration && moduleScopeStatement(declaration);
        if (!specifier || !declaration || !statement) {
            this.context.fail(
                identifier,
                `${this.label} imports '${identifier.text}' in a form a generation closure does not carry (a named import of a module-scope const or function).`,
            );
        }
        if (declarationOrigin(declaration) !== "program") {
            this.context.fail(
                identifier,
                `${this.label} imports '${identifier.text}' from outside the repository.`,
            );
        }
        const sibling = statement.getSourceFile();
        const name = declaredNames(statement).find(
            (candidate) =>
                candidate === (specifier.propertyName ?? specifier.name).text,
        );
        if (name === undefined) {
            this.context.fail(
                identifier,
                `${this.label} imports '${identifier.text}' through a re-export, which a generation closure does not follow.`,
            );
        }
        this.part(sibling);
        this.include(statement);
        part.imports.set(identifier.text, {
            kind: "sibling",
            file: sibling,
            name,
        });
    }

    /** A module-scope statement's own text, without its `export` keyword. */
    private statementText(statement: ts.Statement): string {
        const file = statement.getSourceFile();
        const modifiers = ts.canHaveModifiers(statement)
            ? ts.getModifiers(statement)
            : undefined;
        if (
            modifiers?.some(
                (modifier) =>
                    modifier.kind === ts.SyntaxKind.DefaultKeyword ||
                    modifier.kind === ts.SyntaxKind.DeclareKeyword,
            )
        ) {
            return this.context.fail(
                statement,
                `${this.label} reaches a default or ambient declaration, which a generation closure does not carry.`,
            );
        }
        const exported = modifiers?.find(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        );
        return file.text.slice(
            exported ? exported.end : statement.getStart(file),
            statement.end,
        );
    }

    /** The target as an expression of its own file's scope. */
    private targetExpression(): string {
        const target = this.target;
        const file = target.getSourceFile();
        const text = file.text.slice(target.getStart(file), target.end);
        if (ts.isArrowFunction(target) || ts.isFunctionExpression(target)) {
            return text;
        }
        if (ts.isFunctionDeclaration(target)) return `(${text})`;
        if (
            ts.isMethodDeclaration(target) &&
            ts.isObjectLiteralExpression(target.parent) &&
            (ts.isIdentifier(target.name) || ts.isStringLiteral(target.name))
        ) {
            return `({ ${text} })[${JSON.stringify(target.name.text)}]`;
        }
        return this.context.fail(
            target,
            `${this.label} is a ${syntaxKindName(target.kind)}, which generation does not execute alone.`,
        );
    }
}

/** A pinned public export, loaded from the packaged module that declares it. */
function pinnedExport(name: string): unknown {
    const exported = sharedUpstreamStore().resolvePublicExport(name);
    return pinnedModuleBinding(exported.modulePath, exported.importedName);
}
