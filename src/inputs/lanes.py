"""Keep inbound route targets within their wall-clearance interval."""
import numpy as np
from . import tracking as base
RADIUS = .07
CLEARANCE = RADIUS + 1e-6
GRID_STEP = .0001


def cross(a, b):
    return float(a[0]*b[1]-a[1]*b[0])


def intersection(a, b, c, d):
    r, s = b-a, d-c
    denominator = cross(r, s)
    if abs(denominator) < 1e-12:
        return None
    t, u = cross(c-a, s)/denominator, cross(c-a, r)/denominator
    return a+t*r if -1e-10 <= t <= 1+1e-10 and -1e-10 <= u <= 1+1e-10 else None


def segment_distance(a, b, c, d):
    if intersection(a, b, c, d) is not None:
        return 0.
    return min(base.distance_segment(a, c, d), base.distance_segment(b, c, d),
               base.distance_segment(c, a, b), base.distance_segment(d, a, b))


def lane_clearance(scene, lane):
    points = [np.asarray(p, dtype=float)+[lane, 0] for p in scene['routes']['inbound']['waypoints']]
    if len(points) != 3:
        raise ValueError('This supplement requires the frozen three-waypoint inbound route')
    a, b = np.asarray(scene['deepCut']['p0']), np.asarray(scene['deepCut']['p1'])
    end = intersection(points[1], points[2], a, b)
    if end is None:
        return None
    walls = [(np.asarray(w['p0']), np.asarray(w['p1'])) for w in scene['walls']]
    return min(segment_distance(p, q, c, d) for p, q in [(points[0], points[1]), (points[1], end)] for c, d in walls)


def calculate_guard(scene):
    feasible = []
    for integer in range(-2500, 2501):
        lane = integer/10000
        clearance = lane_clearance(scene, lane)
        if clearance is not None and clearance >= CLEARANCE:
            feasible.append(integer)
    if not feasible:
        raise ValueError('No radius-clear inbound target lane; geometry requires review')
    components = [[feasible[0]]]
    for integer in feasible[1:]:
        if integer != components[-1][-1]+1:
            components.append([])
        components[-1].append(integer)
    selected = next((c for c in components if 0 in c), None)
    if selected is None:
        raise ValueError('Centre route is not feasible; do not silently choose another route')
    return {'intervalW': [selected[0]/10000, selected[-1]/10000],
            'gridStepW': GRID_STEP, 'bodyRadiusW': RADIUS, 'minimumWallClearanceW': CLEARANCE,
            'feasibleGridPointCount': len(selected),
            'allGridComponentsW': [[c[0]/10000, c[-1]/10000] for c in components],
            'unchangedOriginalRange': selected[0] == -2500 and selected[-1] == 2500,
            'deepCutLengthW': float(np.linalg.norm(np.asarray(scene['deepCut']['p1'])-np.asarray(scene['deepCut']['p0'])))}


def constrained_lane(original, scene, guard):
    lo, hi = guard['intervalW']
    candidate = min(hi, max(lo, original))
    clearance = lane_clearance(scene, candidate)
    if clearance is not None and clearance >= CLEARANCE:
        return candidate
    # Avoid treating a sampled interval as a mathematical proof of feasibility
    # between grid points. Each actual selected lane is checked geometrically.
    grid = range(round(lo*10000), round(hi*10000)+1)
    for integer in sorted(grid, key=lambda i: (abs(i/10000-original), i)):
        candidate = integer/10000
        clearance = lane_clearance(scene, candidate)
        if clearance is not None and clearance >= CLEARANCE:
            return candidate
    raise ValueError('No validated lane in frozen interval')


def prepare_window(camera, nominal, duration, raw, geometry, guard):
    document, observation = base.prepare_window(camera, nominal, duration, raw, geometry)
    if document['parameters']['radius'] != RADIUS:
        raise ValueError('Agent radius differs from frozen geometric supplement')
    changed = []
    for kind in ['initialAgents', 'arrivals']:
        for agent in document[kind]:
            if agent['routeId'] != 'inbound':
                continue
            original = agent['lane']
            safe = constrained_lane(original, document['scene'], guard)
            if safe != original:
                changed.append({'id': agent['id'], 'sourceId': agent['sourceId'], 'cohort': kind,
                                'originalLaneW': original, 'guardedLaneW': safe})
            agent['lane'] = safe
    document['geometryLaneGuard'] = {**guard, 'revision': '3b', 'changedInboundTargets': changed,
        'changedCount': len(changed),
        'scope': 'Target-route clearance only; interacting or initially off-centre agent trajectories are not guaranteed to follow this centre path'}
    return document, observation
