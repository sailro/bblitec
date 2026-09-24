/**
 * Executes Babylon Lite's own shader composer.
 *
 * `src/shader/shader-composer.ts` is a pure function over a `ShaderTemplate`
 * and a `ShaderFragment[]`, with no device and no browser globals, and the
 * pinned package ships it as an ES module. So the composed WGSL for a material
 * feature set can be *obtained* rather than reproduced — the same shape the HDR
 * prefilter and the drawn sprite atlas already use, and the second of the two
 * legitimate answers in the project's own rule: lower the pinned AST, or
 * execute the pinned code.
 *
 * This matters because the alternative was a transcription of the composed
 * fragment spliced by text marker, and every arm a transcription misses reads
 * as a small systematic shading bias — the clearcoat base-F0 remap reached a
 * published gate that way before the swap. Production composition goes through
 * `createPbrComposer` and `composeSceneStandardVariants`; this module owns
 * the pinned imports and extraction helpers they and the lifted builtins
 * share.
 */
import ts from "typescript";

import { javascriptModuleUrl } from "./data-url.js";
import { webgpuFlagNamespaces } from "./webgpu-flags.js";
import { rewriteModuleSpecifiers } from "./module-specifier-rewrite.js";
import { isRelativeSpecifier } from "./typescript-module-specifiers.js";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve, relative } from "node:path";
import {
    findRepositoryRoot,
    readUpstreamPin,
    sharedUpstreamStore,
} from "./upstream-source.js";

/**
 * The WebGPU flag namespaces, installed before the first pinned import.
 *
 * `engine/gpu-flags.ts` exists to shrink the bundle: it *snapshots*
 * `globalThis.GPUShaderStage` and its siblings into one-letter aliases at
 * module load, so a pinned module loaded in Node — where the namespaces do
 * not exist — captures `undefined` and fails the moment a descriptor reads
 * a flag. Installing them here rather than in each caller is what makes the
 * order right: every pinned import in generation goes through this module,
 * and a snapshot taken once cannot be corrected afterwards.
 *
 * Generation reads the WGSL and the binding tables a descriptor carries,
 * never its usage masks.
 */
for (const [name, values] of Object.entries(webgpuFlagNamespaces)) {
    const host = globalThis as unknown as Record<string, unknown>;
    if (host[name] === undefined) host[name] = values;
}

/** Cached per process: the pin cannot change while generation runs, and
 *  every pinned import and packaged-module read resolves through it. */
let pinnedLibraryRootCache: string | undefined;

export function pinnedLibraryRoot(): string {
    if (pinnedLibraryRootCache !== undefined) {
        return pinnedLibraryRootCache;
    }
    // Resolve through the pin the way `upstream-source.ts` does. The package
    // exports only its entry point, so `require.resolve` cannot reach the
    // individual modules, and the pin is the provenance the rest of generation
    // already reads.
    const repositoryRoot = findRepositoryRoot();
    const pin = readUpstreamPin(repositoryRoot);
    const packageRoot = resolve(
        repositoryRoot,
        "node_modules",
        ...pin.package.split("/"),
    );
    const library = join(packageRoot, "lib");
    if (!existsSync(library)) {
        throw new Error(
            `Pinned upstream package is not installed: ${pin.package}@${pin.version}. Run npm ci.`,
        );
    }
    pinnedLibraryRootCache = library;
    return library;
}

/**
 * Reads a packaged module's text from the pinned library, synchronously.
 *
 * The WGSL the background and utility builtins lift ships as string literals
 * inside compiled modules (raw imports carry no source-map entry), so the
 * literal has to be read out of the packaged text the way the solid skybox
 * already does. Synchronous because `lowerShaders` is.
 */
export function readPinnedLibraryModule(relativePath: string): string {
    return readFileSync(
        join(pinnedLibraryRoot(), pinnedImplementationPath(relativePath)),
        "utf8",
    );
}

/** Resolve implementation text through source maps rather than hashed chunk names. */
export function pinnedImplementationPath(relativePath: string): string {
    const sourcePath = `src/${relativePath.replace(/\.js$/, ".ts")}`;
    const store = sharedUpstreamStore();
    return store.hasSource(sourcePath)
        ? store.packagedModulePath(sourcePath)
        : relativePath;
}

/**
 * Packaged module text, parsed once per distinct text: the literal readers
 * below are asked for several constants of the same module, and the pin
 * cannot change while generation runs.
 */
const packagedModuleFiles = new Map<string, ts.SourceFile>();

function packagedModuleFile(source: string): ts.SourceFile {
    const cached = packagedModuleFiles.get(source);
    if (cached) return cached;
    const file = ts.createSourceFile(
        "packaged-module.js",
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    packagedModuleFiles.set(source, file);
    return file;
}

/**
 * The first variable a packaged module declares whose initializer the
 * predicate accepts, by name or -- `name` undefined -- under any name,
 * optionally only inside `[start, end)`.
 */
function packagedDeclaration<T extends ts.Expression>(
    source: string,
    accepts: (initializer: ts.Expression) => initializer is T,
    name?: string,
    range: { start: number; end: number } = { start: 0, end: source.length },
): { name: string; initializer: T } | undefined {
    const file = packagedModuleFile(source);
    let found: { name: string; initializer: T } | undefined;
    const visit = (node: ts.Node): void => {
        if (found || node.end <= range.start || node.pos >= range.end) return;
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            (name === undefined || node.name.text === name) &&
            node.initializer &&
            accepts(node.initializer) &&
            node.getStart(file) >= range.start &&
            node.end <= range.end
        ) {
            found = { name: node.name.text, initializer: node.initializer };
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
}

/** Raw WGSL imports retain their source path in Vite's region markers. */
export function extractPackagedRawShader(
    source: string,
    sourcePath: string,
): string {
    const marker = `//#region ${sourcePath}?raw`;
    const start = source.indexOf(marker);
    if (start < 0)
        throw new Error(`Pinned raw shader '${sourcePath}' was not found.`);
    const end = source.indexOf("//#endregion", start);
    const declaration = packagedDeclaration(
        source,
        ts.isStringLiteral,
        undefined,
        { start: start + marker.length, end: end < 0 ? source.length : end },
    );
    if (!declaration)
        throw new Error(
            `Pinned raw shader '${sourcePath}' has no string declaration.`,
        );
    return declaration.initializer.text;
}

const rawShaderCache = new Map<string, string>();

/** Vite may inline a raw import into its call argument and remove the region. */
function inlinedRawShader(
    modulePath: string,
    sourcePath: string,
): string | undefined {
    const originalPath = `src/${modulePath.replace(/\.js$/, ".ts")}`;
    const store = sharedUpstreamStore();
    if (!store.hasSource(originalPath)) return undefined;
    const original = store.getSourceFile(originalPath);
    const imported = original.statements.find(
        (node): node is ts.ImportDeclaration =>
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text.endsWith(`/${sourcePath}?raw`),
    )?.importClause?.name?.text;
    if (!imported) return undefined;
    const uses: { callee: string; argument: number }[] = [];
    const collect = (node: ts.Node): void => {
        if (ts.isCallExpression(node))
            node.arguments.forEach((argument, index) => {
                if (ts.isIdentifier(argument) && argument.text === imported)
                    uses.push({
                        callee: node.expression.getText(original),
                        argument: index,
                    });
            });
        ts.forEachChild(node, collect);
    };
    collect(original);
    const packaged = ts.createSourceFile(
        modulePath,
        readPinnedLibraryModule(modulePath),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    const values = new Set<string>();
    const read = (node: ts.Node): void => {
        if (ts.isCallExpression(node))
            for (const use of uses) {
                if (node.expression.getText(packaged) !== use.callee) continue;
                const argument = node.arguments[use.argument];
                if (argument && ts.isStringLiteral(argument))
                    values.add(argument.text);
            }
        ts.forEachChild(node, read);
    };
    read(packaged);
    return values.size === 1 ? [...values][0] : undefined;
}

/** Find a raw import in the implementation or a shared dependency chunk. */
export function readPinnedRawShader(
    modulePath: string,
    sourcePath: string,
): string {
    const key = `${modulePath}:${sourcePath}`;
    const cached = rawShaderCache.get(key);
    if (cached !== undefined) return cached;
    const visited = new Set<string>();
    const visit = (path: string): string | undefined => {
        if (visited.has(path)) return undefined;
        visited.add(path);
        const text = readFileSync(join(pinnedLibraryRoot(), path), "utf8");
        if (text.includes(`//#region ${sourcePath}?raw`))
            return extractPackagedRawShader(text, sourcePath);
        const file = ts.createSourceFile(
            path,
            text,
            ts.ScriptTarget.Latest,
            false,
            ts.ScriptKind.JS,
        );
        for (const statement of file.statements) {
            if (
                (!ts.isImportDeclaration(statement) &&
                    !ts.isExportDeclaration(statement)) ||
                !statement.moduleSpecifier ||
                !ts.isStringLiteral(statement.moduleSpecifier) ||
                !statement.moduleSpecifier.text.startsWith(".")
            )
                continue;
            const dependency = relative(
                pinnedLibraryRoot(),
                resolve(
                    pinnedLibraryRoot(),
                    dirname(path),
                    statement.moduleSpecifier.text,
                ),
            );
            const found = visit(dependency);
            if (found !== undefined) return found;
        }
        return undefined;
    };
    const value =
        visit(pinnedImplementationPath(modulePath)) ??
        inlinedRawShader(modulePath, sourcePath);
    if (value === undefined)
        throw new Error(
            `Pinned raw shader '${sourcePath}' was not reachable from ${modulePath}.`,
        );
    rawShaderCache.set(key, value);
    return value;
}

/**
 * The value of the first `<name> = "..."` string declaration in packaged
 * module text, read off the module's AST so every escape the bundler emits
 * decodes the way the engine decodes it.
 */
export function extractPackagedStringLiteral(
    source: string,
    name: string,
): string {
    const declaration = packagedDeclaration(source, ts.isStringLiteral, name);
    if (!declaration) {
        throw new Error(`Pinned packaged literal '${name}' was not found.`);
    }
    return declaration.initializer.text;
}

/**
 * The text of the first `<name> = \`...\`` template declaration in packaged
 * module text. Only a substitution- and escape-free template qualifies — a
 * `${` inside means the pin turned the constant into a builder, which is a
 * contract change the caller must see rather than a string to guess at.
 */
export function extractPackagedTemplateLiteral(
    source: string,
    name: string,
): string {
    const declaration = packagedDeclaration(
        source,
        (initializer): initializer is ts.TemplateLiteral =>
            ts.isNoSubstitutionTemplateLiteral(initializer) ||
            ts.isTemplateExpression(initializer),
        name,
    );
    if (!declaration) {
        throw new Error(
            `Pinned packaged template literal '${name}' was not found.`,
        );
    }
    const literal = declaration.initializer;
    // Between the backticks, byte for byte as the package ships it.
    const value = source.slice(
        literal.getStart(literal.getSourceFile()) + 1,
        literal.end - 1,
    );
    if (!ts.isNoSubstitutionTemplateLiteral(literal) || value.includes("\\")) {
        throw new Error(
            `Pinned packaged template literal '${name}' is no longer a plain string.`,
        );
    }
    return value;
}

/**
 * Splits a lifted WGSL statement list into one statement per entry, keeping
 * every byte of each statement. Statements end at `;` outside any brace or
 * parenthesis nesting, or at a top-level `}` (an `if` or `for` block) that no
 * `else` continues — so a pinned `if (...) { ... } else { ... }` chain stays
 * one statement, and the `;`s inside a `for` header stay inside it.
 */
export function splitWgslStatements(body: string): string[] {
    const pieces: string[] = [];
    let braces = 0;
    let parens = 0;
    let start = 0;
    for (let index = 0; index < body.length; index++) {
        const character = body[index];
        if (character === "(") parens++;
        else if (character === ")") parens--;
        else if (character === "{") braces++;
        else if (character === "}") {
            braces--;
            if (
                braces === 0 &&
                parens === 0 &&
                !/^\s*else\b/.test(body.slice(index + 1))
            ) {
                pieces.push(body.slice(start, index + 1));
                start = index + 1;
            }
        } else if (character === ";" && braces === 0 && parens === 0) {
            pieces.push(body.slice(start, index + 1));
            start = index + 1;
        }
    }
    pieces.push(body.slice(start));
    return pieces
        .map((piece) => piece.trim())
        .filter((piece) => piece.length > 0);
}

const pinnedModules = new Map<string, Promise<unknown>>();

/**
 * Import a module from the pinned package by its `lib`-relative path.
 *
 * Memoized like the augmented import below, and for the same reason: Node
 * dedupes the `import()` itself, but not the root join and the file-URL
 * build that produce its argument — and generation asks for the same handful
 * of pinned modules once per material it derives. `pinnedLibraryRoot()` is
 * already process-cached, so a path's URL cannot change under the memo.
 */
export async function importPinnedModule<T>(relativePath: string): Promise<T> {
    const cached = pinnedModules.get(relativePath);
    if (cached) return (await cached) as T;
    const pending = import(
        pathToFileURL(join(pinnedLibraryRoot(), relativePath)).href
    );
    pinnedModules.set(relativePath, pending);
    return (await pending) as T;
}

/**
 * A geometry task's attachment names as the pin's own enum values.
 *
 * All three material families compose an MRT arm from the same manifest
 * names, and the enum that resolves them is the pin's
 * `frame-graph/geometry-types.ts` — so the lookup and its refusal live here
 * rather than once per family. The import is memoized above, so asking three
 * times costs one read.
 */
export async function geometryAttachmentTypes(
    names: readonly string[],
): Promise<readonly number[]> {
    const types = await importPinnedModule<{
        GeometryTextureType: Record<string, number>;
    }>("frame-graph/geometry-types.js");
    return names.map((name) => {
        const value = types.GeometryTextureType[name];
        if (value === undefined) {
            throw new Error(`Unknown geometry texture type '${name}'.`);
        }
        return value;
    });
}

const augmentedModules = new Map<string, Promise<unknown>>();

/**
 * Imports a pinned module with named module-local symbols also exported.
 *
 * Not everything the pin runs sits on its export surface — the DDS loader's
 * `computeSH` is module-local — and transcribing an internal function is the
 * drift the project rule exists to prevent. So the pinned module's own text
 * is imported through a `data:` URL with an export appended for the internal
 * symbols. Relative specifiers do not resolve from a `data:` URL, so they
 * are rewritten to absolute URLs against the module's own directory first;
 * everything that executes is still the pin's text.
 */
export async function importPinnedModuleWithExports<T>(
    relativePath: string,
    extraExports: readonly string[],
    redirects: ReadonlyMap<string, string> = new Map(),
): Promise<T> {
    // Node dedupes the `data:` import, but not the read, the rewrite and the
    // base64 that build its URL — and a scene composing several post-process
    // stages asks for the same module once per stage.
    const key = `${relativePath}|${extraExports.join(",")}|${JSON.stringify([...redirects])}`;
    const cached = augmentedModules.get(key);
    if (cached) {
        return (await cached) as T;
    }
    const loading = import(
        pinnedModuleUrl(relativePath, extraExports, redirects)
    );
    augmentedModules.set(key, loading);
    return (await loading) as T;
}

/** Pinned code with explicit transport redirects, retaining its async control flow. */
export function pinnedModuleUrl(
    relativePath: string,
    extraExports: readonly string[] = [],
    redirects: ReadonlyMap<string, string> = new Map(),
): string {
    return pinnedModuleTextUrl(
        relativePath,
        readPinnedLibraryModule(relativePath),
        extraExports,
        redirects,
    );
}

/** Anchor a transformed pinned module against its original import directory. */
export function pinnedModuleTextUrl(
    relativePath: string,
    source: string,
    extraExports: readonly string[] = [],
    redirects: ReadonlyMap<string, string> = new Map(),
): string {
    const anchored = anchorSpecifiersInText(
        source,
        join(pinnedLibraryRoot(), pinnedImplementationPath(relativePath)),
        redirects,
    );
    return javascriptModuleUrl(
        anchored +
            (extraExports.length
                ? `\nexport { ${extraExports.join(", ")} };\n`
                : ""),
    );
}

/**
 * Imports a pinned module whose own `fetch` generation answers.
 *
 * A pinned loader that fetches its container is still worth executing whole —
 * `loadSPZ` is a container fork, a gzip inflate, a parse and a TRS write, and
 * only the first three are things generation could reach any other way — but
 * it must not reach the network from inside a compile: the download cache is
 * what makes a corpus build survive an unavailable host. So `fetch` is
 * shadowed in the pinned module's own scope, exactly as
 * `importPinnedModuleUnasynced` shadows `Promise.all`, rather than patched
 * onto `globalThis`, where an asset materializing concurrently would see it.
 * The stand-in hands back a real `Response`, so `ok`, `status` and
 * `arrayBuffer()` behave as the pin's own fetch does.
 *
 * A sibling rather than an option on the importer above, for the reason
 * `importPinnedModuleObserving` is one: the module it returns is specific to
 * one caller's bytes, so it cannot join that function's memo, and it has no
 * module-local symbols to export. `release` drops the stand-in, which the
 * caller holds until the pinned function it came for has run — the stand-in
 * is called then, not at import.
 */
export async function importPinnedModuleFetching<T>(
    relativePath: string,
    fetchBytes: (url: string) => Uint8Array,
    redirects: ReadonlyMap<string, string> = new Map(),
): Promise<{ module: T; release: () => void }> {
    const { hook, release } = installPinnedImportHook(
        (url: string, resolve: (response: Response) => void) => {
            // `Response` copies and windows the body itself, so this is a
            // view rather than a copy: the three-argument form is what makes
            // a `Uint8Array` over an unknown buffer type satisfy
            // `BufferSource`, and it saves a full asset copy — 17 MB and
            // 3 ms on the reached container.
            const bytes = fetchBytes(url);
            resolve(
                new Response(
                    new Uint8Array(
                        bytes.buffer as ArrayBuffer,
                        bytes.byteOffset,
                        bytes.byteLength,
                    ),
                ),
            );
        },
    );
    const modulePath = join(
        pinnedLibraryRoot(),
        pinnedImplementationPath(relativePath),
    );
    const shadowed = [
        "const fetch = (url) => new Promise((resolve) => " +
            `globalThis[${JSON.stringify(hook)}](url, resolve));`,
        anchorPinnedSpecifiers(modulePath, redirects),
    ].join("\n");
    return {
        module: (await import(javascriptModuleUrl(shadowed))) as T,
        release,
    };
}

/** Distinct per import, so two observed compositions never share a hook. */
let observationCount = 0;

/**
 * Installs a callback a generated shim module can reach, under a name
 * nothing else can collide with.
 *
 * Every pinned import that watches one of the pin's own imports, or stands
 * in for one, needs the same two things: a unique name, and the callback on
 * `globalThis` where a `data:` module can see it. Spelled once here, beside
 * the imports that use it, because a second naming convention is how two
 * shims come to share a hook.
 *
 * `release` removes it. An observer whose shim outlives the call keeps the
 * hook; a stand-in that runs once releases it.
 */
export function installPinnedImportHook<
    Arguments extends unknown[],
    Result = void,
>(
    callback: (...args: Arguments) => Result,
): { hook: string; release: () => void } {
    const hook = `__bblitecPinnedImport${observationCount++}`;
    const globals = globalThis as Record<string, unknown>;
    globals[hook] = callback;
    return {
        hook,
        release: () => {
            delete globals[hook];
        },
    };
}

/**
 * Imports a pinned module with some of its own imports observed.
 *
 * A composite post-process task is not a shader: it is a factory that calls
 * other factories, and what generation needs is which passes it built, in
 * which order, through which entry point. Nothing on the returned object says
 * so — the pin has no reason to record it — and reading it back out of the
 * task's own fields would be this port restating the composite's structure.
 *
 * So the composite's own text is imported through a `data:` URL exactly as
 * `importPinnedModuleWithExports` does, except that the specifiers named in
 * `observe` resolve to a shim: it re-exports the real module untouched and
 * wraps the named factories to announce each call. Only the module under
 * import is rewritten, which is enough because a composite calls its leaf
 * factories itself; what those leaves call in turn is the pin's own business.
 *
 * `record` is invoked with the entry point's name and its return value, in
 * call order, before the caller sees anything.
 */
export async function importPinnedModuleObserving<T>(
    relativePath: string,
    observe: Readonly<Record<string, readonly string[]>>,
    record: (symbol: string, value: unknown) => void,
): Promise<T> {
    const modulePath = join(
        pinnedLibraryRoot(),
        pinnedImplementationPath(relativePath),
    );
    // The shim module stays importable, so the hook it names is not
    // released.
    const { hook } = installPinnedImportHook(record);
    const shims = new Map<string, string>();
    for (const [specifier, symbols] of Object.entries(observe)) {
        const target = JSON.stringify(
            pathToFileURL(resolve(dirname(modulePath), specifier)).href,
        );
        const lines = [
            `import * as real from ${target};`,
            // `export *` skips a name the shim exports itself, so the wrapper
            // wins for the observed factories and every other export stays
            // the pin's own binding.
            `export * from ${target};`,
        ];
        for (const symbol of symbols) {
            lines.push(
                `export function ${symbol}(...args) {`,
                `  const value = real.${symbol}(...args);`,
                `  globalThis[${JSON.stringify(hook)}](${JSON.stringify(
                    symbol,
                )}, value);`,
                "  return value;",
                "}",
            );
        }
        shims.set(specifier, javascriptModuleUrl(lines.join("\n")));
    }
    return (await import(
        javascriptModuleUrl(anchorPinnedSpecifiers(modulePath, shims))
    )) as T;
}

/**
 * Module text with every relative specifier made importable, anchored
 * against the module's own directory unless a shim redirects it. Every
 * pinned import that has to leave the file system (a `data:` URL, an
 * augmented module, an executed shader builder) goes through this or, for
 * the unasynced import, through the same `rewriteModuleSpecifiers` with its
 * dynamic imports hoisted.
 */
export function anchorSpecifiersInText(
    text: string,
    modulePath: string,
    shims: ReadonlyMap<string, string> = new Map(),
): string {
    return rewriteModuleSpecifiers(text, modulePath, (specifier) =>
        isRelativeSpecifier(specifier.text)
            ? {
                  specifier: anchoredSpecifier(
                      modulePath,
                      specifier.text,
                      shims,
                  ),
              }
            : undefined,
    );
}

/** A specifier as an importable URL: its shim, or the file it names. */
function anchoredSpecifier(
    modulePath: string,
    specifier: string,
    shims: ReadonlyMap<string, string>,
): string {
    return (
        shims.get(specifier) ??
        pathToFileURL(resolve(dirname(modulePath), specifier)).href
    );
}

/** The pinned module's text with every relative specifier made importable. */
function anchorPinnedSpecifiers(
    modulePath: string,
    shims: ReadonlyMap<string, string> = new Map(),
): string {
    return anchorSpecifiersInText(
        readFileSync(modulePath, "utf8"),
        modulePath,
        shims,
    );
}

/** The index of the first non-whitespace character at or after `index`. */
function afterWhitespace(text: string, index: number): number {
    let end = index;
    while (end < text.length && text[end]!.trim() === "") end += 1;
    return end;
}

/**
 * Module text with every `async` modifier and every `await` operator
 * removed, each with the space that separates it from what follows. The
 * keywords are located as syntax -- a modifier on a function, an await
 * expression -- so a word inside a literal, a comment or a property name is
 * never touched, and the text around them is executed byte for byte.
 */
function stripAsyncAndAwait(text: string): string {
    const source = ts.createSourceFile(
        "pinned-module.js",
        text,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.JS,
    );
    const removed: Array<readonly [number, number]> = [];
    const visit = (node: ts.Node): void => {
        if (ts.canHaveModifiers(node)) {
            for (const modifier of ts.getModifiers(node) ?? []) {
                if (modifier.kind === ts.SyntaxKind.AsyncKeyword) {
                    removed.push([
                        modifier.getStart(source),
                        afterWhitespace(text, modifier.end),
                    ]);
                }
            }
        }
        if (ts.isAwaitExpression(node)) {
            removed.push([
                node.getStart(source),
                node.expression.getStart(source),
            ]);
        }
        if (ts.isForOfStatement(node) && node.awaitModifier) {
            removed.push([
                node.awaitModifier.getStart(source),
                afterWhitespace(text, node.awaitModifier.end),
            ]);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    let stripped = text;
    for (const [start, end] of removed.sort(
        (left, right) => right[0] - left[0],
    )) {
        stripped = stripped.slice(0, start) + stripped.slice(end);
    }
    return stripped;
}

/**
 * Imports a pinned module with its `async`/`await` erased.
 *
 * The loader's `applyMaterial` hooks are `async` because the real `ctx`
 * decodes images; the stub `ctx` here produces every awaited value
 * synchronously, so the awaits are inert and the pin's text runs unchanged
 * with the keywords stripped. Three mechanical rewrites make that executable:
 *
 * - dynamic `import('…')` expressions are hoisted into eager namespace
 *   imports (`gltf-ext-dielectric.ts` lazy-loads its three `setPbrX`
 *   modules; eager loading is the same modules, which define functions and
 *   nothing else at load);
 * - the remaining relative specifiers are anchored to absolute URLs against
 *   the module's own directory, exactly as `importPinnedModuleWithExports`
 *   does, so the dependencies are the same instances the composer imports;
 * - `Promise.all` is shadowed by the identity it reduces to once nothing in
 *   the array is a promise.
 *
 * Everything that executes is still the pin's text. If the pin ever grows a
 * genuinely asynchronous step, a promise surfaces where a value is expected
 * and `assertPinnedSync` throws at generation time instead of drifting.
 */
export async function importPinnedModuleUnasynced(
    relativePath: string,
    extraExports: readonly string[] = [],
    redirects: ReadonlyMap<string, string> = new Map(),
): Promise<Record<string, unknown>> {
    const modulePath = join(
        pinnedLibraryRoot(),
        pinnedImplementationPath(relativePath),
    );
    const hoisted: string[] = [];
    let dynamicIndex = 0;
    // A dynamic import becomes the namespace a hoisted static import binds;
    // every specifier, hoisted or static, resolves through the same shim map.
    const anchored = rewriteModuleSpecifiers(
        readPinnedLibraryModule(relativePath),
        modulePath,
        (specifier) => {
            if (ts.isCallExpression(specifier.parent)) {
                const name = `__pinnedDynamicImport${dynamicIndex++}`;
                hoisted.push(
                    `import * as ${name} from ${JSON.stringify(
                        anchoredSpecifier(
                            modulePath,
                            specifier.text,
                            redirects,
                        ),
                    )};`,
                );
                return { expression: name };
            }
            return isRelativeSpecifier(specifier.text)
                ? {
                      specifier: anchoredSpecifier(
                          modulePath,
                          specifier.text,
                          redirects,
                      ),
                  }
                : undefined;
        },
    );
    const text = stripAsyncAndAwait(anchored);
    const augmented = [
        ...hoisted,
        "const Promise = { all: (values) => values };",
        text,
        ...(extraExports.length > 0
            ? [`export { ${extraExports.join(", ")} };`]
            : []),
    ].join("\n");
    const url = javascriptModuleUrl(augmented);
    return (await import(url)) as Record<string, unknown>;
}

/** Trips if an unasynced pinned function still produced a promise. */
export function assertPinnedSync<T>(value: T, what: string): T {
    if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { then?: unknown }).then === "function"
    ) {
        throw new Error(
            `Pinned ${what} returned a promise under the unasync transform; ` +
                `the pin's shape changed and the transform needs re-reading.`,
        );
    }
    return value;
}

/**
 * Extracts one top-level `fn` definition from composed WGSL, verbatim.
 *
 * Used to take a helper the renderer would otherwise transcribe — the coat's
 * `getR0RemappedForClearCoat` was the first — straight out of the pin's own
 * composed fragment, so a changed formula arrives here instead of drifting.
 * Braces nest only through the body, so a depth scan is enough.
 */
export function extractWgslFunction(source: string, name: string): string {
    const start = source.indexOf(`fn ${name}(`);
    if (start < 0) {
        throw new Error(`Pinned composed WGSL declares no function '${name}'.`);
    }
    let depth = 0;
    let seenBody = false;
    for (let index = start; index < source.length; index++) {
        const character = source[index];
        if (character === "{") {
            depth++;
            seenBody = true;
        } else if (character === "}") {
            depth--;
            if (seenBody && depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }
    throw new Error(`Pinned composed WGSL function '${name}' is unterminated.`);
}
