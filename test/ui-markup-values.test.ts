import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("closed markup values preserve snapshots, conditional order, queries and lazy text evaluation", (t) => {
    const directory = resolve("artifacts/ui-markup-values");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(
        `
        let label = 'old <span>&"data-bbl-node=0"</span>';
        let reads = 0;
        function readLabel(): string { reads++; return label; }
        function action(text: string): string { return '<button id="go" class="choice go">π🎮' + text + '後</button>'; }
        function build(stack: boolean, id: string): void {
            const root = document.createElement("div");
            root.id = id;
            const cancelHtml = '<button class="choice cancel">' + readLabel() + '</button>';
            const goHtml = action(readLabel());
            const alias = goHtml;
            label = "changed after capture";
            root.innerHTML = '<div class="choices' + (stack ? ' stacked' : '') + '">' +
                (stack ? alias + cancelHtml : cancelHtml + alias) + '</div>';
            const choices = root.querySelectorAll(".choice");
            if (choices.length !== 2) throw new Error("markup query cardinality");
            const first = choices[0];
            if (first.getAttribute("class") !== (stack ? "choice go" : "choice cancel")) throw new Error("markup query order");
            const go = root.querySelector(".go") as HTMLElement;
            if (go !== root.querySelector("#go")) throw new Error("markup query identity");
            if (go !== choices[stack ? 0 : 1]) throw new Error("markup query branch");
            if (alias !== '<button id="go" class="choice go">π🎮old <span>&"data-bbl-node=0"</span>後</button>') throw new Error("ordinary string value changed");
            document.body.append(root);
        }
        const dynamic = performance.now() >= 0;
        build(dynamic, "stacked");
        label = 'old <span>&"data-bbl-node=0"</span>';
        build(!dynamic, "horizontal");
        if (reads !== 4) throw new Error("markup reevaluated its initializer");
        let order = "";
        function mark(value: string): string { order += value; return value; }
        const ordered = document.createElement("div");
        ordered.id = "ordered";
        ordered.innerHTML = '<div>' + mark("A") + (mark("B") === "B" ? '<span>' + mark("C") + '</span>' : '<span>' + mark("D") + '</span>') + mark("E") + '</div>';
        if (order !== "ABCE") throw new Error("markup evaluation order");
        document.body.append(ordered);
        let mutableText = readLabel();
        function changeText(next: string): string { mutableText = next; return next; }
        const laterSpan = document.createElement("div");
        laterSpan.id = "later-span";
        laterSpan.innerHTML = '<div>' + (dynamic ? '<span>' + mutableText + '</span>' : '<span>unused</span>') + '<span>' + changeText("after span") + '</span></div>';
        document.body.append(laterSpan);
        const laterCondition = document.createElement("div");
        laterCondition.id = "later-condition";
        laterCondition.innerHTML = '<div>' + mutableText + (changeText("after condition") === "after condition" ? '<span>' + mutableText + '</span>' : '<span>unused</span>') + '</div>';
        document.body.append(laterCondition);
        const optional = document.createElement("div");
        optional.innerHTML = dynamic ? "<span>empty</span>" : '<button class="absent">possible</button>';
        if (optional.querySelector(".absent") !== null) throw new Error("absent selected markup");
        if (optional.querySelectorAll(".absent").length !== 0) throw new Error("absent markup list");
        const changed = document.createElement("div");
        changed.innerHTML = dynamic ? '<span class="target"></span><span class="other"></span>' : '<span class="other"></span><span class="target"></span>';
        const previous = changed.querySelector(".target") as HTMLElement;
        const next = changed.querySelector(".other") as HTMLElement;
        previous.className = "other";
        next.className = "target";
        if (changed.querySelector(".target") !== next) throw new Error("live markup class query");
        if (changed.querySelectorAll(".target").length !== 1) throw new Error("live markup class list");
        const replaced = document.createElement("div");
        replaced.innerHTML = dynamic ? '<span class="old"></span>' : '<button class="old"></button>';
        if (dynamic) replaced.innerHTML = '<div class="current"></div>';
        if (replaced.querySelector(".old") !== null) throw new Error("replaced markup still queried");
        if (replaced.querySelector(".current") === null) throw new Error("replacement markup missing");
        globalThis.close();
    `,
        { fileName: join(directory, "entry.ts") },
    );
    assert.ok(result.manifest.features.includes("ui:rml"));
    assert.match(result.cpp, /ui_query_markup_first/);
    assert.match(result.cpp, /ui_query_markup_all/);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-markup-values", {
        macros: { BBLITE_WORKERS: 1, BBLITE_OFFSCREEN_SURFACES: 1 },
    });
});

test("closed markup reuses immutable string storage", () => {
    const result = compileSource(`
        const label = String(performance.now());
        const stored = '<span>' + label + '</span>';
        const root = document.createElement("div");
        root.innerHTML = performance.now() >= 0 ? stored : '<b>fallback</b>';
    `);
    assert.match(result.cpp, /string_substring\(v_stored,/);
    assert.doesNotMatch(result.cpp, /v_bblite_markup_text_/);
});

test("closed markup refuses ambiguous stored spans, unknown attributes and unsupported alternatives", () => {
    for (const [source, message] of [
        [
            "const x=String(performance.now()); const html=`<span>${x}</span><span>${x}</span>`; root.innerHTML=html;",
            /one runtime text span/,
        ],
        [
            'const x=String(performance.now()); root.innerHTML=`<div class="${x}"></div>`;',
            /requires static attribute/,
        ],
        [
            "const html=String(performance.now()); root.innerHTML=html;",
            /closed authored markup provenance/,
        ],
        [
            'root.innerHTML=performance.now()>0 ? "<span>ok</span>" : "<script>bad</script>";',
            /outside the bounded/,
        ],
        [
            'function html(): string { return "<script>bad</script>"; } root.innerHTML=html();',
            /outside the bounded/,
        ],
        ...["querySelector", "querySelectorAll"].map(
            (method) =>
                [
                    'const child=document.createElement("div"); child.innerHTML=performance.now()>0 ? \'<span class="target"></span>\' : \'<button class="target"></button>\'; root.append(child); root.' +
                        method +
                        '(".target");',
                    /owned directly by the queried root/,
                ] as const,
        ),
    ] as const)
        assert.throws(
            () =>
                compileSource(
                    'const root=document.createElement("div");' + source,
                ),
            message,
        );
});
