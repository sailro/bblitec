/**
 * An HTML page as Chromium's own parser (`DOMParser`) builds it: implied
 * elements, entity decoding, attribute casing and misnesting recovery are
 * the browser's, not a reimplementation. The walker emits the host UI node
 * shape with each element's namespace; comments are dropped.
 *
 * The bake is keyed on this module alone, so editing the page reader or
 * the compiler replays the parse.
 */
import {
    cachedBakeBatchSync,
    cachedBakeSync,
    moduleIdentity,
    type BakeKey,
} from "./bake-cache.js";
import { evaluateInSharedPage } from "./compiler/generation-child.js";

export interface HostPageElement {
    /** The local name, lower case for HTML elements. */
    tag: string;
    namespace: string;
    attributes?: Record<string, string>;
    children?: HostPageNode[];
}

export interface HostPageText {
    tag?: undefined;
    text: string;
}

export type HostPageNode = HostPageElement | HostPageText;

export interface HostPageDocument {
    /** `CSS1Compat` in standards mode, `BackCompat` in quirks mode. */
    compatMode: string;
    root: HostPageElement;
}

const walker = `(markup) => {
    const parsed = new DOMParser().parseFromString(markup, "text/html");
    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) return { text: node.data };
        if (node.nodeType !== Node.ELEMENT_NODE) return undefined;
        const element = { tag: node.localName, namespace: node.namespaceURI ?? "" };
        if (node.attributes.length > 0)
            element.attributes = Object.fromEntries(
                Array.from(node.attributes, (attribute) => [attribute.name, attribute.value]),
            );
        const children = Array.from(
            node.localName === "template" ? node.content.childNodes : node.childNodes,
            walk,
        ).filter((child) => child !== undefined);
        if (children.length > 0) element.children = children;
        return element;
    };
    return JSON.stringify({ compatMode: parsed.compatMode, root: walk(parsed.documentElement) });
}`;

function isHostPageDocument(value: unknown): value is HostPageDocument {
    return (
        typeof value === "object" &&
        value !== null &&
        "compatMode" in value &&
        "root" in value &&
        typeof value.root === "object" &&
        value.root !== null &&
        "tag" in value.root &&
        value.root.tag === "html"
    );
}

export interface HtmlFragmentComment {
    tag?: undefined;
    text?: undefined;
    comment: string;
}

export interface HtmlFragmentElement {
    /** The local name, lower case for HTML elements. */
    tag: string;
    namespace: string;
    /** In source order. */
    attributes?: Record<string, string>;
    children?: HtmlFragmentNode[];
}

/** An innerHTML fragment's node, comments included. */
export type HtmlFragmentNode =
    HtmlFragmentElement | HostPageText | HtmlFragmentComment;

// Each markup of a JSON list as its fragment's node list, in one page.
const fragmentWalker = `(input) => {
    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) return { text: node.data };
        if (node.nodeType === Node.COMMENT_NODE) return { comment: node.data };
        if (node.nodeType !== Node.ELEMENT_NODE) return undefined;
        const element = { tag: node.localName, namespace: node.namespaceURI ?? "" };
        if (node.attributes.length > 0)
            element.attributes = Object.fromEntries(
                Array.from(node.attributes, (attribute) => [attribute.name, attribute.value]),
            );
        const children = Array.from(
            node.localName === "template" ? node.content.childNodes : node.childNodes,
            walk,
        ).filter((child) => child !== undefined);
        if (children.length > 0) element.children = children;
        return element;
    };
    return JSON.stringify(
        JSON.parse(input).map((markup) => {
            const template = document.createElement("template");
            template.innerHTML = markup;
            return JSON.stringify(
                Array.from(template.content.childNodes, walk).filter((node) => node !== undefined),
            );
        }),
    );
}`;

const fragments = new Map<string, HtmlFragmentNode[]>();

function fragmentKey(markup: string): BakeKey {
    return {
        kind: "html-fragment",
        version: "1",
        module: moduleIdentity(import.meta.url),
        browser: true,
        parameters: {},
        inputs: [Buffer.from(markup, "utf8")],
    };
}

/**
 * Each `markup` parsed as innerHTML is (a template's contents, so an option
 * or a table part stands alone): the browser's tree, entity decoding,
 * implied end tags and attribute forms, with comments. The fragments the
 * memo and the bake cache lack parse together, in one Chromium page.
 */
export function parseHtmlFragments(
    markups: readonly string[],
): ReadonlyArray<readonly HtmlFragmentNode[]> {
    const unknown = [...new Set(markups)].filter(
        (markup) => !fragments.has(markup),
    );
    if (unknown.length) {
        const baked = cachedBakeBatchSync(
            unknown.map(fragmentKey),
            (missing) => {
                const parsed: unknown = JSON.parse(
                    evaluateInSharedPage({
                        label: "Reading static innerHTML",
                        serverName: "innerHTML parser server",
                        requirement:
                            "Reading static innerHTML requires Chromium.",
                        evaluate: fragmentWalker,
                        input: JSON.stringify(
                            missing.map((index) => unknown[index]!),
                        ),
                    }),
                );
                if (
                    !Array.isArray(parsed) ||
                    !parsed.every((item) => typeof item === "string")
                )
                    throw new Error(
                        "The innerHTML parser returned no fragment list.",
                    );
                return parsed.map((item) => Buffer.from(item, "utf8"));
            },
        );
        unknown.forEach((markup, index) => {
            const nodes: unknown = JSON.parse(
                Buffer.from(baked[index]!).toString("utf8"),
            );
            if (!Array.isArray(nodes) || !nodes.every(isHtmlFragmentNode))
                throw new Error("The innerHTML parser returned no node list.");
            fragments.set(markup, nodes);
        });
    }
    return markups.map((markup) => {
        const nodes = fragments.get(markup);
        if (!nodes) throw new Error("An innerHTML fragment was not parsed.");
        return nodes;
    });
}

/** `markup` parsed as innerHTML is (`parseHtmlFragments`). */
export function parseHtmlFragment(markup: string): readonly HtmlFragmentNode[] {
    const [nodes] = parseHtmlFragments([markup]);
    if (!nodes) throw new Error("An innerHTML fragment was not parsed.");
    return nodes;
}

function isHtmlFragmentNode(value: unknown): value is HtmlFragmentNode {
    if (typeof value !== "object" || value === null) return false;
    if ("text" in value) return typeof value.text === "string";
    if ("comment" in value) return typeof value.comment === "string";
    return (
        "tag" in value &&
        typeof value.tag === "string" &&
        "namespace" in value &&
        typeof value.namespace === "string" &&
        (!("attributes" in value) ||
            (typeof value.attributes === "object" &&
                value.attributes !== null &&
                Object.values(value.attributes).every(
                    (attribute) => typeof attribute === "string",
                ))) &&
        (!("children" in value) ||
            (Array.isArray(value.children) &&
                value.children.every(isHtmlFragmentNode)))
    );
}

/** Parse `html` with the generation's Chromium, replayed from the bake cache. */
export function parseHostPageMarkup(html: string): HostPageDocument {
    const bytes = cachedBakeSync(
        {
            kind: "host-page",
            version: "1",
            module: moduleIdentity(import.meta.url),
            browser: true,
            parameters: {},
            inputs: [Buffer.from(html, "utf8")],
        },
        () =>
            Buffer.from(
                evaluateInSharedPage({
                    label: "Reading an HTML host page",
                    serverName: "host page parser server",
                    requirement: "Reading an HTML host page requires Chromium.",
                    evaluate: walker,
                    input: html,
                }),
                "utf8",
            ),
    );
    const document: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!isHostPageDocument(document))
        throw new Error("The host page parser returned no document element.");
    return document;
}
