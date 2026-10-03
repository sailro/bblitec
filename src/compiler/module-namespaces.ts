import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import type { DataType } from "./data-types/model.js";
import { aliasTarget, declaredIn, declaredSymbol } from "./symbols.js";
import { unwrapExpression } from "./syntax.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import {
    isModuleInitializerStatement,
    planEntryModuleState,
    runtimeModuleDependencies,
} from "./module-initializers.js";

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

    public constructor(private readonly context: LoweringServices) {}

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
        )
            return this.context.compileValue(declaration.name);
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
            cpp: `bbl::js::Promise<bbl::js::ModuleNamespace>::resolved(${result.cpp})`,
            dataType: { kind: "promise", result: result.dataType! },
            promiseType: "bbl::js::ModuleNamespace",
            promiseResult: result,
        };
    }

    private requireEvaluatedOrPure(file: ts.SourceFile, node: ts.Node): void {
        if (!this.staticModules) {
            const modules = new Set<ts.SourceFile>();
            const visit = (current: ts.SourceFile): void => {
                if (modules.has(current)) return;
                modules.add(current);
                runtimeModuleDependencies(
                    this.context.checker,
                    current,
                ).forEach(visit);
            };
            visit(this.context.sourceFile);
            this.staticModules = modules;
        }
        const visited = new Set<ts.SourceFile>();
        const visit = (current: ts.SourceFile): void => {
            if (visited.has(current) || this.staticModules!.has(current))
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
            if (state.length)
                this.context.fail(
                    state[0]!,
                    "Lazy module initialization with observable state requires a retained once-only module activation.",
                );
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
                this.context.fail(
                    statement,
                    "Lazy module initialization with observable state requires a retained once-only module activation.",
                );
            }
        };
        visit(file);
    }
}
