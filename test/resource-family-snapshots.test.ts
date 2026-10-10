import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

function materialSource(body: string): string {
    return `
        import {createEngine,createStandardMaterial,createPbrMaterial,type StandardMaterial} from '@babylonjs/lite';
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
    element: `const alias=rig.materials; alias[0]=replacement as unknown as StandardMaterial; rig.materials[0]!.uvOffset=[3,4];`,
    replacement: `rig.materials=[replacement as unknown as StandardMaterial]; rig.materials[0]!.uvOffset=[3,4];`,
    escaped: `function mutate(values:StandardMaterial[]){values[0]=replacement as unknown as StandardMaterial;} mutate(rig.materials); rig.materials[0]!.uvOffset=[3,4];`,
    index: `function choose(){rig.materials[0]=replacement as unknown as StandardMaterial;return 0;} rig.materials[choose()]!.uvOffset=[3,4];`,
}))
    test(`nested material array facts expire after ${name} mutation`, () => {
        assert.throws(
            () => compileSource(materialSource(body)),
            /known StandardMaterial|standard material|not.*[Ss]tandard|native.*family/,
        );
    });
