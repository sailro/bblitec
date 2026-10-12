import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import type { NativeHostUiNode } from "../src/compiler/types.js";
import {
    parseHostPageMarkup,
    type HostPageElement,
    type HostPageNode,
} from "../src/host-page-parser.js";
import { readNativeHostUi } from "../src/native-host-ui.js";
import {
    findUiCssSyntax,
    splitUiCssList,
    stripUiCssComments,
    uiCssBlockEnd,
} from "../src/ui-css-syntax.js";

const pagePath = "corpus/babylon-lite/lab/lite/demo-trogir-streaming.html";
const companionPath = "ui/trogir-streaming-host.json";
const page = readFileSync(pagePath, "utf8");
const host = readNativeHostUi(companionPath);

/**
 * A node list as it renders: inter-element white space collapses away and
 * runs collapse to one space; an element with one text child carries it as
 * its `text`, as the companion format spells it.
 */
function rendered(nodes: readonly (HostPageNode | NativeHostUiNode)[]) {
    type Node =
        | { text: string }
        | {
              tag: string;
              attributes?: Record<string, string>;
              text?: string;
              children?: Node[];
          };
    const result: Node[] = [];
    for (const node of nodes) {
        if (node.tag === undefined) {
            const text = node.text.replace(/[\t\n\f\r ]+/g, " ");
            if (text.trim()) result.push({ text });
            continue;
        }
        if (node.tag === "script") continue;
        const childNodes: (HostPageNode | NativeHostUiNode)[] = [
            ...("text" in node && node.text !== undefined
                ? [{ text: node.text }]
                : []),
            ...(node.children ?? []),
        ];
        const children = rendered(childNodes);
        const first = children[0];
        if (first && "text" in first && !("tag" in first))
            first.text = first.text.trimStart();
        const last = children.at(-1);
        if (last && "text" in last && !("tag" in last))
            last.text = last.text.trimEnd();
        const only = children.length === 1 ? children[0] : undefined;
        result.push({
            tag: node.tag,
            ...(node.attributes ? { attributes: node.attributes } : {}),
            ...(only && !("tag" in only)
                ? { text: only.text }
                : children.length > 0
                  ? { children }
                  : {}),
        });
    }
    return result;
}

test("the Trogir companion transcribes the host page's markup in document order", () => {
    const html = parseHostPageMarkup(page).root;
    const body = html.children?.find(
        (node): node is HostPageElement => node.tag === "body",
    );
    assert.ok(body);
    assert.deepEqual(
        rendered(host.elements.filter((node) => node.tag !== "style")),
        rendered(body.children ?? []),
    );
});

test("the Trogir companion transcribes every host page style rule in order", () => {
    const sheet = stripUiCssComments(
        page.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "",
    );
    const compact = (text: string): string =>
        text
            .replace(/\s+/g, " ")
            .replace(/\s*([:;,{}()])\s*/g, "$1")
            .trim();
    const rules: string[] = [];
    let keyframes = "";
    const visit = (source: string, condition: string): void => {
        let cursor = 0;
        for (;;) {
            const opening = findUiCssSyntax(source, "{", cursor);
            if (opening === undefined) return;
            const end = uiCssBlockEnd(source, opening);
            assert.ok(end !== undefined);
            const prelude = source.slice(cursor, opening).trim();
            const body = source.slice(opening + 1, end - 1);
            if (prelude.startsWith("@keyframes"))
                keyframes = compact(`${prelude}{${body}}`);
            else if (prelude.startsWith("@media")) visit(body, prelude);
            else
                for (const selector of splitUiCssList(prelude))
                    rules.push(
                        `${condition ? `${compact(condition)} ` : ""}${selector}{${compact(body)}}`,
                    );
            cursor = end;
        }
    };
    visit(sheet, "");
    const transcribed = (host.styleRules ?? []).map((rule) => {
        assert.equal(rule.kind, "sequence");
        const condition =
            rule.maxWidth !== undefined
                ? `@media(max-width:${rule.maxWidth}px) `
                : rule.reducedMotion
                  ? "@media(prefers-reduced-motion:reduce) "
                  : "";
        const style = compact(rule.style).replace(/;$/, "");
        return `${condition}${rule.primary}{${style}}`;
    });
    // Rules apply in source order within a specificity, so conditional rules
    // follow the unconditional ones they override, as in the page.
    assert.deepEqual(
        transcribed,
        rules.map((rule) => rule.replace(/;\}$/, "}")),
    );
    const style = host.elements.find((node) => node.tag === "style");
    assert.ok(style && style.tag === "style");
    assert.equal(compact(style.text ?? ""), keyframes);
});

test("the Trogir companion compiles beside the ids its application reads", () => {
    const application = readFileSync(
        "corpus/babylon-lite/lab/lite/src/demos/trogir-streaming.ts",
        "utf8",
    );
    const ids = new Set(
        [...application.matchAll(/(?:getElementById|output)\("([^"]+)"\)/g)]
            .map((match) => match[1]!)
            .filter((id) => id !== "id"),
    );
    const cpp = compileSource(
        `import { createEngine } from "@babylonjs/lite";
        await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);`,
        { nativeHostUi: host },
    ).cpp;
    for (const id of ids)
        assert.match(cpp, new RegExp(`"id", "${id}"`), `missing #${id}`);
    assert.match(cpp, /color-scheme: ?dark/);
    assert.match(cpp, /accent-color: ?#58c6ff/);
});
