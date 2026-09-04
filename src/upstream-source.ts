import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
    dirname,
    join,
    posix,
    relative,
    resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

export function findRepositoryRoot(
    start = process.cwd(),
): string {
    let current = resolve(start);
    while (true) {
        if (
            existsSync(
                join(
                    current,
                    "upstream",
                    "babylon-lite.json",
                ),
            ) &&
            existsSync(join(current, "package.json"))
        ) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current) {
            throw new Error(
                `Unable to locate the bblitec repository from '${start}'.`,
            );
        }
        current = parent;
    }
}

export function readUpstreamPin(
    repositoryRoot = findRepositoryRoot(
        dirname(fileURLToPath(import.meta.url)),
    ),
    pinPath = "upstream/babylon-lite.json",
): UpstreamPin {
    const value: unknown = JSON.parse(
        readFileSync(
            resolve(repositoryRoot, pinPath),
            "utf8",
        ),
    );
    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value)
    ) {
        throw new Error(
            `Invalid Babylon Lite pin file: ${pinPath}.`,
        );
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

function walk(directory: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) result.push(...walk(path));
        else result.push(path);
    }
    return result;
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
     * Each module's text as the pin's own package build leaves it: the
     * source map carries the source, and `transformTaggedWgsl` -- the pin's
     * build step, executed from its pinned script -- turns every `wgsl`
     * tagged template into the minified plain template the package ships.
     * Everything that reads a pinned module reads this, so a shader folded
     * from a builder's AST is the text the browser compiles, byte for byte.
     */
    private readonly builtSources = new Map<string, string>();
    private wgslTagChecked = false;
    private readonly sourceFiles = new Map<string, ts.SourceFile>();
    private readonly publicExports = new Map<string, PublicExport>();

    public constructor(
        repositoryRoot = findRepositoryRoot(
            dirname(fileURLToPath(import.meta.url)),
        ),
        pinPath = "upstream/babylon-lite.json",
    ) {
        const pin = readUpstreamPin(
            repositoryRoot,
            pinPath,
        );
        this.pin = pin;
        this.repositoryRoot = repositoryRoot;
        this.packageRoot = resolve(repositoryRoot, "node_modules", ...pin.package.split("/"));
        const packageJsonPath = join(this.packageRoot, "package.json");
        if (!existsSync(packageJsonPath)) {
            throw new Error(`Pinned upstream package is not installed: ${pin.package}@${pin.version}. Run npm ci.`);
        }
        const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageMetadata;
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
        this.loadPublicExports();
    }

    public getSource(modulePath: string): string {
        const normalized = modulePath.replace(/\\/g, "/");
        const built = this.builtSources.get(normalized);
        if (built !== undefined) return built;
        const source = this.sources.get(normalized);
        if (!source) throw new Error(`Upstream TypeScript source not found: ${normalized}.`);
        // The plugin's own early-out: a module that never mentions the tag
        // is handed back untouched without a parse.
        const transformed = source.includes("wgsl")
            ? pinnedTaggedWgslTransform(this.repositoryRoot)(source, normalized)
            : null;
        if (transformed && !this.wgslTagChecked) {
            // Stripping the tag is sound only while the helper is the
            // identity over its template, which one check settles for the
            // whole pin.
            this.wgslTagChecked = true;
            assertPinnedWgslTagIsIdentity(this.getSourceFile("src/shader/wgsl.ts"));
        }
        const text = transformed?.code ?? source;
        this.builtSources.set(normalized, text);
        return text;
    }

    public hasSource(modulePath: string): boolean {
        return this.sources.has(modulePath.replace(/\\/g, "/"));
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
            normalized.endsWith(".js")
                ? ts.ScriptKind.JS
                : ts.ScriptKind.TS,
        );
        this.sourceFiles.set(normalized, sourceFile);
        return sourceFile;
    }

    public listSources(): string[] {
        return [...this.sources.keys()].sort();
    }

    public resolvePublicExport(name: string): PublicExport {
        const entry = this.publicExports.get(name);
        if (!entry) throw new Error(`Babylon Lite public export '${name}' was not found.`);
        return entry;
    }

    public resolveImport(fromModule: string, specifier: string): string | undefined {
        if (!specifier.startsWith(".")) return undefined;
        const withoutExtension = specifier.replace(/\.(?:js|mjs|cjs|ts)$/, "");
        const candidate = posix.normalize(posix.join(posix.dirname(fromModule), `${withoutExtension}.ts`));
        return this.hasSource(candidate) ? candidate : undefined;
    }

    private loadSources(): void {
        const libRoot = join(this.packageRoot, "lib");
        for (const mapPath of walk(libRoot).filter((path) => path.endsWith(".js.map"))) {
            const map = JSON.parse(readFileSync(mapPath, "utf8")) as SourceMapFile;
            for (let index = 0; index < (map.sources?.length ?? 0); index += 1) {
                const content = map.sourcesContent?.[index];
                const path = map.sources?.[index] ? virtualSourcePath(map.sources[index]!) : undefined;
                if (path && content) this.sources.set(path, content);
            }
        }
        this.sources.set("src/index.ts", readFileSync(join(libRoot, "index.js"), "utf8"));
    }

    private loadPublicExports(): void {
        const file = this.getSourceFile("src/index.ts");
        for (const statement of file.statements) {
            if (
                !ts.isExportDeclaration(statement) ||
                !statement.exportClause ||
                !ts.isNamedExports(statement.exportClause) ||
                !statement.moduleSpecifier ||
                !ts.isStringLiteral(statement.moduleSpecifier)
            ) {
                continue;
            }
            for (const element of statement.exportClause.elements) {
                const exportedName = element.name.text;
                const modulePath =
                    this.resolveImport("src/index.ts", statement.moduleSpecifier.text) ??
                    this.findSourceExport(exportedName);
                if (!modulePath) continue;
                this.publicExports.set(exportedName, {
                    exportedName,
                    importedName: element.propertyName?.text ?? exportedName,
                    modulePath,
                });
            }
        }
    }

    private findSourceExport(name: string): string | undefined {
        for (const path of this.listSources()) {
            if (path === "src/index.ts") {
                continue;
            }
            const file = this.getSourceFile(path);
            for (const statement of file.statements) {
                if (
                    !(
                        ts.canHaveModifiers(statement) &&
                        ts.getModifiers(statement)?.some(
                        (modifier) =>
                            modifier.kind ===
                            ts.SyntaxKind.ExportKeyword,
                        )
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
                    statement.name?.text === name
                ) {
                    return path;
                }
                if (ts.isVariableStatement(statement)) {
                    for (const declaration of
                        statement.declarationList.declarations) {
                        if (
                            ts.isIdentifier(declaration.name) &&
                            declaration.name.text === name
                        ) {
                            return path;
                        }
                    }
                }
            }
        }
        return undefined;
    }
}
