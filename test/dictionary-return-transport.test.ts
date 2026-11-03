import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("typed parsed dictionaries retain document fields and identity through calls and returns", (t) => {
    const result = compileSource(`
        interface Entry {count:number; labels?:string[];}
        let reads=0;
        function load(text:string):Record<string,Entry> {
            reads++;
            try{return JSON.parse(text) as Record<string,Entry>;}catch{return {};}
        }
        function update(values:Record<string,Entry>,key:string):Entry {
            const selected=values[key]!;
            selected.count++;
            selected.labels?.push("new");
            return selected;
        }
        const values=load('{"a":{"count":2,"labels":["old"],"extra":7},"odd":{"count":"kept"}}');
        const selected=update(values,"a");
        if(selected!==values.a||selected.count!==3||values.a!.labels!.join(",")!=="old,new")throw new Error("dictionary alias");
        if(JSON.stringify(values)!=='{"a":{"count":3,"labels":["old","new"],"extra":7},"odd":{"count":"kept"}}')throw new Error("document shape");
        const bad=load("{");
        if(Object.keys(bad).length!==0||reads!==2)throw new Error("catch or repeated parse");
        function optional(text:string):Readonly<Record<string,Entry>>|null {
            if(text==="")return null;
            return JSON.parse(text) as Record<string,Entry>;
        }
        if(optional("")!==null||optional('{"x":{"count":4}}')?.x.count!==4)throw new Error("optional dictionary");
        function fixed(text:string):Record<"left"|"right",Entry> {
            try{return JSON.parse(text) as Record<"left"|"right",Entry>;}catch{return {left:{count:0},right:{count:0}};}
        }
        const pair=fixed('{"left":{"count":1},"right":{"count":2},"extra":3}');
        pair.right.count=5;
        if(JSON.stringify(pair)!=='{"left":{"count":1},"right":{"count":5},"extra":3}')throw new Error("record view");
        let ownerReads=0,keyReads=0;
        function owner():Record<string,Entry>{ownerReads++;return values;}
        function key():string{keyReads++;return "a";}
        const previous=owner()[key()]!.count++;
        const next=++owner()[key()]!.count;
        if(previous!==3||next!==5||ownerReads!==2||keyReads!==2||values.a!.count!==5)throw new Error("update order");
        const coerced=load('{"a":{"count":"6"},"b":{"count":null},"c":{}}');
        if(coerced.a!.count++!==6||++coerced.b!.count!==1||!Number.isNaN(++coerced.c!.count))throw new Error("update coercion");
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "dictionary-return-transport", result.cpp);
});

test("parsed typed arrays and tuples retain their document identity across return branches", (t) => {
    const result = compileSource(`
        function list(text:string):{value:number}[] {
            try{return JSON.parse(text) as {value:number}[];}catch{return [];}
        }
        function pair(text:string):[number,string] {
            try{return JSON.parse(text) as [number,string];}catch{return [0,""];}
        }
        const rows=list('[{"value":2,"extra":3}]');
        rows[0]!.value=4;
        if(JSON.stringify(rows)!=='[{"value":4,"extra":3}]'||list("[").length!==0)throw new Error("array document");
        const mixed=pair('[1,"two",3]');
        mixed[0]=5;
        if(JSON.stringify(mixed)!=='[5,"two",3]'||pair("[")[1]!=="")throw new Error("tuple document");
        const alias=mixed;
        const index=Math.random()<2?2:1;
        mixed[index]="end";
        if(alias[index]!=="end")throw new Error("indexed alias");
        const joined=JSON.parse('[null,1,[2,3],true]') as unknown[];
        if(joined.join("|")!=="|1|2,3|true")throw new Error("document join");
    `);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(native, "array-return-transport", result.cpp);
});

test("dynamic array writes preserve owned aliases and refuse unsupported storage", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "json-array-assignment",
        `
        #include <bblite/js_json.hpp>
        #include <stdexcept>
        int main() {
            const auto value=bbl::js::json_parse("[1]");
            const auto alias=value;
            value.set("0", bbl::js::json_value(2.0));
            value.set("1", bbl::js::json_value(3.0));
            if(bbl::js::json_stringify(alias)!="[2,3]")throw std::runtime_error("alias");
            for(const auto* key:{"4","01","-1","length"}) {
                bool refused=false;
                try {value.set(key,bbl::js::json_value(7.0));}
                catch(const std::runtime_error&){refused=true;}
                if(!refused)throw std::runtime_error("unsupported key");
            }
            const auto view=bbl::js::JsonValue::from_sequence(bbl::js::Array<double>{1.0});
            bool refused=false;
            try {view.set("0",bbl::js::json_value(7.0));}
            catch(const std::runtime_error&){refused=true;}
            if(!refused||bbl::js::json_stringify(alias)!="[2,3]")throw std::runtime_error("storage boundary");
        }
    `,
    );
});

test("conditional record arms with differently shaped dictionary members store into one shared record", () => {
    // The saved arms' `fields` are a union of two record types; the shared
    // notice record's string dictionary member stores that union as the
    // dictionary its demand asks for (it once repeated the demand forever).
    const result = compileSource(`
        type NoticeTone = "info" | "warning" | "done";
        interface Notice { label: string; fields?: Record<string, string>; tone: NoticeTone; }
        function format(label: string, fields?: Record<string, string>): string {
            let text = label;
            for (const [name, value] of Object.entries(fields ?? {})) text += " " + name + ":" + value;
            return text;
        }
        function show(target: HTMLElement, notice: Notice): void {
            target.textContent = format(notice.label, notice.fields);
            target.classList.toggle("warn", notice.tone === "warning");
        }
        interface Panel { element: HTMLElement; finish: (saved: boolean, replaced: boolean) => void; clear: () => void; }
        function createPanel(): Panel {
            const banner = document.createElement("p");
            const actions = { clear: (): void => restart() };
            let current: Notice = { label: "idle", tone: "info" };
            const draw = (): void => { show(banner, current); };
            const restart = (): void => { current = { label: "idle", tone: "info" }; draw(); };
            const post = (notice: Notice): void => { current = notice; draw(); };
            const finish = (saved: boolean, replaced: boolean): void => {
                if (!saved) {
                    post(replaced
                        ? { label: "conflict", fields: { file: format("draft"), other: format("copy"), slot: "2" }, tone: "warning" }
                        : { label: "failed", tone: "warning" });
                    return;
                }
                post(replaced
                    ? { label: "replaced", fields: { file: format("draft"), slot: "2", other: format("copy"), previous: "1" }, tone: "done" }
                    : { label: "saved", fields: { file: format("draft"), slot: "2" }, tone: "done" });
            };
            banner.addEventListener("click", () => { post({ label: "retry", fields: { file: "draft" }, tone: "info" }); });
            draw();
            return { element: banner, finish, clear: actions.clear };
        }
        const panel = createPanel();
        document.body.appendChild(panel.element);
        const late = performance.now() < 0;
        panel.finish(late, true);
        panel.finish(!late, late);
        panel.finish(!late, !late);
        if (late) panel.clear();
    `);
    assert.match(result.cpp, /bbl::js::Map<std::string, std::string>/);
});
