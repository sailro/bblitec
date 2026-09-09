import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test("both backends resize instance streams and upload current matrices and colors", { skip: !tools }, () => {
    const output = resolve("artifacts/thin-instance-upload");
    mkdirSync(output, { recursive: true });
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8").replaceAll("\r\n", "\n");
    const helpers = ["inline bool thin_instance_pool_grew(", "inline std::size_t thin_instance_active_count(\n",
        "inline void pinned_instance_matrices("].map(signature => cppFunction(shared, signature)).join("\n");
    const updates = ["sdl_gpu", "dawn"].map(backend => {
        const source = readFileSync(`native/src/pal_${backend}.cpp`, "utf8");
        const condition = source.indexOf("mesh.thin_instanced &&");
        const start = source.lastIndexOf("if (", condition);
        assert.ok(condition >= 0 && start >= 0, backend);
        const block = cppFunction(source.slice(start), "if (");
        return `void update_${backend}(const MeshRecord& mesh, UploadedMesh& ${backend === "dawn" ? "dawn_mesh" : "gpu_mesh"}) {
            [[maybe_unused]] State state;
            [[maybe_unused]] Uploads frame_buffer_uploads;
            std::vector<std::array<float, 16>> pinned_instance_scratch;
            ${block}
        }`;
    });
    writeFileSync(join(output, "updates.hpp"), `namespace bbl { ${helpers}\n${updates.join("\n")} }`);
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, readFileSync("test/fixtures/thin-instance-upload-check.cpp"));
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native/include", file]);
    execFileSync(executable, { stdio: "pipe" });
});
