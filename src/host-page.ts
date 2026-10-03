/**
 * An HTML page as a program's host: the module its module script evaluates,
 * and the markup, attributes and `<style>` sheets around it as the native
 * host UI model (`NativeHostUi`), which the reviewed `ui/*.json` companions
 * also describe. `host-page-parser.ts` parses the page with Chromium.
 *
 * What the host model cannot represent refuses here, naming the page:
 * external and head classic scripts, data scripts, inline event handlers, external style sheets,
 * foreign (SVG/MathML) markup and head content with an effect.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { deploymentAssetSource } from "./compiler/deployment.js";
import type {
    CompileOptions,
    HostPageProgram,
    NativeHostUi,
    NativeHostUiElement,
    NativeHostUiNode,
    NativeHostUiStyleSheet,
    PageLoaderModule,
    PageStartupScript,
} from "./compiler/types.js";
import {
    parseHostPageMarkup,
    type HostPageDocument,
    type HostPageElement,
    type HostPageNode,
} from "./host-page-parser.js";
import {
    dynamicImportSpecifier,
    isRelativeSpecifier,
    moduleSpecifiers,
} from "./typescript-module-specifiers.js";

export interface HostPage extends HostPageProgram {
    title?: string;
    /** The module the page's module script evaluates. */
    entry: string;
    /** Absent for a page without markup, sheets or attributes. */
    hostUi?: NativeHostUi;
}

/** Whether a source path names an HTML page rather than a module. */
export function isHostPagePath(path: string): boolean {
    return /\.html?$/i.test(path);
}

/** The site root "/" paths resolve beneath: the page's directory unless given. */
export function hostPageRoot(page: HostPageProgram): string {
    return resolve(page.root ?? dirname(resolve(page.path)));
}

/**
 * The file a root-relative or relative module specifier names beneath the
 * page's root, as the bundler serving it resolves the URL; undefined for
 * another origin.
 */
export function hostPageModulePath(
    specifier: string,
    root: string,
): string | undefined {
    return deploymentAssetSource(specifier, { publicDir: root });
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

/** An element's start tag, for a refusal to name it by. */
function spelled(element: HostPageElement): string {
    return `<${[
        element.tag,
        ...Object.entries(element.attributes ?? {}).map(
            ([name, value]) => `${name}="${value}"`,
        ),
    ].join(" ")}>`;
}

function textContent(element: HostPageElement): string {
    return (element.children ?? [])
        .map((child) =>
            child.tag === undefined ? child.text : textContent(child),
        )
        .join("");
}

function childElements(element: HostPageElement): HostPageElement[] {
    return (element.children ?? []).filter(
        (child): child is HostPageElement => child.tag !== undefined,
    );
}

/** Finds raw text (script and style contents) in the page, in order. */
class PageLines {
    private readonly html: string;
    private cursor = 0;

    public constructor(html: string) {
        // The HTML parser normalizes line breaks before tokenizing.
        this.html = html.replace(/\r\n?/g, "\n");
    }

    /** The 1-based page line `text` starts on, searching past the last. */
    public line(text: string): number {
        const offset = this.html.indexOf(text, this.cursor);
        if (offset < 0) return 1;
        this.cursor = offset + text.length;
        return this.html.slice(0, offset).split("\n").length;
    }
}

/** The page's one module script, whose entry the survey reports. */
function moduleScripts(document: HostPageDocument): HostPageElement[] {
    const scripts: HostPageElement[] = [];
    const visit = (element: HostPageElement): void => {
        if (element.tag === "script") scripts.push(element);
        else childElements(element).forEach(visit);
    };
    visit(document.root);
    return scripts.filter(
        (script) => script.attributes?.type?.trim().toLowerCase() === "module",
    );
}

/** The entry the page's module script names, with its loader when inline. */
function pageEntry(
    script: HostPageElement,
    page: HostPageProgram & { lines: PageLines },
    fail: (message: string) => never,
): { entry: string; loader?: PageLoaderModule } {
    const root = hostPageRoot(page);
    const modulePath = (specifier: string): string => {
        if (/[?#]/.test(specifier))
            fail(`module '${specifier}' carries a query or fragment.`);
        const path =
            hostPageModulePath(specifier, root) ??
            fail(`loads module '${specifier}' from another origin.`);
        return existsSync(path)
            ? path
            : fail(
                  `module '${specifier}' resolves to '${path}', which does not exist.`,
              );
    };
    for (const name of Object.keys(script.attributes ?? {}))
        if (name !== "type" && name !== "src")
            fail(`module script attribute '${name}' is not represented.`);
    const src = script.attributes?.src;
    const inline = textContent(script);
    if (src !== undefined) {
        if (!isWhitespace(inline))
            fail("module script has both a src attribute and inline text.");
        return { entry: modulePath(src) };
    }
    // Line numbers in the inline script follow the page's own lines.
    const fileName = `${resolve(page.path)}.inline-module.ts`;
    const source = "\n".repeat(page.lines.line(inline) - 1) + inline;
    const parsed = ts.createSourceFile(
        fileName,
        source,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TS,
    );
    const imports = moduleSpecifiers(parsed);
    const [first] = imports;
    if (!first || imports.some((literal) => literal.text !== first.text))
        return fail(
            "inline module script must import exactly one module, by a string literal.",
        );
    const specifier = first.text;
    if (!isRelativeSpecifier(specifier) && !specifier.startsWith("/"))
        fail(`imports bare specifier '${specifier}', which names a package.`);
    const entry = modulePath(specifier);
    const dynamic = imports.filter((literal) =>
        dynamicImportSpecifier(literal.parent),
    );
    if (dynamic.length === 0) {
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
    if (dynamic.length !== imports.length || dynamic.length > 1)
        fail(
            "inline module script must import its entry once, statically or dynamically.",
        );
    return { entry, loader: { fileName, source, specifier } };
}

/**
 * The page's host model and entry, from the tree Chromium parsed. Every
 * unrepresented construct is listed in one refusal.
 */
export function hostPageFromDocument(
    document: HostPageDocument,
    page: HostPageProgram & { html: string },
): HostPage {
    const fail = (message: string): never => {
        throw new Error(`Host page '${page.path}' ${message}`);
    };
    const refusals: string[] = [];
    const refuse = (message: string): void => {
        refusals.push(message);
    };
    if (document.compatMode !== "CSS1Compat")
        fail(
            "renders in quirks mode; the native layout represents standards mode (<!doctype html>) only.",
        );
    const lines = new PageLines(page.html);
    const html = document.root;
    const [head, body, ...others] = childElements(html);
    if (head?.tag !== "head" || body?.tag !== "body")
        return fail("has no head or body element.");
    for (const other of others)
        refuse(`${spelled(other)} outside head and body is not represented.`);

    const styleSheets: NativeHostUiStyleSheet[] = [];
    const scripts: HostPageElement[] = [];
    let title: string | undefined;
    const startup: PageStartupScript[] = [];

    const readStyle = (element: HostPageElement): void => {
        for (const [name, value] of Object.entries(element.attributes ?? {}))
            if (name !== "type" || !/^(?:text\/css)?$/i.test(value))
                refuse(`<style ${name}="${value}"> is not represented.`);
        const text = textContent(element);
        styleSheets.push({ text, line: lines.line(text) });
    };

    for (const child of head.children ?? []) {
        if (child.tag === undefined) {
            if (!isWhitespace(child.text)) refuse("has text in its head.");
            continue;
        }
        const attributes = child.attributes ?? {};
        const attributeCount = Object.keys(attributes).length;
        if (child.tag === "style") readStyle(child);
        else if (child.tag === "script") {
            scripts.push(child);
            if (child.attributes?.type?.trim().toLowerCase() !== "module")
                refuse(
                    "classic <script> in the head requires parser-owned document construction.",
                );
        } else if (child.tag === "title") title = textContent(child).trim();
        else if (child.tag === "meta") {
            const { charset, name, content = "" } = attributes;
            if (attributeCount === 1 && charset?.toLowerCase() === "utf-8")
                continue;
            // The native window is the whole layout viewport at scale one,
            // which the user cannot zoom.
            if (
                attributeCount === 2 &&
                name === "viewport" &&
                content
                    .split(",")
                    .map((entry) => entry.trim().replace(/\s*=\s*/, "="))
                    .every((entry) =>
                        /^(?:width=device-width|(?:initial|minimum|maximum)-scale=1(?:\.0*)?|user-scalable=(?:no|0)|viewport-fit=(?:auto|cover))$/.test(
                            entry,
                        ),
                    )
            )
                continue;
            // Browser chrome and search metadata; the light scheme is the
            // native controls' own.
            if (
                attributeCount === 2 &&
                (name === "theme-color" ||
                    name === "description" ||
                    (name === "color-scheme" &&
                        /^(?:light|normal)$/.test(content.trim())))
            )
                continue;
            refuse(`head metadata ${spelled(child)} is not represented.`);
        } else if (
            child.tag === "link" &&
            (attributes.rel ?? "")
                .split(/\s+/)
                .every((rel) => inertLinkRelations.has(rel.toLowerCase()))
        )
            continue;
        else refuse(`head element ${spelled(child)} is not represented.`);
    }

    const inlineHandlers = (element: HostPageElement): boolean => {
        const handlers = Object.keys(element.attributes ?? {}).filter((name) =>
            /^on/i.test(name),
        );
        for (const name of handlers)
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
            if (node.tag === undefined) return [node];
            if (node.tag === "script") {
                scripts.push(node);
                const type = node.attributes?.type?.trim().toLowerCase();
                if (type === "module") return [];
                if (
                    type &&
                    !/^(?:text|application)\/(?:java|ecma)script$/.test(type)
                ) {
                    refuse(`<script type="${type}"> is not compiled.`);
                    return [];
                }
                for (const attribute of Object.keys(node.attributes ?? {}))
                    if (attribute !== "type")
                        refuse(
                            `classic <script> attribute '${attribute}' is not represented.`,
                        );
                const inline = textContent(node);
                const fileName = `${resolve(page.path)}.inline-classic-${startup.length + 1}.js`;
                const source = "\n".repeat(lines.line(inline) - 1) + inline;
                const parsed = ts.createSourceFile(
                    fileName,
                    source,
                    ts.ScriptTarget.ES2022,
                    true,
                    ts.ScriptKind.JS,
                );
                if (moduleSpecifiers(parsed).length)
                    refuse(
                        "classic <script> imports require module activation before parser microtask checkpoints.",
                    );
                if (
                    parsed.statements.some(
                        (statement) =>
                            !ts.isExpressionStatement(statement) &&
                            !ts.isEmptyStatement(statement),
                    )
                )
                    refuse(
                        "classic <script> requires expression statements; global declarations and control statements need shared script binding ownership.",
                    );
                startup.push({ fileName, source });
                return [
                    {
                        tag: "script",
                        text: inline,
                        ...(node.attributes
                            ? { attributes: node.attributes }
                            : {}),
                        startupScript: fileName,
                    },
                ];
            }
            if (node.tag === "style") {
                if (startup.length)
                    refuse(
                        "a style sheet after a classic <script> requires ordered stylesheet activation.",
                    );
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
            if (node.attributes) element.attributes = node.attributes;
            const children = hostNodes(node.children ?? [], `<${node.tag}>`);
            if (children.length > 0) element.children = children;
            return [element];
        });

    inlineHandlers(body);
    // White space opening or closing the body (around its scripts, say)
    // collapses away at the edges of its block.
    const elements = hostNodes(body.children ?? [], "<body>");
    const blank = (node: NativeHostUiNode | undefined): boolean =>
        node !== undefined && node.tag === undefined && isWhitespace(node.text);
    while (blank(elements[0])) elements.shift();
    while (blank(elements.at(-1))) elements.pop();

    const modules = scripts.filter(
        (script) => script.attributes?.type?.trim().toLowerCase() === "module",
    );
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
    const { entry, loader } = pageEntry(script, { ...page, lines }, fail);

    const htmlAttributes = html.attributes ?? {};
    const bodyAttributes = body.attributes ?? {};
    // The document language alone has no native rendering.
    const hasDocument =
        elements.length > 0 ||
        styleSheets.length > 0 ||
        Object.keys(bodyAttributes).length > 0 ||
        Object.keys(htmlAttributes).some((name) => name !== "lang");
    return {
        path: page.path,
        ...(page.root !== undefined ? { root: page.root } : {}),
        ...(title ? { title } : {}),
        entry,
        ...(loader ? { loader } : {}),
        ...(startup.length ? { startup } : {}),
        ...(hasDocument
            ? {
                  hostUi: {
                      sourcePath: page.path,
                      ...(html.attributes ? { htmlAttributes } : {}),
                      ...(body.attributes ? { bodyAttributes } : {}),
                      ...(styleSheets.length > 0 ? { styleSheets } : {}),
                      elements,
                  },
              }
            : {}),
    };
}

/** What a page contributes to its entry's compilation. */
export function hostPageCompileOptions(page: HostPage): CompileOptions {
    return {
        fileName: page.entry,
        hostPage: page,
        ...(page.hostUi ? { nativeHostUi: page.hostUi } : {}),
        ...(page.title ? { title: page.title } : {}),
    };
}

/** Read and parse the HTML page at `path`. */
export function readHostPage(page: HostPageProgram): HostPage {
    const html = readFileSync(resolve(page.path), "utf8");
    return hostPageFromDocument(parseHostPageMarkup(html), { ...page, html });
}

/**
 * The entry a page's module script names, whatever else the page holds: a
 * survey reports its readiness even when the page refuses.
 */
export function readHostPageEntry(page: HostPageProgram): string {
    const html = readFileSync(resolve(page.path), "utf8");
    const fail = (message: string): never => {
        throw new Error(`Host page '${page.path}' ${message}`);
    };
    const [script, ...others] = moduleScripts(parseHostPageMarkup(html));
    if (!script || others.length > 0)
        return fail("must have one module script naming its entry.");
    return pageEntry(script, { ...page, lines: new PageLines(html) }, fail)
        .entry;
}
