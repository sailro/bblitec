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

/**
 * A `float` literal that reads back as the same float32.
 *
 * `floatLiteral` spells the shortest decimal that round-trips as a
 * DOUBLE, which is right where the value is a JavaScript number whose
 * store rounds. A value read out of a `Float32Array` is already the
 * float32, so the shortest decimal that round-trips through
 * `Math.fround` names the identical float in about half the characters —
 * and a baked CSG solid emits hundreds of thousands of them.
 */
export function float32Literal(value: number): string {
    if (!Number.isFinite(value)) {
        throw new Error(
            `A float32 literal needs a finite value, received ${value}.`,
        );
    }
    // `toPrecision` drops the sign of negative zero, which `floatLiteral`
    // preserves deliberately; every other value keeps its sign through the
    // search below.
    if (Object.is(value, -0)) return "-0.0f";
    // Binary search over the digit count rather than an ascending ladder:
    // round-tripping is monotone in the count, and two thirds of a baked
    // geometry stream needs eight or nine significant digits, so counting
    // up from one spends five `toPrecision` calls per value to learn that.
    // Measured over scene 90's 358,016 floats: 272 ms ascending against
    // 137 ms here, byte-identical on every value.
    let low = 1;
    let high = 9;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (Math.fround(Number(value.toPrecision(middle))) === value) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    const shortened = Number(value.toPrecision(low));
    return floatLiteral(
        Math.fround(shortened) === value ? shortened : value,
    );
}

export function doubleLiteral(value: number): string {
    const text = String(value);
    return text.includes(".") || /e/i.test(text) ? text : `${text}.0`;
}

const VALUES_PER_LINE = 64;

/**
 * A generation-time numeric stream as a C++ `static const` array, plus the
 * expression that hands it to a `std::vector` parameter.
 *
 * Baked bytes reach the generated program as data, and the shape matters:
 * a braced `std::vector` initializer of this size is one object-file
 * section per element on MSVC (`C1128`, measured at 140k floats), while
 * the same values as a plain array compile in a third of a second on both
 * compilers. The array is emitted where the caller emits, so a
 * function-local declaration puts the data in the binary once and builds
 * the vector from its bounds at the call.
 *
 * An empty stream has no array to bound -- a zero-length C array is not
 * C++ -- so it answers with the empty vector and declares nothing.
 */
export function cppArrayDeclaration(
    symbol: string,
    elementType: string,
    values: ArrayLike<number>,
    spell: (value: number) => string,
): { readonly lines: readonly string[]; readonly expression: string } {
    if (values.length === 0) {
        return { lines: [], expression: `std::vector<${elementType}>{}` };
    }
    // A baked stream repeats its values far more than it varies them --
    // scene 90's four arrays hold 358,016 floats over 10,148 distinct ones,
    // and its normals are 489 distinct of 51,924 -- while `float32Literal`'s
    // round-trip search is the whole cost of spelling one. A memo that
    // lives for this call alone spells each distinct value once: measured
    // over that scene, 186 ms becomes 22 ms, byte-identical on all 358,016.
    //
    // Negative zero is spelled OUTSIDE the memo rather than filtered inside
    // it. `Map` compares keys with SameValueZero, so -0 and +0 are one key
    // while their spellings deliberately differ; a shared entry would
    // answer for whichever sign arrived first, which is the sign
    // `float32Literal` documents that it preserves.
    const memo = new Map<number, string>();
    const spelled = Array.from(values, (value) => {
        if (Object.is(value, -0)) return spell(value);
        let text = memo.get(value);
        if (text === undefined) {
            text = spell(value);
            memo.set(value, text);
        }
        return text;
    });
    const lines = [`static const ${elementType} ${symbol}[] = {`];
    for (let start = 0; start < spelled.length; start += VALUES_PER_LINE) {
        lines.push(
            `    ${spelled
                .slice(start, start + VALUES_PER_LINE)
                .join(", ")},`,
        );
    }
    lines.push("};");
    return {
        lines,
        expression:
            `std::vector<${elementType}>(${symbol}, ` +
            `${symbol} + ${values.length})`,
    };
}

/**
 * A whole string that is exactly one C++ identifier.
 *
 * The one spelling every consumer shares — emitted-C++ identifier checks
 * and WGSL identifier refusals alike, since the two grammars agree on
 * `[A-Za-z_][A-Za-z0-9_]*`.
 */
export const cppIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
