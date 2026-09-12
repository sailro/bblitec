import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { cachedBakeSync, moduleIdentity } from "../bake-cache.js";
import { pageBase64Script } from "../browser-harness.js";
import { imageCodecForFileName } from "../image-codec-manifest.js";
import { findRepositoryRoot } from "../upstream-source.js";
import { transpileCommonJs } from "../typescript-transpile.js";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { resolveBundledAsset } from "./assets.js";
import { closureModules, ownsCanvas, sameFileClosure } from "./browser-texture-function.js";
import { runGenerationChild } from "./generation-child.js";
import type { LoweringServices } from "./lowering-services.js";
import { runModuleJsonSync } from "./module-json-sync.js";
import { CompilerSymbols, isDefaultLibraryIdentifier } from "./symbols.js";
import { unwrapExpression } from "./syntax.js";
import { parameterIsReadOnly, tryResolveFunctionDeclaration } from "./user-functions.js";
import type { Value } from "./types.js";

interface CanvasReadbackContext extends Pick<LoweringServices,
    "checker" | "options" | "userFunctions" | "canvasReadbackFunctions" | "fail"> {}

interface ReadbackImage { source: string; logicalPath: string; }
type ReadbackArgument = { kind: "engine" } | { kind: "value"; value: unknown } | { kind: "directory"; index: number };

const dataGlobals = new Set(["Object", "Number", "String", "Boolean", "Set", "Map", "Array", "Math", "undefined"]);
const canvasGlobals = new Set([...dataGlobals, "document", "OffscreenCanvas", "fetch", "createImageBitmap",
    "Uint8Array", "Uint8ClampedArray", "ArrayBuffer", "Error", "Promise"]);

function checkClosedInputs(context: CanvasReadbackContext, closure: readonly ts.FunctionDeclaration[], globals: ReadonlySet<string>): void {
    const symbols = new CompilerSymbols(context.checker);
    for (const member of closure) {
        forEachAnalysisNode(member.body!, child => {
            if (!ts.isIdentifier(child)) return;
            if (isDefaultLibraryIdentifier(context.checker, child)) {
                const property = ts.isPropertyAccessExpression(child.parent) && child.parent.expression === child ? child.parent : undefined;
                if (!globals.has(child.text) || (child.text === "Math" && property?.name.text === "random") ||
                    (child.text === "document" && property?.name.text !== "createElement")) {
                    context.fail(child, "Canvas readback requires deterministic operations over its own canvas and closed data.");
                }
                return;
            }
            const target = symbols.valueSymbol(child)?.valueDeclaration;
            if (target && ts.isVariableDeclaration(target) && ts.isVariableDeclarationList(target.parent) &&
                ts.isVariableStatement(target.parent.parent) && ts.isSourceFile(target.parent.parent.parent) &&
                (!(target.parent.flags & ts.NodeFlags.Const) || !parameterIsReadOnly(context.checker, member, child))) {
                context.fail(child, "Canvas readback cannot mutate or capture mutable module bindings.");
            }
        }, { types: "skip", memberNames: "skip" });
    }
}

/** Closed data arguments may execute only local functions over immutable module inputs. */
function dataArgument(context: CanvasReadbackContext, expression: ts.Expression, value: Value): unknown {
    if (value.staticJson !== undefined) return value.staticJson;
    if (value.staticString !== undefined) return value.staticString;
    if (value.staticNumber !== undefined) return value.staticNumber;
    if (value.staticBoolean !== undefined) return value.staticBoolean;
    if (value.staticStrings !== undefined) return value.staticStrings;
    const node = unwrapExpression(expression);
    const declaration = ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        ? tryResolveFunctionDeclaration(context.checker, node.expression) : undefined;
    if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.name ||
        !ts.isCallExpression(node) || node.arguments.length || declaration.parameters.length ||
        !(ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export)) {
        return context.fail(expression, "Canvas readback arguments require generation-known data or a closed exported data function.");
    }
    const closure = sameFileClosure(context.checker, declaration, () => false);
    if (!closure) return context.fail(expression, "Canvas readback data arguments cannot reach foreign functions or pinned APIs.");
    checkClosedInputs(context, closure, dataGlobals);
    return runModuleJsonSync(declaration.getSourceFile().fileName, declaration.name.text, []);
}

/** Capture one top-level Canvas2D readback from its active, closed invocation. */
export function bakeCanvasReadback(context: CanvasReadbackContext, call: ts.CallExpression): {
    pixels: Uint8Array; images: ReadbackImage[];
} {
    let owner: ts.Node = call;
    while (owner.parent && !ts.isFunctionLike(owner)) owner = owner.parent;
    if (!ts.isFunctionDeclaration(owner) || !owner.name || !owner.body || !ts.isSourceFile(owner.parent)) {
        return context.fail(call, "Canvas readback requires a module-level function invocation.");
    }
    const statement = call.parent;
    if (!ts.isVariableDeclaration(statement) || !ts.isVariableDeclarationList(statement.parent) ||
        !ts.isVariableStatement(statement.parent.parent) || statement.parent.parent.parent !== owner.body) {
        return context.fail(call, "Canvas readback must initialize a top-level local in its producer.");
    }
    const invocation = context.userFunctions.invocationFor(owner);
    const closure = sameFileClosure(context.checker, owner, name => name === "createTexture2DFromPixels" || name === "loadTexture2D");
    if (!invocation || !closure || !closure.some(member => ownsCanvas(member, context.checker)) ||
        invocation.call.arguments.length !== owner.parameters.length) {
        return context.fail(call, "Canvas readback requires a closed canvas-producing function with explicit arguments.");
    }
    checkClosedInputs(context, closure, canvasGlobals);
    const images: ReadbackImage[] = [];
    const files: Record<string, string> = {};
    const arguments_: ReadbackArgument[] = [];
    for (let index = 0; index < invocation.arguments.length; index++) {
        const value = invocation.arguments[index]!;
        if (value.kind === "engine") { arguments_.push({ kind: "engine" }); continue; }
        const data = dataArgument(context, invocation.call.arguments[index]!, value);
        const directory = typeof data === "string" ? resolve(dirname(context.options.fileName), resolveBundledAsset(data, context.options.fileName, context.options)) : undefined;
        if (directory && existsSync(directory) && statSync(directory).isDirectory()) {
            const logical = relative(dirname(resolve(context.options.fileName)), directory).replaceAll("\\", "/");
            if (logical.startsWith("..")) return context.fail(call, "Canvas readback asset directories must be within the entry directory.");
            const prefix = `/__bbl_assets/${index}/`;
            const visit = (folder: string): void => {
                for (const item of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
                    const source = join(folder, item.name);
                    if (item.isDirectory()) { visit(source); continue; }
                    if (!item.isFile()) continue;
                    const suffix = relative(directory, source).replaceAll("\\", "/");
                    files[prefix + suffix] = readFileSync(source).toString("base64");
                    if (imageCodecForFileName(source)) images.push({ source, logicalPath: `${logical}/${suffix}` });
                }
            };
            visit(directory);
            arguments_.push({ kind: "directory", index });
        } else arguments_.push({ kind: "value", value: data });
    }
    const source = owner.getSourceFile();
    const graph = closureModules(source.fileName, owner.name.text, findRepositoryRoot(dirname(source.fileName)));
    if (!graph) return context.fail(call, "Canvas readback module closure must resolve within the repository.");
    const rewritten = source.text.slice(0, call.getStart(source)) +
        `globalThis.__bblReadback(${call.getText(source)})` + source.text.slice(call.end) +
        `\nexports.__bblBrowserTextureTarget = ${owner.name.text};\n`;
    graph.modules[graph.entry]!.javascript = transpileCommonJs(rewritten, source.fileName);
    const input = JSON.stringify({ modules: graph.modules, entry: graph.entry, arguments: arguments_, files });
    const pixels = cachedBakeSync({
        kind: "canvas-readback", version: "1", module: moduleIdentity(import.meta.url), browser: true,
        parameters: { module: graph.entry, function: owner.name.text, readback: call.getStart(source) },
        inputs: [Buffer.from(input)],
    }, () => runCanvasReadback(input));
    context.canvasReadbackFunctions.add(owner.name.text);
    return { images, pixels };
}

function runCanvasReadback(input: string): Uint8Array {
    const harnessModule = new URL("../browser-harness.js", import.meta.url).href;
    const script = `
        import { createServer } from "node:http";
        import { withBrowserPage } from ${JSON.stringify(harnessModule)};
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const prefixes = input.arguments.filter(arg => arg.kind === "directory").map(arg => "/__bbl_assets/" + arg.index + "/");
        const unresolved = new Set();
        const server = createServer((request, response) => {
            const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
            const file = input.files[path];
            if (file !== undefined) { response.end(Buffer.from(file, "base64")); return; }
            if (path !== "/" && path !== "/favicon.ico" && !prefixes.some(prefix => path.startsWith(prefix))) unresolved.add(path);
            response.writeHead(path === "/" ? 200 : 404, { "Content-Type": "text/html" });
            response.end("<!doctype html><title>Canvas readback</title>");
        });
        const value = await withBrowserPage(server, {
            serverName: "Canvas readback server", browserRequirement: "Canvas readback requires Chromium.",
        }, async (page, origin) => {
            await page.route("**/*", route => {
                const url = route.request().url();
                if (new URL(url).origin === origin) return route.continue();
                unresolved.add(url);
                return route.abort();
            });
            await page.goto(origin);
            await page.addScriptTag({ content: ${JSON.stringify(pageBase64Script)} });
            return page.evaluate(async ({ input, origin }) => {
                const stop = {};
                let pixels;
                globalThis.__bblReadback = image => { pixels = bblBase64(image.data); throw stop; };
                const unavailable = new Proxy({}, { get(_owner, key) { throw new Error("Canvas readback reached runtime state: " + String(key)); } });
                const loaded = {};
                const load = key => {
                    if (loaded[key]) return loaded[key].exports;
                    const module = loaded[key] = { exports: {} };
                    const record = input.modules[key];
                    const require = name => {
                        const target = record.resolved[name];
                        if (target) return load(target);
                        if (name === "babylon-lite" || name === "@babylonjs/lite" || name.startsWith("babylon-lite/") || name.startsWith("@babylonjs/lite/")) return unavailable;
                        throw new Error("Canvas readback cannot load " + name);
                    };
                    new Function("module", "exports", "require", record.javascript)(module, module.exports, require);
                    return module.exports;
                };
                const args = input.arguments.map(arg => arg.kind === "engine" ? unavailable :
                    arg.kind === "directory" ? origin + "/__bbl_assets/" + arg.index : arg.value);
                try { await load(input.entry).__bblBrowserTextureTarget(...args); }
                catch (error) { if (error !== stop) throw error; }
                if (pixels === undefined) throw new Error("The producer did not reach its canvas readback.");
                return pixels;
            }, { input, origin });
        });
        if (unresolved.size) throw new Error("Canvas readback fetched outside its closed asset directories: " + [...unresolved].join(", "));
        process.stdout.write(value);
    `;
    return new Uint8Array(Buffer.from(runGenerationChild({ script, input, label: "Generation-time Canvas2D readback" }), "base64"));
}
