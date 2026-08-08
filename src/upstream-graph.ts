import ts from "typescript";
import { UpstreamSourceStore } from "./upstream-source.js";

export interface GraphEdge {
    kind: "dynamic" | "runtime" | "type";
    specifier: string;
    target?: string;
}

export interface ModuleDiagnostics {
    asyncFunctions: number;
    awaitExpressions: number;
    classes: number;
    closures: number;
    dynamicImports: number;
    newExpressions: number;
    objectDefineProperty: number;
    platformReferences: string[];
}

export interface ModuleGraphEntry {
    path: string;
    bytes: number;
    edges: GraphEdge[];
    diagnostics: ModuleDiagnostics;
}

export interface UpstreamGraph {
    package: {
        name: string;
        version: string;
        sourceVersion: string;
    };
    roots: Array<{
        exportName: string;
        symbolName: string;
        modulePath: string;
    }>;
    modules: ModuleGraphEntry[];
    externals: string[];
    summary: {
        moduleCount: number;
        sourceBytes: number;
        runtimeEdges: number;
        dynamicEdges: number;
        typeEdges: number;
        diagnostics: Omit<ModuleDiagnostics, "platformReferences"> & {
            platformReferences: string[];
        };
    };
}
const platformNames = new Set([
    "AudioContext",
    "Blob",
    "CanvasRenderingContext2D",
    "OffscreenCanvas",
    "WebSocket",
    "document",
    "fetch",
    "navigator",
    "performance",
    "requestAnimationFrame",
    "window",
]);

function diagnostics(file: ts.SourceFile): ModuleDiagnostics {
    const result: ModuleDiagnostics = {
        asyncFunctions: 0,
        awaitExpressions: 0,
        classes: 0,
        closures: 0,
        dynamicImports: 0,
        newExpressions: 0,
        objectDefineProperty: 0,
        platformReferences: [],
    };
    const references = new Set<string>();
    const visit = (node: ts.Node): void => {
        if (
            (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
            node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
        ) {
            result.asyncFunctions += 1;
        }
        if (ts.isAwaitExpression(node)) result.awaitExpressions += 1;
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) result.classes += 1;
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) result.closures += 1;
        if (ts.isNewExpression(node)) result.newExpressions += 1;
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) result.dynamicImports += 1;
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "Object" &&
            (node.expression.name.text === "defineProperty" || node.expression.name.text === "defineProperties")
        ) {
            result.objectDefineProperty += 1;
        }
        if (ts.isIdentifier(node) && platformNames.has(node.text)) references.add(node.text);
        ts.forEachChild(node, visit);
    };
    visit(file);
    result.platformReferences = [...references].sort();
    return result;
}

function moduleEdges(store: UpstreamSourceStore, modulePath: string, file: ts.SourceFile): GraphEdge[] {
    const edges: GraphEdge[] = [];
    const addEdge = (kind: GraphEdge["kind"], specifier: string): void => {
        const target = store.resolveImport(modulePath, specifier);
        edges.push({ kind, specifier, ...(target ? { target } : {}) });
    };

    for (const statement of file.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
            const clause = statement.importClause;
            const runtimeBindings =
                !clause?.isTypeOnly &&
                (!clause?.namedBindings ||
                    !ts.isNamedImports(clause.namedBindings) ||
                    clause.namedBindings.elements.some((element) => !element.isTypeOnly));
            addEdge(runtimeBindings || !clause ? "runtime" : "type", statement.moduleSpecifier.text);
        } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
            addEdge(statement.isTypeOnly ? "type" : "runtime", statement.moduleSpecifier.text);
        }
    }

    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length === 1 &&
            ts.isStringLiteral(node.arguments[0]!)
        ) {
            addEdge("dynamic", node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return edges;
}

export function analyzeUpstreamGraph(store: UpstreamSourceStore, publicExports: string[]): UpstreamGraph {
    const roots = publicExports.map((exportName) => {
        const resolved = store.resolvePublicExport(exportName);
        return {
            exportName,
            symbolName: resolved.importedName,
            modulePath: resolved.modulePath,
        };
    });
    const queue = roots.map((root) => root.modulePath);
    const visited = new Set<string>();
    const modules: ModuleGraphEntry[] = [];
    const externals = new Set<string>();

    while (queue.length > 0) {
        const modulePath = queue.shift()!;
        if (visited.has(modulePath)) continue;
        visited.add(modulePath);
        const source = store.getSource(modulePath);
        const file = ts.createSourceFile(modulePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const edges = moduleEdges(store, modulePath, file);
        modules.push({
            path: modulePath,
            bytes: Buffer.byteLength(source),
            edges,
            diagnostics: diagnostics(file),
        });
        for (const edge of edges) {
            if (edge.target && (edge.kind === "runtime" || edge.kind === "dynamic")) queue.push(edge.target);
            else if (!edge.target && !edge.specifier.startsWith(".")) externals.add(edge.specifier);
        }
    }

    modules.sort((left, right) => left.path.localeCompare(right.path));
    const aggregate: UpstreamGraph["summary"]["diagnostics"] = {
        asyncFunctions: 0,
        awaitExpressions: 0,
        classes: 0,
        closures: 0,
        dynamicImports: 0,
        newExpressions: 0,
        objectDefineProperty: 0,
        platformReferences: [],
    };
    const platformReferences = new Set<string>();
    for (const module of modules) {
        aggregate.asyncFunctions += module.diagnostics.asyncFunctions;
        aggregate.awaitExpressions += module.diagnostics.awaitExpressions;
        aggregate.classes += module.diagnostics.classes;
        aggregate.closures += module.diagnostics.closures;
        aggregate.dynamicImports += module.diagnostics.dynamicImports;
        aggregate.newExpressions += module.diagnostics.newExpressions;
        aggregate.objectDefineProperty += module.diagnostics.objectDefineProperty;
        module.diagnostics.platformReferences.forEach((reference) => platformReferences.add(reference));
    }
    aggregate.platformReferences = [...platformReferences].sort();
    const edges = modules.flatMap((module) => module.edges);
    return {
        package: {
            name: store.pin.package,
            version: store.pin.version,
            sourceVersion: store.pin.sourceVersion,
        },
        roots,
        modules,
        externals: [...externals].sort(),
        summary: {
            moduleCount: modules.length,
            sourceBytes: modules.reduce((sum, module) => sum + module.bytes, 0),
            runtimeEdges: edges.filter((edge) => edge.kind === "runtime").length,
            dynamicEdges: edges.filter((edge) => edge.kind === "dynamic").length,
            typeEdges: edges.filter((edge) => edge.kind === "type").length,
            diagnostics: aggregate,
        },
    };
}
