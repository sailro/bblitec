import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { findRepositoryRoot } from "./repository-root.js";
import { PinnedProgram, registerPinnedSource } from "./pinned-program.js";
import { listFiles } from "./tooling/records.js";
export { findRepositoryRoot } from "./repository-root.js";

import {
    assertPinnedWgslTagIsIdentity,
    pinnedTaggedWgslTransform,
} from "./pinned-wgsl-build.js";

interface SourceMapFile {
    sources?: string[];
    sourcesContent?: Array<string | null>;
}

interface PackageMetadata {
    name: string;
    version: string;
    babylonLiteRelease?: {
        sourceVersion?: string;
    };
}

export interface UpstreamPin {
    package: string;
    version: string;
    sourceVersion: string;
}

/**
 * A repository file as the manifest and its readers spell it: relative to
 * the repository root, forward slashes, so a recorded input list compares
 * byte for byte wherever the checkout lives.
 */
export function repositoryRelativePath(
    repositoryRoot: string,
    path: string,
): string {
    return relative(repositoryRoot, resolve(path)).replaceAll("\\", "/");
}

export function readUpstreamPin(
    repositoryRoot = findRepositoryRoot(
        dirname(fileURLToPath(import.meta.url)),
    ),
    pinPath = "upstream/babylon-lite.json",
): UpstreamPin {
    const value: unknown = JSON.parse(
        readFileSync(resolve(repositoryRoot, pinPath), "utf8"),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Invalid Babylon Lite pin file: ${pinPath}.`);
    }
    const record = value as Record<string, unknown>;
    if (
        typeof record.package !== "string" ||
        typeof record.version !== "string" ||
        typeof record.sourceVersion !== "string"
    ) {
        throw new Error(
            `Babylon Lite pin requires package, version, and sourceVersion strings: ${pinPath}.`,
        );
    }
    return {
        package: record.package,
        version: record.version,
        sourceVersion: record.sourceVersion,
    };
}

export interface PublicExport {
    exportedName: string;
    importedName: string;
    modulePath: string;
}

function virtualSourcePath(source: string): string | undefined {
    const normalized = source.replace(/\\/g, "/");
    const marker = normalized.lastIndexOf("/src/");
    if (marker >= 0) return normalized.slice(marker + 1);
    if (normalized.startsWith("src/")) return normalized;
    const relativeMarker = normalized.indexOf("src/");
    return relativeMarker >= 0 ? normalized.slice(relativeMarker) : undefined;
}

/**
 * The one store a process reads the pin through.
 *
 * Constructing a store parses the whole published source-map set and every
 * public export -- around 14 MB of JSON and a hundred-plus source files --
 * and the pin does not change while a process runs, so the modules that
 * reach for pinned facts share this rather than each rebuilding it. A
 * caller that needs an isolated store (a test pointing at another tree)
 * still constructs its own.
 */
let shared: UpstreamSourceStore | undefined;

export function sharedUpstreamStore(): UpstreamSourceStore {
    if (!shared) shared = new UpstreamSourceStore();
    return shared;
}

export class UpstreamSourceStore {
    public readonly packageRoot: string;
    public readonly pin: UpstreamPin;
    private readonly repositoryRoot: string;
    private readonly sources = new Map<string, string>();
    /**
     * Each module's text as the pin's own package build leaves it
     * (`pinned-wgsl-build.ts`), memoized per module across every store
     * over the same package, since the transform is a pure function of the
     * module: everything that reads a pinned module reads this, so a
     * shader folded from a builder's AST is the text the browser compiles,
     * byte for byte.
     */
    private static readonly builtSources = new Map<string, string>();
    private readonly sourceFiles = new Map<string, ts.SourceFile>();
    private readonly packagedModules = new Map<string, string>();
    private readonly declarationModules = new Map<string, string[]>();
    private readonly publicExports = new Map<string, PublicExport>();
    private typedProgram: PinnedProgram | undefined;

    public constructor(
        repositoryRoot = findRepositoryRoot(
            dirname(fileURLToPath(import.meta.url)),
        ),
        pinPath = "upstream/babylon-lite.json",
    ) {
        const pin = readUpstreamPin(repositoryRoot, pinPath);
        this.pin = pin;
        this.repositoryRoot = repositoryRoot;
        this.packageRoot = resolve(
            repositoryRoot,
            "node_modules",
            ...pin.package.split("/"),
        );
        const packageJsonPath = join(this.packageRoot, "package.json");
        if (!existsSync(packageJsonPath)) {
            throw new Error(
                `Pinned upstream package is not installed: ${pin.package}@${pin.version}. Run npm ci.`,
            );
        }
        const metadata = JSON.parse(
            readFileSync(packageJsonPath, "utf8"),
        ) as PackageMetadata;
        if (metadata.name !== pin.package || metadata.version !== pin.version) {
            throw new Error(
                `Upstream package mismatch: expected ${pin.package}@${pin.version}, ` +
                    `found ${metadata.name}@${metadata.version}.`,
            );
        }
        if (metadata.babylonLiteRelease?.sourceVersion !== pin.sourceVersion) {
            throw new Error(
                `Upstream source commit mismatch: expected ${pin.sourceVersion}, ` +
                    `found ${metadata.babylonLiteRelease?.sourceVersion ?? "unknown"}.`,
            );
        }

        this.loadSources();
        // Stripping the pin's `wgsl` tag -- here, in the compiler's readers
        // of scene source, and in the Canvas2D helper module -- is sound
        // only while the helper is the identity over its template; one
        // check per store settles it for every reader.
        assertPinnedWgslTagIsIdentity(this.getSourceFile("src/shader/wgsl.ts"));
    }

    public getSource(modulePath: string): string {
        const normalized = modulePath.replace(/\\/g, "/");
        const key = `${this.packageRoot}\0${normalized}`;
        const built = UpstreamSourceStore.builtSources.get(key);
        if (built !== undefined) return built;
        const source = this.sources.get(normalized);
        if (!source)
            throw new Error(
                `Upstream TypeScript source not found: ${normalized}.`,
            );
        const text =
            pinnedTaggedWgslTransform(this.repositoryRoot)(source, normalized)
                ?.code ?? source;
        UpstreamSourceStore.builtSources.set(key, text);
        return text;
    }

    public hasSource(modulePath: string): boolean {
        return this.sources.has(modulePath.replace(/\\/g, "/"));
    }

    /** The emitted module containing a source, including Vite's shared chunks. */
    public packagedModulePath(modulePath: string): string {
        const path = this.packagedModules.get(modulePath);
        if (!path)
            throw new Error(`No packaged module contains ${modulePath}.`);
        return path;
    }

    public getSourceFile(modulePath: string): ts.SourceFile {
        const normalized = modulePath.replace(/\\/g, "/");
        const cached = this.sourceFiles.get(normalized);
        if (cached) {
            return cached;
        }
        const sourceFile = ts.createSourceFile(
            normalized,
            this.getSource(normalized),
            ts.ScriptTarget.Latest,
            true,
            normalized.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
        );
        this.sourceFiles.set(normalized, sourceFile);
        registerPinnedSource(sourceFile, () => this.program);
        return sourceFile;
    }

    /**
     * The checked program over these sources, built on the first question
     * asked of it and shared by every reader of this store.
     */
    public get program(): PinnedProgram {
        this.typedProgram ??= new PinnedProgram(this);
        return this.typedProgram;
    }

    public listSources(): string[] {
        return [...this.sources.keys()].sort();
    }

    /** The public export `name`, or undefined when the package exports no such name. */
    public findPublicExport(name: string): PublicExport | undefined {
        if (this.publicExports.size === 0) this.loadPublicExports();
        return this.publicExports.get(name);
    }

    public resolvePublicExport(name: string): PublicExport {
        const entry = this.findPublicExport(name);
        if (!entry)
            throw new Error(
                `Babylon Lite public export '${name}' was not found.`,
            );
        return entry;
    }

    public resolveImport(
        fromModule: string,
        specifier: string,
    ): string | undefined {
        if (!specifier.startsWith(".")) return undefined;
        const withoutExtension = specifier.replace(/\.(?:js|mjs|cjs|ts)$/, "");
        const candidate = posix.normalize(
            posix.join(posix.dirname(fromModule), `${withoutExtension}.ts`),
        );
        return this.hasSource(candidate) ? candidate : undefined;
    }

    private loadSources(): void {
        const libRoot = join(this.packageRoot, "lib");
        for (const mapPath of listFiles(libRoot).filter((path) =>
            path.endsWith(".js.map"),
        )) {
            const map = JSON.parse(
                readFileSync(mapPath, "utf8"),
            ) as SourceMapFile;
            for (
                let index = 0;
                index < (map.sources?.length ?? 0);
                index += 1
            ) {
                const content = map.sourcesContent?.[index];
                const path = map.sources?.[index]
                    ? virtualSourcePath(map.sources[index]!)
                    : undefined;
                if (path && content) {
                    this.sources.set(path, content);
                    this.packagedModules.set(
                        path,
                        relative(libRoot, mapPath.slice(0, -4)).replace(
                            /\\/g,
                            "/",
                        ),
                    );
                }
            }
        }
        // Vite 8 publishes the original barrel in its source map. The
        // bundled barrel aliases imports through minified local names.
        if (!this.sources.has("src/index.ts")) {
            this.sources.set(
                "src/index.ts",
                readFileSync(join(libRoot, "index.js"), "utf8"),
            );
        }
    }

    private loadPublicExports(): void {
        const file = this.getSourceFile("src/index.ts");
        for (const statement of file.statements) {
            if (
                !ts.isExportDeclaration(statement) ||
                !statement.exportClause ||
                !ts.isNamedExports(statement.exportClause)
            ) {
                continue;
            }
            for (const element of statement.exportClause.elements) {
                const exportedName = element.name.text;
                const hasModule =
                    statement.moduleSpecifier &&
                    ts.isStringLiteral(statement.moduleSpecifier);
                const modulePath =
                    (hasModule
                        ? this.resolveImport(
                              "src/index.ts",
                              statement.moduleSpecifier.text,
                          )
                        : undefined) ?? this.findSourceExport(exportedName);
                if (!modulePath) continue;
                this.publicExports.set(exportedName, {
                    exportedName,
                    importedName: hasModule
                        ? (element.propertyName?.text ?? exportedName)
                        : exportedName,
                    modulePath,
                });
            }
        }
    }

    /**
     * The module declaring an export the barrel names without a specifier
     * (a bundled barrel aliases its imports through minified local names).
     * The index of every source's exported declarations is built from their
     * syntax the first time one is asked for, which is also the first time a
     * public export is resolved: a process that never resolves one parses
     * none of it. The parse is the index's own, so it retains no tree.
     */
    private findSourceExport(name: string): string | undefined {
        if (this.declarationModules.size === 0) {
            for (const path of this.listSources()) {
                if (path === "src/index.ts") continue;
                for (const declared of exportedDeclarationNames(
                    ts.createSourceFile(
                        path,
                        this.sources.get(path)!,
                        ts.ScriptTarget.Latest,
                        false,
                    ),
                )) {
                    const modules = this.declarationModules.get(declared) ?? [];
                    modules.push(path);
                    this.declarationModules.set(declared, modules);
                }
            }
        }
        return this.declarationModules.get(name)?.[0];
    }
}

/** The names a module's `export`-modified declarations bind. */
function exportedDeclarationNames(file: ts.SourceFile): string[] {
    const names: string[] = [];
    for (const statement of file.statements) {
        if (
            !ts.canHaveModifiers(statement) ||
            !ts
                .getModifiers(statement)
                ?.some(
                    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
                )
        ) {
            continue;
        }
        if (
            (ts.isFunctionDeclaration(statement) ||
                ts.isClassDeclaration(statement) ||
                ts.isInterfaceDeclaration(statement) ||
                ts.isTypeAliasDeclaration(statement) ||
                ts.isEnumDeclaration(statement)) &&
            statement.name
        ) {
            names.push(statement.name.text);
        } else if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) {
                    names.push(declaration.name.text);
                }
            }
        }
    }
    return names;
}
