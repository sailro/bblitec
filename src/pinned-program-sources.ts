/**
 * Pinned code over a vendored third-party package, compiled as program code.
 *
 * A pinned module whose imports (value, type and dynamic, through other
 * pinned modules) reach a vendored package (`vendored-package-sources.ts`)
 * that is source-available, and no package that is not, has no native
 * owner beside its source: its public exports compile as the program's own
 * functions. A program that imports one reads those exports, and the types
 * those modules declare, from the pinned sources instead of the package's
 * declarations (`index.d.ts`), which strip the members those modules keep
 * to themselves; the modules they read values from (`lite-error.ts`) and
 * the package's TypeScript join the program, and their type-only reads of
 * any other pinned module read the package's declarations.
 */
import { readFileSync } from "node:fs";
import { posix, resolve, sep } from "node:path";
import ts from "typescript";
import { isRuntimeImport } from "./module-imports.js";
import { cachedBakeSync, moduleIdentity } from "./bake-cache.js";
import { compilerRepositoryRoot } from "./repository-root.js";
import {
    dynamicImportSpecifier,
    isPackageImportSpecifier,
    isRelativeSpecifier,
    moduleSpecifiers,
} from "./typescript-module-specifiers.js";
import {
    exportedDeclarations,
    readPinFile,
    sharedUpstreamStore,
    type UpstreamSourceStore,
} from "./upstream-source.js";
import {
    vendoredPackages,
    type VendoredPackage,
} from "./vendored-package-sources.js";

type AvailablePackage = Extract<VendoredPackage, { available: true }>;

/** A specifier's package name (`@scope/name` or `name`) and subpath. */
function packageSpecifier(specifier: string): {
    name: string;
    subpath: string;
} {
    const parts = specifier.split("/");
    const count = specifier.startsWith("@") ? 2 : 1;
    const rest = parts.slice(count).join("/");
    return {
        name: parts.slice(0, count).join("/"),
        subpath: rest ? `./${rest}` : ".",
    };
}

/**
 * The specifiers a module's text names, `import("x")` types included, from
 * a parse of its own that sets no parents and is not kept.
 */
function specifierTexts(path: string, text: string): string[] {
    return moduleSpecifiers(
        ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false),
        { importTypes: true },
    ).map((literal) => literal.text);
}

/** A virtual module file the program reads. */
interface VirtualModule {
    readonly path: string;
    readonly text: string;
    /** The pinned module, for a pinned source. */
    readonly pinned?: string;
    /** The vendored package and the module's path in it. */
    readonly vendored?: { readonly name: string; readonly module: string };
}

export class PinnedProgramSources {
    private readonly packages: ReadonlyMap<string, VendoredPackage>;
    private reach: ReadonlyMap<string, "vendored" | "refused"> | undefined;
    private readonly specifiers = new Map<string, readonly string[]>();
    private selection:
        | {
              readonly program: ReadonlySet<string>;
              readonly exports: ReadonlyMap<string, string>;
          }
        | undefined;
    private readonly modules = new Map<string, VirtualModule>();

    public constructor(
        private readonly store: UpstreamSourceStore = sharedUpstreamStore(),
    ) {
        this.packages = vendoredPackages(store.packageRoot);
    }

    /** Whether a pinned module compiles as program code (see the module comment). */
    public qualifies(module: string): boolean {
        return this.reaches().get(module) === "vendored";
    }

    /**
     * What each pinned module's import closure reaches: an available
     * vendored package and nothing unavailable (`vendored`), or a package
     * that is not source-available (`refused`); a module reaching no
     * package is absent. One walk back over the import graph from the
     * modules naming each kind of package.
     */
    private reaches(): ReadonlyMap<string, "vendored" | "refused"> {
        if (this.reach) return this.reach;
        const importers = new Map<string, string[]>();
        const vendored: string[] = [];
        const refused: string[] = [];
        for (const module of this.store.listSources())
            for (const specifier of this.pinnedSpecifiers(module)) {
                if (isRelativeSpecifier(specifier)) {
                    const target = this.store.resolveImport(module, specifier);
                    if (target)
                        importers.set(target, [
                            ...(importers.get(target) ?? []),
                            module,
                        ]);
                } else if (!isPackageImportSpecifier(specifier))
                    (this.packages.get(packageSpecifier(specifier).name)
                        ?.available
                        ? vendored
                        : refused
                    ).push(module);
            }
        const reaching = (named: readonly string[]): Set<string> => {
            const reached = new Set(named);
            const pending = [...reached];
            while (pending.length)
                for (const importer of importers.get(pending.pop()!) ?? [])
                    if (!reached.has(importer)) {
                        reached.add(importer);
                        pending.push(importer);
                    }
            return reached;
        };
        const reach = new Map<string, "vendored" | "refused">();
        for (const module of reaching(vendored)) reach.set(module, "vendored");
        for (const module of reaching(refused)) reach.set(module, "refused");
        this.reach = reach;
        return reach;
    }

    /** The specifiers a pinned module names, in the text the program reads. */
    private pinnedSpecifiers(module: string): readonly string[] {
        let known = this.specifiers.get(module);
        if (!known) {
            known = specifierTexts(module, this.store.getSource(module));
            this.specifiers.set(module, known);
        }
        return known;
    }

    /** The public exports a program compiles from their sources, by name, with their modules. */
    public get exports(): ReadonlyMap<string, string> {
        return this.select().exports;
    }

    /**
     * The exported names the package's declarations declare that these
     * modules own, and every pinned module the program then reads: the
     * qualifying ones and those they read values from.
     */
    private select(): NonNullable<PinnedProgramSources["selection"]> {
        if (this.selection) return this.selection;
        const declarations = ts.createSourceFile(
            "index.d.ts",
            this.declarationsText(),
            ts.ScriptTarget.Latest,
            false,
        );
        const exports = new Map<string, string>();
        for (const name of exportedDeclarations(declarations).keys()) {
            const value = this.store.findPublicExport(name)?.modulePath;
            // A type the package's barrel cannot name is the export of the
            // one qualifying module declaring it.
            const owners =
                value === undefined
                    ? this.store
                          .declaringModules(name)
                          .filter((module) => this.qualifies(module))
                    : [];
            const module =
                value !== undefined
                    ? this.qualifies(value)
                        ? value
                        : undefined
                    : owners.length === 1
                      ? owners[0]
                      : undefined;
            if (module) exports.set(name, module);
        }
        const program = new Set<string>();
        const pending = [...new Set(exports.values())];
        while (pending.length) {
            const module = pending.pop()!;
            if (program.has(module)) continue;
            program.add(module);
            const file = this.store.getSourceFile(module);
            const checker = this.store.program.checkerFor(file);
            // A qualifying module joins whichever way it is named; any other
            // only where its values are read.
            const visit = (node: ts.Node): void => {
                let specifier: string | undefined;
                let runtime: boolean;
                if (
                    (ts.isImportDeclaration(node) ||
                        ts.isExportDeclaration(node)) &&
                    node.moduleSpecifier &&
                    ts.isStringLiteral(node.moduleSpecifier)
                ) {
                    specifier = node.moduleSpecifier.text;
                    runtime = isRuntimeImport(checker, node);
                } else {
                    specifier = dynamicImportSpecifier(node)?.text;
                    runtime = specifier !== undefined;
                }
                const target =
                    specifier !== undefined &&
                    this.store.resolveImport(module, specifier);
                if (target && (runtime || this.qualifies(target)))
                    pending.push(target);
                ts.forEachChild(node, visit);
            };
            visit(file);
        }
        this.selection = { program, exports };
        return this.selection;
    }

    /** The package's declarations (`index.d.ts`). */
    public declarationsPath(): string {
        return resolve(this.store.packageRoot, "index.d.ts");
    }

    private declarationsText(): string {
        return ts.sys.readFile(this.declarationsPath())!;
    }

    /**
     * The package's declarations with these exports, and the types their
     * modules declare, re-exported from the pinned sources.
     */
    public typings(text: string): string {
        const { exports } = this.select();
        const file = ts.createSourceFile(
            "index.d.ts",
            text,
            ts.ScriptTarget.Latest,
            false,
        );
        const removed = [...exportedDeclarations(file)]
            .filter(([name]) => exports.has(name))
            .flatMap(([, statements]) => statements)
            .sort((a, b) => b.pos - a.pos);
        let result = text;
        for (const statement of removed)
            result =
                result.slice(0, statement.getFullStart()) +
                result.slice(statement.end);
        const byModule = new Map<string, string[]>();
        for (const [name, module] of exports)
            byModule.set(module, [...(byModule.get(module) ?? []), name]);
        // Imported as well as exported: the declarations left beside them
        // may name them.
        return [
            result,
            ...[...byModule].flatMap(([module, names]) => {
                const list = names.sort().join(", ");
                return [
                    `import { ${list} } from "./${module.replace(/\.ts$/, ".js")}";`,
                    `export { ${list} };`,
                ];
            }),
        ].join("\n");
    }

    /** The virtual module at an absolute path, when the program reads one there. */
    public module(path: string): VirtualModule | undefined {
        const key = resolve(path);
        const known = this.modules.get(key);
        if (known) return known;
        const { program } = this.select();
        const packageRoot = resolve(this.store.packageRoot);
        let found: VirtualModule | undefined;
        if (key.startsWith(`${packageRoot}${sep}`)) {
            const module = posix.normalize(
                key.slice(packageRoot.length + 1).replaceAll("\\", "/"),
            );
            if (program.has(module))
                found = {
                    path: key,
                    text: this.store.getSource(module),
                    pinned: module,
                };
        }
        for (const vendored of this.packages.values()) {
            if (found || !vendored.available) continue;
            const root = resolve(vendored.root);
            if (!key.startsWith(`${root}${sep}`)) continue;
            const module = key.slice(root.length + 1).replaceAll("\\", "/");
            const text = vendored.modules.get(module);
            if (text !== undefined)
                found = {
                    path: key,
                    text,
                    vendored: { name: vendored.name, module },
                };
        }
        if (found) this.modules.set(key, found);
        return found;
    }

    /**
     * Every virtual module the program reads, by absolute path: the pinned
     * modules and the vendored modules their imports reach. A program roots
     * them, so the checker counts them its own rather than a library's.
     */
    public files(): readonly string[] {
        const { program } = this.select();
        const found = new Set<string>();
        const pending = [...program].map((module) => this.pinnedPath(module));
        while (pending.length) {
            const path = pending.pop()!;
            if (found.has(path)) continue;
            const module = this.module(path);
            if (!module) continue;
            found.add(path);
            for (const specifier of module.pinned
                ? this.pinnedSpecifiers(module.pinned)
                : specifierTexts(path, module.text)) {
                const target = this.resolve(specifier, module);
                if (target && target !== this.declarationsPath())
                    pending.push(target);
            }
        }
        return [...found].sort();
    }

    /** The absolute path of a pinned module the program reads. */
    public pinnedPath(module: string): string {
        return resolve(this.store.packageRoot, module);
    }

    /**
     * Where a specifier in a virtual module resolves: another virtual
     * module, the package's declarations (`declarationsPath`), or
     * undefined when it names nothing the program reads.
     */
    public resolve(
        specifier: string,
        containing: VirtualModule,
    ): string | undefined {
        if (containing.pinned) {
            if (isRelativeSpecifier(specifier)) {
                const target = this.store.resolveImport(
                    containing.pinned,
                    specifier,
                );
                return target && this.select().program.has(target)
                    ? this.pinnedPath(target)
                    : this.declarationsPath();
            }
            return this.packageEntry(specifier);
        }
        const vendored = containing.vendored!;
        if (!isRelativeSpecifier(specifier))
            return this.packageEntry(specifier);
        const owner = this.packages.get(vendored.name) as AvailablePackage;
        const base = posix
            .normalize(posix.join(posix.dirname(vendored.module), specifier))
            .replace(/\.js$/, "");
        const module = [
            `${base}.ts`,
            `${base}.d.ts`,
            `${base}/index.ts`,
            `${base}/index.d.ts`,
        ].find((candidate) => owner.modules.has(candidate));
        return module ? resolve(owner.root, module) : undefined;
    }

    private packageEntry(specifier: string): string | undefined {
        const { name, subpath } = packageSpecifier(specifier);
        const vendored = this.packages.get(name);
        if (!vendored?.available) return undefined;
        const entry = vendored.entries.get(subpath);
        return entry === undefined ? undefined : resolve(vendored.root, entry);
    }
}

let shared: PinnedProgramSources | undefined;
let exportNames: ReadonlySet<string> | undefined;

/**
 * The names of the exports a program compiles from their sources, for the
 * one question every program asks: whether its own imports name one. The
 * answer replays from the bake cache, keyed by the pin, the package lock
 * (which fixes the vendored packages installed) and the corpus's pinned
 * type-only sources, so a program whose imports name none reads neither
 * the pin's sources nor the vendored maps.
 */
export function pinnedProgramExportNames(): ReadonlySet<string> {
    if (exportNames) return exportNames;
    const root = compilerRepositoryRoot();
    const corpus = readPinFile("upstream/babylon-lite-corpus.json", root) as {
        packageSources?: unknown;
    };
    const inputs = [
        readFileSync(resolve(root, "package-lock.json")),
        readFileSync(resolve(root, "upstream/babylon-lite.json")),
        new TextEncoder().encode(JSON.stringify(corpus.packageSources ?? [])),
    ];
    const names = cachedBakeSync(
        {
            kind: "pinned-program-exports",
            version: "1",
            module: [
                import.meta.url,
                new URL("./vendored-package-sources.js", import.meta.url).href,
                new URL("./upstream-source.js", import.meta.url).href,
            ]
                .map(moduleIdentity)
                .join(":"),
            browser: false,
            buildConditions: true,
            parameters: {},
            inputs,
        },
        () =>
            new TextEncoder().encode(
                JSON.stringify([...pinnedProgramSources().exports.keys()]),
            ),
    );
    exportNames = new Set(
        JSON.parse(new TextDecoder().decode(names)) as string[],
    );
    return exportNames;
}

/** The process's one view of these sources over the shared pin store. */
export function pinnedProgramSources(): PinnedProgramSources {
    shared ??= new PinnedProgramSources();
    return shared;
}
