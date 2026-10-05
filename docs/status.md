# Current status

Published full-image / foreground MAD against pinned browser references. `pixel-perfect` marks a
backend whose capture matches its reference exactly; a MAD below 0.0005 that is not zero still reads
0.000. Registry poses/gates and repeatability exceptions remain authoritative.
Values describe saved reports, not the current working tree. Verify with `npm run status:verify`.

## Curated parity scenes

Numbered scene coverage starts with its registry name. Colors: below 0.5 green,
0.5–1 yellow, 1+ red. Repeatability-exempt rows retain their published values.
Physics rows measure Bullet against Havok: their residuals are solver deltas, not renderer fidelity
([contract](fidelity.md#physics-contract)).

| Scene | Preview | SDL_GPU | Dawn | Coverage |
| ---: | :---: | ---: | ---: | --- |
| 1 | <img src="images/scenes/scene1.png" alt="Scene 1 BoomBox rendering" width="160"> | pixel‑perfect | pixel‑perfect | BoomBox PBR |
| 2 | <img src="images/scenes/scene2.png" alt="Scene 2 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Directional Light Sphere |
| 3 | <img src="images/scenes/scene3.png" alt="Scene 3 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Fog Boxes |
| 4 | <img src="images/scenes/scene4.png" alt="Scene 4 rendering" width="160"> | 0.042/0.042 | 0.042/0.042 | ESM Directional and PCF Spot Shadows |
| 5 | <img src="images/scenes/scene5.png" alt="Scene 5 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Alien Morph and Skeleton |
| 6 | <img src="images/scenes/scene6.png" alt="Scene 6 rendering" width="160"> | pixel‑perfect | pixel‑perfect | PBR Gold Sphere |
| 7 | <img src="images/scenes/scene7.png" alt="Scene 7 ChibiRex rendering" width="160"> | 0.001/0.008 | 0.001/0.008 | ChibiRex Default Camera |
| 8 | <img src="images/scenes/scene8.png" alt="Scene 8 rendering" width="160"> | pixel‑perfect | pixel‑perfect | HDR Glass Sphere |
| 9 | <img src="images/scenes/scene9.png" alt="Scene 9 rendering" width="160"> | pixel‑perfect | 0.000/0.000 | Sponza |
| 10 | <img src="images/scenes/scene10.png" alt="Scene 10 rendering" width="160"> | pixel‑perfect | pixel‑perfect | PBR Rough Sphere |
| 11 | <img src="images/scenes/scene11.png" alt="Scene 11 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Spec-Gloss Shark |
| 12 | <img src="images/scenes/scene12.png" alt="Scene 12 rendering" width="160"> | pixel‑perfect | pixel‑perfect | PBR Shader Balls |
| 13 | <img src="images/scenes/scene13.png" alt="Scene 13 rendering" width="160"> | pixel‑perfect | pixel‑perfect | PBR Spheres Grid |
| 14 | <img src="images/scenes/scene14.png" alt="Scene 14 rendering" width="160"> | 0.000/0.005 | pixel‑perfect | Flight Helmet |
| 15 | <img src="images/scenes/scene15.png" alt="Scene 15 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Two Spot Lights |
| 16 | <img src="images/scenes/scene16.png" alt="Scene 16 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Thin Instances |
| 17 | <img src="images/scenes/scene17.png" alt="Scene 17 rendering" width="160"> | pixel‑perfect | pixel‑perfect | PBR and Standard Thin Instances |
| 18 | <img src="images/scenes/scene18.png" alt="Scene 18 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | PCF Spotlight Shadows |
| 19 | <img src="images/scenes/scene19.png" alt="Scene 19 rendering" width="160"> | pixel‑perfect | pixel‑perfect | PBR Clearcoat |
| 20 | <img src="images/scenes/scene20.png" alt="Scene 20 rendering" width="160"> | pixel‑perfect | pixel‑perfect | PBR Emissive Sphere Grid |
| 21 | <img src="images/scenes/scene21.png" alt="Scene 21 rendering" width="160"> | pixel‑perfect | pixel‑perfect | PBR Sheen Cloth |
| 22 | <img src="images/scenes/scene22.png" alt="Scene 22 rendering" width="160"> | 0.040/0.040 | 0.040/0.040 | PBR Shadow Receiver |
| 23 | <img src="images/scenes/scene23.png" alt="Scene 23 rendering" width="160"> | pixel‑perfect | pixel‑perfect | PBR Anisotropy |
| 24 | <img src="images/scenes/scene24.png" alt="Scene 24 rendering" width="160"> | 0.000/0.000 | pixel‑perfect | Hill Valley |
| 25 | <img src="images/scenes/scene25.png" alt="Scene 25 rendering" width="160"> | pixel‑perfect | pixel‑perfect | KTX Compressed Texture |
| 26 | <img src="images/scenes/scene26.png" alt="Scene 26 rendering" width="160"> | pixel‑perfect | pixel‑perfect | PBR Subsurface |
| 27 | <img src="images/scenes/scene27.png" alt="Scene 27 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Material Variants |
| 28 | <img src="images/scenes/scene28.png" alt="Scene 28 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Clearcoat glTF |
| 29 | <img src="images/scenes/scene29.png" alt="Scene 29 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Sheen Cloth glTF |
| 30 | <img src="images/scenes/scene30.png" alt="Scene 30 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Volume Testing |
| 31 | <img src="images/scenes/scene31.png" alt="Scene 31 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Emissive Strength |
| 32 | <img src="images/scenes/scene32.png" alt="Scene 32 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Unlit glTF |
| 33 | <img src="images/scenes/scene33.png" alt="Scene 33 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Punctual Lights |
| 34 | <img src="images/scenes/scene34.png" alt="Scene 34 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Node Visibility |
| 35 | <img src="images/scenes/scene35.png" alt="Scene 35 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Simple Instancing |
| 36 | <img src="images/scenes/scene36.png" alt="Scene 36 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Basis Universal Texture |
| 37 | <img src="images/scenes/scene37.png" alt="Scene 37 rendering" width="160"> | 0.001/0.005 | 0.001/0.006 | Sheen Wood Leather Sofa |
| 38 | <img src="images/scenes/scene38.png" alt="Scene 38 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Mesh Builder Gallery |
| 39 | <img src="images/scenes/scene39.png" alt="Scene 39 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Animated Waterfall |
| 40 | <img src="images/scenes/scene40.png" alt="Scene 40 rendering" width="160"> | 0.003/0.006 | 0.003/0.006 | Havok Sphere Drop; Bullet on Havok's sub-steps, speculative landing and rebound |
| 41 | <img src="images/scenes/scene41.png" alt="Scene 41 rendering" width="160"> | 0.215/0.284 | 0.215/0.284 | Physics Shape Debug Viewer; Mesh, hull and compound bodies with retained debug overlays; free fall |
| 42 | <img src="images/scenes/scene42.png" alt="Scene 42 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Physics Clone Pre-Step |
| 43 | <img src="images/scenes/scene43.png" alt="Scene 43 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Parametric Proximity Path |
| 44 | <img src="images/scenes/scene44.png" alt="Scene 44 rendering" width="160"> | 0.006/0.037 | 0.006/0.037 | Physics Sleeping Towers |
| 45 | <img src="images/scenes/scene45.png" alt="Scene 45 rendering" width="160"> | 0.039/0.074 | 0.039/0.074 | Physics Collision Filtering; landing hops under -1 gravity |
| 46 | <img src="images/scenes/scene46.png" alt="Scene 46 rendering" width="160"> | 0.001/0.077 | 0.001/0.077 | Physics Constraints; Seven constraint types including radial limits; upstream frame 10. Later trajectories differ between solvers |
| 47 | <img src="images/scenes/scene47.png" alt="Scene 47 rendering" width="160"> | 0.000/0.001 | 0.000/0.001 | Physics Heightfield; Heightfield and six falling shape types; upstream frame 1. Later contact trajectories differ between solvers |
| 48 | <img src="images/scenes/scene48.png" alt="Scene 48 rendering" width="160"> | 0.060/0.098 | 0.060/0.098 | Physics Centre of Mass; Authored centres of mass under a kick, captured mid-topple; contact-instant lateral drift |
| 49 | <img src="images/scenes/scene49.png" alt="Scene 49 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Physics Shape Queries; cylinder/capsule proximity and cast with live rotation, query, orbit and resize controls |
| 50 | <img src="images/scenes/scene50.png" alt="Scene 50 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Sprite Grid |
| 51 | <img src="images/scenes/scene51.png" alt="Scene 51 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Soft-Edged Sprite Grid |
| 52 | <img src="images/scenes/scene52.png" alt="Scene 52 rendering" width="160"> | pixel‑perfect | pixel‑perfect | HUD on 3D |
| 53 | <img src="images/scenes/scene53.png" alt="Scene 53 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Depth-Hosted Sprites |
| 54 | <img src="images/scenes/scene54.png" alt="Scene 54 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Facing Billboards |
| 55 | <img src="images/scenes/scene55.png" alt="Scene 55 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Billboard Field |
| 56 | <img src="images/scenes/scene56.png" alt="Scene 56 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Axis-Locked Billboards |
| 57 | <img src="images/scenes/scene57.png" alt="Scene 57 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Cutout Billboards |
| 58 | <img src="images/scenes/scene58.png" alt="Scene 58 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Sprite2D Frame Animation |
| 59 | <img src="images/scenes/scene59.png" alt="Scene 59 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Billboard Sprite Frame Animation |
| 60 | <img src="images/scenes/scene60.png" alt="Scene 60 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Flat Colour |
| 61 | <img src="images/scenes/scene61.png" alt="Scene 61 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Normal Colour |
| 62 | <img src="images/scenes/scene62.png" alt="Scene 62 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Diffuse Texture |
| 63 | <img src="images/scenes/scene63.png" alt="Scene 63 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Directional Light |
| 64 | <img src="images/scenes/scene64.png" alt="Scene 64 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Morph Targets |
| 65 | <img src="images/scenes/scene65.png" alt="Scene 65 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Node Material Shadow Receiver |
| 66 | <img src="images/scenes/scene66.png" alt="Scene 66 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | NME Full Playground |
| 67 | <img src="images/scenes/scene67.png" alt="Scene 67 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME PBR Core |
| 68 | <img src="images/scenes/scene68.png" alt="Scene 68 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME PBR Clearcoat |
| 69 | <img src="images/scenes/scene69.png" alt="Scene 69 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME PBR Sheen |
| 70 | <img src="images/scenes/scene70.png" alt="Scene 70 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME PBR Anisotropy |
| 71 | <img src="images/scenes/scene71.png" alt="Scene 71 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME PBR Subsurface |
| 72 | <img src="images/scenes/scene72.png" alt="Scene 72 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME PBR Full |
| 73 | <img src="images/scenes/scene73.png" alt="Scene 73 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Split-Viewport NME Comparison |
| 74 | <img src="images/scenes/scene74.png" alt="Scene 74 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Effect Renderer |
| 75 | <img src="images/scenes/scene75.png" alt="Scene 75 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Effect Render Target |
| 76 | <img src="images/scenes/scene76.png" alt="Scene 76 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Effect Texture |
| 77 | <img src="images/scenes/scene77.png" alt="Scene 77 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Pass-Through Blocks |
| 78 | <img src="images/scenes/scene78.png" alt="Scene 78 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Math Blocks |
| 79 | <img src="images/scenes/scene79.png" alt="Scene 79 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Curves and Waves |
| 80 | <img src="images/scenes/scene80.png" alt="Scene 80 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Colour Blocks |
| 81 | <img src="images/scenes/scene81.png" alt="Scene 81 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME UV Projection |
| 82 | <img src="images/scenes/scene82.png" alt="Scene 82 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Procedural Noise |
| 83 | <img src="images/scenes/scene83.png" alt="Scene 83 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Normals |
| 84 | <img src="images/scenes/scene84.png" alt="Scene 84 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Fragment Depth |
| 85 | <img src="images/scenes/scene85.png" alt="Scene 85 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Matrix Blocks |
| 86 | <img src="images/scenes/scene86.png" alt="Scene 86 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Scene and Mesh State |
| 87 | <img src="images/scenes/scene87.png" alt="Scene 87 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Iridescence and Image Processing |
| 88 | <img src="images/scenes/scene88.png" alt="Scene 88 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Loop Block |
| 89 | <img src="images/scenes/scene89.png" alt="Scene 89 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NME Storage Blocks |
| 90 | <img src="images/scenes/scene90.png" alt="Scene 90 rendering" width="160"> | pixel‑perfect | pixel‑perfect | CSG Operations |
| 91 | <img src="images/scenes/scene91.png" alt="Scene 91 rendering" width="160"> | pixel‑perfect | pixel‑perfect | CSG2 Operations; Manifold operations and material partitions |
| 92 | <img src="images/scenes/scene92.png" alt="Scene 92 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Sprite Custom Shader |
| 93 | <img src="images/scenes/scene93.png" alt="Scene 93 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Sprite Palette Shader |
| 94 | <img src="images/scenes/scene94.png" alt="Scene 94 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Billboard Custom Shader |
| 95 | <img src="images/scenes/scene95.png" alt="Scene 95 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Billboard Palette Shader |
| 96 | <img src="images/scenes/scene96.png" alt="Scene 96 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Sprite UV Scroll |
| 97 | <img src="images/scenes/scene97.png" alt="Scene 97 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Sprite Multiply Blend |
| 98 | <img src="images/scenes/scene98.png" alt="Scene 98 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Billboard Sprites |
| 99 | <img src="images/scenes/scene99.png" alt="Scene 99 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Bone Control |
| 100 | <img src="images/scenes/scene100.png" alt="Scene 100 rendering" width="160"> | 0.003/0.006 | 0.003/0.006 | Havok Collision Event; Scene 40 plus the collision event |
| 101 | <img src="images/scenes/scene101.png" alt="Scene 101 rendering" width="160"> | 0.027/0.178 | 0.027/0.178 | Physics Trigger Volume; trigger drop two elastic bounces in; the rebound rule's 0.2% compounding |
| 102 | <img src="images/scenes/scene102.png" alt="Scene 102 rendering" width="160"> | 0.003/0.125 | 0.003/0.125 | Havok Filtered Raycast; raycast over triangle-soup colliders |
| 103 | <img src="images/scenes/scene103.png" alt="Scene 103 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Physics Raycast Instance Picking; exact captureFrame=5 pose. |
| 104 | <img src="images/scenes/scene104.png" alt="Scene 104 rendering" width="160"> | 0.013/0.012 | 0.013/0.012 | Havok Character Controller; Character capsule movement, collision events, keyboard/jump and camera follow; imported level lightmaps |
| 105 | <img src="images/scenes/scene105.png" alt="Scene 105 rendering" width="160"> | 0.032/0.023 | 0.032/0.023 | Havok Character Moving Platform; Character movement and animated platform |
| 106 | <img src="images/scenes/scene106.png" alt="Scene 106 rendering" width="160"> | 0.019/0.104 | 0.019/0.104 | Physics Motion and Prestep Grid; geometry and solver residual at frame 20. |
| 110 | <img src="images/scenes/scene110.png" alt="Scene 110 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Render Target Diffuse Texture |
| 111 | <img src="images/scenes/scene111.png" alt="Scene 111 rendering" width="160"> | 0.000/0.001 | 0.000/0.001 | Scene-Wide Light UBO Stress |
| 112 | <img src="images/scenes/scene112.png" alt="Scene 112 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Flight Helmet KTX2 |
| 113 | <img src="images/scenes/scene113.png" alt="Scene 113 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Picking Precision |
| 114 | <img src="images/scenes/scene114.png" alt="Scene 114 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Morph and Skeleton Picking |
| 115 | <img src="images/scenes/scene115.png" alt="Scene 115 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Alien Picking at Frame 100 |
| 116 | <img src="images/scenes/scene116.png" alt="Scene 116 rendering" width="160"> | pixel‑perfect | pixel‑perfect | No-Color Depth Views |
| 117 | <img src="images/scenes/scene117.png" alt="Scene 117 rendering" width="160"> | pixel‑perfect | pixel‑perfect | 2D Sprite Picking |
| 118 | <img src="images/scenes/scene118.png" alt="Scene 118 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Billboard Sprite Picking |
| 120 | <img src="images/scenes/scene120.png" alt="Scene 120 rendering" width="160"> | 0.001/0.003 | 0.001/0.003 | Gaussian Splatting |
| 121 | <img src="images/scenes/scene121.png" alt="Scene 121 rendering" width="160"> | 0.001/0.007 | 0.001/0.006 | Gaussian Splatting Data Updates |
| 122 | <img src="images/scenes/scene122.png" alt="Scene 122 rendering" width="160"> | 0.001/0.001 | 0.001/0.001 | Gaussian Splatting SOG |
| 123 | <img src="images/scenes/scene123.png" alt="Scene 123 rendering" width="160"> | 0.001/0.001 | 0.001/0.001 | Gaussian Splatting SPZ |
| 124 | <img src="images/scenes/scene124.png" alt="Scene 124 rendering" width="160"> | 0.000/0.002 | 0.000/0.003 | Compressed PLY Gaussian Splatting |
| 125 | <img src="images/scenes/scene125.png" alt="Scene 125 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Gaussian Splat Transform Bake |
| 126 | <img src="images/scenes/scene126.png" alt="Scene 126 rendering" width="160"> | 0.000/0.001 | 0.002/0.005 | Gaussian Splat Shader Plugin |
| 127 | <img src="images/scenes/scene127.png" alt="Scene 127 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Gaussian Splat Linear Depth |
| 128 | <img src="images/scenes/scene128.png" alt="Scene 128 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Gaussian Splat Alpha-Blended Depth |
| 129 | <img src="images/scenes/scene129.png" alt="Scene 129 rendering" width="160"> | 0.001/0.004 | 0.001/0.004 | Gaussian Splat GPU Picking |
| 140 | <img src="images/scenes/scene140.png" alt="Scene 140 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | NME Alpha-Discard Shadows |
| 141 | <img src="images/scenes/scene141.png" alt="Scene 141 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Node, Standard and PBR ESM Casters |
| 142 | <img src="images/scenes/scene142.png" alt="Scene 142 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Post-Process Viewports |
| 143 | <img src="images/scenes/scene143.png" alt="Scene 143 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Post-Process Chain |
| 144 | <img src="images/scenes/scene144.png" alt="Scene 144 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Bloom |
| 145 | <img src="images/scenes/scene145.png" alt="Scene 145 rendering" width="160"> | 0.016/0.015 | 0.010/0.009 | Standard Geometry Outputs |
| 146 | <img src="images/scenes/scene146.png" alt="Scene 146 rendering" width="160"> | 0.001/0.001 | 0.001/0.001 | PBR Geometry Outputs |
| 147 | <img src="images/scenes/scene147.png" alt="Scene 147 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Circle of Confusion |
| 148 | <img src="images/scenes/scene148.png" alt="Scene 148 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Depth of Field |
| 149 | <img src="images/scenes/scene149.png" alt="Scene 149 rendering" width="160"> | 0.007/0.009 | pixel‑perfect | Node Material Geometry Outputs |
| 150 | <img src="images/scenes/scene150.png" alt="Scene 150 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Property Position Animation |
| 151 | <img src="images/scenes/scene151.png" alt="Scene 151 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Property Transform Animation |
| 152 | <img src="images/scenes/scene152.png" alt="Scene 152 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Managed Animation Groups |
| 153 | <img src="images/scenes/scene153.png" alt="Scene 153 rendering" width="160"> | 0.000/0.028 | 0.000/0.028 | Autonomous Canvas Animation |
| 154 | <img src="images/scenes/scene154.png" alt="Scene 154 rendering" width="160"> | pixel‑perfect | pixel‑perfect | STEP Time Animation |
| 155 | <img src="images/scenes/scene155.png" alt="Scene 155 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Weighted Property Blending |
| 156 | <img src="images/scenes/scene156.png" alt="Scene 156 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Manual Cross-Fade Animation |
| 157 | <img src="images/scenes/scene157.png" alt="Scene 157 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Weighted Skeleton Blending |
| 158 | <img src="images/scenes/scene158.png" alt="Scene 158 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Additive Pose Blending |
| 159 | <img src="images/scenes/scene159.png" alt="Scene 159 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Shader Flat Color |
| 160 | <img src="images/scenes/scene160.png" alt="Scene 160 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Shader Texture Sampler |
| 161 | <img src="images/scenes/scene161.png" alt="Scene 161 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Shader Custom Uniforms |
| 162 | <img src="images/scenes/scene162.png" alt="Scene 162 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Shader Defines |
| 163 | <img src="images/scenes/scene163.png" alt="Scene 163 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Shader Alpha Cutout |
| 164 | <img src="images/scenes/scene164.png" alt="Scene 164 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Device Loss Recovery |
| 165 | <img src="images/scenes/scene165.png" alt="Scene 165 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Shader Material Thin Instances |
| 166 | <img src="images/scenes/scene166.png" alt="Scene 166 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Clustered Sponza Spot Lights |
| 167 | <img src="images/scenes/scene167.png" alt="Scene 167 rendering" width="160"> | pixel‑perfect | pixel‑perfect | PBR Lightmap |
| 168 | <img src="images/scenes/scene168.png" alt="Scene 168 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Mirrored Double-Sided Winding |
| 170 | <img src="images/scenes/scene170.png" alt="Scene 170 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Navigation Crowd |
| 171 | <img src="images/scenes/scene171.png" alt="Scene 171 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Navigation Crowd Path |
| 172 | <img src="images/scenes/scene172.png" alt="Scene 172 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Navigation Tile Cache Obstacles |
| 173 | <img src="images/scenes/scene173.png" alt="Scene 173 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Navigation Obstacle Toggle |
| 174 | <img src="images/scenes/scene174.png" alt="Scene 174 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Navigation Off-Mesh Connections |
| 175 | <img src="images/scenes/scene175.png" alt="Scene 175 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Navigation Raycast |
| 176 | <img src="images/scenes/scene176.png" alt="Mosquito in Amber" width="160"> | 0.000/0.000 | 0.000/0.000 | Mosquito In Amber |
| 177 | <img src="images/scenes/scene177.png" alt="Scene 177 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Iridescence Sphere |
| 178 | <img src="images/scenes/scene178.png" alt="Scene 178 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Iridescence Abalone |
| 179 | <img src="images/scenes/scene179.png" alt="Scene 179 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Clustered Sponza Lights |
| 180 | <img src="images/scenes/scene180.png" alt="Scene 180 rendering" width="160"> | 0.020/0.455 | 0.020/0.455 | Standalone Text Renderer |
| 181 | <img src="images/scenes/scene181.png" alt="Scene 181 rendering" width="160"> | 0.002/0.028 | 0.002/0.028 | Live Text Editor |
| 186 | <img src="images/scenes/scene186.png" alt="Scene 186 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Local Cubemap Blending |
| 187 | <img src="images/scenes/scene187.png" alt="Scene 187 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Subpixel Morphological Anti-Aliasing |
| 200 | <img src="images/scenes/scene200.png" alt="Scene 200 rendering" width="160"> | pixel‑perfect | pixel‑perfect | High-Precision Matrix Off |
| 201 | <img src="images/scenes/scene201.png" alt="Scene 201 rendering" width="160"> | pixel‑perfect | pixel‑perfect | High-Precision Matrix On |
| 202 | <img src="images/scenes/scene202.png" alt="Scene 202 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Floating Origin Point Light |
| 203 | <img src="images/scenes/scene203.png" alt="Scene 203 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Floating Origin Spot Light |
| 204 | <img src="images/scenes/scene204.png" alt="Scene 204 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Floating Origin Thin Instances |
| 205 | <img src="images/scenes/scene205.png" alt="Scene 205 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Floating Origin Facing Billboards |
| 206 | <img src="images/scenes/scene206.png" alt="Scene 206 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Floating Origin Cutout Billboards |
| 207 | <img src="images/scenes/scene207.png" alt="Scene 207 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Floating Origin Directional Shadows |
| 209 | <img src="images/scenes/scene209.png" alt="Scene 209 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Floating Origin Havok Physics; Floating Origin Physics Regions |
| 210 | <img src="images/scenes/scene210.png" alt="Scene 210 rendering" width="160"> | pixel‑perfect | pixel‑perfect | XMP Metadata Rounded Cube |
| 211 | <img src="images/scenes/scene211.png" alt="Scene 211 rendering" width="160"> | pixel‑perfect | pixel‑perfect | BrainStem Meshopt |
| 212 | <img src="images/scenes/scene212.png" alt="Scene 212 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Dispersion Test |
| 213 | <img src="images/scenes/scene213.png" alt="Scene 213 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Grid Material Ordering |
| 214 | <img src="images/scenes/scene214.png" alt="Scene 214 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Cascaded Shadow Torus Knots |
| 215 | <img src="images/scenes/scene215.png" alt="Scene 215 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Cascaded Shadows On A PBR Receiver |
| 216 | <img src="images/scenes/scene216.png" alt="Scene 216 rendering" width="160"> | pixel‑perfect | pixel‑perfect | PBR Fog |
| 217 | <img src="images/scenes/scene217.png" alt="Scene 217 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Material Plugins |
| 218 | <img src="images/scenes/scene218.png" alt="Scene 218 rendering" width="160"> | pixel‑perfect | pixel‑perfect | VAT Shark |
| 219 | <img src="images/scenes/scene219.png" alt="Scene 219 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Instanced VAT Shark |
| 220 | <img src="images/scenes/scene220.png" alt="Scene 220 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Quantized Duck |
| 221 | <img src="images/scenes/scene221.png" alt="Scene 221 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Pointer Drags |
| 222 | <img src="images/scenes/scene222.png" alt="Scene 222 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Composite Gizmos |
| 223 | <img src="images/scenes/scene223.png" alt="Scene 223 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Camera And Light Gizmos |
| 224 | <img src="images/scenes/scene224.png" alt="Scene 224 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Bounding Box Gizmo |
| 225 | <img src="images/scenes/scene225.png" alt="Scene 225 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Geospatial Camera; renders its pose, controls attach without input arms. |
| 226 | <img src="images/scenes/scene226.png" alt="Scene 226 rendering" width="160"> | 0.001/0.003 | 0.001/0.003 | Gaussian Splatting glTF |
| 227 | <img src="images/scenes/scene227.png" alt="Scene 227 rendering" width="160"> | 0.001/0.001 | 0.001/0.001 | Shared Scene Surfaces |
| 228 | <img src="images/scenes/scene228.png" alt="Scene 228 rendering" width="160"> | 0.001/0.001 | 0.001/0.001 | Independent Scene Surfaces |
| 229 | <img src="images/scenes/scene229.png" alt="Scene 229 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Triangle Without Indices |
| 231 | <img src="images/scenes/scene231.png" alt="Scene 231 rendering" width="160"> | 0.000/0.001 | 0.000/0.000 | Standard Material Deform Features |
| 240 | <img src="images/scenes/scene240.png" alt="Scene 240 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Animated Triangle |
| 241 | <img src="images/scenes/scene241.png" alt="Scene 241 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Animation Pointer UVs |
| 242 | <img src="images/scenes/scene242.png" alt="Scene 242 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Emissive Fireflies |
| 243 | <img src="images/scenes/scene243.png" alt="Scene 243 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Morph Stress Test |
| 244 | <img src="images/scenes/scene244.png" alt="Scene 244 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Pot of Coals |
| 245 | <img src="images/scenes/scene245.png" alt="Scene 245 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Recursive Skeletons |
| 246 | <img src="images/scenes/scene246.png" alt="Scene 246 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Simple Skin |
| 247 | <img src="images/scenes/scene247.png" alt="Scene 247 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Teapots Galore |
| 248 | <img src="images/scenes/scene248.png" alt="Scene 248 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Texture Settings |
| 249 | <img src="images/scenes/scene249.png" alt="Scene 249 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Vertex Alpha Clip |
| 250 | <img src="images/scenes/scene250.png" alt="Scene 250 rendering" width="160"> | 0.000/0.000 | pixel‑perfect | VirtualCity Cameras |
| 251 | <img src="images/scenes/scene251.png" alt="Scene 251 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Animation Group Mask |
| 252 | <img src="images/scenes/scene252.png" alt="Scene 252 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Standard Morph Target |
| 253 | <img src="images/scenes/scene253.png" alt="Scene 253 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Animate All The Things |
| 254 | <img src="images/scenes/scene254.png" alt="Scene 254 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Animation Sampler Type |
| 255 | <img src="images/scenes/scene255.png" alt="Scene 255 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Animation Skin Type |
| 256 | <img src="images/scenes/scene256.png" alt="Scene 256 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Normal Tangent Test |
| 257 | <img src="images/scenes/scene257.png" alt="Scene 257 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Node Negative Scale |
| 258 | <img src="images/scenes/scene258.png" alt="Scene 258 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Interleaved Buffer |
| 259 | <img src="images/scenes/scene259.png" alt="Scene 259 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Material Texture |
| 260 | <img src="images/scenes/scene260.png" alt="Scene 260 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Triangle Strip Primitive |
| 261 | <img src="images/scenes/scene261.png" alt="Scene 261 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Temporal Anti-Aliasing |
| 262 | <img src="images/scenes/scene262.png" alt="Scene 262 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NPE Particle Size |
| 263 | <img src="images/scenes/scene263.png" alt="Scene 263 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NPE Particle Gravity |
| 264 | <img src="images/scenes/scene264.png" alt="Scene 264 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NPE Particle Sphere Emitter |
| 265 | <img src="images/scenes/scene265.png" alt="Scene 265 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Environment Test |
| 266 | <img src="images/scenes/scene266.png" alt="Scene 266 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Negative Scale Spheres |
| 267 | <img src="images/scenes/scene267.png" alt="Scene 267 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Standard Vertex Colors |
| 268 | <img src="images/scenes/scene268.png" alt="Scene 268 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Orthographic Camera |
| 269 | <img src="images/scenes/scene269.png" alt="Scene 269 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Mirrored Transform Reparenting |
| 270 | <img src="images/scenes/scene270.png" alt="Scene 270 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Mirrored Standard Meshes |
| 271 | <img src="images/scenes/scene271.png" alt="Scene 271 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Shadow Light Rebuild |
| 272 | <img src="images/scenes/scene272.png" alt="Scene 272 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Runtime Mesh Swap |
| 273 | <img src="images/scenes/scene273.png" alt="Scene 273 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Runtime Material Family |
| 274 | <img src="images/scenes/scene274.png" alt="Scene 274 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Alpha to Coverage |
| 275 | <img src="images/scenes/scene275.png" alt="Scene 275 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Text Alpha-to-Coverage |
| 276 | <img src="images/scenes/scene276.png" alt="Scene 276 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NPE Sprite Sheet Particles |
| 277 | <img src="images/scenes/scene277.png" alt="Scene 277 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NPE Attractor Update |
| 278 | <img src="images/scenes/scene278.png" alt="Scene 278 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Line System |
| 279 | <img src="images/scenes/scene279.png" alt="Scene 279 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Line System Update |
| 280 | <img src="images/scenes/scene280.png" alt="Scene 280 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NPE Flow Map Update |
| 281 | <img src="images/scenes/scene281.png" alt="Scene 281 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NPE Noise Update |
| 282 | <img src="images/scenes/scene282.png" alt="Scene 282 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Standard UV Transform |
| 283 | <img src="images/scenes/scene283.png" alt="Scene 283 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NPE Multiply Blend |
| 284 | <img src="images/scenes/scene284.png" alt="Scene 284 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NPE MultiplyAdd Blend |
| 286 | <img src="images/scenes/scene286.png" alt="Scene 286 rendering" width="160"> | pixel‑perfect | pixel‑perfect | ShaderMaterial on Interleaved glTF |
| 290 | <img src="images/scenes/scene290.png" alt="Scene 290 rendering" width="160"> | 0.017/0.027 | 0.017/0.027 | Havok Thin Instances; 2,009 bodies at frame 180 |
| 300 | <img src="images/scenes/scene300.png" alt="Scene 300 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Frozen NPE Sprite2D Sheet; frozen buffer and shared sprite sheet |
| 301 | <img src="images/scenes/scene301.png" alt="Scene 301 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NPE Sprite2D Blend Modes |
| 302 | <img src="images/scenes/scene302.png" alt="Scene 302 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | NPE Moving Emitter |
| 303 | <img src="images/scenes/scene303.png" alt="Scene 303 rendering" width="160"> | pixel‑perfect | pixel‑perfect | Sprite2D Renderer-Native Y-Sort |
| 304 | <img src="images/scenes/scene304.png" alt="Scene 304 rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Calculator KHR_interactivity |
| 305 | <img src="images/scenes/scene305.png" alt="Scene 305 rendering" width="160"> | pixel‑perfect | pixel‑perfect | NPE Teleport Graph Plumbing |
| 306 | <img src="images/scenes/scene306.png" alt="Scene 306 rendering" width="160"> | pixel‑perfect | pixel‑perfect | External Video Texture |

## Upstream application gates

Unchanged pinned applications, including their reached source and asset graphs.

| Application | Preview | SDL_GPU | Dawn | Coverage |
| --- | :---: | ---: | ---: | --- |
| Ocean | <img src="images/scenes/ocean.png" alt="Ocean rendering" width="160"> | 0.303/0.299 | 0.303/0.298 | Spectral ocean; compute FFT and mipmaps; procedural sky; buoyancy; retained controls; canvas-only MAD: 0.005/0.005 on both backends. |
| Offscreen (Worker) | <img src="images/scenes/offscreen.png" alt="Offscreen main and worker views" width="160"> | $\color{#1a7f37}{\textsf{0.401}} / \color{#9a6700}{\textsf{0.548}}$ | $\color{#1a7f37}{\textsf{0.401}} / \color{#9a6700}{\textsf{0.548}}$ | Dedicated Worker realms; transferred canvases; retained blocking control. UI and localized lens residuals; canvas-only: pixel-perfect on both backends. |
| Tetris | <img src="images/scenes/tetris.png" alt="Tetris rendering" width="160"> | $\color{#cf222e}{\textsf{1.143}} / \color{#9a6700}{\textsf{0.904}}$ | $\color{#cf222e}{\textsf{1.143}} / \color{#9a6700}{\textsf{0.904}}$ | Thin-instance game; audio; retained UI. UI residual; canvas-only MAD: 0.080/0.086 on both backends, the demo's doubled `devicePixelRatio` supersample (the port renders at the window's size). |
| Doom | <img src="images/scenes/doom.png" alt="Doom rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | WAD game; sprites; audio; retained UI. |
| LibreQuake | <img src="images/scenes/quake.png" alt="LibreQuake rendering" width="160"> | 0.027/0.027 | 0.027/0.027 | BSP/WAD2/MDL game; audio; Canvas2D HUD. |
| Torus States | <img src="images/scenes/torus-states.png" alt="Torus States rendering" width="160"> | pixel‑perfect | pixel‑perfect | Frame graph; offscreen effects; bloom. |
| Platformer | <img src="images/scenes/platformer.png" alt="Platformer rendering" width="160"> | $\color{#9a6700}{\textsf{0.664}} / \color{#9a6700}{\textsf{0.664}}$ | $\color{#9a6700}{\textsf{0.664}} / \color{#9a6700}{\textsf{0.664}}$ | Sprite game; CRT pass; audio; retained UI. UI residual; canvas-only: pixel-perfect on both backends. |
| Break Meshes | <img src="images/scenes/break-meshes.png" alt="Break Meshes rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Voronoi fracture; PBR; physics. |
| Racer | <img src="images/scenes/racer.png" alt="Racer rendering" width="160"> | 0.466/0.466 | 0.466/0.466 | Driving game; CSM; physics; audio; retained HUD. UI residual; canvas-only MAD: 0.004/0.004 on both backends. |
| Antigravity Racer | <img src="images/scenes/antigravity-racer.png" alt="Antigravity Racer rendering" width="160"> | $\color{#cf222e}{\textsf{2.393}} / \color{#cf222e}{\textsf{2.437}}$ | $\color{#cf222e}{\textsf{2.393}} / \color{#cf222e}{\textsf{2.437}}$ | Antigravity racing game; dynamic hierarchy instances; shader storage; CSM; HDR/IBL; gamepads; GPU picking; retained menu. UI residual; canvas-only MAD: SDL_GPU 0.000/0.000, Dawn pixel-perfect. |
| Littlest Tokyo | <img src="images/scenes/littlest-tokyo.png" alt="Littlest Tokyo rendering" width="160"> | 0.141/0.107 | 0.141/0.107 | Animated glTF; PBR/IBL; retained chrome. |
| Bath Day | <img src="images/scenes/bath-day.png" alt="Bath Day rendering" width="160"> | 0.102/0.140 | 0.102/0.140 | Skinned Draco/WebP glTF; transmission; retained chrome. |
| Freeciv | <img src="images/scenes/freeciv.png" alt="Freeciv rendering" width="160"> | 0.115/0.113 | 0.115/0.113 | Strategy map; sprites; picking; retained cursor/tooltips. |
| The Playroom (`playroom`) | <img src="images/scenes/playroom.png" alt="Playroom gameplay with throw counter and score" width="160"> | $\color{#9a6700}{\textsf{0.957}} / \color{#9a6700}{\textsf{0.720}}$ | $\color{#9a6700}{\textsf{0.959}} / \color{#9a6700}{\textsf{0.723}}$ | Physics game; ragdoll; thin instances; skeleton shadows; audio; retained HUD. Not qualified: the Bullet ragdoll settles in another pose than Havok's by the reference frame, so the canvas differs; physics performance remains below target; canvas-only MAD: SDL_GPU 3.364/3.126, Dawn 3.363/3.126. |
| Sandblox | <img src="images/scenes/sandblox.png" alt="Sandblox rendering" width="160"> | 0.073/0.077 | 0.073/0.077 | 3D building sandbox; dynamic coloured thin instances; material plugins; property animation; audio; JSON save/load; retained editing UI. UI residual; canvas-only MAD: 0.000/0.000 on both backends. |
| Voxel Sandbox | <img src="images/scenes/minecraft.png" alt="Voxel Sandbox rendering" width="160"> | $\color{#cf222e}{\textsf{1.090}} / \color{#cf222e}{\textsf{1.090}}$ | $\color{#cf222e}{\textsf{1.090}} / \color{#cf222e}{\textsf{1.090}}$ | Procedural voxel world; generated texture atlas; custom shader materials; audio; save/load; retained HUD and crosshair. UI residual; canvas-only MAD: 0.000/0.000 on both backends. |
| NPE on Sprite2D | <img src="images/scenes/npe-sprite2d.png" alt="NPE on Sprite2D rendering" width="160"> | pixel‑perfect | pixel‑perfect | Live pure-2D node particles; sprite atlas; pointer-following emitter. |
| Screen-Space Effects | <img src="images/scenes/screen-space-effects.png" alt="Screen-Space Effects rendering" width="160"> | 0.361/0.440 | 0.361/0.440 | Contact shadows; one-bounce GI; temporal history; retained controls. UI residual; canvas-only: pixel-perfect on both backends. |
| Mosquito in Amber | <img src="images/scenes/mosquito-amber.png" alt="Mosquito in Amber rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Transmissive glTF (scene 176) as a demo; studio HDR IBL; retained chrome. |
| Calculator | <img src="images/scenes/calculator.png" alt="Calculator rendering" width="160"> | $\color{#1a7f37}{\textsf{0.196}} / \color{#9a6700}{\textsf{0.895}}$ | $\color{#1a7f37}{\textsf{0.196}} / \color{#9a6700}{\textsf{0.895}}$ | KHR_interactivity flow graph; GPU picking under the selectability filter; retained chrome. UI residual; canvas-only: pixel-perfect on both backends. |

## Project-owned differential gates

Repository fixtures running against pinned Babylon Lite. These measure contracts outside current corpus coverage.

| Scene | Preview | SDL_GPU | Dawn | Coverage |
| ---: | :---: | ---: | ---: | --- |
| light-setters | <img src="images/scenes/regression-light-setters.png" alt="Light setters rendering" width="160"> | pixel‑perfect | pixel‑perfect | Light Vector Setters |
| property-animation-paths | <img src="images/scenes/regression-property-animation-paths.png" alt="Property animation paths rendering" width="160"> | pixel‑perfect | pixel‑perfect | Property Animation Paths |
| nav-crowd | <img src="images/scenes/regression-nav-crowd.png" alt="Navigation crowd step rendering" width="160"> | pixel‑perfect | pixel‑perfect | Navigation Crowd Step |
| nav-obstacles | <img src="images/scenes/regression-nav-obstacles.png" alt="Navigation obstacle removal rendering" width="160"> | pixel‑perfect | pixel‑perfect | Navigation Obstacle Removal |
| mesh-flags | <img src="images/scenes/regression-mesh-flags.png" alt="Mesh visible and pickable rendering" width="160"> | pixel‑perfect | pixel‑perfect | Mesh Visible and Pickable |
| physics-aggregate-options | <img src="images/scenes/regression-physics-aggregate-options.png" alt="Physics aggregate options rendering" width="160"> | 0.031/0.049 | 0.031/0.049 | Physics Aggregate Options |
| physics-floating-origin | <img src="images/scenes/regression-physics-floating-origin.png" alt="Physics floating origin rendering" width="160"> | 0.000/0.000 | 0.000/0.000 | Physics Floating Origin Regions |
| material-falloff | <img src="images/scenes/regression-material-falloff.png" alt="Material falloff write rendering" width="160"> | pixel‑perfect | pixel‑perfect | Material Falloff Write |
| opacity-alpha-write | <img src="images/scenes/regression-opacity-alpha-write.png" alt="Opacity alpha write rendering" width="160"> | pixel‑perfect | 0.000/0.000 | Opacity Alpha Write |
| blend-alpha-write | <img src="images/scenes/regression-blend-alpha-write.png" alt="Blend alpha write rendering" width="160"> | pixel‑perfect | pixel‑perfect | Blend Alpha Write |
| runtime-options | <img src="images/scenes/regression-runtime-options.png" alt="Runtime options rendering" width="160"> | 0.000/0.001 | 0.000/0.001 | Runtime Options |
| engine-calls | <img src="images/scenes/regression-engine-calls.png" alt="Engine calls rendering" width="160"> | pixel‑perfect | pixel‑perfect | Engine Calls |
| no-camera-floating-origin | <img src="images/scenes/regression-no-camera-floating-origin.png" alt="No camera floating origin rendering" width="160"> | pixel‑perfect | pixel‑perfect | No Camera Floating Origin |
| compiler-state | <img src="images/scenes/regression-compiler-state.png" alt="Compiler state rendering" width="160"> | pixel‑perfect | pixel‑perfect | Compiler State |
| glTF-track-clamp | <img src="images/scenes/regression-track-clamp.png" alt="glTF track clamp rendering" width="160"> | pixel‑perfect | pixel‑perfect | glTF Track Clamp |
| shader-frame-graph | <img src="images/scenes/audit-shader-frame-graph.png" alt="Shader frame graph rendering" width="160"> | pixel‑perfect | pixel‑perfect | Shader Frame Graph |
| runtime-sweep | <img src="images/scenes/regression-runtime-sweep.png" alt="Runtime sweep rendering" width="160"> | pixel‑perfect | pixel‑perfect | Runtime Sweep |
| instanced-ground | <img src="images/scenes/regression-instanced-ground.png" alt="Instanced ground rendering" width="160"> | pixel‑perfect | pixel‑perfect | Instanced Ground |
| sprite-layer-arms | <img src="images/scenes/regression-sprite-layer-arms.png" alt="Sprite layer arms rendering" width="160"> | pixel‑perfect | pixel‑perfect | Sprite Layer Arms |
| glTF-sparse | <img src="images/scenes/regression-gltf-sparse.png" alt="glTF sparse accessors rendering" width="160"> | pixel‑perfect | pixel‑perfect | glTF Sparse Accessors |
| glTF-uv-sets | <img src="images/scenes/regression-gltf-uv-sets.png" alt="glTF UV sets rendering" width="160"> | pixel‑perfect | pixel‑perfect | glTF UV Sets |
| glTF-topology | <img src="images/scenes/regression-gltf-topology.png" alt="glTF primitive topology rendering" width="160"> | pixel‑perfect | pixel‑perfect | glTF Primitive Topology |
| glTF-step-animation | <img src="images/scenes/regression-gltf-step-animation.png" alt="glTF STEP animation rendering" width="160"> | pixel‑perfect | pixel‑perfect | glTF STEP Animation |
| node-local-attributes | <img src="images/scenes/regression-node-local-attributes.png" alt="Node local attributes rendering" width="160"> | pixel‑perfect | pixel‑perfect | Node Local Attributes |
| morph-ground | <img src="images/scenes/regression-morph-ground.png" alt="Morph storage ground rendering" width="160"> | pixel‑perfect | pixel‑perfect | Morph Storage Ground |
| timer-callback-cells | <img src="images/scenes/regression-timer-callback-cells.png" alt="Timer callback cells rendering" width="160"> | pixel‑perfect | pixel‑perfect | Timer Callback Cells |
| host-page | <img src="images/scenes/regression-host-page.png" alt="Host page rendering" width="160"> | $\color{#1a7f37}{\textsf{0.069}} / \color{#cf222e}{\textsf{6.774}}$ | $\color{#1a7f37}{\textsf{0.069}} / \color{#cf222e}{\textsf{6.774}}$ | HTML host page: markup, sheets, inline loader, engine-less Canvas2D. UI text residual. |
| page-canvas | <img src="images/scenes/regression-page-canvas.png" alt="Page canvas rendering" width="160"> | 0.009/0.024 | 0.009/0.024 | Text scene on a page-authored canvas over page chrome; canvas-only: pixel‑perfect on both backends. UI text residual. |
| filter-values | <img src="images/scenes/regression-filter-values.png" alt="Filter values rendering" width="160"> | 0.002/0.044 | 0.002/0.044 | Inherited custom properties, scalar/pixel math and computed shadow color. |
| markup-values | <img src="images/scenes/regression-markup-values.png" alt="Markup values rendering" width="160"> | 0.035/0.124 | 0.035/0.124 | Stored markup snapshots, conditional order and queried button interaction. |
| grid-placement | <img src="images/scenes/regression-grid-placement.png" alt="Grid placement rendering" width="160"> | 0.038/0.141 | 0.038/0.141 | Two-axis spans, intrinsic/finite tracks, auto-repeat and reversible isolation. |
| retained-svg | <img src="images/scenes/regression-retained-svg.png" alt="Retained SVG rendering" width="160"> | 0.007/0.299 | 0.007/0.299 | SVG namespace construction, live shape attributes, replacement and inherited color. |
| page-scene-canvas | <img src="images/scenes/regression-page-scene-canvas.png" alt="Page scene canvas rendering" width="160"> | $\color{#1a7f37}{\textsf{0.357}} / \color{#9a6700}{\textsf{0.633}}$ | $\color{#1a7f37}{\textsf{0.357}} / \color{#9a6700}{\textsf{0.633}}$ | Scene through a laid-out page canvas: preceding page paint stays beneath it; intrinsic canvas size; vertical-align, p and code defaults. UI text residual. |
