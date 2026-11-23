import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("cloneNode lowers to a detached native copy, deep or shallow", () => {
    const { cpp } = compileSource(`
        const plate = document.createElement("div");
        const footer = document.createElement("div");
        footer.className = "footer";
        const coin = document.createElement("button");
        coin.addEventListener("click", () => console.log("follow"));
        footer.appendChild(coin);
        plate.appendChild(footer);
        document.body.appendChild(plate);
        const found = plate.querySelector(".footer");
        const measured = document.createElement("div");
        if (found) measured.appendChild(found.cloneNode(true));
        measured.appendChild(footer.cloneNode());
        document.body.appendChild(measured);
    `);
    assert.match(cpp, /bbl::ui_clone_node\([^;]*, true\)/);
    assert.match(cpp, /bbl::ui_clone_node\([^;]*, false\)/);
});

test("native clones copy attributes, style, text and children but no listeners", (t) =>
    runRmlUiFixture(t, "ui-clone-node"));
