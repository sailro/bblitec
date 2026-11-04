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
        ".panel{visibility:hidden;font-style:italic;text-transform:uppercase;text-overflow:ellipsis;transform-origin:left bottom;border-top:2px solid red;border-right:3px solid blue;border-bottom:4px solid green;border-left:5px solid black;border-width:1px 2px 3px 4px;border-top-color:#123456;-webkit-user-drag:none;-webkit-touch-callout:none}.panel.open{visibility:visible;transition:opacity 200ms linear,visibility 0s linear 200ms}",
    );
    assert.match(result.cpp, /border-top:2px solid red/);
    assert.match(result.cpp, /border-left:5px solid black/);
    assert.match(result.cpp, /visibility:hidden/);
    assert.match(result.cpp, /transform-origin:left bottom/);
    const projected = result.cpp
        .split("\n")
        .filter((line) => line.includes("bbl::ui_add_"))
        .join("\n");
    assert.doesNotMatch(projected, /-webkit-user-drag|-webkit-touch-callout/);
    for (const declaration of [
        "visibility:collapse",
        "font-style:oblique",
        "text-transform:full-width",
        "text-overflow:fade",
        "border-top:2px dotted red",
        "border-top-width:1px 2px",
        "border-width:-1px",
        "transform-origin:top 10px",
        "transform-origin:left right",
        "-webkit-user-drag:auto",
        "-webkit-touch-callout:default",
        "constructor:none",
    ]) {
        assert.throws(
            () => compile(`.panel{${declaration}}`),
            /Retained UI style property/,
        );
    }
});

test("border lines keep their style, spell CSS shorthand resets and dashed outlines project", () => {
    const result = compile(
        ".a{border:red 2px dashed}.b{border:none}.c{border-top:0}.d{border-style:dashed solid;border-left-style:hidden}.e{border:1px solid var(--Edge)}.f{outline:#fff dashed 2px}",
    );
    assert.match(result.cpp, /border:2px dashed red/);
    assert.match(result.cpp, /border:3px none/);
    assert.match(result.cpp, /border-top:0 none/);
    assert.match(result.cpp, /border-style:dashed solid/);
    assert.match(result.cpp, /border-left-style:hidden/);
    assert.match(result.cpp, /border:1px solid var\(--Edge\)/);
    assert.match(result.cpp, /--bbl-outline:2px dashed #fff/);
    // A zero-width outline draws nothing, as none does.
    assert.match(compile(".h{outline:0}").cpp, /--bbl-outline:none/);
    // `text-shadow: none` removes an inherited shadow.
    assert.match(compile(".g{text-shadow:none}").cpp, /font-effect:none/);
    // A generation-known style write lowers as a declaration does.
    const written = compileSource(
        prefix +
            `const panel=document.createElement("div");document.body.appendChild(panel);panel.style.border="red 2px dashed";panel.style.borderBottom="none";`,
    );
    assert.match(written.cpp, /"border", "2px dashed red"/);
    assert.match(written.cpp, /"border-bottom", "3px none"/);
    for (const declaration of [
        "border:1px dotted red",
        "border-bottom:2px double red",
        "border:1px solid red blue",
        "border-style:groove",
        "border-top-style:solid dashed",
        "outline:2px dotted #fff",
    ])
        assert.throws(
            () => compile(`.panel{${declaration}}`),
            /Retained UI style property/,
        );
});

test("keyword transform origins in either order and numeral font features project", () => {
    const result = compile(
        `.a{transform-origin:top right}.b{transform-origin:center left 2px}.c{font-feature-settings:"tnum"}`,
    );
    assert.match(result.cpp, /transform-origin:right top/);
    assert.match(result.cpp, /transform-origin:left center 2px/);
    const adaptation = result.manifest.adaptations.find(
        ({ id }) => id === "substituted-ui-runtime",
    );
    assert.match(adaptation?.nativeSemantics ?? "", /font-feature-settings/);
    assert.throws(
        () => compile(`.c{font-feature-settings:"liga" 0}`),
        /Retained UI style property 'font-feature-settings'/,
    );
    const write = compileSource(
        `${prefix}const panel=document.createElement("div");panel.style.transformOrigin="bottom left";document.body.appendChild(panel);`,
    );
    assert.match(
        write.cpp,
        /ui_set_style_property\([^;]+"transform-origin", "left bottom"\)/,
    );
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
    assert.match(
        result.cpp,
        /transition:scale 80ms linear,bbl-transform 80ms linear/,
    );
    assert.match(result.cpp, /bbl-zero-clip:1/);
    assert.match(result.cpp, /top:0px;right:1px;bottom:auto;left:1px/);
    assert.match(result.cpp, /--bbl-outline:3px solid white/);
    // Gradient images are the cascaded background image, as raster ones are.
    assert.match(
        compile(
            ".hub{background-image:radial-gradient(circle at 38% 32%, rgba(255,255,255,0.55), rgba(255,255,255,0) 60%),linear-gradient(red,blue)}",
        ).cpp,
        /--bbl-background-image:radial-gradient\(circle at 38% 32%, rgba\(255,255,255,0\.55\), rgba\(255,255,255,0\) 60%\),linear-gradient\(red,blue\)/,
    );
    // An explicit size is a decorator layer's own box.
    assert.match(
        compile(".panel{background-size:20px 40px}").cpp,
        /--bbl-background-size:20px 40px/,
    );
    for (const declaration of [
        "background-image:linear-gradient(red,blue) no-repeat",
        "background-image:url(a.png),linear-gradient(red,blue)",
        "background-size:20px auto",
        "background-position:right bottom",
        "background-repeat:space",
        "scale:1 2",
        "clip:rect(1px,2px,3px,4px)",
    ])
        assert.throws(
            () => compile(`.panel{${declaration}}`),
            /Retained UI style property/,
        );
});
