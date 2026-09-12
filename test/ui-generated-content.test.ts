import assert from "node:assert/strict";
import {mkdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {parseUiGeneratedContent} from "../src/ui-generated-content.js";
import {stripUiCssComments} from "../src/ui-css-syntax.js";
import {runRmlUiFixture} from "./native-fixture.js";

test("generated content parses literal lists and attribute text without interpreting markup", () => {
    assert.deepEqual(parseUiGeneratedContent('"<b>{" attr(data-label) "}"'), {enabled:true, parts:[
        {kind:"text", value:"<b>{"}, {kind:"attribute", value:"data-label"}, {kind:"text", value:"}"},
    ]});
    assert.deepEqual(parseUiGeneratedContent('"\\41 \\1f600\\0"'), {enabled:true,parts:[{kind:"text",value:"A😀�"}]});
    assert.deepEqual(parseUiGeneratedContent('none'), {enabled:false,parts:[]});
    assert.deepEqual(parseUiGeneratedContent('""'), {enabled:true,parts:[{kind:"text",value:""}]});
    assert.equal(stripUiCssComments('.x{/* remove */content:"/* keep */"}'),'.x{content:"/* keep */"}');
    for (const source of ['', '"unterminated', 'counter(item)', 'url(icon.png)', 'attr(data-label string)', '"a" !important'])
        assert.equal(parseUiGeneratedContent(source), undefined, source);
});

test("generated content refuses unrepresented functions and originating declarations", () => {
    const compile = (css: string) => compileSource(`import {createEngine} from "@babylonjs/lite";
        await createEngine({}); const sheet=document.createElement("style");
        sheet.textContent=${JSON.stringify(css)}; document.head.appendChild(sheet);`);
    for (const css of ['.item{content:"x"}', '.item::before{content:counter(item)}', '.item::before:hover{content:"x"}', '.item::before{content:"";outline:1px solid red}'])
        assert.throws(() => compile(css));
    for (const css of ['input::placeholder{content:"x"}', 'input::placeholder{font-size:18px}', 'input::placeholder{background:red}'])
        assert.throws(() => compile(css));
    for (const css of ['::before{content:""}', '.panel ::before{content:"{"}', '.panel > ::after{content:"}"}', '.item:hover::after{color:red}'])
        assert.doesNotThrow(() => compile(css));
});

test("generated before and after boxes preserve content, cascade and authored child semantics", t => {
    const directory = resolve("artifacts/ui-generated-content");
    mkdirSync(directory, {recursive:true});
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const css = `
        .panel{display:block;width:240px}
        .panel::before{content:"";display:block;width:30px;height:11px;background-color:#123456}
        .panel > .item::before{content:"<b>{" attr(data-label) "}";color:#112233}
        #item::before{content:"ID:" attr(data-label)}
        .item::before{content:"later"}
        .panel > .item::after{content:"End";display:flex;width:40px;height:15px}
        .panel:hover > .item::before{color:#445566}
        .panel > .item.off::before{content:none}
        #item.off::before{content:none}
        .panel > .item:empty{background-color:#abcdef}
        .panel > .item:first-child{padding-left:3px}
        .item + .tail{padding-left:4px}
        .tail:only-of-type{padding-right:5px}
        .tail::before{content:"/* keep */ @keyframes literal { }"}
        .hint{color:#334455}
        .hint::placeholder{color:#123456;opacity:0.6}
        :where(#hint)::placeholder{color:red}
        :is(.hint,.unused)::placeholder{opacity:0.8}
        .hint:focus::placeholder{color:#654321}
        @media (max-width:500px){#item::before{content:"Narrow"}}
    `;
    const result = compileSource(`
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"}); worker.terminate();
        const sheet=document.createElement("style"); sheet.id="sheet"; sheet.textContent=${JSON.stringify(css)};
        document.head.appendChild(sheet);
        const panel=document.createElement("div"); panel.id="panel"; panel.className="panel";
        const item=document.createElement("button"); item.id="item"; item.className="item"; item.setAttribute("data-label","Ready");
        const tail=document.createElement("span"); tail.id="tail"; tail.className="tail"; tail.textContent="Tail";
        panel.append(item,tail); document.body.appendChild(panel);
        const hint=document.createElement("input"); hint.id="hint"; hint.className="hint";
        hint.setAttribute("placeholder","Type"); document.body.appendChild(hint);
        const note=document.createElement("textarea"); note.id="note"; note.className="hint";
        note.setAttribute("placeholder","Notes"); document.body.appendChild(note);
        globalThis.close();
    `, {fileName:join(directory,"entry.ts")});
    assert.match(result.cpp, /UiGeneratedPart::Before/);
    assert.match(result.cpp, /UiContentPartKind::Attribute/);
    writeFileSync(join(directory,"program.hpp"),result.cpp);
    runRmlUiFixture(t,"ui-generated-content");
});
