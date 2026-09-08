import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { createCompilerProgram, type CompilerProgram } from "./program.js";
import type { CompileManifest, CompileResult, Feature, WorkerCompilation } from "./types.js";
import { featureOrder, featureSources, renderFeaturesCmake } from "./output-projection.js";
import { reachedGeneratedSources } from "../generated-sources.js";
import { isDefaultLibraryIdentifier } from "./symbols.js";

function globalNamed(frontend: CompilerProgram, expression: ts.Expression, name: string): boolean {
    const identifier = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    return ts.isIdentifier(identifier) && identifier.text === name &&
        isDefaultLibraryIdentifier(frontend.checker, identifier);
}

/** Discovery follows resolved browser constructors, never a filename or demo protocol. */
export function usesWorkers(frontend: CompilerProgram): boolean {
    const visit = (node: ts.Node): boolean =>
        (ts.isNewExpression(node) && globalNamed(frontend, node.expression, "Worker")) ||
        (ts.forEachChild(node, visit) ?? false);
    return frontend.program.getSourceFiles().some(file => !file.isDeclarationFile && visit(file));
}

interface Module { fileName: string; namespace: string; result?: CompileResult }

/** Each compiled module is a factory; invoking it never shares source bindings. */
export function compileWorkerApplication(
    frontend: CompilerProgram,
    compile: (frontend: CompilerProgram, workers: WorkerCompilation) => CompileResult,
    fail: (node: ts.Node, message: string) => never,
): CompileResult {
    const modules = new Map<string, Module>();
    const configuration = (owner: CompilerProgram, namespace?: string): WorkerCompilation => ({
        namespace,
        register(node) {
            if (!globalNamed(owner, node.expression, "Worker")) return undefined;
            if (node.arguments?.length !== 2) return fail(node, "Native Worker requires a local module URL and { type: 'module' }.");
            const [url, options] = node.arguments;
            if (!url || !ts.isNewExpression(url) || !globalNamed(owner, url.expression, "URL") || url.arguments?.length !== 2) {
                return fail(node, "Worker scripts must resolve through new URL(relativePath, import.meta.url).");
            }
            const [path, base] = url.arguments;
            if (!path || !ts.isStringLiteralLike(path) || !/^\.\.?\//.test(path.text) ||
                !base || !ts.isPropertyAccessExpression(base) || base.name.text !== "url" ||
                !ts.isMetaProperty(base.expression) || base.expression.keywordToken !== ts.SyntaxKind.ImportKeyword) {
                return fail(url, "Worker module URLs must be local literals relative to import.meta.url.");
            }
            if (!options || !ts.isObjectLiteralExpression(options) || !options.properties.some(property =>
                ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && property.name.text === "type" &&
                ts.isStringLiteralLike(property.initializer) && property.initializer.text === "module")) {
                return fail(node, "Native Worker currently supports module workers; classic worker scripts are not admitted.");
            }
            const fileName = resolve(dirname(node.getSourceFile().fileName), path.text);
            let module = modules.get(fileName);
            if (!module) {
                const identity = relative(dirname(frontend.sourceFile.fileName), fileName).replaceAll("\\", "/");
                module = { fileName, namespace: `bblworker_${createHash("sha256").update(identity).digest("hex").slice(0, 16)}` };
                modules.set(fileName, module);
            }
            return `::${module.namespace}::initialize`;
        },
        declarations: () => [...modules.values()].map(module => `namespace ${module.namespace} { void initialize(bbl::pal::WorkerRealm&); }`).join("\n"),
    });
    const application = compile(frontend, configuration(frontend));
    for (const module of modules.values()) {
        let source: string;
        try { source = readFileSync(module.fileName, "utf8"); }
        catch { return fail(frontend.sourceFile, `Unable to read worker module '${module.fileName}'.`); }
        const child = createCompilerProgram(source, module.fileName);
        module.result = compile(child, configuration(child, module.namespace));
    }
    const results = [application, ...[...modules.values()].map(module => module.result!)];
    const features = featureOrder.filter(feature => results.some(result => result.manifest.features.includes(feature)));
    // The current renderer uses one generated product set per binary. Any
    // number of realms may consume that set; incompatible sets need explicit
    // index/domain composition before they can share the backend tables.
    const graphics = results.filter(result => result.manifest.features.includes("backend:sdl"));
    const rendering = graphics[0] ?? application;
    const product = renderingProduct(rendering.manifest);
    for (const result of graphics.slice(1)) {
        if (renderingProduct(result.manifest) !== product) {
            fail(frontend.sourceFile, `Worker application reaches incompatible generated rendering products in '${result.manifest.source}'; distinct product domains are not yet admitted.`);
        }
    }
    const assets = new Map<string, CompileManifest["assets"][number]>();
    for (const result of results) for (const asset of result.manifest.assets) {
        const prior = assets.get(asset.source);
        if (prior && JSON.stringify(prior) !== JSON.stringify(asset)) {
            fail(frontend.sourceFile, `Worker application specializes '${asset.source}' differently across realms.`);
        }
        assets.set(asset.source, asset);
    }
    const runtimeSources = [...new Set(features.flatMap(feature => featureSources[feature]))];
    const generatedSources = reachedGeneratedSources(features as Feature[]);
    return {
        cpp: results.map(result => result.cpp).join("\n"),
        cmake: renderFeaturesCmake(features, runtimeSources, generatedSources),
        assetPayloads: new Map(results.flatMap(result => [...result.assetPayloads])),
        ...(rendering.nodeParticles ? { nodeParticles: rendering.nodeParticles } : {}),
        manifest: {
            ...rendering.manifest, source: application.manifest.source, assets: [...assets.values()],
            adaptations: results.flatMap(result => result.manifest.adaptations),
            inputs: [...new Set(results.flatMap(result => result.manifest.inputs))].sort(),
            features, runtimeSources, generatedSources,
            featureSites: Object.assign({}, ...results.map(result => result.manifest.featureSites)),
        },
    };
}

function renderingProduct(manifest: CompileManifest): string {
    const { source, inputs, features, featureSites, runtimeSources, generatedSources, assets, adaptations, ...products } = manifest;
    void source; void inputs; void features; void featureSites; void runtimeSources; void generatedSources; void assets; void adaptations;
    return JSON.stringify(products);
}
