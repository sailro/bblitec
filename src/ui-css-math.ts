import {
    splitUiCssList,
    uiCssFunctionEnd,
    uiCssSyntaxIndices,
} from "./ui-css-syntax.js";

/** Units the native PAL resolves in CSS math (UiLengthMath, native/src/pal_ui_length_math.hpp). */
const mathUnits = new Set([
    "px",
    "dp",
    "rem",
    "s",
    "ms",
    "deg",
    "rad",
    "turn",
    "grad",
    ...["vw", "vh", "vmin", "vmax"].flatMap((unit) => [
        unit,
        `s${unit}`,
        `l${unit}`,
        `d${unit}`,
    ]),
]);

/**
 * The properties whose percentages the native layout resolves inside CSS
 * math (`css_layout_percentage_property` in pal_ui_length_math.hpp).
 */
export const CSS_LAYOUT_PERCENTAGE_PROPERTIES: ReadonlySet<string> = new Set([
    "width",
    "height",
    "min-width",
    "max-width",
    "min-height",
    "max-height",
    "margin",
    "margin-top",
    "margin-right",
    "margin-bottom",
    "margin-left",
    "padding",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "top",
    "right",
    "bottom",
    "left",
    "flex",
    "flex-basis",
    "gap",
    "row-gap",
    "column-gap",
]);

/**
 * The `env()` variables the native host defines: the window's safe-area
 * insets (`rml_css_environment` in pal_ui_length_math.hpp).
 */
export const UI_SAFE_AREA_ENVIRONMENT: ReadonlySet<string> = new Set([
    "safe-area-inset-top",
    "safe-area-inset-right",
    "safe-area-inset-bottom",
    "safe-area-inset-left",
]);

type Dimension = "number" | "length" | "time" | "angle" | "unknown";

/** What the native math knows of a term: its dimension, and whether it holds a percentage or bounds one. */
interface Term {
    readonly dimension: Dimension;
    readonly percentage: boolean;
    readonly bounded: boolean;
}

class Refusal extends Error {}

/**
 * The shape of one CSS math expression as UiLengthMath folds it: a
 * percentage of a layout length stays a term the layout resolves, with
 * lengths added and at most one min()/max()/clamp() level bounding it;
 * `var()` holds what its substitution puts there.
 */
class MathShape {
    private offset = 0;

    constructor(
        private readonly source: string,
        private readonly percentages: boolean,
    ) {}

    public read(): void {
        this.atom();
    }

    private refuse(reason: string): never {
        throw new Refusal(reason);
    }

    private space(): void {
        while (/\s/.test(this.source[this.offset] ?? "")) this.offset++;
    }

    private take(token: string): boolean {
        this.space();
        if (this.source[this.offset] !== token) return false;
        this.offset++;
        return true;
    }

    private same(left: Term, right: Term): boolean {
        return (
            left.dimension === right.dimension ||
            left.dimension === "unknown" ||
            right.dimension === "unknown"
        );
    }

    private atom(): Term {
        this.space();
        if (this.take("(")) {
            const value = this.sum();
            if (!this.take(")")) this.refuse("an unclosed group");
            return value;
        }
        if (this.take("+") || this.take("-")) return this.atom();
        const name = /^[a-z-]+(?=\()/.exec(this.source.slice(this.offset))?.[0];
        if (name !== undefined) {
            this.offset += name.length + 1;
            // Substituted before the PAL folds, by what its property holds.
            if (name === "var") {
                this.offset = uiCssFunctionEnd(this.source, this.offset - 1);
                return {
                    dimension: "unknown",
                    percentage: false,
                    bounded: false,
                };
            }
            // Substituted before the PAL folds, by a safe-area inset's px
            // length or else its fallback (`rml_css_environment`).
            if (name === "env") {
                const start = this.offset;
                this.offset = uiCssFunctionEnd(this.source, this.offset - 1);
                const [variable, ...fallback] = splitUiCssList(
                    this.source.slice(start, this.offset - 1),
                );
                const inset = UI_SAFE_AREA_ENVIRONMENT.has(variable!);
                if (!inset && fallback.length === 0)
                    this.refuse(
                        "an env() variable the native host does not define, without a fallback",
                    );
                return {
                    dimension: inset ? "length" : "unknown",
                    percentage: false,
                    bounded: false,
                };
            }
            if (!["calc", "min", "max", "clamp"].includes(name))
                this.refuse(`'${name}()'`);
            const terms = [this.sum()];
            while (this.take(",")) terms.push(this.sum());
            if (!this.take(")")) this.refuse(`an unclosed ${name}()`);
            if (name === "calc") {
                if (terms.length !== 1) this.refuse("calc() of several terms");
                return terms[0]!;
            }
            if (name === "clamp" && terms.length !== 3)
                this.refuse("clamp() without three terms");
            if (
                terms.some(
                    (term) => term.bounded || !this.same(term, terms[0]!),
                )
            )
                this.refuse(`${name}() over bounded or mixed terms`);
            const relative = terms.filter((term) => term.percentage).length;
            const fixed = terms.length - relative > 0 ? 1 : 0;
            if (relative === 0)
                return { ...terms[0]!, percentage: false, bounded: false };
            if (name !== "clamp" && relative + fixed > 2)
                this.refuse(
                    `${name}() of more than two percentage-bearing terms`,
                );
            return {
                dimension: "length",
                percentage: true,
                bounded: name === "clamp" || relative + fixed > 1,
            };
        }
        const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(
            this.source.slice(this.offset),
        )?.[0];
        if (number === undefined) this.refuse("a token that is not a number");
        this.offset += number.length;
        if (this.source[this.offset] === "%") {
            this.offset++;
            if (!this.percentages)
                this.refuse("a percentage outside a layout length");
            return { dimension: "length", percentage: true, bounded: false };
        }
        const unit = /^[a-z]*/i.exec(this.source.slice(this.offset))![0];
        this.offset += unit.length;
        const lower = unit.toLowerCase();
        if (lower === "")
            return { dimension: "number", percentage: false, bounded: false };
        if (!mathUnits.has(lower)) this.refuse(`'${unit}'`);
        const dimension: Dimension = ["s", "ms"].includes(lower)
            ? "time"
            : ["deg", "rad", "turn", "grad"].includes(lower)
              ? "angle"
              : "length";
        return { dimension, percentage: false, bounded: false };
    }

    private product(): Term {
        let value = this.atom();
        for (;;) {
            const multiply = this.take("*");
            if (!multiply && !this.take("/")) return value;
            const other = this.atom();
            if (
                multiply
                    ? value.dimension !== "number" &&
                      other.dimension !== "number" &&
                      value.dimension !== "unknown" &&
                      other.dimension !== "unknown"
                    : other.dimension !== "number" &&
                      other.dimension !== "unknown"
            )
                this.refuse("a product of two dimensions");
            value = value.dimension === "number" ? other : value;
        }
    }

    private sum(): Term {
        let value = this.product();
        for (;;) {
            if (!this.take("+") && !this.take("-")) return value;
            const other = this.product();
            if (!this.same(value, other) || (value.bounded && other.bounded))
                this.refuse("a sum of mixed or doubly bounded terms");
            value = {
                dimension:
                    value.dimension === "unknown"
                        ? other.dimension
                        : value.dimension,
                percentage: value.percentage || other.percentage,
                bounded: value.bounded || other.bounded,
            };
        }
    }
}

/** The parenthesis depth at `end`, outside strings, escapes and comments. */
function depthAt(source: string, end: number): number {
    let depth = 0;
    for (const index of uiCssSyntaxIndices(source)) {
        if (index >= end) break;
        if (source[index] === "(") depth++;
        else if (source[index] === ")") depth--;
    }
    return depth;
}

/**
 * Why the native PAL cannot fold a CSS math expression in `value` for
 * `property`, or undefined: units it does not resolve, a percentage outside
 * a layout length, or percentage terms nested past one min()/max()/clamp()
 * level. A custom property keeps a percentage for the length its
 * substitution lands in, as the PAL leaves it.
 */
export function uiCssMathRefusal(
    property: string,
    value: string,
): string | undefined {
    const custom = property.startsWith("--");
    // Gradient layers lower to decorators whose own math sizes and places
    // the layer box; math inside a gradient function is the image's.
    const layers =
        property === "background" &&
        /(?:linear|radial|conic)-gradient\(/i.test(value);
    let read = 0;
    for (const match of value.matchAll(
        /(?<![\w-])(?:calc|min|max|clamp)\(/gi,
    )) {
        // A nested function is read with the one around it.
        if (match.index < read) continue;
        const end = uiCssFunctionEnd(value, match.index + match[0].length - 1);
        read = end;
        const body = value.slice(match.index, end).toLowerCase();
        if (property === "clip-path" || (custom && body.includes("%")))
            continue;
        try {
            new MathShape(
                body,
                CSS_LAYOUT_PERCENTAGE_PROPERTIES.has(property) ||
                    (layers && depthAt(value, match.index) === 0),
            ).read();
        } catch (error) {
            if (error instanceof Refusal) return error.message;
            throw error;
        }
        if (
            /\d(?:\.\d*)?rem\b/.test(body) &&
            (custom || property === "font" || property === "font-size")
        )
            return "root-relative math in font sizing or a custom property";
    }
    return undefined;
}
