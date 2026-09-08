import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {existsSync,mkdirSync} from "node:fs";
import {join,resolve} from "node:path";
import test from "node:test";
import {nativeFixtureVcpkgRoot,optionalNativeFixtureTools,runNativeFixtureCompiler} from "./native-fixture.js";

test("Windows UI fonts preserve OpenType shaping, browser coverage, accumulated lines and texture lifetime",t=>{
    const tools=optionalNativeFixtureTools();
    const rml=resolve(process.env.BBLITE_RMLUI_DIR??"artifacts/tools/rmlui");
    if(process.platform!=="win32"||!tools||!existsSync(join(rml,"lib/rmlui.lib"))){t.skip("Windows native RmlUi fixture dependencies unavailable.");return;}
    const output=resolve("artifacts/ui-win32-font-check");mkdirSync(output,{recursive:true});
    const executable=join(output,"check.exe");
    runNativeFixtureCompiler(tools,["/nologo","/std:c++20","/W4","/WX","/EHsc","/MD",`/Fo:${output}\\`,`/Fe:${executable}`,
        "/I","native/include","/I","native/src","/I",join(rml,"include"),"/DRMLUI_STATIC_LIB",
        "test/fixtures/ui-win32-font-check.cpp","native/src/pal_system_fonts.cpp",join(rml,"lib/rmlui.lib"),
        join(nativeFixtureVcpkgRoot,"lib/freetype.lib"),join(nativeFixtureVcpkgRoot,"lib/lunasvg.lib"),"dwrite.lib","user32.lib"]);
    assert.match(execFileSync(executable,[],{encoding:"utf8",env:{...process.env,PATH:`${join(nativeFixtureVcpkgRoot,"bin")};${process.env.PATH??""}`}}),/ui-win32-font-check: ok/);
});
