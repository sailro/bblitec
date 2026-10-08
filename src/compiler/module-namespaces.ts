import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import type { DataType } from "./data-types/model.js";
import { aliasTarget, declaredIn, declaredSymbol } from "./symbols.js";
import { unwrapExpression } from "./syntax.js";
import { staticNumberValue } from "./option-helpers.js";
import { someAnalysisNode } from "./analysis-walk.js";
import { EmissionMap } from "./emission-transaction.js";
import { emitReachableStatements } from "./loop-control.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import {
    isModuleInitializerStatement,
    planEntryModuleState,
    runtimeModuleDependencies,
} from "./module-initializers.js";

/** A reached lazy module needs its lexical homes before entry emission. */
export class ModuleActivationRequired extends Error {
    public constructor(readonly file: ts.SourceFile) {
        super("A lazy module requires retained activation storage.");
    }
}

/** Omitted evaluation must terminate without allocating mutable module state. */
function isTotalDefinition(expression: ts.Expression): boolean {
    const node = unwrapExpression(expression);
    if (
        (ts.isLiteralExpression(node) &&
            !ts.isRegularExpressionLiteral(node)) ||
        node.kind === ts.SyntaxKind.TrueKeyword ||
        node.kind === ts.SyntaxKind.FalseKeyword ||
        node.kind === ts.SyntaxKind.NullKeyword ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node)
    )
        return true;
    if (ts.isPrefixUnaryExpression(node))
        return ts.isNumericLiteral(unwrapExpression(node.operand));
    return false;
}

/** Finite module identities transport independently of their live export bindings. */
export class ModuleNamespaces {
    /** @unjournaled Immutable source graph, independent of emission and bindings. */
    private staticModules: ReadonlySet<ts.SourceFile> | undefined;
    /** @unjournaled Sorted exports and their symbols are immutable checker facts. */
    private readonly exportsByModule = new Map<
        string,
        ReadonlyMap<string, ts.Symbol>
    >();
    private readonly activations = new EmissionMap<
        ts.SourceFile,
        { cpp: string; prefix: string }
    >();

    public constructor(private readonly context: LoweringServices) {}

    private evaluatedModules(): ReadonlySet<ts.SourceFile> {
        if (!this.staticModules) {
            const modules = new Set<ts.SourceFile>();
            const visit = (file: ts.SourceFile): void => {
                if (modules.has(file)) return;
                modules.add(file);
                runtimeModuleDependencies(this.context.checker, file).forEach(
                    visit,
                );
            };
            visit(this.context.sourceFile);
            this.staticModules = modules;
        }
        return this.staticModules;
    }

    /** Allocate shared homes without running any authored initializer. */
    public prepare(required: ReadonlySet<ts.SourceFile>): void {
        const context = this.context;
        const visit = (file: ts.SourceFile): void => {
            if (this.evaluatedModules().has(file) || this.activations.has(file))
                return;
            if (file.isDeclarationFile) {
                if (
                    declaredIn(declaredSymbol(context.checker, file), "babylon")
                )
                    return;
                return context.fail(
                    file,
                    "Dynamic import of a declaration-only module has no native implementation.",
                );
            }
            const cpp = context.allocateTemporaryCppName("module_activation");
            this.activations.set(file, {
                cpp,
                prefix: `lazy_module${this.activations.size}_`,
            });
            for (const dependency of runtimeModuleDependencies(
                context.checker,
                file,
            )) {
                if (dependency === context.sourceFile)
                    context.fail(
                        file,
                        "Lazy dependencies on the entry require shared entry module storage.",
                    );
                visit(dependency);
            }
        };
        required.forEach(visit);
        for (const [file, { cpp }] of this.activations) {
            context.reachJsData();
            context.emit({
                kind: "declaration",
                type: "auto",
                name: cpp,
                initializer: `bbl::js::make_gc_shared<bbl::js::ModuleActivation>(${context.cppString(file.fileName)})`,
            });
            context.registerNativeBinding(
                cpp,
                false,
                false,
                "std::shared_ptr<bbl::js::ModuleActivation>",
            );
        }
        for (const [file, { prefix }] of this.activations) {
            context.bindings.pushScope(prefix);
            const scope = context.bindings.variableScopes.at(-1)!;
            try {
                for (const statement of file.statements) {
                    if (ts.isVariableStatement(statement)) {
                        for (const declaration of statement.declarationList
                            .declarations)
                            context.declarations.prepareModuleBinding(
                                declaration,
                            );
                    } else if (
                        ts.isModuleDeclaration(statement) ||
                        ts.isClassDeclaration(statement)
                    )
                        context.fail(
                            statement,
                            "Lazy namespace/class evaluation requires represented module storage.",
                        );
                    if (
                        ts.isEnumDeclaration(statement) &&
                        statement.members.some(
                            (member) =>
                                context.checker.getConstantValue(member) ===
                                undefined,
                        )
                    )
                        context.fail(
                            statement,
                            "Lazy enum evaluation requires represented module storage.",
                        );
                    if (
                        someAnalysisNode(statement, ts.isAwaitExpression, {
                            functions: "skip",
                        })
                    )
                        context.fail(
                            statement,
                            "Top-level await in a lazy module requires asynchronous module activation.",
                        );
                }
            } finally {
                const root = context.bindings.variableScopes[0]!;
                for (const [symbol, binding] of scope)
                    root.set(symbol, binding);
                context.bindings.popScope();
            }
        }
    }

    /** Initializer closures share predeclared homes, including cyclic dependencies. */
    public defineInitializers(): void {
        const context = this.context;
        for (const [file, { cpp, prefix }] of this.activations) {
            context.bindings.pushScope(prefix);
            try {
                const closure = context.captureManagedClosureLines(() => {
                    context.beginNativeFunctionBody(undefined, true);
                    try {
                        for (const dependency of runtimeModuleDependencies(
                            context.checker,
                            file,
                        )) {
                            const activation = this.activations.get(dependency);
                            if (!activation) continue;
                            context.useNativeValue({
                                kind: "void",
                                cpp: activation.cpp,
                            });
                            context.emit({
                                kind: "expression",
                                code: `${activation.cpp}->evaluate();`,
                            });
                        }
                        emitReachableStatements(
                            context,
                            file.statements.filter((statement) =>
                                isModuleInitializerStatement(
                                    statement,
                                    context.checker,
                                ),
                            ),
                        );
                    } finally {
                        context.endNativeFunctionBody();
                    }
                });
                context.emit({
                    kind: "expression",
                    code: `${cpp}->set_initializer(${context.nativeEmission.renderSharedClosure(closure, "void", file, "", [])});`,
                });
            } finally {
                context.bindings.popScope();
            }
        }
    }

    public value(type: DataType<"module-namespace">, cpp?: string): Value {
        this.context.reachJsData();
        return {
            kind: "data",
            cpp:
                cpp ??
                `bbl::js::ModuleNamespace{${this.context.cppString(type.module)}}`,
            dataType: type,
            moduleNamespace: true,
            truthinessCpp: "true",
            recordOwnKeys: [...this.exports(type).keys()],
        };
    }

    private exports(
        type: DataType<"module-namespace">,
    ): ReadonlyMap<string, ts.Symbol> {
        const cached = this.exportsByModule.get(type.module);
        if (cached) return cached;
        const file = this.context.program.getSourceFile(type.module);
        const symbol = file && declaredSymbol(this.context.checker, file);
        if (!symbol) return new Map();
        const result = new Map(
            this.context.checker
                .getExportsOfModule(symbol)
                .filter(
                    (exported) =>
                        (aliasTarget(this.context.checker, exported).flags &
                            ts.SymbolFlags.Value) !==
                        0,
                )
                .sort((left, right) =>
                    left.name < right.name
                        ? -1
                        : left.name > right.name
                          ? 1
                          : 0,
                )
                .map((exported) => [exported.name, exported]),
        );
        this.exportsByModule.set(type.module, result);
        return result;
    }

    public member(
        owner: Value,
        name: string,
        node: ts.Node,
    ): Value | undefined {
        if (owner.dataType?.kind !== "module-namespace") return undefined;
        this.context.emitDiscardedValue(owner);
        const exported = this.exports(owner.dataType).get(name);
        if (!exported) return undefined;
        const target = aliasTarget(this.context.checker, exported);
        if (declaredIn(target, "babylon")) {
            const constant = this.context.compileRegisteredConstant(
                target.name,
            );
            if (constant) return constant;
            if (
                !this.context.checker.getSignaturesOfType(
                    this.context.checker.getTypeOfSymbolAtLocation(
                        target,
                        node,
                    ),
                    ts.SignatureKind.Call,
                ).length
            )
                return this.context.fail(
                    node,
                    `Pinned module export '${name}' has no represented constant or callable.`,
                );
            return { kind: "callback", cpp: "", intrinsicName: target.name };
        }
        const declaration = target.valueDeclaration ?? target.declarations?.[0];
        if (declaration && ts.isSourceFile(declaration))
            return this.value({
                kind: "module-namespace",
                module: declaration.fileName,
            });
        if (
            declaration &&
            (ts.isVariableDeclaration(declaration) ||
                ts.isFunctionDeclaration(declaration) ||
                ts.isClassDeclaration(declaration) ||
                ts.isEnumDeclaration(declaration)) &&
            declaration.name &&
            ts.isIdentifier(declaration.name)
        ) {
            const value = this.context.compileValue(declaration.name);
            // A constant export computed from constants (`A * 4`) reads as
            // the number it folds to, so comparing two reads of it decides
            // at generation as a literal export's reads do.
            const staticNumber =
                value.kind === "number" &&
                value.staticNumber === undefined &&
                ts.isVariableDeclaration(declaration) &&
                (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !==
                    0
                    ? staticNumberValue(this.context, declaration.name)
                    : undefined;
            return staticNumber !== undefined && Number.isFinite(staticNumber)
                ? { ...value, staticNumber }
                : value;
        }
        return this.context.fail(
            node,
            `Module namespace export '${name}' has no supported value declaration.`,
        );
    }

    public entries(owner: Value, node: ts.Node): [string, Value][] | undefined {
        if (owner.dataType?.kind !== "module-namespace") return undefined;
        const type = owner.dataType;
        owner = this.context.bindings.pinValueToTemporary(
            owner,
            "module_namespace",
        );
        return [...this.exports(type).keys()].map((name) => [
            name,
            this.member(owner, name, node)!,
        ]);
    }

    public fromIdentifier(identifier: ts.Identifier): Value | undefined {
        const file = this.context.symbols
            .valueSymbol(identifier)
            ?.declarations?.find(ts.isSourceFile);
        return file
            ? this.value({ kind: "module-namespace", module: file.fileName })
            : undefined;
    }

    public compileImport(call: ts.CallExpression): Value {
        if (!this.context.options.workers) throw new ApplicationRealmRequired();
        this.context.expectArgumentCount(call, 1, 1);
        const argument = call.arguments[0]!;
        if (!ts.isStringLiteralLike(argument))
            return this.context.fail(
                argument,
                "Dynamic import requires a finite literal module specifier.",
            );
        const file = declaredSymbol(
            this.context.checker,
            argument,
        )?.declarations?.find(ts.isSourceFile);
        if (!file)
            return this.context.fail(
                argument,
                "Dynamic import module could not be resolved.",
            );
        this.requireEvaluatedOrPure(file, call);
        const type: DataType<"module-namespace"> = {
            kind: "module-namespace",
            module: file.fileName,
        };
        const result = this.value(type);
        const then = this.exports(type).get("then");
        if (
            then &&
            this.context.checker.getSignaturesOfType(
                this.context.checker.getTypeOfSymbolAtLocation(then, call),
                ts.SignatureKind.Call,
            ).length
        )
            return this.context.fail(
                call,
                "Callable module export 'then' requires namespace thenable assimilation.",
            );
        return {
            kind: "promise",
            cpp: this.importCpp(file, result),
            dataType: { kind: "promise", result: result.dataType! },
            promiseType: "bbl::js::ModuleNamespace",
            promiseResult: result,
        };
    }

    private importCpp(file: ts.SourceFile, namespace: Value): string {
        const activation = this.activations.get(file);
        if (!activation)
            return `bbl::js::Promise<bbl::js::ModuleNamespace>::resolved(${namespace.cpp})`;
        this.context.useNativeValue({ kind: "void", cpp: activation.cpp });
        return `bbl::js::import_module(${activation.cpp})`;
    }

    private requireEvaluatedOrPure(file: ts.SourceFile, node: ts.Node): void {
        const evaluated = this.evaluatedModules();
        const visited = new Set<ts.SourceFile>();
        const visit = (current: ts.SourceFile): void => {
            if (
                visited.has(current) ||
                evaluated.has(current) ||
                this.activations.has(current)
            )
                return;
            visited.add(current);
            if (current.isDeclarationFile) {
                const symbol = declaredSymbol(this.context.checker, current);
                if (declaredIn(symbol, "babylon")) return;
                this.context.fail(
                    node,
                    "Dynamic import of a declaration-only module has no native implementation.",
                );
            }
            runtimeModuleDependencies(this.context.checker, current).forEach(
                visit,
            );
            const state = planEntryModuleState(
                this.context.program,
                current,
                this.context.checker,
                this.context.symbols,
            );
            if (state.length) throw new ModuleActivationRequired(file);
            for (const statement of current.statements) {
                if (
                    ts.isModuleDeclaration(statement) ||
                    (ts.isClassDeclaration(statement) &&
                        (statement.heritageClauses?.length ||
                            statement.members.some(
                                (member) =>
                                    member.name &&
                                    ts.isComputedPropertyName(member.name),
                            )))
                )
                    this.context.fail(
                        statement,
                        "Lazy module initialization with observable state requires a retained once-only module activation.",
                    );
                if (
                    ts.isEnumDeclaration(statement) &&
                    statement.members.some(
                        (member) =>
                            this.context.checker.getConstantValue(member) ===
                            undefined,
                    )
                )
                    this.context.fail(
                        statement,
                        "Lazy module initialization with observable state requires a retained once-only module activation.",
                    );
                if (
                    !isModuleInitializerStatement(
                        statement,
                        this.context.checker,
                    )
                )
                    continue;
                if (
                    ts.isVariableStatement(statement) &&
                    (statement.declarationList.flags & ts.NodeFlags.Const) !==
                        0 &&
                    statement.declarationList.declarations.every(
                        (declaration) =>
                            ts.isIdentifier(declaration.name) &&
                            declaration.initializer &&
                            isTotalDefinition(declaration.initializer) &&
                            this.context.evaluationOrder.isPureExpression(
                                declaration.initializer,
                            ),
                    )
                )
                    continue;
                throw new ModuleActivationRequired(file);
            }
        };
        visit(file);
    }
}
