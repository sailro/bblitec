import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// Transforms Chromium 157 serializes as the comments in the check give them:
// translations in px and percentages of the border box, rotations, scales, a
// composition, a list beside the individual `scale`, 3D functions and matrix
// writes; then, at a transition's end a quarter through a 1000ms animation
// and a transition between mismatched lists, the animated element's value is
// frozen into its inline transform.
const program = `
    const sheet = document.createElement("style");
    sheet.textContent = \`
        .box { position: absolute; left: 0; top: 0; width: 100px; height: 80px; }
        .framed { padding: 10px; border: 5px solid black; }
        .halved { scale: 0.5; }
        @keyframes orbit { from { transform: translate(0px, -36px); } to { transform: translate(36px, 0px); } }
        .orbit { position: absolute; left: 200px; top: 200px; width: 42px; height: 42px; }
        .orbit.on { animation: orbit 1000ms linear infinite; }
        .mixed { transform: rotate(0deg); transition: transform 1000ms linear; }
        .mixed.moved { transform: translate(100px, 0); }
        .clock { width: 4px; height: 4px; opacity: 1; transition: opacity 240ms linear; }
        .clock.off { opacity: 0; }
    \`;
    document.head.appendChild(sheet);
    const make = (id: string, className: string, transform: string): HTMLDivElement => {
        const element = document.createElement("div");
        element.id = id;
        element.className = className;
        if (transform !== "") element.style.transform = transform;
        document.body.appendChild(element);
        return element;
    };
    const log = make("log", "", "");
    const plain = make("plain", "box", "");
    const pixels = make("pixels", "box", "translate(10px, 20px)");
    const percent = make("percent", "box", "translate(50%, -25%)");
    const framed = make("framed", "box framed", "translate(50%, 50%)");
    const quarter = make("quarter", "box", "rotate(90deg)");
    const turned = make("turned", "box", "rotate(30deg)");
    const scaled = make("scaled", "box", "scale(2, 0.5)");
    const composed = make("composed", "box", "translate(-50%, -50%) scale(.94)");
    const halved = make("halved", "box halved", "translate(10px, 0)");
    const deep = make("deep", "box", "perspective(100px) rotateY(30deg)");
    const lifted = make("lifted", "box", "translateZ(10px)");
    const axis = make("axis", "box", "rotate3d(1, 1, 0, 60deg)");
    const written = make("written", "box", "matrix(1, 0, 0, 1, 1e+06, 1e-07)");
    const affine = make("affine", "box", "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1)");
    const orbit = make("orbit", "orbit", "");
    const mixed = make("mixed", "box mixed", "");
    const clock = make("clock", "clock", "");
    const report = (): string =>
        [
            getComputedStyle(plain).transform,
            getComputedStyle(pixels).transform,
            getComputedStyle(percent).transform,
            getComputedStyle(framed).transform,
            getComputedStyle(quarter).transform,
            getComputedStyle(turned).transform,
            getComputedStyle(scaled).transform,
            getComputedStyle(composed).transform,
            getComputedStyle(halved).transform,
            getComputedStyle(deep).transform,
            getComputedStyle(lifted).transform,
            getComputedStyle(axis).transform,
            getComputedStyle(written).getPropertyValue("transform"),
            getComputedStyle(affine).transform,
            getComputedStyle(mixed).transform,
        ].join(";");
    // A first read requests the values the next layout serializes.
    log.textContent = report() + "|" + getComputedStyle(orbit).transform;
    clock.addEventListener("transitionend", () => {
        const frozen = getComputedStyle(orbit).transform;
        orbit.style.animation = "none";
        orbit.style.transition = "none";
        orbit.style.transform = frozen === "none" ? "translate(0, 0)" : frozen;
        log.textContent = report() + "|" + frozen;
    });
    globalThis.close();
`;

test("getComputedStyle(element).transform lowers to the native serialization", () => {
    const { cpp } = compileSource(program);
    assert.match(cpp, /bbl::ui_computed_style\([^;]*v_orbit[^;]*"transform"\)/);
    assert.match(
        cpp,
        /bbl::ui_computed_style\([^;]*v_written[^;]*"transform"\)/,
    );
    assert.match(
        cpp,
        /bbl::ui_set_style_property\([^;]*v_orbit[^;]*"bbl-transform", [^;]*v_\w*frozen/,
    );
    assert.throws(
        () =>
            compileSource(`
                const panel = document.createElement("div");
                document.body.appendChild(panel);
                panel.textContent = getComputedStyle(panel).translate;
            `),
        /Computed style 'translate' is not represented; display, opacity, transform, visibility/,
    );
});

test("native computed transforms serialize as Chromium and freeze an animation", (t) =>
    runApplicationRmlUiFixture(t, "ui-computed-transform", program, {
        BBLITE_HAS_DOM_INPUT: 1,
    }));
