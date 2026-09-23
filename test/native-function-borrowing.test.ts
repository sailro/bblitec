import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

const types = `
    type Vec3 = readonly [number, number, number];
    interface Ray {
        origin: Vec3;
        dir: Vec3;
    }
`;

test("direct numeric kernels borrow member Refs across effect-free later arguments", () => {
    const result = compileSource(`
        ${types}
        interface Event {
            ray: Ray;
        }
        function raySphere(ray: Ray, center: Vec3, radius: number): number {
            const ox = ray.origin[0] - center[0];
            const oy = ray.origin[1] - center[1];
            const oz = ray.origin[2] - center[2];
            const b = ox * ray.dir[0] + oy * ray.dir[1] + oz * ray.dir[2];
            const disc = b * b - (ox * ox + oy * oy + oz * oz - radius * radius);
            if (disc < 0) return -1;
            const distance = -b - Math.sqrt(disc);
            return distance >= 0 ? distance : -1;
        }
        const centers: readonly Vec3[] = [[0, 0, 0]];
        function scan(event: Event): number {
            return raySphere(event.ray, centers[0]!, 1 + 0.25);
        }
        const event: Event = {
            ray: { origin: [0, 0, 4], dir: [0, 0, -1] },
        };
        const distance = scan(event);
    `);

    assert.match(result.cpp, /double raySphere\(const bblscene::Ray&/);
    assert.match(
        result.cpp,
        /bblscene::raySphere\(v_fn\d+_event\.ray, bbl::js::Tuple<3>\{0\.0, 0\.0, 0\.0\}, \(1\.0 \+ 0\.25\)\)/,
    );
    assert.doesNotMatch(result.cpp, /snapshot_value\(v_fn\d+_event\.ray\)/);
});

test("member Ref arguments still snapshot for callbacks, getters, rebinds, and impure kernels", () => {
    const result = compileSource(`
        ${types}
        interface Holder {
            ray: Ray;
        }
        const first: Ray = { origin: [0, 0, 1], dir: [0, 0, -1] };
        const second: Ray = { origin: [0, 0, 2], dir: [0, 0, -1] };
        const holder: Holder = { ray: first };
        function read(ray: Ray, amount: number): number {
            return ray.origin[0] + amount;
        }
        function replace(): number {
            holder.ray = second;
            return 1;
        }
        const callbacks = [replace];
        const effects = {
            get value(): number {
                holder.ray = first;
                return 2;
            },
        };
        function impure(ray: Ray): number {
            holder.ray = second;
            return ray.origin[0];
        }
        function safeA(value: number): number {
            return value <= 0 ? 0 : safeB(value - 1);
        }
        function safeB(value: number): number {
            return value <= 0 ? 0 : safeA(value - 1);
        }
        const stored: Ray[] = [first];
        function replaceSlot(ray: Ray, slots: Ray[], replacement: Ray): number {
            slots[0] = replacement;
            return ray.origin[0];
        }
        const rebound = read(holder.ray, replace());
        const callback = read(holder.ray, callbacks[0]!());
        const getter = read(holder.ray, effects.value);
        const mutated = impure(holder.ray);
        const recursive = read(holder.ray, safeA(2));
        const fromSlot = replaceSlot(stored[0]!, stored, second);
    `);

    assert.equal(
        (
            result.cpp.match(
                /bbl::js::snapshot_value\(v_holder(?:->|\.)ray\)/g,
            ) ?? []
        ).length,
        3,
    );
    assert.match(
        result.cpp,
        /bblscene::replaceSlot\(v_bblite_function_argument_\d+,/,
    );
});

test("numeric-buffer writers borrow Ref arguments without admitting owning array-slot writes", () => {
    const result = compileSource(`
        ${types}
        interface NumericTarget { [index: number]: number; }
        interface Holder { ray: Ray; }
        function write(target: NumericTarget, ray: Ray): void {
            target[0] = ray.origin[0];
            target[1] = Math.cos(ray.dir[0]);
            target[1]++;
        }
        const target = new Float32Array(2);
        function scan(holder: Holder): void {
            write(target, holder.ray);
        }
        const holder: Holder = {
            ray: { origin: [3, 0, 0], dir: [0, 0, -1] },
        };
        scan(holder);
        let sharedRay = holder.ray;
        const callbacks = [() => {
            sharedRay = { origin: [5, 0, 0], dir: [0, 0, -1] };
        }];
        write(target, sharedRay);
        callbacks[0]!();
        write(target, sharedRay);
        if (target[0] !== 5 || target[1] !== 2)
            throw new Error("numeric buffer writes");
    `);
    assert.match(result.cpp, /void write\(bbl::js::NumericArrayView/);
    assert.match(result.cpp, /bblscene::write\([^;\n]+, \(\*v_sharedRay\)\)/);
    assert.doesNotMatch(
        result.cpp,
        /(?:auto|bblscene::Ray) v_bblite_function_argument_\d+/,
    );
});
