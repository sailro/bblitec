/** Locations outside CSS strings, escapes and comments, for block syntax walks. */
export function* uiCssSyntaxIndices(source: string, start = 0): Iterable<number> {
    let quote = "";
    for (let index = start; index < source.length; index++) {
        const token = source[index]!;
        if (token === "\\") { index++; continue; }
        if (quote) { if (token === quote) quote = ""; continue; }
        if (token === '"' || token === "'") { quote = token; continue; }
        if (token === "/" && source[index+1] === "*") {
            const end = source.indexOf("*/", index+2);
            if (end < 0) return;
            index = end+1;
            continue;
        }
        yield index;
    }
}

export function findUiCssSyntax(source: string, token: string, start = 0): number | undefined {
    for (const index of uiCssSyntaxIndices(source,start)) if (source[index] === token) return index;
    return undefined;
}

export function stripUiCssComments(source: string): string {
    let result = "", start = 0, quote = "";
    for (let index = 0; index < source.length; index++) {
        const token = source[index]!;
        if (token === "\\") { index++; continue; }
        if (quote) { if (token === quote) quote = ""; continue; }
        if (token === '"' || token === "'") quote = token;
        else if (token === "/" && source[index+1] === "*") {
            result += source.slice(start,index);
            const end = source.indexOf("*/",index+2);
            if (end < 0) return result;
            index = end+1;
            start = index+1;
        }
    }
    return result + source.slice(start);
}

/** Position just after the closing brace, or undefined for an incomplete block. */
export function uiCssBlockEnd(source: string, opening: number): number | undefined {
    let depth = 0;
    for (const index of uiCssSyntaxIndices(source,opening)) {
        if (source[index] === "{") depth++;
        else if (source[index] === "}" && --depth === 0) return index+1;
    }
    return undefined;
}

/** Commas inside quotes or nested functions/attributes do not split a CSS list. */
export function splitUiCssList(source: string): string[] {
    const result: string[] = [];
    let start = 0, depth = 0, quote = "";
    for (let index = 0; index < source.length; index++) {
        const token = source[index]!;
        if (token === "\\") { index++; continue; }
        if (quote) { if (token === quote) quote = ""; }
        else if (token === '"' || token === "'") quote = token;
        else if (token === "[" || token === "(") depth++;
        else if (token === "]" || token === ")") depth--;
        else if (token === "," && depth === 0) { result.push(source.slice(start,index).trim()); start = index + 1; }
    }
    result.push(source.slice(start).trim());
    return result;
}

/** Whitespace separates value tokens only outside balanced functions. */
export function uiCssValueTokens(source: string): string[] | undefined {
    const result: string[] = [];
    let start = 0, depth = 0;
    for (const index of uiCssSyntaxIndices(source)) {
        const token = source[index]!;
        if (token === "(") depth++;
        else if (token === ")" && --depth < 0) return undefined;
        else if (/\s/.test(token) && depth === 0) {
            if (index > start) result.push(source.slice(start,index));
            start = index + 1;
        }
    }
    if (depth) return undefined;
    if (start < source.length) result.push(source.slice(start));
    return result;
}
