import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

function compileSheet(css: string) {
    return compileSource(`import {createEngine} from '@babylonjs/lite';await createEngine({});
        const sheet=document.createElement('style');sheet.textContent=${JSON.stringify(css)};document.head.appendChild(sheet);`);
}

test("max-width rules share ordinary retained declaration admission", () => {
    const result = compileSheet(`.panel{display:flex;flex-wrap:nowrap}
        @media(max-width:480px){.panel{flex-wrap:wrap;margin-left:14px;text-align:right;background:red;opacity:.7}}
        @media(max-width:480px){.panel::before{content:"";width:10px;height:10px;background:blue}}
    `);
    assert.match(
        result.cpp,
        /false, 480\.0, "flex-wrap:wrap;margin-left:14px;text-align:right;/,
    );
    for (const condition of [
        "max-width:480px",
        "prefers-reduced-motion:reduce",
    ])
        assert.match(
            compileSheet(
                `@media(${condition}){.panel{display:grid;grid-template-columns:repeat(2,20px)}}`,
            ).cpp,
            /grid-template-columns:repeat\(2,20px\)/,
        );
    assert.throws(
        () => compileSheet("@media(max-width:480px){.panel{unrepresented:1}}"),
        /style property/,
    );
});

test("scroll behavior retains axis longhands, shorthand order and live style writes", () => {
    const result = compileSheet(
        ".panel{overflow:auto;overscroll-behavior:auto contain;overscroll-behavior-x:none}@media(max-width:480px){.panel{overscroll-behavior-y:none}}",
    );
    assert.match(
        result.cpp,
        /overscroll-behavior:auto contain;overscroll-behavior-x:none/,
    );
    const live = compileSource(
        `import {createEngine} from '@babylonjs/lite';await createEngine({});const panel=document.createElement('div');document.body.appendChild(panel);panel.style.overscrollBehaviorY='contain';panel.style.removeProperty('overscroll-behavior-y');`,
    );
    assert.match(live.cpp, /"overscroll-behavior-y", "contain"/);
    for (const css of [
        "overscroll-behavior:contain none auto",
        "overscroll-behavior-y:auto none",
        "overscroll-behavior-x:scroll",
    ])
        assert.throws(() => compileSheet(`.panel{${css}}`), /style property/);
});

test("native scroll containment and media cascades retain layout and axis behavior", (t) =>
    runRmlUiFixture(t, "ui-scroll-media"));

test("stable scrollbar gutters share static, media and live style admission", () => {
    const result = compileSheet(
        ".panel{overflow-y:auto;scrollbar-gutter:stable;scrollbar-width:thin}@media(max-width:480px){.panel{scrollbar-gutter:auto}}",
    );
    assert.match(result.cpp, /scrollbar-gutter:stable/);
    assert.match(result.cpp, /480\.0, "scrollbar-gutter:auto"/);
    assert.throws(
        () => compileSheet(".panel{scrollbar-gutter:stable both-edges}"),
        /style property/,
    );
});
