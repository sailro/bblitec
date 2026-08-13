// Project-owned differential gate federating the runtime capabilities that
// no corpus scene reaches, so they stay measured without depending on any
// demo:
//
//   * raw typed-array meshes through createMeshFromData, built here rather
//     than loaded, so the generated vertex path is exercised end to end;
//   * fixed-capacity thin-instance pools rewritten in place every frame and
//     published with flushThinInstances, plus one pool whose visible count
//     varies through setThinInstanceCount;
//   * resource handles carried inside plain data -- a struct holding a mesh
//     beside its integrated state, in a dynamic array of those structs --
//     retired with removeFromScene and a single-element splice;
//
// and the language shapes that drive them: a class that owns its state as
// private fields, a factory that hands back a record of methods closing over
// its own scope, and a Record keyed by a string-literal union that a runtime
// tag indexes.
//
// The scene settles to a still state before it reports readiness, so both
// sides capture the same frame.

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createBox,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createMeshFromData,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    createStandardMaterial,
    flushThinInstances,
    loadTexture2D,
    onBeforeRender,
    registerScene,
    removeFromScene,
    setThinInstanceCount,
    setThinInstances,
    startEngine,
} from "babylon-lite";
import type {
    ArcRotateCamera,
    EngineContext,
    Mesh,
    SceneContext,
} from "babylon-lite";

/** Rows and columns of the instanced lattice. */
const ROWS = 6;
const COLUMNS = 8;
const LATTICE_CAPACITY = ROWS * COLUMNS;
/** The preview pool never shows more than this many instances. */
const PREVIEW_CAPACITY = 6;

const GRAVITY = 2.0;
const STEP = 1 / 60;
const SETTLE_FRAME = 24;
const READY_FRAME = 32;

/** How the lattice is drawn. A runtime tag selects one of these. */
type Style = "flat" | "beveled" | "tall";

/** The cycle order, indexed at runtime by `indexOf`. */
const STYLE_CYCLE: readonly Style[] = [
    "flat",
    "beveled",
    "tall",
];

/** Per-style geometry weighting, indexed by the tag. */
interface StyleParams {
    scale: number;
    height: number;
}

const PALETTE: readonly (readonly [
    number,
    number,
    number,
])[] = [
    [0.95, 0.24, 0.52],
    [0.22, 0.34, 0.95],
    [0.13, 0.8, 0.38],
    [1.0, 0.8, 0.12],
];

/** One live spark: its mesh travels inside the data. */
interface Spark {
    mesh: Mesh;
    px: number;
    py: number;
    vx: number;
    vy: number;
    life: number;
    size: number;
}

/** A unit cube as raw typed arrays: four vertices per face with a flat
 *  normal each, so the generated mesh carries real per-face shading. */
function createCubeData(size: number): {
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    uvs: Float32Array;
} {
    // axis, sign, and the two in-plane axes for each of the six faces.
    const faces: readonly (readonly [
        number,
        number,
        number,
        number,
    ])[] = [
        [0, 1, 1, 2],
        [0, -1, 1, 2],
        [1, 1, 0, 2],
        [1, -1, 0, 2],
        [2, 1, 0, 1],
        [2, -1, 0, 1],
    ];
    const half = size * 0.5;
    const positions = new Float32Array(72);
    const normals = new Float32Array(72);
    const uvs = new Float32Array(48);
    const indices = new Uint32Array(36);
    for (let face = 0; face < 6; face++) {
        const entry = faces[face]!;
        const axis = entry[0];
        const sign = entry[1];
        const uAxis = entry[2];
        const vAxis = entry[3];
        for (let corner = 0; corner < 4; corner++) {
            const u = corner === 0 || corner === 3 ? -1 : 1;
            const v = corner < 2 ? -1 : 1;
            const base = (face * 4 + corner) * 3;
            positions[base + axis] = half * sign;
            positions[base + uAxis] = half * u;
            positions[base + vAxis] = half * v;
            normals[base + axis] = sign;
            const uvBase = (face * 4 + corner) * 2;
            uvs[uvBase] = u * 0.5 + 0.5;
            uvs[uvBase + 1] = v * 0.5 + 0.5;
        }
        const first = face * 4;
        const slot = face * 6;
        indices[slot] = first;
        indices[slot + 1] = first + 1;
        indices[slot + 2] = first + 2;
        indices[slot + 3] = first;
        indices[slot + 4] = first + 2;
        indices[slot + 5] = first + 3;
    }
    return { positions, normals, indices, uvs };
}

/** Writes a uniform-scale translation into a thin-instance buffer,
 *  column-major, the way the instanced path expects it. */
function writeInstance(
    out: Float32Array,
    index: number,
    x: number,
    y: number,
    z: number,
    scale: number,
): void {
    const o = index * 16;
    out[o + 0] = scale;
    out[o + 1] = 0;
    out[o + 2] = 0;
    out[o + 3] = 0;
    out[o + 4] = 0;
    out[o + 5] = scale;
    out[o + 6] = 0;
    out[o + 7] = 0;
    out[o + 8] = 0;
    out[o + 9] = 0;
    out[o + 10] = scale;
    out[o + 11] = 0;
    out[o + 12] = x;
    out[o + 13] = y;
    out[o + 14] = z;
    out[o + 15] = 1;
}

/** A slot at scale zero renders nothing, which is how unused capacity in a
 *  fixed-size pool is hidden. */
function writeHidden(
    out: Float32Array,
    index: number,
): void {
    writeInstance(out, index, 0, 0, 0, 0);
}

/** Sparks thrown off the lattice: private state, a constructor that captures
 *  the engine and scene, and command methods that own the burst and sweep. */
class SparkField {
    private readonly engine: EngineContext;
    private readonly scene: SceneContext;
    private readonly live: Spark[] = [];

    constructor(engine: EngineContext, scene: SceneContext) {
        this.engine = engine;
        this.scene = scene;
    }

    /** Spawn one burst, tinted by the palette entry. */
    burst(slot: number, count: number): void {
        for (let index = 0; index < count; index++) {
            const mesh = createBox(this.engine, 1);
            const size = 0.16 + Math.random() * 0.12;
            const angle = Math.random() * Math.PI * 2;
            const speed = 0.6 + Math.random() * 0.7;
            const material = createStandardMaterial();
            const tint = PALETTE[slot % PALETTE.length]!;
            material.diffuseColor = [
                tint[0],
                tint[1],
                tint[2],
            ];
            mesh.material = material;
            mesh.position.set(slot - 2, 2.4, 0);
            mesh.scaling.set(size, size, size);
            addToScene(this.scene, mesh);
            // The mesh handle enters the data model here.
            this.live.push({
                mesh,
                px: slot - 2,
                py: 2.4,
                vx: Math.cos(angle) * speed,
                vy: 0.5 + Math.random() * 0.6,
                life: 0.25 + Math.random() * 0.5,
                size,
            });
        }
    }

    /** Integrate every live spark and retire the expired ones. */
    update(dt: number): void {
        for (
            let index = this.live.length - 1;
            index >= 0;
            index--
        ) {
            // A const bound to an element is a reference, so these writes
            // reach the array rather than a copy of the entry.
            const spark = this.live[index]!;
            spark.life -= dt;
            if (spark.life <= 0) {
                removeFromScene(this.scene, spark.mesh);
                this.live.splice(index, 1);
                continue;
            }
            spark.vy -= GRAVITY * dt;
            spark.px += spark.vx * dt;
            spark.py += spark.vy * dt;
            spark.mesh.position.set(
                spark.px,
                spark.py,
                0,
            );
            const scale = spark.size;
            spark.mesh.scaling.set(scale, scale, scale);
        }
    }
}

async function main(): Promise<void> {
    const canvas = document.getElementById(
        "renderCanvas",
    ) as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);

    scene.camera = createArcRotateCamera(
        -Math.PI / 2,
        Math.PI / 2.25,
        18,
        { x: 0, y: 0.5, z: 0 },
    );
    attachControl(
        scene.camera as ArcRotateCamera,
        canvas,
        scene,
    );
    scene.clearColor = { r: 0.02, g: 0.024, b: 0.05, a: 1 };

    addToScene(
        scene,
        createHemisphericLight([0, 1, 0.25], 0.75),
    );
    addToScene(
        scene,
        createDirectionalLight([0.22, -0.5, -0.84], 1.4),
    );

    // One generated cube shared by every instanced pool.
    const cube = createCubeData(0.92);

    // Two lattice pools and one preview pool. Each buffer is a named local
    // because a pool adopts its array rather than copying it.
    const latticeA = createMeshFromData(
        engine,
        "lattice_a",
        cube.positions,
        cube.normals,
        cube.indices,
        cube.uvs,
    );
    const materialA = createStandardMaterial();
    materialA.diffuseColor = [
        PALETTE[0]![0],
        PALETTE[0]![1],
        PALETTE[0]![2],
    ];
    latticeA.material = materialA;

    const latticeB = createMeshFromData(
        engine,
        "lattice_b",
        cube.positions,
        cube.normals,
        cube.indices,
        cube.uvs,
    );
    const materialB = createStandardMaterial();
    materialB.diffuseColor = [
        PALETTE[1]![0],
        PALETTE[1]![1],
        PALETTE[1]![2],
    ];
    latticeB.material = materialB;

    const preview = createMeshFromData(
        engine,
        "preview",
        cube.positions,
        cube.normals,
        cube.indices,
        cube.uvs,
    );
    const materialPreview = createStandardMaterial();
    materialPreview.diffuseColor = [
        PALETTE[2]![0],
        PALETTE[2]![1],
        PALETTE[2]![2],
    ];
    preview.material = materialPreview;

    // A file texture through the pinned sampler contract: sRGB base color,
    // no mips, nearest filters, attached after the material is created.
    const decal = createMeshFromData(
        engine,
        "decal",
        cube.positions,
        cube.normals,
        cube.indices,
        cube.uvs,
    );
    const decalTexture = await loadTexture2D(
        engine,
        "/textures/nme/ebf71b300f43563f.png",
        {
            srgb: true,
            invertY: false,
            mipMaps: false,
            minFilter: "nearest",
            magFilter: "nearest",
        },
    );
    decal.material = createPbrMaterial({
        baseColorTexture: decalTexture,
        ormTexture: createSolidTexture2D(
            engine,
            1.0,
            0.85,
            0.0,
        ),
        environmentIntensity: 0.9,
        directIntensity: 1.0,
    });
    decal.position.set(0, -3.4, 0);
    decal.scaling.set(2.2, 2.2, 2.2);
    addToScene(scene, decal);

    const bufferA = new Float32Array(16 * LATTICE_CAPACITY);
    const bufferB = new Float32Array(16 * LATTICE_CAPACITY);
    const bufferPreview = new Float32Array(
        16 * PREVIEW_CAPACITY,
    );
    for (let index = 0; index < LATTICE_CAPACITY; index++) {
        writeHidden(bufferA, index);
        writeHidden(bufferB, index);
    }
    for (let index = 0; index < PREVIEW_CAPACITY; index++) {
        writeHidden(bufferPreview, index);
    }
    setThinInstances(latticeA, bufferA, LATTICE_CAPACITY);
    setThinInstances(latticeB, bufferB, LATTICE_CAPACITY);
    setThinInstances(
        preview,
        bufferPreview,
        PREVIEW_CAPACITY,
    );
    addToScene(scene, latticeA);
    addToScene(scene, latticeB);
    addToScene(scene, preview);

    // Written out of tag order on purpose: the union's members are numbered
    // alphabetically, so the slots reorder on the way in while the entries
    // still evaluate in the order written here.
    const styles: Record<Style, StyleParams> = {
        flat: { scale: 0.55, height: 0.0 },
        beveled: { scale: 0.8, height: 0.35 },
        tall: { scale: 0.7, height: 0.9 },
    };

    /** The style selector: a record of methods and a getter over state the
     *  factory owns, which the frame loop drives after it has returned. */
    function createStyler() {
        let current: Style = "flat";
        function setStyle(style: Style): void {
            current = style;
        }
        function cycleStyle(): void {
            setStyle(
                STYLE_CYCLE[
                    (STYLE_CYCLE.indexOf(current) + 1) %
                        STYLE_CYCLE.length
                ]!,
            );
        }
        return {
            setStyle,
            cycleStyle,
            get style() {
                return current;
            },
        };
    }

    const styler = createStyler();
    const sparks = new SparkField(engine, scene);
    for (let slot = 0; slot < 4; slot++) {
        sparks.burst(slot, 3);
    }

    let frame = 0;
    onBeforeRender(scene, () => {
        if (frame < SETTLE_FRAME) {
            // The tag moves mid-flight, so the Record index is a value the
            // frame loop carries rather than anything folded at compile time.
            if (frame === 8 || frame === 16) {
                styler.cycleStyle();
            }
            const params = styles[styler.style];

            // Both lattice pools rewrite in place and republish.
            let usedA = 0;
            let usedB = 0;
            for (let row = 0; row < ROWS; row++) {
                for (
                    let column = 0;
                    column < COLUMNS;
                    column++
                ) {
                    const x = column - (COLUMNS - 1) / 2;
                    const y =
                        row -
                        (ROWS - 1) / 2 +
                        (row % 2 === 0
                            ? params.height
                            : -params.height);
                    if ((row + column) % 2 === 0) {
                        writeInstance(
                            bufferA,
                            usedA,
                            x,
                            y,
                            0,
                            params.scale,
                        );
                        usedA++;
                    } else {
                        writeInstance(
                            bufferB,
                            usedB,
                            x,
                            y,
                            0,
                            params.scale,
                        );
                        usedB++;
                    }
                }
            }
            for (
                let index = usedA;
                index < LATTICE_CAPACITY;
                index++
            ) {
                writeHidden(bufferA, index);
            }
            for (
                let index = usedB;
                index < LATTICE_CAPACITY;
                index++
            ) {
                writeHidden(bufferB, index);
            }
            flushThinInstances(latticeA);
            flushThinInstances(latticeB);

            // The preview pool varies how much of its capacity is visible.
            const shown =
                STYLE_CYCLE.indexOf(styler.style) + 2;
            for (let index = 0; index < shown; index++) {
                writeInstance(
                    bufferPreview,
                    index,
                    index - 2,
                    4.2,
                    0,
                    0.45,
                );
            }
            flushThinInstances(preview);
            setThinInstanceCount(preview, shown);

            sparks.update(STEP);
        }

        frame++;
        if (frame === READY_FRAME) {
            canvas.dataset.ready = "true";
        }
    });

    await registerScene(scene);
    await startEngine(engine);
}

main().catch((error) => console.error(error));
