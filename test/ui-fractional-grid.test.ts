import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {compileSource, CompileError} from "../src/compiler.js";
import {readNativeHostUi} from "../src/native-host-ui.js";

const source = `import {createEngine,startEngine} from '@babylonjs/lite';
async function main() {const engine=await createEngine({});await startEngine(engine);}main();`;
const host = () => readNativeHostUi("ui/scene180-host.json");

test("fractional host grids preserve explicit track order and form border-box sizing", () => {
    const result=compileSource(source,{nativeHostUi:host()});
    assert.match(result.cpp,/--bbl-fr-grid-tracks:70px 1fr 48px/);
    assert.match(result.cpp,/box-sizing: border-box/);
    assert.match(result.cpp,/Drag canvas to move/);
    assert.match(result.cpp,/Scroll wheel to scale/);
    assert.match(readFileSync("native/src/pal_ui_defaults.hpp","utf8"),/input\[type=range\]/);
});

test("fractional host grids refuse implicit rows and unsupported track syntax", () => {
    for (const mutation of ["extra-child", "missing-child", "minmax", "negative", "rows"]) {
        const ui=host();
        const row=ui.elements[0]!.children![1]!.children![0]!;
        if(mutation==="extra-child") row.children!.push({tag:"span",text:"extra"});
        else if(mutation==="missing-child") row.children!.pop();
        else if(mutation==="minmax") row.attributes!.style=row.attributes!.style!.replace("1fr","minmax(0,1fr)");
        else if(mutation==="negative") row.attributes!.style=row.attributes!.style!.replace("1fr","-1fr");
        else row.attributes!.style += ";grid-template-rows:repeat(1,20px);";
        assert.throws(()=>compileSource(source,{nativeHostUi:ui}),CompileError,mutation);
    }
});
