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
    const text = String(value);
    return text.includes(".") || /e/i.test(text) ? `${text}f` : `${text}.0f`;
}

export function doubleLiteral(value: number): string {
    const text = String(value);
    return text.includes(".") || /e/i.test(text) ? text : `${text}.0`;
}

/**
 * The one identifier-sanitizing regex. Callers keep their own prefixing and
 * reserved-word policies (a `v_`-prefixed local needs neither; a struct
 * field needs both), but the character class they share lives here.
 */
export function sanitizeCppIdentifier(name: string): string {
    return name.replace(/[^A-Za-z0-9_]/g, "_");
}
