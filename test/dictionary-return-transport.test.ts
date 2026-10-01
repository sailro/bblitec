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
