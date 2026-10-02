import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("retained SVG construction preserves namespace, shape mutation and inherited color", (t) => {
    const directory = resolve("artifacts/ui-svg");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(
        `
        const make = (tag: string): SVGElement => document.createElementNS("http://www.w3.org/2000/svg", tag);
        const svg = make("svg");
        svg.setAttribute("id", "icon");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", "96");
        svg.setAttribute("height", "96");
        svg.style.color = "rgb(255,0,0)";
        const circle = make("circle");
        circle.setAttribute("cx", "12"); circle.setAttribute("cy", "12"); circle.setAttribute("r", "8");
        circle.setAttribute("fill", "currentColor");
        svg.append(circle);
        const stored: { icon: SVGElement; child: Element } = {icon: svg, child: circle};
        stored.icon.setAttribute("viewBox", "0 0 24 24");
        if (stored.icon.getAttribute("viewbox") !== null) throw new Error("SVG attribute case");
        if (stored.icon.getAttribute("viewBox") !== "0 0 24 24") throw new Error("SVG viewBox");
        if (!svg.matches("svg[viewBox]")) throw new Error("SVG selector names");
        if (svg.matches("SVG") || svg.matches("[viewbox]")) throw new Error("SVG selector case");
        if (circle.matches(":is(CIRCLE)")) throw new Error("Nested SVG selector case");
        if (svg.querySelector("circle") !== circle) throw new Error("SVG descendant query");
        const html = document.createElement("div");
        html.setAttribute("TITLE", "case");
        if (!html.matches("DIV[TITLE=case]")) throw new Error("HTML selector case");
        const htmlSvg = document.createElement("svg");
        html.append(htmlSvg, svg);
        if (!svg.matches("svg:only-of-type")) throw new Error("Selector namespace identity");
        stored.child.setAttribute("r", "6");
        if (svg instanceof HTMLElement) throw new Error("SVG is not HTML");
        if (!(svg instanceof Element)) throw new Error("SVG is an element");
        if (!(stored.child instanceof SVGElement)) throw new Error("SVG interface");
        document.body.append(svg);
        globalThis.close();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.ok(result.manifest.features.includes("ui:inline-svg"));
    assert.match(result.cpp, /ui_create_svg_element/);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-svg", {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
});

test("SVG construction refuses foreign namespaces and unsupported SVG elements", () => {
    for (const [namespace, tag, message] of [
        ["http://www.w3.org/1998/Math/MathML", "math", /SVG namespace/],
        ["http://www.w3.org/2000/svg", "foreignObject", /bounded svg/],
        ["http://www.w3.org/2000/svg", "SVG", /bounded svg/],
    ] as const)
        assert.throws(
            () =>
                compileSource(
                    `document.createElementNS(${JSON.stringify(namespace)}, ${JSON.stringify(tag)});`,
                ),
            message,
        );
});

test("image markup accepts void tags and refuses dynamic sources or unrepresented attributes", () => {
    const compile = (markup: string) =>
        compileSource(
            `const root=document.createElement("div");root.innerHTML=${markup};document.body.append(root);`,
        );
    for (const markup of ['<img alt="">', '<img alt=""/>'])
        assert.match(compile(JSON.stringify(markup)).cpp, /<img[^\n]+\/>/);
    for (const [markup, message] of [
        ["<img><span></span></img>", /closing tag/],
        ['<img onload="run()">', /attribute 'onload'/],
        ['<img srcset="tile.png 2x">', /attribute 'srcset'/],
        ['<img width="20%">', /nonnegative integer/],
    ] as const)
        assert.throws(() => compile(JSON.stringify(markup)), message);
    assert.throws(
        () => compile('`<img src="${performance.now()}">`'),
        /requires static attribute 'src'/,
    );
});
