import assert from "node:assert/strict";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {uiStyleSelector} from "../src/ui-style-rule.js";
import {runRmlUiFixture} from "./native-fixture.js";

function compileSheet(css:string) {
    return compileSource(`import {createEngine} from '@babylonjs/lite';await createEngine({});
        const sheet=document.createElement('style');sheet.textContent=${JSON.stringify(css)};document.head.appendChild(sheet);
        const range=document.createElement('input');range.type='range';range.className='level';document.body.appendChild(range);`);
}

test("range parts retain originating selectors, part states and authored decorations",()=>{
    const result=compileSheet(`.level{appearance:none;width:120px;height:10px}
        .level::-webkit-slider-thumb{appearance:none;width:18px;height:18px;margin-top:-4px;border-radius:4px;background:linear-gradient(white,red);box-shadow:0 2px 3px blue}
        .panel > input:disabled::-webkit-slider-thumb{opacity:0.5}
        .level::-webkit-slider-thumb:hover{background:green}
        .level::-webkit-slider-runnable-track{height:10px;background:#888}
        @media(max-width:720px){.level::-webkit-slider-thumb{width:20px}}
    `);
    assert.match(result.cpp,/UiRangePart::Thumb/);
    assert.match(result.cpp,/UiRangePart::Track/);
    assert.match(result.cpp,/UiSelectorTestKind::Disabled/);
    assert.match(result.cpp,/margin-top:-4px/);
    assert.equal(uiStyleSelector({kind:"class",primary:"level",range:"thumb",hover:true}),".level::-webkit-slider-thumb:hover");
    assert.throws(()=>compileSheet('.level::-webkit-slider-thumb:horizontal{background:red}'),/selector.*not lowered/);
    assert.throws(()=>compileSheet('.level::-webkit-slider-thumb::before{content:"x"}'),/selector.*not lowered/);
    assert.throws(()=>compileSheet('.level::-webkit-slider-thumb{content:"x"}'),/content.*before\/after/);
});

test("Gecko range rules follow Chromium selector-list rejection without changing the live cascade",()=>{
    const result=compileSheet(`.level::-webkit-slider-thumb{background:red}
        .level::-moz-range-thumb{background:blue;unrepresented-gecko-property:1}
        .level, .level::-moz-range-track{width:999px}
        .level::-moz-range-progress{background:green}
        .level{width:120px}
    `);
    const emitted=result.cpp.split('\n').filter(line=>line.includes('bbl::ui_add_')).join('\n');
    assert.match(emitted,/background-color:red/);
    assert.match(emitted,/width:120px/);
    assert.doesNotMatch(emitted,/blue|green|999|gecko/);
    assert.throws(()=>compileSheet('.level::-moz-range-unrepresented{width:20px}'),/selector.*not lowered/);
    assert.throws(()=>compileSheet('[data-kind="::-moz-range-thumb"]{unrepresented:1}'),/style property/);
});

test("native custom range parts preserve dimensions, cascade, values and control input",t=>runRmlUiFixture(t,"ui-range-parts"));

test("host range rules share target validation and native emission",()=>{
    const source="import {createEngine} from '@babylonjs/lite';await createEngine({});";
    const host={sourcePath:"fixture.json",elements:[],styleRules:[{kind:"class" as const,primary:"level",range:"thumb" as const,style:"appearance:none;width:18px"}]};
    assert.match(compileSource(source,{nativeHostUi:host}).cpp,/ui_add_host_style_rule[^\n]*UiRangePart::Thumb/);
    assert.throws(()=>compileSource(source,{nativeHostUi:{...host,styleRules:[{...host.styleRules[0]!,scrollbar:"thumb"}]}}),/exclusive thumb or track/);
    assert.throws(()=>compileSource(source,{nativeHostUi:{...host,styleRules:[{...host.styleRules[0]!,style:"outline:1px solid red"}]}}),/requires an authored retained element/);
});
