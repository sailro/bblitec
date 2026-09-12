import assert from "node:assert/strict";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {parseUiSelectorSequence, splitUiSelectorList, uiSelectorSequenceCss, uiSelectorSequenceSpecificity} from "../src/ui-selector.js";
import {runRmlUiFixture} from "./native-fixture.js";

test("compound selector parsing preserves relations, quoted values and specificity", () => {
    const selector = `section.panel.selected > button[data-mode='a,b'] + .entry:focus`;
    const sequence = parseUiSelectorSequence(selector)!;
    assert.deepEqual(sequence.map(step => step.relation), ["self", "child", "next"]);
    assert.equal(uiSelectorSequenceCss(sequence), 'section.panel.selected > button[data-mode="a,b"] + .entry:focus');
    assert.equal(uiSelectorSequenceSpecificity(sequence), 5 * 0x100 + 2);
    assert.deepEqual(splitUiSelectorList(`${selector}, .entry:not(.a,.b),[title="a,b"]`), [selector, ".entry:not(.a,.b)", '[title="a,b"]']);
    for (const source of ["", "a >", "a ++ b", ".a:unknown", ".a::before", "a[name^=value]", "a:has(:has(.b))", "bbl-grid-children", ".a:hover:hover"])
        assert.equal(parseUiSelectorSequence(source), undefined, source);
    for (const source of ['[title=\'a"b\']', '[data-mode="a,b"]', "button img", ".a.b.c .d > .e ~ .f"])
        assert.deepEqual(parseUiSelectorSequence(uiSelectorSequenceCss(parseUiSelectorSequence(source)!)), parseUiSelectorSequence(source));
});

test("structural and negated selector terms normalize formulas and retain specificity", () => {
    const parse = (source: string) => parseUiSelectorSequence(source)!;
    assert.equal(uiSelectorSequenceCss(parse('.item:first-child')), '.item:nth-child(1)');
    assert.equal(uiSelectorSequenceCss(parse('.item:nth-child(+n - 2)')), '.item:nth-child(1n-2)');
    assert.equal(uiSelectorSequenceCss(parse('.item:nth-last-of-type(odd)')), '.item:nth-last-of-type(2n+1)');
    assert.equal(uiSelectorSequenceSpecificity(parse('.item:not(.muted, #blocked)')), 0x10100);
    assert.equal(uiSelectorSequenceSpecificity(parse('.item:is(.muted, #blocked)')), 0x10100);
    assert.equal(uiSelectorSequenceSpecificity(parse('.item:where(.muted, #blocked)')), 0x100);
    assert.equal(uiSelectorSequenceSpecificity(parse('.item:has(> .child, + #neighbor)')), 0x10100);
    for (const source of ['.item:not(:not(.muted))', '.item:not([title="a)b"], .panel > .entry)', '.item:nth-child(-2n + 5)',
        ':is(.entry, [role="dialog"]) > img', '.item:where(.a,.b)', '.item:has(> :is(.child, .other):hover, + .neighbor span)', '.item:not(:has(.child))'])
        assert.deepEqual(parse(uiSelectorSequenceCss(parse(source))), parse(source));
    for (const source of ['.item:not()', '.item:not(.a,)', '.item:not(.a', '.item:nth-child(2n of .entry)', '.item:nth-child(2 n)', '.item:nth-child(2147483648)', '.item:empty()',
        '.item:is()', '.item:where(.a,)', '.item:has(>)', '.item:has(.a:has(.b))', '.item:has(::before)'])
        assert.equal(parseUiSelectorSequence(source), undefined, source);
});

test("generated selector chains share the rendered and private native cascades", t => {
    const directory = resolve("artifacts/ui-selector");
    mkdirSync(directory, {recursive:true});
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(`
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const sheet = document.createElement("style");
        sheet.textContent = \`
            button{height:40px;background-color:#112233}
            button img{width:7px}
            .panel.selected.extra > .entry[disabled]{background-color:#445566}
            .lead + .entry{color:#123456}
            .lead ~ .entry{border:2px solid red}
            .panel .entry span{color:#223344}
            .entry[data-mode="a,b"]{width:90px}
            .panel:hover .entry{background-color:#778899}
            .panel :hover{opacity:0.9}
            .entry:focus-visible span{color:#aabbcc}
            .entry[disabled]:active{opacity:0.5}
            .panel > button:first-child{padding:3px}
            .panel > button:last-child{padding:4px}
            .panel > button:nth-child(2n + 1){margin-left:1px}
            .panel > button:nth-last-of-type(2){margin-right:1px}
            .entry:not(.muted, #blocked){color:#987654}
            .entry:not(:disabled){border:1px solid blue}
            .panel:focus-within .lead{color:#abcdef}
            .entry > span:only-child{font-size:13px}
            .entry:empty{background-color:red}
            :is(.missing, .panel) > .entry{min-height:41px}
            :where(#panel) > .entry{min-height:42px}
            .panel:has(> .entry[disabled]) .lead{background-color:#123456}
            .lead:has(+ .entry){margin-top:6px}
            .panel:has(> .entry > span){padding-bottom:7px}
            .panel:not(:has(> .entry:not([disabled]))){padding-top:8px}
        \`;
        document.head.appendChild(sheet);
        const panel = document.createElement("section");
        panel.id = "panel";
        panel.className = "panel selected extra";
        panel.style.cssText = "position:absolute;left:20px;top:20px;width:220px;height:150px;pointer-events:auto";
        const lead = document.createElement("button");
        lead.id = "lead"; lead.className = "lead";
        lead.textContent = "Lead";
        const entry = document.createElement("button");
        entry.id = "entry"; entry.className = "entry";
        entry.setAttribute("disabled", ""); entry.setAttribute("data-mode", "a,b");
        const label = document.createElement("span");
        label.id = "label"; label.textContent = "Entry";
        entry.appendChild(label);
        panel.append(lead, " ", entry);
        document.body.appendChild(panel);
        const before = entry.getBoundingClientRect();
        entry.setAttribute("data-mode", "wide");
        const after = entry.getBoundingClientRect();
        if (before.width !== 90 || after.width !== 120 || before.width !== 90)
            throw new Error("layout snapshot values");
        entry.setAttribute("data-mode", "a,b");
        globalThis.close();
    `, {fileName:join(directory, "entry.ts")});
    assert.match(result.cpp, /UiSelectorRelation::Next/);
    assert.match(result.cpp, /UiSelectorTestKind::Equals/);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-selector");
});

test("conditional selector geometry cannot silently establish a projected grid", () => {
    const compile = (rule: string) => compileSource(`
        import {createEngine} from "@babylonjs/lite";
        await createEngine({});
        const sheet = document.createElement("style");
        sheet.textContent = ${JSON.stringify(".grid{display:grid;grid-template-columns:repeat(2,24px)}.cell{width:24px;height:24px}")} + ${JSON.stringify(rule)};
        document.head.appendChild(sheet);
        const grid = document.createElement("div"); grid.className = "grid";
        const cell = document.createElement("div"); cell.className = "cell";
        grid.appendChild(cell); document.body.appendChild(grid);
    `);
    assert.throws(() => compile('.cell[data-mode="large"]{width:60px}'), /can change direct-child width/);
    assert.throws(() => compile('.grid > .cell{color:red}'), /cannot be proven across projected grid containers/);
});
