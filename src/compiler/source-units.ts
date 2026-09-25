import {
    dirname,
    extname,
    isAbsolute,
    relative,
    resolve,
    sep,
} from "node:path";
import { cppTokens } from "./cpp-identifiers.js";
import { cppDeclaredNames, splitCppDeclarations } from "./cpp-declarations.js";

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
 * The most generated code one translation unit holds, counted in identifier
 * tokens: the code a compiler analyses and optimizes, where literal data
 * tables cost little. A source whose definitions exceed it compiles as
 * several units, so no one unit bounds an application's parallel build; each
 * further unit repeats the instantiations its code shares with the others,
 * so the budget keeps parts few. A definition larger than it is a unit alone.
 */
export const unitMaximumWeight = 24_000;

/** What one pass over a piece of code finds: the names it uses and its weight. */
interface CodeScan {
    readonly identifiers: ReadonlySet<string>;
    /** Identifier tokens, repeats included ({@link unitMaximumWeight}). */
    readonly weight: number;
}

function scanCode(code: string): CodeScan {
    const identifiers = new Set<string>();
    let weight = 0;
    for (const token of cppTokens(code)) {
        if (token.kind !== "identifier") continue;
        identifiers.add(token.text);
        weight++;
    }
    return { identifiers, weight };
}

/** The names the wrapper around a unit's pieces adds to its body. */
const unitWrapperNames: ReadonlySet<string> = new Set([
    "namespace",
    "bblscene",
]);

/**
 * What one piece of a unit costs a part. Its code and the template
 * definitions it reaches count toward the unit budget; a template, and every
 * distinct name the code uses (a record, an environment, a runtime
 * function), is compiled once per part however many of its pieces use it,
 * so pieces sharing them belong together.
 */
interface PieceCost {
    readonly code: number;
    /** Template definitions the piece reaches, by their code weight. */
    readonly templates: ReadonlyMap<string, number>;
    /** What the part compiles for the piece: its templates and names. */
    readonly shared: ReadonlyMap<string, number>;
}

/** A distinct name's weight when grouping pieces: the instantiations it brings. */
const sharedNameWeight = 20;

function pieceCost(
    piece: CodeScan,
    reachedTemplates: (identifiers: Iterable<string>) => ReadonlySet<string>,
    templateWeight: (name: string) => number,
): PieceCost {
    const templates = new Map<string, number>();
    for (const name of reachedTemplates(piece.identifiers))
        templates.set(name, templateWeight(name));
    const shared = new Map<string, number>();
    for (const name of piece.identifiers) shared.set(name, sharedNameWeight);
    for (const [name, weight] of templates) shared.set(name, weight);
    return { code: piece.weight, templates, shared };
}

/**
 * Splits a unit's pieces into parts of at most the unit budget, grouping
 * pieces that share templates and names so each part compiles as few of
 * them again as it can. A part starts from the heaviest piece left (the
 * first piece, when it is pinned there) and then takes, while the budget
 * holds, the piece that brings the least new shared weight per unit of its
 * own code. Pieces keep their order within a part, and parts are ordered by
 * their first piece.
 */
function packUnitParts<Piece extends { readonly scan: CodeScan }>(
    pieces: readonly Piece[],
    reachedTemplates: (identifiers: Iterable<string>) => ReadonlySet<string>,
    templateWeight: (name: string) => number,
    pinFirst: boolean,
): Piece[][] {
    const costs = pieces.map((piece) =>
        pieceCost(piece.scan, reachedTemplates, templateWeight),
    );
    const allTemplates = new Map<string, number>();
    let whole = 0;
    for (const cost of costs) {
        whole += cost.code;
        for (const [name, weight] of cost.templates)
            allTemplates.set(name, weight);
    }
    for (const weight of allTemplates.values()) whole += weight;
    if (whole <= unitMaximumWeight || pieces.length <= 1) return [[...pieces]];
    const users = new Map<string, number[]>();
    for (const [index, cost] of costs.entries())
        for (const name of cost.shared.keys()) {
            const list = users.get(name);
            if (list) list.push(index);
            else users.set(name, [index]);
        }
    const unassigned = new Set(pieces.keys());
    const parts: number[][] = [];
    while (unassigned.size > 0) {
        const seed =
            pinFirst && parts.length === 0
                ? 0
                : [...unassigned].reduce((best, index) =>
                      costs[index]!.code > costs[best]!.code ? index : best,
                  );
        const part = [seed];
        unassigned.delete(seed);
        const held = new Set<string>();
        let weight = 0;
        // What each piece would add to the budget, and to shared weight.
        const addedBudget = new Map<number, number>();
        const addedShared = new Map<number, number>();
        for (const index of unassigned) {
            const cost = costs[index]!;
            let templates = 0;
            for (const templateWeight of cost.templates.values())
                templates += templateWeight;
            let shared = 0;
            for (const sharedWeight of cost.shared.values())
                shared += sharedWeight;
            addedBudget.set(index, cost.code + templates);
            addedShared.set(index, shared);
        }
        const hold = (index: number): void => {
            const cost = costs[index]!;
            weight += cost.code;
            for (const [name, sharedWeight] of cost.shared) {
                if (held.has(name)) continue;
                held.add(name);
                const templateWeight = cost.templates.get(name) ?? 0;
                weight += templateWeight;
                for (const user of users.get(name)!) {
                    if (!addedShared.has(user)) continue;
                    addedShared.set(
                        user,
                        addedShared.get(user)! - sharedWeight,
                    );
                    addedBudget.set(
                        user,
                        addedBudget.get(user)! - templateWeight,
                    );
                }
            }
        };
        hold(seed);
        for (;;) {
            let best: number | undefined;
            let bestScore = Infinity;
            for (const [index, shared] of addedShared) {
                if (weight + addedBudget.get(index)! > unitMaximumWeight)
                    continue;
                const score = shared / (costs[index]!.code + 1);
                if (score < bestScore) {
                    best = index;
                    bestScore = score;
                }
            }
            if (best === undefined) break;
            part.push(best);
            unassigned.delete(best);
            addedShared.delete(best);
            addedBudget.delete(best);
            hold(best);
        }
        parts.push(part.sort((a, b) => a - b));
    }
    return parts
        .sort((a, b) => a[0]! - b[0]!)
        .map((part) => part.map((index) => pieces[index]!));
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
): (identifiers: Iterable<string>) => string {
    const indexed = declarations.map((declaration) => {
        const tokens = [...cppTokens(declaration.text)];
        const declared = cppDeclaredNames(tokens);
        // A declaration's own name reaches no other overload of it.
        const references = new Set<string>();
        for (const token of tokens)
            if (token.kind === "identifier") references.add(token.text);
        for (const name of declared?.names ?? []) references.delete(name);
        return { ...declaration, declared, references };
    });
    const byName = new Map<string, number[]>();
    for (const [index, { declared }] of indexed.entries())
        for (const name of declared?.names ?? []) {
            const list = byName.get(name);
            if (list) list.push(index);
            else byName.set(name, [index]);
        }
    // Overloads found by argument-dependent lookup (a record's `json_write`)
    // follow the types their signatures name.
    const overloads = indexed.flatMap(({ declared }, index) =>
        declared?.function &&
        declared.names.every((name) => byName.get(name)!.length > 1)
            ? [index]
            : [],
    );
    const referencesAny = (
        references: ReadonlySet<string>,
        names: ReadonlySet<string>,
    ): boolean => {
        for (const name of references) if (names.has(name)) return true;
        return false;
    };
    return (identifiers) => {
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
        reach(identifiers);
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
                    referencesAny(indexed[index]!.references, types)
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
    const templates = new Map(
        options.templates.map((definition) => [
            definition.name,
            scanCode(definition.definition),
        ]),
    );
    const reachedTemplates = (
        identifiers: Iterable<string>,
    ): ReadonlySet<string> => {
        const reached = new Set<string>();
        const visit = (names: Iterable<string>): void => {
            for (const identifier of names) {
                const definition = templates.get(identifier);
                if (!definition || reached.has(identifier)) continue;
                reached.add(identifier);
                visit(definition.identifiers);
            }
        };
        if (templates.size > 0) visit(identifiers);
        return reached;
    };
    // Each piece is scanned once: its names and weight both pack the parts
    // and select what each part's body needs.
    const parts = [...groups].map(([key, group]) => ({
        key,
        source: group.source,
        pieces: packUnitParts(
            (key === resolve(source)
                ? [entry, ...group.definitions]
                : group.definitions
            ).map((text) => ({ text, scan: scanCode(text) })),
            reachedTemplates,
            (name) => templates.get(name)!.weight,
            key === resolve(source),
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
            const unitEntry = isEntry && index === 0 ? piece[0]!.text : "";
            const definitions = (unitEntry ? piece.slice(1) : piece)
                .map(({ text }) => text)
                .join("\n\n");
            // The body's names are its pieces', its templates' and the
            // wrapper's, so no part is scanned again.
            const bodyNames = new Set<string>();
            for (const { scan } of piece)
                for (const name of scan.identifiers) bodyNames.add(name);
            const reached = reachedTemplates(bodyNames);
            const required = options.templates.filter(({ name }) =>
                reached.has(name),
            );
            for (const { name } of required)
                for (const identifier of templates.get(name)!.identifiers)
                    bodyNames.add(identifier);
            for (const name of unitWrapperNames) bodyNames.add(name);
            const body = `namespace bblscene {\n${required.map(({ definition }) => definition).join("\n\n")}\n${definitions}\n}\n${unitEntry}`;
            if (files.has(path))
                throw new Error(`Generated source path collision: ${path}`);
            files.set(
                path,
                `// Generated by bblitec. Do not edit.\n#include "${include}"\n${wrap(`${declarationsFor(bodyNames)}\n${body}`)}`,
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
