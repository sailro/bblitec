import ts from "typescript";
import { someAnalysisNode } from "./analysis-walk.js";
import { declaredSymbol, namedMember } from "./symbols.js";
import {
    bindingNameIdentifiers,
    expressionMayRunCode,
    rootExpression,
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
 * record copied): a planning attempt records it there and goes on. A
 * survey's plan meets it as its statement's demand instead: it loses what
 * the demand changes and goes on with the statements that do not read it,
 * where lowering on with the copy would end the plan at the next demand.
 */
export function demandOrPlan(demand: StorageDemand): void {
    if (!active?.goesOnPastDemands) throw demand;
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

/** The body of the function a declaration is local to; undefined at module level. */
function functionBodyOf(
    declaration: ts.Declaration | undefined,
): ts.Block | undefined {
    const owner =
        declaration && ts.findAncestor(declaration.parent, ts.isFunctionLike);
    const body = owner && "body" in owner ? owner.body : undefined;
    return body && ts.isBlock(body) ? body : undefined;
}

/**
 * The class whose instance a `this` keyword reads (its constructor, in a
 * static member): the class of the nearest member that binds `this`.
 */
function thisClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
    const member = ts.findAncestor(
        node.parent,
        (ancestor) =>
            (ts.isFunctionLike(ancestor) && !ts.isArrowFunction(ancestor)) ||
            ts.isPropertyDeclaration(ancestor) ||
            ts.isClassStaticBlockDeclaration(ancestor),
    );
    return member && ts.isClassLike(member.parent) ? member.parent : undefined;
}

/**
 * What a rolled-back `statement` would have written: the bindings it
 * declares and the roots of the targets it assigns, updates or deletes,
 * and the classes whose `this` roots one (`this.x = ...`). Undefined when
 * a target is rooted elsewhere (`f().x = ...`): a later read could not be
 * told from the omitted write.
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
            for (const { target } of writeSites(node)) {
                const root = rootIdentifier(target);
                const owner =
                    root === undefined &&
                    rootExpression(target).kind === ts.SyntaxKind.ThisKeyword
                        ? thisClass(target)
                        : undefined;
                if (root) names.push(root);
                else if (owner) classes.push(owner);
                else return true;
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
 * (`demandOrPlan`) outside a survey. Ordinary refusals
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
    /** @unjournaled Source declarations removed by a planning rollback. */
    private readonly lostDeclarations = new Set<ts.Symbol>();
    /**
     * @unjournaled The lost declarations local to a function body, by body:
     * the next activation of that body declares them afresh.
     */
    private readonly lostLocals = new Map<ts.Node, Set<ts.Symbol>>();
    /** @unjournaled Classes whose instances a planning rollback wrote through `this`. */
    private readonly lostClasses = new Set<ts.ClassLikeDeclaration>();
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
    /** @unjournaled The statement the plan began lowering last: where it ended. */
    private lowering?: ts.Statement;
    /** @unjournaled What ended the plan's work: undefined while it runs or once it returned. */
    private stop: unknown;

    /**
     * @unjournaled The replays besides storage (`replayable`) a survey's
     * plan met: the compile applies them after the plan, as a strict
     * attempt's restart would.
     */
    readonly replays: Error[] = [];

    /**
     * `survey`: whether the plan runs between a survey's strict attempts;
     * `replayable`: the replays besides storage that a survey's plan
     * records and goes on past, losing the statement that met one.
     */
    public constructor(
        checker: ts.TypeChecker,
        private readonly survey = false,
        private readonly replayable?: (error: unknown) => error is Error,
    ) {
        this.collected = new ReplayStorage(checker);
    }

    /** Whether lowering goes on past a demand that allows it (`demandOrPlan`). */
    public get goesOnPastDemands(): boolean {
        return !this.survey;
    }

    /** A demand lowering goes on without (`demandOrPlan`). */
    public planDemand(request: StorageRequest): void {
        if (this.wentOn !== undefined && this.wentOn !== request.kind)
            throw new PlanningWrite(
                `a demand of kind ${request.kind} after lowering went on past one of kind ${this.wentOn}`,
            );
        this.requireStrictSite([request]);
        this.wentOn = request.kind;
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
            this.stop = error;
            if (error instanceof StorageDemand) {
                if (this.wentOn) return undefined;
                if (this.metAtStrictSite(error.requests))
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
        this.lowering = statement;
        this.beginActivation(statement);
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
                            owner !== undefined && this.lostClasses.has(owner)
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
            if (dependent) {
                if (!this.survey)
                    throw new PlanningDependency(
                        "a statement reads what a rolled-back one lost",
                    );
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
            if (this.survey && this.replayable?.(error)) {
                this.replays.push(error);
                this.lose(context.checker, statement);
                return;
            }
            if (!(error instanceof StorageDemand)) throw error;
            if (this.wentOn)
                throw new PlanningWrite(
                    `a statement's demand after lowering went on past one of kind ${this.wentOn}`,
                );
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
                throw new PlanningWrite(
                    `a demand of kind ${error.request.kind} whose change later statements may read`,
                );
            this.lose(context.checker, statement);
        }
    }

    /**
     * Loses what a dependent demand changes the storage of: a binding,
     * parameter or class (and the function that declares it, which its
     * callers lower), or a record type. A generic signature's storage is
     * its family's, whose every later call meets the demand again and is
     * lost in turn: only the statement is. False for another request.
     */
    private loseDemanded(
        context: StatementContext,
        request: StorageRequest,
    ): boolean {
        if (request.kind === "generic") return true;
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
    private metAtStrictSite(requests: readonly StorageRequest[]): boolean {
        return (
            this.survey || !this.rolledBack || requests.every(demandsKeyOnly)
        );
    }

    /** Ends a plan whose demands strict lowering could meet elsewhere first. */
    private requireStrictSite(requests: readonly StorageRequest[]): void {
        if (this.metAtStrictSite(requests)) return;
        statistics.departed++;
        throw new PlanningStop(
            "a demand strict lowering could meet elsewhere first",
        );
    }

    /** What ended the plan and the statement it lowered then; no cause when its work returned. */
    public ended(): { cause: unknown; statement?: ts.Statement } {
        return {
            cause: this.stop,
            ...(this.lowering ? { statement: this.lowering } : {}),
        };
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
            }
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
     * are not the ones an earlier activation's rollback lost.
     */
    private beginActivation(statement: ts.Statement): void {
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
        if (!this.collected.add(request)) return;
        this.demands.push(request);
        statistics.collected++;
    }
}
