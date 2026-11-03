/**
 * SVG presentation properties a stylesheet or style write may set: the PAL
 * resolves them through the retained cascade for each created SVG element
 * and serializes them for RmlUi's SVG plugin; other elements ignore them,
 * as a browser does.
 */
export const UI_SVG_PRESENTATION_PROPERTIES = [
    "fill",
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-opacity",
    "fill-opacity",
    "paint-order",
    "text-anchor",
];

// An rgb()/rgba() component as LunaSVG's colour parser reads one.
const component = String.raw`\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?%?\s*`;
const paint = new RegExp(
    String.raw`^(?:none|currentcolor|#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(${component}(?:,${component}){2,3}\)|[a-z]+)$`,
);
// CSS-wide keywords, which the PAL refuses as a paint.
const cssWide = new Set(["inherit", "initial", "unset", "revert"]);
// The keywords LunaSVG parses, which it compares exactly once trimmed.
const keywords: Readonly<Record<string, readonly string[]>> = {
    "stroke-linecap": ["butt", "round", "square"],
    "stroke-linejoin": ["miter", "round", "bevel"],
    "text-anchor": ["start", "middle", "end"],
};

/**
 * Whether `value` is an SVG paint the PAL draws (`ui_validate_svg_attribute`
 * in native/src/pal_ui_svg.hpp, then LunaSVG): none, currentColor, a hex
 * colour of 3, 4, 6 or 8 digits, one comma-separated rgb()/rgba() call or a
 * colour name, in any case.
 */
export function supportedUiSvgPaint(value: string): boolean {
    const text = value.trim().toLowerCase();
    return paint.test(text) && !cssWide.has(text);
}

/** Whether `value` is one of a keyword property's values; undefined for another property. */
export function supportedUiSvgKeyword(
    property: string,
    value: string,
): boolean | undefined {
    return keywords[property]?.includes(value.trim());
}

/** Whether `value` is a literal one of `property`'s values the PAL serializes. */
export function supportedUiSvgPresentation(
    property: string,
    value: string,
): boolean {
    const text = value.trim().toLowerCase();
    switch (property) {
        case "fill":
        case "stroke":
            return supportedUiSvgPaint(text);
        case "stroke-width":
            return /^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/.test(text);
        case "stroke-opacity":
        case "fill-opacity":
            return /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) && Number(text) <= 1;
        case "paint-order": {
            if (text === "normal") return true;
            const parts = text.split(/\s+/);
            return (
                parts.length <= 3 &&
                new Set(parts).size === parts.length &&
                parts.every((part) =>
                    ["fill", "stroke", "markers"].includes(part),
                )
            );
        }
        default:
            return supportedUiSvgKeyword(property, text) ?? false;
    }
}
