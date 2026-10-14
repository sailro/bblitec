import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { runApplicationRmlUiFixture } from "./rmlui-application-fixture.js";

// Member calls and writes on an element a call produces: each call runs
// once, in order, and keeps its effect.
const program = `
    let made = 0;
    let order = "";
    const make = (id: string): HTMLDivElement => {
        made++;
        order += id;
        const element = document.createElement("div");
        element.id = id;
        document.body.appendChild(element);
        return element;
    };
    let flag = Number("1") > 0;
    make("a").style.setProperty("--n", "3");
    make("b");
    make("c").classList.add("x");
    make("d").classList.toggle("y", flag);
    make("e").style.color = "red";
    make("f").textContent = "text";
    make("g").dataset.state = "on";
    (flag ? make("h") : make("unused")).classList.add("z");
    document.body.appendChild(document.createElement("span")).classList.add("w");
    const removed = make("i").style.removeProperty("color");
    if (removed !== "" || make("j").style.getPropertyValue("--n") !== "")
        throw new Error("style reads");
    if (made !== 10 || order !== "abcdefghij") throw new Error("calls " + made + " " + order);
    globalThis.close();
`;

// Method calls, element and length writes on a member of a call result, and
// a method on an element whose index has an effect: one evaluation each.
const dataProgram = `
    let made = 0;
    const keep = { box: { items: [1, 2] as number[], tags: new Set<number>(), names: new Map<string, number>() } };
    const own = (): { items: number[]; tags: Set<number>; names: Map<string, number> } => {
        made++;
        return keep.box;
    };
    const fresh = (): { items: number[] } => {
        made++;
        return { items: [] };
    };
    own().items.push(3);
    fresh().items.push(1);
    own().tags.add(7);
    own().names.set("a", 1);
    own().items[0] = 5;
    own().items.splice(1, 1);
    own().items.sort((a, b) => b - a);
    const lists: number[][] = [[], []];
    let index = 0;
    lists[index++]!.push(4);
    if (made !== 7 || index !== 1 || lists[0]!.length !== 1 || lists[1]!.length !== 0)
        throw new Error("evaluations " + made + " " + index);
    if (keep.box.items.join(",") !== "5,3" || !keep.box.tags.has(7) || keep.box.names.get("a") !== 1)
        throw new Error("effects " + keep.box.items.join(","));
    own().items.length = 0;
    if (made !== 8 || keep.box.items.length !== 0) throw new Error("length");
`;

test("methods on a call-produced data receiver run once, as in Node", () => {
    runInNewContext(
        ts.transpileModule(dataProgram, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const tools = optionalNativeFixtureTools(false);
    assert.ok(tools, "Native fixture compiler required");
    runGeneratedProgram(
        tools,
        "call-receivers/data",
        compileSource(dataProgram).cpp,
        { expectedOutput: "" },
    );
});

test("member calls on a call-produced element keep the call and its effect", () => {
    const cpp = compileSource(program).cpp;
    assert.match(cpp, /ui_set_style_property\([^;]+"--n", "3"\)/);
    assert.match(cpp, /ui_toggle_class\([^;]+"x", true\)/);
    assert.match(cpp, /ui_toggle_class\([^;]+"y", v_flag\)/);
    assert.match(cpp, /ui_toggle_class\([^;]+"z", true\)/);
    // A shape the projection cannot represent refuses rather than dropping.
    for (const [statement, diagnostic] of [
        [`make("a").setAttribute("role", "x");`, /Unsupported call target/],
        [
            `find("a")?.classList.add("x");`,
            /A DOM helper must return a retained element/,
        ],
    ] as const)
        assert.throws(
            () =>
                compileSource(
                    `const make = (id: string): HTMLDivElement => { const e = document.createElement("div"); e.id = id; return e; };
                    function find(id: string): HTMLElement | null { return document.getElementById(id); }
                    ${statement}`,
                ),
            diagnostic,
        );
});

test("call-produced element receivers run natively once with their effects", (t) => {
    runApplicationRmlUiFixture(t, "ui-call-receivers", program);
});
