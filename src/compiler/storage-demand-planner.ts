import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import { declaredSymbol, namedMember, resolvedSymbol } from "./symbols.js";
import { localClassOfSymbol } from "./class-members.js";
import {
    bindingNameIdentifiers,
    classBaseExpression,
    evaluationContainer,
    expressionMayRunCode,
    referenceBases,
    statementDeclaredNames,
    thisClass,
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
    demandsSourceStorage,
    ReplayStorage,
    type StorageRequest,
} from "./replay-storage.js";
import type { LoweringServices } from "./lowering-services.js";
import { callSignatures } from "./type-facts.js";
import { holderTest, holdsRecord } from "./record-observations.js";

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

/** Ends a plan; the message says what ended it. */
class PlanningStop extends Error {}
class PlanningDependency extends Error {}
class PlanningWrite extends Error {}

/**
 * Raises `demand` at a site lowering can go on past (a record join stored
 * as a copy, a resource stored without its engine owner, a parameter's
 * record copied): a planning attempt records it there and goes on. Past
 * such a site lowering stores what it stored before the demand, so a later
 * demand that follows from this one is met by the next attempt.
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
 * A binding's named storage demanded by its own initializer. Rolling back
 * this declaration loses only its binding: evaluating the initializer
 * runs no calls, accessors or writes. Its source/array storage does not
 * carry a representation inferred at another use of the binding.
 */
function ownBindingDemand(
    statement: ts.Statement | undefined,
    request: StorageRequest,
): boolean {
    if (
        !statement ||
        !ts.isVariableStatement(statement) ||
        statement.declarationList.declarations.length !== 1 ||
        request.kind !== "dynamic" ||
        (request.storage !== "source" && request.storage !== "array")
    )
        return false;
    const declaration = statement.declarationList.declarations[0]!;
    return (
        declaration === request.declaration &&
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        !expressionMayRunCode(declaration.initializer) &&
        // Spreads can invoke getters/iterators; computed keys can run coercion.
        !someAnalysisNode(
            declaration.initializer,
            (node) =>
                ts.isSpreadElement(node) ||
                ts.isSpreadAssignment(node) ||
                ts.isComputedPropertyName(node),
            { functions: "skip", types: "skip" },
        )
    );
}

/**
 * Whether planning can go on past `statement` once its demand rolled it
 * back. A storage decision for a declaration (an absence tag, a tuple or
 * numeric array slot, string enum elements) holds whatever the statement
 * went on to do; an ownership transition (dynamic binding, shared record
 * storage) can arise during writes, so it ends discovery. A demand for
 * the statement's own binding instead loses that declaration; a later
 * read of it ends discovery through the lost-declaration check.
 */
function independentDemand(
    context: StatementContext,
    statement: ts.Statement,
    error: StorageDemand,
): boolean {
    if (error instanceof GenericFunctionStorageRequired)
        return independentGenericCall(context, statement, error);
    if (error instanceof DynamicBindingStorageRequired)
        return ownBindingDemand(statement, error.request);
    return !(
        error instanceof ParameterObjectStorageRequired ||
        error instanceof NativeRecordStorageRequired ||
        error instanceof SharedClassStorageRequired
    );
}

/**
 * The body of the function whose frame a declaration's variable lives in;
 * undefined in a module or class static block, which run once.
 */
function functionBodyOf(
    declaration: ts.Declaration | undefined,
): ts.Block | undefined {
    const owner = declaration && evaluationContainer(declaration);
    const body =
        owner && ts.isFunctionLike(owner) && "body" in owner
            ? owner.body
            : undefined;
    return body && ts.isBlock(body) ? body : undefined;
}

/**
 * What a rolled-back `statement` would have written: the bindings it
 * declares and the bases (`referenceBases`) of the targets it assigns,
 * updates or deletes, and the classes whose `this` roots one
 * (`this.x = ...`). Undefined when a target is rooted elsewhere
 * (`f().x = ...`): a later read could not be told from the omitted write.
 */
function rolledBackWrites(
    statement: ts.Statement,
): { names: ts.Identifier[]; classes: ts.ClassLikeDeclaration[] } | undefined {
    const names = statementDeclaredNames(statement);
    const classes: ts.ClassLikeDeclaration[] = [];
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
            for (const { target } of writeSites(node))
                for (const base of referenceBases(target)) {
                    const owner =
                        base.kind === ts.SyntaxKind.ThisKeyword
                            ? thisClass(target)
                            : undefined;
                    if (ts.isIdentifier(base)) names.push(base);
                    else if (owner) classes.push(owner);
                    // A literal is a fresh object no other code holds.
                    else if (
                        !ts.isObjectLiteralExpression(base) &&
                        !ts.isArrayLiteralExpression(base)
                    )
                        return true;
                }
            return false;
        },
        { functions: "skip", types: "skip" },
    );
    return untracked ? undefined : { names, classes };
}

/**
 * A discarded emission collects storage demands at transaction boundaries,
 * up to a bound on the demands one plan collects.
 * Its compiler reads frozen seed demands; new demands are applied only to a fresh
 * compiler. A demand rolls back its statement, whose written names are
 * lost to later statements, except one lowering goes on past
 * (`demandOrPlan`), after which the plan collects demands of every kind
 * whose storage their key and source types name (`demandsSourceStorage`).
 * Refusals and lost-binding reads end discovery. Past a rolled-back
 * statement, which may have met a demand first at its own site, a plan
 * collects only demands of a key (`demandsKeyOnly`) or a statement's own
 * binding with named storage (`ownBindingDemand`).
 */
export class StorageDemandPlanner {
    /** @unjournaled Demands must survive the statements they roll back. */
    readonly demands: StorageRequest[] = [];
    /** @unjournaled Discovery deduplicates requests discarded by emission. */
    private readonly collected: ReplayStorage;
    /** @unjournaled Source declarations removed by a planning rollback. */
    private readonly lostDeclarations = new Set<ts.Symbol>();
    /**
     * @unjournaled The lost declarations local to a function body, by body:
     * the next activation of that body declares them afresh.
     */
    private readonly lostLocals = new Map<ts.Node, Set<ts.Symbol>>();
    /** @unjournaled Classes whose instances a planning rollback wrote through `this`. */
    private readonly lostClasses = new Set<ts.ClassLikeDeclaration>();
    /** @unjournaled Record types whose instances a planning rollback wrote through `this`, one array per change. */
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
     * @unjournaled Whether lowering went on past a demand (`demandOrPlan`):
     * later values hold the storage the attempt began with there, so a
     * later demand carrying storage its site lowered may differ from strict
     * lowering's (`demandsSourceStorage`).
     */
    private wentOn = false;
    /** @unjournaled The statements this plan began lowering (`beginActivation`). */
    private statements = 0;
    /** @unjournaled `statements` when the plan collected its first demand. */
    private firstDemandAt?: number;
    /** @unjournaled `statements` when the plan collected its latest demand. */
    private lastDemandAt = 0;
    /**
     * @unjournaled Whether the plan ended at its statement bound
     * (`beginActivation`): a scope that recovers from the stop goes on
     * lowering, and nothing it meets is collected.
     */
    private bounded = false;

    public constructor(checker: ts.TypeChecker) {
        this.collected = new ReplayStorage(checker);
    }

    /** A demand lowering goes on without (`demandOrPlan`). */
    public planDemand(request: StorageRequest): void {
        this.requireSourceStorage([request]);
        this.requireStrictSite([request]);
        this.wentOn = true;
        this.collect(request);
    }

    /**
     * A plan that lowered every statement without a demand compiled what
     * the next strict attempt would; one that collected any is discarded.
     */
    public complete<T>(result: T): T {
        if (this.demands.length > 0)
            throw new PlanningStop("the end of a plan that collected demands");
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
                if (!this.fromSourceStorage(error.requests))
                    statistics.writes++;
                else if (this.metAtStrictSite(error.requests))
                    for (const request of error.requests) this.collect(request);
                else statistics.departed++;
            } else if (error instanceof CompileError) statistics.refused++;
            else if (error instanceof PlanningDependency)
                statistics.dependent++;
            else if (error instanceof PlanningWrite) statistics.writes++;
            else if (!(error instanceof PlanningStop)) throw error;
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
        if (this.demands.length >= 256)
            throw new PlanningStop("the 256 demands one plan collects");
        // Under a generic instantiation a statement reads the types the
        // active call binds, so a check of lost types holds for that call
        // alone.
        const cached =
            this.lostTypes.length === 0 ||
            !context.dataTypes.substitutesTypeParameters();
        if (
            (this.lostDeclarations.size > 0 ||
                this.lostClasses.size > 0 ||
                this.lostTypes.length > 0) &&
            (!cached ||
                this.dependencyChecks.get(statement) !== this.lostGeneration)
        ) {
            const checked: ts.Statement[] = [];
            const dependent = someAnalysisNode(
                statement,
                (node) => {
                    if (ts.isStatement(node) && cached) {
                        if (
                            this.dependencyChecks.get(node) ===
                            this.lostGeneration
                        )
                            return "skip";
                        checked.push(node);
                    }
                    if (node.kind === ts.SyntaxKind.ThisKeyword) {
                        if (this.lostClasses.size === 0) return false;
                        const owner = thisClass(node);
                        return (
                            owner !== undefined &&
                            this.extendsLostClass(context.checker, owner)
                        );
                    }
                    if (!ts.isIdentifier(node)) return false;
                    const symbol = declaredSymbol(context.checker, node);
                    return (
                        (symbol !== undefined &&
                            this.lostDeclarations.has(symbol)) ||
                        this.readsLostType(context, node)
                    );
                },
                { types: "skip", names: "references" },
            );
            if (dependent)
                throw new PlanningDependency(
                    "a statement reads what a rolled-back one lost",
                );
            for (const node of checked)
                this.dependencyChecks.set(node, this.lostGeneration);
        }
        try {
            context.transaction(lower);
        } catch (error) {
            if (!(error instanceof StorageDemand)) throw error;
            this.requireSourceStorage(error.requests);
            this.requireStrictSite(error.requests, statement);
            for (const request of error.requests) this.collect(request);
            // An ownership change can reach what later statements read: the
            // plan ends.
            if (!independentDemand(context, statement, error))
                throw new PlanningWrite(
                    `a demand of kind ${error.request.kind} whose change later statements may read`,
                );
            this.lose(context.checker, statement);
        }
    }

    /** Whether a reference's value can be a record of a type the plan lost. */
    private readsLostType(
        context: StatementContext,
        reference: ts.Identifier,
    ): boolean {
        if (this.lostTypes.length === 0) return false;
        const checker = context.checker;
        const type = checker.getTypeAtLocation(reference);
        // An untyped value reads as anything; counting it would lose all.
        if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)
            return false;
        if (context.dataTypes.substitutesTypeParameters())
            return holdsRecord(checker, type, this.lostTypes, (held) =>
                context.dataTypes.resolveTypeParameter(held),
            );
        let reads = this.lostTypeReads.get(type);
        if (reads === undefined) {
            this.holds ??= holderTest(checker);
            reads = this.holds(type, this.lostTypes);
            this.lostTypeReads.set(type, reads);
        }
        return reads;
    }

    /** Whether strict lowering would meet `requests` as this plan did. */
    private metAtStrictSite(
        requests: readonly StorageRequest[],
        statement?: ts.Statement,
    ): boolean {
        return (
            !this.rolledBack ||
            requests.every(
                (request) =>
                    demandsKeyOnly(request) ||
                    ownBindingDemand(statement, request),
            )
        );
    }

    /**
     * Whether strict lowering would ask for the storage `requests` ask for:
     * before lowering went on past a demand, or where their key and source
     * types name it (`demandsSourceStorage`).
     */
    private fromSourceStorage(requests: readonly StorageRequest[]): boolean {
        return !this.wentOn || requests.every(demandsSourceStorage);
    }

    /** Ends a plan, uncollected, at demands whose storage its copies may have changed. */
    private requireSourceStorage(requests: readonly StorageRequest[]): void {
        if (this.fromSourceStorage(requests)) return;
        throw new PlanningWrite(
            "a demand carrying storage lowered past a demand lowering went on without",
        );
    }

    /** Ends a plan whose demands strict lowering could meet elsewhere first. */
    private requireStrictSite(
        requests: readonly StorageRequest[],
        statement?: ts.Statement,
    ): void {
        if (this.metAtStrictSite(requests, statement)) return;
        statistics.departed++;
        throw new PlanningStop(
            "a demand strict lowering could meet elsewhere first",
        );
    }

    /** Loses what a rolled-back statement would have written. */
    private lose(checker: ts.TypeChecker, statement: ts.Statement): void {
        this.rolledBack = true;
        const written = rolledBackWrites(statement);
        if (!written)
            throw new PlanningWrite(
                "a rolled-back statement writes a target rooted neither at a name nor at this",
            );
        for (const name of written.names) this.loseName(checker, name);
        for (const owner of written.classes)
            if (!this.lostClasses.has(owner)) {
                this.lostClasses.add(owner);
                this.lostGeneration++;
                // Its instances are lost wherever a name holds one too.
                const symbol =
                    owner.name && declaredSymbol(checker, owner.name);
                if (symbol)
                    this.loseType(checker.getDeclaredTypeOfSymbol(symbol));
            }
    }

    /** Whether `owner` is a lost class or extends one: its `this` reads what the class lost. */
    private extendsLostClass(
        checker: ts.TypeChecker,
        owner: ts.ClassLikeDeclaration,
    ): boolean {
        for (
            let current: ts.ClassLikeDeclaration | undefined = owner;
            current;
        ) {
            if (this.lostClasses.has(current)) return true;
            const base = classBaseExpression(current);
            current =
                base &&
                localClassOfSymbol(resolvedSymbol(checker, base.expression));
        }
        return false;
    }

    private loseType(type: ts.Type): void {
        if (this.lostTypes.includes(type)) return;
        this.lostTypes = [...this.lostTypes, type];
        this.lostTypeReads.clear();
        this.lostGeneration++;
    }

    private loseName(checker: ts.TypeChecker, name: ts.Identifier): void {
        const symbol = declaredSymbol(checker, name);
        if (symbol && !this.lostDeclarations.has(symbol)) {
            this.lostDeclarations.add(symbol);
            this.lostGeneration++;
            const body = functionBodyOf(symbol.valueDeclaration);
            if (body) {
                let locals = this.lostLocals.get(body);
                if (!locals) this.lostLocals.set(body, (locals = new Set()));
                locals.add(symbol);
            }
        }
    }

    /**
     * A function body's first statement begins an activation, whose locals
     * are not the ones an earlier activation's rollback lost. Every
     * statement lowered while the plan runs is noted, recovered or not.
     * Past a demand lowering went on without, a plan ends once it lowered,
     * since its latest demand, as many statements as before its first: a
     * demand that follows from one it met (a join chain's next link) only
     * the next attempt meets, and lowering on to the end for it would cost
     * the whole program.
     */
    public beginActivation(statement: ts.Statement): void {
        this.statements++;
        this.bounded ||=
            this.wentOn &&
            this.firstDemandAt !== undefined &&
            this.statements - this.lastDemandAt > this.firstDemandAt;
        if (this.bounded)
            throw new PlanningStop(
                "as many statements past its latest demand as before its first",
            );
        const body = statement.parent;
        if (
            !ts.isBlock(body) ||
            body.statements[0] !== statement ||
            !ts.isFunctionLike(body.parent)
        )
            return;
        const locals = this.lostLocals.get(body);
        if (!locals) return;
        // Fewer lost names leave every recorded independent statement
        // independent: the checks keep their generation.
        for (const symbol of locals) this.lostDeclarations.delete(symbol);
        this.lostLocals.delete(body);
    }

    private collect(request: StorageRequest): void {
        if (this.bounded || !this.collected.add(request)) return;
        this.firstDemandAt ??= this.statements;
        this.lastDemandAt = this.statements;
        this.demands.push(request);
        statistics.collected++;
    }
}
