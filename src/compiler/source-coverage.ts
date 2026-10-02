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
        })[];
    }[];
}

/** An immutable source location shared by coverage and deferred capabilities. */
export class SourceSiteRegistry {
    private readonly hashes = new WeakMap<ts.SourceFile, string>();

    file(source: ts.SourceFile): { file: string; sha256: string } {
        let sha256 = this.hashes.get(source);
        if (!sha256) {
            sha256 = createHash("sha256").update(source.text).digest("hex");
            this.hashes.set(source, sha256);
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

/** Opt-in observations; a storage replay replaces the preceding attempt of its realm. */
export class SourceCoverage {
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
        const attempt: RealmCoverage = {
            program,
            observed: new Map(),
            retained: new EmissionMap(),
            failures: 0,
            complete: false,
        };
        this.realms.set(resolve(entry), attempt);
        current = attempt;
        try {
            const result = work();
            attempt.complete = attempt.failures === 0;
            return result;
        } catch (error) {
            attempt.terminal =
                error instanceof Error ? error.message : String(error);
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
                ]);
                const sites = [...nodes]
                    .filter(local)
                    .map((node) => {
                        const observation = realm.observed.get(node);
                        const retained = realm.retained.get(node);
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

/** Keep normal compilation independent of the optional collector. */
export function coverSourceRealm<T>(
    program: ts.Program,
    entry: string,
    work: () => T,
): T {
    return active ? active.realm(program, entry, work) : work();
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
    } catch (error) {
        if (!speculating && error instanceof CompileError) {
            observation?.refusals.add(error.message);
            realm.failures++;
        }
        throw error;
    }
}
