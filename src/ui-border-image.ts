/** The bounded CSS border-image surface shared by inline and stylesheet declarations. */
export interface UiBorderImage {
    readonly source: string;
    readonly slices: readonly string[];
    readonly widths: readonly string[];
}

function fourSides(value: string, accepts: RegExp): readonly string[] | undefined {
    const sides = value.trim().toLowerCase().split(/\s+/);
    if (sides.length > 4 || sides.some(side => {
        if (!accepts.test(side)) return true;
        if (side === "auto") return false;
        const number = Number.parseFloat(side), native = Math.fround(number);
        return !Number.isFinite(native) || (number !== 0 && native === 0);
    })) return undefined;
    return [sides[0]!, sides[1] ?? sides[0]!, sides[2] ?? sides[0]!, sides[3] ?? sides[1] ?? sides[0]!];
}

/** Stretching raster slices, with no center fill and no painted outset. */
export function parseUiBorderImage(value: string): UiBorderImage | "none" | undefined {
    const text = value.trim();
    if (/^none$/i.test(text)) return "none";
    const match = /^url\(\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'()]+))\s*\)\s*(.*?)\s*$/i.exec(text);
    if (!match) return undefined;
    const source = match[1] ?? match[2] ?? match[3]!;
    if (/[\\\x00-\x1f]/.test(source) || /(?:\.svg(?:[?#]|$)|^data:)/i.test(source)) return undefined;
    const components = match[4]!.replace(/\bstretch(?:\s+stretch)?\s*$/i, "").trim().split("/");
    if (components.length > 3 || (components.length > 1 && !components.at(-1)?.trim())) return undefined;
    const number = "(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
    const slices = fourSides(components[0]?.trim() || "100%", new RegExp(`^${number}%?$`));
    const widths = fourSides(components[1]?.trim() || "1", new RegExp(`^(?:${number}(?:px|%)?|auto)$`));
    const outset = components[2];
    if (!slices || !widths || (outset !== undefined && !fourSides(outset, /^0(?:\.0*)?(?:px)?$/))) return undefined;
    return { source, slices, widths };
}

/** Canonical CSS consumed by the pinned native border-image implementation. */
export function renderUiBorderImage(image: UiBorderImage, packagedSource: string): string {
    return `url("${packagedSource}") ${image.slices.join(" ")} / ${image.widths.join(" ")} / 0 0 0 0 stretch`;
}
