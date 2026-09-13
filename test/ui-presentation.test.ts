import assert from "node:assert/strict";
import test from "node:test";
import {compileSource} from "../src/compiler.js";
import {runRmlUiFixture} from "./native-fixture.js";

const prefix='import {createEngine} from "@babylonjs/lite";await createEngine({});const sheet=document.createElement("style");';
const compile=(css:string)=>compileSource(prefix+`sheet.textContent=${JSON.stringify(css)};document.head.appendChild(sheet);`);

test("retained presentation declarations preserve border sides, text styles and transform origins",()=>{
    const result=compile('.panel{visibility:hidden;font-style:italic;text-transform:uppercase;text-overflow:ellipsis;transform-origin:left bottom;border-top:2px solid red;border-right:3px solid blue;border-bottom:4px solid green;border-left:5px solid black;border-width:1px 2px 3px 4px;border-top-color:#123456;-webkit-user-drag:none}.panel.open{visibility:visible;transition:opacity 200ms linear,visibility 0s linear 200ms}');
    assert.match(result.cpp,/border-top:2px red/);
    assert.match(result.cpp,/border-left:5px black/);
    assert.match(result.cpp,/visibility:hidden/);
    assert.match(result.cpp,/transform-origin:left bottom/);
    const projected=result.cpp.split("\n").filter(line=>line.includes("bbl::ui_add_")).join("\n");
    assert.doesNotMatch(projected,/-webkit-user-drag/);
    for(const declaration of ['visibility:collapse','font-style:oblique','text-transform:full-width','text-overflow:fade','border-top:2px dashed red','border-top-width:1px 2px','border-width:-1px','transform-origin:top left','-webkit-user-drag:auto','constructor:none']) {
        assert.throws(()=>compile(`.panel{${declaration}}`),/Retained UI style property/);
    }
});

test("native presentation styles preserve box edges, formatting and live replacement",t=>{
    runRmlUiFixture(t,"ui-presentation");
});
