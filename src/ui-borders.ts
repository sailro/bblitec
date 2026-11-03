import { uiCssValueTokens } from "./ui-css-syntax.js";

/** The border line styles the retained layer draws. */
export const UI_BORDER_STYLES = ["none", "hidden", "solid", "dashed"];

/** The shorthands whose value is one border line (`uiBorderLine`). */
export const UI_BORDER_LINE_PROPERTIES = [
    "border",
    "border-top",
    "border-right",
    "border-bottom",
    "border-left",
];

/** Every CSS line style, so that one is never read as a color. */
const lineStyles = new Set([
    ...UI_BORDER_STYLES,
    "dotted",
    "double",
    "groove",
    "ridge",
    "inset",
    "outset",
]);
const width = /^(?:0|\d+(?:\.\d+)?(?:px|em|rem))$/;
const color = /^(?:#[0-9a-f]{3,8}|rgba?\([^;]+\)|var\(--[a-z0-9_-]+\)|[a-z]+)$/;

/**
 * A `border` or `border-<side>` value as RmlUi's shorthand reads it: width,
 * style and color in that order. As the CSS shorthand does, an omitted width
 * is `medium` and an omitted style `none`; undefined when the value is
 * outside literal widths, the drawn styles and literal or variable colors.
 */
export function uiBorderLine(value: string): string | undefined {
    const tokens = uiCssValueTokens(value.trim());
    if (!tokens?.length || tokens.length > 3) return undefined;
    let lineWidth: string | undefined,
        lineStyle: string | undefined,
        lineColor: string | undefined;
    for (const token of tokens) {
        // Keywords compare case-insensitively; a variable name does not.
        const keyword = token.toLowerCase();
        if (lineStyles.has(keyword) && !UI_BORDER_STYLES.includes(keyword))
            return undefined;
        if (width.test(keyword) && lineWidth === undefined) lineWidth = keyword;
        else if (UI_BORDER_STYLES.includes(keyword) && lineStyle === undefined)
            lineStyle = keyword;
        else if (color.test(keyword) && lineColor === undefined)
            lineColor = token;
        else return undefined;
    }
    return [lineWidth ?? "3px", lineStyle ?? "none", lineColor]
        .filter((part) => part !== undefined)
        .join(" ");
}
