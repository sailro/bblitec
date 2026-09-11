/** The ordinary CSS filters implemented by the retained layer compositor. */
export function supportedUiFilter(value: string): boolean {
    const text = value.trim().toLowerCase();
    if (text === "none") return true;
    const scalar = "(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
    const length = `(?:[+-]?${scalar}px|[+-]?0)`;
    const channel = "\\d{1,3}";
    const alpha = "(?:0(?:\\.\\d*)?|1(?:\\.0*)?|\\.\\d+)";
    const color = `(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgb\\(\\s*${channel}\\s*,\\s*${channel}\\s*,\\s*${channel}\\s*\\)|rgba\\(\\s*${channel}\\s*,\\s*${channel}\\s*,\\s*${channel}\\s*,\\s*${alpha}\\s*\\)|black|silver|gr[ae]y|white|maroon|red|orange|purple|fuchsia|green|lime|olive|yellow|navy|blue|teal|aqua|transparent)`;
    const amount = new RegExp(`^${scalar}%?$`);
    const blur = new RegExp(`^(?:${scalar}px|0)$`);
    const angle = new RegExp(`^(?:[+-]?${scalar}(?:deg|rad)|0)$`);
    const shadow = new RegExp(`^(?:${color}\\s+${length}\\s+${length}(?:\\s+(?:${scalar}px|0))?|${length}\\s+${length}(?:\\s+(?:${scalar}px|0))?\\s+${color})$`);
    let cursor = 0, count = 0;
    while (cursor < text.length) {
        const start = /^\s*([a-z-]+)\(/.exec(text.slice(cursor));
        if (!start) return false;
        cursor += start[0].length;
        const body = cursor;
        let depth = 1;
        while (cursor < text.length && depth) {
            if (text[cursor] === "(") depth++;
            if (text[cursor] === ")") depth--;
            cursor++;
        }
        if (depth) return false;
        const argument = text.slice(body, cursor - 1).trim();
        if ([...argument.matchAll(/(?:\d+(?:\.\d*)?|\.\d+)/g)].some(match => !Number.isFinite(Math.fround(Number(match[0]))))) return false;
        switch (start[1]) {
            case "brightness": case "contrast": case "grayscale": case "invert":
            case "opacity": case "saturate": case "sepia":
                if (!amount.test(argument)) return false;
                break;
            case "hue-rotate": if (!angle.test(argument)) return false; break;
            case "blur": if (!blur.test(argument)) return false; break;
            case "drop-shadow":
                if (!shadow.test(argument)) return false;
                break;
            default: return false;
        }
        count++;
        if (cursor < text.length && !/\s/.test(text[cursor]!)) return false;
        while (/\s/.test(text[cursor] ?? "")) cursor++;
    }
    return count > 0;
}
