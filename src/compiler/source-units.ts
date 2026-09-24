import {
    dirname,
    extname,
    isAbsolute,
    relative,
    resolve,
    sep,
} from "node:path";
import { cppIdentifiers, cppTokens } from "./cpp-identifiers.js";
import { cppDeclaredNames, splitCppDeclarations } from "./cpp-statements.js";

export type NativeFunctionDefinition = {
    lines: readonly string[];
} & (
    | { kind: "function"; source: string; prototype: string }
    | { kind: "template"; name: string; prototype?: string }
);

/** A namespace-level definition and the source that owns its implementation. */
export interface NativeDefinition {
    source: string;
    definition: string;
}

export interface DataPreamble {
    standalone: string;
    shared: string;
    definitions: NativeDefinition[];
}

export interface SourceUnit {
    source: string;
    path: string;
    realm?: string;
}

export interface ApplicationCpp {
    /** Standalone projection for compiler inspection and native semantic fixtures. */
    cpp: string;
    files: ReadonlyMap<string, string>;
    sourceUnits: SourceUnit[];
}

/** Mirror sibling imports without letting parent paths escape the output tree. */
export function commonSourceDirectory(
    entry: string,
    sources: Iterable<string>,
): string {
    let root = dirname(resolve(entry));
    for (const source of sources) {
        for (;;) {
            const path = relative(root, resolve(source));
            if (
                path !== ".." &&
                !path.startsWith(`..${sep}`) &&
                !isAbsolute(path)
            )
                break;
            const parent = dirname(root);
            if (parent === root)
                throw new Error(
                    `Sources have no common directory: ${entry}, ${source}`,
                );
            root = parent;
        }
    }
    return root;
}

export function sourceUnitStem(root: string, source: string): string {
    const path = relative(root, resolve(source)).replaceAll("\\", "/");
    return path.slice(0, path.length - extname(path).length);
}

/**
 * The most generated code one translation unit holds. A source whose
 * definitions exceed it compiles as several units, so no one unit bounds an
 * application's parallel build; a definition larger than it is a unit alone.
 */
export const unitMaximumBytes = 64 * 1024;

/** Splits a unit's pieces, in order, into parts of at most the unit budget. */
function packUnitParts(pieces: readonly string[]): string[][] {
    const parts: string[][] = [[]];
    let bytes = 0;
    for (const piece of pieces) {
        const current = parts.at(-1)!;
        if (current.length > 0 && bytes + piece.length > unitMaximumBytes) {
            parts.push([piece]);
            bytes = piece.length;
        } else {
            current.push(piece);
            bytes += piece.length;
        }
    }
    return parts;
}

/** A namespace-level declaration, which a unit holds when its code names it. */
export interface UnitDeclaration {
    /** Declared in `namespace bblscene`; otherwise at the realm's own level. */
    readonly scene: boolean;
    readonly text: string;
}

/** The declarations of a `namespace bblscene { ... }` block, in order. */
export function sceneDeclarations(block: string): UnitDeclaration[] {
    const open = block.indexOf("{");
    const close = block.lastIndexOf("}");
    if (open < 0 || close < open) return [];
    return splitCppDeclarations(block.slice(open + 1, close)).map(
        (declaration) => ({ scene: true, text: declaration.text }),
    );
}

/**
 * Selects, for each unit, the declarations its code reaches: those declaring
 * a name the unit or an already selected declaration names, every overload
 * of a function among them, and every overload of a function name whose
 * signature names a selected type. A declaration of any other shape is in
 * every unit. The selection keeps the declarations' order, so each still
 * follows what it depends on.
 */
function unitDeclarations(
    declarations: readonly UnitDeclaration[],
): (code: string) => string {
    const indexed = declarations.map((declaration) => {
        const tokens = [...cppTokens(declaration.text)];
        const declared = cppDeclaredNames(tokens);
        // A declaration's own name reaches no other overload of it.
        const references = new Set(cppIdentifiers(declaration.text));
        for (const name of declared?.names ?? []) references.delete(name);
        return { ...declaration, declared, references };
    });
    const byName = new Map<string, number[]>();
    for (const [index, { declared }] of indexed.entries())
        for (const name of declared?.names ?? [])
            byName.set(name, [...(byName.get(name) ?? []), index]);
    // Overloads found by argument-dependent lookup (a record's `json_write`)
    // follow the types their signatures name.
    const overloads = indexed.flatMap(({ declared }, index) =>
        declared?.function &&
        declared.names.every((name) => byName.get(name)!.length > 1)
            ? [index]
            : [],
    );
    return (code) => {
        const selected = new Set<number>();
        const types = new Set<string>();
        const pending: number[] = [];
        const select = (index: number): void => {
            if (selected.has(index)) return;
            selected.add(index);
            pending.push(index);
        };
        const reach = (names: Iterable<string>): void => {
            for (const name of names)
                for (const index of byName.get(name) ?? []) select(index);
        };
        for (const [index, { declared }] of indexed.entries())
            if (!declared) select(index);
        reach(cppIdentifiers(code));
        for (;;) {
            while (pending.length > 0) {
                const declaration = indexed[pending.pop()!]!;
                if (declaration.declared && !declaration.declared.function)
                    for (const name of declaration.declared.names)
                        types.add(name);
                reach(declaration.references);
            }
            for (const index of overloads)
                if (
                    !selected.has(index) &&
                    [...indexed[index]!.references].some((name) =>
                        types.has(name),
                    )
                )
                    select(index);
            if (pending.length === 0) break;
        }
        let text = "";
        let inScene = false;
        for (const [index, declaration] of indexed.entries()) {
            if (!selected.has(index)) continue;
            if (declaration.scene !== inScene) {
                text += inScene ? "}\n" : "namespace bblscene {\n";
                inScene = declaration.scene;
            }
            text += `${declaration.text}\n`;
        }
        return inScene ? `${text}}\n` : text;
    };
}

export function renderSourceUnits(options: {
    source: string;
    realm: string | undefined;
    includes: string;
    declarations: readonly UnitDeclaration[];
    definitions: readonly NativeDefinition[];
    templates: readonly { name: string; definition: string }[];
    entry: string;
    cpp: string;
}): ApplicationCpp {
    const { source, realm, includes, definitions, entry, cpp } = options;
    const wrap = (text: string): string =>
        realm ? `namespace ${realm} {\n${text}\n}\n` : text;
    const entryPath = "main.cpp";
    const groups = new Map<string, { source: string; definitions: string[] }>();
    groups.set(resolve(source), { source, definitions: [] });
    for (const definition of definitions) {
        const key = resolve(definition.source);
        let group = groups.get(key);
        if (!group) {
            group = { source: definition.source, definitions: [] };
            groups.set(key, group);
        }
        group.definitions.push(definition.definition);
    }
    const parts = [...groups].map(([key, group]) => ({
        key,
        source: group.source,
        pieces: packUnitParts(
            key === resolve(source)
                ? [entry, ...group.definitions]
                : group.definitions,
        ),
    }));
    if (parts.length === 1 && parts[0]!.pieces.length === 1) {
        return {
            cpp,
            files: new Map([[entryPath, cpp]]),
            sourceUnits: [
                { source, path: entryPath, ...(realm ? { realm } : {}) },
            ],
        };
    }
    const root = commonSourceDirectory(
        source,
        parts.map(({ key }) => key),
    );
    const header = "sources/application.hpp";
    const files = new Map<string, string>([
        [header, `#pragma once\n${includes}\n`],
    ]);
    const sourceUnits: SourceUnit[] = [];
    const declarationsFor = unitDeclarations(options.declarations);
    const templates = new Map(
        options.templates.map((definition) => [
            definition.name,
            cppIdentifiers(definition.definition),
        ]),
    );
    const requiredTemplates = (body: string): string => {
        if (templates.size === 0) return "";
        const reached = new Set<string>();
        const visit = (identifiers: ReadonlySet<string>): void => {
            for (const identifier of identifiers) {
                const definition = templates.get(identifier);
                if (!definition || reached.has(identifier)) continue;
                reached.add(identifier);
                visit(definition);
            }
        };
        visit(cppIdentifiers(body));
        return options.templates
            .filter(({ name }) => reached.has(name))
            .map(({ definition }) => definition)
            .join("\n\n");
    };
    for (const { key, source: partSource, pieces } of parts) {
        const isEntry = key === resolve(source);
        const stem = `sources/${sourceUnitStem(root, partSource)}`;
        for (const [index, piece] of pieces.entries()) {
            // The entry's further parts sit beside the other sources' units.
            const path =
                isEntry && index === 0
                    ? entryPath
                    : `${stem}${index === 0 ? "" : `.part${index}`}.cpp`;
            const include = relative(dirname(path), header).replaceAll(
                "\\",
                "/",
            );
            const unitEntry = isEntry && index === 0 ? piece[0]! : "";
            const definitions = (unitEntry ? piece.slice(1) : piece).join(
                "\n\n",
            );
            const body = `namespace bblscene {\n${requiredTemplates(definitions + unitEntry)}\n${definitions}\n}\n${unitEntry}`;
            if (files.has(path))
                throw new Error(`Generated source path collision: ${path}`);
            files.set(
                path,
                `// Generated by bblitec. Do not edit.\n#include "${include}"\n${wrap(`${declarationsFor(body)}\n${body}`)}`,
            );
            sourceUnits.push({
                source: partSource,
                path,
                ...(realm ? { realm } : {}),
            });
        }
    }
    return { cpp, files, sourceUnits };
}
