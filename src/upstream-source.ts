import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
    dirname,
    join,
    posix,
    resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

export class UpstreamSourceStore {
    public readonly packageRoot: string;
    public readonly pin: UpstreamPin;
    private readonly sources = new Map<string, string>();
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
        const source = this.sources.get(normalized);
        if (!source) throw new Error(`Upstream TypeScript source not found: ${normalized}.`);
        return source;
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
