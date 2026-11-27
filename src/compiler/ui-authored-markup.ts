import {
    parseHtmlFragment,
    type HtmlFragmentNode,
} from "../host-page-parser.js";

/**
 * An author's `aria-*` or `data-*` attribute: metadata without rendering
 * semantics, on any element. `data-bbl-*` names are the projection's own.
 */
export function isUiMetadataAttribute(name: string): boolean {
    return (
        /^(?:aria|data)-[a-z][a-z0-9_.-]*$/.test(name) &&
        !name.startsWith("data-bbl-")
    );
}

/**
 * Static innerHTML that creates form controls. The controls own browser state
 * (value, checkedness, selectedness, listeners), which retained elements hold
 * and projected RML does not, so this markup is parsed at generation into the
 * element tree createElement would build.
 */
export type UiAuthoredMarkupNode =
    | { readonly kind: "text"; readonly text: string }
    | {
          readonly kind: "element";
          readonly tag: string;
          /** An SVG element, created as createElementNS creates it. */
          readonly svg?: true;
          readonly attributes: ReadonlyArray<{
              readonly name: string;
              readonly value: string;
          }>;
          readonly children: readonly UiAuthoredMarkupNode[];
      };

const FORM_CONTROL = /<\s*(?:input|select|option|textarea)[\s/>]/i;

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

const FORM_CONTROLS = new Set(["input", "select", "option", "textarea"]);

const GLOBAL_ATTRIBUTES = new Set(["class", "id", "style", "role", "hidden"]);

const TAG_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map(
    Object.entries({
        div: [],
        span: [],
        p: [],
        h1: [],
        h2: [],
        b: [],
        strong: [],
        // A label activates the control its `for` names, as `htmlFor` does.
        label: ["for"],
        nav: [],
        // A link's activation navigates this browsing context only.
        a: ["href", "target"],
        form: [],
        output: ["name", "for"],
        button: ["type", "disabled"],
        input: [
            "type",
            "name",
            "value",
            "min",
            "max",
            "step",
            "placeholder",
            "maxlength",
            "checked",
            "disabled",
        ],
        select: ["name", "disabled"],
        option: ["value", "selected", "disabled"],
        textarea: [
            "name",
            "placeholder",
            "rows",
            "cols",
            "maxlength",
            "disabled",
        ],
    }).map(([tag, names]) => [tag, new Set(names)]),
);

/** The input types a retained native control represents (a file input aside). */
export const RETAINED_INPUT_TYPES: ReadonlySet<string> = new Set([
    "text",
    "search",
    "password",
    "range",
    "checkbox",
    "color",
]);

/**
 * The admitted input types that block implicit submission: Enter in one
 * submits the form holding it, and a native form never submits.
 */
const IMPLICIT_SUBMISSION_TYPES = new Set(["text", "search", "password"]);

/** Whether static markup creates a form control. */
export function createsFormControls(markup: string): boolean {
    if (!FORM_CONTROL.test(markup)) return false;
    const creates = (node: HtmlFragmentNode): boolean =>
        node.tag !== undefined &&
        ((node.namespace === HTML_NAMESPACE && FORM_CONTROLS.has(node.tag)) ||
            (node.children ?? []).some(creates));
    return parseHtmlFragment(markup).some(creates);
}

/**
 * Whether a text node under `parent` is retained: a select holds only its
 * options, so whitespace between them is dropped and other text refuses.
 */
export function retainsText(
    parent: string | undefined,
    text: string,
    fail: (message: string) => never,
): boolean {
    if (parent !== "select") return true;
    if (text.trim().length > 0)
        fail("has text inside <select>; it holds only options.");
    return false;
}

/**
 * The element and text tree the browser parses `markup` into. Comments,
 * other tags, unreviewed attributes and file inputs refuse. Whitespace
 * between options is not retained: a select holds only its options.
 */
export function parseAuthoredMarkup(
    markup: string,
    fail: (message: string) => never,
): UiAuthoredMarkupNode[] {
    const convert = (
        nodes: readonly HtmlFragmentNode[],
        parent: string | undefined,
        inForm: boolean,
    ): UiAuthoredMarkupNode[] => {
        const result: UiAuthoredMarkupNode[] = [];
        for (const node of nodes) {
            if ("comment" in node)
                fail(
                    "with form controls has comments, which retained elements do not hold.",
                );
            if (node.tag === undefined) {
                if (parent === "textarea")
                    fail("textarea content is not represented; set its value.");
                if (retainsText(parent, node.text, fail))
                    result.push({ kind: "text", text: node.text });
                continue;
            }
            const tag = node.tag;
            const allowed =
                (node.namespace === HTML_NAMESPACE
                    ? TAG_ATTRIBUTES.get(tag)
                    : undefined) ??
                fail(
                    `with form controls supports div, span, p, h1, h2, b, strong, label, nav, a, form, output, button, input, select, option and textarea, not <${tag}>.`,
                );
            const attributes: Array<{ name: string; value: string }> = [];
            for (const [name, value] of Object.entries(node.attributes ?? {})) {
                if (
                    !GLOBAL_ATTRIBUTES.has(name) &&
                    !allowed.has(name) &&
                    !isUiMetadataAttribute(name)
                )
                    fail(`attribute '${name}' is not supported on <${tag}>.`);
                if (name === "class")
                    for (const className of value.split(/\s+/).filter(Boolean))
                        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(className))
                            fail(`class '${className}' is not valid.`);
                if (
                    tag === "button" &&
                    name === "type" &&
                    value.toLowerCase() !== "button"
                )
                    fail("<button> supports only type='button'.");
                if (
                    tag === "a" &&
                    name === "target" &&
                    !["", "_self", "_parent", "_top"].includes(
                        value.toLowerCase(),
                    )
                )
                    fail(
                        `<a> target '${value}' opens another browsing context, which the native window does not have.`,
                    );
                if (
                    tag === "input" &&
                    name === "type" &&
                    !RETAINED_INPUT_TYPES.has(value.toLowerCase())
                )
                    fail(
                        `<input> type '${value}' is not represented; text, search, password, range, checkbox and color inputs are supported.`,
                    );
                attributes.push({
                    name,
                    value: name === "type" ? value.toLowerCase() : value,
                });
            }
            if (
                inForm &&
                tag === "input" &&
                IMPLICIT_SUBMISSION_TYPES.has(
                    (node.attributes?.type ?? "text").toLowerCase(),
                )
            )
                fail(
                    "has a <form> holding a text, search or password <input>, whose Enter submits it; native forms never submit.",
                );
            const children = convert(
                node.children ?? [],
                tag,
                inForm || tag === "form",
            );
            if (
                tag === "option" &&
                children.some((child) => child.kind !== "text")
            )
                fail("<option> holds only text.");
            result.push({ kind: "element", tag, attributes, children });
        }
        return result;
    };
    return convert(parseHtmlFragment(markup), undefined, false);
}

/** The SVG elements retained SVG holds: its root, shapes, texts and images. */
export const RETAINED_SVG_TAGS: ReadonlySet<string> = new Set([
    "svg",
    "path",
    "rect",
    "circle",
    "line",
    "ellipse",
    "polyline",
    "polygon",
    "text",
    "textPath",
    "image",
]);

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * The document an SVG element's innerHTML parses in: the markup inside an
 * `<svg>`, which Chromium parses in that element's context. Content that
 * breaks out of it (an HTML element) becomes the svg's sibling.
 */
export function svgContentDocument(markup: string): string {
    return `<svg>${markup}</svg>`;
}

/**
 * Markup assigned to an SVG element's innerHTML: the retained SVG children
 * createElementNS and setAttribute would build, whose attributes the
 * retained SVG checks as it does theirs. Whitespace between shapes renders
 * nothing and is not retained; other text belongs to a text.
 */
export function parseAuthoredSvgMarkup(
    markup: string,
    fail: (message: string) => never,
): UiAuthoredMarkupNode[] {
    const parsed = parseHtmlFragment(svgContentDocument(markup));
    const root = parsed.length === 1 ? parsed[0] : undefined;
    if (
        root === undefined ||
        !("namespace" in root) ||
        root.namespace !== SVG_NAMESPACE
    )
        fail("on an SVG element holds HTML content, which retained SVG lacks.");
    const convert = (
        nodes: readonly HtmlFragmentNode[],
        parent: string | undefined,
    ): UiAuthoredMarkupNode[] => {
        const result: UiAuthoredMarkupNode[] = [];
        const inText = parent === "text" || parent === "textPath";
        for (const node of nodes) {
            if ("comment" in node)
                fail(
                    "on an SVG element has comments, which retained elements do not hold.",
                );
            if (node.tag === undefined) {
                if (inText) result.push({ kind: "text", text: node.text });
                else if (node.text.trim().length > 0)
                    fail("on an SVG element has text outside a <text>.");
                continue;
            }
            if (node.tag === "svg" || !RETAINED_SVG_TAGS.has(node.tag))
                fail(
                    `tag '<${node.tag}>' is outside the retained SVG shape, text and image subset.`,
                );
            result.push({
                kind: "element",
                tag: node.tag,
                svg: true,
                attributes: Object.entries(node.attributes ?? {}).map(
                    ([name, value]) => ({ name, value }),
                ),
                children: convert(node.children ?? [], node.tag),
            });
        }
        return result;
    };
    return convert(root.children ?? [], undefined);
}
