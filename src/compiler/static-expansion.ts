import { emissionArray } from "./emission-transaction.js";
import type ts from "typescript";

const MAX_STATIC_ITERATIONS = 4096;
const MAX_STATIC_BYTES = 1024 * 1024;
const MAX_COMPOSITION_RECORDS = 65536;

/**
 * A compilation-wide limit, not a per-loop/nest advisory. Count captured text
 * too: an unsuccessful fold must not allocate unbounded speculative output.
 */
export class StaticExpansionBudget {
    private iterations = 0;
    private bytes = 0;
    private readonly sites: ts.IterationStatement[] = emissionArray([]);
    private exceeded: { site: ts.IterationStatement; message: string } | undefined;

    public constructor(
        private readonly fail: (node: ts.Node, message: string) => never,
    ) {}

    public enter(site: ts.IterationStatement): void {
        if (++this.iterations > MAX_STATIC_ITERATIONS) {
            this.refuse(site, `${MAX_STATIC_ITERATIONS} static iterations`);
        }
        this.sites.push(site);
    }

    public leave(): void {
        this.sites.pop();
    }

    public emit(line: string): void {
        const site = this.sites.at(-1);
        if (!site) return;
        this.bytes += Buffer.byteLength(line, "utf8") + 1;
        if (this.bytes > MAX_STATIC_BYTES) {
            this.refuse(site, `${MAX_STATIC_BYTES} emitted bytes`);
        }
    }

    public assertWithinBudget(): void {
        if (this.exceeded) this.fail(this.exceeded.site, this.exceeded.message);
    }

    public checkComposition(
        site: ts.IterationStatement,
        meshes: number,
        materials: number,
    ): void {
        if (!Number.isSafeInteger(meshes) || meshes > MAX_COMPOSITION_RECORDS ||
            !Number.isSafeInteger(materials) || materials > MAX_COMPOSITION_RECORDS) {
            this.reject(
                site,
                `Resource-loop composition exceeds ${MAX_COMPOSITION_RECORDS} mesh or material records. ` +
                    "Use shared geometry/instances rather than expanding the composition table.",
            );
        }
    }

    private refuse(site: ts.IterationStatement, limit: string): never {
        return this.reject(
            site,
            `Total static loop expansion exceeds ${limit}. ` +
                "This loop requires per-iteration specialization; keep " +
                "composition choices invariant and use runtime data for construction.",
        );
    }

    private reject(site: ts.IterationStatement, message: string): never {
        this.exceeded ??= { site, message };
        return this.fail(this.exceeded.site, this.exceeded.message);
    }
}
