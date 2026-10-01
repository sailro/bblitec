import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("readonly heterogeneous catalogues retain search, mapping and stored values", (t) => {
    const result = compileSource(`
        const rows = [
            {id: "first", rank: 3}, {id: "second", rank: 1, marked: true},
            {id: "third", rank: 2},
        ] as const satisfies readonly {id:string; rank:number; marked?:true}[];
        type Id = typeof rows[number]["id"];
        function select(id: Id): typeof rows[number] & {marked?:true} {
            return rows.find(row => row.id === id)!;
        }
        const id: Id = Math.random() < 2 ? "second" : "first";
        const found = select(id);
        if (found.rank !== 1 || found.marked !== true) throw new Error("selected fields");
        let visits = 0;
        if (rows.find((row,index,array) => { visits++; return row.id === id && index === 1 && array.length === 3; }) !== found || visits !== 2)
            throw new Error("find identity or effects");
        if (rows.find(row => row.rank < 0) !== undefined || rows.findIndex(row => row.id === id) !== 1)
            throw new Error("search absence");
        if (!rows.every(row => row.rank > 0) || !rows.some(row => row.id === id)) throw new Error("predicates");
        const selected = rows.filter(row => row.rank < 3);
        const indexed = new Map(rows.map(row => [row.id, row]));
        if (selected.length !== 2 || indexed.get(id) !== found) throw new Error("stored identity");
        const ordered = [...rows].sort((a,b) => a.rank-b.rank);
        if (ordered.map(row => row.rank).join(",") !== "1,2,3" || rows[0].rank !== 3) throw new Error("sorted snapshot");
        const empty: readonly number[] = [];
        if ([...empty].length !== 0 || empty.find(n => n > 0) !== undefined) throw new Error("empty collection");
        const nothing = [] as const;
        if (nothing.length !== 0) throw new Error("empty tuple");
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "collection-data-families", result.cpp);
});

test("readonly string tuple mapping keeps contextual lanes through spreads and returns", (t) => {
    const result = compileSource(`
        type Kind = "scalar" | "vector";
        const fields: readonly (readonly [string, Kind])[] = [
            ...Array.from({length: 3}, (_,i) => ["value" + i, "vector"] as const),
            ...["light", "shade"].map(name => [name, "vector"] as const),
            ["scale", "scalar"],
        ];
        function definitions(): {name:string;kind:Kind}[] {
            return fields.map(([name,kind]) => ({name: "next-" + name, kind}));
        }
        const result=definitions();
        if (result.length !== 6 || result[5]!.kind !== "scalar" || result[1]!.name !== "next-value1")
            throw new Error("tuple mapping");
        const byName = new Map(result.map(row => [row.name,row]));
        if (byName.get("next-scale") !== result[5]) throw new Error("mapped row identity");
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "collection-tuple-mapping", result.cpp);
});

test("computed module catalogues support runtime loop control", (t) => {
    const directory = resolve("artifacts/collection-module-loop");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "catalogue.ts"),
        `
        const rows=[{id:"last",rank:3},{id:"first",rank:1,marked:true},{id:"middle",rank:2}] as const;
        const ordered=[...rows].sort((a,b)=>a.rank-b.rank);
        export function collect(limit:number):string {
            let result="";
            for(const row of ordered) {
                if(row.rank>limit)break;
                if(row.rank===2)continue;
                result+=row.id;
            }
            return result;
        }
    `,
    );
    const result = compileSource(
        `
        import {collect} from "./catalogue";
        if(collect(0)!==""||collect(2)!=="first"||collect(4)!=="firstlast")throw new Error("module loop control");
    `,
        { fileName: resolve(directory, "entry.ts") },
    );
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "collection-module-loop", result.cpp);
});
