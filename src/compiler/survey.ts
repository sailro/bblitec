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
    type StorageRequest,
} from "./replay-storage.js";
import { StorageDemand } from "./storage-demand.js";
import { EmissionSet, EmissionTransaction } from "./emission-transaction.js";
import { coverLoweredAgain, keepingCoverage } from "./source-coverage.js";
import {
    bindingNameIdentifiers,
    hasDeclareModifier,
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
    readonly callbacks: Pick<
        import("./callbacks.js").CallbackLowerer,
        "retryForwardMiss"
    >;
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

/**
 * A storage demand a pass met at a statement, which it rolled back: the next
 * pass replays with it, unless a root met a replay undoing the deployment's
 * folds (`SurveyCollector.demanded`).
 */
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
    /** The functions whose bodies this attempt lowered outside a probe. */
    lowered: Set<ts.Node>;
    /** The argument shapes each of `lowered` was lowered with (`loweredBefore`). */
    loweredShapes: Map<ts.Node, Set<string>>;
    /** Those of `lowered` whose lowering did not end: the next call lowers the body again. */
    unfinished: Set<ts.Node>;
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
    /**
     * The demands of `taken` this lowering of the roots took itself: the
     * pass's own, or a round's. Storage it built before one is what a
     * statement left to that demand can stand on.
     */
    fresh: Set<string>;
    /** Each phase the attempt ended, in order, with the statement lowerings it made. */
    phases: { name: string; seconds: number; lowerings: number }[];
    /** The time its outermost probes took: those kept, and those rolled back. */
    probes: { kept: number; dropped: number };
    /** When the phase under way began, and the lowerings made before it. */
    phase: { started: number; lowerings: number };
    /** The roots it lowered, in order, and the one under way. */
    roots: SurveyRoot[];
    root: SurveyRoot | undefined;
    /**
     * Where the module roots began and ended in what `distinct` and
     * `lowered` hold, in insertion order: a round lowers them again.
     */
    moduleRoots: { from: RootMark; to: RootMark };
    /** A round's sources: the files holding what it lowers again. */
    sources?: ReadonlySet<ts.SourceFile>;
    /**
     * What probes refused since the last demand taken: the functions whose
     * shared body a probe could not keep, and each call a probe lowered
     * inline with the refusal that ended it. A probe lowers neither again:
     * a body a probe cannot lower is lowered where its statements recover.
     * Its identity keys what probes lowered on the same storage
     * (`speculativeEpoch`).
     */
    speculative: SpeculativeRefusals;
}

interface SpeculativeRefusals {
    readonly shared: Set<ts.Node>;
    readonly inline: Map<ts.Node, Map<ts.Node, CompileError>>;
}

function noSpeculativeRefusals(): SpeculativeRefusals {
    return { shared: new Set(), inline: new Map() };
}

/** How many statements an attempt's `distinct` and functions its `lowered` hold. */
type RootMark = readonly [begun: number, lowered: number];

/** One root an attempt lowered. */
interface SurveyRoot {
    /** The source it lowers as its own: a function, or a run of statements. */
    readonly file: ts.SourceFile;
    readonly pos: number;
    readonly end: number;
    /** What it added to the attempt's `distinct` and `lowered`, as their insertion order holds it. */
    readonly from: RootMark;
    to: RootMark;
    /**
     * It took a storage demand, or left a statement to one this lowering
     * of the roots had taken: what was lowered before can stand on storage
     * the demand changed, so a round lowers it again. A statement left to
     * a demand taken before stands on what the entry built, which only the
     * next pass builds again.
     */
    stale: boolean;
}

/** The rounds a pass runs at most. */
const roundLimit = 12;

/** The demands a round takes per statement it lowers, at least, for another to follow. */
const roundYield = 0.001;

/**
 * A statement the census counts: any but a block, which only groups the
 * statements it holds, and declarations that lower to nothing (interfaces,
 * type aliases, imports, exports, ambient declarations).
 */
function surveyedStatement(node: ts.Node): node is ts.Statement {
    return (
        ts.isStatement(node) &&
        !hasDeclareModifier(node) &&
        !ts.isBlock(node) &&
        !ts.isInterfaceDeclaration(node) &&
        !ts.isTypeAliasDeclaration(node) &&
        !ts.isImportDeclaration(node) &&
        !ts.isExportDeclaration(node) &&
        // An overload signature declares a type; its implementation runs.
        !(ts.isFunctionDeclaration(node) && !node.body)
    );
}

/**
 * Whether `statement` is a `return` of a function's own body: it lowers as
 * the function's result, not as a statement of its own, so the lowering of
 * its function tries it.
 */
export function isBodyReturn(
    statement: ts.Statement,
): statement is ts.ReturnStatement & { readonly parent: ts.Block } {
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

/** Where storage requests rose: the first one's node as `file:line`, or a signature site. */
function requestsSite(requests: readonly StorageRequest[]): string | undefined {
    const site = requests.map(storageRequestSite).find(Boolean);
    return typeof site === "object" ? nodeSite(site) : site;
}

/** Where a storage demand rose: a node as `file:line`, or a signature site. */
function replaySite(replay: unknown): string | undefined {
    return replay instanceof StorageDemand
        ? requestsSite(replay.requests)
        : undefined;
}

/** `text` on one line, cut short, and the site it names. */
function stopLine(text: string, site: string | undefined): string {
    return (
        text.replace(/\s+/g, " ").slice(0, 160) + (site ? ` at ${site}` : "")
    );
}

/** What restarted an attempt, and where its storage demand rose. */
export function describeStop(cause: unknown): string {
    const text =
        cause instanceof StorageDemand
            ? `${cause.constructor.name}: ${replayText(cause)}`
            : cause instanceof Error
              ? replayText(cause)
              : String(cause);
    return stopLine(text, replaySite(cause));
}

/** What a plan's storage requests ask for, and where the first rose. */
export function describeRequests(requests: readonly StorageRequest[]): string {
    return stopLine(describeStorageRequests(requests), requestsSite(requests));
}

/**
 * The attempt a round lowers in: `previous` (the pass's full lowering, or
 * its last round) without what its module roots and its `stale` roots began
 * and lowered, so the roots take them again; the demands taken are the
 * pass's own.
 */
function roundAttempt(
    pass: Attempt,
    previous: Attempt,
    stale: readonly SurveyRoot[],
): Attempt {
    const begun = [...previous.distinct];
    const lowered = [...previous.lowered];
    const forgotten = new Set<ts.Node>();
    const forget = (from: RootMark, to: RootMark): void => {
        for (let index = from[0]; index < to[0]; index++)
            forgotten.add(begun[index]!);
        for (let index = from[1]; index < to[1]; index++)
            forgotten.add(lowered[index]!);
    };
    const ranges = new Map<ts.SourceFile, SurveyRoot[]>();
    for (const root of stale) {
        forget(root.from, root.to);
        const held = ranges.get(root.file);
        if (held) held.push(root);
        else ranges.set(root.file, [root]);
    }
    // A statement a committed probe began stays begun outside the stale
    // roots' own source.
    const probedElsewhere = (statement: ts.Statement): boolean =>
        !ranges
            .get(statement.getSourceFile())
            ?.some(
                (root) =>
                    statement.pos >= root.pos && statement.end <= root.end,
            );
    // The function and statement roots lower again in the files holding
    // what the stale roots began; every module root does.
    const sources = new Set([...forgotten].map((node) => node.getSourceFile()));
    forget(previous.moduleRoots.from, previous.moduleRoots.to);
    const distinct = new Set(begun.filter((node) => !forgotten.has(node)));
    const kept = new Set(lowered.filter((node) => !forgotten.has(node)));
    const mark: RootMark = [distinct.size, kept.size];
    return newAttempt({
        lowered: kept,
        distinct,
        probed: new EmissionSet(previous.probed),
        rootProbes: new Set([...previous.rootProbes].filter(probedElsewhere)),
        taken: pass.taken,
        moduleRoots: { from: mark, to: mark },
        sources,
    });
}

/** An attempt nothing has lowered, refused or demanded in yet, but what it `carries` on. */
function newAttempt(carries: Partial<Attempt> = {}): Attempt {
    return {
        attempted: 0,
        refusals: new Map(),
        declarations: new Map(),
        replays: [],
        demands: new Map(),
        lowered: new Set(),
        loweredShapes: new Map(),
        unfinished: new Set(),
        rooted: 0,
        settling: false,
        slowest: [],
        distinct: new Set(),
        probed: new EmissionSet(),
        rootProbes: new Set(),
        taken: new Set(),
        fresh: new Set(),
        phases: [],
        probes: { kept: 0, dropped: 0 },
        phase: { started: performance.now(), lowerings: 0 },
        roots: [],
        root: undefined,
        moduleRoots: { from: [0, 0], to: [0, 0] },
        speculative: noSpeculativeRefusals(),
        ...carries,
    };
}

/** How a survey runs: what it reports as it goes, and the most passes it runs. */
export interface SurveySettings {
    readonly progress?: SurveyProgress;
    readonly passLimit?: number;
    /**
     * Whether a pass lowers the functions and statements no lowering
     * reached as roots after the entry (default); without them a pass is
     * the entry's own lowering, the refusals it meets the entry's.
     */
    readonly roots?: boolean;
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
    /** @unjournaled The attempt begun last, whose phases its pass reports. */
    private last: Attempt | undefined;
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
    /** Whether a pass lowers roots after the entry (`SurveySettings.roots`). */
    public readonly lowersRoots: boolean;
    /** @unjournaled Takes a storage demand into the storage the running attempt lowers with. */
    private apply: ((demand: StorageDemand) => boolean) | undefined;
    /** @unjournaled The refusals a shared body's recovering lowering withholds (`withholdingRefusals`). */
    private withheld: { refusals: number } | undefined;
    /**
     * @unjournaled The statements each probe lowering under way began
     * (`beganInProbe`): journaled sets, so an inner probe that rolls back
     * takes its statements away.
     */
    private readonly probing: EmissionSet<ts.Statement>[] = [];

    /**
     * `replayable`: the replays a compile applies before its next attempt
     * (a storage demand, a lazy module's activation, runtime query state),
     * which a pass meets at a statement. `unfolding`: those of them that
     * undo the deployment's generation-time folds (runtime query state),
     * which only the program's own lowering takes.
     */
    public constructor(
        settings: SurveySettings = {},
        private readonly replayable?: (error: unknown) => error is Error,
        private readonly unfolding?: (error: Error) => boolean,
    ) {
        this.progress = settings.progress;
        this.passLimit = settings.passLimit;
        this.lowersRoots = settings.roots ?? true;
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
     * probe with arguments of `shape` (their count and kinds); a lowering
     * outside a probe that answers false lowers it now. A call of another
     * shape lowers the body again, once per shape: the storage demands its
     * arguments raise (an options record a first, argument-less call never
     * passed) are met in the pass.
     */
    public loweredBefore(
        declaration: ts.Node,
        speculating: boolean,
        shape: string,
    ): boolean {
        const attempt = this.current;
        if (!attempt) return false;
        let shapes = attempt.loweredShapes.get(declaration);
        if (attempt.lowered.has(declaration)) {
            if (!attempt.unfinished.has(declaration) && shapes?.has(shape))
                return true;
            if (!speculating) {
                attempt.unfinished.delete(declaration);
                shapes?.add(shape);
            }
            return false;
        }
        if (!speculating) {
            attempt.lowered.add(declaration);
            if (!shapes)
                attempt.loweredShapes.set(declaration, (shapes = new Set()));
            shapes.add(shape);
        }
        return false;
    }

    /**
     * Notes that the lowering of `declaration`'s body this attempt began
     * did not end (its shared form refused, a storage demand left it): the
     * next call outside a probe lowers the body again.
     */
    public leftUnfinished(declaration: ts.Node): void {
        const attempt = this.current;
        if (attempt?.lowered.has(declaration))
            attempt.unfinished.add(declaration);
    }

    /** Whether a lowering of this attempt lowered `declaration`'s body to its end, or is lowering it. */
    public lowers(declaration: ts.Node): boolean {
        const attempt = this.current;
        return (
            attempt !== undefined &&
            attempt.lowered.has(declaration) &&
            !attempt.unfinished.has(declaration)
        );
    }

    /**
     * Lowers code the program never reached as a root (`lower`), recorded
     * against its first statement; what it reaches counts as a root's.
     */
    public attemptRoot(
        context: StatementContext,
        first: ts.Statement,
        lower: () => void,
        source: Pick<ts.Node, "pos" | "end"> = first,
    ): void {
        const attempt = this.current;
        const mark = (): RootMark =>
            attempt ? [attempt.distinct.size, attempt.lowered.size] : [0, 0];
        const root: SurveyRoot = {
            file: first.getSourceFile(),
            pos: source.pos,
            end: source.end,
            from: mark(),
            to: mark(),
            stale: false,
        };
        const enclosing = attempt?.root;
        if (attempt) attempt.root = root;
        try {
            this.inRoots(() => this.attemptStatement(context, first, lower));
        } finally {
            root.to = mark();
            if (attempt) {
                attempt.roots.push(root);
                attempt.root = enclosing;
            }
        }
    }

    /**
     * Lowers the roots again (`lower`) while a round takes a storage demand:
     * each round lowers the module roots and the roots the last one left
     * stale, with what the others began and lowered standing as it is, on
     * the storage the pass holds by then. A demand a round takes is the
     * pass's; what a round lowers is not its census, which stays the full
     * lowering's until a pass takes no demand. The pass a limit ends the
     * survey at runs none: no pass lowers with what they would take.
     */
    public rounds(lower: () => void): void {
        const pass = this.current;
        if (
            !pass ||
            (this.passLimit !== undefined && this.passes + 1 >= this.passLimit)
        )
            return;
        let previous = pass;
        for (let round = 1; round <= roundLimit; round++) {
            const stale = previous.roots.filter((root) => root.stale);
            if (stale.length === 0) return;
            const taken = pass.taken.size;
            const started = performance.now();
            const next = roundAttempt(pass, previous, stale);
            this.current = next;
            try {
                lower();
            } finally {
                this.current = pass;
            }
            for (const replay of next.replays)
                if (!(replay instanceof StorageDemand))
                    pass.replays.push(replay);
            const added = pass.taken.size - taken;
            const seconds = (performance.now() - started) / 1000;
            this.progress?.report(
                `Survey pass ${this.passes + 1} round ${round}: ${added} demand${added === 1 ? "" : "s"} taken lowering ${stale.length} root${stale.length === 1 ? "" : "s"} again ` +
                    `(${seconds.toFixed(0)} s / ${next.attempted})`,
            );
            // A round that takes few demands for what it lowers is the
            // last: the next pass takes what is left.
            if (added < next.attempted * roundYield) return;
            previous = next;
        }
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

    /**
     * Whether a probe of this attempt could not keep `declaration`'s shared
     * body (`refused` notes one that could not): the next call lowers it
     * inline instead of probing it again.
     */
    /**
     * Runs `work`, a shared body's lowering with statement recovery, with
     * the refusals its statements meet withheld from the census: a strict
     * compile refuses such a body and lowers the call inline, where the
     * statements that still refuse are recorded.
     */
    public withholdingRefusals<T>(work: () => T): {
        result: T;
        refused: boolean;
    } {
        const enclosing = this.withheld;
        const withheld = { refusals: 0 };
        this.withheld = withheld;
        try {
            const result = work();
            return { result, refused: withheld.refusals > 0 };
        } finally {
            this.withheld = enclosing;
        }
    }

    public sharedBodyRefused(declaration: ts.Node, refused = false): boolean {
        const shared = this.current?.speculative.shared;
        if (!shared) return false;
        if (refused) shared.add(declaration);
        return shared.has(declaration);
    }

    /**
     * The refusal that ended a probe's inline lowering of `declaration` at
     * `call` in this attempt (`refusal` notes it): a probe reaching the
     * call again refuses at once.
     */
    public inlineBodyRefusal(
        call: ts.Node,
        declaration: ts.Node,
        refusal?: CompileError,
    ): CompileError | undefined {
        const inline = this.current?.speculative.inline;
        if (!inline) return undefined;
        let calls = inline.get(call);
        if (refusal) {
            if (!calls)
                inline.set(call, (calls = new Map<ts.Node, CompileError>()));
            calls.set(declaration, refusal);
        }
        return calls?.get(declaration);
    }

    /** Whether the roots lower `file`'s functions and statements now: all files, or a round's sources. */
    public lowersRootsOf(file: ts.SourceFile): boolean {
        return this.current?.sources?.has(file) ?? true;
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

    /**
     * Whether no lowering of this attempt began `statement` but in a probe
     * that rolled back: the census's untried statement, which a root tries.
     */
    public unbegun(statement: ts.Statement): boolean {
        const attempt = this.current;
        return (
            attempt !== undefined &&
            !attempt.distinct.has(statement) &&
            !attempt.probed.has(statement) &&
            !attempt.rootProbes.has(statement)
        );
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
            return (
                isBodyReturn(statement) &&
                (lowered.has(statement.parent.parent) ||
                    statement.parent.statements.some((sibling) =>
                        begun.has(sibling),
                    ))
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

    /** Notes that an outermost probe of the current attempt took `milliseconds`, kept or rolled back. */
    public probed(kept: boolean, milliseconds: number): void {
        const probes = this.current?.probes;
        if (probes) probes[kept ? "kept" : "dropped"] += milliseconds;
    }

    /** Notes that the current attempt ended its phase `name` (the entry, a kind of root). */
    public phaseEnded(name: string): void {
        const attempt = this.current;
        if (!attempt) return;
        const now = performance.now();
        attempt.phases.push({
            name,
            seconds: (now - attempt.phase.started) / 1000,
            lowerings: attempt.attempted - attempt.phase.lowerings,
        });
        attempt.phase = { started: now, lowerings: attempt.attempted };
        const mark: RootMark = [attempt.distinct.size, attempt.lowered.size];
        if (name === "entry") attempt.moduleRoots = { from: mark, to: mark };
        else if (name === "module roots") attempt.moduleRoots.to = mark;
    }

    /** Whether the realm's last attempt lowered every statement before it ended. */
    public settling(realm: string): boolean {
        return this.realms.get(realm)?.settling ?? false;
    }

    /** Notes that a lowering began `statement`, inside a probe or not. */
    public touch(statement: ts.Statement, speculating: boolean): void {
        const attempt = this.current;
        if (!attempt) return;
        (speculating ? attempt.probed : attempt.distinct).add(statement);
        if (speculating) for (const begun of this.probing) begun.add(statement);
    }

    /**
     * A key for what probes lowered since storage last changed: a probe
     * may stand on such a lowering, rolled back since, instead of lowering
     * it again (`beganInProbe`, `touchProbed`). Undefined outside an attempt.
     */
    public speculativeEpoch(): object | undefined {
        return this.current?.speculative;
    }

    /** `lower`, a lowering inside a probe, with the statements it began. */
    public beganInProbe<T>(lower: () => T): {
        result: T;
        statements: readonly ts.Statement[];
    } {
        const begun = new EmissionSet<ts.Statement>();
        this.probing.push(begun);
        try {
            const result = lower();
            return { result, statements: [...begun] };
        } finally {
            this.probing.pop();
        }
    }

    /** Notes that a probe began and lowered `statements` again (`beganInProbe`). */
    public touchProbed(statements: readonly ts.Statement[]): void {
        for (const statement of statements) this.touch(statement, true);
        coverLoweredAgain(statements);
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
        const attempt: Attempt = newAttempt();
        this.realms.set(realm, attempt);
        this.last = attempt;
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
                const begun = this.bodiesBegun();
                try {
                    context.transaction(lower);
                    return;
                } catch (error) {
                    met = error;
                }
                // A read of a binding its block declares later: the binding
                // takes storage ahead of the statement that block stands
                // at, and this statement lowers again, with the bodies its
                // withdrawn lowering began. From scopes of its own (a
                // function's body) an enclosing statement does.
                if (
                    context.callbacks.retryForwardMiss(met, () =>
                        this.withdrawBodies(begun),
                    )
                )
                    continue;
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
                    if (attempt.root) attempt.root.stale = true;
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
                else {
                    this.demanded(
                        attempt,
                        statement,
                        refused ? taken! : (met as Error),
                        applied === "held",
                    );
                    // What it declares is the next pass's: the empty
                    // storage below stands in for it, so a refusal reached
                    // through one of its names is not a gap of its own.
                    this.declaredAtNames(
                        attempt,
                        context.checker,
                        statementDeclaredNames(statement),
                    );
                    if (
                        attempt.root &&
                        applied === false &&
                        met instanceof StorageDemand &&
                        attempt.fresh.has(replayText(met))
                    )
                        attempt.root.stale = true;
                }
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

    /** Storage lowering reads changed: what a probe refused before may lower now. */
    public storageChanged(): void {
        if (this.current) this.current.speculative = noSpeculativeRefusals();
    }

    /** How many bodies this attempt began lowering: a mark for `withdrawBodies`. */
    public bodiesBegun(): number {
        return this.current?.lowered.size ?? 0;
    }

    /**
     * Forgets the bodies begun since `mark`: the statement that reached
     * them was withdrawn and lowers again, their bodies with it.
     */
    public withdrawBodies(mark: number): void {
        const attempt = this.current;
        if (!attempt) return;
        let index = 0;
        for (const body of attempt.lowered)
            if (index++ >= mark) {
                attempt.lowered.delete(body);
                attempt.unfinished.delete(body);
            }
    }

    /**
     * What applying `met` did: true when the storage took a new demand,
     * "held" when it already held one this attempt never took, the refusal
     * applying it raised, and false when this attempt already took it or
     * `met` is not a storage demand.
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
        attempt.fresh.add(key);
        this.storageChanged();
        return true;
    }

    /**
     * A rolled-back compound statement's own statements, which its rollback
     * left unlowered: each is lowered on its own, the names its header binds
     * (a loop's variables, a catch variable) holding empty storage, counted
     * with the roots as context the survey rebuilt. A refusal through one of
     * those names cascades from it, whether or not its type has empty storage.
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
        this.declaredAtNames(attempt, context.checker, held.names);
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
        // A root meets a replay in the context the survey built: one that
        // undoes the deployment's folds would let the program's own lowering
        // reach what an ordinary compile folds away.
        if (!this.inRoot || !this.unfolding?.(replay))
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
        const phases = (this.last?.phases ?? [])
            .map(
                ({ name, seconds, lowerings }) =>
                    `${name} ${seconds.toFixed(0)} s / ${lowerings}`,
            )
            .join(", ");
        const probes = this.last?.probes;
        if (phases)
            this.progress?.report(
                `Survey phases, pass ${this.passes}: ${phases}` +
                    (probes
                        ? `; probes kept ${(probes.kept / 1000).toFixed(0)} s, rolled back ${(probes.dropped / 1000).toFixed(0)} s`
                        : ""),
            );
        if (added === 0) return false;
        // The demands the pass took, by what they ask for: what a next pass
        // lowers with, and what a chain of passes is waiting on.
        const taken = [...(this.last?.taken ?? [])];
        const named = taken.slice(0, 8);
        const which =
            named.length > 0
                ? `: ${named.join("; ")}${taken.length > named.length ? `; ${taken.length - named.length} more` : ""}`
                : "";
        const demands = `${added} demand${added === 1 ? "" : "s"}`;
        if (this.passLimit !== undefined && this.passes >= this.passLimit) {
            this.progress?.report(
                `Survey pass ${this.passes}: ${demands} left; the pass limit ends the survey here${which}`,
            );
            return false;
        }
        const line = `Survey pass ${this.passes}: ${demands} added for the next pass${which}`;
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

    /**
     * A root's capture or parameter (`name`) with no storage of its type:
     * the root goes on without it, `error` is counted at the root's `first`
     * statement without rolling one back, and the statements reading it
     * cascade from it.
     */
    public unboundCapture(
        checker: ts.TypeChecker,
        first: ts.Statement,
        name: ts.Identifier,
        error: CompileError,
    ): void {
        const attempt = this.current;
        if (!attempt) throw error;
        const census = this.counted(attempt, checker, first, error);
        this.declaredAt(attempt, checker, [name], census.site);
    }

    /**
     * A root's parameter holding empty storage, which no call passes: a
     * refusal reached through it (a value generation must know, a member
     * of the record a caller hands) cascades from the parameter.
     */
    public emptyBinding(checker: ts.TypeChecker, name: ts.Identifier): void {
        if (this.current) this.declaredAtNames(this.current, checker, [name]);
    }

    /** Each of `names` that has no refusal site yet takes the name's own. */
    private declaredAtNames(
        attempt: Attempt,
        checker: ts.TypeChecker,
        names: Iterable<ts.Identifier>,
    ): void {
        for (const name of names) {
            const location = sourceLocation(name);
            this.declaredAt(attempt, checker, [name], {
                file: location.file.fileName,
                line: location.line,
                column: location.character,
            });
        }
    }

    /** Each of `names` that has no refusal site yet takes `site`. */
    private declaredAt(
        attempt: Attempt,
        checker: ts.TypeChecker,
        names: Iterable<ts.Identifier>,
        site: Census["site"],
    ): void {
        for (const name of names) {
            const symbol = declaredSymbol(checker, name);
            if (symbol && !attempt.declarations.has(symbol))
                attempt.declarations.set(symbol, site);
        }
    }

    private record(
        attempt: Attempt,
        checker: ts.TypeChecker,
        statement: ts.Statement,
        error: CompileError,
    ): void {
        if (this.withheld) {
            this.withheld.refusals++;
            return;
        }
        const census = this.counted(attempt, checker, statement, error);
        if (census.rolledBack.has(statement)) return;
        census.rolledBack.add(statement);
        // Every statement this refusal rolled back loses its declarations,
        // whichever caller reached the site first.
        this.declaredAt(
            attempt,
            checker,
            statementDeclaredNames(statement),
            census.site,
        );
    }

    /** The census entry of `error`, made at `statement`, with one more occurrence. */
    private counted(
        attempt: Attempt,
        checker: ts.TypeChecker,
        statement: ts.Statement,
        error: CompileError,
    ): Census {
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
        return census;
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
