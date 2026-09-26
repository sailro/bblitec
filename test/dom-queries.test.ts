import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("retained DOM queries observe authored tree changes and return ordered snapshots", (t) => {
    const directory = resolve("artifacts/dom-queries");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const root = document.createElement("div");
        root.id = "panel";
        const first = document.createElement("button");
        first.id = "query-leaf";
        first.className = "entry";
        const second = document.createElement("button");
        second.className = "entry last";
        const third = document.createElement("div");
        third.id = "other";
        root.appendChild(first);
        root.appendChild(second);
        document.body.appendChild(root);
        document.body.appendChild(third);
        if (root.querySelector(".entry") !== first) throw new Error("first match");
        if (root.querySelector("#panel") !== null) throw new Error("scope excludes root");
        if (root.querySelector(".absent") !== null) throw new Error("missing match");
        if (root.querySelectorAll(".absent").length !== 0) throw new Error("empty snapshot");
        if (document.querySelector("body > #panel > button.entry") !== first) throw new Error("document query");
        const snapshot = root.querySelectorAll(".last, .entry");
        if (snapshot.length !== 2 || snapshot[0] !== first || snapshot[1] !== second) throw new Error("ordered unique snapshot");
        const copied = Array.from(root.querySelectorAll(".entry"));
        if (copied.length !== 2 || copied[1] !== second) throw new Error("NodeList Array.from");
        if (!second.matches("button.entry:nth-child(2):not(.missing)")) throw new Error("compound match");
        if (second.closest("#panel") !== root || second.closest("button") !== second) throw new Error("closest includes self");
        if (!root.matches("div:has(> button.last)")) throw new Error("relative match");
        function find(parent: HTMLElement): Element | null { return parent.querySelector(".entry"); }
        if (find(root) !== first) throw new Error("helper query");
        third.appendChild(first);
        second.classList.remove("entry");
        if (snapshot.length !== 2 || snapshot[0] !== first || snapshot[1] !== second) throw new Error("snapshot lifetime");
        if (root.querySelector(".entry") !== null || third.querySelector(".entry") !== first) throw new Error("live tree");
        if (document.querySelectorAll("#panel, #other").length !== 2) throw new Error("document snapshot");
        const absent = document.getElementById("missing");
        const optional = absent?.querySelector(".entry") ?? null;
        if (optional !== null) throw new Error("optional root");
        const optionalList = absent?.querySelectorAll(".entry") ?? [];
        if (optionalList.length !== 0) throw new Error("optional snapshot");
        const chained = document.querySelector("#other")?.querySelector(".entry");
        if (chained !== first) throw new Error("chained query");
        third.remove();
        if (third.querySelector(".entry") !== first || first.closest("#other") !== third) throw new Error("detached tree");
        if (document.querySelector("#other") !== null) throw new Error("detached document query");
        function ancestor(event: Event): Element | null { return (event.target as HTMLElement).closest("#other"); }
        first.addEventListener("pointerdown", event => {
            if (ancestor(event) !== third || (event.target as HTMLElement).closest("button") !== first)
                throw new Error("event target closest identity");
            if (!(event.target as HTMLElement).matches("button.entry") || (event.target as HTMLElement).closest(".absent") !== null)
                throw new Error("event target selector semantics");
            first.setAttribute("data-event-query", "complete");
        });
        const log = document.createElement("div");
        log.id = "query-log";
        log.textContent = "complete";
        document.body.appendChild(log);
        globalThis.close();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.match(result.cpp, /bbl::ui_query_element\(/);
    assert.match(result.cpp, /bbl::ui_query_elements\(/);
    assert.match(result.cpp, /bbl::ui_matches_element\(/);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "dom-queries", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
        },
    });
});

test("retained queries refuse unrepresented selector and interaction forms", () => {
    const preamble = `import {createEngine} from "@babylonjs/lite"; await createEngine({}); const root = document.createElement("div");`;
    for (const selector of [
        "",
        ".entry,",
        ".entry::before",
        ":scope > .entry",
        ".entry:hover",
        ":has(:focus)",
    ]) {
        assert.throws(
            () =>
                compileSource(
                    `${preamble} const found = root.querySelector(${JSON.stringify(selector)});`,
                ),
            /Retained DOM query/,
        );
    }
});
