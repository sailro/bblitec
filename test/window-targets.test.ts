import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { runRmlUiFixture } from "./native-fixture.js";

test("Window targets retain document, extension and listener identity through stored structural views", (t) => {
    const directory = resolve("artifacts/window-targets");
    mkdirSync(directory, { recursive: true });
    const result = compileSource(`
        const panel = document.createElement("div");
        panel.id = "target";
        document.body.appendChild(panel);
        const owners: Window[] = [panel.ownerDocument.defaultView ?? window];
        const documents: Document[] = [panel.ownerDocument, window.document];
        if (owners[0] !== window || documents[0] !== document || documents[1] !== document)
            throw new Error("document and Window identity");
        if (documents[0]!.ownerDocument !== null) throw new Error("document owner is null");
        if (documents[0]!.body !== document.body) throw new Error("document body");
        if (documents[0]!.head !== document.head) throw new Error("document head");
        if (documents[0]!.documentElement !== document.documentElement) throw new Error("document root");
        if (documents[0]!.activeElement !== document.activeElement) throw new Error("document focus identity");
        let customCalls=0;
        const custom=()=>{customCalls++;};
        owners[0]!.addEventListener("notify",custom);
        const customTargets:EventTarget[]=[window,document];
        let currentCustomTarget:EventTarget=customTargets[0]!;
        function customArgument():CustomEvent { currentCustomTarget=customTargets[1]!; return new CustomEvent("notify"); }
        currentCustomTarget.dispatchEvent(customArgument());
        if (customCalls!==1) throw new Error("custom target snapshot");
        documents[0]!.dispatchEvent(new CustomEvent("notify",{bubbles:true}));
        if (customCalls!==2) throw new Error("custom document propagation");
        owners[0]!.removeEventListener("notify",custom);
        owners[0]!.dispatchEvent(new CustomEvent("notify"));
        if (customCalls!==2) throw new Error("custom stored removal");
        type ResizeTarget = Pick<Window, "addEventListener" | "removeEventListener">;
        let resizes = 0;
        function listen(target: ResizeTarget): () => void {
            const changed = () => { resizes++; panel.setAttribute("data-resizes", String(resizes)); };
            target.addEventListener("resize", changed);
            return () => target.removeEventListener("resize", changed);
        }
        const removeResize = listen(owners[0]!);
        const option: {target?:EventTarget|null} = {target:window};
        let selected = 0;
        let argumentsRead = 0;
        let optionalCount = 0;
        const changed = () => { optionalCount++; panel.setAttribute("data-optional", String(optionalCount)); };
        function select(): EventTarget|null|undefined { selected++; return option.target; }
        function argument(): ()=>void { argumentsRead++; option.target = null; return changed; }
        select()?.addEventListener("resize", argument());
        option.target?.addEventListener("resize", argument());
        if (selected !== 1 || argumentsRead !== 1) throw new Error("optional receiver evaluation");
        type Host = Window & {state?:{value:number}; snapshot?:()=>number};
        function write(host:Host,value:number): void { host.state={value}; }
        function read(host:Host): number { return host.state?.value ?? 0; }
        const hosts:Host[]=[window];
        if (read(hosts[0]!) !== 0) throw new Error("initial optional host field");
        write(hosts[0]!,4);
        const old=(window as Host).state;
        write(hosts[0]!,5);
        if (read(hosts[0]!)!==5 || old?.value!==4) throw new Error("host field snapshot");
        const snapshot=()=>read(hosts[0]!);
        hosts[0]!.snapshot=snapshot;
        if (hosts[0]!.snapshot!==snapshot || hosts[0]!.snapshot!()!==5) throw new Error("host callback identity");
        let hostReads=0;
        function selectHost():Host { hostReads++; return hosts[0]!; }
        if (selectHost().snapshot!()!==5 || hostReads!==1) throw new Error("host receiver evaluated once");
        type ReportingHost=Window & {report?:(...values:unknown[])=>void};
        const reporting={host:window as ReportingHost};
        let reports=0,reportArguments=0;
        function reportArgument():number {reportArguments++;return 3;}
        reporting.host.report?.(reportArgument());
        if(reportArguments!==0)throw new Error("absent host rest callback");
        reporting.host.report=(...values:unknown[])=>{reports+=values.length;};
        const report=reporting.host.report;
        reporting.host.report?.(reportArgument(),"value");
        if(reports!==2||reportArguments!==1||report!==reporting.host.report)
            throw new Error("host rest callback and identity");
        delete reporting.host.report;
        reporting.host.report?.(reportArgument());
        if(reportArguments!==1)throw new Error("deleted host rest callback");
        delete hosts[0]!.state;
        if (read(hosts[0]!)!==0) throw new Error("host field deletion");
        const optionalHosts:Array<Host|null>=[null,hosts[0]!];
        for (const host of optionalHosts) {
            if ((host?.state?.value??0)!==0) throw new Error("optional Window field");
        }
        type PickerHost=Window & {showOpenFilePicker?:()=>Promise<unknown>;showSaveFilePicker?:()=>Promise<unknown>};
        function hasPicker(host:PickerHost):boolean { return typeof host.showOpenFilePicker === "function" || !!host.showSaveFilePicker; }
        const pickerHosts:PickerHost[]=[window];
        if (hasPicker(pickerHosts[0]!)) throw new Error("native picker capability");
        if (typeof pickerHosts[0]!.showOpenFilePicker === "function") {
            await pickerHosts[0]!.showOpenFilePicker!();
            throw new Error("unavailable picker branch");
        }
        const local={showOpenFilePicker:()=>3};
        if (local.showOpenFilePicker()!==3) throw new Error("ordinary object picker name");
        interface StorageNotice {key:string|null;newValue:string|null;storageArea?:Storage|null;}
        interface StorageTarget {
            addEventListener(type:"storage",callback:(event:StorageNotice)=>void):void;
            removeEventListener(type:"storage",callback:(event:StorageNotice)=>void):void;
        }
        let storageCount=0;
        const onStorage=(event:StorageNotice)=>{
            if (event.storageArea && event.storageArea!==localStorage) throw new Error("storage identity");
            if (event.key!=="setting" || event.newValue!=="next") throw new Error("storage payload");
            storageCount++;
            panel.setAttribute("data-storage",String(storageCount));
        };
        function listenStorage(storageOptions:{events?:StorageTarget|null}):()=>void {
            storageOptions.events?.addEventListener("storage",onStorage);
            return ()=>storageOptions.events?.removeEventListener("storage",onStorage);
        }
        const removeStorage=listenStorage({events:window});
        const removeAbsentStorage=listenStorage({});
        removeAbsentStorage();
        localStorage.setItem("setting","local");
        if (storageCount!==0) throw new Error("own storage changes are silent");
        owners[0]!.addEventListener("storage",(event:StorageEvent)=>{
            if (event.oldValue!=="before" || event.url!=="native://example/" || event.target!==window || event.currentTarget!==window)
                throw new Error("typed storage payload");
            event.preventDefault();
            if (event.defaultPrevented || event.bubbles || event.cancelable) throw new Error("storage event flags");
            panel.setAttribute("data-storage-typed","yes");
        },{once:true});
        owners[0]!.addEventListener("pagehide",()=>panel.setAttribute("data-pagehide","yes"),{once:true});
        panel.addEventListener("click",()=>{
            removeResize();
            option.target=window;
            select()?.removeEventListener("resize",argument());
            removeStorage();
        });
        globalThis.close();
    `);
    assert.match(result.cpp, /on_dom_storage/);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    emitUpstreamGenerated(directory, ["core", "backend:sdl"]);
    runRmlUiFixture(t, "window-targets", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
            BBLITE_HAS_PBR_RENDERER: 0,
            BBLITE_HAS_SDL_GPU: 1,
            BBLITE_HAS_DAWN: 0,
        },
        includeDirectories: [join(directory, "upstream/include")],
    });
});

test("Window target boundaries refuse fabricated methods and owned storage events", () => {
    assert.throws(
        () =>
            compileSource(
                `new StorageEvent("storage", {key:"setting"}); globalThis.close();`,
            ),
        /StorageEvent|constructor|construct/i,
    );
    assert.throws(
        () =>
            compileSource(`
            interface Target {addEventListener(type:"resize", callback:()=>void):void;}
            const target = {} as Target;
            target.addEventListener("resize", ()=>{throw new Error("never installed");});
            globalThis.close();
        `),
        /Unsupported|callback|method|member/i,
    );
});
