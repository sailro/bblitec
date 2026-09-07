#include <bblite/js_promise.hpp>
#include <bblite/js_realm_state.hpp>
#include <bblite/pal_frame_driver.hpp>

#include <iostream>

namespace {
using namespace bbl;
void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

js::Promise<double> compute(js::Promise<double> input, std::vector<int>* order) {
    order->push_back(1);
    const double value = co_await input;
    order->push_back(3);
    co_return value * 2;
}

void ordering_and_recovery() {
    const js::RealmScope realm;
    pal::EventLoop loop;
    std::vector<int> order;
    double result = 0;
    loop.run([&] {
        auto input = js::Promise<double>::resolved(4);
        compute(input, &order).then([&](double value) {
            order.push_back(4);
            return js::Promise<double>::resolved(value + 1);
        }).then([&](double value) {
            result = value;
            throw std::runtime_error("reaction failure");
        }).catch_error([&](std::exception_ptr error) {
            require(js::promise_error_string(error) == "Error: reaction failure", "Rejection lost its error");
            order.push_back(5);
            loop.close();
        });
        order.push_back(2);
    });
    require(order == std::vector<int>{1, 2, 3, 4, 5} && result == 9, "Promise reactions ran in the wrong order");
}

struct Owned {
    std::thread::id owner = std::this_thread::get_id();
    int* destroyed;
    ~Owned() { require(owner == std::this_thread::get_id(), "Coroutine destroyed outside its realm"); ++*destroyed; }
};

js::Promise<js::PromiseVoid> waiting(js::Promise<double> signal, int* destroyed) {
    Owned owned{std::this_thread::get_id(), destroyed};
    const auto value = co_await signal;
    static_cast<void>(value);
    require(false, "A closed realm resumed suspended source code");
    co_return js::PromiseVoid{};
}

void shutdown_releases_suspended_activations() {
    const js::RealmScope realm;
    pal::EventLoop loop;
    int destroyed = 0;
    loop.run([&] {
        js::Promise<double> signal;
        waiting(signal, &destroyed);
        loop.close();
    });
    require(destroyed == 1, "Suspended activation survived realm shutdown");
}

int frame_steps = 0;
int frame_cleanup = 0;
pal::FrameDriver renderer_activation(Engine& engine) {
    const auto cleanup = js::finally([&] {
        require(pal::OffscreenRun::current() == engine.offscreen_run.get(), "Renderer cleanup lost its canvas binding");
        ++frame_cleanup;
    });
    require(pal::OffscreenRun::current() == engine.offscreen_run.get(), "Renderer activation lost its canvas binding");
    ++frame_steps;
    co_yield false; // No output image was available yet.
    ++frame_steps;
    co_yield true;
    require(false, "Closed realm resumed its renderer");
    co_return true;
}

void renderer_tasks_yield_and_retire() {
    const js::RealmScope realm;
    pal::EventLoop loop;
    auto frames = std::make_shared<pal::AnimationFrameSource>();
    pal::OffscreenSurface surface(32, 32, frames);
    pal::OffscreenDevice device;
    Engine engine;
    engine.offscreen_run = std::make_shared<pal::OffscreenRun>(surface, device);
    bool timer_ran = false;
    loop.run([&] {
        auto driver = renderer_activation(engine);
        driver.ready().observe([&](const js::PromiseVoid&) {
            require(frame_steps == 2 && timer_ran, "Readiness preceded output or renderer prevented timer dispatch");
            require(!pal::OffscreenRun::current(), "Renderer leaked its canvas binding into a reaction");
            loop.close();
        }, [](std::exception_ptr error) { std::rethrow_exception(error); });
        driver.start();
        loop.set_timeout([frames] { frames->tick(pal::EventLoop::Clock::now()); }, 1, true);
        loop.set_timeout([&] { timer_ran = true; }, 0);
    });
    require(frame_cleanup == 1 && !pal::OffscreenRun::current(), "Renderer frame survived shutdown or kept its canvas bound");
}
}

int main() {
    try {
        ordering_and_recovery();
        shutdown_releases_suspended_activations();
        renderer_tasks_yield_and_retire();
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
