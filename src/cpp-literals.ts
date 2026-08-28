/**
 * C++ literal formatting for JavaScript numbers, shared by every emitter.
 *
 * One rule, text-based: append the suffix when `String(value)` already reads
 * as a C++ floating literal (it carries a dot or an exponent), otherwise add
 * `.0` so an integer-valued number stays a floating literal. The exponent
 * test is the load-bearing half: `String(1e21)` is `"1e+21"`, for which the
 * former integer-based rule (`Number.isInteger` → `${value}.0f`) emitted
 * `1e+21.0f` — not C++.
 */
export function floatLiteral(value: number): string {
    // `String(-0)` is `"0"`, which loses the sign bit. Every emitter that
    // byte-preserves a block cares — a folded uniform whose default is
    // negative zero must upload negative zero.
    const text = Object.is(value, -0) ? "-0" : String(value);
    return text.includes(".") || /e/i.test(text) ? `${text}f` : `${text}.0f`;
}

export function doubleLiteral(value: number): string {
    const text = String(value);
    return text.includes(".") || /e/i.test(text) ? text : `${text}.0`;
}

/**
 * A string as a C++ literal.
 *
 * JSON's escaping is C++'s for everything a scene can carry, except the two
 * line separators JavaScript allows raw inside a string and C++ does not.
 */
export function stringLiteral(value: string): string {
    return JSON.stringify(value)
        .split("\u2028")
        .join("\\u2028")
        .split("\u2029")
        .join("\\u2029");
}

/**
 * The one identifier-sanitizing regex. Callers keep their own prefixing and
 * reserved-word policies (a `v_`-prefixed local needs neither; a struct
 * field needs both), but the character class they share lives here.
 */
export function sanitizeCppIdentifier(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** A source-level name that is safe as an unprefixed C++ identifier. */
export function cppIdentifier(name: string): string {
    const cleaned = sanitizeCppIdentifier(name);
    const prefixed = /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
    return cppKeywords.has(prefixed) ? `${prefixed}_` : prefixed;
}

const cppKeywords: ReadonlySet<string> = new Set([
    "alignas", "alignof", "and", "and_eq", "asm", "atomic_cancel",
    "atomic_commit", "atomic_noexcept", "auto", "bitand", "bitor",
    "bool", "break", "case", "catch", "char", "char8_t", "char16_t",
    "char32_t", "class", "compl", "concept", "const", "consteval",
    "constexpr", "constinit", "const_cast", "continue", "co_await",
    "co_return", "co_yield", "decltype", "default", "delete", "do",
    "double", "dynamic_cast", "else", "enum", "explicit", "export",
    "extern", "false", "float", "for", "friend", "goto", "if",
    "inline", "int", "long", "mutable", "namespace", "new", "noexcept",
    "not", "not_eq", "nullptr", "operator", "or", "or_eq", "private",
    "protected", "public", "reflexpr", "register", "reinterpret_cast",
    "requires", "return", "short", "signed", "sizeof", "static",
    "static_assert", "static_cast", "struct", "switch", "synchronized",
    "template", "this", "thread_local", "throw", "true", "try",
    "typedef", "typeid", "typename", "union", "unsigned", "using",
    "virtual", "void", "volatile", "wchar_t", "while", "xor", "xor_eq",
]);
