/**
 * Generation survey: lower every statement of a program past every compile
 * refusal.
 *
 * Ordinary generation stops at the first `CompileError`, which measures the
 * frontier of an entry and nothing behind it. A survey wraps every lowered
 * statement in an emission transaction; a refusal rolls that statement back,
 * is recorded here, and lowering continues with the next statement, so one
 * run lists every refusal. The variables a rolled-back statement declared
 * stay bound to empty storage of their types, so later statements lower
 * against them. A storage demand (or another replay) met at a statement
 * rolls it back too: the pass goes on, and the next pass replays with what
 * it met, until a pass meets nothing new. After the entry, every function
 * of the program's own sources no lowering reached is lowered once as a
 * root. The census is a measurement: nothing lowered under it is a
 * program, and normal generation never consults it.
 *
 * Refusals raised inside speculative probes are the probe's to decide, not
 * the survey's, and the statement lowerer stands aside while one is open.
 * Each pass replaces its realm's records. A site refusal decided after
 * lowering is recorded against the site's statement; any other refusal
 * raised outside statement lowering ends the survey as incomplete.
 */
import ts from "typescript";
import { CompileError } from "./compile-error.js";
import { declaredSymbol, resolvedSymbol } from "./symbols.js";
import { sourceLocation, syntaxKindName } from "../source-location.js";
import {
    describeStorageRequests,
    storageRequestSite,
} from "./replay-storage.js";
import { StorageDemand } from "./storage-demand.js";
import { EmissionSet } from "./emission-transaction.js";
import {
    bindingNameIdentifiers,
    reachedThroughName,
    sourceFunctionName,
    statementDeclaredNames,
} from "./syntax.js";

interface SurveySite {
    file: string;
    line: number;
    column: number;
}

interface SurveyRefusal {
    /** Where the refusal was raised, as `fail` reported it. */
    site: SurveySite;
    /** The refusal text without its location prefix. */
    message: string;
    /** The message with quoted names, numbers and parenthesised detail elided. */
    class: string;
    /** The first statement rolled back for this refusal. */
    statement: { file: string; line: number; kind: string; function: string };
    /** The refused statement that would have declared the binding this refusal names. */
    cascade?: SurveySite;
    /** How many lowerings reached this site with this message. */
    occurrences: number;
    /** Those of them inside a survey root, whose context is empty storage. */
    rootOccurrences: number;
    /** How many distinct statements those lowerings rolled back. */
    statements: number;
}

interface SurveyClass {
    class: string;
    sites: number;
    /** Sites among them that only name a binding another refusal took away. */
    cascades: number;
    occurrences: number;
    /** Those of them inside a survey root. */
    rootOccurrences: number;
    example: string;
}

export interface SurveyReport {
    schemaVersion: 1;
    /** False when an error outside statement lowering ended the survey. */
    complete: boolean;
    terminal?: string;
    /** The stack frames that raised `terminal`, innermost first: an error without a source location names its raiser. */
    terminalStack?: string[];
    /**
     * `attempted`/`refused`: statement lowerings, each copy of an inlined
     * body counted; `distinct`/`distinctRefused`: the statements they
     * were; `rooted`: the lowerings inside survey roots; `demanded`:
     * statements the last pass rolled back for a storage demand it met there.
     */
    statements: {
        attempted: number;
        distinct: number;
        rooted: number;
        refused: number;
        distinctRefused: number;
        demanded: number;
    };
    /**
     * The program's own sources once its roots began: their statements
     * (`surveyedStatement`) and those any lowering of the last pass began
     * outside a probe -- a declaration when something inside it lowered, a
     * body's last `return` when its function lowered.
     */
    program?: { files: number; statements: number; attempted: number };
    refusals: SurveyRefusal[];
    classes: SurveyClass[];
    /**
     * The storage demands the last pass met at statements, most statements
     * first: a pass limit can leave some for a next pass.
     */
    demands: SurveyDemand[];
    /** The passes that ran to their end. */
    passes: number;
    /** The statements whose own lowering took longest in the last passes, slowest first. */
    slowest: SurveyTiming[];
}

/**
 * The census a survey publishes when it ends: its last attempt's, or --
 * where an error outside statement lowering ended it (an attempt's setup
 * refused) -- that of the last pass that ran to its end, if it went
 * further, with what ended it.
 */
export function publishedSurvey(
    ended: SurveyReport,
    furthest: SurveyReport | undefined,
): SurveyReport {
    if (
        ended.complete ||
        !furthest ||
        furthest.statements.attempted <= ended.statements.attempted
    )
        return ended;
    const { terminal: _running, terminalStack: _frames, ...found } = furthest;
    return {
        ...found,
        complete: false,
        ...(ended.terminal ? { terminal: ended.terminal } : {}),
        ...(ended.terminalStack ? { terminalStack: ended.terminalStack } : {}),
    };
}

/** What a surveyed statement lowering needs from its context. */
interface StatementContext {
    readonly checker: ts.TypeChecker;
    transaction(work: () => void): void;
    refusedDemand(error: unknown): CompileError | undefined;
    bindEmptyStorage(name: ts.Identifier): boolean;
}

/** A refusal while it is being counted: the statements it rolled back, by node. */
interface Census extends SurveyRefusal {
    rolledBack: Set<ts.Statement>;
}

/** How long a statement's own lowering took, its nested statements' excluded. */
interface SurveyTiming {
    statement: { file: string; line: number; kind: string; function: string };
    selfMs: number;
    /** Its nested statements included. */
    totalMs: number;
}

/** The statements a census lists by lowering time. */
const slowestKept = 50;

/** A storage demand a pass met at a statement, which it rolled back: the next pass replays with it. */
interface SurveyDemand {
    /** What the demand asks for (`describeStorageRequests`). */
    demand: string;
    /** Where it rose: the declaration it retypes or the node a record demand rose at. */
    site?: string;
    statement: { file: string; line: number; kind: string; function: string };
    /** How many distinct statements it rolled back. */
    statements: number;
}

/** One compile attempt (a pass) of one realm; the realm's next pass replaces it. */
interface Attempt {
    attempted: number;
    refusals: Map<string, Census>;
    /** Bindings the rolled-back statements would have declared, by symbol. */
    declarations: Map<ts.Symbol, SurveySite>;
    /** The replays (storage demands among them) this pass met at statements, for the next pass. */
    replays: Error[];
    /** Those demands by description, with the statements they rolled back. */
    demands: Map<string, SurveyDemand & { rolledBack: Set<ts.Statement> }>;
    /** Every statement a lowering of this attempt began, probes included. */
    touched: Set<ts.Statement>;
    /** The functions whose bodies this attempt lowered outside a probe. */
    lowered: Set<ts.Node>;
    /** The statement lowerings inside survey roots. */
    rooted: number;
    /** Whether the attempt lowered every statement: what follows settles the program. */
    settling: boolean;
    /** The statements whose own lowering took longest, slowest first. */
    slowest: SurveyTiming[];
    /** The statements a lowering of this attempt began outside a probe. */
    distinct: Set<ts.Statement>;
    /**
     * Those a probe began: journaled, so a probe that rolls back takes
     * its statements away and a committed one keeps them.
     */
    probed: EmissionSet<ts.Statement>;
}

/**
 * The variables and parameters of enclosing functions that `declaration`
 * reads, by their declared names: what a survey root binds besides its
 * parameters.
 */
export function capturedFunctionLocals(
    checker: ts.TypeChecker,
    declaration: ts.Node,
): ts.Identifier[] {
    const found = new Map<ts.Symbol, ts.Identifier>();
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
            const symbol = resolvedSymbol(checker, node);
            const local = symbol?.valueDeclaration;
            if (
                symbol &&
                local &&
                (ts.isVariableDeclaration(local) ||
                    ts.isParameter(local) ||
                    ts.isBindingElement(local)) &&
                ts.isIdentifier(local.name) &&
                !ts.findAncestor(local, (owner) => owner === declaration) &&
                ts.findAncestor(local.parent, ts.isFunctionLike)
            )
                found.set(symbol, local.name);
        }
        ts.forEachChild(node, visit);
    };
    visit(declaration);
    return [...found.values()];
}

/**
 * A statement the census counts: any but a block, which only groups the
 * statements it holds, and declarations that lower to nothing (interfaces,
 * type aliases, imports, exports).
 */
export function surveyedStatement(node: ts.Node): node is ts.Statement {
    return (
        ts.isStatement(node) &&
        !ts.isBlock(node) &&
        !ts.isInterfaceDeclaration(node) &&
        !ts.isTypeAliasDeclaration(node) &&
        !ts.isImportDeclaration(node) &&
        !ts.isExportDeclaration(node)
    );
}

/**
 * The statements a compound statement runs, and the names its header binds
 * for them: none for a simple statement or a declaration.
 */
function heldStatements(statement: ts.Statement): {
    names: ts.Identifier[];
    statements: ts.Statement[];
} {
    const declared = (node: ts.Node | undefined): ts.Identifier[] =>
        node && ts.isVariableDeclarationList(node)
            ? node.declarations.flatMap((declaration) =>
                  bindingNameIdentifiers(declaration.name),
              )
            : [];
    if (ts.isIfStatement(statement))
        return {
            names: [],
            statements: [
                statement.thenStatement,
                ...(statement.elseStatement ? [statement.elseStatement] : []),
            ],
        };
    if (
        ts.isForOfStatement(statement) ||
        ts.isForInStatement(statement) ||
        ts.isForStatement(statement)
    )
        return {
            names: declared(statement.initializer),
            statements: [statement.statement],
        };
    if (
        ts.isWhileStatement(statement) ||
        ts.isDoStatement(statement) ||
        ts.isLabeledStatement(statement)
    )
        return { names: [], statements: [statement.statement] };
    if (ts.isTryStatement(statement)) {
        const variable = statement.catchClause?.variableDeclaration;
        return {
            names: variable ? bindingNameIdentifiers(variable.name) : [],
            statements: [
                statement.tryBlock,
                ...(statement.catchClause ? [statement.catchClause.block] : []),
                ...(statement.finallyBlock ? [statement.finallyBlock] : []),
            ],
        };
    }
    if (ts.isSwitchStatement(statement))
        return {
            names: [],
            statements: statement.caseBlock.clauses.flatMap((clause) => [
                ...clause.statements,
            ]),
        };
    if (ts.isBlock(statement))
        return { names: [], statements: [...statement.statements] };
    return { names: [], statements: [] };
}

/** The message shape: names, numbers and parenthesised detail elided. */
export function refusalClass(message: string): string {
    return message
        .replace(/'[^']*'/g, "'…'")
        .replace(/"[^"]*"/g, '"…"')
        .replace(/\([^()]*\)/g, "(…)")
        .replace(/\b\d+(?:\.\d+)?\b/g, "N");
}

function enclosingFunctionName(statement: ts.Statement): string {
    const owner = ts.findAncestor(
        statement.parent,
        (node) => ts.isFunctionLike(node) || ts.isSourceFile(node),
    );
    return owner && ts.isFunctionLike(owner)
        ? (sourceFunctionName(owner) ?? "<anonymous>")
        : "<module>";
}

/**
 * What stopped an attempt or a plan, and where: what its storage demand
 * asks for and the site it rose at, else the statement lowering then.
 */
function describeStop(cause: unknown, lowering: ts.Node | undefined): string {
    const text =
        cause instanceof StorageDemand
            ? `${cause.constructor.name}: ${describeStorageRequests(cause.requests)}`
            : cause instanceof Error
              ? `${cause.constructor.name}: ${cause.message}`
              : String(cause);
    const demanded =
        cause instanceof StorageDemand
            ? cause.requests.map(storageRequestSite).find(Boolean)
            : undefined;
    const node = typeof demanded === "object" ? demanded : lowering;
    const site =
        typeof demanded === "string"
            ? demanded
            : node &&
              `${sourceLocation(node).file.fileName}:${sourceLocation(node).line}`;
    return (
        text.replace(/\s+/g, " ").slice(0, 160) + (site ? ` at ${site}` : "")
    );
}

/** How a survey reports while it runs: a line at most every `intervalMs`. */
export interface SurveyProgress {
    readonly report: (line: string) => void;
    readonly intervalMs: number;
    /**
     * Receives the census as it stands, marked incomplete: with each
     * progress line and after each pass that met demands. A survey stopped
     * early leaves what it had found.
     */
    readonly census?: (report: SurveyReport) => void;
}

export class SurveyCollector {
    /** @unjournaled The census counts refusals a rollback discards too. */
    private readonly realms = new Map<string, Attempt>();
    /** @unjournaled The census counts refusals a rollback discards too. */
    private current: Attempt | undefined;
    /** @unjournaled When the last progress line was reported. */
    private reportedAt = Date.now();
    /** @unjournaled Compile attempts so far: each restart replays the program. */
    private attempts = 0;
    /** @unjournaled What ended the last attempt that restarted, and where. */
    private restart: string | undefined;
    /** @unjournaled The statement lowering began last: where a restart's demand rose. */
    private lowering: ts.Statement | undefined;
    /** @unjournaled Whether a survey root is lowering: its context is empty storage. */
    private inRoot = false;
    /** @unjournaled The statement lowering now: when it began, and its nested statements' time. */
    private timing: { started: number; nested: number } | undefined;
    /** @unjournaled The program's own sources (`SurveyReport.program`). */
    private programFiles: readonly ts.SourceFile[] = [];

    /** @unjournaled The passes that ran to their end. */
    private passes = 0;
    /** @unjournaled The census of the last pass that ran to its end (`publishedSurvey`). */
    private furthest: SurveyReport | undefined;

    /**
     * `replayable`: the replays besides storage a compile applies before its
     * next attempt (a lazy module's activation, runtime query state), which
     * a pass meets at a statement as it meets a storage demand;
     * `passLimit`: the most passes the survey runs.
     */
    public constructor(
        private readonly progress?: SurveyProgress,
        private readonly replayable?: (error: unknown) => error is Error,
        private readonly passLimit?: number,
    ) {}

    /**
     * A progress line once `intervalMs` passed: the lowerings and refused
     * statements counted so far, and the statement starting to lower.
     */
    private reportProgress(statement: ts.Statement): void {
        if (!this.progress) return;
        const now = Date.now();
        if (now - this.reportedAt < this.progress.intervalMs) return;
        this.reportedAt = now;
        let attempted = 0;
        const refused = new Set<ts.Statement>();
        for (const attempt of this.realms.values()) {
            attempted += attempt.attempted;
            for (const census of attempt.refusals.values())
                for (const rolledBack of census.rolledBack)
                    refused.add(rolledBack);
        }
        const location = sourceLocation(statement);
        const line =
            `Survey progress: attempt ${this.attempts}, ${attempted} statement lowerings, ${refused.size} refused; lowering ` +
            `${location.file.fileName}:${location.line} (${enclosingFunctionName(statement)})` +
            (this.restart ? `; last restart: ${this.restart}` : "");
        this.progress.report(line);
        this.leaveCensus(line);
    }

    /** Hands out the census as it stands, marked incomplete with what is running. */
    private leaveCensus(running: string): void {
        this.progress?.census?.({
            ...this.report(),
            complete: false,
            terminal: `Survey still running: ${running}`,
        });
    }

    /**
     * Records what ended an attempt that restarts the program: where its
     * storage demand rose, else the statement lowering then.
     */
    public restarted(cause: unknown): void {
        this.restart = describeStop(cause, this.lowering);
        this.progress?.report(
            `Survey restart after attempt ${this.attempts}: ${this.restart}`,
        );
    }

    /**
     * Whether this attempt already lowered `declaration`'s body outside a
     * probe; a lowering outside a probe that answers false lowers it now.
     */
    public loweredBefore(declaration: ts.Node, speculating: boolean): boolean {
        const lowered = this.current?.lowered;
        if (!lowered) return false;
        if (lowered.has(declaration)) return true;
        if (!speculating) lowered.add(declaration);
        return false;
    }

    /**
     * Lowers a function the program never reached as a root (`lower`),
     * recorded against its body's first statement; what it reaches counts
     * as a root's.
     */
    public attemptRoot(
        context: StatementContext,
        body: ts.Block,
        lower: () => void,
    ): void {
        const enclosing = this.inRoot;
        this.inRoot = true;
        try {
            this.attemptStatement(context, body.statements[0]!, lower);
        } finally {
            this.inRoot = enclosing;
        }
    }

    /** Counts the program's own sources, whose every function the survey lowers. */
    public programSources(files: readonly ts.SourceFile[]): void {
        this.programFiles = files;
    }

    /** `SurveyReport.program`, from the statements and functions the realms' last passes lowered. */
    private programReport(): NonNullable<SurveyReport["program"]> {
        const distinct = new Set<ts.Node>();
        const lowered = new Set<ts.Node>();
        for (const attempt of this.realms.values()) {
            for (const statement of attempt.distinct) distinct.add(statement);
            for (const statement of attempt.probed) distinct.add(statement);
            for (const declaration of attempt.lowered) lowered.add(declaration);
        }
        const functionLowered = (node: ts.Node): boolean =>
            lowered.has(node) ||
            (ts.isFunctionLike(node) &&
                "body" in node &&
                node.body !== undefined &&
                ts.isBlock(node.body) &&
                node.body.statements.some((statement) =>
                    distinct.has(statement),
                ));
        let statements = 0;
        let attempted = 0;
        // Whether anything in `node` lowered.
        const visit = (node: ts.Node): boolean => {
            let inside = lowered.has(node);
            ts.forEachChild(node, (child) => {
                if (visit(child)) inside = true;
            });
            if (!surveyedStatement(node)) return inside || distinct.has(node);
            statements++;
            const owner = ts.isBlock(node.parent)
                ? node.parent.parent
                : undefined;
            if (
                distinct.has(node) ||
                ((ts.isFunctionDeclaration(node) ||
                    ts.isClassDeclaration(node)) &&
                    inside) ||
                (ts.isReturnStatement(node) &&
                    owner !== undefined &&
                    ts.isFunctionLike(owner) &&
                    functionLowered(owner))
            ) {
                attempted++;
                return true;
            }
            return inside;
        };
        for (const file of this.programFiles) visit(file);
        return { files: this.programFiles.length, statements, attempted };
    }

    /** Notes that the current attempt lowered every statement it will. */
    public settle(): void {
        if (this.current) this.current.settling = true;
    }

    /** Whether the realm's last attempt lowered every statement before it ended. */
    public settling(realm: string): boolean {
        return this.realms.get(realm)?.settling ?? false;
    }

    /** Notes that a lowering began `statement`, inside a probe or not. */
    public touch(statement: ts.Statement, speculating: boolean): void {
        const attempt = this.current;
        if (!attempt) return;
        attempt.touched.add(statement);
        (speculating ? attempt.probed : attempt.distinct).add(statement);
    }

    /**
     * Whether no lowering of this attempt began a statement of `body`: a
     * function the program never reached, which the survey lowers as a root.
     */
    public untouched(body: ts.Block): boolean {
        const touched = this.current?.touched;
        return (
            touched !== undefined &&
            body.statements.every((statement) => !touched.has(statement))
        );
    }

    /** Runs one realm's compile attempt, replacing the census a previous attempt of that realm left. */
    public attempt<T>(realm: string, run: () => T): T {
        this.attempts++;
        const previous = this.current;
        const attempt: Attempt = {
            attempted: 0,
            refusals: new Map(),
            declarations: new Map(),
            replays: [],
            demands: new Map(),
            touched: new Set(),
            lowered: new Set(),
            rooted: 0,
            settling: false,
            slowest: [],
            distinct: new Set(),
            probed: new EmissionSet(),
        };
        this.realms.set(realm, attempt);
        this.current = attempt;
        try {
            return run();
        } finally {
            this.current = previous;
        }
    }

    /** Lowers one statement under a transaction; a refusal rolls it back and is recorded. */
    public attemptStatement(
        context: StatementContext,
        statement: ts.Statement,
        lower: () => void,
        lowerNested?: (nested: ts.Statement) => void,
    ): void {
        const attempt = this.current;
        if (!attempt) {
            lower();
            return;
        }
        attempt.attempted++;
        if (this.inRoot) attempt.rooted++;
        this.lowering = statement;
        this.reportProgress(statement);
        const timing = { started: performance.now(), nested: 0 };
        const enclosing = this.timing;
        this.timing = timing;
        try {
            context.transaction(lower);
            return;
        } catch (error) {
            // A demand its replay refused is the statement's refusal; any
            // other demand rolls its statement back for the next pass.
            const refusal =
                error instanceof CompileError
                    ? error
                    : context.refusedDemand(error);
            if (refusal)
                this.record(attempt, context.checker, statement, refusal);
            else if (error instanceof StorageDemand || this.replayable?.(error))
                this.demanded(attempt, statement, error);
            else throw error;
        } finally {
            this.timing = enclosing;
            const elapsed = performance.now() - timing.started;
            if (enclosing) enclosing.nested += elapsed;
            this.timed(attempt, statement, elapsed - timing.nested, elapsed);
        }
        // The variables it declared stay bound, to empty storage of their
        // types: later statements lower against them instead of cascading.
        for (const name of statementDeclaredNames(statement)) {
            const declaration = declaredSymbol(
                context.checker,
                name,
            )?.valueDeclaration;
            if (
                declaration &&
                (ts.isVariableDeclaration(declaration) ||
                    ts.isBindingElement(declaration))
            )
                context.bindEmptyStorage(name);
        }
        if (lowerNested)
            this.lowerHeld(context, attempt, statement, lowerNested);
    }

    /**
     * A rolled-back compound statement's own statements, which its rollback
     * left unlowered: each is lowered on its own, the names its header binds
     * (a loop's variables, a catch variable) holding empty storage, counted
     * with the roots as context the survey rebuilt.
     */
    private lowerHeld(
        context: StatementContext,
        attempt: Attempt,
        statement: ts.Statement,
        lowerNested: (nested: ts.Statement) => void,
    ): void {
        const held = heldStatements(statement);
        const unlowered = held.statements.filter(
            (nested) =>
                !attempt.distinct.has(nested) &&
                !(
                    ts.isBlock(nested) &&
                    nested.statements.some((inner) =>
                        attempt.distinct.has(inner),
                    )
                ),
        );
        if (unlowered.length === 0) return;
        const enclosing = this.inRoot;
        this.inRoot = true;
        try {
            for (const name of held.names) context.bindEmptyStorage(name);
            for (const nested of unlowered) lowerNested(nested);
        } finally {
            this.inRoot = enclosing;
        }
    }

    /** Keeps `statement` among the attempt's slowest by its own lowering time. */
    private timed(
        attempt: Attempt,
        statement: ts.Statement,
        selfMs: number,
        totalMs: number,
    ): void {
        const slowest = attempt.slowest;
        if (
            slowest.length >= slowestKept &&
            selfMs <= slowest[slowest.length - 1]!.selfMs
        )
            return;
        const location = sourceLocation(statement);
        slowest.push({
            statement: {
                file: location.file.fileName,
                line: location.line,
                kind: syntaxKindName(statement.kind),
                function: enclosingFunctionName(statement),
            },
            selfMs: Math.round(selfMs),
            totalMs: Math.round(totalMs),
        });
        slowest.sort((a, b) => b.selfMs - a.selfMs);
        if (slowest.length > slowestKept) slowest.pop();
    }

    private demanded(
        attempt: Attempt,
        statement: ts.Statement,
        replay: Error,
    ): void {
        attempt.replays.push(replay);
        const described =
            replay instanceof StorageDemand
                ? describeStorageRequests(replay.requests)
                : `${replay.constructor.name}: ${replay.message}`;
        let census = attempt.demands.get(described);
        if (!census) {
            const location = sourceLocation(statement);
            const site =
                replay instanceof StorageDemand
                    ? replay.requests.map(storageRequestSite).find(Boolean)
                    : undefined;
            census = {
                demand: described,
                ...(site
                    ? {
                          site:
                              typeof site === "string"
                                  ? site
                                  : `${sourceLocation(site).file.fileName}:${sourceLocation(site).line}`,
                      }
                    : {}),
                statement: {
                    file: location.file.fileName,
                    line: location.line,
                    kind: syntaxKindName(statement.kind),
                    function: enclosingFunctionName(statement),
                },
                statements: 0,
                rolledBack: new Set(),
            };
            attempt.demands.set(described, census);
        }
        census.rolledBack.add(statement);
    }

    /** The replays the realm's last pass met at its statements. */
    public replaysOf(realm: string): readonly Error[] {
        return this.realms.get(realm)?.replays ?? [];
    }

    /** Reports a pass that met demands: the next pass replays with the `added` ones. */
    /**
     * Ends a pass that `added` demands for the next one: whether the next
     * runs. A pass that added none is the last, as is the one that reaches
     * the pass limit; its census keeps the demands left.
     */
    public passEnded(added: number): boolean {
        this.passes++;
        this.furthest = this.report();
        if (added === 0) return false;
        const demands = `${added} demand${added === 1 ? "" : "s"}`;
        if (this.passLimit !== undefined && this.passes >= this.passLimit) {
            this.progress?.report(
                `Survey pass ${this.passes}: ${demands} left; the pass limit ends the survey here`,
            );
            return false;
        }
        const line = `Survey pass ${this.passes}: ${demands} added for the next pass`;
        this.progress?.report(line);
        this.leaveCensus(line);
        return true;
    }

    /**
     * Records a refusal decided after `statement` lowered (a check at the
     * end of the realm naming its site); outside an attempt it stands.
     */
    public refuseLowered(
        checker: ts.TypeChecker,
        statement: ts.Statement,
        error: CompileError,
    ): void {
        if (!this.current) throw error;
        this.record(this.current, checker, statement, error);
    }

    private record(
        attempt: Attempt,
        checker: ts.TypeChecker,
        statement: ts.Statement,
        error: CompileError,
    ): void {
        let census = attempt.refusals.get(error.message);
        if (!census) {
            const location = sourceLocation(statement);
            census = {
                site: {
                    file: error.fileName,
                    line: error.line,
                    column: error.column,
                },
                message: error.detail,
                class: refusalClass(error.detail),
                statement: {
                    file: location.file.fileName,
                    line: location.line,
                    kind: syntaxKindName(statement.kind),
                    function: enclosingFunctionName(statement),
                },
                occurrences: 0,
                rootOccurrences: 0,
                statements: 0,
                rolledBack: new Set(),
            };
            const cascade = this.cascadeOf(attempt, checker, error);
            if (cascade) census.cascade = cascade;
            attempt.refusals.set(error.message, census);
        }
        census.occurrences++;
        if (this.inRoot) census.rootOccurrences++;
        if (census.rolledBack.has(statement)) return;
        census.rolledBack.add(statement);
        // Every statement this refusal rolled back loses its declarations,
        // whichever caller reached the site first.
        for (const name of statementDeclaredNames(statement)) {
            const symbol = declaredSymbol(checker, name);
            if (symbol && !attempt.declarations.has(symbol))
                attempt.declarations.set(symbol, census.site);
        }
    }

    /**
     * A refusal raised at a name that a refused statement would have
     * declared, or at a member, element or call reached through that name
     * (`splash.setProgress` once `splash` is gone).
     */
    private cascadeOf(
        attempt: Attempt,
        checker: ts.TypeChecker,
        error: CompileError,
    ): SurveySite | undefined {
        const subject = error.subject;
        if (!subject || attempt.declarations.size === 0) return undefined;
        const root = reachedThroughName(subject);
        const symbol = root && declaredSymbol(checker, root);
        return symbol ? attempt.declarations.get(symbol) : undefined;
    }

    /** The census the survey publishes when it ends (`publishedSurvey`). */
    public published(terminal?: Error): SurveyReport {
        return publishedSurvey(this.report(terminal), this.furthest);
    }

    public report(terminal?: Error): SurveyReport {
        const merged = new Map<string, Census>();
        const demanded = new Set<ts.Statement>();
        const demands: SurveyDemand[] = [];
        let attempted = 0;
        let rooted = 0;
        const distinct = new Set<ts.Statement>();
        for (const attempt of this.realms.values()) {
            rooted += attempt.rooted;
            for (const statement of attempt.distinct) distinct.add(statement);
            for (const statement of attempt.probed) distinct.add(statement);
            for (const { rolledBack, ...demand } of attempt.demands.values()) {
                for (const statement of rolledBack) demanded.add(statement);
                demands.push({ ...demand, statements: rolledBack.size });
            }
            attempted += attempt.attempted;
            for (const [key, census] of attempt.refusals) {
                const existing = merged.get(key);
                if (!existing) {
                    merged.set(key, {
                        ...census,
                        rolledBack: new Set(census.rolledBack),
                    });
                } else {
                    existing.occurrences += census.occurrences;
                    existing.rootOccurrences += census.rootOccurrences;
                    for (const statement of census.rolledBack)
                        existing.rolledBack.add(statement);
                }
            }
        }
        const refusals = [...merged.values()]
            .map(({ rolledBack, ...refusal }): SurveyRefusal => ({
                ...refusal,
                statements: rolledBack.size,
            }))
            .sort(
                (a, b) =>
                    a.site.file.localeCompare(b.site.file) ||
                    a.site.line - b.site.line ||
                    a.site.column - b.site.column,
            );
        const classes = new Map<string, SurveyClass>();
        for (const refusal of refusals) {
            const entry = classes.get(refusal.class) ?? {
                class: refusal.class,
                sites: 0,
                cascades: 0,
                occurrences: 0,
                rootOccurrences: 0,
                example: refusal.message,
            };
            entry.sites++;
            if (refusal.cascade) entry.cascades++;
            entry.occurrences += refusal.occurrences;
            entry.rootOccurrences += refusal.rootOccurrences;
            classes.set(refusal.class, entry);
        }
        return {
            schemaVersion: 1,
            complete: terminal === undefined,
            ...(terminal === undefined
                ? {}
                : {
                      terminal: terminal.message,
                      terminalStack: (terminal.stack ?? "")
                          .split("\n")
                          .map((line) => line.trim())
                          .filter((line) => line.startsWith("at "))
                          .slice(0, 12),
                  }),
            statements: {
                attempted,
                distinct: distinct.size,
                rooted,
                refused: refusals.reduce(
                    (count, refusal) => count + refusal.occurrences,
                    0,
                ),
                distinctRefused: new Set(
                    [...merged.values()].flatMap((census) => [
                        ...census.rolledBack,
                    ]),
                ).size,
                demanded: demanded.size,
            },
            ...(this.programFiles.length > 0
                ? { program: this.programReport() }
                : {}),
            refusals,
            classes: [...classes.values()].sort(
                (a, b) =>
                    b.sites - a.sites ||
                    b.occurrences - a.occurrences ||
                    a.class.localeCompare(b.class),
            ),
            demands: demands.sort(
                (a, b) =>
                    b.statements - a.statements ||
                    a.demand.localeCompare(b.demand),
            ),
            passes: this.passes,
            slowest: [...this.realms.values()]
                .flatMap((attempt) => attempt.slowest)
                .sort((a, b) => b.selfMs - a.selfMs)
                .slice(0, slowestKept),
        };
    }
}

/** Ends a survey whose last pass the pass limit stopped before its program settled. */
export class SurveyPassLimit extends Error {}

let active: SurveyCollector | undefined;

/** The survey the current compile reports to, if any. */
export function activeSurvey(): SurveyCollector | undefined {
    return active;
}

/** Opt-in measurement only: restores the previous survey afterwards. */
export function withSurvey<T>(collector: SurveyCollector, run: () => T): T {
    const previous = active;
    active = collector;
    try {
        return run();
    } finally {
        active = previous;
    }
}
