import { cppTokens, type CppToken } from "./cpp-identifiers.js";

/** One top-level statement of an emitted C++ block. */
export interface CppStatement {
    readonly text: string;
    readonly tokens: readonly CppToken[];
}

/**
 * What a statement can do to the block it sits in. A compound statement or an
 * expression statement introduces no name after itself; a declaration does;
 * anything else (a jump, a label, a using-declaration) stays where it is.
 */
type CppStatementShape = "compound" | "expression" | "declaration" | "other";

/** A parsed single-declarator local declaration. */
interface CppLocalDeclaration {
    readonly name: string;
    /** The declared type as spelled, or undefined for `auto`/`decltype`. */
    readonly spelledType?: string;
    readonly constant: boolean;
    readonly reference: boolean;
    /** The token index of the `=` of a copy-initialization, if any. */
    readonly initializerIndex?: number;
}

const compoundKeywords: ReadonlySet<string> = new Set([
    "if",
    "for",
    "while",
    "do",
    "switch",
    "try",
]);

const otherKeywords: ReadonlySet<string> = new Set([
    "return",
    "throw",
    "break",
    "continue",
    "goto",
    "co_return",
    "co_yield",
    "co_await",
    "case",
    "default",
    "using",
    "typedef",
    "static_assert",
    "else",
    "catch",
    "template",
    "namespace",
    "struct",
    "class",
    "enum",
    "union",
    "asm",
    "new",
    "delete",
    "sizeof",
    "alignof",
    "typeid",
    "noexcept",
    "requires",
    "operator",
    "this",
    "true",
    "false",
    "nullptr",
]);

const specifiers: ReadonlySet<string> = new Set([
    "const",
    "constexpr",
    "static",
    "thread_local",
    "volatile",
    "inline",
    "extern",
    "mutable",
]);

const fundamentalTypes: ReadonlySet<string> = new Set([
    "bool",
    "char",
    "short",
    "int",
    "long",
    "float",
    "double",
    "signed",
    "unsigned",
    "void",
]);

/** Keywords after which a `[` introduces a lambda rather than a subscript. */
const expressionKeywords: ReadonlySet<string> = new Set([
    "return",
    "co_return",
    "co_yield",
    "co_await",
    "throw",
    "else",
    "do",
    "case",
]);

const openers: ReadonlySet<string> = new Set(["(", "[", "{"]);
const closers: ReadonlySet<string> = new Set([")", "]", "}"]);

/**
 * Splits the text between a block's braces into its top-level statements.
 * A compound statement ends at its closing `}` unless an `else`, a `catch`
 * or a do-statement's `while` continues it; every other statement ends at
 * its top-level `;`.
 */
export function splitCppStatements(body: string): CppStatement[] {
    const tokens = [...cppTokens(body)];
    const statements: CppStatement[] = [];
    let first = 0;
    let depth = 0;
    const finish = (last: number): void => {
        statements.push({
            text: body.slice(tokens[first]!.start, tokens[last]!.end),
            tokens: tokens.slice(first, last + 1),
        });
        first = last + 1;
    };
    const compound = (): boolean => isCompoundHead(tokens[first]!);
    // Whether the token after `index` continues the current statement.
    const continued = (index: number): boolean => {
        const next = tokens[index + 1];
        if (next?.kind !== "identifier") return false;
        const head = tokens[first]!;
        if (next.text === "else") return true;
        if (next.text === "catch")
            return head.kind === "identifier" && head.text === "try";
        if (next.text === "while")
            return (
                head.kind === "identifier" &&
                head.text === "do" &&
                !hasTopLevelWhile(tokens, first + 1, index)
            );
        return false;
    };
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!;
        if (token.kind !== "punctuation") continue;
        if (openers.has(token.text)) {
            depth++;
        } else if (closers.has(token.text)) {
            depth--;
            if (depth < 0)
                throw new Error("Unbalanced emitted C++ block: stray closer.");
            // A brace closing at statement level inside any other statement
            // (a braced initializer, a called lambda) runs on to its `;`.
            if (
                depth === 0 &&
                token.text === "}" &&
                compound() &&
                !continued(index)
            )
                finish(index);
        } else if (token.text === ";" && depth === 0 && !continued(index)) {
            finish(index);
        }
    }
    if (depth !== 0)
        throw new Error("Unbalanced emitted C++ block: unclosed opener.");
    if (first < tokens.length)
        throw new Error("Emitted C++ block ends inside a statement.");
    return statements;
}

function isCompoundHead(token: CppToken): boolean {
    return (
        (token.kind === "punctuation" && token.text === "{") ||
        (token.kind === "identifier" && compoundKeywords.has(token.text))
    );
}

/** Whether a do-statement already has its `while` between `from` and `to`. */
function hasTopLevelWhile(
    tokens: readonly CppToken[],
    from: number,
    to: number,
): boolean {
    let depth = 0;
    for (let index = from; index <= to; index++) {
        const token = tokens[index]!;
        if (token.kind === "punctuation") {
            if (openers.has(token.text)) depth++;
            else if (closers.has(token.text)) depth--;
        } else if (
            depth === 0 &&
            token.kind === "identifier" &&
            token.text === "while"
        )
            return true;
    }
    return false;
}

/** How a statement relates to the block around it. */
export function cppStatementShape(
    tokens: readonly CppToken[],
): CppStatementShape {
    const head = tokens[0];
    if (!head) return "other";
    if (isCompoundHead(head)) return "compound";
    if (head.kind === "punctuation") {
        if (head.text === "[")
            return tokens[1]?.text === "[" ? "declaration" : "expression";
        return ["(", "*", "++", "--", "!", "~"].includes(head.text)
            ? "expression"
            : "other";
    }
    if (head.kind !== "identifier" || otherKeywords.has(head.text))
        return "other";
    if (
        specifiers.has(head.text) ||
        fundamentalTypes.has(head.text) ||
        head.text === "auto" ||
        head.text === "decltype"
    )
        return "declaration";
    const after = qualifiedNameEnd(tokens, 0);
    const next = after === undefined ? undefined : tokens[after];
    if (!next) return "other";
    if (next.kind === "identifier") return "declaration";
    if (next.kind !== "punctuation") return "other";
    if (next.text === "&" || next.text === "&&" || next.text === "*")
        return "declaration";
    return [
        "(",
        "=",
        ".",
        "->",
        "[",
        "++",
        "--",
        "+",
        "-",
        "/",
        "%",
        "|",
        "^",
        "==",
        "!=",
    ].includes(next.text)
        ? "expression"
        : "other";
}

/**
 * The index after a possibly scoped, possibly templated name that begins at
 * `index`, or undefined when no name begins there.
 */
export function qualifiedNameEnd(
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

/** The index after the `)` that closes the `(` at `index`. */
function parenthesesEnd(
    tokens: readonly CppToken[],
    index: number,
): number | undefined {
    let depth = 0;
    for (; index < tokens.length; index++) {
        const token = tokens[index]!;
        if (token.kind !== "punctuation") continue;
        if (openers.has(token.text)) depth++;
        else if (closers.has(token.text) && --depth === 0) return index + 1;
    }
    return undefined;
}

/**
 * Reads a declaration of one local: attributes, specifiers, a type (`auto`,
 * `decltype(...)`, a scoped name or fundamental keywords), reference or
 * pointer declarators and the name. Undefined for any other form (several
 * declarators, structured bindings, arrays, function pointers).
 */
export function parseCppLocalDeclaration(
    tokens: readonly CppToken[],
): CppLocalDeclaration | undefined {
    let index = 0;
    let constant = false;
    while (tokens[index]?.text === "[" && tokens[index + 1]?.text === "[") {
        let depth = 0;
        for (; index < tokens.length; index++) {
            const text = tokens[index]!.text;
            if (text === "[") depth++;
            else if (text === "]" && --depth === 0) break;
        }
        index++;
    }
    const readSpecifiers = (): void => {
        while (
            tokens[index]?.kind === "identifier" &&
            specifiers.has(tokens[index]!.text)
        ) {
            if (tokens[index]!.text === "const") constant = true;
            index++;
        }
    };
    readSpecifiers();
    const typeStart = index;
    let deduced = false;
    const head = tokens[index];
    if (head?.kind !== "identifier") return undefined;
    if (head.text === "auto") {
        deduced = true;
        index++;
    } else if (head.text === "decltype") {
        deduced = true;
        if (tokens[index + 1]?.text !== "(") return undefined;
        const end = parenthesesEnd(tokens, index + 1);
        if (end === undefined) return undefined;
        index = end;
    } else if (fundamentalTypes.has(head.text)) {
        while (
            tokens[index]?.kind === "identifier" &&
            fundamentalTypes.has(tokens[index]!.text)
        )
            index++;
    } else {
        const end = qualifiedNameEnd(tokens, index);
        if (end === undefined) return undefined;
        index = end;
    }
    const typeEnd = index;
    readSpecifiers();
    let reference = false;
    let pointers = 0;
    for (;;) {
        const text = tokens[index]?.text;
        if (text === "&" || text === "&&") {
            if (reference) return undefined;
            reference = true;
            index++;
        } else if (text === "*" && !reference) {
            pointers++;
            index++;
            if (tokens[index]?.text === "const") return undefined;
        } else break;
    }
    const name = tokens[index];
    if (name?.kind !== "identifier" || otherKeywords.has(name.text))
        return undefined;
    const after = tokens[index + 1];
    if (!after || !["=", "{", "(", ";"].includes(after.text)) return undefined;
    const spelled = deduced
        ? undefined
        : spellCppTokens(tokens.slice(typeStart, typeEnd)) +
          "*".repeat(pointers);
    return {
        name: name.text,
        ...(spelled === undefined ? {} : { spelledType: spelled }),
        constant,
        reference,
        ...(after.text === "=" ? { initializerIndex: index + 1 } : {}),
    };
}

/** Tokens spelled back as source: names and template arguments unspaced. */
export function spellCppTokens(tokens: readonly CppToken[]): string {
    return tokens
        .map((token) => token.text)
        .join(" ")
        .replace(/ ?(::|<|>|,) ?/g, (_match, symbol: string) =>
            symbol === "," ? ", " : symbol,
        );
}

/**
 * Whether the statement leaves the block it belongs to other than by falling
 * through or throwing: a `return`, a coroutine keyword or a `goto` outside
 * every lambda and local class it contains, or a `break` or `continue` outside
 * every loop (and, for `break`, every `switch`) it contains.
 */
export function transfersControlOut(tokens: readonly CppToken[]): boolean {
    // What each open bracket opens: another function's body (a lambda or a
    // local class), a loop or switch body, or a lambda introducer.
    type Frame = {
        nested: boolean;
        loop: boolean;
        switchBody: boolean;
        introducer: boolean;
    };
    const plain: Frame = {
        nested: false,
        loop: false,
        switchBody: false,
        introducer: false,
    };
    const stack: Frame[] = [];
    let pendingLambda: number | undefined;
    let pendingClass: number | undefined;
    let pendingLoop: { depth: number; switchBody: boolean } | undefined;
    const enclosed = (predicate: (frame: Frame) => boolean): boolean =>
        stack.some(predicate);
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!;
        if (token.kind === "identifier") {
            switch (token.text) {
                case "struct":
                case "class":
                case "union":
                    pendingClass ??= stack.length;
                    break;
                case "for":
                case "while":
                case "do":
                case "switch":
                    // A do-statement's `while` tail opens no body.
                    pendingLoop = {
                        depth: stack.length,
                        switchBody: token.text === "switch",
                    };
                    break;
                case "return":
                case "co_return":
                case "co_await":
                case "co_yield":
                case "goto":
                    if (!enclosed((frame) => frame.nested)) return true;
                    break;
                case "break":
                    if (
                        !enclosed(
                            (frame) =>
                                frame.nested || frame.loop || frame.switchBody,
                        )
                    )
                        return true;
                    break;
                case "continue":
                    if (!enclosed((frame) => frame.nested || frame.loop))
                        return true;
                    break;
            }
            continue;
        }
        if (token.kind !== "punctuation") continue;
        switch (token.text) {
            case "[": {
                if (tokens[index + 1]?.text === "[") {
                    // An attribute: skip to its closing `]]`.
                    let depth = 0;
                    for (; index < tokens.length; index++) {
                        const text = tokens[index]!.text;
                        if (text === "[") depth++;
                        else if (text === "]" && --depth === 0) break;
                    }
                    break;
                }
                const previous = tokens[index - 1];
                const subscript =
                    previous !== undefined &&
                    (previous.kind === "literal" ||
                        (previous.kind === "identifier" &&
                            !expressionKeywords.has(previous.text)) ||
                        previous.text === ")" ||
                        previous.text === "]");
                stack.push({ ...plain, introducer: !subscript });
                break;
            }
            case "]": {
                const frame = stack.pop();
                if (frame?.introducer) pendingLambda = stack.length;
                break;
            }
            case "(":
                stack.push(plain);
                break;
            case "{": {
                const depth = stack.length;
                const nested =
                    pendingLambda === depth || pendingClass === depth;
                const loop =
                    !nested &&
                    pendingLoop?.depth === depth &&
                    !pendingLoop.switchBody;
                const switchBody =
                    !nested &&
                    pendingLoop?.depth === depth &&
                    pendingLoop.switchBody;
                if (pendingLambda === depth) pendingLambda = undefined;
                if (pendingClass === depth) pendingClass = undefined;
                if (pendingLoop?.depth === depth) pendingLoop = undefined;
                stack.push({ ...plain, nested, loop, switchBody });
                break;
            }
            case ")":
            case "}":
                stack.pop();
                break;
            case ";":
            case ",":
                if (pendingLambda === stack.length) pendingLambda = undefined;
                if (token.text === ";") {
                    if (pendingClass === stack.length) pendingClass = undefined;
                    // A loop whose body is one statement ends at its `;`.
                    if (pendingLoop?.depth === stack.length)
                        pendingLoop = undefined;
                }
                break;
        }
    }
    return false;
}

/** Unqualified identifiers a statement names, in order of first use. */
export function unqualifiedIdentifiers(
    tokens: readonly CppToken[],
): readonly string[] {
    const names = new Set<string>();
    for (const token of tokens)
        if (token.kind === "identifier" && !token.qualified)
            names.add(token.text);
    return [...names];
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
export function splitCppDeclarations(text: string): CppStatement[] {
    const tokens = [...cppTokens(text)];
    const declarations: CppStatement[] = [];
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
