import { splitUiCssList, uiCssValueTokens } from "./ui-css-syntax.js";

/** Numeric lines and spans share the same grammar on both grid axes. */
export function supportedUiGridPlacement(value: string): boolean {
    const parts = value.trim().toLowerCase().split("/");
    if (parts.length > 2) return false;
    return parts.every((part) => {
        const token = part.trim();
        if (token === "auto") return true;
        const span = /^span\s+\+?([1-9]\d*)$/.exec(token);
        if (span) return Number(span[1]) <= 256;
        return /^[+-]?[1-9]\d*$/.test(token) && Math.abs(Number(token)) <= 257;
    });
}

/** The native parser enforces the same bounded finite/intrinsic track grammar. */
export function supportedUiGridTracks(
    value: string,
    implicit = false,
): boolean {
    if (value.trim().toLowerCase() === "none") return !implicit;
    const number = "(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?";
    const length = new RegExp(`^(?:${number}px|0)$`);
    const fraction = new RegExp(`^${number}fr$`);
    const finite = (token: string): boolean =>
        Number.isFinite(parseFloat(token)) &&
        parseFloat(token) <= 3.4028234663852886e38;
    const fixed = (token: string): boolean =>
        length.test(token) && finite(token);
    const flexible = (token: string): boolean =>
        fraction.test(token) && finite(token);
    let automaticRepeat = false;
    const tracks = (
        source: string,
        repeated: boolean,
    ): boolean[] | undefined => {
        const tokens = uiCssValueTokens(source.trim().toLowerCase());
        if (!tokens?.length) return undefined;
        const result: boolean[] = [];
        for (const token of tokens) {
            if (token === "auto" || flexible(token)) result.push(false);
            else if (fixed(token)) result.push(true);
            else if (token.startsWith("minmax(") && token.endsWith(")")) {
                const parts = splitUiCssList(token.slice(7, -1));
                if (
                    parts.length !== 2 ||
                    !(parts[0] === "auto" || fixed(parts[0]!)) ||
                    !(
                        parts[1] === "auto" ||
                        fixed(parts[1]!) ||
                        flexible(parts[1]!)
                    )
                )
                    return undefined;
                result.push(fixed(parts[0]!) || fixed(parts[1]!));
            } else if (
                !implicit &&
                !repeated &&
                token.startsWith("repeat(") &&
                token.endsWith(")")
            ) {
                const parts = splitUiCssList(token.slice(7, -1));
                if (parts.length !== 2) return undefined;
                const automatic =
                    parts[0] === "auto-fit" || parts[0] === "auto-fill";
                if (automatic ? automaticRepeat : !/^[1-9]\d*$/.test(parts[0]!))
                    return undefined;
                if (automatic) automaticRepeat = true;
                const count = automatic ? 1 : Number(parts[0]);
                if (count > 256) return undefined;
                const pattern = tracks(parts[1]!, true);
                if (!pattern || result.length + pattern.length * count > 256)
                    return undefined;
                for (let i = 0; i < count; ++i) result.push(...pattern);
            } else return undefined;
            if (result.length > 256) return undefined;
        }
        return result;
    };
    const result = tracks(value, false);
    return !!result && (!automaticRepeat || result.every(Boolean));
}
