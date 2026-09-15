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
 * the survey's: `probeEmission` counts its depth and the wrapper stands
 * aside while any probe is open. A compile attempt that restarts for a
 * storage replay discards its realm's records; a refusal raised outside
 * statement lowering ends the survey as incomplete.
 */
import ts from "typescript";
import { CompileError } from "./compile-error.js";
import { sourceLocation } from "../source-location.js";

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
export interface SurveyEmissionContext {
    readonly checker: ts.TypeChecker;
    surveyEmission<T>(emit: () => T): T;
}

/** One compile attempt's census; a replay of the same realm replaces it. */
export interface SurveyAttempt {
    attempted: number;
    refused: number;
    refusals: Map<string, SurveyRefusal>;
    /** The statements each refusal rolled back, by refusal key. */
    rolledBack: Map<string, Set<string>>;
    declarations: Map<ts.Symbol, SurveySite>;
}

const UNKNOWN_VARIABLE = /^Unknown or unsupported variable '([^']+)'\.$/;

// `ts.SyntaxKind[kind]` answers with an alias (`FirstStatement`) for the
// kinds that mark a range; the first named kind for each value is the one
// a reader recognises.
const kindNames = new Map<number, string>();
for (const [name, value] of Object.entries(ts.SyntaxKind)) {
    if (typeof value !== "number" || /^(?:First|Last)[A-Z]/.test(name) || kindNames.has(value)) continue;
    kindNames.set(value, name);
}

function syntaxKindName(kind: ts.SyntaxKind): string {
    return kindNames.get(kind) ?? String(kind);
}

/** The message shape: names, numbers and parenthesised detail elided. */
export function refusalClass(message: string): string {
    return message
        .replace(/'[^']*'/g, "'…'")
        .replace(/"[^"]*"/g, "\"…\"")
        .replace(/\([^()]*\)/g, "(…)")
        .replace(/\b\d+(?:\.\d+)?\b/g, "N");
}

function enclosingFunctionName(statement: ts.Statement): string {
    const owner = ts.findAncestor(statement.parent, node => ts.isFunctionLike(node) || ts.isSourceFile(node));
    if (!owner || ts.isSourceFile(owner)) return "<module>";
    const name = ts.getNameOfDeclaration(owner);
    if (name) return name.getText();
    if (ts.isConstructorDeclaration(owner)) return "constructor";
    return ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name)
        ? owner.parent.name.text : "<anonymous>";
}

function declaredNames(statement: ts.Statement): ts.Identifier[] {
    const names: ts.Identifier[] = [];
    const collect = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) names.push(name);
        else for (const element of name.elements) if (ts.isBindingElement(element)) collect(element.name);
    };
    if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) collect(declaration.name);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) && statement.name) {
        names.push(statement.name);
    }
    return names;
}

function identifierAt(statement: ts.Statement, text: string, line: number, column: number): ts.Identifier | undefined {
    let found: ts.Identifier | undefined;
    const visit = (node: ts.Node): void => {
        if (found) return;
        if (ts.isIdentifier(node) && node.text === text) {
            const location = sourceLocation(node);
            if (location.line === line && location.character === column) { found = node; return; }
        }
        ts.forEachChild(node, visit);
    };
    visit(statement);
    return found;
}

export class SurveyCollector {
    private speculation = 0;
    private readonly realms = new Map<string, SurveyAttempt>();
    private current: SurveyAttempt | undefined;

    /** True while a speculative probe is open: its refusals are the probe's to decide. */
    public get speculating(): boolean {
        return this.speculation > 0;
    }

    public enterSpeculation(): void {
        this.speculation++;
    }

    public leaveSpeculation(): void {
        this.speculation--;
    }

    /**
     * Starts a realm's compile attempt, replacing the census a previous
     * attempt of the same realm left. Returns what to `resume` afterwards.
     */
    public beginAttempt(realm: string): SurveyAttempt | undefined {
        const previous = this.current;
        const attempt: SurveyAttempt = { attempted: 0, refused: 0, refusals: new Map(), rolledBack: new Map(), declarations: new Map() };
        this.realms.set(realm, attempt);
        this.current = attempt;
        return previous;
    }

    public resume(previous: SurveyAttempt | undefined): void {
        this.current = previous;
    }

    /** Lowers one statement under a transaction; a refusal rolls it back and is recorded. */
    public attemptStatement(context: SurveyEmissionContext, statement: ts.Statement, lower: () => void): void {
        const attempt = this.current;
        if (!attempt) {
            lower();
            return;
        }
        attempt.attempted++;
        try {
            context.surveyEmission(() => { lower(); return true; });
        } catch (error) {
            if (!(error instanceof CompileError)) throw error;
            attempt.refused++;
            this.record(attempt, context.checker, statement, error);
        }
    }

    private record(attempt: SurveyAttempt, checker: ts.TypeChecker, statement: ts.Statement, error: CompileError): void {
        const prefix = `${error.fileName}:${error.line}:${error.column}: `;
        const message = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
        const key = `${prefix}${message}`;
        const location = sourceLocation(statement);
        const rolledBack = attempt.rolledBack.get(key) ?? new Set<string>();
        rolledBack.add(`${location.file.fileName}:${location.line}`);
        attempt.rolledBack.set(key, rolledBack);
        let refusal = attempt.refusals.get(key);
        if (refusal) {
            refusal.occurrences++;
            refusal.statements = rolledBack.size;
        } else {
            refusal = {
                site: { file: error.fileName, line: error.line, column: error.column },
                message,
                class: refusalClass(message),
                statement: {
                    file: location.file.fileName,
                    line: location.line,
                    kind: syntaxKindName(statement.kind),
                    function: enclosingFunctionName(statement),
                },
                occurrences: 1,
                statements: 1,
            };
            const cascade = this.cascadeOf(attempt, checker, statement, error, message);
            if (cascade) refusal.cascade = cascade;
            attempt.refusals.set(key, refusal);
        }
        // Every statement this refusal rolled back loses its declarations,
        // whichever caller reached the site first.
        for (const name of declaredNames(statement)) {
            const symbol = checker.getSymbolAtLocation(name);
            if (symbol && !attempt.declarations.has(symbol)) attempt.declarations.set(symbol, refusal.site);
        }
    }

    /** A refusal naming a binding that a refused statement would have declared. */
    private cascadeOf(attempt: SurveyAttempt, checker: ts.TypeChecker, statement: ts.Statement,
        error: CompileError, message: string): SurveySite | undefined {
        const unknown = UNKNOWN_VARIABLE.exec(message);
        if (!unknown || attempt.declarations.size === 0) return undefined;
        const identifier = identifierAt(statement, unknown[1]!, error.line, error.column);
        const symbol = identifier ? checker.getSymbolAtLocation(identifier) : undefined;
        return symbol ? attempt.declarations.get(symbol) : undefined;
    }

    public report(complete: boolean, terminal?: string): SurveyReport {
        const merged = new Map<string, SurveyRefusal>();
        let attempted = 0;
        let refused = 0;
        for (const attempt of this.realms.values()) {
            attempted += attempt.attempted;
            refused += attempt.refused;
            for (const [key, refusal] of attempt.refusals) {
                const existing = merged.get(key);
                if (existing) {
                    existing.occurrences += refusal.occurrences;
                    existing.statements += refusal.statements;
                } else merged.set(key, { ...refusal, site: { ...refusal.site }, statement: { ...refusal.statement } });
            }
        }
        const refusals = [...merged.values()].sort((a, b) =>
            a.site.file.localeCompare(b.site.file) || a.site.line - b.site.line || a.site.column - b.site.column);
        const classes = new Map<string, SurveyClass>();
        for (const refusal of refusals) {
            const entry = classes.get(refusal.class) ??
                { class: refusal.class, sites: 0, cascades: 0, occurrences: 0, example: refusal.message };
            entry.sites++;
            if (refusal.cascade) entry.cascades++;
            entry.occurrences += refusal.occurrences;
            classes.set(refusal.class, entry);
        }
        return {
            schemaVersion: 1,
            complete,
            ...(terminal === undefined ? {} : { terminal }),
            statements: { attempted, refused },
            refusals,
            classes: [...classes.values()].sort((a, b) => b.sites - a.sites || b.occurrences - a.occurrences || a.class.localeCompare(b.class)),
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
