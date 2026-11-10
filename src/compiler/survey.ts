/**
 * Generation survey: lower an entry past every compile refusal.
 *
 * Ordinary generation stops at the first `CompileError`, which measures the
 * frontier of an entry and nothing behind it. A survey wraps every lowered
 * statement in an emission transaction; a refusal rolls that statement back,
 * is recorded here, and lowering continues with the next statement, so one
 * run lists every refusal the entry reaches. The census is a measurement:
 * nothing lowered under it is a program, and normal generation never
 * consults it.
 *
 * Refusals raised inside speculative probes are the probe's to decide, not
 * the survey's, and the statement lowerer stands aside while one is open.
 * A compile attempt that restarts for a storage replay discards its realm's
 * records. A site refusal decided after lowering is recorded against the
 * site's statement; any other refusal raised outside statement lowering
 * ends the survey as incomplete.
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
import type { PlanCensus } from "./storage-demand-planner.js";
import {
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
    /** How many distinct statements those lowerings rolled back. */
    statements: number;
}

interface SurveyClass {
    class: string;
    sites: number;
    /** Sites among them that only name a binding another refusal took away. */
    cascades: number;
    occurrences: number;
    example: string;
}

export interface SurveyReport {
    schemaVersion: 1;
    /** False when an error outside statement lowering ended the survey. */
    complete: boolean;
    terminal?: string;
    /** The stack frames that raised `terminal`, innermost first: an error without a source location names its raiser. */
    terminalStack?: string[];
    statements: { attempted: number; refused: number };
    refusals: SurveyRefusal[];
    classes: SurveyClass[];
    /**
     * In the census a running survey leaves: what the last plan between
     * attempts met, lowering past their reach -- the statements it lowered,
     * those it left to the next attempt (they read what a demand or a
     * refusal took away), and its refusals. Provisional: the storage a
     * later attempt replays with may lower a statement differently.
     */
    plan?: {
        statements: { attempted: number; left: number; refused: number };
        refusals: SurveyRefusal[];
    };
}

/** What a surveyed statement lowering needs from its context. */
interface StatementContext {
    readonly checker: ts.TypeChecker;
    transaction(work: () => void): void;
    refusedDemand(error: unknown): CompileError | undefined;
}

/** A refusal while it is being counted: the statements it rolled back, by node. */
interface Census extends SurveyRefusal {
    rolledBack: Set<ts.Statement>;
}

/** One compile attempt of one realm; a replay of that realm replaces it. */
interface Attempt {
    attempted: number;
    refusals: Map<string, Census>;
    /** Bindings the rolled-back statements would have declared, by symbol. */
    declarations: Map<ts.Symbol, SurveySite>;
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
     * Receives the census as it stands at each restart, marked incomplete:
     * a survey stopped before its end leaves what it had found.
     */
    readonly partial?: (report: SurveyReport) => void;
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
    /** @unjournaled The last plan's census and the statements it left (`SurveyReport.plan`). */
    private plan: { census: Attempt; left: number } | undefined;

    public constructor(private readonly progress?: SurveyProgress) {}

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
        this.progress.report(
            `Survey progress: attempt ${this.attempts}, ${attempted} statement lowerings, ${refused.size} refused; lowering ` +
                `${location.file.fileName}:${location.line} (${enclosingFunctionName(statement)})` +
                (this.restart ? `; last restart: ${this.restart}` : ""),
        );
    }

    /**
     * Records what ended an attempt that restarts the program: where its
     * storage demand rose, else the statement lowering then.
     */
    public restarted(cause: unknown): void {
        this.restart = describeStop(cause, this.lowering);
        const restart = `restart after attempt ${this.attempts}: ${this.restart}`;
        this.progress?.report(`Survey ${restart}`);
        this.leavePartial(restart);
    }

    /** Hands the census as it stands, marked incomplete, with what the last plan met. */
    private leavePartial(running: string): void {
        if (!this.progress?.partial) return;
        const planned =
            this.plan && SurveyCollector.refusalsOf([this.plan.census]);
        this.progress.partial({
            ...this.report(),
            complete: false,
            terminal: `Survey still running: ${running}`,
            ...(this.plan && planned
                ? {
                      plan: {
                          statements: {
                              attempted: this.plan.census.attempted,
                              left: this.plan.left,
                              refused: planned.reduce(
                                  (count, refusal) =>
                                      count + refusal.occurrences,
                                  0,
                              ),
                          },
                          refusals: planned,
                      },
                  }
                : {}),
        });
    }

    /**
     * Reports a plan run between strict attempts: the demands it added,
     * how long it lowered, and what ended it.
     */
    public planned(
        checker: ts.TypeChecker,
        added: number,
        milliseconds: number,
        ended: { cause: unknown; statement?: ts.Statement },
        met: PlanCensus,
    ): void {
        const census: Attempt = {
            attempted: met.lowered,
            refusals: new Map(),
            declarations: new Map(),
        };
        for (const { statement, error } of met.refused)
            this.record(census, checker, statement, error);
        this.plan = { census, left: met.left };
        const ending = `plan after attempt ${this.attempts}: ${added} demands added in ${Math.round(milliseconds / 1000)} s; ended by ${
            ended.cause === undefined
                ? "the end of the program"
                : describeStop(ended.cause, ended.statement)
        }`;
        this.progress?.report(
            `Survey ${ending}; ${met.lowered} statement lowerings, ${met.left} left, ${met.refused.length} refused`,
        );
        this.leavePartial(ending);
    }

    /** Runs one realm's compile attempt, replacing the census a previous attempt of that realm left. */
    public attempt<T>(realm: string, run: () => T): T {
        this.attempts++;
        const previous = this.current;
        const attempt: Attempt = {
            attempted: 0,
            refusals: new Map(),
            declarations: new Map(),
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
    ): void {
        const attempt = this.current;
        if (!attempt) {
            lower();
            return;
        }
        attempt.attempted++;
        this.lowering = statement;
        this.reportProgress(statement);
        try {
            context.transaction(lower);
        } catch (error) {
            // A demand its replay refused is the statement's refusal.
            const refusal =
                error instanceof CompileError
                    ? error
                    : context.refusedDemand(error);
            if (!refusal) throw error;
            this.record(attempt, context.checker, statement, refusal);
        }
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
                statements: 0,
                rolledBack: new Set(),
            };
            const cascade = this.cascadeOf(attempt, checker, error);
            if (cascade) census.cascade = cascade;
            attempt.refusals.set(error.message, census);
        }
        census.occurrences++;
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

    /** The refusals of `attempts` merged by message, in source order. */
    private static refusalsOf(attempts: Iterable<Attempt>): SurveyRefusal[] {
        const merged = new Map<string, Census>();
        for (const attempt of attempts)
            for (const [key, census] of attempt.refusals) {
                const existing = merged.get(key);
                if (!existing) {
                    merged.set(key, {
                        ...census,
                        rolledBack: new Set(census.rolledBack),
                    });
                } else {
                    existing.occurrences += census.occurrences;
                    for (const statement of census.rolledBack)
                        existing.rolledBack.add(statement);
                }
            }
        return [...merged.values()]
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
    }

    public report(terminal?: Error): SurveyReport {
        let attempted = 0;
        for (const attempt of this.realms.values())
            attempted += attempt.attempted;
        const refusals = SurveyCollector.refusalsOf(this.realms.values());
        const classes = new Map<string, SurveyClass>();
        for (const refusal of refusals) {
            const entry = classes.get(refusal.class) ?? {
                class: refusal.class,
                sites: 0,
                cascades: 0,
                occurrences: 0,
                example: refusal.message,
            };
            entry.sites++;
            if (refusal.cascade) entry.cascades++;
            entry.occurrences += refusal.occurrences;
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
                refused: refusals.reduce(
                    (count, refusal) => count + refusal.occurrences,
                    0,
                ),
            },
            refusals,
            classes: [...classes.values()].sort(
                (a, b) =>
                    b.sites - a.sites ||
                    b.occurrences - a.occurrences ||
                    a.class.localeCompare(b.class),
            ),
        };
    }
}

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
