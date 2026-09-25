#pragma once
// The frame unit a Window fixture links for the run options its realm reads,
// with the PAL services the unit's frame-loop bodies reach: a Window realm
// never runs those loops, so each refuses the call.
#include <stdexcept>

#include "pal_gpu_frame.cpp"

namespace bbl {
double scene_callback_delta(const Scene&, double) {
    throw std::logic_error("Unexpected fixture scene frame");
}
void run_deferred_callbacks(Engine&) { throw std::logic_error("Unexpected fixture frame drain"); }
void run_timeout_callbacks(Engine&) { throw std::logic_error("Unexpected fixture frame drain"); }
void run_interval_callbacks(Engine&) { throw std::logic_error("Unexpected fixture frame drain"); }
namespace pal {
void advance_performance_milliseconds(double) {
    throw std::logic_error("Unexpected fixture frame clock");
}
std::size_t process_working_set_bytes() {
    throw std::logic_error("Unexpected fixture memory profile");
}
} // namespace pal
} // namespace bbl
