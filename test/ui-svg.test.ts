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
        // A client point in the root's user space: measured, inverted and applied.
        const ctm = (svg as SVGSVGElement).getScreenCTM();
        if (!ctm) throw new Error("A connected SVG has a screen CTM");
        const point = (svg as SVGSVGElement).createSVGPoint();
        point.x = 3; point.y = 4;
        const user = point.matrixTransform(ctm.inverse());
        if (user === point || point.x !== 3 || point.y !== 4 || user.w !== 1 || ctm.b !== 0) throw new Error("SVG point");
        if ((make("circle") as SVGGraphicsElement).getScreenCTM() !== null) throw new Error("A detached SVG shape has no CTM");
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
    assert.match(result.cpp, /bbl::ui_svg_screen_ctm\(/);
    assert.match(result.cpp, /bbl::js::dom_point_matrix_transform\(/);
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

test("an SVG shape takes a tabindex, ARIA attributes, focus and key listeners", () => {
    const result = compileSource(
        `import {createEngine} from "@babylonjs/lite"; await createEngine({}); const ns = "http://www.w3.org/2000/svg"; const svg = document.createElementNS(ns, "svg"); const thumb = document.createElementNS(ns, "circle"); const label = ["Mix", "Blend"][Math.floor(Math.random() * 2)]!; for (const [key, value] of Object.entries({ r: "11", tabindex: "0", role: "slider", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "1" })) thumb.setAttribute(key, value); svg.append(thumb); document.body.append(svg); let value = 0; thumb.addEventListener("keydown", (e) => { if (e.key === "End") { value = 1; thumb.setAttribute("aria-valuenow", String(value)); e.preventDefault(); } }); thumb.addEventListener("focus", () => thumb.setAttribute("stroke-width", "3")); (thumb as SVGGraphicsElement).focus();`,
    );
    assert.match(result.cpp, /ui_set_attribute\([^;]*"tabindex", "0"\)/);
    assert.match(result.cpp, /ui_set_attribute\([^;]*"role", "slider"\)/);
    assert.match(result.cpp, /on_dom_keyboard\([^;]*"keydown"/);
    assert.match(result.cpp, /bbl::ui_focus\(/);
});

test("SVG geometry refuses DOMMatrix and DOMPoint members it does not lower", () => {
    const prefix = `const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); document.body.append(svg); const ctm = svg.getScreenCTM()!; const point = svg.createSVGPoint();`;
    for (const [statement, message] of [
        ["point.x += 1;", /DOMPoint components support '=' assignments/],
        [
            "point.matrixTransform({ a: 2 });",
            /matrixTransform requires a DOMMatrix; a DOMMatrixInit is not lowered/,
        ],
        ["ctm.multiply(ctm);", /DOMMatrix\.multiply is not lowered/],
    ] as const)
        assert.throws(() => compileSource(`${prefix} ${statement}`), message);
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
