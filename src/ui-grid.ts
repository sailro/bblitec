import { splitUiCssList, uiCssValueTokens } from "./ui-css-syntax.js";

/** Native row-major, non-spanning track syntax, before density conversion. */
export function supportedUiGridTracks(value: string): boolean {
    if (value.trim().toLowerCase() === "none") return true;
    const number = "(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?";
    const length = new RegExp(`^(?:${number}px|0)$`);
    const fraction = new RegExp(`^${number}fr$`);
    const finite = (token: string): boolean =>
        Number.isFinite(parseFloat(token)) &&
        parseFloat(token) <= 3.4028234663852886e38;
    const countTracks = (
        source: string,
        repeated: boolean,
    ): number | undefined => {
        const tokens = uiCssValueTokens(source.trim().toLowerCase());
        if (!tokens?.length) return undefined;
        let count = 0;
        for (const token of tokens) {
            if (
                token === "auto" ||
                ((length.test(token) || fraction.test(token)) && finite(token))
            )
                count++;
            else if (token.startsWith("minmax(") && token.endsWith(")")) {
                const parts = splitUiCssList(token.slice(7, -1));
                if (
                    parts.length !== 2 ||
                    !(
                        parts[0] === "auto" ||
                        (length.test(parts[0]!) && finite(parts[0]!))
                    ) ||
                    !fraction.test(parts[1]!) ||
                    !finite(parts[1]!)
                )
                    return undefined;
                count++;
            } else if (
                !repeated &&
                token.startsWith("repeat(") &&
                token.endsWith(")")
            ) {
                const parts = splitUiCssList(token.slice(7, -1));
                if (parts.length !== 2 || !/^[1-9]\d*$/.test(parts[0]!))
                    return undefined;
                const repetitions = Number(parts[0]);
                if (repetitions > 256) return undefined;
                const pattern = countTracks(parts[1]!, true);
                if (pattern === undefined) return undefined;
                count += repetitions * pattern;
            } else return undefined;
            if (count > 256) return undefined;
        }
        return count;
    };
    return countTracks(value, false) !== undefined;
}
