import assert from "node:assert/strict";
import {mkdirSync, writeFileSync} from "node:fs";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {readNativeHostUi} from "../src/native-host-ui.js";
import {runRmlUiFixture} from "./native-fixture.js";

const source = (css: string) => `import {createEngine} from '@babylonjs/lite';await createEngine({});
    const sheet=document.createElement('style');sheet.textContent=${JSON.stringify(css)};document.head.appendChild(sheet);`;

test("container rules preserve conditions across source and host emission", () => {
    const css = `.parent{container-type:inline-size}.reset{container-type:normal}
        @media(max-width:800px){@container(max-width:320px){.row{display:grid;grid-template-columns:1fr}.row:hover{opacity:.5}}}
        @container(max-width:320px){@container(max-width:200px){.small{height:10px}}}
        @container(max-width:320px){@media(prefers-reduced-motion:reduce){.row{transition:none}}}`;
    const result=compileSource(source(css));
    assert.match(result.cpp,/container-type:inline-size/);
    assert.match(result.cpp,/800\.0, "display:grid;grid-template-columns:1fr"[^\n]*320\.0\);/);
    assert.match(result.cpp,/"small"[^\n]*200\.0\);/);
    assert.match(result.cpp,/UiMotionPreference::Reduce[^\n]*320\.0\);/);
    mkdirSync("artifacts/ui-container-queries",{recursive:true});
    const path="artifacts/ui-container-queries/host.json";
    writeFileSync(path,JSON.stringify({elements:[],styleRules:[{kind:"class",primary:"row",style:"height:20px",containerMaxWidth:320},
        {kind:"sequence",primary:"input[type=range]",style:"height:8px",range:"thumb",containerMaxWidth:320}]}));
    const host=readNativeHostUi(path);
    assert.equal(host.styleRules?.[0]?.containerMaxWidth,320);
    assert.match(compileSource(source(""),{nativeHostUi:host}).cpp,/ui_add_host_style_rule[^\n]*320\.0\);/);
});

test("container admission refuses unrepresented query forms and native implementation selectors", () => {
    for(const header of ["@container sidebar (max-width:320px)","@container(min-width:320px)","@container(max-height:320px)","@container style(--theme:dark)","@container(max-width:-1px)","@container(max-width:2em)"])
        assert.throws(()=>compileSource(source(`${header}{.row{height:20px}}`)),/Retained stylesheet selector/);
    for(const value of ["size","scroll-state","inline-size scroll-state"])
        assert.throws(()=>compileSource(source(`.row{container-type:${value}}`)),/container-type/);
    assert.throws(()=>compileSource(source('.row:bbl-container-max-width(320){height:20px}')),/Retained stylesheet selector/);
});

test("native size queries settle nearest-container cascades and intrinsic containment", t => runRmlUiFixture(t,"ui-container-queries"));
