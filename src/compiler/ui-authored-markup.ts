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

const BOOLEAN_ATTRIBUTES = new Set([
    "hidden",
    "disabled",
    "checked",
    "selected",
]);

const INPUT_TYPES = new Set(["text", "password", "range", "checkbox", "color"]);

const ENTITIES: ReadonlyMap<string, string> = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", '"'],
    ["apos", "'"],
    ["nbsp", " "],
]);

/** Whether static markup creates a form control. */
export function createsFormControls(markup: string): boolean {
    return FORM_CONTROL.test(markup);
}

function decodeEntities(
    text: string,
    fail: (message: string) => never,
): string {
    return text.replace(
        /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g,
        (whole, name: string) => {
            if (name.startsWith("#")) {
                const code =
                    name[1] === "x" || name[1] === "X"
                        ? Number.parseInt(name.slice(2), 16)
                        : Number.parseInt(name.slice(1), 10);
                if (
                    code <= 0 ||
                    code > 0x10ffff ||
                    (code >= 0xd800 && code <= 0xdfff)
                )
                    fail(`has an invalid character reference '${whole}'.`);
                return String.fromCodePoint(code);
            }
            return (
                ENTITIES.get(name) ??
                fail(`has an unsupported entity '${whole}'.`)
            );
        },
    );
}

/**
 * The element and text tree of `markup`. Comments, other tags, implicit end
 * tags, unquoted or unreviewed attributes and file inputs refuse. Whitespace
 * between options is not retained: a select holds only its options.
 */
export function parseAuthoredMarkup(
    markup: string,
    fail: (message: string) => never,
): UiAuthoredMarkupNode[] {
    interface Open {
        tag: string;
        attributes: Array<{ name: string; value: string }>;
        children: UiAuthoredMarkupNode[];
    }
    const roots: UiAuthoredMarkupNode[] = [];
    const stack: Open[] = [];
    const children = (): UiAuthoredMarkupNode[] =>
        stack.at(-1)?.children ?? roots;
    let cursor = 0;
    while (cursor < markup.length) {
        const opening = markup.indexOf("<", cursor);
        const text = markup.slice(cursor, opening < 0 ? undefined : opening);
        if (text) {
            const parent = stack.at(-1)?.tag;
            const blank = text.trim().length === 0;
            if (parent === "select" && !blank)
                fail("has text inside <select>; it holds only options.");
            if (parent === "textarea")
                fail("textarea content is not represented; set its value.");
            if (parent !== "select")
                children().push({
                    kind: "text",
                    text: decodeEntities(text, fail),
                });
        }
        if (opening < 0) break;
        if (markup.startsWith("<!--", opening))
            fail(
                "with form controls has comments, which retained elements do not hold.",
            );
        let quote = "";
        let closing = opening + 1;
        for (; closing < markup.length; closing++) {
            const character = markup[closing]!;
            if (quote) {
                if (character === quote) quote = "";
            } else if (character === "'" || character === '"')
                quote = character;
            else if (character === ">") break;
        }
        if (closing >= markup.length) fail("contains an unterminated tag.");
        let token = markup.slice(opening + 1, closing).trim();
        cursor = closing + 1;
        if (token.startsWith("/")) {
            const tag = token.slice(1).trim().toLowerCase();
            const open = stack.pop();
            if (!open || open.tag !== tag)
                fail(`has mismatched closing tag '</${tag}>'.`);
            const element: UiAuthoredMarkupNode = {
                kind: "element",
                tag,
                attributes: open.attributes,
                children: open.children,
            };
            if (
                tag === "option" &&
                open.children.some((child) => child.kind !== "text")
            )
                fail("<option> holds only text.");
            children().push(element);
            continue;
        }
        const selfClosing = token.endsWith("/");
        if (selfClosing) token = token.slice(0, -1).trimEnd();
        const tagMatch =
            /^([A-Za-z][A-Za-z0-9-]*)/.exec(token) ??
            fail(`contains invalid tag '<${token}>'.`);
        const tag = tagMatch[1]!.toLowerCase();
        const allowed =
            TAG_ATTRIBUTES.get(tag) ??
            fail(
                `with form controls supports div, span, p, h1, h2, b, strong, label, button, input, select, option and textarea, not <${tag}>.`,
            );
        if (selfClosing && tag !== "input")
            fail(`<${tag}> must have an explicit closing tag.`);
        const attributes: Array<{ name: string; value: string }> = [];
        let rest = token.slice(tagMatch[0].length);
        while (rest.trim().length > 0) {
            rest = rest.trimStart();
            const attribute =
                /^([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*=\s*(["'])([\s\S]*?)\2|(?=\s|$))/.exec(
                    rest,
                ) ??
                fail(`tag '<${tag}>' has an invalid or unquoted attribute.`);
            rest = rest.slice(attribute[0].length);
            const name = attribute[1]!.toLowerCase();
            if (
                !GLOBAL_ATTRIBUTES.has(name) &&
                !allowed.has(name) &&
                !/^(?:aria|data)-[a-z][a-z0-9_.-]*$/.test(name)
            )
                fail(
                    `attribute '${attribute[1]}' is not supported on <${tag}>.`,
                );
            if (attribute[3] === undefined && !BOOLEAN_ATTRIBUTES.has(name))
                fail(`tag '<${tag}>' has an invalid or unquoted attribute.`);
            if (attributes.some((existing) => existing.name === name))
                fail(`attribute '${attribute[1]}' is duplicated on <${tag}>.`);
            const value = decodeEntities(attribute[3] ?? "", fail);
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
        if (tag === "input")
            children().push({ kind: "element", tag, attributes, children: [] });
        else stack.push({ tag, attributes, children: [] });
    }
    if (stack.length > 0)
        fail(`is missing closing tag '</${stack.at(-1)!.tag}>'.`);
    return roots;
}
