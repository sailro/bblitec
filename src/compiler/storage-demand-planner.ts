import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import { declaredSymbol, namedMember } from "./symbols.js";
import {
    bindingNameIdentifiers,
    expressionMayRunCode,
    rootIdentifier,
    statementDeclaredNames,
    unwrapExpression,
    writeSites,
} from "./syntax.js";
import { CompileError } from "./compile-error.js";
import {
    DynamicBindingStorageRequired,
    ParameterObjectStorageRequired,
} from "./dynamic-binding-storage.js";
import { GenericFunctionStorageRequired } from "./generic-function-storage.js";
import { NativeRecordStorageRequired } from "./native-record-storage.js";
import { SharedClassStorageRequired } from "./shared-class-storage.js";
import { StorageDemand } from "./storage-demand.js";
import {
    demandsKeyOnly,
    ReplayStorage,
    type StorageRequest,
} from "./replay-storage.js";
import type { LoweringServices } from "./lowering-services.js";
import { callSignatures } from "./type-facts.js";
import { holderTest } from "./record-observations.js";

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
    departed: 0,
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
class PlanningCollected extends Error {}
class PlanningDeparted extends Error {}

/**
 * Raises `demand` at a site lowering can go on past (a record join stored
 * as a copy, a resource stored without its engine owner, a parameter's
 * record copied): a planning attempt records it there and goes on.
 */
export function demandOrPlan(demand: StorageDemand): void {
    if (!active) throw demand;
    active.planDemand(demand.request);
}

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
    const unwrapped = unwrapExpression(error.call.expression);
    if (!ts.isIdentifier(unwrapped)) {
        const callee = namedMember(context.checker, unwrapped);
        if (!callee || !ts.isIdentifier(callee.expression)) return false;
        const owner = context.bindings.lookupOptional(callee.expression);
        const type =
            owner?.dataType?.kind === "optional"
                ? owner.dataType.inner
                : owner?.dataType;
        if (type?.kind !== "struct") return false;
        const field = context.dataTypes.findStructField(
            type.name,
            callee.name,
            callee.key,
        );
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
            callSignatures(
                context.checker,
                context.checker.getTypeAtLocation(value),
                "exact",
            ).length === 0
        );
    });
}

/**
 * Whether planning can go on past `statement` once its demand rolled it
 * back. A storage decision for a declaration (an absence tag, a tuple or
 * numeric array slot, string enum elements) holds whatever the statement
 * went on to do; an ownership transition (dynamic binding, shared record
 * storage) can arise during writes, so it ends discovery.
 */
function independentDemand(
    context: StatementContext,
    statement: ts.Statement,
    error: StorageDemand,
): boolean {
    if (error instanceof GenericFunctionStorageRequired)
        return independentGenericCall(context, statement, error);
    return !(
        error instanceof DynamicBindingStorageRequired ||
        error instanceof ParameterObjectStorageRequired ||
        error instanceof NativeRecordStorageRequired ||
        error instanceof SharedClassStorageRequired
    );
}

/**
 * The names whose values a rolled-back `statement` would have written: the
 * bindings it declares and the roots of the targets it assigns, updates or
 * deletes. Undefined when a target is not rooted at a name (`this.x = ...`):
 * a later read could not be told from the omitted write.
 */
function rolledBackWrites(
    statement: ts.Statement,
): ts.Identifier[] | undefined {
    const names = statementDeclaredNames(statement);
    const untracked = someAnalysisNode(
        statement,
        (node) => {
            if (ts.isVariableDeclaration(node))
                names.push(...bindingNameIdentifiers(node.name));
            else if (
                (ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) &&
                node.name
            )
                names.push(node.name);
            for (const { target } of writeSites(node)) {
                const root = rootIdentifier(target);
                if (!root) return true;
                names.push(root);
            }
            return false;
        },
        { functions: "skip", types: "skip" },
    );
    return untracked ? undefined : names;
}

/**
 * A discarded emission collects storage demands at transaction boundaries,
 * bounded unless it is the compile's attempt (`complete`).
 * Its compiler reads frozen seed demands; new demands are applied only to a fresh
 * compiler. A demand rolls back its statement, whose written names are
 * lost to later statements, except one lowering goes on past
 * (`demandOrPlan`). Ordinary refusals
 * end discovery, including lost-binding cascades, except in a survey, whose
 * strict attempts roll the refused statement back too. Past a rolled-back statement, which may have
 * met a demand first at its own site, a plan collects only demands of a key
 * (`demandsKeyOnly`); a survey's collects every demand.
 */
export class StorageDemandPlanner {
    /** @unjournaled Demands must survive the statements they roll back. */
    readonly demands: StorageRequest[] = [];
    /** @unjournaled Discovery deduplicates requests discarded by emission. */
    private readonly collected: ReplayStorage;
    /** @unjournaled Bounds the discarded attempt, independently of rollback. */
    private statements = 0;
    /** @unjournaled Source declarations removed by a planning rollback. */
    private readonly lostDeclarations = new Set<ts.Symbol>();
    /** @unjournaled Record types whose storage a survey's plan changed, one array per change. */
    private lostTypes: readonly ts.Type[] = [];
    /** @unjournaled Whether a holder type can be one of them, reset with each new one. */
    private readonly lostTypeReads = new Map<ts.Type, boolean>();
    /** @unjournaled The record-holder rule (`holderTest`), for this plan's checker. */
    private holds?: (holder: ts.Type, records: readonly ts.Type[]) => boolean;
    /** @unjournaled Successful dependency checks are valid until another declaration is lost. */
    private readonly dependencyChecks = new WeakMap<ts.Node, number>();
    /** @unjournaled Lost declaration sets grow across statement rollback. */
    private lostGeneration = 0;
    /** @unjournaled Whether a statement was rolled back: later demands may differ from strict lowering's. */
    private rolledBack = false;
    /**
     * @unjournaled The kind of demand lowering went on without
     * (`demandOrPlan`): a later demand of this attempt may follow from it,
     * so only that kind is collected.
     */
    private wentOn?: StorageRequest["kind"];
    private readonly deadline: number;
    private readonly statementLimit: number;

    /**
     * `budget`: milliseconds the attempt may lower for, at least ten
     * seconds, or undefined for a plan that is the compile's attempt and
     * lowers as far as it can; `survey`: whether it plans a survey's strict
     * attempts.
     */
    public constructor(
        checker: ts.TypeChecker,
        budget?: number,
        private readonly survey = false,
    ) {
        this.collected = new ReplayStorage(checker);
        this.deadline =
            budget === undefined
                ? Infinity
                : performance.now() + Math.max(10000, budget);
        this.statementLimit = budget === undefined ? Infinity : 10000;
    }

    /** A demand lowering goes on without (`demandOrPlan`). */
    public planDemand(request: StorageRequest): void {
        if (this.wentOn !== undefined && this.wentOn !== request.kind)
            throw new PlanningWrite();
        this.requireStrictSite([request]);
        this.wentOn = request.kind;
        this.collect(request);
    }

    /**
     * A plan that lowered every statement without a demand compiled what
     * the next strict attempt would; one that collected any is discarded.
     */
    public complete<T>(result: T): T {
        if (this.demands.length > 0) throw new PlanningCollected();
        return result;
    }

    /** What `work` returned, or undefined when planning stopped it. */
    public run<T>(work: () => T): T | undefined {
        const previous = active;
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- A synchronous dynamic scope, restored before returning.
        active = this;
        try {
            return work();
        } catch (error) {
            if (error instanceof StorageDemand) {
                if (this.wentOn) return undefined;
                if (this.metAtStrictSite(error.requests))
                    for (const request of error.requests) this.collect(request);
                else statistics.departed++;
            } else if (error instanceof CompileError) statistics.refused++;
            else if (error instanceof PlanningDependency)
                statistics.dependent++;
            else if (error instanceof PlanningWrite) statistics.writes++;
            else if (
                !(error instanceof PlanningLimit) &&
                !(error instanceof PlanningCollected) &&
                !(error instanceof PlanningDeparted)
            )
                throw error;
            return undefined;
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
            ++this.statements > this.statementLimit ||
            this.demands.length >= 256 ||
            performance.now() > this.deadline
        )
            throw new PlanningLimit();
        if (
            (this.lostDeclarations.size > 0 || this.lostTypes.length > 0) &&
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
                        (symbol !== undefined &&
                            this.lostDeclarations.has(symbol)) ||
                        this.readsLostType(context.checker, node)
                    );
                },
                { types: "skip", names: "references" },
            );
            if (dependent) {
                if (!this.survey) throw new PlanningDependency();
                // A survey's plan leaves the statement to the next attempt
                // and goes on with what does not read it.
                statistics.dependent++;
                this.lose(context.checker, statement);
                return;
            }
            for (const node of checked)
                this.dependencyChecks.set(node, this.lostGeneration);
        }
        try {
            context.transaction(lower);
        } catch (error) {
            if (error instanceof CompileError && this.survey) {
                // A survey's strict attempt rolls the refused statement
                // back and goes on: so does its plan.
                statistics.refused++;
                this.lose(context.checker, statement);
                return;
            }
            if (!(error instanceof StorageDemand)) throw error;
            if (this.wentOn) throw new PlanningWrite();
            this.requireStrictSite(error.requests);
            for (const request of error.requests) this.collect(request);
            // An ownership change can reach what later statements read. A
            // survey's plan loses what it changes and goes on; another
            // plan ends.
            if (
                !independentDemand(context, statement, error) &&
                !(
                    this.survey &&
                    error.requests.every((request) =>
                        this.loseDemanded(context, request),
                    )
                )
            )
                throw new PlanningWrite();
            this.lose(context.checker, statement);
        }
    }

    /**
     * Loses what a dependent demand changes the storage of: a binding,
     * parameter or class (and the function that declares it, which its
     * callers lower), or a record type. False for another request.
     */
    private loseDemanded(
        context: StatementContext,
        request: StorageRequest,
    ): boolean {
        if (request.kind === "record") {
            if (!this.lostTypes.includes(request.demand.type)) {
                this.lostTypes = [...this.lostTypes, request.demand.type];
                this.lostTypeReads.clear();
                this.lostGeneration++;
            }
            return true;
        }
        if (
            request.kind !== "dynamic" &&
            request.kind !== "parameter-object" &&
            request.kind !== "shared-class"
        )
            return false;
        const names = request.declaration.name
            ? bindingNameIdentifiers(request.declaration.name)
            : [];
        const owner = ts.findAncestor(
            request.declaration.parent,
            ts.isFunctionLike,
        );
        const ownerName =
            owner &&
            (ts.isFunctionDeclaration(owner) || ts.isMethodDeclaration(owner))
                ? owner.name
                : owner && ts.isVariableDeclaration(owner.parent)
                  ? owner.parent.name
                  : undefined;
        if (ownerName && ts.isIdentifier(ownerName)) names.push(ownerName);
        for (const name of names) this.loseName(context.checker, name);
        return true;
    }

    /** Whether a reference's value can be a record of a type a survey's plan lost. */
    private readsLostType(
        checker: ts.TypeChecker,
        reference: ts.Identifier,
    ): boolean {
        if (this.lostTypes.length === 0) return false;
        const type = checker.getTypeAtLocation(reference);
        // An untyped value reads as anything; counting it would lose all.
        if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)
            return false;
        let reads = this.lostTypeReads.get(type);
        if (reads === undefined) {
            this.holds ??= holderTest(checker);
            reads = this.holds(type, this.lostTypes);
            this.lostTypeReads.set(type, reads);
        }
        return reads;
    }

    /** Whether strict lowering would meet `requests` as this plan did. */
    private metAtStrictSite(requests: readonly StorageRequest[]): boolean {
        return (
            this.survey || !this.rolledBack || requests.every(demandsKeyOnly)
        );
    }

    /** Ends a plan whose demands strict lowering could meet elsewhere first. */
    private requireStrictSite(requests: readonly StorageRequest[]): void {
        if (this.metAtStrictSite(requests)) return;
        statistics.departed++;
        throw new PlanningDeparted();
    }

    /** Loses the names a rolled-back statement would have written. */
    private lose(checker: ts.TypeChecker, statement: ts.Statement): void {
        this.rolledBack = true;
        const written = rolledBackWrites(statement);
        if (!written) throw new PlanningWrite();
        for (const name of written) this.loseName(checker, name);
    }

    private loseName(checker: ts.TypeChecker, name: ts.Identifier): void {
        const symbol = declaredSymbol(checker, name);
        if (symbol && !this.lostDeclarations.has(symbol)) {
            this.lostDeclarations.add(symbol);
            this.lostGeneration++;
        }
    }

    private collect(request: StorageRequest): void {
        if (!this.collected.add(request)) return;
        this.demands.push(request);
        statistics.collected++;
    }
}
