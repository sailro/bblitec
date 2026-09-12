const UI_GENERATED_PARTS = {before:"Before", after:"After", placeholder:"Placeholder"} as const;
export type UiGeneratedPart = keyof typeof UI_GENERATED_PARTS;
export function isUiGeneratedPart(value: unknown): value is UiGeneratedPart {
    return typeof value === "string" && Object.hasOwn(UI_GENERATED_PARTS,value);
}
export interface UiContentPart { kind: "text" | "attribute"; value: string; }
export interface UiGeneratedContent { enabled: boolean; parts: UiContentPart[]; }

/** The represented content list: CSS strings and current attribute text. */
export function parseUiGeneratedContent(source: string): UiGeneratedContent | undefined {
    let rest = source.trim();
    if (/^(none|normal)$/i.test(rest)) return {enabled:false, parts:[]};
    const parts: UiContentPart[] = [];
    while (rest) {
        const attribute = /^attr\(\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\)/i.exec(rest);
        if (attribute) {
            parts.push({kind:"attribute", value:attribute[1]!.toLowerCase()});
            rest = rest.slice(attribute[0].length).trimStart();
            continue;
        }
        const quote = rest[0];
        if (quote !== '"' && quote !== "'") return undefined;
        let value = "", cursor = 1;
        for (; cursor < rest.length && rest[cursor] !== quote; cursor++) {
            const token = rest[cursor]!;
            if (token === "\r" || token === "\n" || token === "\f") return undefined;
            if (token !== "\\") { value += token === "\u0000" ? "\ufffd" : token; continue; }
            cursor++;
            if (cursor >= rest.length) return undefined;
            const hex = /^[0-9a-f]{1,6}/i.exec(rest.slice(cursor));
            if (hex) {
                const code = Number.parseInt(hex[0],16);
                value += String.fromCodePoint(code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code);
                cursor += hex[0].length;
                if (rest[cursor] === "\r" && rest[cursor+1] === "\n") cursor++;
                if (!/[\t\n\r\f ]/.test(rest[cursor] ?? "")) cursor--;
            } else if (rest[cursor] === "\r" && rest[cursor+1] === "\n") cursor++;
            else if (rest[cursor] !== "\n" && rest[cursor] !== "\r" && rest[cursor] !== "\f") value += rest[cursor];
        }
        if (rest[cursor] !== quote) return undefined;
        parts.push({kind:"text", value});
        rest = rest.slice(cursor+1).trimStart();
    }
    return parts.length ? {enabled:true,parts} : undefined;
}

export function uiGeneratedContentCpp(content: UiGeneratedContent | undefined, quote: (value: string) => string): string {
    if (!content) return "std::nullopt";
    return `bbl::UiGeneratedContent{${content.enabled}, {${content.parts.map(part =>
        `{bbl::UiContentPartKind::${part.kind === "text" ? "Text" : "Attribute"}, ${quote(part.value)}}`).join(", ")}}}`;
}

export function uiGeneratedPartCpp(part: UiGeneratedPart | undefined): string {
    return part === undefined ? "None" : UI_GENERATED_PARTS[part];
}
