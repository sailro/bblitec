import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const imports = `import {createEngine,createBox,setThinInstances,loadTexture2D,createTexture2DFromPixels,createPbrMaterial,waitForGpuIdle,type Texture2D} from "@babylonjs/lite";`;
const setup = `const engine=await createEngine(document.createElement("canvas"));
await waitForGpuIdle(engine);
const mesh=createBox(engine);
setThinInstances(mesh,new Float32Array(16),1);`;

test("PBR accepts the known file payload of a settled realm texture for every file slot", () => {
    const result = compileSource(`${imports}
async function main(){
    ${setup}
    const texture=await loadTexture2D(engine,"texture.png",{srgb:true});
    createPbrMaterial({baseColorTexture:texture,ormTexture:texture,normalTexture:texture});
}
void main();`);
    assert.match(result.cpp, /co_await bbl::pal::load_realm_file_texture\(/);
    // One settled texture value reaches every slot through the one setter.
    const slots = [
        ...result.cpp.matchAll(
            /bbl::set_pbr_texture\([^,]+, \w+, bbl::MaterialTextureSlot::(\w+), (\w+)\);/g,
        ),
    ];
    assert.deepEqual(
        slots.map((entry) => entry[1]),
        ["base_color", "orm", "normal"],
    );
    assert.equal(new Set(slots.map((entry) => entry[2])).size, 1);
});

test("PBR binds a stored pixel texture a helper returns", () => {
    const result = compileSource(`${imports}
async function main(){
    ${setup}
    function texture():Texture2D {
        return createTexture2DFromPixels(engine,new Uint8Array(4),1,1);
    }
    createPbrMaterial({baseColorTexture:texture()});
}
void main();`);
    assert.match(
        result.cpp,
        /bbl::set_pbr_texture\([^,]+, \w+, bbl::MaterialTextureSlot::base_color, \w+\);/,
    );
});
