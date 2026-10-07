import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import { declaredSymbol } from "./symbols.js";
import {
    assignmentTargets,
    bindingNameIdentifiers,
    expressionMayRunCode,
    isAssignmentExpression,
    isUpdateExpression,
    rootIdentifier,
    statementDeclaredNames,
    unwrapExpression,
} from "./syntax.js";
import { CompileError } from "./compile-error.js";
import { AbsenceTagStorageRequired } from "./absence-tag-storage.js";
import { TupleArraySlotRequired } from "./tuple-array-storage.js";
import { DynamicBindingStorageRequired } from "./dynamic-binding-storage.js";
import { GenericFunctionStorageRequired } from "./generic-function-storage.js";
import {
    NativeRecordStorageRequired,
    type NativeRecordStorageDemand,
} from "./native-record-storage.js";
import { NumericSlotStorageRequired } from "./numeric-slot-storage.js";
import { EnumArrayStorageRequired } from "./enum-array-storage.js";
import { ReplayStorage, type StorageRequest } from "./replay-storage.js";
import type { LoweringServices } from "./lowering-services.js";

type StorageDemand =
    | DynamicBindingStorageRequired
    | NativeRecordStorageRequired
    | GenericFunctionStorageRequired
    | AbsenceTagStorageRequired
    | TupleArraySlotRequired
    | NumericSlotStorageRequired
    | EnumArrayStorageRequired;

export function storageRequest(error: StorageDemand): StorageRequest {
    if (error instanceof DynamicBindingStorageRequired)
        return {
            kind: "dynamic",
            declaration: error.declaration,
            storage: error.storage,
        };
    if (error instanceof NativeRecordStorageRequired)
        return { kind: "record", demand: error.demand };
    if (error instanceof AbsenceTagStorageRequired)
        return { kind: "absence-tag", declaration: error.declaration };
    if (error instanceof TupleArraySlotRequired)
        return { kind: "tuple-array", declaration: error.declaration };
    if (error instanceof NumericSlotStorageRequired)
        return {
            kind: "numeric-slot",
            declaration: error.declaration,
            numeric: error.kind,
        };
    if (error instanceof EnumArrayStorageRequired)
        return { kind: "enum-array", unions: error.unions };
    return { kind: "generic", demand: error.demand };
}

export function isStorageDemand(error: unknown): error is StorageDemand {
    return (
        error instanceof DynamicBindingStorageRequired ||
        error instanceof NativeRecordStorageRequired ||
        error instanceof GenericFunctionStorageRequired ||
        error instanceof AbsenceTagStorageRequired ||
        error instanceof TupleArraySlotRequired ||
        error instanceof NumericSlotStorageRequired ||
        error instanceof EnumArrayStorageRequired
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
        const field = context.dataTypes.findStructField(
            type.name,
            callee.name.text,
            callee.name,
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
            context.checker.getTypeAtLocation(value).getCallSignatures()
                .length === 0
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
        error instanceof NativeRecordStorageRequired
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
            const targets = isAssignmentExpression(node)
                ? assignmentTargets(node.left)
                : isUpdateExpression(node)
                  ? [node.operand]
                  : ts.isDeleteExpression(node)
                    ? [node.expression]
                    : (ts.isForInStatement(node) ||
                            ts.isForOfStatement(node)) &&
                        !ts.isVariableDeclarationList(node.initializer)
                      ? assignmentTargets(node.initializer)
                      : [];
            for (const target of targets) {
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
 * A bounded discarded emission collects storage demands at transaction boundaries.
 * Its compiler reads frozen seed demands; new demands are applied only to a fresh
 * strict compiler. A demand rolls back its statement, whose written names are
 * lost to later statements, except a record join, which lowering goes on
 * without (`planJoin`). Ordinary refusals end discovery, including
 * lost-binding cascades, except in a survey, whose strict attempts roll the
 * refused statement back too.
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
    /** @unjournaled Successful dependency checks are valid until another declaration is lost. */
    private readonly dependencyChecks = new WeakMap<ts.Node, number>();
    /** @unjournaled Lost declaration sets grow across statement rollback. */
    private lostGeneration = 0;
    /**
     * @unjournaled A join was planned as a copy: a later demand of this
     * attempt may follow from that copy, so only joins are collected.
     */
    private copied = false;
    private readonly deadline: number;

    /**
     * `budget`: milliseconds the attempt may lower for, at least ten
     * seconds; `survey`: whether it plans a survey's strict attempts.
     */
    public constructor(
        checker: ts.TypeChecker,
        budget = 0,
        private readonly survey = false,
    ) {
        this.collected = new ReplayStorage(checker);
        this.deadline = performance.now() + Math.max(10000, budget);
    }

    /** A record join lowering goes on without, storing a copy. */
    public planJoin(demand: NativeRecordStorageDemand): void {
        this.copied = true;
        this.collect({ kind: "record", demand });
    }

    public run(work: () => void): void {
        const previous = active;
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- A synchronous dynamic scope, restored before returning.
        active = this;
        try {
            work();
        } catch (error) {
            if (isStorageDemand(error)) {
                if (!this.copied) this.collect(storageRequest(error));
            } else if (error instanceof CompileError) statistics.refused++;
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
            if (error instanceof CompileError && this.survey) {
                // A survey's strict attempt rolls the refused statement
                // back and goes on: so does its plan.
                statistics.refused++;
                this.lose(context.checker, statement);
                return;
            }
            if (!isStorageDemand(error)) throw error;
            if (this.copied) throw new PlanningWrite();
            this.collect(storageRequest(error));
            if (!independentDemand(context, statement, error))
                throw new PlanningWrite();
            this.lose(context.checker, statement);
        }
    }

    /** Loses the names a rolled-back statement would have written. */
    private lose(checker: ts.TypeChecker, statement: ts.Statement): void {
        const written = rolledBackWrites(statement);
        if (!written) throw new PlanningWrite();
        for (const name of written) {
            const symbol = declaredSymbol(checker, name);
            if (symbol && !this.lostDeclarations.has(symbol)) {
                this.lostDeclarations.add(symbol);
                this.lostGeneration++;
            }
        }
    }

    private collect(request: StorageRequest): void {
        if (!this.collected.add(request)) return;
        this.demands.push(request);
        statistics.collected++;
    }
}
