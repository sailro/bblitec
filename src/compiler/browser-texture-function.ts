// Closed browser texture producers execute in Chromium; the bake records texture bytes and options.
import { EmissionMap, EmissionWeakMap } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
import {
    dirname,
    resolve,
} from "node:path";
import { imageCodecs } from "../image-codec-manifest.js";

import ts from "typescript";
import { forEachAnalysisNode, someAnalysisNode } from "./analysis-walk.js";

import {
    bakeReplayEnabled,
    bakeIdentity,
    cachedBakeSync,
    moduleIdentity,
    repositoryModuleClosure,
    resolveRepositoryModuleFile,
    type BakeKey,
    type RepositoryModuleFile,
} from "../bake-cache.js";
import { pageBase64Script } from "../browser-harness.js";
import { doubleLiteral } from "../cpp-literals.js";
import {
    loadTexture2DOptionFields,
    loadTexture2DUploadCpp,
    pixelsTexture2DOptionFields,
    pixelsTextureOptionsCpp,
} from "../pinned-address-modes.js";
import {
    findRepositoryRoot,
    repositoryRelativePath,
} from "../upstream-source.js";
import { pngDimensions } from "./asset-bytes-sync.js";
import { runGenerationChild } from "./generation-child.js";
import {
    babylonPackages,
    CompilerSymbols,
    isBabylonModule,
} from "./symbols.js";
import { transpileCommonJs } from "../typescript-transpile.js";
import type {
    Value,
} from "./types.js";
import {
    tryResolveFunctionDeclaration,
    writesThroughTrackedRoot,
} from "./user-functions.js";
import { rootIdentifier, argumentAt } from "./syntax.js";
import { isDefaultLibraryIdentifier } from "./symbols.js";

/** The two pinned factories a bounded browser texture function may reach. */
const supportedFactories = ["createTexture2DFromPixels", "loadTexture2D"] as const;

type SupportedFactory = (typeof supportedFactories)[number];

/** The source shape a call site matched, before anything is executed. */
export interface BrowserTextureFunctionShape {
    name: string;
    sourceFile: ts.SourceFile;
    /** Whether the target carries `export`; a local one is exposed by the
     *  driver instead, which is why the two are distinguished in the key. */
    exported: boolean;
    /** The target plus every same-file function it transitively calls. */
    closure: readonly ts.FunctionDeclaration[];
    /** What the single return statement returns, asserted at the source. */
    returns: "value" | "record";
}
/** One texture the executed function handed a pinned factory. */
type BakedBrowserTexture =
    | {
          factory: "createTexture2DFromPixels";
          /** Raw RGBA8, exactly as the call passed it. */
          pixels: Uint8Array;
          width: number;
          height: number;
          options: Record<string, string>;
      }
    | {
          factory: "loadTexture2D";
          /** The object URL's blob, byte-for-byte. */
          image: Uint8Array;
          mediaType: string;
          options: Record<string, string>;
      };

/** What one executed function produced: its textures and what it returned. */
interface BrowserTextureBake {
    textures: readonly BakedBrowserTexture[];
    result:
        | { kind: "texture"; index: number }
        | { kind: "record"; properties: Record<string, number> };
}

// ── Source shape ─────────────────────────────────────────────────────────────

/** Walk `node`'s value positions; type annotations are not executed. */
function forEachValueNode(node: ts.Node, visit: (node: ts.Node) => void): void {
    forEachAnalysisNode(node, visit, { includeRoot: false, types: "skip", skip: ts.isTypeAliasDeclaration });
}

/** Whether a value position under `node` satisfies `predicate`. */
export function containsValueNode(
    node: ts.Node,
    predicate: (child: ts.Node) => boolean,
): boolean {
    return someAnalysisNode(node, predicate, { includeRoot: false, types: "skip", skip: ts.isTypeAliasDeclaration });
}

/**
 * A function body that allocates a browser canvas of either spelling,
 * through the DOM library's own `OffscreenCanvas` or `document`.
 */
export function ownsCanvas(node: ts.Node, checker: ts.TypeChecker): boolean {
    return containsValueNode(node, (child) => {
        if (
            ts.isNewExpression(child) &&
            ts.isIdentifier(child.expression) &&
            child.expression.text === "OffscreenCanvas" &&
            isDefaultLibraryIdentifier(checker, child.expression)
        ) {
            return true;
        }
        const firstArgument = ts.isCallExpression(child)
            ? child.arguments[0]
            : undefined;
        return (
            ts.isCallExpression(child) &&
            ts.isPropertyAccessExpression(child.expression) &&
            child.expression.name.text === "createElement" &&
            ts.isIdentifier(child.expression.expression) &&
            child.expression.expression.text === "document" &&
            isDefaultLibraryIdentifier(checker, child.expression.expression) &&
            firstArgument !== undefined &&
            ts.isStringLiteral(firstArgument) &&
            firstArgument.text === "canvas"
        );
    });
}

/** The module-scope `VariableDeclaration` an identifier names, if any. */
function namesModuleScopeBinding(
    checker: ts.TypeChecker,
    identifier: ts.Identifier,
): boolean {
    const symbol = checker.getSymbolAtLocation(identifier);
    return (symbol?.declarations ?? []).some(
        (declaration) =>
            ts.isVariableDeclaration(declaration) &&
            ts.isVariableDeclarationList(declaration.parent) &&
            ts.isVariableStatement(declaration.parent.parent) &&
            ts.isSourceFile(declaration.parent.parent.parent),
    );
}

/**
 * Whether a call site is a bounded browser texture producer, and what its
 * closure is.
 *
 * Every refusal here returns undefined rather than failing: a call that
 * does not have this shape is an ordinary local call, and ordinary
 * inlining owns it (and produces the refusal that names what it hit).
 */
export function browserTextureFunctionShape(
    checker: ts.TypeChecker,
    declaration: ts.Node,
): BrowserTextureFunctionShape | undefined {
    if (!ts.isFunctionDeclaration(declaration) || !declaration.body) {
        return undefined;
    }
    const name = declaration.name?.text;
    if (!name || !ts.isSourceFile(declaration.parent)) return undefined;
    if (declaration.parameters.length !== 1) return undefined;
    const sourceFile = declaration.parent;
    if (!importsAreExecutable(sourceFile)) return undefined;

    let factories = 0;
    const closure = sameFileClosure(checker, declaration, (pinned, node) => {
        if (!(supportedFactories as readonly string[]).includes(pinned)) {
            return false;
        }
        if (
            ts.isCallExpression(node.parent) &&
            node.parent.expression === node
        ) {
            factories += 1;
        }
        return true;
    });
    if (!closure) return undefined;
    if (factories === 0) return undefined;
    if (!closure.some((member) => ownsCanvas(member, checker))) return undefined;

    const returns = returnShape(declaration);
    if (!returns) return undefined;
    return {
        name,
        sourceFile,
        exported: (ts.getCombinedModifierFlags(declaration) &
            ts.ModifierFlags.Export) !==
            0,
        closure,
        returns,
    };
}

/**
 * Whether a module's imports are ones an executed-in-browser bake resolves:
 * the pin, or a repository sibling. Anything else is a package the bake
 * server will not serve.
 */
export function importsAreExecutable(sourceFile: ts.SourceFile): boolean {
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        if (statement.importClause?.isTypeOnly) continue;
        if (!ts.isStringLiteral(statement.moduleSpecifier)) return false;
        const specifier = statement.moduleSpecifier.text;
        if (isBabylonModule(specifier)) continue;
        if (!specifier.startsWith(".")) return false;
    }
    return true;
}

/**
 * The function plus every same-file function it transitively reaches, or
 * undefined when the closure is not one a browser bake can execute whole:
 * a module-level write (memoization across calls, so one execution would
 * not describe what the scene does), a function declared in another file,
 * or a pinned name `acceptPinned` refuses. `acceptPinned` sees every
 * pinned import the closure reaches, in value position, with its node.
 */
export function sameFileClosure(
    checker: ts.TypeChecker,
    declaration: ts.FunctionDeclaration,
    acceptPinned: (name: string, node: ts.Identifier) => boolean,
): ts.FunctionDeclaration[] | undefined {
    const sourceFile = declaration.getSourceFile();
    const symbols = new CompilerSymbols(checker);
    const closure: ts.FunctionDeclaration[] = [declaration];
    for (let index = 0; index < closure.length; index += 1) {
        let rejected = false;
        forEachValueNode(closure[index]!, (node) => {
            if (rejected) return;
            if (
                writesThroughTrackedRoot(node, (target) => {
                    const root = rootIdentifier(target);
                    return (
                        root !== undefined &&
                        namesModuleScopeBinding(checker, root)
                    );
                }, () => false)
            ) {
                rejected = true;
                return;
            }
            if (!ts.isIdentifier(node)) return;
            if (
                ts.isPropertyAccessExpression(node.parent) &&
                node.parent.name === node
            ) {
                return;
            }
            const pinned = symbols.babylonImportName(node);
            if (pinned !== undefined) {
                if (!acceptPinned(pinned, node)) rejected = true;
                return;
            }
            const target = localFunctionDeclaration(checker, node, sourceFile);
            if (target === "foreign") {
                rejected = true;
                return;
            }
            if (target && !closure.includes(target)) closure.push(target);
        });
        if (rejected) return undefined;
    }
    return closure;
}

/**
 * The same-file function an identifier names, `"foreign"` for one declared
 * elsewhere, or undefined when the identifier names no function body at all.
 *
 * Call position is deliberately NOT required: a helper passed as a value is
 * still reached, and leaving it out of the closure would leave its canvas,
 * its pinned reaches and its module-level writes unexamined.
 */
function localFunctionDeclaration(
    checker: ts.TypeChecker,
    identifier: ts.Identifier,
    sourceFile: ts.SourceFile,
): ts.FunctionDeclaration | "foreign" | undefined {
    const symbol = checker.getSymbolAtLocation(identifier);
    if (!symbol) return undefined;
    const target =
        (symbol.flags & ts.SymbolFlags.Alias) !== 0
            ? checker.getAliasedSymbol(symbol)
            : symbol;
    for (const declaration of target.declarations ?? []) {
        // The browser executor deliberately owns functions whose bodies use
        // Canvas APIs the ordinary user-function lowerer refuses.
        if (!ts.isFunctionDeclaration(declaration) || !declaration.body) {
            continue;
        }
        return declaration.getSourceFile() === sourceFile
            ? declaration
            : "foreign";
    }
    return undefined;
}

/**
 * The single return this shape allows, as the shape of what it returns.
 *
 * One return statement, at the body's top level, of either one value or an
 * object literal of plain properties. A body with several returns produces
 * a texture set that depends on which arm ran, and one execution cannot
 * say that.
 */
function returnShape(
    declaration: ts.FunctionDeclaration,
): "value" | "record" | undefined {
    const returns: ts.ReturnStatement[] = [];
    forEachAnalysisNode(declaration.body!, (node) => {
        if (ts.isReturnStatement(node)) returns.push(node);
    }, { includeRoot: false, skip: node => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) });
    const returned = returns[0]?.expression;
    if (returns.length !== 1 || !returned) return undefined;
    if (!ts.isObjectLiteralExpression(returned)) return "value";
    return returned.properties.every(
        (property) =>
            ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property),
    )
        ? "record"
        : undefined;
}

// ── Execution ────────────────────────────────────────────────────────────────

export interface ClosureModule {
    /** Repository-relative, forward-slashed: the module's identity. */
    key: string;
    javascript: string;
    /** Specifier -> module key, for the page's CommonJS loader. */
    resolved: Record<string, string>;
}

/**
 * The target module and every repository sibling it reaches, transpiled to
 * CommonJS. The entry additionally exposes the target under a fixed name,
 * which is how a non-exported local function is reached without editing
 * what the module exports.
 */
export function closureModules(
    entryPath: string,
    entryFunction: string,
    repositoryRoot: string,
): {
    entry: string;
    modules: Record<string, ClosureModule>;
    files: readonly RepositoryModuleFile[];
} | undefined {
    const files = repositoryModuleClosure([entryPath], repositoryRoot);
    if (!files) return undefined;
    const modules: Record<string, ClosureModule> = {};
    const keyOf = (path: string): string =>
        repositoryRelativePath(repositoryRoot, path);
    const entry = keyOf(entryPath);
    if (entry.startsWith("..")) return undefined;
    for (const { path, source: bytes } of files) {
        const key = keyOf(path);
        if (key.startsWith("..")) return undefined;
        const source = bytes.toString("utf8");
        const parsed = ts.createSourceFile(
            path,
            source,
            ts.ScriptTarget.ES2022,
            true,
        );
        const resolved: Record<string, string> = {};
        for (const statement of parsed.statements) {
            const specifier =
                (ts.isImportDeclaration(statement) ||
                    ts.isExportDeclaration(statement)) &&
                statement.moduleSpecifier &&
                ts.isStringLiteral(statement.moduleSpecifier)
                    ? statement.moduleSpecifier.text
                    : undefined;
            if (!specifier || !specifier.startsWith(".")) continue;
            const file = resolveRepositoryModuleFile(
                resolve(dirname(path), specifier),
            );
            if (!file) return undefined;
            resolved[specifier] = keyOf(file);
        }
        let javascript = transpileCommonJs(source, path);
        if (key === entry) {
            javascript += `\nexports.${browserTextureTargetExport} = ${entryFunction};\n`;
        }
        modules[key] = { key, javascript, resolved };
    }
    return { entry, modules, files };
}

const browserTextureTargetExport = "__bblBrowserTextureTarget";

/**
 * Same-process replay in front of the durable bake cache: a scene calling
 * one producer twice pays neither a second subprocess nor a second cache
 * read. The BAKE is shared, not the values — each call site still binds its
 * own native texture, which is what calling the producer twice does.
 */
interface CachedBrowserTextureBake {
    bake: BrowserTextureBake;
    bytes: number;
}

const maximumBakeMemoBytes = 64 * 1024 * 1024;
const bakes = new EmissionMap<string, CachedBrowserTextureBake>();
let bakeMemoBytes = 0;
const producerBakes = new EmissionWeakMap<
    ts.SourceFile,
    Map<string, BrowserTextureBake>
>();

function bakeByteLength(bake: BrowserTextureBake): number {
    return bake.textures.reduce(
        (total, texture) =>
            total +
            (texture.factory === "createTexture2DFromPixels"
                ? texture.pixels.byteLength
                : texture.image.byteLength),
        0,
    );
}

function memoizedBake(key: string): BrowserTextureBake | undefined {
    const cached = bakes.get(key);
    if (!cached) return undefined;
    bakes.delete(key);
    bakes.set(key, cached);
    return cached.bake;
}

function memoizeBake(key: string, bake: BrowserTextureBake): void {
    const bytes = bakeByteLength(bake);
    if (bytes > maximumBakeMemoBytes) return;
    while (bakeMemoBytes + bytes > maximumBakeMemoBytes) {
        const oldest = bakes.entries().next();
        if (oldest.done) break;
        const [oldestKey, oldestValue] = oldest.value;
        bakes.delete(oldestKey);
        bakeMemoBytes -= oldestValue.bytes;
    }
    bakes.set(key, { bake, bytes });
    bakeMemoBytes += bytes;
}

/**
 * Run one bounded browser texture function in headless Chromium and return
 * what its pinned factories were handed.
 *
 * `run` is injectable so the replay contract and the driver's own
 * assertions are testable without a browser launch.
 */
export function bakeBrowserTextureFunction(
    shape: BrowserTextureFunctionShape,
    repositoryRoot: string,
    run: (
        modules: Record<string, ClosureModule>,
        entry: string,
    ) => string = runBrowserTextureFunctionInChromium,
): BrowserTextureBake {
    const entryPath = shape.sourceFile.fileName;
    const producerKey = JSON.stringify([
        repositoryRoot,
        shape.name,
        shape.exported,
        shape.returns,
    ]);
    const memoEnabled =
        run === runBrowserTextureFunctionInChromium &&
        bakeReplayEnabled();
    const producerMemo = memoEnabled
        ? producerBakes.get(shape.sourceFile)
        : undefined;
    const producerMemoized = producerMemo?.get(producerKey);
    if (producerMemoized) return producerMemoized;
    const graph = closureModules(entryPath, shape.name, repositoryRoot);
    if (!graph) {
        throw new Error(
            `Browser texture function '${shape.name}' reaches a module its ` +
                "closure cannot be built from: a relative import that does " +
                "not resolve, or a file outside the repository.",
        );
    }
    const bake = (): Uint8Array =>
        Buffer.from(run(graph.modules, graph.entry), "utf8");
    const inputs = [
        ...graph.files.flatMap(({ path, source }) => [
            Buffer.from(`${path}\n`, "utf8"),
            source,
        ]),
        ...Object.values(graph.modules).flatMap((entry) => [
            Buffer.from(`${entry.key}\n`, "utf8"),
            Buffer.from(entry.javascript, "utf8"),
        ]),
    ];
    const parameters = {
        module: graph.entry,
        function: shape.name,
        exported: shape.exported,
        returns: shape.returns,
    };
    const key: BakeKey = {
        kind: "browser-texture-function",
        version: "1",
        module: moduleIdentity(import.meta.url),
        browser: true,
        parameters,
        inputs,
    };
    const memoKey = memoEnabled ? bakeIdentity(key) : undefined;
    const memoized =
        memoKey === undefined ? undefined : memoizedBake(memoKey);
    if (memoized) return memoized;
    // An unresolvable closure bakes uncached — uncertain inputs mean bake,
    // never replay, exactly as the executed-module assets do.
    const text = Buffer.from(
        cachedBakeSync(key, bake),
    ).toString("utf8");
    const decoded = decodeBrowserTextureBake(shape, text);
    if (memoKey !== undefined) memoizeBake(memoKey, decoded);
    if (memoEnabled) {
        const sourceMemo =
            producerMemo ??
            new EmissionMap<string, BrowserTextureBake>();
        sourceMemo.set(producerKey, decoded);
        if (!producerMemo) {
            producerBakes.set(shape.sourceFile, sourceMemo);
        }
    }
    return decoded;
}

/** The driver's JSON, validated into the typed bake the compiler consumes. */
export function decodeBrowserTextureBake(
    shape: BrowserTextureFunctionShape,
    text: string,
): BrowserTextureBake {
    const payload = JSON.parse(text) as {
        textures?: Array<Record<string, unknown>>;
        result?: Record<string, unknown>;
    };
    const refuse: (message: string) => never = (message) => {
        throw new Error(
            `Browser texture function '${shape.name}': ${message}`,
        );
    };
    const textures = (payload.textures ?? []).map(
        (entry): BakedBrowserTexture => {
            const factory = entry.factory as SupportedFactory;
            const options = decodeTextureOptions(
                factory,
                entry.options,
                refuse,
            );
            if (factory === "createTexture2DFromPixels") {
                const width = entry.width;
                const height = entry.height;
                if (
                    typeof width !== "number" ||
                    typeof height !== "number" ||
                    !Number.isInteger(width) ||
                    !Number.isInteger(height) ||
                    width <= 0 ||
                    height <= 0
                ) {
                    refuse(
                        "createTexture2DFromPixels needs positive integer " +
                            "dimensions settled by the execution.",
                    );
                }
                const pixels = new Uint8Array(
                    Buffer.from(String(entry.pixels), "base64"),
                );
                if (pixels.length !== width * height * 4) {
                    refuse(
                        "createTexture2DFromPixels received " +
                            `${pixels.length} bytes for ${width}x${height} RGBA.`,
                    );
                }
                return { factory, pixels, width, height, options };
            }
            if (factory !== "loadTexture2D") {
                refuse(`unexpected factory '${String(entry.factory)}'.`);
            }
            const mediaType = String(entry.mediaType);
            if (!imageCodecs.some((codec) => codec.mimeType === mediaType)) {
                refuse(
                    `loadTexture2D object URL carries '${mediaType}', which ` +
                        "is not one of the image types this port packages.",
                );
            }
            return {
                factory,
                image: new Uint8Array(Buffer.from(String(entry.image), "base64")),
                mediaType,
                options,
            };
        },
    );
    const result = payload.result;
    if (result?.kind === "texture") {
        const index = result.index;
        if (typeof index !== "number" || !textures[index]) {
            refuse("returned a texture the execution did not record.");
        }
        if (shape.returns !== "value") {
            refuse("returned one texture where the source returns an object.");
        }
        return { textures, result: { kind: "texture", index } };
    }
    if (result?.kind === "record") {
        if (shape.returns !== "record") {
            refuse("returned an object where the source returns one value.");
        }
        const properties = result.properties as Record<string, number>;
        for (const [name, index] of Object.entries(properties)) {
            if (typeof index !== "number" || !textures[index]) {
                refuse(`returned '${name}' as something other than a texture.`);
            }
        }
        return { textures, result: { kind: "record", properties } };
    }
    return refuse("did not return a texture or an object of textures.");
}

function decodeTextureOptions(
    factory: SupportedFactory,
    raw: unknown,
    refuse: (message: string) => never,
): Record<string, string> {
    if (raw === null || raw === undefined) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) {
        refuse(`${factory} options must be a plain object.`);
    }
    const allowed: readonly string[] =
        factory === "loadTexture2D"
            ? loadTexture2DOptionFields
            : pixelsTexture2DOptionFields;
    const named: Record<string, string> = {};
    for (const [field, value] of Object.entries(
        raw as Record<string, unknown>,
    )) {
        if (value === undefined) continue;
        if (!allowed.includes(field)) {
            refuse(
                `${factory} option '${field}' is not lowered; the reached ` +
                    `slice is ${allowed.join(", ")}.`,
            );
        }
        if (typeof value !== "string" && typeof value !== "boolean") {
            refuse(
                `${factory} option '${field}' must settle to a string or ` +
                    "boolean literal.",
            );
        }
        named[field] = String(value);
    }
    return named;
}

/**
 * The page-side driver: a CommonJS loader over the transpiled closure, the
 * strict pinned stub, and the engine proxy.
 *
 * Everything the target could reach that is not the two factories throws
 * with the name it asked for, so an unsupported reach is a generation
 * failure rather than a silently different texture.
 */
function browserTextureDriverScript(): string {
    return `
        const __bblPinnedModules = ${JSON.stringify([...babylonPackages])};
        const __bblIsPinnedModule = (specifier) =>
            __bblPinnedModules.some(
                (name) => specifier === name || specifier.startsWith(name + "/"));
        const textures = [];
        const toBytes = (value) =>
            ArrayBuffer.isView(value)
                ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
                : new Uint8Array(value);
        const babylonStub = new Proxy(
            {
                createTexture2DFromPixels: (engine, pixels, width, height, options) => {
                    const index = textures.length;
                    textures.push({
                        factory: "createTexture2DFromPixels",
                        pixels: __bblBase64(toBytes(pixels)),
                        width,
                        height,
                        options: options === undefined ? null : options,
                    });
                    return { __bblTexture: index };
                },
                loadTexture2D: (engine, url, options) => {
                    // The slot is reserved at the synchronous CALL, not
                    // after the fetch: two loads started by one Promise.all
                    // complete in whichever order the network settles, and
                    // an index taken then would order the packaged textures
                    // differently between runs -- or, with an await inside
                    // the push itself, hand both calls the same index.
                    const index = textures.length;
                    textures.push(null);
                    return (async () => {
                        if (typeof url !== "string" || !url.startsWith("blob:")) {
                            throw new Error(
                                "loadTexture2D reached '" + String(url) +
                                    "', which is not a browser object URL; a fetched " +
                                    "texture URL is lowered by the ordinary loader.");
                        }
                        const blob = await (await fetch(url)).blob();
                        const bytes = new Uint8Array(await blob.arrayBuffer());
                        textures[index] = {
                            factory: "loadTexture2D",
                            image: __bblBase64(bytes),
                            mediaType: blob.type,
                            options: options === undefined ? null : options,
                        };
                        return { __bblTexture: index };
                    })();
                },
            },
            {
                get(target, name) {
                    if (typeof name !== "string") return undefined;
                    if (name === "__esModule") return undefined;
                    if (name in target) return target[name];
                    throw new Error(
                        "babylon-lite export '" + name + "' is not available to a " +
                            "generation-time browser texture bake.");
                },
            },
        );
        const engineStub = new Proxy(
            {},
            {
                get(_target, name) {
                    if (typeof name !== "string") return undefined;
                    throw new Error(
                        "The generation-time browser texture bake gives the engine " +
                            "no properties; '" + name + "' was read.");
                },
            },
        );
        const loaded = new Map();
        const loadModule = (key) => {
            const cached = loaded.get(key);
            if (cached) return cached.exports;
            const entry = __bblModules[key];
            if (!entry) {
                throw new Error(
                    "Module '" + key + "' is outside the bounded browser texture closure.");
            }
            const module = { exports: {} };
            loaded.set(key, module);
            const require = (specifier) => {
                if (__bblIsPinnedModule(specifier)) {
                    return babylonStub;
                }
                const target = entry.resolved[specifier];
                if (!target) {
                    throw new Error(
                        "Import '" + specifier + "' is outside the bounded browser " +
                            "texture closure.");
                }
                return loadModule(target);
            };
            new Function("module", "exports", "require", entry.javascript)(
                module, module.exports, require);
            return module.exports;
        };
        const describe = (value) => {
            if (value && typeof value === "object" &&
                typeof value.__bblTexture === "number") {
                return { kind: "texture", index: value.__bblTexture };
            }
            if (value && typeof value === "object" &&
                Object.getPrototypeOf(value) === Object.prototype) {
                const properties = {};
                for (const name of Object.keys(value)) {
                    const member = value[name];
                    if (!member || typeof member !== "object" ||
                        typeof member.__bblTexture !== "number") {
                        throw new Error(
                            "Returned property '" + name + "' is not a texture this " +
                                "bake produced.");
                    }
                    properties[name] = member.__bblTexture;
                }
                return { kind: "record", properties };
            }
            throw new Error("The executed function returned no texture.");
        };
        globalThis.__bblRunBrowserTextures = async () => {
            const target = loadModule(__bblEntry)[${JSON.stringify(browserTextureTargetExport)}];
            if (typeof target !== "function") {
                throw new Error("The bake driver did not expose the target function.");
            }
            const result = describe(await target(engineStub));
            if (textures.some((entry) => entry === null)) {
                throw new Error(
                    "A loadTexture2D call had not completed when the producer " +
                        "returned, so its texture is not what the scene binds.");
            }
            return JSON.stringify({ textures, result });
        };
    `;
}

function runBrowserTextureFunctionInChromium(
    modules: Record<string, ClosureModule>,
    entry: string,
): string {
    const harnessModule = new URL("../browser-harness.js", import.meta.url).href;
    const helper = `${pageBase64Script}globalThis.__bblBase64 = bblBase64;`;
    const script = `
        import { createServer } from "node:http";
        import { withBrowserPage } from ${JSON.stringify(harnessModule)};
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const server = createServer((_request, response) => {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end("<!doctype html><title>Browser texture bake</title>");
        });
        const text = await withBrowserPage(
            server,
            {
                serverName: "browser texture bake server",
                browserRequirement:
                    "Baking a scene function's browser-produced textures requires Chromium.",
            },
            async (page, origin) => {
                await page.goto(origin);
                await page.addScriptTag({ content: ${JSON.stringify(helper)} });
                await page.evaluate(
                    ({ modules, entry }) => {
                        globalThis.__bblModules = modules;
                        globalThis.__bblEntry = entry;
                    },
                    { modules: input.modules, entry: input.entry },
                );
                await page.addScriptTag({ content: input.driver });
                return page.evaluate("window.__bblRunBrowserTextures()");
            },
        );
        if (typeof text !== "string") {
            throw new Error("The browser texture bake produced no result.");
        }
        process.stdout.write(text);
    `;
    return runGenerationChild({
        script,
        label: "Generation-time browser texture bake",
        input: JSON.stringify({
            modules,
            entry,
            driver: browserTextureDriverScript(),
        }),
        maxBuffer: 256 * 1024 * 1024,
    });
}

export { pngDimensions } from "./asset-bytes-sync.js";

// ── Lowering ─────────────────────────────────────────────────────────────────

/** What the lowering reads off the compiler; the walk is a superset. */
interface BrowserTextureCallContext
    extends Pick<LoweringServices,
        | "checker"
        | "options"
        | "browserTextureFunctions"
        | "compileValue"
        | "registerAsset"
        | "allocateTemporaryCppName"
        | "cppString"
        | "reachFeature"
        | "emit"
        | "fail"
    > {}

const producerShapes = new EmissionWeakMap<
    ts.Node,
    BrowserTextureFunctionShape | null
>();

function cachedBrowserTextureFunctionShape(
    checker: ts.TypeChecker,
    declaration: ts.Node,
): BrowserTextureFunctionShape | undefined {
    const cached = producerShapes.get(declaration);
    if (cached !== undefined) return cached ?? undefined;
    const shape = browserTextureFunctionShape(checker, declaration);
    producerShapes.set(declaration, shape ?? null);
    return shape;
}

/**
 * Lower `f(engine)` when `f` is a bounded browser texture producer.
 *
 * Returns undefined when the call is not that shape, so ordinary inlining
 * owns it. Once the shape matches, every later refusal FAILS: the source
 * said it produces browser textures, so a driver that could not produce
 * them is a generation error, not a fallback.
 */
export function compileBrowserTextureFunctionCall(
    context: BrowserTextureCallContext,
    call: ts.CallExpression,
    callee: ts.Identifier,
): Value | undefined {
    const declaration = tryResolveFunctionDeclaration(context.checker, callee);
    const shape = declaration
        ? cachedBrowserTextureFunctionShape(
              context.checker,
              declaration,
          )
        : undefined;
    if (!shape) return undefined;
    if (call.arguments.length !== 1) return undefined;
    // Past this point the call IS this shape, so a refusal fails rather
    // than returning undefined: falling back to the inliner here would
    // compile the argument a second time, on top of the lines the first
    // compile already emitted.
    const engine = context.compileValue(argumentAt(call, 0));
    if (engine.kind !== "engine") {
        context.fail(
            argumentAt(call, 0),
            `'${shape.name}' produces its textures in a browser canvas at ` +
                `generation, so its one argument is the engine; received ${engine.kind}.`,
        );
    }
    const engineCpp = engine.engineCpp ?? engine.cpp;

    let bake: BrowserTextureBake;
    try {
        bake = bakeBrowserTextureFunction(
            shape,
            findRepositoryRoot(dirname(resolve(context.options.fileName))),
        );
    } catch (error) {
        context.fail(call, (error as Error).message);
    }
    context.browserTextureFunctions.add(shape.name);

    const values = bake.textures.map((texture, index) =>
        bindBakedTexture(context, call, shape, index, texture, engineCpp),
    );
    if (bake.result.kind === "texture") {
        return values[bake.result.index]!;
    }
    const recordProperties: Record<string, Value> = {};
    for (const [name, index] of Object.entries(bake.result.properties)) {
        recordProperties[name] = values[index]!;
    }
    return { kind: "record", cpp: "", recordProperties };
}

/**
 * Package one baked texture and bind the factory call to a native local.
 *
 * The binding is not optional: the value is used wherever the scene used
 * the function's result, and a `cpp` that was still the factory expression
 * would create the texture once per use.
 */
function bindBakedTexture(
    context: BrowserTextureCallContext,
    call: ts.CallExpression,
    shape: BrowserTextureFunctionShape,
    index: number,
    texture: BakedBrowserTexture,
    engineCpp: string,
): Value {
    const label = `${shape.name}_texture_${index}`;
    const cppName = context.allocateTemporaryCppName(label);
    if (texture.factory === "createTexture2DFromPixels") {
        const asset = context.registerAsset(
            `data:application/octet-stream;base64,${Buffer.from(
                texture.pixels,
            ).toString("base64")}`,
            "pixels",
        );
        const options = pixelsTextureOptionsCpp(texture.options, (message) =>
            context.fail(call, message),
        );
        context.reachFeature("texture:pixels", call);
        context.emit(
            `const auto ${cppName} = bbl::create_texture_2d_from_pixels(` +
                `${engineCpp}, bbl::asset_path(${context.cppString(asset.output)}), ` +
                `${doubleLiteral(texture.width)}, ${doubleLiteral(texture.height)}` +
                `${options ? `, ${options}` : ""});`,
        );
        return {
            kind: "texture",
            textureStorage: "pixels",
            cpp: cppName,
            engineCpp,
            nativeBinding: true,
            textureWidth: texture.width,
            textureHeight: texture.height,
            pixelsTexture: {
                source: asset.source,
                asset: context.cppString(asset.output),
                width: texture.width,
                height: texture.height,
                options: texture.options,
            },
        };
    }
    const asset = context.registerAsset(
        `data:${texture.mediaType};base64,${Buffer.from(texture.image).toString(
            "base64",
        )}`,
        "texture",
    );
    const upload = loadTexture2DUploadCpp(texture.options, (message) =>
        context.fail(call, message),
    );
    const dimensions = pngDimensions(texture.image);
    context.reachFeature("texture:file", call);
    context.emit(
        `const auto ${cppName} = bbl::load_file_texture(${engineCpp}, ` +
            `bbl::asset_path(${context.cppString(asset.output)}), ` +
            `${upload.sampler}, ${upload.invertY ? "true" : "false"}, ` +
            `${upload.srgb ? "true" : "false"}, ` +
            `${upload.premultiplyAlpha ? "true" : "false"});`,
    );
    return {
        kind: "texture",
        textureStorage: "file",
        // `loadTexture2D` never sets the texture-OBJECT `invertY`; its own
        // option drives the flipped upload copy instead (texture-2d.ts).
        textureObjectInvertY: false,
        cpp: cppName,
        engineCpp,
        nativeBinding: true,
        ...(dimensions
            ? {
                  textureWidth: dimensions.width,
                  textureHeight: dimensions.height,
              }
            : {}),
        textureFile: { srgb: upload.srgb },
    };
}
