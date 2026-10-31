import test from "node:test";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// CSS Color 4's space-separated rgb() in a sheet and an inline write.
const program = `
    const style = document.createElement("style");
    style.textContent = ".panel { width: 4px; height: 4px; background: rgb(21 22 38 / 88%); color: rgba(100% 50% 0%); }";
    document.head.appendChild(style);
    for (const id of ["sheet", "inline"]) {
        const panel = document.createElement("div");
        panel.id = id;
        panel.className = "panel";
        document.body.appendChild(panel);
    }
    document.getElementById("inline")!.style.backgroundColor = \`rgb(\${Number("10")} 20 30 / 0.5)\`;
    globalThis.close();
`;

test("space-separated rgb() colours run natively from sheets and inline writes", (t) => {
    runApplicationRmlUiFixture(t, "ui-space-colors", program);
});
