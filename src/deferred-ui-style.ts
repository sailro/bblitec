import {
    findUiCssSyntax,
    stripUiCssComments,
    uiCssBlockEnd,
} from "./ui-css-syntax.js";
import { supportedUiGridTracks } from "./ui-grid.js";

/** Missing projection contracts, admitted only at an explicit throwing operation. */
const properties = new Set([
    "aspect-ratio",
    "zoom",
    "columns",
    "column-count",
    "column-width",
    "column-fill",
    "column-span",
    "column-rule",
    "column-rule-color",
    "column-rule-style",
    "column-rule-width",
    "break-before",
    "break-after",
    "break-inside",
    "border-collapse",
    "border-spacing",
    "table-layout",
    "caption-side",
    "empty-cells",
    "grid-template-areas",
    "grid-area",
    "clip-path",
    "mask",
    "mask-image",
    "mask-size",
    "mask-position",
    "mask-repeat",
    "mask-mode",
    "mask-origin",
    "mask-clip",
    "mask-composite",
    "mix-blend-mode",
    "animation-delay",
    "animation-direction",
    "animation-fill-mode",
    "animation-play-state",
    "animation-timeline",
    "transition-delay",
    "scroll-behavior",
    "scroll-snap-type",
    "scroll-snap-align",
    "scroll-snap-stop",
    "scroll-padding",
    "scroll-padding-top",
    "scroll-padding-right",
    "scroll-padding-bottom",
    "scroll-padding-left",
    "accent-color",
    "text-indent",
]);

export function deferredUiStyleCapability(
    property: string,
    value: string | undefined,
): string | undefined {
    if (properties.has(property)) return `css:property:${property}`;
    if (value === undefined) return undefined;
    if (/^grid-(?:template|auto)-(?:columns|rows)$/.test(property)) {
        // Validate the surrounding grammar with the same track parser as strict
        // admission. Replacing a known missing unit/name must not admit malformed
        // function syntax or an unrelated unknown track token.
        let missing = false;
        const explicit = property.startsWith("grid-template-");
        let represented = stripUiCssComments(value).trim().toLowerCase();
        if (explicit)
            represented = represented.replace(
                /\[\s*[-_a-z][-_a-z0-9]*(?:\s+[-_a-z][-_a-z0-9]*)*\s*\]/g,
                () => {
                    missing = true;
                    return " ";
                },
            );
        if (explicit && represented.trim() === "subgrid")
            return `css:grid-tracks:${property}`;
        represented = represented.replace(
            /(?:\d+(?:\.\d*)?|\.\d+)(?:%|(?:em|rem|vw|vh)\b)/g,
            () => {
                missing = true;
                return "1px";
            },
        );
        if (missing && supportedUiGridTracks(represented, !explicit))
            return `css:grid-tracks:${property}`;
    }
    return undefined;
}

/** Visit declaration blocks without treating quoted braces or URLs as syntax. */
export function visitUiStyleSheetDeclarations(
    source: string,
    visit: (declarations: string) => void,
): void {
    const text = stripUiCssComments(source);
    let cursor = 0;
    while (cursor < text.length) {
        const opening = findUiCssSyntax(text, "{", cursor);
        if (opening === undefined) return;
        const end = uiCssBlockEnd(text, opening);
        if (end === undefined) return;
        const body = text.slice(opening + 1, end - 1);
        if (findUiCssSyntax(body, "{") === undefined) visit(body);
        else visitUiStyleSheetDeclarations(body, visit);
        cursor = end;
    }
}
