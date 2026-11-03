import { splitUiCssList, uiCssValueTokens } from "./ui-css-syntax.js";

// A length, a percentage, CSS math over them (the PAL folds it; ui-css-math.ts
// admits it), or a custom property the style engine substitutes first; a
// position may also be negative.
const amount = "(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:px|rem|em|vw|vh|%)";
const computed = "(?:calc|min|max|clamp|var)\\(.*\\)";
const length = new RegExp(`^(?:0|${amount}|${computed})$`, "i");
const offset = new RegExp(`^(?:-?0|-?${amount}|${computed})$`, "i");
const gradient = /^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i;
const boxes = new Set(["border-box", "padding-box", "content-box"]);

function position(
    tokens: readonly string[],
): readonly [string, string] | undefined {
    const horizontal: Readonly<Record<string, string>> = {
        left: "0%",
        center: "50%",
        right: "100%",
    };
    const vertical: Readonly<Record<string, string>> = {
        top: "0%",
        center: "50%",
        bottom: "100%",
    };
    if (tokens.length === 0) return ["0%", "0%"];
    if (tokens.length > 2) return undefined;
    let [x = "center", y = "center"] = tokens.map((token) =>
        token.toLowerCase(),
    );
    if (x === "top" || x === "bottom" || y === "left" || y === "right")
        [x, y] = [y, x];
    const axis = (value: string, keywords: Readonly<Record<string, string>>) =>
        Object.hasOwn(keywords, value)
            ? keywords[value]
            : offset.test(value)
              ? value
              : undefined;
    const px = axis(x, horizontal),
        py = axis(y, vertical);
    return px !== undefined && py !== undefined ? [px, py] : undefined;
}

/** A `background-image` list of gradient images, each its own layer. */
export function uiGradientImageList(value: string): boolean {
    return splitUiCssList(value).every((source) => {
        const values = uiCssValueTokens(source);
        return (
            values?.length === 1 &&
            gradient.test(values[0]!) &&
            values[0]!.endsWith(")")
        );
    });
}

/** Project gradient layers into RmlUi decorators, retaining each independent image box. */
export function uiGradientBackground(value: string): string | undefined {
    const layers: string[] = [];
    for (const source of splitUiCssList(value)) {
        const values = uiCssValueTokens(source, "/");
        const image = values?.shift();
        if (!values || !image || !gradient.test(image) || !image.endsWith(")"))
            return undefined;
        const tokens = values.map((token) => token.toLowerCase());
        if (!tokens.length) {
            layers.push(image);
            continue;
        }
        // Gradients without a specified size fill their positioning area. Sized
        // repetition needs tiling and is deliberately outside this projection.
        const repeats = tokens.filter((token) => token === "no-repeat");
        if (repeats.length !== 1) return undefined;
        tokens.splice(tokens.indexOf("no-repeat"), 1);
        // One box names the origin and the clip, two the origin then the
        // clip; without one the layer is placed in the padding box.
        const named = tokens.filter((token) => boxes.has(token));
        if (named.length > 2) return undefined;
        for (const box of named) tokens.splice(tokens.indexOf(box), 1);
        const origin = named[0] ?? "padding-box";
        const clip = named[1] ?? origin;
        const slash = tokens.indexOf("/");
        const at = position(slash < 0 ? tokens : tokens.slice(0, slash));
        const size = slash < 0 ? ["100%", "100%"] : tokens.slice(slash + 1);
        if (size.length === 1) size.push("auto");
        if (
            !at ||
            size.length !== 2 ||
            size.some((token) => token !== "auto" && !length.test(token))
        )
            return undefined;
        // The decorator paints in the clip box and places the layer in its
        // origin box (RmlUi patch 0025), named apart only when they differ.
        layers.push(
            `${image} ${clip} / ${size.map((token) => (token === "auto" ? "100%" : token)).join(" ")} / ${at.join(" ")}${origin === clip ? "" : ` / ${origin}`}`,
        );
    }
    return layers.length ? layers.join(",") : undefined;
}
