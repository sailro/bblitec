import {
    uiBackgroundPair,
    uiGradientImageList,
} from "./ui-gradient-background.js";

/**
 * The CSS-wide keyword `value` is, lowercased. The PAL resolves it on every
 * background longhand (`pal_ui_background.hpp` `ui_css_wide_keyword`).
 */
export function cssWideKeyword(value: string): string | undefined {
    const keyword = value.trim().toLowerCase();
    return keyword === "inherit" || keyword === "initial" || keyword === "unset"
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
            /^(?:auto|contain|cover|0(?:px)?\s+0(?:px)?)$/.test(keyword) ||
            uiBackgroundPair(value, "size")
        );
    if (property === "background-position")
        return (
            wide ||
            /^(?:center(?:\s+center)?|0%\s+0%)$/.test(keyword) ||
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
 * The PAL property a background longhand declaration writes: the image
 * longhands and the colour are always the PAL's, the clip when its value is a
 * CSS-wide keyword RmlUi cannot parse.
 */
export function nativeUiImageProperty(
    property: string,
    value?: string,
): string {
    if (
        supportedUiImageBackground(property, "inherit") !== undefined ||
        property === "background-color" ||
        (property === "background-clip" &&
            value !== undefined &&
            cssWideKeyword(value) !== undefined)
    )
        return `--bbl-${property}`;
    return property === "transform" ? "bbl-transform" : property;
}
