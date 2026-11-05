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
const positionKeywords = new Set(["left", "center", "right", "top", "bottom"]);

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
    if (tokens.length === 0) return INITIAL_LAYER.position;
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

/**
 * One `background` layer's components, in any order (CSS Backgrounds 3
 * `<bg-layer>`/`<final-bg-layer>`); keywords lowercased, the image and the
 * colour as written.
 */
export interface UiBackgroundLayer {
    /** A gradient or `url()` image; absent for `none` or none written. */
    readonly image?: string;
    /** Whether the layer writes anything besides its image and colour. */
    readonly placed: boolean;
    /** The repeat keyword written, `repeat` by default. */
    readonly repeat: string;
    /** Whether the layer names a box; one names the origin and the clip, two the origin then the clip. */
    readonly boxed: boolean;
    readonly origin: string;
    readonly clip: string;
    readonly attachment: string;
    /** The position's x and y, keywords as percentages. */
    readonly position: readonly [string, string];
    /** `contain`, `cover` or two sizes (`auto`, a length or percentage). */
    readonly size: "contain" | "cover" | readonly [string, string];
    /** The one token no other component claims: a final layer's colour. */
    readonly color?: string;
}

/** A layer writing no component: each one's initial value. */
const INITIAL_LAYER: UiBackgroundLayer = {
    placed: false,
    repeat: "repeat",
    boxed: false,
    origin: "padding-box",
    clip: "border-box",
    attachment: "scroll",
    position: ["0%", "0%"],
    size: ["auto", "auto"],
};

/**
 * A layer's `background` longhands besides the colour, in shorthand order;
 * by default their initial values.
 */
export function uiBackgroundLonghands(
    layer: UiBackgroundLayer = INITIAL_LAYER,
): (readonly [string, string])[] {
    const size =
        typeof layer.size === "string"
            ? layer.size
            : layer.size.every((token) => token === "auto")
              ? "auto"
              : layer.size.join(" ");
    return [
        ["background-clip", layer.clip],
        ["background-image", layer.image ?? "none"],
        ["background-size", size],
        ["background-position", layer.position.join(" ")],
        ["background-repeat", layer.repeat],
        ["background-origin", layer.origin],
        ["background-attachment", layer.attachment],
    ];
}

/** A layer's components; undefined when a component repeats or misparses. */
export function uiBackgroundLayer(
    source: string,
): UiBackgroundLayer | undefined {
    const tokens = uiCssValueTokens(source, "/");
    if (!tokens) return undefined;
    let image: string | undefined;
    let color: string | undefined;
    let repeat: string | undefined;
    let attachment: string | undefined;
    let placement: string[] | undefined;
    let size: string[] | undefined;
    const named: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]!;
        const keyword = token.toLowerCase();
        if (
            (gradient.test(token) || /^url\(/i.test(token)) &&
            token.endsWith(")")
        ) {
            if (image !== undefined) return undefined;
            image = token;
        } else if (keyword === "none") {
            if (image !== undefined) return undefined;
            image = "";
        } else if (/^(?:(?:no-)?repeat(?:-[xy])?|space|round)$/.test(keyword)) {
            if (repeat !== undefined) return undefined;
            repeat = keyword;
        } else if (boxes.has(keyword)) named.push(keyword);
        else if (/^(?:scroll|fixed|local)$/.test(keyword)) {
            if (attachment !== undefined) return undefined;
            attachment = keyword;
        } else if (
            positionKeywords.has(keyword) ||
            offset.test(token) ||
            token === "/"
        ) {
            // A position is one run of its tokens, its size after a slash.
            if (placement !== undefined) return undefined;
            placement = [];
            while (
                index < tokens.length &&
                (positionKeywords.has(tokens[index]!.toLowerCase()) ||
                    offset.test(tokens[index]!))
            )
                placement.push(tokens[index++]!.toLowerCase());
            if (tokens[index] === "/") {
                size = [];
                while (
                    ++index < tokens.length &&
                    (/^(?:auto|contain|cover)$/i.test(tokens[index]!) ||
                        length.test(tokens[index]!))
                )
                    size.push(tokens[index]!.toLowerCase());
            }
            index--;
        } else {
            if (color !== undefined) return undefined;
            color = token;
        }
    }
    if (named.length > 2 || (size !== undefined && !placement?.length))
        return undefined;
    const at = position(placement ?? []);
    if (!at) return undefined;
    const origin = named[0] ?? INITIAL_LAYER.origin;
    let layerSize = INITIAL_LAYER.size;
    if (size !== undefined) {
        const [width, height = "auto", ...rest] = size;
        if (!width || rest.length) return undefined;
        if (width === "contain" || width === "cover") {
            if (size.length !== 1) return undefined;
            layerSize = width;
        } else if (height === "contain" || height === "cover") return undefined;
        else layerSize = [width, height];
    }
    return {
        ...(image ? { image } : {}),
        placed:
            placement !== undefined ||
            repeat !== undefined ||
            attachment !== undefined ||
            named.length > 0,
        repeat: repeat ?? INITIAL_LAYER.repeat,
        boxed: named.length > 0,
        origin,
        clip: named[1] ?? named[0] ?? INITIAL_LAYER.clip,
        attachment: attachment ?? INITIAL_LAYER.attachment,
        position: at,
        size: layerSize,
        ...(color !== undefined ? { color } : {}),
    };
}

/** Two values a layer's size (non-negative lengths) or position (offsets) takes. */
export function uiBackgroundPair(
    value: string,
    kind: "size" | "position",
): boolean {
    const tokens = uiCssValueTokens(value);
    return (
        tokens?.length === 2 &&
        tokens.every((token) => (kind === "size" ? length : offset).test(token))
    );
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
        const layer = uiBackgroundLayer(source);
        if (
            !layer?.image ||
            !gradient.test(layer.image) ||
            layer.color !== undefined ||
            layer.attachment !== "scroll"
        )
            return undefined;
        if (!layer.placed) {
            layers.push(layer.image);
            continue;
        }
        // A layer repeats unless no-repeat says otherwise: its decorator tiles
        // the paint box (RmlUi patch 0059). One-axis and spaced repetition
        // are not represented.
        if (layer.repeat !== "repeat" && layer.repeat !== "no-repeat")
            return undefined;
        // A gradient has no intrinsic size: an auto size is its box's.
        if (typeof layer.size === "string") return undefined;
        const size = layer.size.map((token) =>
            token === "auto" ? "100%" : token,
        );
        // The decorator paints in the clip box and places the layer in its
        // origin box (RmlUi patch 0025), named apart only when they differ;
        // a layer naming no box paints in its padding box.
        const clip = layer.boxed ? layer.clip : layer.origin;
        layers.push(
            `${layer.image} ${clip}${layer.repeat === "repeat" ? " repeat" : ""} / ${size.join(" ")} / ${layer.position.join(" ")}${layer.origin === clip ? "" : ` / ${layer.origin}`}`,
        );
    }
    return layers.length ? layers.join(",") : undefined;
}
