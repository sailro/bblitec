import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";
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
    private readonly publicExports = new Map<string, PublicExport>();

    public constructor(repositoryRoot = process.cwd(), pinPath = "upstream/babylon-lite.json") {
        const pin = JSON.parse(readFileSync(resolve(repositoryRoot, pinPath), "utf8")) as UpstreamPin;
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
        const source = this.getSource("src/index.ts");
        const file = ts.createSourceFile("src/index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
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
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(
            `\\bexport\\s+(?:(?:async\\s+)?function|class|const|let|var|interface|type)\\s+${escaped}\\b`,
        );
        for (const [path, source] of this.sources) {
            if (path !== "src/index.ts" && pattern.test(source)) return path;
        }
        return undefined;
    }
}
