/**
 * The TypeScript of the third-party packages the pin vendors into its
 * `lib/_chunks/vendor/` chunks, read as a program reads its own modules.
 *
 * A vendor chunk's source map names each bundled file by its installed
 * path (`node_modules/.pnpm/<name>@<version>/node_modules/<name>/<file>`)
 * and carries its bytes. A package is source-available when the checkout
 * installs that exact version, every bundled file is byte-identical to the
 * installed one, and the installed package's own source maps carry the
 * TypeScript each file was built from: those sources are then the
 * package's modules. A declaration file with no source beside it stands for
 * the module it declares: a barrel of re-exports is that module's source,
 * and a module of types only stays a declaration.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { compilerRepositoryRoot } from "./repository-root.js";
import { sourceMapSources } from "./source-maps.js";
import { listFiles } from "./tooling/records.js";
import { reexportsOnly } from "./typescript-module-specifiers.js";

interface PackageManifest {
    name?: string;
    version?: string;
    main?: string;
    types?: string;
    exports?: Record<string, string | Record<string, string>>;
}

/** One vendored package: available with its modules, or not with the reason. */
export type VendoredPackage =
    | {
          readonly name: string;
          readonly version: string;
          readonly available: true;
          /** The installed package directory. */
          readonly root: string;
          /** Module text by path relative to `root` (`src/x.ts`, `src/types.d.ts`). */
          readonly modules: ReadonlyMap<string, string>;
          /** Entry modules by subpath (`.`, `./blocks`), relative to `root`. */
          readonly entries: ReadonlyMap<string, string>;
      }
    | {
          readonly name: string;
          readonly version: string;
          readonly available: false;
          readonly reason: string;
      };

const VENDORED_FILE =
    /(?:^|\/)node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/;

/** The version a pnpm store directory names: `<name>@<version>[_peers]`. */
function storeVersion(source: string, name: string): string | undefined {
    const store = source.match(/node_modules\/\.pnpm\/([^/]+)\//)?.[1];
    const prefix = `${name.replace("/", "+")}@`;
    return store?.startsWith(prefix)
        ? store.slice(prefix.length).split("_")[0]
        : undefined;
}

/**
 * Where the package's declarations sit relative to its sources: the
 * directory prefix pair most declaration/source files with the same tail
 * agree on (`dist/` + `src/x` for `dist/src/x.d.ts`, `dist/` and `src/` for
 * `dist/x.d.ts` beside `src/x.ts`).
 */
function declarationRoots(
    declarations: readonly string[],
    sources: ReadonlySet<string>,
): { declarations: string; sources: string } | undefined {
    const votes = new Map<string, number>();
    const byName = new Map<string, string[]>();
    for (const source of sources) {
        const name = posix.basename(source).replace(/\.ts$/, "");
        byName.set(name, [...(byName.get(name) ?? []), source]);
    }
    for (const declaration of declarations) {
        const stem = declaration.replace(/\.d\.ts$/, "").split("/");
        for (const source of byName.get(stem.at(-1)!) ?? []) {
            const path = source.replace(/\.ts$/, "").split("/");
            let shared = 0;
            while (
                shared < Math.min(stem.length, path.length) &&
                stem[stem.length - 1 - shared] ===
                    path[path.length - 1 - shared]
            )
                shared++;
            const key = JSON.stringify([
                stem.slice(0, stem.length - shared).join("/"),
                path.slice(0, path.length - shared).join("/"),
            ]);
            votes.set(key, (votes.get(key) ?? 0) + 1);
        }
    }
    const best = [...votes].sort((a, b) => b[1] - a[1])[0];
    if (!best) return undefined;
    const [declarationRoot, sourceRoot] = JSON.parse(best[0]) as [
        string,
        string,
    ];
    const prefix = (root: string): string => (root ? `${root}/` : "");
    return {
        declarations: prefix(declarationRoot),
        sources: prefix(sourceRoot),
    };
}

function readPackage(
    name: string,
    version: string,
    bundled: ReadonlyMap<string, string>,
): VendoredPackage {
    const unavailable = (reason: string): VendoredPackage => ({
        name,
        version,
        available: false,
        reason,
    });
    const root = resolve(
        compilerRepositoryRoot(),
        "node_modules",
        ...name.split("/"),
    );
    const manifestPath = join(root, "package.json");
    if (!existsSync(manifestPath))
        return unavailable(`${name}@${version} is not installed`);
    const manifest = JSON.parse(
        readFileSync(manifestPath, "utf8"),
    ) as PackageManifest;
    if (manifest.version !== version)
        return unavailable(
            `${name} installs ${manifest.version ?? "no version"}, the pin vendors ${version}`,
        );
    for (const [file, text] of bundled) {
        const installed = join(root, file);
        if (!existsSync(installed) || readFileSync(installed, "utf8") !== text)
            return unavailable(
                `${name}@${version} ${file} differs from the pin's vendored copy`,
            );
        const map = `${installed}.map`;
        const sources = existsSync(map) ? sourceMapSources(map) : [];
        if (
            sources.length === 0 ||
            sources.some(
                ({ source, content }) => !source.endsWith(".ts") || !content,
            )
        )
            return unavailable(
                `${name}@${version} ${file} carries no TypeScript source`,
            );
    }
    const files = listFiles(root).map((path) =>
        relative(root, path).replaceAll("\\", "/"),
    );
    const modules = new Map<string, string>();
    for (const file of files.filter((path) => path.endsWith(".js.map")))
        for (const { source, content } of sourceMapSources(join(root, file))) {
            const path = posix.normalize(
                posix.join(posix.dirname(file), source),
            );
            if (content && source.endsWith(".ts") && !path.startsWith("../"))
                modules.set(path, content);
        }
    const declarations = files.filter((path) => path.endsWith(".d.ts"));
    const roots = declarationRoots(declarations, new Set(modules.keys()));
    if (!roots)
        return unavailable(
            `${name}@${version} declarations match none of its sources`,
        );
    const sourceOf = (declaration: string): string | undefined =>
        declaration.startsWith(roots.declarations)
            ? `${roots.sources}${declaration.slice(roots.declarations.length)}`
            : undefined;
    for (const declaration of declarations) {
        const module = sourceOf(declaration);
        if (!module || modules.has(module.replace(/\.d\.ts$/, ".ts"))) continue;
        const text = readFileSync(join(root, declaration), "utf8");
        modules.set(
            reexportsOnly(declaration, text)
                ? module.replace(/\.d\.ts$/, ".ts")
                : module,
            text,
        );
    }
    const entries = new Map<string, string>();
    const entry = (subpath: string, types: string | undefined): void => {
        const declaration = types && posix.normalize(types);
        const module = declaration && sourceOf(declaration);
        const source = module?.replace(/\.d\.ts$/, ".ts");
        if (source && modules.has(source)) entries.set(subpath, source);
    };
    const exports = manifest.exports;
    if (exports)
        for (const [subpath, target] of Object.entries(exports))
            entry(
                subpath,
                typeof target === "string" ? undefined : target.types,
            );
    else entry(".", manifest.types);
    if (!entries.has("."))
        return unavailable(`${name}@${version} declares no typed entry`);
    return { name, version, available: true, root, modules, entries };
}

const vendored = new Map<string, ReadonlyMap<string, VendoredPackage>>();

/**
 * The packages the pin's vendor chunks bundle, by name, read once per
 * process from the pinned package at `packageRoot`.
 */
export function vendoredPackages(
    packageRoot: string,
): ReadonlyMap<string, VendoredPackage> {
    const known = vendored.get(packageRoot);
    if (known) return known;
    const bundled = new Map<
        string,
        { version: string; files: Map<string, string> }
    >();
    const chunks = join(packageRoot, "lib", "_chunks", "vendor");
    for (const mapPath of existsSync(chunks)
        ? listFiles(chunks).filter((path) => path.endsWith(".js.map"))
        : []) {
        for (const { source, content } of sourceMapSources(mapPath)) {
            const normalized = source.replaceAll("\\", "/");
            const match = normalized.match(VENDORED_FILE);
            if (!match || content === undefined) continue;
            const [, name, file] = match;
            const version = storeVersion(normalized, name!);
            if (!version) continue;
            const entry = bundled.get(name!) ?? {
                version,
                files: new Map<string, string>(),
            };
            entry.files.set(file!, content);
            bundled.set(name!, entry);
        }
    }
    const packages = new Map(
        [...bundled].map(([name, { version, files }]) => [
            name,
            readPackage(name, version, files),
        ]),
    );
    vendored.set(packageRoot, packages);
    return packages;
}
