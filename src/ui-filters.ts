import { splitUiCssList, uiCssValueTokens } from "./ui-css-syntax.js";

/** The ordinary CSS filters implemented by the retained layer compositor. */
export function supportedUiFilter(value: string): boolean {
    const text = value.trim().toLowerCase();
    if (text === "none") return true;
    const scalar = "(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
    const length = `(?:[+-]?${scalar}px|[+-]?0)`;
    const channel = "\\d{1,3}";
    const alpha = "(?:0(?:\\.\\d*)?|1(?:\\.0*)?|\\.\\d+)";
    const color = `(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|rgb\\(\\s*${channel}\\s*,\\s*${channel}\\s*,\\s*${channel}\\s*\\)|rgba\\(\\s*${channel}\\s*,\\s*${channel}\\s*,\\s*${channel}\\s*,\\s*${alpha}\\s*\\)|black|silver|gr[ae]y|white|maroon|red|orange|purple|fuchsia|green|lime|olive|yellow|navy|blue|teal|aqua|transparent|currentcolor)`;
    const amount = new RegExp(`^${scalar}%?$`);
    const blur = new RegExp(`^(?:${scalar}px|0)$`);
    const angle = new RegExp(`^(?:[+-]?${scalar}(?:deg|rad)|0)$`);
    const shadow = new RegExp(
        `^(?:${color}\\s+${length}\\s+${length}(?:\\s+(?:${scalar}px|0))?|${length}\\s+${length}(?:\\s+(?:${scalar}px|0))?(?:\\s+${color})?)$`,
    );
    let cursor = 0,
        count = 0;
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
        const rawArgument = text.slice(body, cursor - 1).trim();
        // Variables resolve in RmlUi's cascade. Math is checked again with its
        // actual dimensions and values by the native filter adapter.
        const argument = filterMathShape(
            rawArgument,
            start[1] !== "drop-shadow",
        );
        if (argument === undefined) return false;
        if (
            [...argument.matchAll(/(?:\d+(?:\.\d*)?|\.\d+)/g)].some(
                (match) => !Number.isFinite(Math.fround(Number(match[0]))),
            )
        )
            return false;
        switch (start[1]) {
            case "brightness":
            case "contrast":
            case "grayscale":
            case "invert":
            case "opacity":
            case "saturate":
            case "sepia":
                if (!amount.test(argument)) return false;
                break;
            case "hue-rotate":
                if (!angle.test(argument)) return false;
                break;
            case "blur":
                if (!blur.test(argument)) return false;
                break;
            case "drop-shadow":
                if (!shadow.test(argument)) return false;
                break;
            default:
                return false;
        }
        count++;
        if (cursor < text.length && !/\s/.test(text[cursor]!)) return false;
        while (/\s/.test(text[cursor] ?? "")) cursor++;
    }
    return count > 0;
}

/** Preserve the surrounding filter grammar while admitting bounded deferred arithmetic. */
function filterMathShape(
    value: string,
    standaloneVariable: boolean,
): string | undefined {
    let result = "";
    for (let index = 0; index < value.length;) {
        const start = /^(calc|min|max|clamp|var)\(/.exec(value.slice(index));
        if (!start) {
            result += value[index++];
            continue;
        }
        // Shadow variables can carry colors already projected by the general
        // cascade. Only math operands have an unambiguous scalar/length contract.
        if (start[1] === "var" && !standaloneVariable) return undefined;
        let end = index + start[0].length,
            depth = 1;
        for (; end < value.length && depth; end++) {
            if (value[end] === "(") depth++;
            if (value[end] === ")") depth--;
        }
        if (depth) return undefined;
        const expression = value.slice(index, end);
        const withoutVariables = expression.replace(/--[a-z0-9_-]+/gi, "0");
        if (
            /[^\d\s.()+*/,e+-]/i.test(
                withoutVariables.replace(
                    /(?:\b(?:calc|min|max|clamp|var)\b|px\b)/g,
                    "",
                ),
            )
        )
            return undefined;
        result += /\d\s*px\b/.test(expression) ? "1px" : "0";
        index = end;
    }
    return result;
}

/** Literal pixel shadows share filter colors and keep each layer's source order. */
export function supportedUiBoxShadow(value: string): boolean {
    const text = value.trim().toLowerCase();
    if (text === "none") return true;
    const shadowColor = (token: string): boolean => {
        if (token === "currentcolor" || /^[-+.\d]/.test(token)) return false;
        if (!token.startsWith("var(") || !token.endsWith(")"))
            return (
                !/\b(?:calc|min|max|clamp)\(/.test(token) &&
                supportedUiFilter(`drop-shadow(0 0 ${token})`)
            );
        const parts = splitUiCssList(token.slice(4, -1));
        return (
            /^--[a-z0-9_-]+$/i.test(parts[0] ?? "") &&
            parts.length <= 2 &&
            (parts.length === 1 || shadowColor(parts[1]!))
        );
    };
    return splitUiCssList(text).every((shadow) => {
        const tokens = uiCssValueTokens(shadow);
        if (!tokens) return false;
        const lengths: number[] = [];
        let inset = false,
            color = false,
            endedLengths = false;
        for (const token of tokens) {
            if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)px$|^[+-]?0$/.test(token)) {
                if (endedLengths) return false;
                const number = Number.parseFloat(token);
                if (!Number.isFinite(Math.fround(number))) return false;
                lengths.push(number);
            } else {
                if (lengths.length) endedLengths = true;
                if (token === "inset" && !inset) inset = true;
                else if (!color && shadowColor(token)) color = true;
                else return false;
            }
        }
        return (
            color &&
            lengths.length >= 2 &&
            lengths.length <= 4 &&
            (lengths[2] ?? 0) >= 0
        );
    });
}
