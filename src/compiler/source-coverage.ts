import { createHash } from "node:crypto";
import { resolve } from "node:path";
import ts from "typescript";
import { CompileError } from "./compile-error.js";
import { EmissionMap } from "./emission-transaction.js";
import { sourceFunctionName } from "./syntax.js";
import { sourceLocation, syntaxKindName } from "../source-location.js";

interface Observation {
    attempts: number;
    refusals: Set<string>;
}

interface RealmCoverage {
    program: ts.Program;
    observed: Map<ts.Statement, Observation>;
    retained: EmissionMap<ts.Statement, "lowered" | "partial">;
    /** Those of work whose state rolled back but whose lowerings count (`keepingCoverage`). */
    kept: Map<ts.Statement, "lowered" | "partial">;
    /**
     * The statements whose lowering ended, in order, while a survey mark is
     * open (`coverageMark`), since a survey last attributed a rollback
     * (`coverRollback`): a rollback undoes `retained` but not this log.
     */
    lowered: ts.Statement[];
    /** The survey marks open: the log is kept only while one is. */
    marks: number;
    /** What rolled each statement back: the innermost survey rollback that undid its lowering. */
    rolledBackBy: Map<ts.Statement, Set<string>>;
    failures: number;
    complete: boolean;
    terminal?: string;
}

interface SourceSite {
    file: string;
    sha256: string;
    start: number;
    end: number;
    kind: string;
    line: number;
    column: number;
}

export interface SourceCoverageReport {
    schemaVersion: 1;
    /** Lowering observations only: neither generated output nor native build proof. */
    measure: "statement-lowering";
    realms: {
        entry: string;
        complete: boolean;
        terminal?: string;
        files: { file: string; sha256: string }[];
        sites: (SourceSite & {
            owner?: SourceSite & { name: string };
            state: "lowered" | "partial" | "refused" | "rolled-back";
            attempts: number;
            refusals: string[];
            /** For a rolled-back site in a survey: the refusals or storage demands that rolled it back. */
            rolledBackBy?: string[];
        })[];
    }[];
}

/** An immutable source location shared by coverage and deferred capabilities. */
export class SourceSiteRegistry {
    /** Replays and independent collectors share immutable parsed source text. */
    private static readonly hashes = new WeakMap<ts.SourceFile, string>();

    file(source: ts.SourceFile): { file: string; sha256: string } {
        let sha256 = SourceSiteRegistry.hashes.get(source);
        if (!sha256) {
            sha256 = createHash("sha256").update(source.text).digest("hex");
            SourceSiteRegistry.hashes.set(source, sha256);
        }
        return { file: resolve(source.fileName), sha256 };
    }

    site(node: ts.Node): SourceSite {
        const original = ts.getOriginalNode(node);
        const { file, line, character } = sourceLocation(original);
        return {
            ...this.file(file),
            start: original.getStart(file),
            end: original.end,
            kind: syntaxKindName(original.kind),
            line,
            column: character,
        };
    }
}

let active: SourceCoverage | undefined;
let current: RealmCoverage | undefined;

/**
 * Opt-in observations. A storage replay replaces the preceding attempt of
 * its realm; an attempt that ends short of an earlier one leaves that one,
 * so a compile stopped before it finished reports its furthest attempt.
 */
export class SourceCoverage {
    /** @unjournaled Each realm keeps one observation attempt; retained sites journal separately. */
    private readonly realms = new Map<string, RealmCoverage>();

    run<T>(work: () => T): T {
        const previous = active;
        const previousRealm = current;
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- A synchronous dynamic scope, restored before returning.
        active = this;
        current = undefined;
        try {
            return work();
        } finally {
            active = previous;
            current = previousRealm;
        }
    }

    realm<T>(program: ts.Program, entry: string, work: () => T): T {
        const previous = current;
        const key = resolve(entry);
        const furthest = this.realms.get(key);
        const attempt: RealmCoverage = {
            program,
            observed: new Map(),
            retained: new EmissionMap(),
            kept: new Map(),
            lowered: [],
            marks: 0,
            rolledBackBy: new Map(),
            failures: 0,
            complete: false,
        };
        this.realms.set(key, attempt);
        current = attempt;
        try {
            const result = work();
            attempt.complete = attempt.failures === 0;
            return result;
        } catch (error) {
            attempt.terminal =
                error instanceof Error ? error.message : String(error);
            const reached = (realm: RealmCoverage): number =>
                realm.retained.size + realm.kept.size;
            if (furthest && reached(furthest) > reached(attempt)) {
                furthest.terminal = attempt.terminal;
                this.realms.set(key, furthest);
            }
            throw error;
        } finally {
            current = previous;
        }
    }

    report(): SourceCoverageReport {
        const sources = new SourceSiteRegistry();
        return {
            schemaVersion: 1,
            measure: "statement-lowering",
            realms: [...this.realms].map(([entry, realm]) => {
                const local = (node: ts.Node): boolean => {
                    const file = node.getSourceFile();
                    return (
                        !file.isDeclarationFile &&
                        !realm.program.isSourceFileFromExternalLibrary(file)
                    );
                };
                const nodes = new Set([
                    ...realm.observed.keys(),
                    ...realm.retained.keys(),
                    ...realm.kept.keys(),
                ]);
                const sites = [...nodes]
                    .filter(local)
                    .map((node) => {
                        const observation = realm.observed.get(node);
                        const retained =
                            realm.retained.get(node) ?? realm.kept.get(node);
                        const refused = (observation?.refusals.size ?? 0) > 0;
                        const state =
                            retained === "lowered" && refused
                                ? ("partial" as const)
                                : (retained ??
                                  (refused
                                      ? ("refused" as const)
                                      : ("rolled-back" as const)));
                        const owner = ts.findAncestor(
                            node.parent,
                            ts.isFunctionLike,
                        );
                        const rolledBackBy =
                            state === "rolled-back"
                                ? realm.rolledBackBy.get(node)
                                : undefined;
                        return {
                            ...sources.site(node),
                            ...(owner
                                ? {
                                      owner: {
                                          ...sources.site(owner),
                                          name:
                                              sourceFunctionName(owner) ??
                                              "<anonymous>",
                                      },
                                  }
                                : {}),
                            state,
                            attempts: observation?.attempts ?? 0,
                            refusals: [...(observation?.refusals ?? [])].sort(),
                            ...(rolledBackBy
                                ? { rolledBackBy: [...rolledBackBy].sort() }
                                : {}),
                        };
                    })
                    .sort(
                        (a, b) =>
                            a.file.localeCompare(b.file) ||
                            a.start - b.start ||
                            a.end - b.end,
                    );
                return {
                    entry,
                    complete: realm.complete,
                    ...(realm.terminal ? { terminal: realm.terminal } : {}),
                    files: realm.program
                        .getSourceFiles()
                        .filter(local)
                        .map((file) => sources.file(file)),
                    sites,
                };
            }),
        };
    }
}

export function sourceCoverageActive(): boolean {
    return current !== undefined;
}

/**
 * Opens a mark for `coverRollback`, which `endCoverageMark` closes: the
 * statements whose lowering ended so far.
 */
export function coverageMark(): number {
    if (!current) return 0;
    current.marks++;
    return current.lowered.length;
}

/** Closes the last mark `coverageMark` opened; with the outermost, the log ends. */
export function endCoverageMark(): void {
    if (current && --current.marks === 0) current.lowered.length = 0;
}

/**
 * Records `cause` as what rolled back the statements whose lowering ended
 * since `mark`: a survey's statement attempt that a refusal or a storage
 * demand undid. An enclosing rollback attributes only what this one did not.
 */
export function coverRollback(mark: number, cause: () => string): void {
    const realm = current;
    if (!realm) return;
    const rolledBack = realm.lowered.splice(mark);
    if (!rolledBack.length) return;
    const text = cause();
    for (const statement of rolledBack) {
        let causes = realm.rolledBackBy.get(statement);
        if (!causes) realm.rolledBackBy.set(statement, (causes = new Set()));
        causes.add(text);
    }
}

/** Keep normal compilation independent of the optional collector. */
export function coverSourceRealm<T>(
    program: ts.Program,
    entry: string,
    work: () => T,
): T {
    return active ? active.realm(program, entry, work) : work();
}

/**
 * Runs `work`, whose state an enclosing transaction will roll back, keeping
 * the sites it lowered as lowered.
 */
export function keepingCoverage(work: () => void): void {
    work();
    const realm = current;
    if (realm)
        for (const [statement, state] of realm.retained)
            realm.kept.set(statement, state);
}

/**
 * Records `statements` as lowered in the current emission transaction: a
 * survey's probe that stands on an earlier probe's lowering of them, rolled
 * back since (`touchProbed`).
 */
export function coverLoweredAgain(statements: readonly ts.Statement[]): void {
    const realm = current;
    if (!realm) return;
    for (const statement of statements) {
        const node = ts.getOriginalNode(statement, ts.isStatement);
        if (realm.retained.get(node) !== "partial")
            realm.retained.set(node, "lowered");
    }
}

/** Record successful lowering inside its existing emission transaction. */
export function coverSourceStatement(
    statement: ts.Statement,
    speculating: boolean,
    lower: () => void,
): void {
    const realm = current;
    if (!realm) return lower();
    const node = ts.getOriginalNode(statement, ts.isStatement);
    let observation = realm.observed.get(node);
    if (!speculating) {
        if (!observation) {
            observation = { attempts: 0, refusals: new Set() };
            realm.observed.set(node, observation);
        }
        observation.attempts++;
    }
    const failures = realm.failures;
    try {
        lower();
        const partial =
            realm.failures !== failures ||
            realm.retained.get(node) === "partial";
        realm.retained.set(node, partial ? "partial" : "lowered");
        if (realm.marks > 0) realm.lowered.push(node);
    } catch (error) {
        if (!speculating && error instanceof CompileError) {
            observation?.refusals.add(error.message);
            realm.failures++;
        }
        throw error;
    }
}
