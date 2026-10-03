import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import { declaredSymbol } from "./symbols.js";
import { statementDeclaredNames } from "./syntax.js";
import { CompileError } from "./compile-error.js";
import { DynamicBindingStorageRequired } from "./dynamic-binding-storage.js";
import { GenericFunctionStorageRequired } from "./generic-function-storage.js";
import { NativeRecordStorageRequired } from "./native-record-storage.js";

type StorageDemand =
    | DynamicBindingStorageRequired
    | NativeRecordStorageRequired
    | GenericFunctionStorageRequired;

export function isStorageDemand(error: unknown): error is StorageDemand {
    return (
        error instanceof DynamicBindingStorageRequired ||
        error instanceof NativeRecordStorageRequired ||
        error instanceof GenericFunctionStorageRequired
    );
}

interface StatementContext {
    readonly checker: ts.TypeChecker;
    transaction(work: () => void): void;
}

let active: StorageDemandPlanner | undefined;
let enabled = true;
const statistics = {
    strict: 0,
    planning: 0,
    collected: 0,
    refused: 0,
    dependent: 0,
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

/**
 * A bounded discarded emission collects storage demands at transaction boundaries.
 * Its compiler reads frozen seed demands; new demands are applied only to a fresh
 * strict compiler. Ordinary refusals end discovery, including lost-binding cascades.
 */
export class StorageDemandPlanner {
    /** @unjournaled Demands must survive the statements they roll back. */
    readonly demands: StorageDemand[] = [];
    /** @unjournaled Bounds the discarded attempt, independently of rollback. */
    private statements = 0;
    /** @unjournaled Source declarations removed by a planning rollback. */
    private readonly lostDeclarations = new Set<ts.Symbol>();
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
            someAnalysisNode(
                statement,
                (node) => {
                    if (!ts.isIdentifier(node)) return false;
                    const symbol = declaredSymbol(context.checker, node);
                    return (
                        symbol !== undefined &&
                        this.lostDeclarations.has(symbol)
                    );
                },
                { types: "skip", memberNames: "skip" },
            )
        )
            throw new PlanningDependency();
        try {
            context.transaction(lower);
        } catch (error) {
            if (!isStorageDemand(error)) throw error;
            this.record(error);
            for (const name of statementDeclaredNames(statement)) {
                const symbol = declaredSymbol(context.checker, name);
                if (symbol) this.lostDeclarations.add(symbol);
            }
        }
    }

    private record(demand: StorageDemand): void {
        this.demands.push(demand);
        statistics.collected++;
    }
}
