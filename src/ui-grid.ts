import { splitUiCssList, uiCssValueTokens } from "./ui-css-syntax.js";

/** A grid line `<custom-ident>`, as the native placement parser reads it. */
function uiGridLineName(token: string): boolean {
    return (
        /^-?[_a-z\u{80}-\u{10ffff}][-_a-z0-9\u{80}-\u{10ffff}]*$/iu.test(
            token,
        ) &&
        !["auto", "span", "inherit", "initial", "unset", "default"].includes(
            token.toLowerCase(),
        )
    );
}

/** One grid line: auto, an area or line name, a nonzero line number or a positive span. */
function supportedUiGridLine(part: string): boolean {
    const token = part.trim();
    if (uiGridLineName(token)) return true;
    const lower = token.toLowerCase();
    if (lower === "auto") return true;
    const span = /^span\s+\+?([1-9]\d*)$/.exec(lower);
    if (span) return Number(span[1]) <= 256;
    return /^[+-]?[1-9]\d*$/.test(lower) && Math.abs(Number(lower)) <= 257;
}

/** Lines and spans share the same grammar on both grid axes. */
export function supportedUiGridPlacement(value: string): boolean {
    const parts = value.split("/");
    return parts.length <= 2 && parts.every(supportedUiGridLine);
}

/** `grid-area`: up to four slash-separated grid lines. */
export function supportedUiGridArea(value: string): boolean {
    const parts = value.split("/");
    return parts.length <= 4 && parts.every(supportedUiGridLine);
}

/**
 * `grid-template-areas`: none, or equal rows of strings whose named cells
 * form rectangles, within 256 tracks per axis (the native parser's grammar).
 */
export function supportedUiGridTemplateAreas(value: string): boolean {
    let source = value.trim();
    if (source.toLowerCase() === "none") return true;
    const rows: string[][] = [];
    while (source) {
        const row = /^(["'])(.*?)\1\s*/su.exec(source);
        if (!row) return false;
        source = source.slice(row[0].length);
        const cells = row[2]!.match(/\.+|[-_a-z0-9\u{80}-\u{10ffff}]+|\S/giu);
        if (
            !cells?.every((cell) =>
                /^(?:\.+|[-_a-z0-9\u{80}-\u{10ffff}]+)$/iu.test(cell),
            )
        )
            return false;
        rows.push(cells.map((cell) => (cell.startsWith(".") ? "" : cell)));
    }
    if (
        rows.length === 0 ||
        rows.length > 256 ||
        rows.some((cells) => cells.length !== rows[0]!.length) ||
        rows[0]!.length > 256
    )
        return false;
    const areas = new Map<
        string,
        {
            left: number;
            right: number;
            top: number;
            bottom: number;
            count: number;
        }
    >();
    rows.forEach((cells, y) =>
        cells.forEach((name, x) => {
            if (!name) return;
            const area = areas.get(name);
            if (area) {
                area.left = Math.min(area.left, x);
                area.right = Math.max(area.right, x);
                area.bottom = y;
                area.count++;
            } else
                areas.set(name, {
                    left: x,
                    right: x,
                    top: y,
                    bottom: y,
                    count: 1,
                });
        }),
    );
    for (const area of areas.values())
        if (
            (area.right - area.left + 1) * (area.bottom - area.top + 1) !==
            area.count
        )
            return false;
    return true;
}

/** The native parser enforces the same bounded finite/intrinsic track grammar. */
export function supportedUiGridTracks(
    value: string,
    implicit = false,
): boolean {
    if (value.trim().toLowerCase() === "none") return !implicit;
    const number = "(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?";
    const length = new RegExp(`^(?:${number}(?:px|em|rem|vw|vh)|0)$`);
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
