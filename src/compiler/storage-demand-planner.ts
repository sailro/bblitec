import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import { declaredSymbol } from "./symbols.js";
import {
    expressionMayRunCode,
    statementDeclaredNames,
    unwrapExpression,
} from "./syntax.js";
import { CompileError } from "./compile-error.js";
import {
    DynamicBindingStorageRequired,
    type DynamicBindingStorage,
} from "./dynamic-binding-storage.js";
import {
    GenericFunctionStorageRequired,
    GenericFunctionStorage,
    type GenericFunctionDemand,
} from "./generic-function-storage.js";
import {
    NativeRecordStorageRequired,
    mergeNativeRecordStorage,
    type NativeRecordStorageDemand,
} from "./native-record-storage.js";
import type { LoweringServices } from "./lowering-services.js";

type StorageDemand =
    | DynamicBindingStorageRequired
    | NativeRecordStorageRequired
    | GenericFunctionStorageRequired;

export type StorageRequest =
    | {
          kind: "dynamic";
          declaration: ts.VariableDeclaration;
          storage: DynamicBindingStorage | undefined;
      }
    | { kind: "record"; demand: NativeRecordStorageDemand }
    | { kind: "generic"; demand: GenericFunctionDemand };

export function storageRequest(error: StorageDemand): StorageRequest {
    if (error instanceof DynamicBindingStorageRequired)
        return {
            kind: "dynamic",
            declaration: error.declaration,
            storage: error.storage,
        };
    if (error instanceof NativeRecordStorageRequired)
        return { kind: "record", demand: error.demand };
    return { kind: "generic", demand: error.demand };
}

export function isStorageDemand(error: unknown): error is StorageDemand {
    return (
        error instanceof DynamicBindingStorageRequired ||
        error instanceof NativeRecordStorageRequired ||
        error instanceof GenericFunctionStorageRequired
    );
}

type StatementContext = Pick<
    LoweringServices,
    "checker" | "bindings" | "dataTypes" | "transaction"
>;

let active: StorageDemandPlanner | undefined;
let enabled = true;
const statistics = {
    strict: 0,
    planning: 0,
    collected: 0,
    refused: 0,
    dependent: 0,
    writes: 0,
};

/** Compiler constructions, including discarded planning; useful for measured comparisons. */
export function storagePlanningStatistics(): Readonly<typeof statistics> {
    return { ...statistics };
}

export function recordStorageCompileAttempt(planning: boolean): void {
    statistics[planning ? "planning" : "strict"]++;
}

export function storageDemandPlanningEnabled(): boolean {
    return enabled;
}

/** Scoped baseline comparison; does not alter normal generation options. */
export function withStorageDemandPlanning<T>(allow: boolean, run: () => T): T {
    const previous = enabled;
    enabled = allow;
    try {
        return run();
    } finally {
        enabled = previous;
    }
}

export function activeStorageDemandPlanner(): StorageDemandPlanner | undefined {
    return active;
}

class PlanningLimit extends Error {}
class PlanningDependency extends Error {}
class PlanningWrite extends Error {}

/** A native generic call asks for its signature before lowering arguments or invoking it. */
function independentGenericCall(
    context: StatementContext,
    statement: ts.Statement,
    error: GenericFunctionStorageRequired,
): boolean {
    const declaration =
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.length === 1
            ? statement.declarationList.declarations[0]
            : undefined;
    const expression = ts.isExpressionStatement(statement)
        ? statement.expression
        : declaration && ts.isIdentifier(declaration.name)
          ? declaration.initializer
          : undefined;
    if (
        !expression ||
        !ts.isCallExpression(error.call) ||
        unwrapExpression(expression) !== error.call
    )
        return false;
    const callee = unwrapExpression(error.call.expression);
    if (!ts.isIdentifier(callee)) {
        if (
            !ts.isPropertyAccessExpression(callee) ||
            !ts.isIdentifier(callee.expression)
        )
            return false;
        const owner = context.bindings.lookupOptional(callee.expression);
        const type =
            owner?.dataType?.kind === "optional"
                ? owner.dataType.inner
                : owner?.dataType;
        if (type?.kind !== "struct") return false;
        const field = context.dataTypes
            .structFields(type.name, callee.name, "accessors")
            .find((field) => field.sourceName === callee.name.text);
        if (!field || field.accessor || field.type.kind !== "function")
            return false;
    }
    return error.call.arguments.every((argument) => {
        if (ts.isSpreadElement(argument)) return false;
        const value = unwrapExpression(argument);
        if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
            // Callback execution may change captured state; only pure expression bodies are independent.
            return !ts.isBlock(value.body) && !expressionMayRunCode(value.body);
        }
        return (
            !expressionMayRunCode(value) &&
            context.checker.getTypeAtLocation(value).getCallSignatures()
                .length === 0
        );
    });
}

/**
 * A bounded discarded emission collects storage demands at transaction boundaries.
 * Its compiler reads frozen seed demands; new demands are applied only to a fresh
 * strict compiler. Ordinary refusals end discovery, including lost-binding cascades.
 */
export class StorageDemandPlanner {
    /** @unjournaled Demands must survive the statements they roll back. */
    readonly demands: StorageRequest[] = [];
    /** @unjournaled Discovery deduplicates requests discarded by emission. */
    private readonly dynamic = new Map<
        ts.VariableDeclaration,
        StorageRequest & { kind: "dynamic" }
    >();
    /** @unjournaled Discovery deduplicates requests discarded by emission. */
    private readonly records = new Map<
        NativeRecordStorageDemand["identity"],
        StorageRequest & { kind: "record" }
    >();
    /** @unjournaled Discovery deduplicates requests discarded by emission. */
    private readonly generic = new GenericFunctionStorage();
    /** @unjournaled Bounds the discarded attempt, independently of rollback. */
    private statements = 0;
    /** @unjournaled Source declarations removed by a planning rollback. */
    private readonly lostDeclarations = new Set<ts.Symbol>();
    /** @unjournaled Successful dependency checks are valid until another declaration is lost. */
    private readonly dependencyChecks = new WeakMap<ts.Node, number>();
    /** @unjournaled Lost declaration sets grow across statement rollback. */
    private lostGeneration = 0;
    private readonly deadline = performance.now() + 10000;

    public run(work: () => void): void {
        const previous = active;
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- A synchronous dynamic scope, restored before returning.
        active = this;
        try {
            work();
        } catch (error) {
            if (isStorageDemand(error)) this.record(error);
            else if (error instanceof CompileError) statistics.refused++;
            else if (error instanceof PlanningDependency)
                statistics.dependent++;
            else if (error instanceof PlanningWrite) statistics.writes++;
            else if (!(error instanceof PlanningLimit)) throw error;
        } finally {
            active = previous;
        }
    }

    public attemptStatement(
        context: StatementContext,
        statement: ts.Statement,
        lower: () => void,
    ): void {
        if (
            ++this.statements > 10000 ||
            this.demands.length >= 256 ||
            performance.now() > this.deadline
        )
            throw new PlanningLimit();
        if (
            this.lostDeclarations.size > 0 &&
            this.dependencyChecks.get(statement) !== this.lostGeneration
        ) {
            const checked: ts.Statement[] = [];
            const dependent = someAnalysisNode(
                statement,
                (node) => {
                    if (ts.isStatement(node)) {
                        if (
                            this.dependencyChecks.get(node) ===
                            this.lostGeneration
                        )
                            return "skip";
                        checked.push(node);
                    }
                    if (!ts.isIdentifier(node)) return false;
                    const symbol = declaredSymbol(context.checker, node);
                    return (
                        symbol !== undefined &&
                        this.lostDeclarations.has(symbol)
                    );
                },
                { types: "skip", memberNames: "skip" },
            );
            if (dependent) throw new PlanningDependency();
            for (const node of checked)
                this.dependencyChecks.set(node, this.lostGeneration);
        }
        try {
            context.transaction(lower);
        } catch (error) {
            if (!isStorageDemand(error)) throw error;
            this.record(error);
            // Ownership transitions can arise during writes; an omitted write would leave old facts visible.
            if (
                !(error instanceof GenericFunctionStorageRequired) ||
                !independentGenericCall(context, statement, error)
            )
                throw new PlanningWrite();
            for (const name of statementDeclaredNames(statement)) {
                const symbol = declaredSymbol(context.checker, name);
                if (symbol && !this.lostDeclarations.has(symbol)) {
                    this.lostDeclarations.add(symbol);
                    this.lostGeneration++;
                }
            }
        }
    }

    private record(demand: StorageDemand): void {
        const request = storageRequest(demand);
        if (request.kind === "dynamic") {
            const existing = this.dynamic.get(request.declaration);
            if (existing) {
                if (!existing.storage && request.storage)
                    existing.storage = request.storage;
                return;
            }
            this.dynamic.set(request.declaration, request);
        } else if (request.kind === "record") {
            const existing = this.records.get(request.demand.identity);
            if (existing) {
                existing.demand = mergeNativeRecordStorage(
                    existing.demand,
                    request.demand,
                );
                return;
            }
            this.records.set(request.demand.identity, request);
        } else if (!this.generic.add(request.demand)) return;
        this.demands.push(request);
        statistics.collected++;
    }
}
