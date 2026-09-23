import {
    dirname,
    extname,
    isAbsolute,
    relative,
    resolve,
    sep,
} from "node:path";
import { cppIdentifiers } from "./cpp-identifiers.js";

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

export function renderSourceUnits(options: {
    source: string;
    realm: string | undefined;
    includes: string;
    declarations: string;
    definitions: readonly NativeDefinition[];
    templates: readonly { name: string; definition: string }[];
    entry: string;
    cpp: string;
}): ApplicationCpp {
    const { source, realm, includes, declarations, definitions, entry, cpp } =
        options;
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
    if (groups.size === 1) {
        return {
            cpp,
            files: new Map([[entryPath, cpp]]),
            sourceUnits: [
                { source, path: entryPath, ...(realm ? { realm } : {}) },
            ],
        };
    }
    const root = commonSourceDirectory(source, groups.keys());
    const header = "sources/application.hpp";
    const files = new Map<string, string>([
        [header, `#pragma once\n${includes}\n${wrap(declarations)}`],
    ]);
    const sourceUnits: SourceUnit[] = [];
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
    for (const [key, group] of groups) {
        const isEntry = key === resolve(source);
        const path = isEntry
            ? entryPath
            : `sources/${sourceUnitStem(root, group.source)}.cpp`;
        const include = relative(dirname(path), header).replaceAll("\\", "/");
        const definitions = group.definitions.join("\n\n");
        const unitEntry = isEntry ? entry : "";
        const body = `namespace bblscene {\n${requiredTemplates(definitions + unitEntry)}\n${definitions}\n}\n${unitEntry}`;
        if (files.has(path))
            throw new Error(`Generated source path collision: ${path}`);
        files.set(
            path,
            `// Generated by bblitec. Do not edit.\n#include "${include}"\n${wrap(body)}`,
        );
        sourceUnits.push({
            source: group.source,
            path,
            ...(realm ? { realm } : {}),
        });
    }
    return { cpp, files, sourceUnits };
}
