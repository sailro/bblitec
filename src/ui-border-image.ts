/** The bounded CSS border-image surface shared by inline and stylesheet declarations. */
interface UiBorderImage {
    readonly source: string;
    readonly slices: readonly string[];
    readonly widths: readonly string[];
}

function fourSides(
    value: string,
    accepts: RegExp,
): readonly string[] | undefined {
    const sides = value.trim().toLowerCase().split(/\s+/);
    if (
        sides.length > 4 ||
        sides.some((side) => {
            if (!accepts.test(side)) return true;
            if (side === "auto") return false;
            const number = Number.parseFloat(side),
                native = Math.fround(number);
            return !Number.isFinite(native) || (number !== 0 && native === 0);
        })
    )
        return undefined;
    return [
        sides[0]!,
        sides[1] ?? sides[0]!,
        sides[2] ?? sides[0]!,
        sides[3] ?? sides[1] ?? sides[0]!,
    ];
}

const number = "(?:\\d+(?:\\.\\d*)?|\\.\\d+)";

/** A static raster source, or null for `none`: no SVG, data URL, escapes or control bytes. */
function parseSource(value: string): string | null | undefined {
    const text = value.trim();
    if (/^none$/i.test(text)) return null;
    const match =
        /^url\(\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'()]+))\s*\)$/i.exec(
            text,
        );
    if (!match) return undefined;
    const source = match[1] ?? match[2] ?? match[3]!;
    // eslint-disable-next-line no-control-regex -- Reject control bytes in CSS image URLs.
    const invalidSource = /[\\\x00-\x1f]/;
    return invalidSource.test(source) ||
        /(?:\.svg(?:[?#]|$)|^data:)/i.test(source)
        ? undefined
        : source;
}

/** Non-negative slices without `fill`. */
const parseSlices = (value: string): readonly string[] | undefined =>
    fourSides(value, new RegExp(`^${number}%?$`));

/** Non-negative widths: px, percentages, multipliers and `auto`. */
const parseWidths = (value: string): readonly string[] | undefined =>
    fourSides(value, new RegExp(`^(?:${number}(?:px|%)?|auto)$`));

/** A zero length: no painted outset or outline. */
export const UI_ZERO_LENGTH = /^0(?:\.0*)?(?:px)?$/;

/** No painted outset. */
const zeroOutset = (value: string): boolean =>
    fourSides(value, UI_ZERO_LENGTH) !== undefined;

/** Stretching, the only repeat represented. */
const stretches = (value: string): boolean =>
    /^stretch(?:\s+stretch)?$/i.test(value.trim());

/** Stretching raster slices, with no center fill and no painted outset. */
export function parseUiBorderImage(
    value: string,
): UiBorderImage | "none" | undefined {
    const text = value.trim();
    if (/^none$/i.test(text)) return "none";
    const match =
        /^(url\(\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s"'()]+)\s*\))\s*(.*?)\s*$/i.exec(
            text,
        );
    if (!match) return undefined;
    const source = parseSource(match[1]!);
    if (source === undefined || source === null) return undefined;
    const components = match[2]!
        .replace(/\bstretch(?:\s+stretch)?\s*$/i, "")
        .trim()
        .split("/");
    if (
        components.length > 3 ||
        (components.length > 1 && !components.at(-1)?.trim())
    )
        return undefined;
    const slices = parseSlices(components[0]?.trim() || "100%");
    const widths = parseWidths(components[1]?.trim() || "1");
    const outset = components[2];
    if (!slices || !widths || (outset !== undefined && !zeroOutset(outset)))
        return undefined;
    return { source, slices, widths };
}

/** Canonical CSS consumed by the pinned native border-image implementation. */
export function renderUiBorderImage(
    image: UiBorderImage,
    packagedSource: string,
): string {
    return `url("${packagedSource}") ${image.slices.join(" ")} / ${image.widths.join(" ")} / 0 0 0 0 stretch`;
}

/** The longhands the native `border-image` shorthand sets, each in its canonical four-value form. */
export const UI_BORDER_IMAGE_LONGHANDS: ReadonlySet<string> = new Set([
    "border-image-source",
    "border-image-slice",
    "border-image-width",
    "border-image-outset",
    "border-image-repeat",
]);

/**
 * One longhand in the canonical form the native shorthand expands to, its
 * raster source through `packaged`; undefined outside the represented
 * surface (as the shorthand refuses it).
 */
export function renderUiBorderImageLonghand(
    property: string,
    value: string,
    packaged: (source: string) => string,
): string | undefined {
    switch (property) {
        case "border-image-source": {
            const source = parseSource(value);
            if (source === undefined) return undefined;
            return source === null ? "none" : `url("${packaged(source)}")`;
        }
        case "border-image-slice":
            return parseSlices(value)?.join(" ");
        case "border-image-width":
            return parseWidths(value)?.join(" ");
        case "border-image-outset":
            return zeroOutset(value) ? "0 0 0 0" : undefined;
        case "border-image-repeat":
            return stretches(value) ? "stretch" : undefined;
        default:
            return undefined;
    }
}
