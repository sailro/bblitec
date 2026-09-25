import { cppTokens, type CppToken } from "./cpp-identifiers.js";

/** One emitted namespace-scope declaration. */
export interface CppDeclaration {
    readonly text: string;
    readonly tokens: readonly CppToken[];
}

const openers: ReadonlySet<string> = new Set(["(", "[", "{"]);

const closers: ReadonlySet<string> = new Set([")", "]", "}"]);

/**
 * The index after a possibly scoped, possibly templated name that begins at
 * `index`, or undefined when no name begins there.
 */
function qualifiedNameEnd(
    tokens: readonly CppToken[],
    index: number,
): number | undefined {
    if (tokens[index]?.text === "::") index++;
    for (;;) {
        if (tokens[index]?.kind !== "identifier") return undefined;
        index++;
        if (tokens[index]?.text === "<") {
            const end = templateArgumentsEnd(tokens, index);
            if (end === undefined) return undefined;
            index = end;
        }
        if (tokens[index]?.text !== "::") return index;
        index++;
    }
}

/** The index after the `>` that closes the `<` at `index`. */
function templateArgumentsEnd(
    tokens: readonly CppToken[],
    index: number,
): number | undefined {
    let angles = 0;
    let depth = 0;
    for (; index < tokens.length; index++) {
        const token = tokens[index]!;
        if (token.kind !== "punctuation") continue;
        if (openers.has(token.text)) depth++;
        else if (closers.has(token.text)) {
            if (--depth < 0) return undefined;
        } else if (depth === 0) {
            if (token.text === "<") angles++;
            else if (token.text === ">" && --angles === 0) return index + 1;
            else if (token.text === ";" || token.text === "=") return undefined;
        }
    }
    return undefined;
}

/** Keywords whose body is followed by the `;` that ends their declaration. */
const typeKeywords: ReadonlySet<string> = new Set([
    "struct",
    "class",
    "union",
    "enum",
]);

/**
 * Splits namespace-scope text into its declarations. A function or namespace
 * body ends its declaration at its closing `}`; a class body, an enumeration
 * or a braced initializer ends at the `;` after it.
 */
export function splitCppDeclarations(text: string): CppDeclaration[] {
    const tokens = [...cppTokens(text)];
    const declarations: CppDeclaration[] = [];
    let first = 0;
    let depth = 0;
    // Whether the declaration's first top-level brace opens a class body,
    // an enumeration or an initializer rather than a function body.
    let bracesNeedSemicolon = false;
    const finish = (last: number): void => {
        declarations.push({
            text: text.slice(tokens[first]!.start, tokens[last]!.end),
            tokens: tokens.slice(first, last + 1),
        });
        first = last + 1;
        bracesNeedSemicolon = false;
    };
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!;
        if (
            depth === 0 &&
            token.kind === "identifier" &&
            typeKeywords.has(token.text)
        )
            bracesNeedSemicolon = true;
        if (token.kind !== "punctuation") continue;
        if (depth === 0 && token.text === "=") bracesNeedSemicolon = true;
        if (openers.has(token.text)) {
            depth++;
        } else if (closers.has(token.text)) {
            depth--;
            if (depth < 0)
                throw new Error("Unbalanced emitted C++ declarations.");
            if (depth === 0 && token.text === "}" && !bracesNeedSemicolon) {
                // A `;` after a function body is an empty declaration.
                if (tokens[index + 1]?.text === ";") index++;
                finish(index);
            }
        } else if (token.text === ";" && depth === 0) {
            finish(index);
        }
    }
    if (depth !== 0 || first < tokens.length)
        throw new Error("Emitted C++ declarations end inside a declaration.");
    return declarations;
}

/** What a namespace-scope declaration introduces. */
interface CppDeclaredNames {
    readonly names: readonly string[];
    /** A function, which another declaration of its name overloads. */
    readonly function: boolean;
}

/**
 * The names a namespace-scope declaration introduces: a class, enumeration
 * or alias name, a function's name, or a variable's. Undefined when its
 * shape is not one of those.
 */
export function cppDeclaredNames(
    tokens: readonly CppToken[],
): CppDeclaredNames | undefined {
    let index = 0;
    // `template <...>` prefixes.
    while (
        tokens[index]?.text === "template" &&
        tokens[index + 1]?.text === "<"
    ) {
        let angles = 0;
        for (index++; index < tokens.length; index++) {
            if (tokens[index]!.text === "<") angles++;
            else if (tokens[index]!.text === ">" && --angles === 0) break;
        }
        index++;
    }
    const head = tokens[index];
    if (!head) return undefined;
    if (head.text === "using") {
        const name = tokens[index + 1];
        return name?.kind === "identifier" && tokens[index + 2]?.text === "="
            ? { names: [name.text], function: false }
            : undefined;
    }
    if (head.text === "namespace") return undefined;
    for (let cursor = index; cursor < tokens.length; cursor++) {
        const token = tokens[cursor]!;
        if (token.kind === "identifier" && typeKeywords.has(token.text)) {
            let name = cursor + 1;
            if (
                tokens[name]?.text === "class" ||
                tokens[name]?.text === "struct"
            )
                name++;
            while (
                tokens[name]?.text === "[" &&
                tokens[name + 1]?.text === "["
            ) {
                let depth = 0;
                for (; name < tokens.length; name++) {
                    if (tokens[name]!.text === "[") depth++;
                    else if (tokens[name]!.text === "]" && --depth === 0) break;
                }
                name++;
            }
            return tokens[name]?.kind === "identifier"
                ? { names: [tokens[name]!.text], function: false }
                : undefined;
        }
        if (token.kind !== "punctuation") continue;
        if (token.text === "<") {
            // Template arguments of a return or variable type.
            const end = qualifiedNameEnd(tokens, cursor - 1);
            if (end === undefined) return undefined;
            cursor = end - 1;
            continue;
        }
        if (token.text === "(") {
            const name = tokens[cursor - 1];
            if (name?.kind === "identifier" && name.text !== "decltype")
                return { names: [name.text], function: true };
            if (tokens[cursor - 2]?.text === "operator")
                return {
                    names: [`operator${name?.text ?? ""}`],
                    function: true,
                };
            return undefined;
        }
        if (token.text === "=" || token.text === ";" || token.text === "{") {
            const name = tokens[cursor - 1];
            return name?.kind === "identifier"
                ? { names: [name.text], function: false }
                : undefined;
        }
    }
    return undefined;
}
