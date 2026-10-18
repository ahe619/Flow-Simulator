"""Build rolling speed samples and the first-minute density snapshots."""
import math


def calibration_agent(base, records, scene, source_id, point, sample, dt):
    """Same frozen V3 representation; only positions affect density calibration."""
    vx, vy, count = base.last_two_velocity(records, sample, source_id, dt)
    raw_speed = math.hypot(vx, vy) if count == 2 else None
    speed = max(.03, raw_speed) if raw_speed is not None else None
    route = base.helper.select_route(point, vx, vy)
    waypoint = (2 if route=='inbound' and point['y']<-.18 else
                1 if route=='inbound' and point['y']<.18 else
                1 if route=='outbound' and point['y']>.25 else 0)
    return {'id':f'cal:{source_id}', 'sourceId':source_id,
            'x':point['x'], 'y':point['y'], 'vx':vx, 'vy':vy,
            'speed':speed, 'rawHistoricalSpeed':raw_speed,
            'speedSource':'last_two_past_positions' if speed is not None else 'empirical_pending',
            'historySamples':count, 'routeId':route, 'waypointIndex':waypoint,
            'lane':max(-.25,min(.25,.3*point['x'])),
            'outsideCalibrationSupport':point['outsideCalibrationSupport']}


def extra_tables(base, document, raw, geometry, first, last, dt):
    records, invalid = base.project_records(raw, geometry, document['scene'])
    assert dict(invalid)==document['quality']['invalidRows']
    speed_records = []
    for sample in range(first+1,last+1):
        for source_id, point in sorted(records.get(sample,{}).items()):
            if not point['inside']:
                continue
            vx,vy,count = base.last_two_velocity(records,sample,source_id,dt)
            if count!=2:
                continue
            raw_speed = math.hypot(vx,vy)
            if not math.isfinite(raw_speed):
                raise ValueError('Nonfinite speed observation')
            speed_records.append({'time':(sample-first)*dt,
                'previousTime':(sample-first-1)*dt, 'sourceSample':sample,
                'sourceId':source_id, 'rawSpeed':raw_speed,
                'speed':max(.03,raw_speed)})
    # The reference event is retrospective. The first 60 s provide one fixed
    # pressure onset. Negative times are a compatibility view relative to the
    # calibration end, not a claim that these observations precede simulation.
    snapshots = []
    for sample in range(first,last+1,5):
        elapsed = (sample-first)*dt
        if elapsed>=60:
            break
        snapshots.append({'sourceSample':sample,
            'actualElapsedTime':elapsed, 'timeRelativeToCalibrationEnd':elapsed-60,
            'timeRelativeToStart':elapsed-60,
            'isObserved':sample in raw,'observationMissing':sample not in raw,
            'timeRelativeToStartCompatibilityOrigin':'calibration end at simulation elapsed 60 s, not simulation start',
            'agents':[calibration_agent(base,records,document['scene'],source_id,point,sample,dt)
                      for source_id,point in sorted(records.get(sample,{}).items()) if point['inside']]})
    candidates=[]
    for sample in range(first+1,last+1):
        now=records.get(sample,{});previous=records.get(sample-1,{})
        now_inside={pid for pid,p in now.items() if p['inside']}
        previous_inside={pid for pid,p in previous.items() if p['inside']}
        entering=(now_inside-previous_inside)&previous.keys()
        births=now_inside-previous.keys()
        for ids,kind in [(entering,'boundary_confirmed'),(births,'inferred_tunnel_birth')]:
            for pid in sorted(ids):
                candidates.append({'sourceId':pid,'sourceSample':sample,'kind':kind,
                    'timeBracket':[(sample-first-1)*dt,(sample-first)*dt],
                    'firstInsidePositionW':[now[pid]['x'],now[pid]['y']],
                    'confirmationSampleAvailable':sample+1 in raw})
    rejected = document['quality']['rejectedEvents']
    rej_map={(r['sourceId'],r['sourceSample'],r['kind']):r for r in rejected}
    accepted_map={(a['sourceId'],a['sourceSample'],a['demandSource']):a for a in document['arrivals']}
    assert len(rej_map)==len(rejected) and len(accepted_map)==len(document['arrivals'])
    assert len(candidates)==len(rejected)+len(document['arrivals'])
    for c in candidates:
        k=(c['sourceId'],c['sourceSample'],c['kind'])
        assert (k in rej_map) != (k in accepted_map)
        if k in rej_map:
            c.update(status='rejected',reason=rej_map[k]['reason'])
        else:
            c.update(status='accepted',inputId=accepted_map[k]['id'],
                     nominalInputTime=accepted_map[k]['time'])
    assert sum(c['kind']=='boundary_confirmed' for c in candidates)==document['quality']['rawBoundaryEventsBeforeConfirmation']
    assert sum(c['kind']=='inferred_tunnel_birth' for c in candidates)==document['quality']['rawInteriorBirthEvents']
    return speed_records,snapshots,candidates
