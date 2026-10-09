import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools(false);

test(
    "Map entry projections preserve order, duplicate keys, and object aliases",
    { skip: !nativeTools },
    () => {
        const result = compileSource(`
        interface Entry { id: string; value: number; }
        const items: Entry[] = [{ id: "a", value: 1 }, { id: "b", value: 2 }, { id: "a", value: 3 }];
        let calls = 0;
        const index = new Map(items.map(item => { calls++; return [item.id, item]; }));
        if (calls !== 3 || index.size !== 2 || index.get("a")!.value !== 3) throw new Error("entry projection");
        items[2]!.value = 9;
        if (index.get("a")!.value !== 9) throw new Error("lost alias");
        let order = "";
        for (const [key, value] of index) order += key + value.value;
        if (order !== "a9b2") throw new Error("map order");
        const groups: string[][] = [["a", "b"], ["c"]];
        const labels = Object.fromEntries(groups.flatMap(group => group.map(name => [name, name.toUpperCase()] as const)));
        if (labels.a !== "A" || labels.b !== "B" || labels.c !== "C") throw new Error("flattened entry projection");
        const combined: Record<string, string> = { first: "before", a: "old", ...labels, last: "after", b: "override" };
        labels.a = "changed";
        if (combined.first !== "before" || combined.a !== "A" || combined.b !== "override" || combined.last !== "after") throw new Error("dictionary spread");
        function rename(item: Entry): Entry { item.id = "changed"; return item; }
        const renamed = new Map(items.map(item => [item.id, rename(item)]));
        if (!renamed.has("a") || !renamed.has("b") || renamed.has("changed")) throw new Error("pair evaluation order");
        const rows: Array<{values?: Readonly<Record<string, string>> | null}> = [
            {}, {values: null}, {values: {name: "copied", keep: "source"}},
        ];
        let copies = 0;
        const consume = (values: Record<string, string>): void => {
            if (values.name === "copied") copies++;
            values.name = "local";
        };
        for (const row of rows) consume({...row.values});
        if (copies !== 1 || rows[2]!.values!.name !== "copied") throw new Error("optional dictionary copy");
        let reads = 0;
        function source(index: number): Readonly<Record<string, string>> | null | undefined {
            reads++;
            return rows[index]!.values;
        }
        for (let i = 0; i < rows.length; i++) {
            const copy: Record<string, string> = {name: "before", ...source(i), keep: "after"};
            if (copy.name !== (i === 2 ? "copied" : "before") || copy.keep !== "after")
                throw new Error("optional dictionary ordering");
        }
        if (reads !== 3) throw new Error("spread evaluated twice");
        const originals: Array<{values?: Readonly<Record<string, Entry>>}> = [{}, {values: {item: items[0]!}}];
        const snapshots: Array<Record<string, Entry>> = [];
        const save = (values: Record<string, Entry>): void => { snapshots.push(values); };
        for (const original of originals) save({...original.values});
        if (Object.keys(snapshots[0]!).length !== 0) throw new Error("absent spread keys");
        snapshots[1]!.item.value = 17;
        if (items[0]!.value !== 17) throw new Error("spread lost nested identity");
        delete snapshots[1]!["item"];
        if (originals[1]!.values!.item.value !== 17) throw new Error("spread aliased source dictionary");
    `);
        runGeneratedProgram(nativeTools!, "projected-map", result.cpp);
    },
);
