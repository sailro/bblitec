import { isRecord } from "./json-fields.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { type UpstreamPin, sharedUpstreamStore } from "./upstream-source.js";
import {
    aliasTarget,
    declaredSymbol,
    resolvedSymbol,
} from "./compiler/symbols.js";

interface ApiItem {
    id: string;
    owner: string;
    kind: string;
    declaration: string;
    fingerprint: string;
    dependencies: string[];
}

export interface ApiSnapshot {
    schemaVersion: 1;
    pin: UpstreamPin;
    typescript: string;
    declarationsSha256: string;
    exports: Record<string, string>;
    items: ApiItem[];
}

export function apiHash(text: string | Buffer): string {
    return createHash("sha256").update(text).digest("hex");
}

/** Token boundaries and literal contents matter; comments and formatting do not. */
function declarationText(node: ts.Node): string {
    const printer = ts.createPrinter({ removeComments: true });
    const text = printer.printNode(
        ts.EmitHint.Unspecified,
        node,
        node.getSourceFile(),
    );
    const scanner = ts.createScanner(
        ts.ScriptTarget.Latest,
        true,
        ts.LanguageVariant.Standard,
        text,
    );
    const tokens: string[] = [];
    while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken)
        tokens.push(scanner.getTokenText());
    return tokens.join(" ");
}

export function declarationKey(node: ts.Node): string {
    return `${resolve(node.getSourceFile().fileName)}:${node.getStart()}:${node.end}`;
}

function declarationName(node: ts.Node): ts.DeclarationName | undefined {
    if (
        ts.isFunctionDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isEnumMember(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isParameter(node)
    )
        return node.name;
    return undefined;
}

function visible(node: ts.Node): boolean {
    const name = declarationName(node);
    return (
        !(
            ts.canHaveModifiers(node) &&
            ts
                .getModifiers(node)
                ?.some(
                    (modifier) =>
                        modifier.kind === ts.SyntaxKind.PrivateKeyword ||
                        modifier.kind === ts.SyntaxKind.ProtectedKeyword,
                )
        ) && !(name && ts.isPrivateIdentifier(name))
    );
}

function memberName(node: ts.Node): string | undefined {
    const name = declarationName(node);
    if (!name) return undefined;
    return ts.isIdentifier(name) ||
        ts.isStringLiteralLike(name) ||
        ts.isNumericLiteral(name)
        ? name.text
        : name.getText();
}

function kindOf(node: ts.Node): string | undefined {
    if (ts.isFunctionDeclaration(node)) return "function";
    if (ts.isInterfaceDeclaration(node)) return "interface";
    if (ts.isTypeAliasDeclaration(node)) return "type";
    if (ts.isClassDeclaration(node)) return "class";
    if (ts.isEnumDeclaration(node)) return "enum";
    if (ts.isEnumMember(node)) return "enum-member";
    if (ts.isVariableDeclaration(node)) return "variable";
    if (ts.isModuleDeclaration(node)) return "namespace";
    if (ts.isMethodSignature(node) || ts.isMethodDeclaration(node))
        return "method";
    if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node))
        return "property";
    if (ts.isGetAccessorDeclaration(node)) return "get";
    if (ts.isSetAccessorDeclaration(node)) return "set";
    if (ts.isConstructorDeclaration(node)) return "constructor";
    if (
        ts.isConstructSignatureDeclaration(node) ||
        ts.isConstructorTypeNode(node)
    )
        return "construct";
    if (ts.isCallSignatureDeclaration(node) || ts.isFunctionTypeNode(node))
        return "call";
    if (ts.isIndexSignatureDeclaration(node)) return "index";
    return undefined;
}

const signatures = new Set([
    "function",
    "method",
    "constructor",
    "construct",
    "call",
    "index",
]);

export interface ApiSurface {
    snapshot: ApiSnapshot;
    /** The resolved declaration entry the surface was extracted from. */
    entry: string;
    /** Declaration identity also works with the compiler's augmented copy of index.d.ts. */
    byDeclaration: Map<string, string[]>;
}

/** Public exports plus their local declaration closure, including unnamed option records. */
export function extractApi(
    program: ts.Program,
    entry: ts.SourceFile,
    pin: UpstreamPin,
): ApiSurface {
    const checker = program.getTypeChecker();
    const module = declaredSymbol(checker, entry);
    if (!module)
        throw new Error(
            `API declaration entry is not a module: ${entry.fileName}`,
        );

    const roots = new Map<string, ts.Node[]>();
    const rootOf = new Map<ts.Node, string>();
    // The published package has a rolled declaration entry. Referenced external peer types
    // remain named dependencies, rather than adding the DOM/WebGPU API to our denominator.
    for (const statement of entry.statements) {
        const declarations = ts.isVariableStatement(statement)
            ? statement.declarationList.declarations
            : [statement];
        for (const node of declarations) {
            const name = memberName(node);
            if (!name || !kindOf(node)) continue;
            roots.set(name, [...(roots.get(name) ?? []), node]);
            const mark = (child: ts.Node): void => {
                rootOf.set(child, name);
                ts.forEachChild(child, mark);
            };
            mark(node);
        }
    }
    const exports: Record<string, string> = {};
    for (const symbol of checker.getExportsOfModule(module)) {
        const target = aliasTarget(checker, symbol);
        const owner = target.declarations
            ?.map((node) => rootOf.get(node))
            .find((name) => name !== undefined);
        if (!owner)
            throw new Error(
                `Public export ${symbol.name} is outside the rolled declaration entry.`,
            );
        exports[symbol.name] = owner;
    }
    const references = (node: ts.Node): string[] => {
        const result = new Set<string>();
        const visit = (child: ts.Node): void => {
            if (!visible(child)) return;
            if (
                ts.isTypeReferenceNode(child) ||
                ts.isExpressionWithTypeArguments(child) ||
                ts.isTypeQueryNode(child)
            ) {
                const name = ts.isTypeReferenceNode(child)
                    ? child.typeName
                    : ts.isTypeQueryNode(child)
                      ? child.exprName
                      : child.expression;
                for (const declaration of resolvedSymbol(checker, name)
                    ?.declarations ?? []) {
                    const owner = rootOf.get(declaration);
                    if (owner) result.add(owner);
                }
            }
            ts.forEachChild(child, visit);
        };
        visit(node);
        return [...result].sort();
    };
    const edges = new Map(
        [...roots].map(([name, nodes]) => [
            name,
            [...new Set(nodes.flatMap(references))],
        ]),
    );
    const closure = (seeds: readonly string[]): string[] => {
        const reached = new Set<string>();
        const visit = (name: string): void => {
            if (reached.has(name)) return;
            reached.add(name);
            for (const dependency of edges.get(name) ?? []) visit(dependency);
        };
        seeds.forEach(visit);
        return [...reached].sort();
    };
    const rootHashes = new Map(
        [...roots].map(([name, nodes]) => [
            name,
            apiHash(nodes.map(declarationText).sort().join("\n")),
        ]),
    );
    const fingerprint = (
        declaration: string,
        dependencies: readonly string[],
    ): string =>
        apiHash(
            JSON.stringify([
                declaration,
                dependencies.map((name) => [name, rootHashes.get(name)]),
            ]),
        );
    const items = new Map<string, ApiItem>();
    const byDeclaration = new Map<string, string[]>();
    for (const owner of closure(Object.values(exports))) {
        const visit = (node: ts.Node, path: string, top = false): void => {
            if (!visible(node)) return;
            const kind = kindOf(node);
            let nested = path;
            if (kind) {
                const name = memberName(node);
                const staticPrefix =
                    ts.canHaveModifiers(node) &&
                    ts
                        .getModifiers(node)
                        ?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
                        ? "static."
                        : "";
                const label =
                    !top && name ? `${path}.${staticPrefix}${name}` : path;
                const declaration = declarationText(node);
                const id = `${label}:${kind}${signatures.has(kind) ? `:${apiHash(declaration).slice(0, 16)}` : ""}`;
                const dependencies = closure(references(node));
                const previous = items.get(id);
                if (previous && previous.declaration !== declaration) {
                    // Declaration merging keeps all parts of an interface/namespace in one unit.
                    previous.declaration += `\n${declaration}`;
                    previous.dependencies = [
                        ...new Set([...previous.dependencies, ...dependencies]),
                    ].sort();
                    previous.fingerprint = fingerprint(
                        previous.declaration,
                        previous.dependencies,
                    );
                } else if (!previous)
                    items.set(id, {
                        id,
                        owner,
                        kind,
                        declaration,
                        fingerprint: fingerprint(declaration, dependencies),
                        dependencies,
                    });
                const key = declarationKey(node);
                byDeclaration.set(key, [...(byDeclaration.get(key) ?? []), id]);
                nested = id;
            } else if (ts.isParameter(node))
                nested = `${path}.parameter.${memberName(node)}`;
            else if (
                ts.isUnionTypeNode(node) ||
                ts.isIntersectionTypeNode(node)
            ) {
                for (const type of node.types)
                    visit(
                        type,
                        `${path}.variant.${apiHash(declarationText(type)).slice(0, 16)}`,
                    );
                return;
            }
            ts.forEachChild(node, (child) => visit(child, nested));
        };
        for (const node of roots.get(owner) ?? []) visit(node, owner, true);
    }
    return {
        snapshot: {
            schemaVersion: 1,
            pin,
            typescript: ts.version,
            declarationsSha256: apiHash(entry.text),
            exports: Object.fromEntries(
                Object.entries(exports).sort(([a], [b]) => a.localeCompare(b)),
            ),
            items: [...items.values()].sort((a, b) => a.id.localeCompare(b.id)),
        },
        entry: resolve(entry.fileName),
        byDeclaration,
    };
}

export function loadApiSurface(): ApiSurface {
    const store = sharedUpstreamStore();
    const path = join(store.packageRoot, "index.d.ts");
    const program = ts.createProgram([path], {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
    });
    const entry = program.getSourceFile(path);
    if (!entry) throw new Error(`Missing API declarations: ${path}`);
    return extractApi(program, entry, store.pin);
}

export function readApiSnapshot(path: string): ApiSnapshot {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        !Array.isArray(value.items) ||
        !isRecord(value.pin) ||
        typeof value.pin.package !== "string" ||
        typeof value.pin.version !== "string" ||
        typeof value.pin.sourceVersion !== "string" ||
        !isRecord(value.exports) ||
        typeof value.typescript !== "string" ||
        typeof value.declarationsSha256 !== "string"
    ) {
        throw new Error(`Invalid API snapshot: ${path}`);
    }
    const items = value.items.map((item: unknown): ApiItem => {
        if (
            !isRecord(item) ||
            typeof item.id !== "string" ||
            typeof item.owner !== "string" ||
            typeof item.kind !== "string" ||
            typeof item.fingerprint !== "string" ||
            typeof item.declaration !== "string" ||
            !Array.isArray(item.dependencies) ||
            !item.dependencies.every(
                (name: unknown) => typeof name === "string",
            )
        ) {
            throw new Error(`Invalid API item in ${path}`);
        }
        return {
            id: item.id,
            owner: item.owner,
            kind: item.kind,
            declaration: item.declaration,
            fingerprint: item.fingerprint,
            dependencies: item.dependencies,
        };
    });
    if (new Set(items.map((item) => item.id)).size !== items.length)
        throw new Error(`Duplicate API items in ${path}`);
    const exports: Record<string, string> = {};
    for (const [name, owner] of Object.entries(value.exports)) {
        if (typeof owner !== "string")
            throw new Error(`Invalid API export in ${path}`);
        exports[name] = owner;
    }
    return {
        schemaVersion: 1,
        pin: {
            package: value.pin.package,
            version: value.pin.version,
            sourceVersion: value.pin.sourceVersion,
        },
        typescript: value.typescript,
        declarationsSha256: value.declarationsSha256,
        exports,
        items,
    };
}

export function diffApi(
    before: ApiSnapshot,
    after: ApiSnapshot,
): {
    added: string[];
    removed: string[];
    changed: string[];
    exportsChanged: boolean;
} {
    const old = new Map(before.items.map((item) => [item.id, item]));
    const current = new Map(after.items.map((item) => [item.id, item]));
    return {
        added: after.items
            .filter((item) => !old.has(item.id))
            .map((item) => item.id),
        removed: before.items
            .filter((item) => !current.has(item.id))
            .map((item) => item.id),
        changed: after.items
            .filter(
                (item) =>
                    old.has(item.id) &&
                    old.get(item.id)?.fingerprint !== item.fingerprint,
            )
            .map((item) => item.id),
        exportsChanged:
            JSON.stringify(before.exports) !== JSON.stringify(after.exports),
    };
}
