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
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { findRepositoryRoot, readUpstreamPin } from "./upstream-source.js";

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
 * The values are the WebGPU specification's, and they reach no artifact —
 * generation reads the WGSL and the binding tables a descriptor carries,
 * never its usage masks.
 */
const webgpuFlagNamespaces: Readonly<
    Record<string, Readonly<Record<string, number>>>
> = {
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
    GPUTextureUsage: {
        COPY_SRC: 1,
        COPY_DST: 2,
        TEXTURE_BINDING: 4,
        STORAGE_BINDING: 8,
        RENDER_ATTACHMENT: 16,
    },
    GPUBufferUsage: {
        MAP_READ: 1,
        MAP_WRITE: 2,
        COPY_SRC: 4,
        COPY_DST: 8,
        INDEX: 16,
        VERTEX: 32,
        UNIFORM: 64,
        STORAGE: 128,
        INDIRECT: 256,
        QUERY_RESOLVE: 512,
    },
    GPUColorWrite: { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 },
};

for (const [name, values] of Object.entries(webgpuFlagNamespaces)) {
    const host = globalThis as unknown as Record<string, unknown>;
    if (host[name] === undefined) host[name] = values;
}

/** The composer's output; field names are the pinned module's own. */
export interface ComposedPinnedShader {
    vertexWgsl: string;
    fragmentWgsl: string;
    /** The pin's identity for this permutation, e.g. `ibl|clearcoat`. */
    fragmentKey: string;
    /** The material UBO the composed fragment declares. */
    materialUboSpec: unknown;
    /** The mesh bind-group layout the composed fragment declares. */
    meshBindGroupLayout: unknown;
}

interface PinnedComposerModules {
    composeShader: (template: unknown, fragments: readonly unknown[]) => {
        _vertexWGSL: string;
        _fragmentWGSL: string;
        _fragmentKey: string;
        _materialUboSpec: unknown;
        _meshBGLDescriptor: unknown;
    };
    createPbrTemplate: (config: Record<string, unknown>) => unknown;
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
    return readFileSync(join(pinnedLibraryRoot(), relativePath), "utf8");
}

/**
 * Extracts one `const <name> = "...";` literal out of packaged module text.
 * The bundler emits these as single-line double-quoted JavaScript strings, so
 * the value is recovered by scanning to the closing quote and parsing it as
 * JSON rather than by a regex that would have to model every escape.
 */
export function extractPackagedStringLiteral(
    source: string,
    name: string,
): string {
    const marker = `const ${name} = "`;
    const start = source.indexOf(marker);
    if (start < 0) {
        throw new Error(
            `Pinned packaged literal '${name}' was not found.`,
        );
    }
    let index = start + marker.length;
    let escaped = "";
    while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\") {
            escaped += source[index]! + (source[index + 1] ?? "");
            index += 2;
            continue;
        }
        escaped += source[index];
        index += 1;
    }
    if (index >= source.length) {
        throw new Error(
            `Pinned packaged literal '${name}' is unterminated.`,
        );
    }
    return JSON.parse(`"${escaped}"`) as string;
}

/**
 * Extracts one `const <name> = \`...\`;` template literal out of packaged
 * module text. Only substitution-free templates qualify — a `${` inside means
 * the pin turned the constant into a builder, which is a contract change the
 * caller must see rather than a string to guess at.
 */
export function extractPackagedTemplateLiteral(
    source: string,
    name: string,
): string {
    const marker = `const ${name} = \``;
    const start = source.indexOf(marker);
    if (start < 0) {
        throw new Error(
            `Pinned packaged template literal '${name}' was not found.`,
        );
    }
    const end = source.indexOf("`", start + marker.length);
    if (end < 0) {
        throw new Error(
            `Pinned packaged template literal '${name}' is unterminated.`,
        );
    }
    const value = source.slice(start + marker.length, end);
    if (value.includes("${") || value.includes("\\")) {
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
export async function importPinnedModule<T>(
    relativePath: string,
): Promise<T> {
    const cached = pinnedModules.get(relativePath);
    if (cached) return (await cached) as T;
    const pending = import(
        pathToFileURL(join(pinnedLibraryRoot(), relativePath)).href
    );
    pinnedModules.set(relativePath, pending);
    return (await pending) as T;
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
): Promise<T> {
    // Node dedupes the `data:` import, but not the read, the rewrite and the
    // base64 that build its URL — and a scene composing several post-process
    // stages asks for the same module once per stage.
    const key = `${relativePath}|${extraExports.join(",")}`;
    const cached = augmentedModules.get(key);
    if (cached) {
        return (await cached) as T;
    }
    const modulePath = join(pinnedLibraryRoot(), relativePath);
    const anchored = anchorPinnedSpecifiers(modulePath);
    const loading = import(
        javascriptModuleUrl(`${anchored}\nexport { ${extraExports.join(", ")} };\n`)
    );
    augmentedModules.set(key, loading);
    return (await loading) as T;
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
    const modulePath = join(pinnedLibraryRoot(), relativePath);
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
export function installPinnedImportHook<Arguments extends unknown[]>(
    callback: (...args: Arguments) => void,
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
    const modulePath = join(pinnedLibraryRoot(), relativePath);
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
 * against the module's own directory unless a shim redirects it. The one
 * specifier rewrite in the tree: every pinned import that has to leave the
 * file system (a `data:` URL, an augmented module) goes through this.
 */
function anchorSpecifiersInText(
    text: string,
    modulePath: string,
    shims: ReadonlyMap<string, string> = new Map(),
): string {
    return text.replace(
        /(from\s*|import\()(["'])(\.\.?\/[^"']+)\2/g,
        (_match, keyword: string, quote: string, specifier: string) =>
            `${keyword}${quote}${
                shims.get(specifier) ??
                pathToFileURL(resolve(dirname(modulePath), specifier)).href
            }${quote}`,
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

/**
 * Strips the given keywords (and their trailing whitespace) from module
 * text — everywhere except inside string, template, or regex literals,
 * because the stripped text is *executed* and a pinned literal that happens
 * to contain a word must survive byte-for-byte. Literal spans come from
 * parsing the text once, so an escape or a nested `${}` cannot fool the
 * filter; the keyword matches are disjoint, so one combined replace keeps
 * every offset valid against that single parse.
 */
function stripKeywordsOutsideLiterals(
    text: string,
    keywords: readonly ["async", "await"],
): string {
    const source = ts.createSourceFile(
        "pinned-module.js",
        text,
        ts.ScriptTarget.ES2022,
        false,
        ts.ScriptKind.JS,
    );
    const literals: Array<readonly [number, number]> = [];
    const collect = (node: ts.Node): void => {
        if (
            ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node) ||
            ts.isRegularExpressionLiteral(node)
        ) {
            literals.push([node.getStart(source), node.end]);
            return;
        }
        ts.forEachChild(node, collect);
    };
    collect(source);
    return text.replace(
        new RegExp(`\\b(?:${keywords.join("|")})\\s+`, "g"),
        (match: string, offset: number) =>
            literals.some(
                ([start, end]) => offset >= start && offset < end,
            )
                ? match
                : "",
    );
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
    const modulePath = join(pinnedLibraryRoot(), relativePath);
    const anchor = (specifier: string): string =>
        redirects.get(specifier) ??
            pathToFileURL(resolve(dirname(modulePath), specifier)).href;
    const hoisted: string[] = [];
    let dynamicIndex = 0;
    // The dynamic imports are hoisted BEFORE the specifiers are anchored,
    // so the hoisted statements resolve through the same shim map and the
    // anchoring pass sees no `import(` left to rewrite.
    const anchored = anchorSpecifiersInText(
        readPinnedLibraryModule(relativePath).replace(
            /\bimport\((["'])([^"']+)\1\)/g,
            (_match, _quote: string, specifier: string) => {
                const name = `__pinnedDynamicImport${dynamicIndex++}`;
                hoisted.push(
                    `import * as ${name} from ${
                        JSON.stringify(anchor(specifier))
                    };`,
                );
                return name;
            },
        ),
        modulePath,
        redirects,
    );
    const text = stripKeywordsOutsideLiterals(anchored, ["async", "await"]);
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

async function pinnedComposer(): Promise<PinnedComposerModules> {
    const [composer, template] = await Promise.all([
        importPinnedModule<{
            composeShader: PinnedComposerModules["composeShader"];
        }>("shader/shader-composer.js"),
        importPinnedModule<{
            createPbrTemplate: PinnedComposerModules["createPbrTemplate"];
        }>("material/pbr/pbr-template.js"),
    ]);
    return {
        composeShader: composer.composeShader,
        createPbrTemplate: template.createPbrTemplate,
    };
}

/**
 * Extracts one top-level `fn` definition from composed WGSL, verbatim.
 *
 * Used to take a helper the renderer would otherwise transcribe — the coat's
 * `getR0RemappedForClearCoat` was the first — straight out of the pin's own
 * composed fragment, so a changed formula arrives here instead of drifting.
 * Braces nest only through the body, so a depth scan is enough.
 */
export function extractWgslFunction(
    source: string,
    name: string,
): string {
    const start = source.indexOf(`fn ${name}(`);
    if (start < 0) {
        throw new Error(
            `Pinned composed WGSL declares no function '${name}'.`,
        );
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
    throw new Error(
        `Pinned composed WGSL function '${name}' is unterminated.`,
    );
}


/**
 * Composes the pinned PBR shader for a template configuration and a set of
 * already-built pinned fragments.
 *
 * The fragments carry their own dependency ids and the composer topologically
 * sorts them, so an incomplete set fails here instead of composing something
 * plausible: `createClearcoatFragment(..., hasIbl = true, ...)` declares `ibl`
 * and the composer refuses it without `createIblFragment`. That refusal is the
 * point — it is the pin stating a contract we would otherwise have to know.
 *
 * Production composition goes through `createPbrComposer` in
 * `pinned-pbr-variants.ts`; this thinner entry exists for
 * `test/pinned-shader-composer.test.ts`, which guards the pinned composer's
 * own contracts (the F0-remap text, the dependency refusal) independently of
 * the production path. Deliberately kept: it is the test's harness, not dead
 * code.
 */
export async function composePinnedPbrShader(
    templateConfig: Record<string, unknown> = {},
    fragments: readonly unknown[] = [],
): Promise<ComposedPinnedShader> {
    const { composeShader, createPbrTemplate } = await pinnedComposer();
    const composed = composeShader(
        createPbrTemplate(templateConfig),
        fragments,
    );
    return {
        vertexWgsl: composed._vertexWGSL,
        fragmentWgsl: composed._fragmentWGSL,
        fragmentKey: composed._fragmentKey,
        materialUboSpec: composed._materialUboSpec,
        meshBindGroupLayout: composed._meshBGLDescriptor,
    };
}
