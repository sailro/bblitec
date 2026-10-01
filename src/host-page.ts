/**
 * An HTML page as a program's host: the module its module script evaluates,
 * and the markup, attributes and `<style>` sheets around it as the native
 * host UI model (`NativeHostUi`), which the reviewed `ui/*.json` companions
 * also describe.
 *
 * The page is parsed by Chromium's own HTML parser (`DOMParser`), so the tree
 * is the one a browser builds: implied elements, entity decoding, attribute
 * casing and misnesting recovery are the parser's, not a reimplementation.
 * The compiler walk is synchronous, so the parse crosses a generation child
 * like the other Chromium bakes and replays from the bake cache.
 *
 * What the host model cannot represent refuses here, naming the page:
 * classic and data scripts, inline event handlers, external style sheets,
 * foreign (SVG/MathML) markup and head metadata with a rendering effect.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { cachedBakeSync, moduleIdentity } from "./bake-cache.js";
import type {
    CompileOptions,
    NativeHostUi,
    NativeHostUiElement,
    NativeHostUiNode,
    PageLoaderModule,
} from "./compiler/types.js";
import { runGenerationChild } from "./compiler/generation-child.js";

export interface HostPageElement {
    kind: "element";
    /** The element's local name, lower case for HTML elements. */
    tag: string;
    namespace: string;
    attributes: [name: string, value: string][];
    children: HostPageNode[];
}

export interface HostPageText {
    kind: "text";
    text: string;
}

export type HostPageNode = HostPageElement | HostPageText;

/** The tree Chromium's HTML parser builds; comments are dropped. */
export interface HostPageDocument {
    /** `CSS1Compat` for a standards-mode page, `BackCompat` for quirks. */
    compatMode: string;
    root: HostPageElement;
}

export interface HostPage {
    /** The page as given. */
    path: string;
    title?: string;
    /** The module the page's module script evaluates. */
    entry: string;
    /** Root-relative module specifiers resolve beneath the page directory. */
    moduleRoot: string;
    /** The inline module script, when it does more than import the entry. */
    loader?: PageLoaderModule;
    hostUi: NativeHostUi;
}

const xhtml = "http://www.w3.org/1999/xhtml";

/**
 * Markup the host model has no representation for. A `<style>` or
 * `<script>` element is consumed by the page reader itself.
 */
const unrepresentedElements: ReadonlyMap<string, string> = new Map([
    ["template", "template contents are inert document fragments"],
    ["noscript", "scripting is enabled, so its content never renders"],
    ["iframe", "nested browsing contexts have no native host"],
    ["frame", "nested browsing contexts have no native host"],
    ["frameset", "nested browsing contexts have no native host"],
    ["object", "plugin content has no native host"],
    ["embed", "plugin content has no native host"],
    ["slot", "shadow trees are not represented"],
    ["link", "external resources are not read"],
    ["meta", "body metadata is not represented"],
    ["base", "a document base URL is not represented"],
]);

/**
 * Head links with no native effect: browser icons and fetch hints, as a
 * native program packages its resources. A style sheet is not one.
 */
const inertLinkRelations: ReadonlySet<string> = new Set([
    "icon",
    "apple-touch-icon",
    "preload",
    "modulepreload",
    "prefetch",
    "preconnect",
    "dns-prefetch",
]);

function isWhitespace(text: string): boolean {
    return /^[\t\n\f\r ]*$/.test(text);
}

function attribute(element: HostPageElement, name: string): string | undefined {
    return element.attributes.find(([candidate]) => candidate === name)?.[1];
}

/** An element's start tag, for a refusal to name it by. */
function spelled(element: HostPageElement): string {
    return `<${[
        element.tag,
        ...element.attributes.map(([name, value]) => `${name}="${value}"`),
    ].join(" ")}>`;
}

function textContent(element: HostPageElement): string {
    return element.children
        .map((child) =>
            child.kind === "text" ? child.text : textContent(child),
        )
        .join("");
}

/** The JSON a generation child returned, checked node by node. */
function hostPageNode(value: unknown): HostPageNode {
    if (typeof value !== "object" || value === null)
        throw new Error("The host page parser returned a malformed node.");
    if ("kind" in value && value.kind === "text") {
        if (!("text" in value) || typeof value.text !== "string")
            throw new Error("The host page parser returned a malformed text.");
        return { kind: "text", text: value.text };
    }
    if (
        !("kind" in value) ||
        value.kind !== "element" ||
        !("tag" in value) ||
        typeof value.tag !== "string" ||
        !("namespace" in value) ||
        typeof value.namespace !== "string" ||
        !("attributes" in value) ||
        !Array.isArray(value.attributes) ||
        !("children" in value) ||
        !Array.isArray(value.children)
    )
        throw new Error("The host page parser returned a malformed element.");
    return {
        kind: "element",
        tag: value.tag,
        namespace: value.namespace,
        attributes: value.attributes.map((entry: unknown) => {
            if (
                !Array.isArray(entry) ||
                entry.length !== 2 ||
                typeof entry[0] !== "string" ||
                typeof entry[1] !== "string"
            )
                throw new Error(
                    "The host page parser returned a malformed attribute.",
                );
            return [entry[0], entry[1]];
        }),
        children: value.children.map(hostPageNode),
    };
}

/**
 * Parse `html` with Chromium's `DOMParser`. The runner is injectable so the
 * page model is testable without a browser launch.
 */
export function parseHostPageMarkup(
    html: string,
    run: (html: string) => string = runHostPageParserInChromium,
): HostPageDocument {
    const bytes = cachedBakeSync(
        {
            kind: "host-page",
            version: "1",
            module: moduleIdentity(import.meta.url),
            browser: true,
            parameters: {},
            inputs: [Buffer.from(html, "utf8")],
        },
        () => Buffer.from(run(html), "utf8"),
    );
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (
        typeof value !== "object" ||
        value === null ||
        !("compatMode" in value) ||
        typeof value.compatMode !== "string" ||
        !("root" in value)
    )
        throw new Error("The host page parser returned a malformed document.");
    const root = hostPageNode(value.root);
    if (root.kind !== "element")
        throw new Error("The host page parser returned no document element.");
    return { compatMode: value.compatMode, root };
}

/** Run `DOMParser` in the generation's Chromium and return the tree as JSON. */
function runHostPageParserInChromium(html: string): string {
    const harnessModule = new URL("./browser-harness.js", import.meta.url).href;
    const script = `
        import { createServer } from "node:http";
        import { withBrowserPage } from ${JSON.stringify(harnessModule)};
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const html = Buffer.concat(chunks).toString("utf8");
        const server = createServer((_request, response) => {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end("<!doctype html><title>Host page parser</title>");
        });
        const value = await withBrowserPage(
            server,
            {
                serverName: "host page parser server",
                shared: true,
                browserRequirement: "Reading an HTML host page requires Chromium.",
            },
            async (page) =>
                page.evaluate((markup) => {
                    const parsed = new DOMParser().parseFromString(markup, "text/html");
                    const walk = (node) => {
                        if (node.nodeType === Node.TEXT_NODE)
                            return { kind: "text", text: node.data };
                        if (node.nodeType !== Node.ELEMENT_NODE) return undefined;
                        const children =
                            node.localName === "template" ? node.content.childNodes : node.childNodes;
                        return {
                            kind: "element",
                            tag: node.localName,
                            namespace: node.namespaceURI ?? "",
                            attributes: Array.from(node.attributes, (entry) => [entry.name, entry.value]),
                            children: Array.from(children, walk).filter((child) => child !== undefined),
                        };
                    };
                    return JSON.stringify({
                        compatMode: parsed.compatMode,
                        root: walk(parsed.documentElement),
                    });
                }, html),
        );
        process.stdout.write(Buffer.from(value, "utf8").toString("base64"));
    `;
    const stdout = runGenerationChild({
        script,
        label: "Reading an HTML host page",
        input: html,
    });
    return Buffer.from(stdout, "base64").toString("utf8");
}

/**
 * The module a page specifier names. A `src` attribute is a URL relative to
 * the page; an import specifier must be relative or root-relative, as a bare
 * one names a package. Root-relative paths resolve beneath the page
 * directory, which is the bundler root the page is served from.
 */
function pageModulePath(
    specifier: string,
    pageDirectory: string,
    form: "src" | "import",
    fail: (message: string) => never,
): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith("//"))
        fail(`loads module '${specifier}' from another origin.`);
    if (/[?#]/.test(specifier))
        fail(`module '${specifier}' carries a query or fragment.`);
    if (
        form === "import" &&
        !specifier.startsWith("/") &&
        !specifier.startsWith("./") &&
        !specifier.startsWith("../")
    )
        fail(`imports bare specifier '${specifier}', which names a package.`);
    const path = resolve(
        pageDirectory,
        specifier.startsWith("/") ? `.${specifier}` : specifier,
    );
    if (!existsSync(path))
        fail(
            `module '${specifier}' resolves to '${path}', which does not exist.`,
        );
    return path;
}

/** Every module an inline module script imports, by specifier. */
function inlineScriptImports(source: ts.SourceFile): {
    declarations: string[];
    calls: string[];
} {
    const declarations: string[] = [];
    const calls: string[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier)
        )
            declarations.push(node.moduleSpecifier.text);
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
            const [specifier] = node.arguments;
            calls.push(
                node.arguments.length === 1 &&
                    specifier &&
                    ts.isStringLiteralLike(specifier)
                    ? specifier.text
                    : "",
            );
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return { declarations, calls };
}

/** The entry the page's module script names, with its loader when inline. */
function pageEntry(
    script: HostPageElement,
    page: { path: string; html: string },
    pageDirectory: string,
    fail: (message: string) => never,
): { entry: string; loader?: PageLoaderModule } {
    for (const [name] of script.attributes)
        if (name !== "type" && name !== "src")
            fail(`module script attribute '${name}' is not represented.`);
    const src = attribute(script, "src");
    const inline = textContent(script);
    if (src !== undefined) {
        if (!isWhitespace(inline))
            fail("module script has both a src attribute and inline text.");
        return { entry: pageModulePath(src, pageDirectory, "src", fail) };
    }
    // Line numbers in the inline script follow the page's own lines.
    const html = page.html.replace(/\r\n?/g, "\n");
    const offset = html.indexOf(inline);
    const precedingLines =
        offset < 0 ? 0 : html.slice(0, offset).split("\n").length - 1;
    const fileName = `${resolve(page.path)}.inline-module.ts`;
    const source = "\n".repeat(precedingLines) + inline;
    const parsed = ts.createSourceFile(
        fileName,
        source,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TS,
    );
    const imports = inlineScriptImports(parsed);
    const specifiers = new Set([...imports.declarations, ...imports.calls]);
    const [specifier] = specifiers;
    if (specifiers.size !== 1 || !specifier)
        return fail(
            "inline module script must import exactly one module, by a string literal.",
        );
    const entry = pageModulePath(specifier, pageDirectory, "import", fail);
    if (imports.calls.length === 0) {
        if (
            !parsed.statements.every(
                (statement) =>
                    ts.isImportDeclaration(statement) &&
                    statement.importClause === undefined,
            )
        )
            fail(
                "inline module script runs statements after importing its entry; only a dynamic import() can precede them.",
            );
        return { entry };
    }
    if (imports.declarations.length > 0 || imports.calls.length > 1)
        fail(
            "inline module script must import its entry once, statically or dynamically.",
        );
    return { entry, loader: { fileName, source, specifier } };
}

/** The page's host model and entry, from the tree Chromium parsed. */
export function hostPageFromDocument(
    document: HostPageDocument,
    page: { path: string; html: string },
): HostPage {
    const fail = (message: string): never => {
        throw new Error(`Host page '${page.path}' ${message}`);
    };
    // Unrepresented constructs are listed together in one refusal.
    const refusals: string[] = [];
    const refuse = (message: string): void => {
        refusals.push(message);
    };
    if (document.compatMode !== "CSS1Compat")
        fail(
            "renders in quirks mode; the native layout represents standards mode (<!doctype html>) only.",
        );
    const pageDirectory = dirname(resolve(page.path));
    const html = document.root;
    const head = html.children.find(
        (child): child is HostPageElement =>
            child.kind === "element" && child.tag === "head",
    );
    const body = html.children.find(
        (child): child is HostPageElement =>
            child.kind === "element" && child.tag === "body",
    );
    if (!head || !body) return fail("has no head or body element.");

    const styleSheets: string[] = [];
    const scripts: HostPageElement[] = [];
    let title: string | undefined;

    const readStyle = (element: HostPageElement): void => {
        for (const [name, value] of element.attributes)
            if (name !== "type" || !/^(?:text\/css)?$/i.test(value))
                refuse(`<style ${name}="${value}"> is not represented.`);
        styleSheets.push(textContent(element));
    };

    for (const child of head.children) {
        if (child.kind === "text") {
            if (!isWhitespace(child.text)) refuse("has text in its head.");
            continue;
        }
        if (child.tag === "style") readStyle(child);
        else if (child.tag === "script") scripts.push(child);
        else if (child.tag === "title") title = textContent(child).trim();
        else if (child.tag === "meta") {
            const charset = attribute(child, "charset");
            const name = attribute(child, "name");
            const content = attribute(child, "content") ?? "";
            if (
                child.attributes.length === 1 &&
                charset?.toLowerCase() === "utf-8"
            )
                continue;
            // The native window is the whole layout viewport at scale one.
            if (
                child.attributes.length === 2 &&
                name === "viewport" &&
                content
                    .split(",")
                    .map((entry) => entry.trim().replace(/\s*=\s*/, "="))
                    .every((entry) =>
                        /^(?:width=device-width|initial-scale=1(?:\.0*)?|viewport-fit=(?:auto|cover))$/.test(
                            entry,
                        ),
                    )
            )
                continue;
            // Browser chrome and search metadata; the light scheme is the
            // native controls' own.
            if (
                child.attributes.length === 2 &&
                (name === "theme-color" ||
                    name === "description" ||
                    (name === "color-scheme" &&
                        /^(?:light|normal)$/.test(content.trim())))
            )
                continue;
            refuse(`head metadata ${spelled(child)} is not represented.`);
        } else if (
            child.tag === "link" &&
            (attribute(child, "rel") ?? "")
                .split(/\s+/)
                .every((rel) => inertLinkRelations.has(rel.toLowerCase()))
        )
            continue;
        else refuse(`head element ${spelled(child)} is not represented.`);
    }

    const inlineHandlers = (element: HostPageElement): boolean => {
        const handlers = element.attributes.filter(([name]) =>
            /^on/i.test(name),
        );
        for (const [name] of handlers)
            refuse(
                `<${element.tag} ${name}> is an inline event handler; scripts other than the entry are not compiled.`,
            );
        return handlers.length > 0;
    };
    const hostNodes = (
        nodes: readonly HostPageNode[],
        within: string,
    ): NativeHostUiNode[] =>
        nodes.flatMap((node): NativeHostUiNode[] => {
            if (node.kind === "text") return [{ text: node.text }];
            if (node.tag === "script") {
                scripts.push(node);
                return [];
            }
            if (node.tag === "style") {
                readStyle(node);
                return [];
            }
            const reason =
                node.namespace !== xhtml
                    ? `is foreign (${node.namespace}) markup`
                    : unrepresentedElements.get(node.tag);
            if (reason) {
                refuse(`<${node.tag}> in ${within}: ${reason}.`);
                return [];
            }
            if (inlineHandlers(node)) return [];
            const element: NativeHostUiElement = { tag: node.tag };
            if (node.attributes.length > 0)
                element.attributes = Object.fromEntries(node.attributes);
            const children = hostNodes(node.children, `<${node.tag}>`);
            if (children.length > 0) element.children = children;
            return [element];
        });

    const htmlAttributes = Object.fromEntries(html.attributes);
    for (const child of html.children)
        if (child.kind === "element" && child !== head && child !== body)
            refuse(`<${child.tag}> outside head and body is not represented.`);
    inlineHandlers(body);
    const bodyAttributes = Object.fromEntries(body.attributes);
    // White space opening or closing the body (around its scripts, say)
    // collapses away at the edges of its block.
    const elements = hostNodes(body.children, "<body>");
    const blank = (node: NativeHostUiNode | undefined): boolean =>
        node !== undefined && node.tag === undefined && isWhitespace(node.text);
    while (blank(elements[0])) elements.shift();
    while (blank(elements.at(-1))) elements.pop();

    const modules = scripts.filter((script) => {
        const type = attribute(script, "type")?.trim().toLowerCase();
        if (type === "module") return true;
        refuse(
            type === undefined ||
                type === "" ||
                /^(?:text|application)\/(?:java|ecma)script$/.test(type)
                ? "has a classic <script>; the page's entry is its module script and other scripts are not compiled."
                : `has a <script type="${type}">, which is not compiled.`,
        );
        return false;
    });
    if (modules.length > 1)
        refuse("has several module scripts; a native program has one entry.");
    if (refusals.length > 0)
        fail(
            `is not represented by the native host:\n${refusals
                .map((refusal) => `  - ${refusal}`)
                .join("\n")}`,
        );
    const [script] = modules;
    if (!script) return fail("has no module script naming its entry.");
    const { entry, loader } = pageEntry(script, page, pageDirectory, fail);

    return {
        path: page.path,
        ...(title ? { title } : {}),
        entry,
        moduleRoot: pageDirectory,
        ...(loader ? { loader } : {}),
        hostUi: {
            sourcePath: page.path,
            ...(Object.keys(htmlAttributes).length > 0
                ? { htmlAttributes }
                : {}),
            ...(Object.keys(bodyAttributes).length > 0
                ? { bodyAttributes }
                : {}),
            ...(styleSheets.length > 0 ? { styleSheets } : {}),
            elements,
        },
    };
}

/** What a page contributes to its entry's compilation. */
export function hostPageCompileOptions(
    page: HostPage,
): Required<Pick<CompileOptions, "fileName" | "hostPage" | "nativeHostUi">> &
    Pick<CompileOptions, "title"> {
    return {
        fileName: page.entry,
        hostPage: {
            path: resolve(page.path),
            moduleRoot: page.moduleRoot,
            ...(page.loader ? { loader: page.loader } : {}),
        },
        nativeHostUi: page.hostUi,
        ...(page.title ? { title: page.title } : {}),
    };
}

/** Read and parse the HTML page at `path`. */
export function readHostPage(path: string): HostPage {
    const html = readFileSync(resolve(path), "utf8");
    return hostPageFromDocument(parseHostPageMarkup(html), { path, html });
}
