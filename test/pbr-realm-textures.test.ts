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
    const payloads = [
        ...result.cpp.matchAll(
            /const auto (\w+) = std::get<bbl::FileTexture>\(([^;]+)\);/g,
        ),
    ];
    assert.equal(payloads.length, 3);
    assert.equal(new Set(payloads.map((entry) => entry[2])).size, 1);
    for (const [index, slot] of ["base_color", "orm", "normal"].entries())
        assert.match(
            result.cpp,
            new RegExp(
                `bbl::set_material_${slot}_file\\([^;]+, ${payloads[index]![1]}(?:, [^;]+)?\\);`,
            ),
        );
});

test("PBR still refuses stored pixel textures without file producer evidence", () => {
    assert.throws(
        () =>
            compileSource(`${imports}
async function main(){
    ${setup}
    function texture():Texture2D {
        return createTexture2DFromPixels(engine,new Uint8Array(4),1,1);
    }
    createPbrMaterial({baseColorTexture:texture()});
}
void main();`),
        /PBR Texture2D storage requires a known solid or file texture producer/,
    );
});
