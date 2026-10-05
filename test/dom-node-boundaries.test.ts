import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const nodes = `
const host = document.createElement('div');
host.id = 'host'; document.body.append(host);
const text = document.createTextNode('a');
const stored: {text: Text} = {text};
const update: Array<(value: string) => void> = [value => { stored.text.textContent = value; }];
const first = document.createElement('b'); first.textContent = 'b';
host.append(text, first);
update[0]!('A');
if (host.textContent !== 'Ab' || host.childElementCount !== 1 || host.children.length !== 1 || host.childNodes.length !== 2) throw new Error('child counts');
if (host.firstChild !== text || host.lastChild !== first || text.nextSibling !== first || first.previousSibling !== text) throw new Error('node order');
if (text.firstChild !== null || text.childNodes.length !== 0 || text instanceof Element || !(text instanceof Node)) throw new Error('text kind');
const second = document.createElement('i'); second.textContent = 'c';
if (host.insertBefore(second, first) !== second || host.textContent !== 'Acb') throw new Error('insert');
host.insertBefore(second, second);
if (host.textContent !== 'Acb') throw new Error('self insert');
const stranger = document.createElement('span');
let caught = 0;
try { host.insertBefore(first, stranger); } catch { caught++; }
if (caught !== 1 || host.textContent !== 'Acb') throw new Error('failed insert mutated tree');
host.insertBefore(text, null);
if (host.textContent !== 'cbA' || host.lastChild !== text) throw new Error('append by null');
host.insertBefore(text, host.firstChild);
if (host.firstChild !== text) throw new Error('nullable reference');
host.insertBefore(text, null);
first.remove();
if (host.children.length !== 1 || host.childNodes.length !== 2) throw new Error('live count');
const leaf = document.createElement('span'); leaf.textContent = 'leaf';
const selected = leaf.firstChild;
if (selected !== leaf.firstChild || leaf.childNodes.length !== 1 || leaf.children.length !== 0) throw new Error('leaf text identity');
const label = document.createElement('div');
label.innerHTML = '<label class="caption">before<!-- ignored > <fake> -->after</label>';
label.querySelector('.caption')!.textContent = 'updated';
document.body.append(label);
const comment = document.createElement('div'); comment.innerHTML = '<!-- retained as markup -->';
let traversalCaught = 0;
try { if (comment.childNodes.length >= 0) throw new Error('unexpected count'); }
catch(error) { if (!error.message.includes('innerHTML')) throw error; traversalCaught++; }
try { if (label.firstChild === null) throw new Error('unexpected node'); }
catch(error) { if (!error.message.includes('innerHTML')) throw error; traversalCaught++; }
if (traversalCaught !== 2) throw new Error('unrepresented markup traversal');
const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
svg.setAttribute('id', 'shapes'); svg.setAttribute('viewBox', '0 0 40 40');
svg.setAttribute('width', '80'); svg.setAttribute('height', '80');
if (!svg.toggleAttribute('hidden') || !svg.hasAttribute('hidden') || svg.toggleAttribute('hidden', false)) throw new Error('toggle attribute');
host.setAttribute('data-value', 'kept');
if (!host.toggleAttribute('data-value', true) || host.getAttribute('data-value') !== 'kept') throw new Error('forced attribute preserved');
let invalidAttribute = 0;
try { host.toggleAttribute('', false); }
catch(error) { if (!error.message.includes('attribute name cannot be empty')) throw error; invalidAttribute++; }
if (invalidAttribute !== 1) throw new Error('unchanged attribute validation');
for (const tag of ['line', 'ellipse', 'polyline', 'polygon'] as const) {
    const shape = document.createElementNS('http://www.w3.org/2000/svg', tag);
    shape.setAttribute('fill', 'none'); shape.setAttribute('stroke', '#ff0000');
    if (tag === 'line') { shape.setAttribute('x1', '2'); shape.setAttribute('y1', '2'); shape.setAttribute('x2', '30'); shape.setAttribute('y2', '30'); }
    else if (tag === 'ellipse') { shape.setAttribute('cx', '20'); shape.setAttribute('cy', '20'); shape.setAttribute('rx', '10'); shape.setAttribute('ry', '5'); }
    else shape.setAttribute('points', '2,2 20,4 30,30');
    svg.append(shape);
}
if (svg.childElementCount !== 4) throw new Error('SVG children');
document.body.append(svg);
globalThis.close();
`;

test("retained text nodes, child reads and insertion preserve identity and DOM order", (t) => {
    const directory = resolve("artifacts/dom-node-boundaries");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(nodes, {
        fileName: join(directory, "entry.ts"),
    });
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.ok(result.manifest.features.includes("ui:inline-svg"));
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "dom-node-boundaries", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("unrepresented markup bridges and pointer capture use explicit typed throws", (t) => {
    const source = `
    const host = document.createElement('div'); host.textContent = 'retained';
    let calls = 0, caught = 0;
    function value(): string { calls++; return 'asset.png'; }
    try { host.innerHTML = '<svg><image href="' + value() + '"/></svg>'; }
    catch(error) { if (!error.message.includes('dom:Element.innerHTML.svg-image')) throw error; caught++; }
    try { host.innerHTML = '<label>Level<input type="range"></label>'; }
    catch(error) { if (!error.message.includes('dom:Element.innerHTML.form-controls')) throw error; caught++; }
    function pointer(): number { calls++; return 1; }
    try { host.setPointerCapture(pointer()); }
    catch(error) { if (!error.message.includes('dom:Element.setPointerCapture')) throw error; caught++; }
    try { host.releasePointerCapture(pointer()); }
    catch(error) { if (!error.message.includes('dom:Element.releasePointerCapture')) throw error; caught++; }
    try { host.hasPointerCapture(pointer()); }
    catch(error) { if (!error.message.includes('dom:Element.hasPointerCapture')) throw error; caught++; }
    if (calls !== 4 || caught !== 5 || host.textContent !== 'retained') throw new Error('deferred mutation');
    const conditional = document.createElement('div');
    let completed = 0, selectedCalls = 0;
    function selected(): string { selectedCalls++; return 'choice'; }
    function write(unsupported: boolean): void {
        conditional.innerHTML = unsupported ? '<input type="range" title="' + selected() + '">' : '<label>' + selected() + '</label>';
        completed++;
    }
    write(false);
    write(host.hasAttribute('missing'));
    try { write(true); } catch(error) {
        if (!error.message.includes('dom:Element.innerHTML.form-controls')) throw error;
        caught++;
    }
    try { write(!host.hasAttribute('missing')); } catch(error) {
        if (!error.message.includes('dom:Element.innerHTML.form-controls')) throw error;
        caught++;
    }
    if (completed !== 2 || selectedCalls !== 4 || caught !== 7) throw new Error('conditional markup');
    const local = { setPointerCapture: (value: number) => value + 1 };
    if (local.setPointerCapture(2) !== 3) throw new Error('authored method');
    globalThis.close();
    `;
    const directory = resolve("artifacts/deferred-dom-node-boundaries");
    mkdirSync(directory, { recursive: true });
    assert.throws(() => compileSource(source), /outside the bounded/);
    const result = compileSource(source, {
        deferredCapabilities: "runtime-throw",
        fileName: join(directory, "entry.ts"),
    });
    assert.deepEqual(
        new Set(result.manifest.deferredCapabilities?.map((site) => site.id)),
        new Set([
            "dom:Element.innerHTML.svg-image",
            "dom:Element.innerHTML.form-controls",
            "dom:Element.setPointerCapture",
            "dom:Element.releasePointerCapture",
            "dom:Element.hasPointerCapture",
        ]),
    );
    assert.ok(
        result.manifest.deferredCapabilities?.every(
            (site) => site.origin === "dom" && site.timing === "throw",
        ),
    );
    assert.ok(!result.manifest.features.includes("ui:inline-svg"));
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "deferred-dom-node-boundaries", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("unrelated markup and stored child collections continue to refuse", () => {
    for (const markup of [
        "<script></script>",
        '<label onclick="run()">x</label>',
        '<image href="asset.png"/>',
        '<svg><input type="range"/></svg>',
        "<!-- missing",
    ])
        assert.throws(
            () =>
                compileSource(
                    `const host=document.createElement('div');host.innerHTML=${JSON.stringify(markup)};`,
                    { deferredCapabilities: "runtime-throw" },
                ),
            /Native UI innerHTML/,
        );
    assert.throws(
        () =>
            compileSource(
                `const host=document.createElement('div');const live=host.children;console.log(live.length);`,
            ),
        /Unsupported|represented|native/,
    );
});
