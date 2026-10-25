import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { PageNesting } from "../src/compiler/page-nesting.js";
import { createCompilerProgram } from "../src/compiler/program.js";

// Which page elements, found by id, may sit inside which while the program
// runs: the host markup's tree, with what the program inserts.

function nesting(program: string): PageNesting {
    const frontend = createCompilerProgram(
        `
const panel = document.getElementById("panel") as HTMLDivElement;
const play = document.getElementById("play") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLDivElement;
${program}`,
        resolve("page-nesting.ts"),
    );
    return new PageNesting(frontend.checker, [frontend.sourceFile], {
        elements: [
            {
                tag: "div",
                attributes: { id: "panel" },
                children: [{ tag: "button", attributes: { id: "play" } }],
            },
            { tag: "div", attributes: { id: "status" } },
        ],
    });
}

test("the host markup places its elements", () => {
    const page = nesting("");
    assert.ok(page.mayContain("panel", "play"));
    assert.ok(page.mayContain("play", "play"));
    assert.ok(!page.mayContain("play", "panel"));
    assert.ok(!page.mayContain("status", "play"));
    // An element no markup holds may sit anywhere.
    assert.ok(page.mayContain("status", "missing"));
});

test("a node the program inserts sits under its receiver", () => {
    assert.ok(
        nesting("status.appendChild(play);").mayContain("status", "play"),
    );
    assert.ok(
        nesting(
            'const row = document.createElement("div");\nstatus.append(row);\nrow.appendChild(play);',
        ).mayContain("status", "play"),
    );
    // Inserting under the document's body places nothing inside an element.
    assert.ok(
        !nesting("document.body.appendChild(play);").mayContain(
            "status",
            "play",
        ),
    );
});

test("parsed markup, an assigned id or a node no insertion places may put any element anywhere", () => {
    assert.ok(
        nesting('status.innerHTML = "<b>x</b>";').mayContain("status", "play"),
    );
    assert.ok(
        nesting(
            'const row = document.createElement("div");\nrow.id = "play";\nstatus.appendChild(row);',
        ).mayContain("status", "play"),
    );
    assert.ok(
        nesting(
            "function attach(parent: HTMLElement, child: HTMLElement): void { parent.appendChild(child); }\nattach(status, play);",
        ).mayContain("status", "play"),
    );
});
