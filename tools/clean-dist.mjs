import { assertNoDistConsumers, withDistWriter } from "./dist-access.mjs";
import { rmSync } from "node:fs";

withDistWriter(() => {
    assertNoDistConsumers();
    rmSync("dist", { recursive: true, force: true });
});
