import test from "node:test";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// Page markup keeps the white space between its tags. CSS removes the
// collapsible white space ending a line and lays out none between blocks, in
// flex and in grid containers; the check compares each box with a twin whose
// markup has no such white space.
test("collapsible white space in page markup takes no layout space", (t) => {
    runApplicationRmlUiFixture(
        t,
        "ui-whitespace-layout",
        "globalThis.close();",
        {},
        `<!doctype html><html><head><title>White space</title><style>
        body { margin: 0; font: 13px sans-serif; }
        .label { display: flex; align-items: center; gap: 8px; white-space: nowrap; float: left; clear: left; }
        .dot { width: 9px; height: 9px; }
        .fit { float: left; clear: left; }
        .stack { float: left; clear: left; width: 200px; padding: 1px; }
        .first { height: 10px; margin-bottom: 12px; }
        .second { height: 10px; margin-top: 8px; }
        .grid { float: left; clear: left; display: grid; grid-template-columns: 40px 40px; gap: 8px; }
        .cell { height: 10px; }
        .words { float: left; clear: left; white-space: nowrap; }
        </style></head><body>
        <div id="spaced" class="label"><span class="dot"></span>Main thread <span>Canvas</span></div>
        <div id="tight" class="label"><span class="dot"></span>Main thread<span>Canvas</span></div>
        <div id="trailing" class="fit"><b>Bold text </b></div>
        <div id="bare" class="fit"><b>Bold text</b></div>
        <div id="credit" class="fit">
            <b>Bold text</b> by an author · CC BY 4.0
        </div>
        <div id="credit-bare" class="fit"><b>Bold text</b> by an author · CC BY 4.0</div>
        <div id="blocks" class="stack">
            <div class="first"></div>
            <div class="second"></div>
        </div>
        <div id="hidden-between" class="stack">
            <div class="first"></div>
            <p hidden></p>
            <div hidden></div>
            <div class="second"></div>
        </div>
        <div id="flow" class="stack"><div class="first"></div><div class="second"></div></div>
        <div id="cells" class="grid">
            <span class="cell"></span>
            <span class="cell"></span>
        </div>
        <div id="packed" class="grid"><span class="cell"></span><span class="cell"></span></div>
        <div id="words" class="words"><b>A</b> <b>D</b></div>
        <div id="words-wrap" class="fit"><b>A</b> <b>D</b></div>
        <div id="glued" class="words"><b>A</b><b>D</b></div>
        <script type="module" src="/entry.ts"></script></body></html>`,
    );
});
