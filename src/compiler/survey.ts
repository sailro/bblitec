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
 * records; a refusal raised outside statement lowering ends the survey as
 * incomplete.
 */
import ts from "typescript";
import { CompileError } from "./compile-error.js";
import { declaredSymbol } from "./symbols.js";
import { sourceLocation, syntaxKindName } from "../source-location.js";

export interface SurveySite {
    file: string;
    line: number;
    column: number;
}

export interface SurveyRefusal {
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

export interface SurveyClass {
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
    statements: { attempted: number; refused: number };
    refusals: SurveyRefusal[];
    classes: SurveyClass[];
}

/** What a surveyed statement lowering needs from its context. */
interface StatementContext {
    readonly checker: ts.TypeChecker;
    transaction(work: () => void): void;
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
    if (!owner || ts.isSourceFile(owner)) return "<module>";
    const name = ts.getNameOfDeclaration(owner);
    if (name) return name.getText();
    if (ts.isConstructorDeclaration(owner)) return "constructor";
    return ts.isVariableDeclaration(owner.parent) &&
        ts.isIdentifier(owner.parent.name)
        ? owner.parent.name.text
        : "<anonymous>";
}

function declaredNames(statement: ts.Statement): ts.Identifier[] {
    const names: ts.Identifier[] = [];
    const collect = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) names.push(name);
        else
            for (const element of name.elements)
                if (ts.isBindingElement(element)) collect(element.name);
    };
    if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations)
            collect(declaration.name);
    } else if (
        (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isEnumDeclaration(statement)) &&
        statement.name
    ) {
        names.push(statement.name);
    }
    return names;
}

export class SurveyCollector {
    /** @unjournaled The census counts refusals a rollback discards too. */
    private readonly realms = new Map<string, Attempt>();
    /** @unjournaled The census counts refusals a rollback discards too. */
    private current: Attempt | undefined;

    /** Runs one realm's compile attempt, replacing the census a previous attempt of that realm left. */
    public attempt<T>(realm: string, run: () => T): T {
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
        try {
            context.transaction(lower);
        } catch (error) {
            if (!(error instanceof CompileError)) throw error;
            this.record(attempt, context.checker, statement, error);
        }
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
        for (const name of declaredNames(statement)) {
            const symbol = declaredSymbol(checker, name);
            if (symbol && !attempt.declarations.has(symbol))
                attempt.declarations.set(symbol, census.site);
        }
    }

    /** A refusal raised at a name that a refused statement would have declared. */
    private cascadeOf(
        attempt: Attempt,
        checker: ts.TypeChecker,
        error: CompileError,
    ): SurveySite | undefined {
        const subject = error.subject;
        if (
            !subject ||
            !ts.isIdentifier(subject) ||
            attempt.declarations.size === 0
        )
            return undefined;
        const symbol = declaredSymbol(checker, subject);
        return symbol ? attempt.declarations.get(symbol) : undefined;
    }

    public report(terminal?: string): SurveyReport {
        const merged = new Map<string, Census>();
        let attempted = 0;
        for (const attempt of this.realms.values()) {
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
            ...(terminal === undefined ? {} : { terminal }),
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
