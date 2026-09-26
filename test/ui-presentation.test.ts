import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

const prefix =
    'import {createEngine} from "@babylonjs/lite";await createEngine({});const sheet=document.createElement("style");';
const compile = (css: string) =>
    compileSource(
        prefix +
            `sheet.textContent=${JSON.stringify(css)};document.head.appendChild(sheet);`,
    );

test("retained presentation declarations preserve border sides, text styles and transform origins", () => {
    const result = compile(
        ".panel{visibility:hidden;font-style:italic;text-transform:uppercase;text-overflow:ellipsis;transform-origin:left bottom;border-top:2px solid red;border-right:3px solid blue;border-bottom:4px solid green;border-left:5px solid black;border-width:1px 2px 3px 4px;border-top-color:#123456;-webkit-user-drag:none}.panel.open{visibility:visible;transition:opacity 200ms linear,visibility 0s linear 200ms}",
    );
    assert.match(result.cpp, /border-top:2px red/);
    assert.match(result.cpp, /border-left:5px black/);
    assert.match(result.cpp, /visibility:hidden/);
    assert.match(result.cpp, /transform-origin:left bottom/);
    const projected = result.cpp
        .split("\n")
        .filter((line) => line.includes("bbl::ui_add_"))
        .join("\n");
    assert.doesNotMatch(projected, /-webkit-user-drag/);
    for (const declaration of [
        "visibility:collapse",
        "font-style:oblique",
        "text-transform:full-width",
        "text-overflow:fade",
        "border-top:2px dashed red",
        "border-top-width:1px 2px",
        "border-width:-1px",
        "transform-origin:top left",
        "-webkit-user-drag:auto",
        "constructor:none",
    ]) {
        assert.throws(
            () => compile(`.panel{${declaration}}`),
            /Retained UI style property/,
        );
    }
});

test("native presentation styles preserve box edges, formatting and live replacement", (t) => {
    runRmlUiFixture(t, "ui-presentation");
});

test("image controls retain transparent text, composed transforms, empty clips and viewport orientation", () => {
    const result = compile(`:root{--control-size:10vw}
        @media (orientation:portrait){:root{--control-size:20vw}}
        button{background:center center / contain no-repeat;color:transparent;transform:rotate(0.25rad);transition:scale 80ms linear,transform 80ms linear;-webkit-tap-highlight-color:transparent}
        button:active{scale:0.95}
        button::before{content:"";background-image:inherit;background-size:contain;transform:rotate(var(--angle))}
        .hidden-label{clip:rect(0px,0px,0px,0px)}
        .panel{inset:0px 1px auto;outline:white solid 3px}`);
    assert.match(result.cpp, /UiSelectorTestKind::Root/);
    assert.match(result.cpp, /UiOrientation::Portrait/);
    assert.match(result.cpp, /color:transparent/);
    assert.match(result.cpp, /bbl-background-size:contain/);
    assert.match(result.cpp, /bbl-background-image:inherit/);
    assert.match(result.cpp, /bbl-transform:rotate/);
    assert.match(result.cpp, /transition:scale 80ms linear,bbl-transform 80ms linear/);
    assert.match(result.cpp, /bbl-zero-clip:1/);
    assert.match(result.cpp, /top:0px;right:1px;bottom:auto;left:1px/);
    assert.match(result.cpp, /--bbl-outline:3px solid white/);
    for (const declaration of ["background-image:linear-gradient(red,blue)", "background-size:20px 40px", "background-position:right bottom", "background-repeat:space", "scale:1 2", "clip:rect(1px,2px,3px,4px)"])
        assert.throws(() => compile(`.panel{${declaration}}`), /Retained UI style property/);
});
