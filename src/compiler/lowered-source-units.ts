import { createHash } from "node:crypto";
import { splitCppDeclarations, cppDeclaredNames } from "./cpp-declarations.js";
import { cppTokens, type CppToken } from "./cpp-identifiers.js";
import {
    packUnitParts,
    scanCode,
    templateReach,
    unitMaximumWeight,
} from "./source-units.js";

interface Definition {
    readonly text: string;
    readonly scope: readonly string[];
    readonly scan: ReturnType<typeof scanCode>;
}

/** Preprocessing inside opaque bodies stays with them; namespace declarations cannot move across it. */
function namespaceDirectives(source: string): boolean {
    if (!/^\s*#/m.test(source)) return false;
    const scopes: boolean[] = [];
    let namespace = false;
    for (const token of cppTokens(source)) {
        if (token.text === "namespace") namespace = true;
        else if (token.text === "{") {
            scopes.push(namespace);
            namespace = false;
        } else if (token.text === "}") scopes.pop();
        else if (token.text === ";") namespace = false;
        else if (token.text === "#" && scopes.every(Boolean)) return true;
    }
    return false;
}

/** A function's parameter list and body boundary, without reading its statements. */
function functionBoundary(tokens: readonly CppToken[]):
    | {
          open: number;
          close: number;
          body: number;
      }
    | undefined {
    let brackets = 0;
    let parentheses = 0;
    let open: number | undefined;
    let close: number | undefined;
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!;
        if (token.text === "[") brackets++;
        if (token.text === "]") brackets--;
        if (brackets) continue;
        if (token.text === "(") {
            if (parentheses++ === 0 && open === undefined) open = index;
        } else if (token.text === ")") {
            if (--parentheses === 0 && close === undefined) close = index;
        } else if (token.text === "{" && parentheses === 0) {
            // Braced constructor member initializers precede the actual body.
            if (
                close !== undefined &&
                tokens
                    .slice(close + 1, index)
                    .some((token) => token.text === ":")
            ) {
                let depth = 1;
                let end = index;
                while (++end < tokens.length && depth) {
                    if (tokens[end]!.text === "{") depth++;
                    if (tokens[end]!.text === "}") depth--;
                }
                if ([",", "{"].includes(tokens[end]?.text ?? "")) {
                    index = end - 1;
                    continue;
                }
            }
            return open !== undefined && close !== undefined
                ? { open, close, body: index }
                : undefined;
        }
    }
    return undefined;
}

function inlineDeclaration(text: string, tokens: readonly CppToken[]): string {
    if (tokens.some((token) => token.text === "inline")) return text;
    let index = 0;
    while (tokens[index]?.text === "[" && tokens[index + 1]?.text === "[") {
        index += 2;
        while (
            index < tokens.length &&
            !(tokens[index]?.text === "]" && tokens[index + 1]?.text === "]")
        )
            index++;
        index += 2;
    }
    const position = tokens[index]?.start ?? 0;
    return `${text.slice(0, position)}inline ${text.slice(position)}`;
}

/** Defaults belong to the shared declaration, never to its separately compiled definition. */
function withoutDefaults(
    text: string,
    tokens: readonly CppToken[],
    open: number,
    close: number,
): string | undefined {
    const ranges: { start: number; end: number }[] = [];
    let depth = 0;
    let angles = 0;
    let start: number | undefined;
    for (let index = open + 1; index <= close; index++) {
        const token = tokens[index]!;
        // A bare angle in a default may be a comparison or a template argument.
        // Keep this module whole until its generator provides that signature fact.
        if (
            start !== undefined &&
            depth === 0 &&
            ["<", ">"].includes(token.text)
        )
            return undefined;
        if (
            depth === 0 &&
            angles === 0 &&
            (token.text === "," || index === close)
        ) {
            if (start !== undefined) ranges.push({ start, end: token.start });
            start = undefined;
        }
        if (token.text === "=" && depth === 0 && angles === 0)
            start = token.start;
        if (["(", "[", "{"].includes(token.text)) depth++;
        else if ([")", "]", "}"].includes(token.text)) depth--;
        else if (depth === 0 && token.text === "<") angles++;
        else if (depth === 0 && token.text === ">") angles--;
    }
    for (const range of ranges.reverse())
        text = text.slice(0, range.start) + text.slice(range.end);
    return text;
}

/**
 * Pack namespace-level library definitions with the application's unit budget.
 * Bodies remain opaque here. Anonymous namespaces gain one module-private name
 * so records, mutable globals and function-local statics retain one identity.
 */
export function renderLoweredSourceUnits(
    path: string,
    source: string,
): ReadonlyMap<string, string> {
    const unchanged = new Map([[path, source]]);
    if (source.length < unitMaximumWeight) return unchanged;
    const firstNamespace = /^namespace\s+[\w:]+\s*\{/m.exec(source);
    if (!firstNamespace) return unchanged;
    const prefix = source.slice(0, firstNamespace.index);
    // Conditional declarations need a preprocessing model before they can move.
    if (namespaceDirectives(source.slice(firstNamespace.index)))
        return unchanged;
    if (scanCode(source).weight <= unitMaximumWeight) return unchanged;
    const privateName = `bbl_lowered_${createHash("sha256").update(path).digest("hex").slice(0, 12)}`;
    const definitions: Definition[] = [];
    const templates = new Map<string, ReturnType<typeof scanCode>>();
    const scopeText = (scope: readonly string[], text: string): string =>
        scope.reduceRight(
            (body, name) => `namespace ${name} {\n${body}\n}`,
            text,
        );
    const project = (
        body: string,
        scope: readonly string[],
    ): string | undefined => {
        const declarations: string[] = [];
        for (const declaration of splitCppDeclarations(body)) {
            let text = declaration.text;
            const offset = declaration.tokens[0]!.start;
            const tokens = declaration.tokens.map((token) => ({
                ...token,
                start: token.start - offset,
                end: token.end - offset,
            }));
            const head = tokens[0]?.text;
            if (head === "namespace") {
                const open = tokens.findIndex((token) => token.text === "{");
                if (open < 0 || tokens.at(-1)?.text !== "}") return undefined;
                const name = text
                    .slice(tokens[0]!.end, tokens[open]!.start)
                    .trim();
                const nested = project(
                    text.slice(tokens[open]!.end, tokens.at(-1)!.start),
                    [...scope, name || privateName],
                );
                if (nested === undefined) return undefined;
                declarations.push(
                    `namespace ${name || privateName} {\n${nested}\n}`,
                );
                if (!name) declarations.push(`using namespace ${privateName};`);
                continue;
            }
            if (head === "#") return undefined;
            const declared = cppDeclaredNames(tokens);
            if (!declared && !["using", "static_assert"].includes(head!))
                return undefined;
            const specifiers = tokens.slice(
                0,
                tokens.findIndex((token) =>
                    ["(", "{", "="].includes(token.text),
                ),
            );
            const storage = specifiers.find((token) => token.text === "static");
            if (storage) {
                if (!declared) return undefined;
                text = text.slice(0, storage.start) + text.slice(storage.end);
                const nested = project(text, [...scope, privateName]);
                if (nested === undefined) return undefined;
                declarations.push(
                    `namespace ${privateName} {\n${nested}\n}`,
                    ...declared.names.map(
                        (name) => `using ${privateName}::${name};`,
                    ),
                );
                continue;
            }
            const boundary = declared?.function
                ? functionBoundary(tokens)
                : undefined;
            const headerOnly =
                head === "template" ||
                specifiers.some((token) =>
                    ["inline", "constexpr", "consteval"].includes(token.text),
                );
            if (headerOnly || !boundary) {
                if (head === "template") {
                    for (const name of declared?.names ?? [])
                        templates.set(name, scanCode(text));
                } else if (
                    declared &&
                    !declared.function &&
                    ![
                        "using",
                        "struct",
                        "class",
                        "enum",
                        "union",
                        "extern",
                        "inline",
                    ].includes(head!)
                ) {
                    // A namespace variable has one storage even when each part reads its declaration.
                    text = inlineDeclaration(text, tokens);
                }
                declarations.push(text);
                continue;
            }
            const name = tokens[boundary.open - 1];
            const member =
                name?.qualified || tokens[boundary.open - 2]?.text === "~";
            if (specifiers.some((token) => token.text === "auto")) {
                declarations.push(inlineDeclaration(text, tokens));
                continue;
            }
            if (!member)
                declarations.push(
                    `${text.slice(0, tokens[boundary.body]!.start).trim()};`,
                );
            const definition = withoutDefaults(
                text,
                tokens,
                boundary.open,
                boundary.close,
            );
            if (definition === undefined) return undefined;
            text = definition;
            definitions.push({ text, scope, scan: scanCode(text) });
        }
        return declarations.join("\n\n");
    };
    const declarations = project(source.slice(firstNamespace.index), []);
    if (declarations === undefined) return unchanged;
    const parts = packUnitParts(
        definitions,
        templateReach(templates),
        (name) => templates.get(name)!.weight,
        false,
    );
    if (parts.length <= 1) return unchanged;
    const stem = path.slice(0, -4);
    const include = `bblite/upstream/units/${stem.replace(/^upstream\/src\//, "")}.hpp`;
    const header = `upstream/include/${include}`;
    const files = new Map([
        [header, `#pragma once\n${prefix}${declarations}\n`],
    ]);
    for (const [index, part] of parts.entries()) {
        files.set(
            index ? `${stem}.part${index}.cpp` : path,
            `// Generated by bblitec. Do not edit.\n#include <${include}>\n${part.map(({ text, scope }) => scopeText(scope, text)).join("\n\n")}\n`,
        );
    }
    return files;
}
