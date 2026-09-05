import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";

const powershell = discoverDevelopmentTools().powershell;

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
