import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("settled callback record tuples retain aliases and distinct loop captures", (t) => {
    const source = `
        interface Entry { value:number; read:()=>number; }
        let offset=1;
        const first:Entry={value:2,read:()=>offset};
        const second:Entry={value:5,read:()=>offset*2};
        const rows=[first,second,first] as const;
        const retained:Array<()=>Entry>=[];
        let total=0;
        for(const row of rows){retained.push(()=>row);total+=row.read();}
        for(const [index,row] of rows.entries()){
            if(index===1)continue;
            row.value+=index;
        }
        for(const row of rows.values())total+=row.value;
        offset=3;
        if(total!==17||retained[0]!()!==first||retained[1]!()!==second||retained[2]!()!==first)
            throw new Error('loop aliases');
        if(retained[0]!().read()!==3||retained[1]!().read()!==6||first.value!==4)
            throw new Error('live callback captures');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    assert.match(result.cpp, /for \(/);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "represented-record-loops/callbacks",
        result.cpp,
    );
});

test("stored listener-name loops specialize names while owner loops remain native", () => {
    const result = compileSource(`
        let calls=0;
        const listener=():void=>{calls++;};
        function install(target:EventTarget):()=>void {
            for(const type of ["pointerdown","keydown","input"] as const)
                target.addEventListener(type,listener);
            return ()=>{
                for(const type of ["pointerdown","keydown","input"] as const)
                    target.removeEventListener(type,listener);
            };
        }
        function installAll(owners:readonly EventTarget[]):Array<()=>void>{
            const removers:Array<()=>void>=[];
            for(const owner of owners)removers.push(install(owner));
            return removers;
        }
        const batches:Array<typeof installAll>=[installAll];
        const removers=batches[0]!([window,document]);
        removers[0]!();removers[1]!();
    `);
    assert.equal(result.cpp.match(/for \(/g)?.length, 1);
    for (const event of ["pointerdown", "keydown", "input"])
        for (const operation of ["on", "off"])
            assert.equal(
                result.cpp.match(
                    new RegExp(
                        `bbl::${operation}_dom_\\w+\\([^\\n]*"${event}"`,
                        "g",
                    ),
                )?.length,
                1,
            );
});

test("nested represented tuples do not consume the static expansion budget", () => {
    const entries = Array.from({ length: 66 }, (_, index) =>
        index % 2 ? "second" : "first",
    ).join(",");
    const result = compileSource(`
        interface Entry { read:()=>number; }
        const first:Entry={read:()=>1},second:Entry={read:()=>2};
        const rows=[${entries}] as const;
        let total=0;
        for(const left of rows)for(const right of rows)total+=left.read()+right.read();
        if(total!==13068)throw new Error('nested tuple sum');
    `);
    assert.equal(result.cpp.match(/for \(/g)?.length, 2);
});

test("callback record loops preserve early exits and finally effects", (t) => {
    const source = `
        interface Entry { key:string; read:()=>number; }
        let trace='';
        const first:Entry={key:'first',read:()=>{trace+='a';return -1;}};
        const second:Entry={key:'second',read:()=>{trace+='b';return 2;}};
        const third:Entry={key:'third',read:()=>{trace+='c';return 3;}};
        const rows=[first,second,third] as const;
        function select():Entry|undefined{
            for(const row of rows){
                try{if(row.read()<0)continue;return row;}
                finally{trace+='f';}
            }
            return undefined;
        }
        if(select()!==second||trace!=='afbf')throw new Error('return and continue');
        trace='';
        outer:for(const row of rows){
            for(const check of rows){
                if(check===second)continue outer;
                trace+=row.key[0]!;
                if(row===third)break outer;
            }
        }
        if(trace!=='fst')throw new Error('labeled jumps');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "represented-record-loops/early-exits",
        result.cpp,
    );
});

test("key-selected callback loops retain the first caught Error through retries", (t) => {
    const source = `
        interface Job {before?:()=>void;after:()=>void;}
        interface Group {add(job:Job|null):void;before():void;after():void;}
        function createGroup():Group{
            let pending:Job[]=[];
            let drained=false;
            const run=(step:'before'|'after',list:readonly Job[]):void=>{
                const failed:Job[]=[];
                let first:{error:unknown}|null=null;
                for(const job of list){
                    try{job[step]?.();}
                    catch(error){failed.push(job);first??={error};}
                }
                if(first){if(step==='after')pending.push(...failed);throw first.error;}
            };
            return {
                add(job){if(!job)return;if(drained)run('after',[job]);else pending.push(job);},
                before(){run('before',pending);},
                after(){drained=true;const list=pending;pending=[];run('after',list);},
            };
        }
        const group=createGroup();
        const failure=new Error('first');
        const later=new Error('later');
        let calls='',attempts=0,otherAttempts=0;
        group.add({before(){calls+='p';},after(){calls+='a';if(++attempts===1)throw failure;}});
        group.add({after(){calls+='b';}});
        group.add({after(){calls+='d';if(++otherAttempts===1)throw later;}});
        group.add(null);group.before();
        let caught=false;
        try{group.after();}
        catch(error){if(error!==failure)throw new Error('first error identity');caught=true;}
        if(!caught||calls!=='pabd')throw new Error('all callbacks must finish');
        group.after();group.after();group.add({after(){calls+='c';}});
        if(calls!=='pabdadc')throw new Error('failed owners must survive for retry');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(true);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "represented-record-loops/retry-errors",
        result.cpp,
    );
});

test("callback loop captures survive iteration-owner rebinding and array growth", (t) => {
    const source = `
        interface Entry {key:string;read:()=>number;}
        const first:Entry={key:'a',read:()=>1};
        const second:Entry={key:'b',read:()=>2};
        const third:Entry={key:'c',read:()=>3};
        let rows:Entry[]=[first,second];
        const original=rows;
        const kept:Array<()=>Entry>=[];
        for(const row of rows){
            kept.push(()=>row);
            if(row===first){original[1]=third;original.push(second);rows=[third];}
        }
        original[0]=third;
        if(kept.length!==3||kept[0]!()!==first||kept[1]!()!==third||kept[2]!()!==second)
            throw new Error('live iteration and captured values');
        if(rows.length!==1||rows[0]!==third||original.length!==3)
            throw new Error('iteration owner snapshot');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "represented-record-loops/owner-mutation",
        result.cpp,
    );
});

test("runtime array iterators snapshot values while observing live alias mutations", (t) => {
    const source = `
        interface Entry {key:string;read:()=>number;}
        const a:Entry={key:'a',read:()=>1},b:Entry={key:'b',read:()=>2};
        const c:Entry={key:'c',read:()=>3},d:Entry={key:'d',read:()=>4};
        const numbers:number[]=[1,2];
        let trace='';
        for(let value of numbers){numbers[0]=9;value+=10;trace+=String(value)+',';}
        if(trace!=='11,12,'||numbers[0]!==9||numbers[1]!==2)
            throw new Error('yielded primitive binding');

        const shifted:Entry[]=[a,b,c,d];
        const shiftAlias=shifted;
        const callbacks:Array<()=>void>=[()=>{shiftAlias.shift();}];
        function getRows():Entry[]{return shifted;}
        trace='';
        for(const row of getRows()){
            try{
                trace+=row.key;
                if(row===a){callbacks[0]!();continue;}
                if(row===c)break;
            }finally{trace+='f';}
        }
        if(trace!=='afcf')throw new Error('shift through callback and finally');

        const spliced:number[]=[1,2,3,4];
        const spliceAlias=spliced;
        function getNumbers():number[]{return spliced;}
        function replaceTail():void{spliceAlias.splice(1,2);spliceAlias.push(5);}
        trace='';
        for(const value of getNumbers()){trace+=String(value);if(value===1)replaceTail();}
        if(trace!=='145')throw new Error('splice through reached helper');
        const shrunk:number[]=[1,2,3];
        trace='';
        for(const value of shrunk){trace+=String(value);shrunk.length=1;}
        if(trace!=='1')throw new Error('live shortened length');

        let entries:Entry[]=[a,b];
        const originalEntries=entries;
        trace='';
        for(const [index,row] of entries.entries()){
            if(index===0){originalEntries[0]=c;originalEntries.push(c);entries=[d];}
            trace+=row.key;
        }
        if(trace!=='abc'||entries[0]!==d)throw new Error('entry owner and value snapshot');
        let keys:number[]=[7,8];
        const originalKeys=keys;
        trace='';
        for(const key of keys.keys()){
            trace+=String(key);
            if(key===0){originalKeys.push(9);keys=[];}
        }
        if(trace!=='012'||keys.length!==0)throw new Error('key iterator original owner');
        const source:number[]=[4,5];
        const keyReads:Array<()=>number>=[];
        trace='';
        for(let key of source.keys()){
            key+=10;keyReads.push(()=>key);trace+=String(key);
        }
        if(trace!=='1011'||keyReads[0]!()!==10||keyReads[1]!()!==11)
            throw new Error('writable key snapshots');
        const entryReads:Array<()=>number>=[];
        trace='';
        for(let [index,value] of source.entries()){
            index+=10;value+=20;entryReads.push(()=>index+value);trace+=String(index);
        }
        if(trace!=='1011'||source[0]!==4||source[1]!==5||entryReads[0]!()!==34||entryReads[1]!()!==36)
            throw new Error('writable entry snapshots');
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
    );
    const result = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "represented-record-loops/live-mutations",
        result.cpp,
    );
});

test("retained loop operations preserve filtering, continue and captured element identity", (t) => {
    const result = compileSource(`
        interface Group {key:string;label:string|null;collapsible:boolean;}
        const groups:readonly Group[]=[
            {key:'empty',label:null,collapsible:false},
            {key:'plain',label:null,collapsible:false},
            {key:'section',label:'Section',collapsible:true},
        ];
        const handlers:Array<()=>void>=[];
        function render(pages:readonly {group:string;value:number}[]):void{
            for(const group of groups){
                const visible=pages.filter(page=>page.group===group.key);
                if(visible.length===0)continue;
                if(!group.collapsible){
                    const text=document.createElement('span');
                    text.textContent=String(visible[0]!.value);
                    continue;
                }
                const section=document.createElement('div');
                section.textContent=group.label??'';
            }
            for(const key of ['a','b','c'] as const){
                const button=document.createElement('button');
                button.textContent=key;
                handlers.push(()=>{button.textContent=key+'!';});
            }
        }
        const renderers:Array<typeof render>=[render];
        queueMicrotask(()=>{
            renderers[0]!([{group:'plain',value:4},{group:'section',value:5}]);
            handlers[2]!();handlers[1]!();handlers[0]!();
            globalThis.close();
        });
    `);
    assert.equal(result.cpp.match(/ui_create_element/g)?.length, 3);
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "represented-record-loops/retained",
        `
        #define main generated_main
        ${result.cpp}
        #undef main
        #include <cassert>
        namespace bbl {
            unsigned created=0,writes=0;
            UiElementHandle ui_create_element(Engine& owner,std::string_view tag){
                assert(&owner==&pal::window_document_engine());
                assert(tag==(created==0?"span":created==1?"div":"button"));
                return UiElementHandle{created++};
            }
            void ui_set_text(Engine& owner,UiElementHandle element,std::string text){
                assert(&owner==&pal::window_document_engine()&&writes<8);
                const char* values[]={"4","Section","a","b","c","c!","b!","a!"};
                const unsigned elements[]={0,1,2,3,4,4,3,2};
                assert(text==values[writes]&&element.value==elements[writes]);
                ++writes;
            }
        }
        namespace bbl::pal {
            Engine& window_document_engine(){static Engine host;return host;}
            int run_window_application(WorkerEntry initialize,EngineOptions){
                const js::RealmScope scope;
                EventLoop loop;
                WorkerRealm realm(loop);
                loop.run([&]{initialize(realm);});
                return 0;
            }
        }
        int main(){const int result=generated_main();assert(bbl::created==5&&bbl::writes==8);return result;}
        `,
        {
            flags: [
                "/DBBLITE_HAS_UI=1",
                "/DBBLITE_WORKERS=1",
                "/DBBLITE_OFFSCREEN_SURFACES=1",
            ],
        },
    );
});
