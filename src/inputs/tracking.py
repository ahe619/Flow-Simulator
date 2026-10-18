"""Convert consecutive tracker samples into agents, arrivals and reference counts."""
from collections import Counter
from copy import deepcopy
import math
import numpy as np
from . import geometry as helper


def make_scene(camera, geometry):
    return deepcopy(geometry["scene"])


def camera_dt(camera):
    return 1. if camera == 'A' else 29/29.97


def last_two_velocity(records, sample, source_id, dt):
    """Exactly one native displacement ending at sample; never bridge an ID gap."""
    now = records.get(sample, {}).get(source_id)
    if now is None:
        return 0., 0., 0
    previous = records.get(sample-1, {}).get(source_id)
    if previous is None:
        return 0., 0., 1
    return (now['x']-previous['x'])/dt, (now['y']-previous['y'])/dt, 2


def distance_segment(point, p0, p1):
    a, b, p = np.asarray(p0), np.asarray(p1), np.asarray(point)
    d = b-a
    t = max(0., min(1., float((p-a)@d/(d@d)))) if d@d else 0.
    return float(np.linalg.norm(p-a-t*d))


def project_records(raw, geometry, scene):
    H = np.asarray(geometry['HimageToU'])
    records, invalid = {}, Counter()
    for sample, frame in raw.items():
        records[sample] = {}
        for source_id, row in frame.items():
            try:
                pixel = [float(row['img_x']), float(row['img_y'])-8]
                if not all(math.isfinite(v) for v in pixel) or not (0 <= pixel[0] <= 3840 and 0 <= pixel[1] <= 2160):
                    raise ValueError('outside_raw_image')
                x, y = helper.project(H, pixel)
                if not math.isfinite(x+y):
                    raise ValueError('nonfinite_projection')
                records[sample][source_id] = {'x': x, 'y': y, 'imagePixel': pixel,
                    'inside': helper.inside(pixel, scene['domainImage']),
                    'outsideCalibrationSupport': not helper.inside(pixel, geometry['supportPolygonImage'])}
            except ValueError as error:
                invalid[str(error)] += 1
    return records, invalid


def deep_cut_position(birth, scene, radius):
    """Use observed lateral coordinate only; put inferred source at deep boundary."""
    a = np.asarray(scene['deepCut']['p0'], dtype=float)
    b = np.asarray(scene['deepCut']['p1'], dtype=float)
    edge = b-a
    length = float(np.linalg.norm(edge))
    if length <= 2*radius:
        return None
    target = (birth['x']-a[0])/edge[0] if abs(edge[0]) > 1e-10 else .5
    margin = min(.49, radius/length)
    target = max(margin, min(1-margin, target))
    normal = np.array([-edge[1], edge[0]])/length
    middle = (a+b)/2
    if not helper.inside((middle+normal*1e-3).tolist(), scene['domainPolygon']):
        normal *= -1
    # Radius clearance refers to the two physical sidewalls, never to the open
    # deep observation cut. A tiny inward offset makes membership unambiguous.
    candidates = sorted(set([target]+np.linspace(margin, 1-margin, 101).tolist()), key=lambda t: abs(t-target))
    for t in candidates:
        point = a+t*edge+normal*1e-4
        if helper.inside(point.tolist(), scene['domainPolygon']) and all(
                distance_segment(point, wall['p0'], wall['p1']) >= radius+1e-6 for wall in scene['walls']):
            return point.tolist()
    return None


def coverage(crossings, initial, arrivals):
    initial_ids = {agent['sourceId'] for agent in initial}
    events = {agent['sourceId']: agent for agent in arrivals}
    output = {}
    for direction in ['into', 'out']:
        group = [event for event in crossings if event['direction'] == direction]
        nominal = potential = ambiguous = 0
        for event in group:
            if event['id'] in initial_ids:
                nominal += 1
                potential += 1
            elif event['id'] in events:
                arrival = events[event['id']]
                nominal += arrival['time'] <= event['time']+1e-10
                potential += arrival['timeBracket'][0] <= event['time']+1e-10
                ambiguous += arrival['timeBracket'][0] <= event['time'] < arrival['timeBracket'][1]
        output[direction] = {'observedCrossings': len(group), 'identityKnownBeforeCrossingNominalTime': nominal,
                             'potentialIdentityCoverageAtEarliestBracketTime': potential,
                             'crossingsInsideArrivalTimingBracket': ambiguous,
                             'uncoveredAtNominalTime': len(group)-nominal}
    return {'byDirection': output,
            'interpretation': 'Potential input identity coverage only. This does not count correctly simulated crossings or use future outcomes to accept demand.'}


def prepare_window(camera, nominal, duration, raw, geometry):
    dt = camera_dt(camera)
    start = math.ceil(nominal/dt-1e-10)+1
    end = start+math.floor(duration/dt+1e-10)
    scene = make_scene(camera, geometry)
    records, invalid = project_records(raw, geometry, scene)
    cal_first = start+math.ceil(-60/dt-1e-10)
    pool, pool_records = [], []
    for sample in range(cal_first+1, start):
        for source_id, point in records.get(sample, {}).items():
            if not point['inside']:
                continue
            vx, vy, count = last_two_velocity(records, sample, source_id, dt)
            if count == 2:
                raw_speed = math.hypot(vx, vy)
                value = max(.03, raw_speed)
                pool.append(value)
                pool_records.append({'sourceSample': sample, 'sourceId': source_id,
                                     'timeRelativeToStart': (sample-start)*dt,
                                     'rawSpeed': raw_speed, 'speed': value})
    pool_fallback = not pool
    if pool_fallback:
        pool = [.03]
    parameters = {'desiredSpeed': .03, 'radius': .07, 'maxAgents': 500, 'dtMax': .02,
                  'pressureGridSize': .28, 'pressureGridOrigin': [0, 0],
                  'pressureStiffness': .3, 'pressureAccelerationLimit': .8}

    def make_agent(point, source_id, identity, history_end, time=None, demand_source=None):
        vx, vy, history_count = last_two_velocity(records, history_end, source_id, dt)
        raw_speed = math.hypot(vx, vy) if history_count == 2 else None
        speed = max(.03, raw_speed) if raw_speed is not None else None
        route = helper.select_route(point, vx, vy)
        waypoint = (2 if route == 'inbound' and point['y'] < -.18 else
                    1 if route == 'inbound' and point['y'] < .18 else
                    1 if route == 'outbound' and point['y'] > .25 else 0)
        agent = {'id': identity, 'sourceId': source_id, 'x': point['x'], 'y': point['y'],
                 'vx': vx, 'vy': vy, 'speed': speed, 'rawHistoricalSpeed': raw_speed,
                 'speedSource': 'last_two_past_positions' if speed is not None else 'empirical_pending',
                 'speedFloorWPerSecond': .03, 'historySamples': history_count,
                 'historyEndSample': history_end, 'historyEndTime': (history_end-start)*dt,
                 'routeId': route, 'waypointIndex': waypoint,
                 'lane': max(-.25, min(.25, .3*point['x'])),
                 'outsideCalibrationSupport': point['outsideCalibrationSupport']}
        if time is not None:
            agent['time'] = time
        if demand_source:
            agent['demandSource'] = demand_source
        return agent

    initial = [make_agent(point, source_id, f'{camera}:{source_id}:initial', start)
               for source_id, point in sorted(records.get(start, {}).items()) if point['inside']]
    initial_ids = {agent['sourceId'] for agent in initial}
    accepted_ids = set(initial_ids)
    arrivals, rejected, candidate_events, crossings, occupancy, continuity = [], [], [], [], [], []
    raw_boundary_ids, raw_internal_birth_ids = set(), set()
    for sample in range(start, end+1):
        now, previous = records.get(sample, {}), records.get(sample-1, {})
        current_inside = {source_id for source_id, point in now.items() if point['inside']}
        previous_inside = {source_id for source_id, point in previous.items() if point['inside']}
        time = (sample-start)*dt
        speed_values = []
        for source_id in current_inside:
            vx, vy, count = last_two_velocity(records, sample, source_id, dt)
            if count == 2:
                speed_values.append(math.hypot(vx, vy))
        occupancy.append({'time': time, 'sourceSample': sample, 'count': len(current_inside),
                          'meanSpeed': float(np.mean(speed_values)) if speed_values else None,
                          'speedSampleCount': len(speed_values), 'density': len(current_inside)/scene['domainArea'],
                          'noTrackerRows': not bool(now)})
        if sample == start:
            continue
        entering = (current_inside-previous_inside) & previous.keys()
        leaving = (previous_inside-current_inside) & now.keys()
        births = current_inside-previous.keys()
        deaths = previous_inside-now.keys()
        continuity.append({'time': time, 'boundaryEntries': len(entering), 'boundaryDepartures': len(leaving),
                           'interiorTrackBirths': len(births), 'interiorTrackDeaths': len(deaths),
                           'countChange': len(current_inside)-len(previous_inside),
                           'accountingResidual': len(current_inside)-len(previous_inside)-len(entering)+len(leaving)-len(births)+len(deaths)})
        raw_boundary_ids.update(entering)
        raw_internal_birth_ids.update(births)
        for source_id, kind in [(source_id, 'boundary_confirmed') for source_id in sorted(entering)] + [(source_id, 'inferred_tunnel_birth') for source_id in sorted(births)]:
            point = now[source_id]
            bracket = [(sample-start-1)*dt, time]
            candidate = {'sourceId': source_id, 'sourceSample': sample, 'kind': kind, 'timeBracket': bracket}
            candidate_events.append(candidate)
            reason = None
            if source_id in accepted_ids:
                reason = 'initial_identity_not_reinserted' if source_id in initial_ids else 'source_identity_already_accepted'
            elif kind == 'inferred_tunnel_birth' and not (point['y'] < 0 and helper.inside([point['x'], point['y']], scene['tunnelPolygon'])):
                reason = 'internal_birth_outside_tunnel_not_inferred'
            elif source_id not in records.get(sample+1, {}) or not records[sample+1][source_id]['inside']:
                reason = 'two_inside_samples_not_confirmed'
            elif kind == 'boundary_confirmed' and helper.crosses_physical_wall(previous[source_id], point, scene['walls']):
                reason = 'crosses_physical_wall'
            if reason:
                rejected.append({**candidate, 'reason': reason})
                continue
            if kind == 'boundary_confirmed':
                fraction, position = helper.boundary_intersection(previous[source_id], point, scene['domainPolygon'])
                event_time = bracket[0]+fraction*dt
            else:
                position = deep_cut_position(point, scene, parameters['radius'])
                if position is None:
                    rejected.append({**candidate, 'reason': 'deep_cut_has_no_radius_clearance'})
                    continue
                event_time = (bracket[0]+bracket[1])/2
            if not 0 <= event_time < duration:
                rejected.append({**candidate, 'reason': 'event_outside_simulation_horizon'})
                continue
            spawn_point = {**point, 'x': position[0], 'y': position[1]}
            agent = make_agent(spawn_point, source_id, f'{camera}:{source_id}:entry', sample-1, event_time, kind)
            if kind == 'boundary_confirmed':
                agent['lane'] = max(-.25, min(.25, .3*previous[source_id]['x']))
            agent.update(x=position[0], y=position[1], sourceSample=sample, timeBracket=bracket,
                         confirmationSample=sample+1, confirmationTime=(sample+1-start)*dt,
                         confirmationRole='Admission filter only; confirmation displacement not used for speed, route or preferred velocity')
            if kind == 'inferred_tunnel_birth' or position[1] < -.2:
                agent.update(routeId='outbound', waypointIndex=0, lane=0)
            if kind == 'inferred_tunnel_birth':
                agent.update(positionRule='Lateral coordinate mapped/clipped onto deep open cut with physical-wall radius clearance; no interior position injection',
                             inferredDemandProxy=True,
                             inferenceLimitation='New tunnel track may be a previously missed or fragmented person; this is inferred demand, not directly observed boundary arrival')
            else:
                agent['positionRule'] = 'Observed outside-to-first-inside segment intersection; moved 0.01% of segment into open domain'
            arrivals.append(agent)
            accepted_ids.add(source_id)
        for source_id in sorted(now.keys() & previous.keys()):
            if not (now[source_id]['inside'] or previous[source_id]['inside']):
                continue
            crossing = helper.mouth_crossing(previous[source_id], now[source_id])
            if crossing:
                fraction, direction = crossing
                event_time = time-dt+fraction*dt
                if 0 <= event_time < duration:
                    crossings.append({'time': event_time, 'direction': direction, 'id': source_id,
                                      'timeBracket': [time-dt, time], 'sourceSample': sample})
    arrivals.sort(key=lambda event: (event['time'], event['id']))
    calibration = []
    for sample in range(cal_first, start, 5):
        calibration.append({'timeRelativeToStart': (sample-start)*dt, 'sourceSample': sample,
                            'agents': [make_agent(point, source_id, f'cal:{source_id}', sample)
                                       for source_id, point in sorted(records.get(sample, {}).items()) if point['inside']]})
    total_keys = ['boundaryEntries', 'boundaryDepartures', 'interiorTrackBirths', 'interiorTrackDeaths']
    quality_totals = {key: sum(row[key] for row in continuity) for key in total_keys}
    frames = [{'time': (sample-start)*dt, 'sourceSample': sample, 'isHistory': sample < start,
               'agents': [{'id': source_id, 'sourceId': source_id, 'x': point['x'], 'y': point['y']}
                          for source_id, point in sorted(records.get(sample, {}).items()) if point['inside']]}
              for sample in range(start-1, end+1)]
    count_times = [float(time) for time in range(0, int(duration)+1, 10)]
    if not count_times or count_times[-1] != duration:
        count_times.append(float(duration))
    held_counts = []
    for time in count_times:
        index = min(len(occupancy)-1, math.floor(time/dt+1e-10))
        source = occupancy[index]
        held_counts.append({'time': time, 'sourceTime': source['time'], 'actualSourceTime': source['time'],
                            'sourceSample': source['sourceSample'], 'lagSeconds': time-source['time'],
                            'count': source['count'], 'rule': 'nearest preceding native sample; no interpolation'})
    rejection_counts = dict(Counter(event['reason'] for event in rejected))
    demand_counts = dict(Counter(event['demandSource'] for event in arrivals))
    speed_counts = dict(Counter(agent['speedSource'] for agent in initial+arrivals))
    document = {'version': 3, 'windowId': f'{camera}_{nominal:g}', 'camera': camera,
        'durationSeconds': duration, 'nominalStartSeconds': nominal,
        'actualStartSecondsApprox': (start-1)*dt, 'startSample': start,
        'sampleIntervalSeconds': dt, 'scene': scene, 'initialAgents': initial, 'arrivals': arrivals,
        'parameters': parameters,
        'calibration': {'intervalSeconds': 60, 'snapshots': calibration,
            'empiricalSpeedPool': pool, 'empiricalSpeedPoolRecords': pool_records,
            'empiricalSpeedPoolFallback': pool_fallback,
            'empiricalSpeedPoolFallbackRule': 'No eligible preceding60s displacements: degenerate0.03W/s pool, explicitly flagged',
            'empiricalSpeedPoolRule': 'Every finite native consecutive displacement ending at an inside-domain point, with both timestamps in preceding60s; include stationary observations; floor0.03W/s; no Q75 replacement or upper speed exclusion',
            'speedSourceCounts': speed_counts, 'measuredSpeedMaximum': max(pool),
            'pressureCalibrationAvailable': any(snapshot['agents'] for snapshot in calibration)},
        'observation': {'status': 'AUTOMATIC PROXY, NOT GROUND TRUTH', 'occupancyArea': scene['domainArea'],
            'occupancy': occupancy, 'counts10s': held_counts, 'crossings': crossings,
            'speedDensity': occupancy, 'trackContinuity': continuity, 'qualityTotals': quality_totals,
            'speedDefinition': 'One consecutive native displacement, with no bridging of missing source IDs',
            'emptyFrameDefinition': 'Zero emitted inside-domain tracks. True emptiness and detector failure are not independently distinguishable.'},
        'quality': {'invalidRows': dict(invalid), 'initialAgents': len(initial), 'scheduledArrivals': len(arrivals),
            'rawBoundaryEventsBeforeConfirmation': quality_totals['boundaryEntries'],
            'rawBoundaryUniqueSourceIds': len(raw_boundary_ids),
            'rawInteriorBirthEvents': quality_totals['interiorTrackBirths'],
            'rawInteriorBirthUniqueSourceIds': len(raw_internal_birth_ids),
            'acceptedDemandCounts': demand_counts, 'acceptedDemandUniqueSourceIds': len({event['sourceId'] for event in arrivals}),
            'rejectedCounts': rejection_counts, 'rejectedEvents': rejected,
            'genuineReentryUnmodeled': 'All second accepted episodes and initial-cohort reentries are excluded; real reentries cannot be distinguished from boundary jitter with this tracker',
            'crossingIdentityCoverage': coverage(crossings, initial, arrivals),
            'speedSourceCounts': speed_counts,
            'source': 'Historical automatic tracker: ID switches, missed detections, trajectory gaps and projection extrapolation remain unresolved',
            'demandBoundary': 'Two consecutive inside samples confirm arrivals. Route and velocity use history ending at timeBracket START. Confirmation sample only filters eligibility. No observed future exit is a route label.',
            'inferredOutboundBoundary': 'Confirmed internal tunnel births use independent deep-cut outbound demand proxy, never their observed internal position as a simulated insertion point'},
        'sources': {}}
    observation = {'version': 3, 'windowId': document['windowId'], 'camera': camera, 'dt': dt,
        'durationSeconds': duration, 'startSample': start, 'frames': frames,
        'counts10s': held_counts, 'referenceCrossings': crossings,
        'occupancyPolygon': scene['occupancyPolygon'], 'occupancyArea': scene['domainArea'],
        'referenceStatus': 'Automatic tracker positions and counts, not ground truth',
        'historyPolicy': 'One preceding native frame and all native evaluation frames; missing IDs remain absent',
        'sources': {}}
    return document, observation
