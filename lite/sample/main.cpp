// A C++ client of the Babylon Lite library: no TypeScript, no generated
// program. It links babylon_lite and calls the runtime API directly.
#include <bblite/pal.hpp>
#include <bblite/pal_audio.hpp>
#include <bblite/pal_ui.hpp>
#include <bblite/runtime.hpp>
#include <bblite/uncaught_error.hpp>
#include <bblite/upstream/light_parameters.hpp>
#include <bblite/upstream/physics.hpp>

#include <cstddef>
#include <exception>
#include <iterator>
#include <numbers>

int main() {
    const bbl::js::CollectOnExit collect_on_exit;
    try {
        auto engine = bbl::create_engine(bbl::EngineOptions{"Babylon Lite C++ sample", 1280, 720});
        auto scene = bbl::create_scene_context(engine);
        scene.clear_color = bbl::Color4{0.1f, 0.1f, 0.15f, 1.0f};

        auto camera = bbl::create_arc_rotate_camera(engine, std::numbers::pi / 4.0, std::numbers::pi / 3.0, 12.0,
                                                    bbl::Vec3d{0.0, 1.0, 0.0});
        scene.camera = camera;
        bbl::attach_control(engine, camera, scene);

        bbl::add_to_scene(scene, bbl::create_hemispheric_light(engine, bbl::Vec3{0.0f, 1.0f, 0.0f}, 0.5));
        auto point = bbl::create_point_light(engine, bbl::Vec3{0.0f, 4.0f, 0.0f}, 0.8);
        bbl::set_light_diffuse_color(bbl::handle_at(engine.lights, point), bbl::Vec3d{1.0, 0.9, 0.8});
        bbl::add_to_scene(scene, point);

        auto material = bbl::create_standard_material(engine);
        bbl::set_material_diffuse_color(engine, material, bbl::js::Array<double>{0.7, 0.5, 0.4});
        bbl::handle_at(engine.materials, material).specular_color = bbl::Color3{0.3f, 0.3f, 0.3f};

        const auto place = [&](bbl::MeshHandle mesh, bbl::Vec3d position) {
            bbl::set_mesh_material(engine, mesh, material);
            bbl::handle_at(engine.meshes, mesh).position = position;
            bbl::mark_mesh_dirty(engine, mesh);
            bbl::add_to_scene(scene, mesh);
            return mesh;
        };
        const auto ground = place(bbl::create_ground(engine, bbl::GroundOptions{20.0, 20.0, 1u, bbl::Vec2{1.0f, 1.0f}}),
                                  bbl::Vec3d{0.0, 0.0, 0.0});
        const auto box = place(bbl::create_box(engine, bbl::BoxOptions{1.0f, 1.0f, 1.0f}), bbl::Vec3d{-2.0, 4.0, 0.0});
        const auto sphere = place(bbl::create_sphere(engine, bbl::SphereOptions{32u, 1.5, 1.5, 1.5}),
                                  bbl::Vec3d{0.0, 6.0, 0.0});
        place(bbl::create_torus(engine, bbl::TorusOptions{1.5, 0.4, 16u}), bbl::Vec3d{2.0, 1.0, 0.0});

        // Physics through the Havok API, which the native build runs on
        // Bullet: a static ground, a falling box and a bouncing sphere.
        using bbl::upstream::PhysicsShapeType;
        const auto world = bbl::upstream::create_havok_world(scene, bbl::Vec3d{0.0, -9.8, 0.0});
        bbl::upstream::create_physics_aggregate(world, ground, PhysicsShapeType::BOX, {.mass = 0.0});
        bbl::upstream::create_physics_aggregate(world, box, PhysicsShapeType::BOX, {.mass = 1.0, .restitution = 0.2});
        bbl::upstream::create_physics_aggregate(world, sphere, PhysicsShapeType::SPHERE,
                                                {.mass = 1.0, .restitution = 0.75});

        // A rounded label through the DOM/CSS port, in the style vocabulary
        // the UI lowering emits (its background longhands among them).
        const auto label = bbl::ui_create_element(engine, "div");
        bbl::ui_set_text(engine, label, "Babylon Lite Native");
        bbl::ui_set_attribute(engine, label, "style",
                              "position:absolute;top:20px;left:20px;z-index:10;"
                              "font-family:system-ui,sans-serif;font-size:20px;font-weight:700;"
                              "line-height:1;color:#ffffff;padding:12px 24px;border-radius:24px;"
                              "border-image:none;border:2px #e0684b;background-clip:border-box;"
                              "--bbl-background-image:none;--bbl-background-size:auto;"
                              "--bbl-background-position:0% 0%;--bbl-background-repeat:repeat;"
                              "--bbl-background-origin:padding-box;--bbl-background-attachment:scroll;"
                              "--bbl-background-color:rgba(16,18,26,0.8);--bbl-absolute-inline:1;");
        bbl::ui_append_to_root(engine, label);

        // A three-note chime at startup through the Web Audio port.
        const auto audio = bbl::pal::audio_create_context();
        bbl::pal::audio_resume(audio);
        const double chime = bbl::pal::audio_current_time(audio) + 0.2;
        const float notes[] = {523.25f, 659.25f, 783.99f};
        for (std::size_t index = 0; index < std::size(notes); ++index) {
            const double at = chime + 0.18 * static_cast<double>(index);
            const auto oscillator = bbl::pal::audio_create_oscillator(audio);
            bbl::pal::audio_set_oscillator_wave(oscillator, bbl::pal::OscillatorWave::Sine);
            bbl::pal::audio_param_set_value(
                bbl::pal::audio_node_param(oscillator, bbl::pal::AudioParamName::Frequency), notes[index]);
            const auto gain = bbl::pal::audio_create_gain(audio);
            const auto volume = bbl::pal::audio_node_param(gain, bbl::pal::AudioParamName::Gain);
            bbl::pal::audio_param_set_value_at_time(volume, 0.0001f, at);
            bbl::pal::audio_param_exponential_ramp(volume, 0.3f, at + 0.02);
            bbl::pal::audio_param_exponential_ramp(volume, 0.0001f, at + 1.2);
            bbl::pal::audio_connect(oscillator, gain);
            bbl::pal::audio_connect(gain, bbl::pal::audio_destination(audio));
            bbl::pal::audio_node_start(oscillator, at);
            bbl::pal::audio_node_stop(oscillator, at + 1.3);
        }

        bbl::register_scene(scene);
        bbl::start_engine(engine);
        return 0;
    } catch (...) {
        return bbl::report_uncaught_error(std::current_exception());
    }
}
