import {
    uiBackgroundPair,
    uiGradientImageList,
} from "./ui-gradient-background.js";

/**
 * The CSS-wide keyword `value` is, lowercased, revert-layer as revert (no
 * cascade layers). RmlUi's cascade resolves it on every property (patch 0066
 * `PropertySpecification::ParseCssWideKeyword`).
 */
export function cssWideKeyword(value: string): string | undefined {
    const keyword = value.trim().toLowerCase();
    if (keyword === "revert-layer") return "revert";
    return keyword === "inherit" ||
        keyword === "initial" ||
        keyword === "unset" ||
        keyword === "revert"
        ? keyword
        : undefined;
}

/** The bounded image-background surface represented by the RmlUi PAL. */
export function supportedUiImageBackground(
    property: string,
    value: string,
): boolean | undefined {
    const keyword = value.trim().toLowerCase();
    const wide = cssWideKeyword(value) !== undefined;
    if (property === "background-image")
        return (
            wide ||
            /^(?:none|url\(\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s()]+)\s*\))$/i.test(
                value.trim(),
            ) ||
            uiGradientImageList(value)
        );
    // An explicit size is a decorator layer with its own box, placed at two
    // offsets (RmlUi patch 0025).
    if (property === "background-size")
        return (
            wide ||
            /^(?:auto|contain|cover)$/.test(keyword) ||
            uiBackgroundPair(value, "size")
        );
    if (property === "background-position")
        return (
            wide ||
            /^center(?:\s+center)?$/.test(keyword) ||
            uiBackgroundPair(value, "position")
        );
    if (property === "background-repeat")
        return wide || /^(?:repeat|no-repeat)$/.test(keyword);
    if (property === "background-origin")
        return wide || keyword === "padding-box";
    if (property === "background-attachment")
        return wide || keyword === "scroll";
    return undefined;
}

export function uiBackgroundImageSource(value: string): string | undefined {
    const match = value
        .trim()
        .match(/^url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s()]+))\s*\)$/i);
    return match?.[1] ?? match?.[2] ?? match?.[3];
}

/**
 * The native property a declaration writes: the image longhands are the
 * PAL's registered `bbl-` ones, which it paints as a decorator.
 */
export function nativeUiImageProperty(property: string): string {
    if (supportedUiImageBackground(property, "inherit") !== undefined)
        return `bbl-${property}`;
    return property === "transform" ? "bbl-transform" : property;
}
