import {
    parseHtmlFragment,
    type HtmlFragmentNode,
} from "../host-page-parser.js";

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
        label: [],
        button: ["type", "disabled"],
        input: [
            "type",
            "name",
            "value",
            "min",
            "max",
            "step",
            "placeholder",
            "checked",
            "disabled",
        ],
        select: ["name", "disabled"],
        option: ["value", "selected", "disabled"],
        textarea: ["name", "placeholder", "rows", "cols", "disabled"],
    }).map(([tag, names]) => [tag, new Set(names)]),
);

const INPUT_TYPES = new Set(["text", "password", "range", "checkbox", "color"]);

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
    ): UiAuthoredMarkupNode[] => {
        const result: UiAuthoredMarkupNode[] = [];
        for (const node of nodes) {
            if ("comment" in node)
                fail(
                    "with form controls has comments, which retained elements do not hold.",
                );
            if (node.tag === undefined) {
                if (parent === "select" && node.text.trim().length > 0)
                    fail("has text inside <select>; it holds only options.");
                if (parent === "textarea")
                    fail("textarea content is not represented; set its value.");
                if (parent !== "select")
                    result.push({ kind: "text", text: node.text });
                continue;
            }
            const tag = node.tag;
            const allowed =
                (node.namespace === HTML_NAMESPACE
                    ? TAG_ATTRIBUTES.get(tag)
                    : undefined) ??
                fail(
                    `with form controls supports div, span, p, h1, h2, b, strong, label, button, input, select, option and textarea, not <${tag}>.`,
                );
            const attributes: Array<{ name: string; value: string }> = [];
            for (const [name, value] of Object.entries(node.attributes ?? {})) {
                if (
                    !GLOBAL_ATTRIBUTES.has(name) &&
                    !allowed.has(name) &&
                    !/^(?:aria|data)-[a-z][a-z0-9_.-]*$/.test(name)
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
                    tag === "input" &&
                    name === "type" &&
                    !INPUT_TYPES.has(value.toLowerCase())
                )
                    fail(
                        `<input> type '${value}' is not represented; text, password, range, checkbox and color inputs are supported.`,
                    );
                attributes.push({
                    name,
                    value: name === "type" ? value.toLowerCase() : value,
                });
            }
            const children = convert(node.children ?? [], tag);
            if (
                tag === "option" &&
                children.some((child) => child.kind !== "text")
            )
                fail("<option> holds only text.");
            result.push({ kind: "element", tag, attributes, children });
        }
        return result;
    };
    return convert(parseHtmlFragment(markup), undefined);
}
