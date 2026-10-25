import test from "node:test";
import { join, resolve } from "node:path";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { runRmlUiFixture } from "./native-fixture.js";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// Animations, a visibility-hidden one, one under display:none and a transition.
const program = `
    const sheet = document.createElement("style");
    sheet.textContent = \`
        .box { width: 10px; height: 4px; opacity: 0.5; }
        .plain.go { animation: fade 100ms linear; }
        .forwards.go { animation: fade 100ms linear forwards; }
        .hidden { visibility: hidden; }
        .hidden.go, .collapsed.go { animation: fade 100ms linear infinite; }
        .closed { display: none; }
        .fade { transition: opacity 100ms linear; }
        .fade.go { opacity: 1; }
        @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    \`;
    document.head.appendChild(sheet);
    const closed = document.createElement("div");
    closed.className = "closed";
    document.body.appendChild(closed);
    for (const id of ["plain", "forwards", "hidden", "collapsed", "fade"]) {
        const element = document.createElement("div");
        element.id = id;
        element.className = id + " box";
        if (id === "collapsed") closed.appendChild(element);
        else document.body.appendChild(element);
    }
    const field = document.createElement("input");
    field.id = "field";
    document.body.appendChild(field);
    for (const id of ["title", "banner"]) {
        const text = document.createElement("div");
        text.id = id;
        text.textContent = id;
        document.body.appendChild(text);
    }
    globalThis.close();
`;

test("time-driven UI work reports when it next changes the document", (t) => {
    runApplicationRmlUiFixture(t, "ui-next-update", program);
});

test("capture frames wait for the Window display only for changes or due time-driven work", (t) => {
    const output = resolve("artifacts/window-rendering-updates");
    emitUpstreamGenerated(output, ["core", "backend:sdl"]);
    runRmlUiFixture(t, "window-rendering-updates", {
        macros: {
            BBLITE_HAS_ENGINE: 0,
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
            BBLITE_HAS_PBR_RENDERER: 0,
            BBLITE_HAS_SDL_GPU: 1,
            BBLITE_HAS_DAWN: 0,
        },
        includeDirectories: [join(output, "upstream/include")],
    });
});
