import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import ts from "typescript";
import {LoweringContext} from "../src/lowering/context.js";
import {lowerGltfAnimationEvaluator} from "../src/lowering/gltf/animation-evaluator.js";
import {transpileCommonJs} from "../src/typescript-transpile.js";
import {doctoredContext} from "./doctored-store.js";
import {nativeFixtureVcpkgRoot,optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";

const modulePath="src/animation/evaluate.ts";
const contexts=()=>[new LoweringContext(),doctoredContext(modulePath,
    "const h10 = f3 - 2 * f2 + f;","const h10 = f3 - 3 * f2 + f;"),
    doctoredContext(modulePath,"const srcOff = (t >= t1 ? idx + 1 : idx) * stride;","const srcOff = idx * stride;")];
function cases(context:LoweringContext){
    const file=context.sourceFile(modulePath),printer=ts.createPrinter();
    const source=file.statements.filter(statement=>!ts.isImportDeclaration(statement)).map(statement=>printer.printNode(ts.EmitHint.Unspecified,statement,file).replace(/^export /gm,"")).join("\n");
    const types=context.sourceFile("src/animation/types.ts");
    const constants=["INTERP_STEP","INTERP_CUBICSPLINE"].map(name=>context.numericValue(context.moduleScopeConstant(types,name)!,types));
    const evaluate=new Function("F32","INTERP_STEP","INTERP_CUBICSPLINE",transpileCommonJs(source,modulePath)+"\nreturn evaluateSampler;")(
        Float32Array,...constants) as (sampler:object,t:number,stride:number,quaternion:boolean,out:Float32Array,offset:number)=>void;
    return [0,1,2].flatMap(interpolation=>[0,1,3].flatMap(count=>[1,3,4,20].flatMap(stride=>[-1,0,.25,.5,.75,1.5,3].map(time=>{
        const input=new Float32Array([0,.5,1.5].slice(0,count));const values:number[]=[];
        for(let key=0;key<count;key++)for(let part=0;part<(interpolation===constants[1]?3:1);part++)for(let component=0;component<stride;component++){
            const tangent=interpolation===constants[1]&&part!==1;
            values.push(stride===4?(tangent?(component===1?.1:0):[[0,0,0,1],[0,.6,0,.8],[0,0,0,-1]][key]![component]!):(tangent?.123456789:(key+1)*.37+component/7));
        }
        const output=new Float32Array(values),result=new Float32Array(stride+4).fill(77);
        evaluate({input,output,interpolation},time,stride,stride===4,result,2);
        return {input:[...input],output:[...output],interpolation,time,stride,quaternion:stride===4,
            expected:[...new Uint32Array(result.buffer)]};
    }))));
}
test("complete sampler lowering responds to source branch and cubic coefficient mutations",()=>{
    const variants=contexts().map(context=>{assert.ok(lowerGltfAnimationEvaluator(context));return cases(context);});
    for(const variant of variants.slice(1))assert.notDeepEqual(variant,variants[0]);
});
test("native sampler matches source for empty, singleton, boundary, STEP, cubic, quaternion and wide morph samples",t=>{
    const native=optionalNativeFixtureTools();if(!native){t.skip("Native fixture compiler unavailable.");return;}
    const variants=contexts(),directory=resolve("artifacts/test-gltf-animation-evaluator");mkdirSync(directory,{recursive:true});
    const file=resolve(directory,"check.cpp"),exe=resolve(directory,"check.exe");
    writeFileSync(resolve(directory,"cases.json"),JSON.stringify(variants.map(cases)));
    writeFileSync(file,`#include <bblite/js_data.hpp>
#include <nlohmann/json.hpp>
#include <array>
#include <bit>
#include <cmath>
#include <fstream>
using Json=nlohmann::json;
struct Sampler{std::vector<float> input,output;double interpolation;};
${variants.map((context,index)=>`namespace variant_${index}{${lowerGltfAnimationEvaluator(context)}}`).join("\n")}
int main(){Json variants;std::ifstream("cases.json")>>variants;
${variants.map((_context,index)=>`for(const auto& row:variants.at(${index})){Sampler sampler{row.at("input").get<std::vector<float>>(),row.at("output").get<std::vector<float>>(),row.at("interpolation")};const auto stride=row.at("stride").get<std::size_t>();std::vector<float> result(stride+4,77);
variant_${index}::gltf_evaluate_animation_sampler(sampler,row.at("time").get<double>(),static_cast<double>(stride),row.at("quaternion").get<bool>(),result,2.0);
for(std::size_t lane=0;lane<result.size();++lane)if(std::bit_cast<std::uint32_t>(result[lane])!=row.at("expected").at(lane).get<std::uint32_t>()){std::ofstream("failure.json")<<Json{{"row",row},{"lane",lane},{"actual",std::bit_cast<std::uint32_t>(result[lane])}}.dump(2);return ${index+1};}}`).join("\n")}}
`);
    runNativeFixtureCompiler(native,["/nologo","/std:c++20","/W4","/WX","/permissive-","/EHsc","/MD","/O2",`/Fo:${directory}/`,`/Fe:${exe}`,"/I","native/include","/I",resolve(nativeFixtureVcpkgRoot,"include"),file]);
    assert.equal(execFileSync(exe,{cwd:directory,encoding:"utf8"}),"");
});
