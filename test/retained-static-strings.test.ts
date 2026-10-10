import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

function modules(name: string, files: Record<string, string>): string {
    const directory = resolve("artifacts/retained-static-strings", name);
    mkdirSync(directory, { recursive: true });
    for (const [file, source] of Object.entries(files))
        writeFileSync(join(directory, file), source);
    return join(directory, "entry.ts");
}

test("retained immutable text reaches static consumers through namespace and helper aliases", () => {
    const fileName = modules("composition", {
        "values.ts": `
            const base = import.meta.env.BASE_URL;
            export const root = (location.origin + base).replace(/\\/+$/, "");
            function unit(): string { return "px"; }
            export const css: string = ".panel {width:" + (2 * 10) + unit() + ";}";
            let calls = 0; calls++;
        `,
    });
    const consume = `
        function install(text: string) {
            const sheet = document.createElement("style");
            sheet.textContent = text;
            document.head.appendChild(sheet);
        }
        function alias(text: string): string { return text; }
    `;
    for (const source of [
        `import * as values from "./values";
         ${consume}
         const css = alias(values.css); install(css);
         const width = values.root.replace("https://example.invalid/demo", "20");
         install(\`.location {width:\${width}px;}\`);`,
        `${consume}
         async function run() {
             const {css, root} = await import("./values");
             const text = alias(css); install(text);
             const width = root.replace("https://example.invalid/demo", "20");
             install(\`.location {width:\${width}px;}\`);
         }
         void run();`,
    ]) {
        const result = compileSource(source, {
            fileName,
            siteUrl: "https://example.invalid/demo/",
        });
        assert.match(
            result.cpp,
            /ui_add_class_style[^\n]*"panel"[^\n]*width:20px/,
        );
        assert.match(
            result.cpp,
            /ui_add_class_style[^\n]*"location"[^\n]*width:20px/,
        );
    }
});

test("local immutable aliases retain pure helpers' branch-composed text", () => {
    const result = compileSource(`
        function main() {
            function compose(wide: boolean): string {
                let width="10";
                if(wide) width="20";
                const parts={body:"width:" + width + "px;"};
                return parts.body;
            }
            const narrow=compose(false);
            const wide=compose(true);
            const sheet=document.createElement("style");
            sheet.textContent=\`.narrow {\${narrow}} .wide {\${wide}}\`;
            document.head.appendChild(sheet);
        }
        main();
    `);
    assert.match(
        result.cpp,
        /ui_add_class_style[^\n]*"narrow"[^\n]*width:10px/,
    );
    assert.match(result.cpp, /ui_add_class_style[^\n]*"wide"[^\n]*width:20px/);
});

test("retained text reads preserve activation, TDZ, mutable aliases and concatenation effects", (t) => {
    const fileName = modules("reads", {
        "state.ts": `export let order=""; export function mark(){order+="L";return "ready";}`,
        "lazy.ts": `
            import {mark} from "./state";
            export const prefix=mark();
            export const label=prefix + (2 * 10);
            export let mutable="before";
            export function change(){mutable="after";}
        `,
        "cycle-a.ts": `import "./cycle-b"; export const label="ready";`,
        "cycle-b.ts": `import {label} from "./cycle-a"; export const text="[" + label + "]";`,
        "template-a.ts": `import "./template-b"; export const label="ready";`,
        "template-b.ts": `import {label} from "./template-a"; export const text=\`[\${label}]\`;`,
        "delayed.ts": `export const early=read(); function read():string{return late;} const late="later";`,
    });
    const result = compileSource(
        `
        import * as state from "./state";
        async function run() {
            const pending=import("./lazy");
            if(String(state.order)!=="") throw new Error("eager module initialization");
            const first=await pending;
            const {label}=first;
            const again=await import("./lazy");
            if(state.order!=="L"||label!=="ready20"||again.label!==label)
                throw new Error("retained immutable text");
            let alias=label;
            function change(){alias="changed";return "/";}
            const ordered=alias + change() + alias;
            if(ordered!=="ready20/changed") throw new Error("concatenation snapshots");
            const snapshot=first.mutable;
            first.change();
            if(snapshot!=="before"||again.mutable!=="after") throw new Error("live mutable export");
            let calls=0;
            function mark():string {calls++;return "/";}
            const folded=label + mark() + label;
            if(calls!==1||folded!=="ready20/ready20") throw new Error("folded text effects");
            function compose(wide:boolean):string {
                let text="narrow";
                if(wide) text="wide";
                return text;
            }
            function choose():boolean {calls++;return true;}
            const composed=compose(choose());
            if(Number(calls)!==2||composed!=="wide") throw new Error("pure helper argument effects");
            let failures=0;
            try {await import("./cycle-a");} catch(error) {
                if(error instanceof Error && error.message.includes("before initialization")) failures++;
            }
            try {await import("./template-a");} catch(error) {
                if(error instanceof Error && error.message.includes("before initialization")) failures++;
            }
            try {await import("./delayed");} catch(error) {
                if(error instanceof Error && error.message.includes("before initialization")) failures++;
            }
            if(failures!==3) throw new Error("constant text bypassed a lexical read");
        }
        run().then(()=>{globalThis.close(); return undefined;});
    `,
        { fileName },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(tools, "retained-static-string-reads", result.cpp, {
        defines: ["BBLITE_WORKERS=1"],
    });
});

test("runtime and mutable text do not acquire immutable initializer facts", () => {
    const fileName = modules("refusals", {
        "values.ts": `
            export let mutable=".panel {width:20px;}";
            export const dynamic=String(Math.random());
            export const known=".panel {width:20px;}";
            export function change(){mutable=".panel {width:30px;}";}
        `,
    });
    for (const body of [
        `const values=await import("./values"); values.change(); const text=values.mutable;`,
        `const {dynamic:text}=await import("./values");`,
        `const {known}=await import("./values"); let text=known; text=String(Math.random());`,
    ]) {
        assert.throws(
            () =>
                compileSource(
                    `
            async function run() {
                ${body}
                const sheet=document.createElement("style");
                sheet.textContent=text;
                document.head.appendChild(sheet);
            }
            void run();
        `,
                    { fileName },
                ),
            /Expected a string literal/,
        );
    }
    for (const builder of [
        `let width=20; function body():string {let text=String(width);return text;}`,
        `const settings={width:20}; function body():string {let text=String(settings.width);return text;} settings.width=30;`,
        `function body():string {let text=String(Math.random());return text;}`,
        `function body():string {let text="20";while(false) text+="0";return text;}`,
    ]) {
        assert.throws(
            () =>
                compileSource(`
            function main() {
                ${builder}
                const text=body();
                const sheet=document.createElement("style");
                sheet.textContent=\`.panel {width:\${text}px;}\`;
                document.head.appendChild(sheet);
            }
            main();
        `),
            /Expected a string literal|Template substitution/,
        );
    }
});
