import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";

const { powershell, tint } = discoverDevelopmentTools();

test("Tint cache reflection is independent of source path and fill order", { skip: !powershell || !tint }, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-shader-reflection-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const shader = `@group(3) @binding(0) var<uniform> color: vec4<f32>;
@fragment fn mainFragment() -> @location(0) vec4<f32> {
    return color;
    return vec4<f32>(0.0);
}
`;
    const extensions = [".hlsl", ".msl", ".slots", ".tint-reflection.txt"];
    const results: Buffer[][] = [];
    for (const order of [["first", "second"], ["second", "first"]]) {
        const root = join(directory, `${order[0]} (cache)`);
        mkdirSync(join(root, "tools"), { recursive: true });
        mkdirSync(join(root, "upstream"));
        copyFileSync(resolve("tools/compile-shaders.ps1"), join(root, "tools/compile-shaders.ps1"));
        copyFileSync(resolve("upstream/tint.json"), join(root, "upstream/tint.json"));
        for (const [index, scene] of order.entries()) {
            const shaders = join(root, "generated", scene, "upstream/shaders");
            mkdirSync(shaders, { recursive: true });
            const stem = `${scene}.frag`;
            writeFileSync(join(shaders, `${stem}.native.wgsl`), shader);
            writeFileSync(join(shaders, "composition.json"), JSON.stringify({
                modules: [{ output: `upstream/shaders/${stem}.native.wgsl`,
                    entryPoint: "mainFragment", pinnedBindings: false }],
            }));
            const output = execFileSync(powershell!, ["-NoProfile", "-NonInteractive", "-File",
                join(root, "tools/compile-shaders.ps1"), "-Scene", scene,
                "-Tint", tint!, "-Target", "metal"], { encoding: "utf8", stdio: "pipe" });
            assert.match(output, index === 0
                ? /Tint stages: 1 transpiled, 0 replayed/
                : /Tint stages: 0 transpiled, 1 replayed/);
            const artifacts = extensions.map((extension) => readFileSync(join(shaders, `${stem}${extension}`)));
            const reflection = artifacts[3]!.toString("utf8");
            assert.match(reflection, /^source\.wgsl:4:\d+ warning: code is unreachable/m);
            assert.match(reflection, /\[3\]\[0\]:/);
            assert.match(reflection, /resource_type = UniformBuffer/);
            assert.ok(!reflection.includes(root));
            results.push(artifacts);
        }
    }
    for (const artifacts of results.slice(1)) assert.deepEqual(artifacts, results[0]);
});

test("changed cached shader bytes invalidate timestamp-based deployment", { skip: !powershell }, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-shader-publication-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    execFileSync(powershell!, ["-NoProfile", "-NonInteractive", "-Command", `
        $ErrorActionPreference = 'Stop'
        $tokens = $null
        $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile(
            $env:BBL_TEST_SHADER_SCRIPT, [ref]$tokens, [ref]$parseErrors)
        if ($parseErrors.Count) { throw 'Shader script parse failed' }
        foreach ($name in @('Test-SameContent', 'Copy-IfDifferent')) {
            $definition = $ast.Find({ param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -eq $name
            }, $true)
            if (-not $definition) { throw "Missing helper $name" }
            . ([scriptblock]::Create($definition.Extent.Text))
        }
        $cached = Join-Path $env:BBL_TEST_SHADER_DIRECTORY 'cached.dxil'
        $published = Join-Path $env:BBL_TEST_SHADER_DIRECTORY 'published.dxil'
        [IO.File]::WriteAllText($cached, 'new shader bytes')
        [IO.File]::WriteAllText($published, 'old shader bytes')
        $cacheTime = [DateTime]::new(2000, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
        $snapshotTime = $cacheTime.AddYears(1)
        [IO.File]::SetLastWriteTimeUtc($cached, $cacheTime)
        [IO.File]::SetLastWriteTimeUtc($published, $snapshotTime)
        Copy-IfDifferent $cached $published
        if ([IO.File]::ReadAllText($published) -ne 'new shader bytes') { throw 'Changed bytes not published' }
        if ([IO.File]::GetLastWriteTimeUtc($published) -le $snapshotTime) { throw 'Snapshot still appears current' }
        if ([IO.File]::GetLastWriteTimeUtc($cached) -ne $cacheTime) { throw 'Cache entry was modified' }
        [IO.File]::SetLastWriteTimeUtc($published, $snapshotTime)
        Copy-IfDifferent $cached $published
        if ([IO.File]::GetLastWriteTimeUtc($published) -ne $snapshotTime) { throw 'Unchanged publish invalidated snapshot' }
    `], {
        env: { ...process.env,
            BBL_TEST_SHADER_SCRIPT: resolve("tools/compile-shaders.ps1"),
            BBL_TEST_SHADER_DIRECTORY: directory,
        },
        stdio: "pipe",
    });
});
