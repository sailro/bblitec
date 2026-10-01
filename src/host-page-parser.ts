/**
 * An HTML page as Chromium's own parser (`DOMParser`) builds it: implied
 * elements, entity decoding, attribute casing and misnesting recovery are
 * the browser's, not a reimplementation. The walker emits the host UI node
 * shape with each element's namespace; comments are dropped.
 *
 * The bake is keyed on this module alone, so editing the page reader or
 * the compiler replays the parse.
 */
import { cachedBakeSync, moduleIdentity } from "./bake-cache.js";
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
