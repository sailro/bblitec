# Current status

`bblitec` is a real compiler for a deliberately constrained reachable subset
of Babylon Lite. It is not yet a universal TypeScript or Babylon runtime.
The supported feature set, split into what is decided at compile time and what
lives at run time, is in [features](features.md).

## Curated parity scenes

Thresholds live in `src/scene-registry.ts`; run one scene with
`npm run scene -- parity scene<ID>` or all registered parity scenes with
`npm run scenes:parity`.

Both native GPU backends are measured against the same full-page goldens,
including reached DOM/CSS UI. Dawn renders through the browser reference's own
compiler and rasterization stack (see [backends](backends.md)). Each backend
column is full-image / foreground MAD. Severity:
green below 0.500,
$\color{#9a6700}{\textsf{yellow from 0.500 to below 1.000}}$, and
$\color{#cf222e}{\textsf{red above 1.000}}$.
A value in the green band prints plain; colour marks only values that need
attention. This keeps the table within GitHub's math-rendering limit.

A scene that does not reach zero carries a recorded adaptation: every
generated scene writes a `fidelity.json` giving the source and native
semantics side by side, with its risk and validation.

Scenes 40, 44 and 100 compare Bullet with Havok at the same moving pose, not
two renderers over one simulation. Scene 100's golden is byte-identical to
scene 40's, which makes it the collision-event variant of that scene; scene
44 freezes two stacks mid-collapse, one of them started asleep
([fidelity](fidelity.md#physics-contract)).

| Scene | Preview | SDL_GPU | Dawn | Coverage |
| ---: | :---: | ---: | ---: | --- |
| 1 | <img src="images/scenes/scene1.png" alt="Scene 1 BoomBox rendering" width="160"> | 0.001 / 0.007 | 0.001 / 0.007 | BoomBox PBR |
| 2 | <img src="images/scenes/scene2.png" alt="Scene 2 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Directional Light Sphere |
| 3 | <img src="images/scenes/scene3.png" alt="Scene 3 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Fog Boxes |
| 4 | <img src="images/scenes/scene4.png" alt="Scene 4 rendering" width="160"> | 0.262 / 0.262 | 0.262 / 0.262 | ESM Directional and PCF Spot Shadows |
| 5 | <img src="images/scenes/scene5.png" alt="Scene 5 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Alien Morph and Skeleton |
| 6 | <img src="images/scenes/scene6.png" alt="Scene 6 rendering" width="160"> | 0.001 / 0.013 | 0.001 / 0.013 | PBR Gold Sphere |
| 7 | <img src="images/scenes/scene7.png" alt="Scene 7 ChibiRex rendering" width="160"> | 0.001 / 0.010 | 0.001 / 0.010 | ChibiRex Default Camera |
| 8 | <img src="images/scenes/scene8.png" alt="Scene 8 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | HDR Glass Sphere |
| 9 | <img src="images/scenes/scene9.png" alt="Scene 9 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Sponza |
| 10 | <img src="images/scenes/scene10.png" alt="Scene 10 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | PBR Rough Sphere |
| 11 | <img src="images/scenes/scene11.png" alt="Scene 11 rendering" width="160"> | 0.010 / 0.281 | 0.010 / 0.281 | Spec-Gloss Shark |
| 12 | <img src="images/scenes/scene12.png" alt="Scene 12 rendering" width="160"> | 0.000 / 0.003 | 0.000 / 0.003 | PBR Shader Balls |
| 13 | <img src="images/scenes/scene13.png" alt="Scene 13 rendering" width="160"> | 0.001 / 0.006 | 0.001 / 0.006 | PBR Spheres Grid |
| 14 | <img src="images/scenes/scene14.png" alt="Scene 14 rendering" width="160"> | 0.012 / 0.006 | 0.012 / 0.006 | Flight Helmet |
| 15 | <img src="images/scenes/scene15.png" alt="Scene 15 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Two Spot Lights |
| 16 | <img src="images/scenes/scene16.png" alt="Scene 16 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Thin Instances |
| 17 | <img src="images/scenes/scene17.png" alt="Scene 17 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | PBR and Standard Thin Instances |
| 18 | <img src="images/scenes/scene18.png" alt="Scene 18 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | PCF Spotlight Shadows |
| 19 | <img src="images/scenes/scene19.png" alt="Scene 19 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | PBR Clearcoat |
| 20 | <img src="images/scenes/scene20.png" alt="Scene 20 rendering" width="160"> | 0.002 / 0.007 | 0.002 / 0.007 | PBR Emissive Sphere Grid |
| 21 | <img src="images/scenes/scene21.png" alt="Scene 21 rendering" width="160"> | 0.330 / 0.330 | 0.330 / 0.330 | PBR Sheen Cloth |
| 22 | <img src="images/scenes/scene22.png" alt="Scene 22 rendering" width="160"> | 0.232 / 0.232 | 0.232 / 0.232 | PBR Shadow Receiver |
| 23 | <img src="images/scenes/scene23.png" alt="Scene 23 rendering" width="160"> | 0.002 / 0.017 | 0.002 / 0.017 | PBR Anisotropy |
| 24 | <img src="images/scenes/scene24.png" alt="Scene 24 rendering" width="160"> | 0.004 / 0.004 | 0.000 / 0.000 | Hill Valley |
| 25 | <img src="images/scenes/scene25.png" alt="Scene 25 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | KTX Compressed Texture |
| 26 | <img src="images/scenes/scene26.png" alt="Scene 26 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | PBR Subsurface |
| 27 | <img src="images/scenes/scene27.png" alt="Scene 27 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Material Variants |
| 28 | <img src="images/scenes/scene28.png" alt="Scene 28 rendering" width="160"> | 0.001 / 0.007 | 0.001 / 0.007 | Clearcoat glTF |
| 29 | <img src="images/scenes/scene29.png" alt="Scene 29 rendering" width="160"> | 0.000 / 0.008 | 0.000 / 0.008 | Sheen Cloth glTF |
| 30 | <img src="images/scenes/scene30.png" alt="Scene 30 rendering" width="160"> | 0.007 / 0.010 | 0.003 / 0.005 | Volume Testing |
| 31 | <img src="images/scenes/scene31.png" alt="Scene 31 rendering" width="160"> | 0.000 / 0.003 | 0.000 / 0.003 | Emissive Strength |
| 32 | <img src="images/scenes/scene32.png" alt="Scene 32 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Unlit glTF |
| 33 | <img src="images/scenes/scene33.png" alt="Scene 33 rendering" width="160"> | 0.000 / 0.009 | 0.000 / 0.006 | Punctual Lights |
| 34 | <img src="images/scenes/scene34.png" alt="Scene 34 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Node Visibility |
| 35 | <img src="images/scenes/scene35.png" alt="Scene 35 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Simple Instancing |
| 36 | <img src="images/scenes/scene36.png" alt="Scene 36 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Basis Universal Texture |
| 37 | <img src="images/scenes/scene37.png" alt="Scene 37 rendering" width="160"> | 0.001 / 0.006 | 0.001 / 0.006 | Sheen Wood Leather Sofa |
| 38 | <img src="images/scenes/scene38.png" alt="Scene 38 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Mesh Builder Gallery |
| 39 | <img src="images/scenes/scene39.png" alt="Scene 39 rendering" width="160"> | 0.000 / 0.001 | 0.000 / 0.001 | Animated Waterfall |
| 40 | <img src="images/scenes/scene40.png" alt="Scene 40 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.332}} / \color{#9a6700}{\textsf{0.777}}$ | $\color{#1a7f37}{\textsf{0.332}} / \color{#9a6700}{\textsf{0.777}}$ | Bullet/Havok sphere-drop solver delta; not a renderer-fidelity value. |
| 43 | <img src="images/scenes/scene43.png" alt="Scene 43 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Parametric Proximity Path |
| 44 | <img src="images/scenes/scene44.png" alt="Scene 44 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.007}} / \color{#1a7f37}{\textsf{0.047}}$ | $\color{#1a7f37}{\textsf{0.007}} / \color{#1a7f37}{\textsf{0.047}}$ | Bullet/Havok sleeping-tower solver delta; not a renderer-fidelity value. |
| 50 | <img src="images/scenes/scene50.png" alt="Scene 50 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Sprite Grid |
| 51 | <img src="images/scenes/scene51.png" alt="Scene 51 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Soft-Edged Sprite Grid |
| 52 | <img src="images/scenes/scene52.png" alt="Scene 52 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | HUD on 3D |
| 53 | <img src="images/scenes/scene53.png" alt="Scene 53 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Depth-Hosted Sprites |
| 54 | <img src="images/scenes/scene54.png" alt="Scene 54 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Facing Billboards |
| 55 | <img src="images/scenes/scene55.png" alt="Scene 55 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Billboard Field |
| 56 | <img src="images/scenes/scene56.png" alt="Scene 56 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Axis-Locked Billboards |
| 57 | <img src="images/scenes/scene57.png" alt="Scene 57 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Cutout Billboards |
| 58 | <img src="images/scenes/scene58.png" alt="Scene 58 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Sprite2D Frame Animation |
| 59 | <img src="images/scenes/scene59.png" alt="Scene 59 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Billboard Sprite Frame Animation |
| 60 | <img src="images/scenes/scene60.png" alt="Scene 60 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Flat Colour |
| 61 | <img src="images/scenes/scene61.png" alt="Scene 61 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Normal Colour |
| 62 | <img src="images/scenes/scene62.png" alt="Scene 62 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Diffuse Texture |
| 63 | <img src="images/scenes/scene63.png" alt="Scene 63 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Directional Light |
| 64 | <img src="images/scenes/scene64.png" alt="Scene 64 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Morph Targets |
| 65 | <img src="images/scenes/scene65.png" alt="Scene 65 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Node Material Shadow Receiver |
| 66 | <img src="images/scenes/scene66.png" alt="Scene 66 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Full Playground |
| 67 | <img src="images/scenes/scene67.png" alt="Scene 67 rendering" width="160"> | 0.000 / 0.002 | 0.000 / 0.002 | NME PBR Core |
| 68 | <img src="images/scenes/scene68.png" alt="Scene 68 rendering" width="160"> | 0.000 / 0.004 | 0.000 / 0.004 | NME PBR Clearcoat |
| 69 | <img src="images/scenes/scene69.png" alt="Scene 69 rendering" width="160"> | 0.000 / 0.008 | 0.000 / 0.008 | NME PBR Sheen |
| 70 | <img src="images/scenes/scene70.png" alt="Scene 70 rendering" width="160"> | 0.001 / 0.021 | 0.001 / 0.021 | NME PBR Anisotropy |
| 71 | <img src="images/scenes/scene71.png" alt="Scene 71 rendering" width="160"> | 0.000 / 0.008 | 0.000 / 0.008 | NME PBR Subsurface |
| 72 | <img src="images/scenes/scene72.png" alt="Scene 72 rendering" width="160"> | 0.001 / 0.011 | 0.001 / 0.011 | NME PBR Full |
| 74 | <img src="images/scenes/scene74.png" alt="Scene 74 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Effect Renderer |
| 75 | <img src="images/scenes/scene75.png" alt="Scene 75 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Effect Render Target |
| 76 | <img src="images/scenes/scene76.png" alt="Scene 76 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Effect Texture |
| 77 | <img src="images/scenes/scene77.png" alt="Scene 77 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Pass-Through Blocks |
| 78 | <img src="images/scenes/scene78.png" alt="Scene 78 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Math Blocks |
| 79 | <img src="images/scenes/scene79.png" alt="Scene 79 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Curves and Waves |
| 80 | <img src="images/scenes/scene80.png" alt="Scene 80 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Colour Blocks |
| 81 | <img src="images/scenes/scene81.png" alt="Scene 81 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME UV Projection |
| 82 | <img src="images/scenes/scene82.png" alt="Scene 82 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Procedural Noise |
| 83 | <img src="images/scenes/scene83.png" alt="Scene 83 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Normals |
| 84 | <img src="images/scenes/scene84.png" alt="Scene 84 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Fragment Depth |
| 85 | <img src="images/scenes/scene85.png" alt="Scene 85 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Matrix Blocks |
| 87 | <img src="images/scenes/scene87.png" alt="Scene 87 rendering" width="160"> | 0.000 / 0.001 | 0.000 / 0.001 | NME Iridescence and Image Processing |
| 88 | <img src="images/scenes/scene88.png" alt="Scene 88 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Loop Block |
| 89 | <img src="images/scenes/scene89.png" alt="Scene 89 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NME Storage Blocks |
| 90 | <img src="images/scenes/scene90.png" alt="Scene 90 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | CSG Operations |
| 92 | <img src="images/scenes/scene92.png" alt="Scene 92 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Sprite Custom Shader |
| 93 | <img src="images/scenes/scene93.png" alt="Scene 93 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Sprite Palette Shader |
| 94 | <img src="images/scenes/scene94.png" alt="Scene 94 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Billboard Custom Shader |
| 95 | <img src="images/scenes/scene95.png" alt="Scene 95 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Billboard Palette Shader |
| 96 | <img src="images/scenes/scene96.png" alt="Scene 96 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Sprite UV Scroll |
| 97 | <img src="images/scenes/scene97.png" alt="Scene 97 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Sprite Multiply Blend |
| 98 | <img src="images/scenes/scene98.png" alt="Scene 98 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Billboard Sprites |
| 99 | <img src="images/scenes/scene99.png" alt="Scene 99 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Bone Control |
| 100 | <img src="images/scenes/scene100.png" alt="Scene 100 rendering" width="160"> | $\color{#1a7f37}{\textsf{0.332}} / \color{#9a6700}{\textsf{0.777}}$ | $\color{#1a7f37}{\textsf{0.332}} / \color{#9a6700}{\textsf{0.777}}$ | Bullet/Havok collision-event solver delta; not a renderer-fidelity value. |
| 110 | <img src="images/scenes/scene110.png" alt="Scene 110 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Render Target Diffuse Texture |
| 111 | <img src="images/scenes/scene111.png" alt="Scene 111 rendering" width="160"> | 0.000 / 0.001 | 0.000 / 0.001 | Scene-Wide Light UBO Stress |
| 116 | <img src="images/scenes/scene116.png" alt="Scene 116 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | No-Color Depth Views |
| 117 | <img src="images/scenes/scene117.png" alt="Scene 117 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | 2D Sprite Picking |
| 118 | <img src="images/scenes/scene118.png" alt="Scene 118 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Billboard Sprite Picking |
| 120 | <img src="images/scenes/scene120.png" alt="Scene 120 rendering" width="160"> | 0.001 / 0.003 | 0.001 / 0.003 | Gaussian Splatting |
| 125 | <img src="images/scenes/scene125.png" alt="Scene 125 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Gaussian Splat Transform Bake |
| 126 | <img src="images/scenes/scene126.png" alt="Scene 126 rendering" width="160"> | 0.000 / 0.001 | 0.002 / 0.005 | Gaussian Splat Shader Plugin |
| 127 | <img src="images/scenes/scene127.png" alt="Scene 127 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Gaussian Splat Linear Depth |
| 128 | <img src="images/scenes/scene128.png" alt="Scene 128 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Gaussian Splat Alpha-Blended Depth |
| 129 | <img src="images/scenes/scene129.png" alt="Scene 129 rendering" width="160"> | 0.001 / 0.004 | 0.001 / 0.004 | Gaussian Splat GPU Picking |
| 141 | <img src="images/scenes/scene141.png" alt="Scene 141 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Node, Standard and PBR ESM Casters |
| 142 | <img src="images/scenes/scene142.png" alt="Scene 142 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Post-Process Viewports |
| 143 | <img src="images/scenes/scene143.png" alt="Scene 143 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Post-Process Chain |
| 144 | <img src="images/scenes/scene144.png" alt="Scene 144 rendering" width="160"> | 0.003 / 0.018 | 0.004 / 0.020 | Bloom |
| 145 | <img src="images/scenes/scene145.png" alt="Scene 145 rendering" width="160"> | 0.022 / 0.021 | 0.010 / 0.009 | Standard Geometry Outputs |
| 146 | <img src="images/scenes/scene146.png" alt="Scene 146 rendering" width="160"> | 0.003 / 0.003 | 0.003 / 0.003 | PBR Geometry Outputs |
| 147 | <img src="images/scenes/scene147.png" alt="Scene 147 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Circle of Confusion |
| 148 | <img src="images/scenes/scene148.png" alt="Scene 148 rendering" width="160"> | 0.001 / 0.001 | 0.001 / 0.001 | Depth of Field |
| 150 | <img src="images/scenes/scene150.png" alt="Scene 150 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Property Position Animation |
| 151 | <img src="images/scenes/scene151.png" alt="Scene 151 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Property Transform Animation |
| 152 | <img src="images/scenes/scene152.png" alt="Scene 152 rendering" width="160"> | 0.010 / 0.281 | 0.010 / 0.281 | Managed Animation Groups |
| 154 | <img src="images/scenes/scene154.png" alt="Scene 154 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | STEP Time Animation |
| 155 | <img src="images/scenes/scene155.png" alt="Scene 155 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Weighted Property Blending |
| 156 | <img src="images/scenes/scene156.png" alt="Scene 156 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Manual Cross-Fade Animation |
| 157 | <img src="images/scenes/scene157.png" alt="Scene 157 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Weighted Skeleton Blending |
| 158 | <img src="images/scenes/scene158.png" alt="Scene 158 rendering" width="160"> | 0.000 / 0.001 | 0.000 / 0.001 | Additive Pose Blending |
| 159 | <img src="images/scenes/scene159.png" alt="Scene 159 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Shader Flat Color |
| 160 | <img src="images/scenes/scene160.png" alt="Scene 160 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Shader Texture Sampler |
| 161 | <img src="images/scenes/scene161.png" alt="Scene 161 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Shader Custom Uniforms |
| 162 | <img src="images/scenes/scene162.png" alt="Scene 162 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Shader Defines |
| 163 | <img src="images/scenes/scene163.png" alt="Scene 163 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Shader Alpha Cutout |
| 165 | <img src="images/scenes/scene165.png" alt="Scene 165 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Shader Material Thin Instances |
| 166 | <img src="images/scenes/scene166.png" alt="Scene 166 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Clustered Sponza Spot Lights |
| 167 | <img src="images/scenes/scene167.png" alt="Scene 167 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | PBR Lightmap |
| 168 | <img src="images/scenes/scene168.png" alt="Scene 168 rendering" width="160"> | 0.000 / 0.002 | 0.000 / 0.002 | Mirrored Double-Sided Winding |
| 170 | <img src="images/scenes/scene170.png" alt="Scene 170 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Navigation Crowd |
| 171 | <img src="images/scenes/scene171.png" alt="Scene 171 rendering" width="160"> | 0.013 / 0.028 | 0.013 / 0.028 | Navigation Crowd Path |
| 172 | <img src="images/scenes/scene172.png" alt="Scene 172 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Navigation Tile Cache Obstacles |
| 173 | <img src="images/scenes/scene173.png" alt="Scene 173 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Navigation Obstacle Toggle |
| 174 | <img src="images/scenes/scene174.png" alt="Scene 174 rendering" width="160"> | 0.006 / 0.023 | 0.006 / 0.023 | Navigation Off-Mesh Connections |
| 175 | <img src="images/scenes/scene175.png" alt="Scene 175 rendering" width="160"> | 0.006 / 0.023 | 0.006 / 0.023 | Navigation Raycast |
| 176 | <img src="images/scenes/scene176.png" alt="Mosquito in Amber" width="160"> | 0.016 / 0.016 | 0.014 / 0.014 | Mosquito In Amber |
| 177 | <img src="images/scenes/scene177.png" alt="Scene 177 rendering" width="160"> | 0.021 / 0.021 | 0.021 / 0.021 | Iridescence Sphere |
| 178 | <img src="images/scenes/scene178.png" alt="Scene 178 rendering" width="160"> | 0.018 / 0.016 | 0.018 / 0.016 | Iridescence Abalone |
| 179 | <img src="images/scenes/scene179.png" alt="Scene 179 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Clustered Sponza Lights |
| 200 | <img src="images/scenes/scene200.png" alt="Scene 200 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | High-Precision Matrix Off |
| 201 | <img src="images/scenes/scene201.png" alt="Scene 201 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | High-Precision Matrix On |
| 202 | <img src="images/scenes/scene202.png" alt="Scene 202 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Floating Origin Point Light |
| 203 | <img src="images/scenes/scene203.png" alt="Scene 203 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Floating Origin Spot Light |
| 204 | <img src="images/scenes/scene204.png" alt="Scene 204 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Floating Origin Thin Instances |
| 205 | <img src="images/scenes/scene205.png" alt="Scene 205 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Floating Origin Facing Billboards |
| 206 | <img src="images/scenes/scene206.png" alt="Scene 206 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Floating Origin Cutout Billboards |
| 207 | <img src="images/scenes/scene207.png" alt="Scene 207 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Floating Origin Directional Shadows |
| 210 | <img src="images/scenes/scene210.png" alt="Scene 210 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | XMP Metadata Rounded Cube |
| 211 | <img src="images/scenes/scene211.png" alt="Scene 211 rendering" width="160"> | 0.000 / 0.002 | 0.000 / 0.002 | BrainStem Meshopt |
| 212 | <img src="images/scenes/scene212.png" alt="Scene 212 rendering" width="160"> | 0.014 / 0.016 | 0.010 / 0.011 | Dispersion Test |
| 213 | <img src="images/scenes/scene213.png" alt="Scene 213 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Grid Material Ordering |
| 214 | <img src="images/scenes/scene214.png" alt="Scene 214 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Cascaded Shadow Torus Knots |
| 215 | <img src="images/scenes/scene215.png" alt="Scene 215 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Cascaded Shadows On A PBR Receiver |
| 216 | <img src="images/scenes/scene216.png" alt="Scene 216 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | PBR Fog |
| 217 | <img src="images/scenes/scene217.png" alt="Scene 217 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Material Plugins |
| 220 | <img src="images/scenes/scene220.png" alt="Scene 220 rendering" width="160"> | 0.001 / 0.002 | 0.001 / 0.002 | Quantized Duck |
| 223 | <img src="images/scenes/scene223.png" alt="Scene 223 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Camera And Light Gizmos |
| 226 | <img src="images/scenes/scene226.png" alt="Scene 226 rendering" width="160"> | 0.001 / 0.003 | 0.001 / 0.003 | Gaussian Splatting glTF |
| 229 | <img src="images/scenes/scene229.png" alt="Scene 229 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Triangle Without Indices |
| 240 | <img src="images/scenes/scene240.png" alt="Scene 240 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Animated Triangle |
| 242 | <img src="images/scenes/scene242.png" alt="Scene 242 rendering" width="160"> | 0.000 / 0.004 | 0.000 / 0.004 | Emissive Fireflies |
| 243 | <img src="images/scenes/scene243.png" alt="Scene 243 rendering" width="160"> | 0.000 / 0.005 | 0.000 / 0.005 | Morph Stress Test |
| 244 | <img src="images/scenes/scene244.png" alt="Scene 244 rendering" width="160"> | 0.001 / 0.011 | 0.001 / 0.011 | Pot of Coals |
| 245 | <img src="images/scenes/scene245.png" alt="Scene 245 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Recursive Skeletons |
| 246 | <img src="images/scenes/scene246.png" alt="Scene 246 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Simple Skin |
| 247 | <img src="images/scenes/scene247.png" alt="Scene 247 rendering" width="160"> | 0.001 / 0.009 | 0.001 / 0.009 | Teapots Galore |
| 248 | <img src="images/scenes/scene248.png" alt="Scene 248 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Texture Settings |
| 249 | <img src="images/scenes/scene249.png" alt="Scene 249 rendering" width="160"> | 0.000 / 0.004 | 0.000 / 0.004 | Vertex Alpha Clip |
| 250 | <img src="images/scenes/scene250.png" alt="Scene 250 rendering" width="160"> | 0.004 / 0.004 | 0.003 / 0.003 | VirtualCity Cameras |
| 251 | <img src="images/scenes/scene251.png" alt="Scene 251 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Animation Group Mask |
| 252 | <img src="images/scenes/scene252.png" alt="Scene 252 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Standard Morph Target |
| 253 | <img src="images/scenes/scene253.png" alt="Scene 253 rendering" width="160"> | 0.001 / 0.002 | 0.001 / 0.002 | Animate All The Things |
| 254 | <img src="images/scenes/scene254.png" alt="Scene 254 rendering" width="160"> | 0.001 / 0.003 | 0.001 / 0.003 | Animation Sampler Type |
| 255 | <img src="images/scenes/scene255.png" alt="Scene 255 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Animation Skin Type |
| 256 | <img src="images/scenes/scene256.png" alt="Scene 256 rendering" width="160"> | 0.000 / 0.005 | 0.000 / 0.005 | Normal Tangent Test |
| 257 | <img src="images/scenes/scene257.png" alt="Scene 257 rendering" width="160"> | 0.001 / 0.005 | 0.001 / 0.005 | Node Negative Scale |
| 258 | <img src="images/scenes/scene258.png" alt="Scene 258 rendering" width="160"> | 0.002 / 0.004 | 0.002 / 0.004 | Interleaved Buffer |
| 259 | <img src="images/scenes/scene259.png" alt="Scene 259 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Material Texture |
| 260 | <img src="images/scenes/scene260.png" alt="Scene 260 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Triangle Strip Primitive |
| 262 | <img src="images/scenes/scene262.png" alt="Scene 262 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NPE Particle Size |
| 263 | <img src="images/scenes/scene263.png" alt="Scene 263 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NPE Particle Gravity |
| 264 | <img src="images/scenes/scene264.png" alt="Scene 264 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NPE Particle Sphere Emitter |
| 265 | <img src="images/scenes/scene265.png" alt="Scene 265 rendering" width="160"> | 0.000 / 0.008 | 0.000 / 0.008 | Environment Test |
| 266 | <img src="images/scenes/scene266.png" alt="Scene 266 rendering" width="160"> | 0.009 / 0.017 | 0.009 / 0.017 | Negative Scale Spheres |
| 267 | <img src="images/scenes/scene267.png" alt="Scene 267 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Standard Vertex Colors |
| 268 | <img src="images/scenes/scene268.png" alt="Scene 268 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Orthographic Camera |
| 269 | <img src="images/scenes/scene269.png" alt="Scene 269 rendering" width="160"> | 0.001 / 0.006 | 0.001 / 0.006 | Mirrored Transform Reparenting |
| 270 | <img src="images/scenes/scene270.png" alt="Scene 270 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Mirrored Standard Meshes |
| 271 | <img src="images/scenes/scene271.png" alt="Scene 271 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Shadow Light Rebuild |
| 273 | <img src="images/scenes/scene273.png" alt="Scene 273 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Runtime Material Family |
| 274 | <img src="images/scenes/scene274.png" alt="Scene 274 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Alpha to Coverage |
| 276 | <img src="images/scenes/scene276.png" alt="Scene 276 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NPE Sprite Sheet Particles |
| 277 | <img src="images/scenes/scene277.png" alt="Scene 277 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NPE Attractor Update |
| 278 | <img src="images/scenes/scene278.png" alt="Scene 278 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Line System |
| 279 | <img src="images/scenes/scene279.png" alt="Scene 279 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Line System Update |
| 280 | <img src="images/scenes/scene280.png" alt="Scene 280 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NPE Flow Map Update |
| 281 | <img src="images/scenes/scene281.png" alt="Scene 281 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NPE Noise Update |
| 282 | <img src="images/scenes/scene282.png" alt="Scene 282 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Standard UV Transform |
| 283 | <img src="images/scenes/scene283.png" alt="Scene 283 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NPE Multiply Blend |
| 284 | <img src="images/scenes/scene284.png" alt="Scene 284 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NPE MultiplyAdd Blend |
| 301 | <img src="images/scenes/scene301.png" alt="Scene 301 rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | NPE Sprite2D Blend Modes |

## Upstream application gates

These are complete applications copied byte-for-byte from the same pinned
Babylon Lite source as the curated scenes. Their full reached source and asset
graphs are SHA-256-checked, then compiled, rendered, and measured by the same
two-backend validation path. They exercise cross-feature behavior that a small
parity scene intentionally does not.

| Application | Preview | SDL_GPU | Dawn | Coverage |
| --- | :---: | ---: | ---: | --- |
| Tetris | <img src="images/scenes/tetris.png" alt="Tetris rendering" width="160"> | $\color{#cf222e}{\textsf{1.333}} / \color{#cf222e}{\textsf{1.004}}$ | $\color{#cf222e}{\textsf{1.333}} / \color{#cf222e}{\textsf{1.004}}$ | Thin-instance game; audio; retained UI. UI residual; no-UI MAD: SDL_GPU 0.093 / 0.101, Dawn 0.093 / 0.101. |
| Doom | <img src="images/scenes/doom.png" alt="Doom rendering" width="160"> | 0.001 / 0.001 | 0.001 / 0.001 | WAD game; sprites; audio; retained UI. |
| LibreQuake | <img src="images/scenes/quake.png" alt="LibreQuake rendering" width="160"> | 0.058 / 0.058 | 0.058 / 0.058 | BSP/WAD2/MDL game; audio; Canvas2D HUD. |
| Torus States | <img src="images/scenes/torus-states.png" alt="Torus States rendering" width="160"> | 0.078 / 0.150 | 0.078 / 0.150 | Frame graph; offscreen effects; bloom. |
| Platformer | <img src="images/scenes/platformer.png" alt="Platformer rendering" width="160"> | $\color{#cf222e}{\textsf{1.046}} / \color{#cf222e}{\textsf{1.046}}$ | $\color{#cf222e}{\textsf{1.044}} / \color{#cf222e}{\textsf{1.044}}$ | Sprite game; CRT pass; audio; retained UI. UI residual; no-UI MAD: SDL_GPU 0.013 / 0.013, Dawn 0.010 / 0.010. |
| Break Meshes | <img src="images/scenes/break-meshes.png" alt="Break Meshes rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Voronoi fracture; PBR; physics. |
| Racer | <img src="images/scenes/racer.png" alt="Racer rendering" width="160"> | $\color{#cf222e}{\textsf{1.106}} / \color{#cf222e}{\textsf{1.106}}$ | $\color{#cf222e}{\textsf{1.106}} / \color{#cf222e}{\textsf{1.106}}$ | Driving game; CSM; physics; audio; retained HUD. UI residual; no-UI MAD: SDL_GPU 0.455 / 0.455, Dawn 0.455 / 0.455. |
| Littlest Tokyo | <img src="images/scenes/littlest-tokyo.png" alt="Littlest Tokyo rendering" width="160"> | 0.161 / 0.121 | 0.161 / 0.121 | Animated glTF; PBR/IBL; retained chrome. |
| Bath Day | <img src="images/scenes/bath-day.png" alt="Bath Day rendering" width="160"> | 0.134 / 0.185 | 0.134 / 0.185 | Skinned Draco/WebP glTF; transmission; retained chrome. |
| Freeciv | <img src="images/scenes/freeciv.png" alt="Freeciv rendering" width="160"> | 0.175 / 0.172 | 0.158 / 0.155 | Strategy map; sprites; picking; retained cursor/tooltips. |
| Voxel Sandbox | <img src="images/scenes/minecraft.png" alt="Voxel Sandbox rendering" width="160"> | $\color{#cf222e}{\textsf{1.414}} / \color{#cf222e}{\textsf{1.414}}$ | $\color{#cf222e}{\textsf{1.413}} / \color{#cf222e}{\textsf{1.414}}$ | Procedural voxel world; generated texture atlas; custom shader materials; audio; save/load; retained HUD and crosshair. UI residual; canvas-only MAD: SDL_GPU 0.000 / 0.000, Dawn 0.000 / 0.000. |

## Project-owned differential gates

These scenes are authored in `bblitec`, but their browser reference still runs
the same TypeScript against the pinned Babylon Lite package. Their MAD measures
native differential fidelity; it does not represent upstream corpus coverage.

They cover contracts absent from the measured corpus. A corpus scene supersedes
a project-owned gate when it reaches the same contract.

| Scene | Preview | SDL_GPU | Dawn | Coverage |
| ---: | :---: | ---: | ---: | --- |
| light-setters | <img src="images/scenes/regression-light-setters.png" alt="Light setters rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Light Vector Setters |
| property-animation-paths | <img src="images/scenes/regression-property-animation-paths.png" alt="Property animation paths rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Property Animation Paths |
| nav-crowd | <img src="images/scenes/regression-nav-crowd.png" alt="Navigation crowd step rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Navigation Crowd Step |
| nav-obstacles | <img src="images/scenes/regression-nav-obstacles.png" alt="Navigation obstacle removal rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Navigation Obstacle Removal |
| mesh-flags | <img src="images/scenes/regression-mesh-flags.png" alt="Mesh visible and pickable rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Mesh Visible and Pickable |
| material-falloff | <img src="images/scenes/regression-material-falloff.png" alt="Material falloff write rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Material Falloff Write |
| compiler-state | <img src="images/scenes/regression-compiler-state.png" alt="Compiler state rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Compiler State |
| glTF-track-clamp | <img src="images/scenes/regression-track-clamp.png" alt="glTF track clamp rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | glTF Track Clamp |
| shader-frame-graph | <img src="images/scenes/audit-shader-frame-graph.png" alt="Shader frame graph rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Shader Frame Graph |
| runtime-sweep | <img src="images/scenes/regression-runtime-sweep.png" alt="Runtime sweep rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Runtime Sweep |
| instanced-ground | <img src="images/scenes/regression-instanced-ground.png" alt="Instanced ground rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Instanced Ground |
| sprite-layer-arms | <img src="images/scenes/regression-sprite-layer-arms.png" alt="Sprite layer arms rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Sprite Layer Arms |
| glTF-sparse | <img src="images/scenes/regression-gltf-sparse.png" alt="glTF sparse accessors rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | glTF Sparse Accessors |
| glTF-uv-sets | <img src="images/scenes/regression-gltf-uv-sets.png" alt="glTF UV sets rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | glTF UV Sets |
| imported-mesh-walk | <img src="images/scenes/regression-imported-mesh-walk.png" alt="Imported mesh walk rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | Recursive Container Flatten |
| glTF-topology | <img src="images/scenes/regression-gltf-topology.png" alt="glTF primitive topology rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | glTF Primitive Topology |
| glTF-step-animation | <img src="images/scenes/regression-gltf-step-animation.png" alt="glTF STEP animation rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | glTF STEP Animation |
| morph-ground | <img src="images/scenes/regression-morph-ground.png" alt="Morph storage ground rendering" width="160"> | 0.000 / 0.001 | 0.000 / 0.001 | Morph Storage Ground |
| shadow-pbr-only | <img src="images/scenes/regression-shadow-pbr-only.png" alt="PBR shadows without Standard rendering" width="160"> | 0.000 / 0.000 | 0.000 / 0.000 | PBR Shadow Receiver Without Standard |
