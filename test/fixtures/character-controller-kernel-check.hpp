#pragma once
#include <bblite/js_data.hpp>
#include <iostream>
#include <iomanip>
namespace bbl::character {
struct PhysicsBody {
    double id = 0, motion = 0, mass = 1;
    js::Array<double> matrix{1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    js::Array<double> com{0,0,0}, linear{0,0,0}, angular{0,0,0};
};
}
#include "full-kernel.hpp"
using namespace bbl;
using namespace bbl::character;
using Query = std::tuple<double, js::Ref<QueryPoint>, js::Ref<QueryPoint>>;

struct Kernel final : CharacterControllerKernel {
    js::Array<js::Ref<PhysicsBody>> bodies;
    js::Array<Query> proximity, casts;
    js::Array<double> events, queries;
    double dt = 1.0 / 60;
    js::Ref<Vec3> node = v();
    Kernel() { _position = v(); }
    js::Array<js::Ref<PhysicsBody>> _world_bodies() override { return bodies; }
    double _world_step_seconds() override { return dt; }
    double _body_motion_type(js::Ref<PhysicsBody> body) override { return body->motion; }
    std::optional<double> _body_identity(js::Ref<PhysicsBody> body) override { return body->id; }
    js::Array<double> _body_world_matrix(js::Ref<PhysicsBody> body) override { return body->matrix; }
    std::tuple<js::Array<double>, double, js::Array<double>, js::Array<double>> _mass_properties(js::Ref<PhysicsBody> body) override {
        return {body->com, body->mass, {1,1,1}, {0,0,0,1}};
    }
    js::Array<double> _angular_velocity(js::Ref<PhysicsBody> body) override { return body->angular; }
    js::Array<double> _linear_velocity(js::Ref<PhysicsBody> body) override { return body->linear; }
    void _apply_impulse(js::Ref<PhysicsBody> body, js::Array<double> position, js::Array<double> impulse) override {
        events.push_back(1); events.push_back(body->id);
        for (auto value : position) events.push_back(value);
        for (auto value : impulse) events.push_back(value);
    }
    void _set_node_position(double x, double y, double z) override { vset(node,x,y,z); }
    void _notify(js::Ref<CharacterCollisionEvent> event) override {
        events.push_back(0); events.push_back(event->collider->id);
        for (auto value : {event->impulsePosition->x,event->impulsePosition->y,event->impulsePosition->z,event->impulse->x,event->impulse->y,event->impulse->z}) events.push_back(value);
    }
    js::Array<Query> _start_hits() override { return proximity; }
    js::Array<Query> _cast_hits() override { return casts; }
    void _collect_proximity(js::Array<double> start, js::Array<double> rotation, double distance, bool triggers) override {
        queries.push_back(0);
        for (auto value : start) queries.push_back(value);
        for (auto value : rotation) queries.push_back(value);
        queries.push_back(distance); queries.push_back(triggers ? 1 : 0);
    }
    void _collect_cast(js::Array<double> rotation, js::Array<double> start, js::Array<double> end, bool triggers) override {
        queries.push_back(1);
        for (const auto& values : {rotation,start,end}) for (auto value : values) queries.push_back(value);
        queries.push_back(triggers ? 1 : 0);
    }
};

inline js::Ref<PhysicsBody> body(double id, double motion) {
    auto result=js::make_ref<PhysicsBody>(); result->id=id; result->motion=motion; return result;
}
inline Query hit(double value, double id, js::Ref<Vec3> point, js::Ref<Vec3> normal) {
    auto cp=js::make_ref<QueryPoint>(); cp->identity={id}; cp->position={point->x,point->y,point->z}; cp->normal={normal->x,normal->y,normal->z};
    return {value,cp,cp};
}
inline js::Ref<Contact> contact(js::Ref<PhysicsBody> owner, js::Ref<Vec3> point, js::Ref<Vec3> normal, double distance) {
    auto result=js::make_ref<Contact>(); result->body=owner; result->position=point; result->normal=normal; result->distance=distance; result->allowedPenetration=.05; return result;
}
inline void append(js::Array<double>& row, js::Ref<Vec3> value) { for (auto number : {value->x,value->y,value->z}) row.push_back(number); }
inline void print(const js::Array<double>& values) {
    static bool first=true; if(!first)std::cout<<',';first=false;std::cout<<'[';
    bool first_value=true;for(double value:values){if(!first_value)std::cout<<',';first_value=false;std::cout<<value;}std::cout<<']';
}
inline js::Array<double> manifold(Kernel& kernel, double status) {
    js::Array<double> row{status};
    for (const auto& value:kernel._manifold) {
        row.push_back(value->body?value->body->id:-1); row.push_back(value->distance);row.push_back(value->fraction);row.push_back(value->allowedPenetration);
        append(row,value->position);append(row,value->normal);
    }
    return row;
}
