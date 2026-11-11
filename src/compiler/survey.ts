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
import { declaredSymbol } from "./symbols.js";
import { sourceLocation, syntaxKindName } from "../source-location.js";
import {
    describeStorageRequests,
    storageRequestSite,
} from "./replay-storage.js";
import { StorageDemand } from "./storage-demand.js";
import { EmissionSet, EmissionTransaction } from "./emission-transaction.js";
import { keepingCoverage } from "./source-coverage.js";
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

/** A statement of the census: where it is, its kind and the function holding it. */
interface SurveyStatement {
    file: string;
    line: number;
    kind: string;
    function: string;
}

/** The program's own sources and the statements they hold (`surveyedStatement`). */
interface SurveyProgram {
    files: number;
    statements: readonly ts.Statement[];
}

interface SurveyRefusal {
    /** Where the refusal was raised, as `fail` reported it. */
    site: SurveySite;
    /** The refusal text without its location prefix. */
    message: string;
    /** The message with quoted names, numbers and parenthesised detail elided. */
    class: string;
    /** The first statement rolled back for this refusal. */
    statement: SurveyStatement;
    /** The refused statement that would have declared the binding this refusal names. */
    cascade?: SurveySite;
    /** How many lowerings reached this site with this message. */
    occurrences: number;
    /** Those of them inside a survey root, whose context is empty storage. */
    rootOccurrences: number;
    /** How many distinct statements those lowerings rolled back. */
    statements: number;
    /** Those statements, as `file:line`, in the order rolled back. */
    rolledBackAt: string[];
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
    program?: {
        files: number;
        statements: number;
        attempted: number;
        /** The functions (or modules) holding the most statements no lowering tried, most first. */
        untried: SurveyUntried[];
    };
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
    bindEmptyStorage(name: ts.Identifier): void;
}

/** A refusal while it is being counted: the statements it rolled back, by node. */
interface Census extends Omit<SurveyRefusal, "rolledBackAt"> {
    rolledBack: Set<ts.Statement>;
}

/** How long a statement's own lowering took, its nested statements' excluded. */
interface SurveyTiming {
    statement: SurveyStatement;
    selfMs: number;
    /** Its nested statements included. */
    totalMs: number;
}

/** The statements a census lists by lowering time. */
const slowestKept = 50;

/** A function, or a module's top level, holding statements no lowering of the last passes tried. */
interface SurveyUntried {
    /** Its name, as a census statement names its function. */
    function: string;
    /** Where it is declared (for a module, its first untried statement). */
    at: string;
    kind: string;
    statements: number;
}

/** The functions a census lists by untried statements. */
const untriedKept = 200;

/** A storage demand a pass met at a statement, which it rolled back: the next pass replays with it. */
interface SurveyDemand {
    /** What the demand asks for (`describeStorageRequests`). */
    demand: string;
    /** Where it rose: the declaration it retypes or the node a record demand rose at. */
    site?: string;
    statement: SurveyStatement;
    /** How many distinct statements it rolled back. */
    statements: number;
    /** Those statements, as `file:line`, in the order rolled back. */
    rolledBackAt: string[];
    /**
     * The storage held the demand before this pass took any: raised again,
     * it does not settle by replay, and in a pass that took none it is the
     * statement's failure.
     */
    held?: true;
}

/** One compile attempt (a pass) of one realm; the realm's next pass replaces it. */
interface Attempt {
    attempted: number;
    refusals: Map<string, Census>;
    /** Bindings the rolled-back statements would have declared, by symbol. */
    declarations: Map<ts.Symbol, SurveySite>;
    /** The replays (storage demands among them) this pass met at statements, for the next pass. */
    replays: Error[];
    /** Those demands by what they ask for and where they rose, with the statements they rolled back. */
    demands: Map<
        string,
        Omit<SurveyDemand, "rolledBackAt"> & { rolledBack: Set<ts.Statement> }
    >;
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
     * The storage demands it took at once (`SurveyCollector.attempt`), by
     * what they ask for: what it lowered before one can stand on storage
     * the demand changed (a layout already built), so a next pass lowers
     * everything with them, and the census is exact once a pass takes none.
     */
    taken: Set<string>;
    /**
     * Those a probe began: journaled, so a probe that rolls back takes
     * its statements away and a committed one keeps them.
     */
    probed: EmissionSet<ts.Statement>;
    /** Those the roots' committed probes began, which the roots' rollback takes from `probed`. */
    rootProbes: Set<ts.Statement>;
}

/**
 * A statement the census counts: any but a block, which only groups the
 * statements it holds, and declarations that lower to nothing (interfaces,
 * type aliases, imports, exports, ambient declarations).
 */
export function surveyedStatement(node: ts.Node): node is ts.Statement {
    return (
        ts.isStatement(node) &&
        !(
            ts.canHaveModifiers(node) &&
            ts
                .getModifiers(node)
                ?.some(
                    (modifier) =>
                        modifier.kind === ts.SyntaxKind.DeclareKeyword,
                )
        ) &&
        !ts.isBlock(node) &&
        !ts.isInterfaceDeclaration(node) &&
        !ts.isTypeAliasDeclaration(node) &&
        !ts.isImportDeclaration(node) &&
        !ts.isExportDeclaration(node)
    );
}

/**
 * Whether `statement` is a `return` of a function's own body: it lowers as
 * the function's result, not as a statement of its own, so the lowering of
 * its function tries it.
 */
export function isBodyReturn(statement: ts.Statement): boolean {
    const body = statement.parent;
    return (
        ts.isReturnStatement(statement) &&
        ts.isBlock(body) &&
        ts.isFunctionLike(body.parent)
    );
}

/**
 * The statements a compound statement runs, and the names its header binds
 * for them: none for a simple statement or a declaration.
 */
export function heldStatements(statement: ts.Statement): {
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

/** The function holding `statement`, or its module. */
function censusOwner(statement: ts.Statement): ts.Node {
    return ts.findAncestor(
        statement.parent,
        (node) => ts.isFunctionLike(node) || ts.isSourceFile(node),
    )!;
}

/** A census owner's name: its function's, `<anonymous>`, or `<module>`. */
function ownerName(owner: ts.Node): string {
    return ts.isFunctionLike(owner)
        ? (sourceFunctionName(owner) ?? "<anonymous>")
        : "<module>";
}

function enclosingFunctionName(statement: ts.Statement): string {
    return ownerName(censusOwner(statement));
}

/** `statement` as the census names it. */
function censusStatement(statement: ts.Statement): SurveyStatement {
    const location = sourceLocation(statement);
    return {
        file: location.file.fileName,
        line: location.line,
        kind: syntaxKindName(statement.kind),
        function: enclosingFunctionName(statement),
    };
}

/** What a replay asks for: a storage demand's requests, else the replay itself. */
function replayText(replay: Error): string {
    return replay instanceof StorageDemand
        ? describeStorageRequests(replay.requests)
        : `${replay.constructor.name}: ${replay.message}`;
}

/** `node` as `file:line`. */
function nodeSite(node: ts.Node): string {
    const location = sourceLocation(node);
    return `${location.file.fileName}:${location.line}`;
}

/** What a census lists of the statements a refusal or demand rolled back. */
function rolledBackCensus(rolledBack: ReadonlySet<ts.Statement>): {
    statements: number;
    rolledBackAt: string[];
} {
    return {
        statements: rolledBack.size,
        rolledBackAt: [...rolledBack].map(nodeSite),
    };
}

/** Where a storage demand rose: a node as `file:line`, or a signature site. */
function replaySite(replay: unknown): string | undefined {
    if (!(replay instanceof StorageDemand)) return undefined;
    const site = replay.requests.map(storageRequestSite).find(Boolean);
    return typeof site === "object" ? nodeSite(site) : site;
}

/** What restarted an attempt, and where its storage demand rose. */
function describeStop(cause: unknown): string {
    const text =
        cause instanceof StorageDemand
            ? `${cause.constructor.name}: ${replayText(cause)}`
            : cause instanceof Error
              ? replayText(cause)
              : String(cause);
    const site = replaySite(cause);
    return (
        text.replace(/\s+/g, " ").slice(0, 160) + (site ? ` at ${site}` : "")
    );
}

/** How a survey runs: what it reports as it goes, and the most passes it runs. */
export interface SurveySettings {
    readonly progress?: SurveyProgress;
    readonly passLimit?: number;
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
    /** @unjournaled Whether a survey root is lowering: its context is empty storage. */
    private inRoot = false;
    /** @unjournaled The statement lowering now: when it began, and its nested statements' time. */
    private timing: { started: number; nested: number } | undefined;
    /** @unjournaled The program's own sources and their statements (`SurveyReport.program`). */
    private program: SurveyProgram | undefined;

    /** @unjournaled The passes that ran to their end. */
    private passes = 0;
    /** @unjournaled The census of the last pass that ran to its end (`publishedSurvey`). */
    private furthest: SurveyReport | undefined;

    private readonly progress: SurveyProgress | undefined;
    private readonly passLimit: number | undefined;
    /** @unjournaled Takes a storage demand into the storage the running attempt lowers with. */
    private apply: ((demand: StorageDemand) => boolean) | undefined;

    /**
     * `replayable`: the replays a compile applies before its next attempt
     * (a storage demand, a lazy module's activation, runtime query state),
     * which a pass meets at a statement.
     */
    public constructor(
        settings: SurveySettings = {},
        private readonly replayable?: (error: unknown) => error is Error,
    ) {
        this.progress = settings.progress;
        this.passLimit = settings.passLimit;
    }

    /**
     * A progress line once `intervalMs` passed: the lowerings and refused
     * statements counted so far, and the statement starting to lower.
     */
    private reportProgress(statement: ts.Statement): void {
        if (!this.progress) return;
        const now = Date.now();
        if (now - this.reportedAt < this.progress.intervalMs) return;
        this.reportedAt = now;
        const census = this.report();
        const lowering = censusStatement(statement);
        const line =
            `Survey progress: attempt ${this.attempts}, ${census.statements.attempted} statement lowerings, ` +
            `${census.statements.distinctRefused} refused; lowering ${lowering.file}:${lowering.line} (${lowering.function})` +
            (this.restart ? `; last restart: ${this.restart}` : "");
        this.progress.report(line);
        this.leaveCensus(line, census);
    }

    /** Hands out `census`, marked incomplete with what is running. */
    private leaveCensus(running: string, census: SurveyReport): void {
        if (!this.progress?.census) return;
        // A later pass still short of the last full one leaves that pass's.
        this.progress.census(
            publishedSurvey(
                {
                    ...census,
                    complete: false,
                    terminal: `Survey still running: ${running}`,
                },
                this.furthest,
            ),
        );
    }

    /** Records what ended an attempt that restarts the program, and where its storage demand rose. */
    public restarted(cause: unknown): void {
        this.restart = describeStop(cause);
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
     * Lowers code the program never reached as a root (`lower`), recorded
     * against its first statement; what it reaches counts as a root's.
     */
    public attemptRoot(
        context: StatementContext,
        first: ts.Statement,
        lower: () => void,
    ): void {
        this.inRoots(() => this.attemptStatement(context, first, lower));
    }

    /**
     * Runs the survey roots (`work`) with what they reach -- a feature, a
     * layout, a registration, none of them the program's -- rolled back,
     * keeping the statements their committed probes began and the sites
     * they lowered. The storage demands they meet stay in the replay
     * storage the next pass lowers with.
     */
    public rollingBack(work: () => void): void {
        new EmissionTransaction().run(
            () => {
                keepingCoverage(work);
                const attempt = this.current;
                if (attempt)
                    for (const statement of attempt.probed)
                        attempt.rootProbes.add(statement);
            },
            () => false,
        );
    }

    /** Runs `work` counted as a root's: its context is the one the survey built. */
    public inRoots(work: () => void): void {
        const enclosing = this.inRoot;
        this.inRoot = true;
        try {
            work();
        } finally {
            this.inRoot = enclosing;
        }
    }

    /** Whether no lowering of this attempt began `statement`, inside a probe or not. */
    public unbegun(statement: ts.Statement): boolean {
        const attempt = this.current;
        return attempt !== undefined && !attempt.touched.has(statement);
    }

    /** Lists the program's own sources' statements once, for `SurveyReport.program`. */
    public programSources(files: readonly ts.SourceFile[]): void {
        if (this.program) return;
        const statements: ts.Statement[] = [];
        const visit = (node: ts.Node): void => {
            if (surveyedStatement(node)) statements.push(node);
            ts.forEachChild(node, visit);
        };
        for (const file of files) visit(file);
        this.program = { files: files.length, statements };
    }

    /**
     * `SurveyReport.program`, from the statements the realms' last passes
     * began and the functions they lowered: a declaration counts when
     * something inside it did, a body's `return` when its function did.
     */
    private programReport(
        program: SurveyProgram,
        begun: ReadonlySet<ts.Node>,
    ): NonNullable<SurveyReport["program"]> {
        const lowered = new Set<ts.Node>();
        for (const attempt of this.realms.values())
            for (const declaration of attempt.lowered) lowered.add(declaration);
        // The nodes something begun or lowered lies inside.
        const holding = new Set<ts.Node>();
        for (const node of [...begun, ...lowered])
            for (
                let parent = node.parent;
                parent && !holding.has(parent);
                parent = parent.parent
            )
                holding.add(parent);
        const tried = (statement: ts.Statement): boolean => {
            if (begun.has(statement)) return true;
            if (
                ts.isFunctionDeclaration(statement) ||
                ts.isClassDeclaration(statement)
            )
                return holding.has(statement) || lowered.has(statement);
            const body = statement.parent;
            return (
                isBodyReturn(statement) &&
                ts.isBlock(body) &&
                (lowered.has(body.parent) ||
                    body.statements.some((sibling) => begun.has(sibling)))
            );
        };
        let attempted = 0;
        const untried = new Map<
            ts.Node,
            { first: ts.Statement; statements: number }
        >();
        for (const statement of program.statements) {
            if (tried(statement)) {
                attempted++;
                continue;
            }
            const owner = censusOwner(statement);
            const entry = untried.get(owner);
            if (entry) entry.statements++;
            else untried.set(owner, { first: statement, statements: 1 });
        }
        return {
            files: program.files,
            statements: program.statements.length,
            attempted,
            untried: [...untried]
                .sort((a, b) => b[1].statements - a[1].statements)
                .slice(0, untriedKept)
                .map(([owner, { first, statements }]) => ({
                    function: ownerName(owner),
                    at: nodeSite(ts.isSourceFile(owner) ? first : owner),
                    kind: syntaxKindName(owner.kind),
                    statements,
                })),
        };
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
        return (
            this.current !== undefined &&
            body.statements.every((statement) => this.unbegun(statement))
        );
    }

    /**
     * Runs one realm's compile attempt, replacing the census a previous
     * attempt of that realm left. `apply` takes a storage demand a statement
     * meets into the storage this attempt lowers with, true when it added
     * something: the statement then lowers again at once.
     */
    public attempt<T>(
        realm: string,
        run: () => T,
        apply: (demand: StorageDemand) => boolean,
    ): T {
        this.attempts++;
        const previous = this.current;
        const enclosingApply = this.apply;
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
            rootProbes: new Set(),
            taken: new Set(),
        };
        this.realms.set(realm, attempt);
        this.current = attempt;
        this.apply = apply;
        try {
            return run();
        } finally {
            this.current = previous;
            this.apply = enclosingApply;
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
        this.reportProgress(statement);
        const timing = { started: performance.now(), nested: 0 };
        const enclosing = this.timing;
        this.timing = timing;
        // The last demand this statement made the pass take.
        let taken: Error | undefined;
        try {
            for (;;) {
                let met: unknown;
                try {
                    context.transaction(lower);
                    return;
                } catch (error) {
                    met = error;
                }
                // A demand its replay refused is the statement's refusal; a
                // storage demand applies at once and the statement lowers
                // again with it; any other replay rolls its statement back
                // for the next pass.
                const refusal =
                    met instanceof CompileError
                        ? met
                        : context.refusedDemand(met);
                if (!refusal && !this.replayable?.(met)) throw met;
                const applied = refusal ? false : this.applied(attempt, met);
                if (applied === true) {
                    taken = met as Error;
                    continue;
                }
                const refused =
                    applied instanceof CompileError ? applied : refusal;
                // A refusal once this pass took a demand for the statement
                // can come of storage lowered before the demand (a layout
                // already built): the next pass lowers it afresh. A demand
                // its application refused is refused all the same.
                if (refused && (!taken || applied instanceof CompileError))
                    this.record(attempt, context.checker, statement, refused);
                else
                    this.demanded(
                        attempt,
                        statement,
                        refused ? taken! : (met as Error),
                        applied === "held",
                    );
                break;
            }
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
     * Whether `met`, a storage demand, went into the attempt's storage at
     * once (true), or the refusal applying it raised; false for a demand
     * already held and any other replay.
     */
    private applied(
        attempt: Attempt,
        met: unknown,
    ): boolean | "held" | CompileError {
        if (!(met instanceof StorageDemand) || !this.apply) return false;
        const key = replayText(met);
        try {
            if (!this.apply(met))
                return attempt.taken.has(key) ? false : "held";
        } catch (error) {
            if (error instanceof CompileError) return error;
            throw error;
        }
        attempt.taken.add(key);
        return true;
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
        this.inRoots(() => {
            for (const name of held.names) context.bindEmptyStorage(name);
            for (const nested of unlowered) lowerNested(nested);
        });
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
        slowest.push({
            statement: censusStatement(statement),
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
        held = false,
    ): void {
        attempt.replays.push(replay);
        const described = replayText(replay);
        const site = replaySite(replay);
        const key = `${described} at ${site ?? ""}`;
        let census = attempt.demands.get(key);
        if (!census) {
            census = {
                demand: described,
                ...(site ? { site } : {}),
                statement: censusStatement(statement),
                statements: 0,
                rolledBack: new Set(),
            };
            attempt.demands.set(key, census);
        }
        if (held) census.held = true;
        census.rolledBack.add(statement);
    }

    /** The demands the realm's last pass took: a next pass lowers everything with them. */
    public taken(realm: string): number {
        return this.realms.get(realm)?.taken.size ?? 0;
    }

    /** The replays the realm's last pass met at its statements. */
    public replaysOf(realm: string): readonly Error[] {
        return this.realms.get(realm)?.replays ?? [];
    }

    /**
     * Ends a pass that `added` demands for the next one: whether the next
     * runs. A pass that added none is the last, as is the one that reaches
     * the pass limit; its census keeps the demands left.
     */
    public passEnded(added: number): boolean {
        this.passes++;
        const census = this.report();
        this.furthest = census;
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
        this.leaveCensus(line, census);
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
            census = {
                site: {
                    file: error.fileName,
                    line: error.line,
                    column: error.column,
                },
                message: error.detail,
                class: refusalClass(error.detail),
                statement: censusStatement(statement),
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
        // The statements a lowering began, a declined probe's aside.
        const begun = new Set<ts.Statement>();
        for (const attempt of this.realms.values()) {
            rooted += attempt.rooted;
            for (const statement of attempt.distinct) begun.add(statement);
            for (const statement of attempt.probed) begun.add(statement);
            for (const statement of attempt.rootProbes) begun.add(statement);
            for (const { rolledBack, ...demand } of attempt.demands.values()) {
                for (const statement of rolledBack) demanded.add(statement);
                demands.push({ ...demand, ...rolledBackCensus(rolledBack) });
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
        const refused = new Set<ts.Statement>();
        for (const census of merged.values())
            for (const statement of census.rolledBack) refused.add(statement);
        const refusals = [...merged.values()]
            .map(({ rolledBack, ...refusal }): SurveyRefusal => ({
                ...refusal,
                ...rolledBackCensus(rolledBack),
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
                distinct: begun.size,
                rooted,
                refused: refusals.reduce(
                    (count, refusal) => count + refusal.occurrences,
                    0,
                ),
                distinctRefused: refused.size,
                demanded: demanded.size,
            },
            ...(this.program
                ? { program: this.programReport(this.program, begun) }
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
