import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

function generate(extra: string): void {
    const directory = resolve("artifacts/module-scalar-projection");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "catalogue.ts"),
        `
        export const catalogue = [{key:'first',label:'First'}, {key:'second',label:'Second'}];
        ${extra}
    `,
    );
    writeFileSync(
        resolve(directory, "rows.ts"),
        `
        import { catalogue } from './catalogue.js';
        const order = ['second','first'];
        const rows = order.map(key => ({key,label:catalogue.find(item=>item.key===key)!.label}));
        export function createRows(): HTMLElement {
            const root = document.createElement('div');
            for (const row of rows) {
                const child = document.createElement('span');
                child.textContent = row.label;
                root.appendChild(child);
            }
            return root;
        }
    `,
    );
    compileSource(
        `import { createRows } from './rows.js'; document.body.appendChild(createRows());`,
        { fileName: resolve(directory, "entry.ts") },
    );
}

test("scalar projections into fresh wrappers do not make the source module table mutable", () => {
    generate(`
        export function project(): void {
            for (const item of catalogue) {
                const holder = {key:item.key, count:item.label.length + 1};
                holder.key = 'other'; holder.count++;
            }
        }
    `);
});

test("module constant analysis retains nested reference aliases and scalar call effects", () => {
    const cases = [
        `export function project():void {for(const item of catalogue){const holder={owner:item};holder.owner.key='changed';}}`,
        `export function project():void {const holder={items:[catalogue]};holder.items[0]![0]!.key='changed';}`,
        `function mutate(item:{key:string}):string {item.key='changed';return item.key;}
         export function project():void {for(const item of catalogue){const holder={key:mutate(item)};holder.key='other';}}`,
        `let saved:{key:string}|undefined;
         function retain(item:{key:string}):string {saved=item;return item.key;}
         export function project():void {for(const item of catalogue){const holder={key:retain(item)};holder.key='other';}if(saved)saved.key='changed';}`,
    ];
    for (const source of cases)
        assert.throws(
            () => generate(source),
            /Expected a static array literal/,
            source,
        );
});

test("module constant analysis retains effects of copied scalar getters", () => {
    assert.throws(
        () =>
            generate(`
        export function project():void {
            const selected = catalogue[0]!;
            const reader = {get key():string {selected.key='changed';return selected.key;}};
            const holder = {key:reader.key};
            holder.key='other';
        }
    `),
        /Expected a static array literal/,
    );
});
