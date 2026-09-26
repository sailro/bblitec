/** The bounded raster-background surface represented by the RmlUi PAL. */
export function supportedUiImageBackground(property: string, value: string): boolean | undefined {
    const keyword = value.trim().toLowerCase();
    if (property === "background-image")
        return /^(?:none|inherit|url\(\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s()]+)\s*\))$/i.test(value.trim());
    if (property === "background-size")
        return /^(?:inherit|auto|contain|cover|0(?:px)?\s+0(?:px)?)$/.test(keyword);
    if (property === "background-position")
        return /^(?:inherit|center(?:\s+center)?|0%\s+0%)$/.test(keyword);
    if (property === "background-repeat")
        return /^(?:inherit|repeat|no-repeat)$/.test(keyword);
    if (property === "background-origin")
        return /^(?:inherit|padding-box)$/.test(keyword);
    if (property === "background-attachment")
        return /^(?:inherit|scroll)$/.test(keyword);
    return undefined;
}

export function uiBackgroundImageSource(value: string): string | undefined {
    const match = value.trim().match(/^url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s()]+))\s*\)$/i);
    return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function nativeUiImageProperty(property: string): string {
    if (supportedUiImageBackground(property, "inherit") !== undefined || property === "background-color")
        return `--bbl-${property}`;
    return property === "transform" ? "bbl-transform" : property;
}
