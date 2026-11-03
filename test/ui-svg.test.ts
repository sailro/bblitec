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
        // A label on an arc: the text follows the path, styled by a class rule.
        const labels = make("svg");
        labels.setAttribute("id", "labels");
        labels.setAttribute("viewBox", "-50 -50 100 100");
        labels.setAttribute("width", "100");
        labels.setAttribute("height", "100");
        const arc = make("path");
        arc.setAttribute("id", "label-arc");
        arc.setAttribute("d", "M-40,0 A40,40 0 0 1 40,0");
        arc.setAttribute("fill", "none");
        const label = make("text");
        label.setAttribute("class", "arc-name");
        label.setAttribute("font-size", "12");
        label.setAttribute("letter-spacing", "1");
        const run = make("textPath");
        run.setAttribute("href", "#label-arc");
        run.setAttribute("startOffset", "50%");
        run.setAttribute("text-anchor", "middle");
        run.textContent = "Oak";
        label.append(run);
        labels.append(arc, label);
        const sheet = document.createElement("style");
        sheet.textContent = ".arc-name { fill: #f6e4bc; stroke: rgba(40, 24, 8, 0.85); stroke-width: 3.5px; paint-order: stroke; text-transform: uppercase; }";
        document.head.append(sheet);
        document.body.append(labels);
        globalThis.close();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.ok(result.manifest.features.includes("ui:inline-svg"));
    assert.match(result.cpp, /ui_create_svg_element/);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-svg", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_UI_INLINE_SVG: 1,
        },
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
    // A namespace held in a const is the same generation-known string, and a
    // created element's dataset member by a literal key is its data attribute.
    const named = compileSource(
        `import {createEngine} from "@babylonjs/lite"; await createEngine({}); const SVG_NS = "http://www.w3.org/2000/svg"; const svg = document.createElementNS(SVG_NS, "svg"); const text = document.createElementNS(SVG_NS, "text"); svg.appendChild(text); text.classList.add("is-cut"); text.dataset["groupKey"] = "walls"; document.body.appendChild(svg); text.addEventListener("pointerenter", () => {});`,
    );
    assert.match(named.cpp, /ui_create_svg_element\([^;]*"text"/);
    assert.match(named.cpp, /"data-group-key", "walls"/);
});

test("image markup accepts void tags and refuses dynamic sources or unrepresented attributes", () => {
    const compile = (markup: string) =>
        compileSource(
            `const root=document.createElement("div");root.innerHTML=${markup};document.body.append(root);`,
        );
    for (const markup of ['<img alt="">', '<img alt=""/>'])
        assert.match(compile(JSON.stringify(markup)).cpp, /<img[^\n]+\/>/);
    // The browser parses the markup: an img is void, so the span follows it.
    assert.match(
        compile(JSON.stringify("<img><span></span></img>")).cpp,
        /<img data-bbl-node=\\"0\\"\/><span data-bbl-node=\\"1\\"><\/span>/,
    );
    for (const [markup, message] of [
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
