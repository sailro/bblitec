import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { checkMaterialProgram } from "./material-programs.js";

function materialSource(body: string): string {
    return `
        import {createEngine,createStandardMaterial,createPbrMaterial,type StandardMaterialProps} from '@babylonjs/lite';
        async function main(){
            const engine=await createEngine({});
            const first=createStandardMaterial(),second=createStandardMaterial();
            const replacement=createPbrMaterial({});
            const rig={materials:[first,second]};
            ${body}
            void engine;
        }
    `;
}

test("nested material arrays retain common family facts through guarded reads", () => {
    const { cpp } = compileSource(
        materialSource(`
        let index=0;
        rig.materials[index++]!.uvOffset=[3,4];
    `),
    );
    assert.equal(cpp.split("v_index++").length - 1, 1);
    assert.match(cpp, /standard_uv_offset_x = 3\.0/);
    assert.match(cpp, /standard_uv_offset_y = 4\.0/);
});

for (const [name, body] of Object.entries({
    element: `const alias=rig.materials; alias[0]=replacement as unknown as StandardMaterialProps; rig.materials[0]!.uvOffset=[3,4];`,
    replacement: `rig.materials=[replacement as unknown as StandardMaterialProps]; rig.materials[0]!.uvOffset=[3,4];`,
    escaped: `function mutate(values:StandardMaterialProps[]){values[0]=replacement as unknown as StandardMaterialProps;} mutate(rig.materials); rig.materials[0]!.uvOffset=[3,4];`,
    index: `function choose(){rig.materials[0]=replacement as unknown as StandardMaterialProps;return 0;} rig.materials[choose()]!.uvOffset=[3,4];`,
}))
    test(`nested material array facts expire after ${name} mutation`, () => {
        assert.throws(
            () => compileSource(materialSource(body)),
            /known StandardMaterial|standard material|not.*[Ss]tandard|native.*family/,
        );
    });

/** {@link materialSource} with the two standard materials held by record fields. */
function holderSource(body: string): string {
    return materialSource(`const holders=[{mat:first},{mat:second}]; ${body}`);
}

test("record fields holding materials retain their common family through static and guarded reads", () => {
    const { cpp } = compileSource(
        holderSource(`
        holders[1]!.mat.uvOffset=[1,2];
        let index=0;
        holders[index++]!.mat.uvOffset=[3,4];
        interface Holder{mat:StandardMaterialProps}
        const typed:Holder[]=[{mat:second},{mat:first}];
        typed[index]!.mat.uvScale=[5,6];
    `),
    );
    assert.equal(cpp.split("v_index++").length - 1, 1);
    for (const field of [
        /standard_uv_offset_x = 1\.0/,
        /standard_uv_offset_y = 4\.0/,
        /diffuse_v_scale = 6\.0f/,
    ])
        assert.match(cpp, field);
});

for (const [name, body] of Object.entries({
    family: `const mixed=[{mat:first},{mat:replacement as unknown as StandardMaterialProps}]; let index=0; mixed[index++]!.mat.uvOffset=[3,4];`,
    field: `holders[0]!.mat=replacement as unknown as StandardMaterialProps; let index=0; holders[index++]!.mat.uvOffset=[3,4];`,
    element: `holders[0]={mat:replacement as unknown as StandardMaterialProps}; let index=0; holders[index++]!.mat.uvOffset=[3,4];`,
    escaped: `function mutate(values:{mat:StandardMaterialProps}[]){values[0]!.mat=replacement as unknown as StandardMaterialProps;} mutate(holders); let index=0; holders[index++]!.mat.uvOffset=[3,4];`,
    index: `function choose(){holders[0]!.mat=replacement as unknown as StandardMaterialProps;return 0;} holders[choose()]!.mat.uvOffset=[3,4];`,
}))
    test(`record field material facts expire after ${name} mutation`, () => {
        assert.throws(
            () => compileSource(holderSource(body)),
            /known StandardMaterial|standard material|not.*[Ss]tandard|native.*family/,
        );
    });

test("stores through record fields holding materials reach the material each index names, as JavaScript does", async (t) => {
    await checkMaterialProgram(
        t,
        "record-field-families",
        `
import { createEngine, createStandardMaterial, type StandardMaterialProps } from "@babylonjs/lite";
interface Holder { mat: StandardMaterialProps }
async function main(): Promise<void> {
    await createEngine({});
    const first = createStandardMaterial(), second = createStandardMaterial();
    const holders = [{ mat: first }, { mat: second }];
    const typed: Holder[] = [{ mat: second }, { mat: first }];
    let h = 0;
    holders[h++]!.mat.diffuseColor = [0, 0, 1];
    holders[h++]!.mat.uvOffset = [5, 6];
    typed[h - 2]!.mat.diffuseColor = [0, 1, 0];
    typed[h - 1]!.mat.uvScale = [2, 3];
    const result = [h, first.diffuseColor[2], second.diffuseColor[1]].join();
    if (result !== "2,1,1") throw new Error(result);
}
void main();
`,
    );
});
