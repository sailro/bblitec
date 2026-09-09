/** Identifier tokens in emitted C++; comments and quoted payloads carry no reads. */
function* identifierTokens(source: string): Generator<{ name: string; start: number; end: number; qualified: boolean }> {
    const start = (code: number): boolean => code === 95 ||
        (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const digit = (code: number): boolean => code >= 48 && code <= 57;
    let index = 0;
    let qualified = false;
    while (index < source.length) {
        if (source.startsWith("//", index)) {
            const end = source.indexOf("\n", index + 2);
            index = end < 0 ? source.length : end + 1;
        } else if (source.startsWith("/*", index)) {
            const end = source.indexOf("*/", index + 2);
            index = end < 0 ? source.length : end + 2;
        } else if (source[index] === '"' || source[index] === "'") {
            qualified = false;
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
                    qualified = false;
                    continue;
                }
            }
            yield { name: token, start: begin, end: index, qualified };
            qualified = qualified && token === "template";
        } else if (digit(source.charCodeAt(index))) {
            qualified = false;
            // C++ numeric suffixes and digit separators belong to the literal.
            index++;
            while (start(source.charCodeAt(index)) || digit(source.charCodeAt(index)) ||
                source[index] === "." || source[index] === "'") index++;
        } else if (source.startsWith("->", index) || source.startsWith("::", index)) {
            qualified = true;
            index += 2;
        } else {
            if (!/\s/.test(source[index]!)) qualified = source[index] === ".";
            index++;
        }
    }
}

export function cppIdentifiers(source: string): ReadonlySet<string> {
    const names = new Set<string>();
    for (const token of identifierTokens(source)) names.add(token.name);
    return names;
}

/** Rename explicit bindings without touching comments, strings or numeric suffixes. */
export function renameCppIdentifiers(source: string, rename: (name: string, qualified: boolean) => string | undefined): string {
    const pieces: string[] = [];
    let offset = 0;
    for (const token of identifierTokens(source)) {
        const replacement = rename(token.name, token.qualified);
        if (replacement === undefined || replacement === token.name) continue;
        pieces.push(source.slice(offset, token.start), replacement);
        offset = token.end;
    }
    pieces.push(source.slice(offset));
    return pieces.join("");
}
