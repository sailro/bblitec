/** Identifier tokens in emitted C++; comments and quoted payloads carry no reads. */
export function cppIdentifiers(source: string): ReadonlySet<string> {
    const identifiers = new Set<string>();
    const start = (code: number): boolean => code === 95 ||
        (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const digit = (code: number): boolean => code >= 48 && code <= 57;
    let index = 0;
    while (index < source.length) {
        if (source.startsWith("//", index)) {
            const end = source.indexOf("\n", index + 2);
            index = end < 0 ? source.length : end + 1;
        } else if (source.startsWith("/*", index)) {
            const end = source.indexOf("*/", index + 2);
            index = end < 0 ? source.length : end + 2;
        } else if (source[index] === '"' || source[index] === "'") {
            const quote = source[index++];
            while (index < source.length) {
                const character = source[index++];
                if (character === "\\") index++;
                else if (character === quote) break;
            }
        } else if (start(source.charCodeAt(index))) {
            const begin = index++;
            while (start(source.charCodeAt(index)) || digit(source.charCodeAt(index))) index++;
            const token = source.slice(begin, index);
            if (["R", "u8R", "uR", "UR", "LR"].includes(token) && source[index] === '"') {
                const opening = source.indexOf("(", index + 1);
                if (opening >= 0 && opening - index <= 17) {
                    const closing = `)${source.slice(index + 1, opening)}"`;
                    const end = source.indexOf(closing, opening + 1);
                    index = end < 0 ? source.length : end + closing.length;
                    continue;
                }
            }
            identifiers.add(token);
        } else if (digit(source.charCodeAt(index))) {
            // C++ numeric suffixes and digit separators belong to the literal.
            index++;
            while (start(source.charCodeAt(index)) || digit(source.charCodeAt(index)) ||
                source[index] === "." || source[index] === "'") index++;
        } else index++;
    }
    return identifiers;
}
