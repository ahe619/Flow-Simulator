"""Ground-plane projection and finite-boundary intersections."""
import math
import cv2
import numpy as np


def project(H,p):
    q=H@np.r_[p,1.]
    if abs(q[2])<1e-9:
        raise ValueError('projection_horizon')
    return (q[:2]/q[2]).tolist()


def inside(p,polygon):
    return cv2.pointPolygonTest(np.array(polygon,np.float32),tuple(map(float,p)),False)>=0


def area(poly):
    p=np.array(poly,float)
    return abs(float(np.dot(p[:,0],np.roll(p[:,1],-1))-np.dot(p[:,1],np.roll(p[:,0],-1))))/2


def select_route(p,vx,vy):
    # A fixed local navigation heuristic. It is not a measured destination.
    # Stationary queues default to the mouth; clear lateral motion stays lateral.
    speed=math.hypot(vx,vy)
    if speed>=.03 and abs(vx)>1.5*abs(vy):
        return 'right' if vx>0 else 'left'
    if speed>=.03 and vy>.5*speed:
        return 'outbound'
    return 'inbound'


def boundary_intersection(a,b,poly):
    # Outside -> inside transition. A convexity assumption is not needed;
    # choose the LAST boundary hit along the observed segment before b.
    p=np.array([a['x'],a['y']]);d=np.array([b['x'],b['y']])-p
    hits=[]
    for c,e in zip(poly,poly[1:]+poly[:1]):
        c=np.array(c);edge=np.array(e)-c
        den=d[0]*edge[1]-d[1]*edge[0]
        if abs(den)<1e-12: continue
        cp=c-p
        t=(cp[0]*edge[1]-cp[1]*edge[0])/den
        u=(cp[0]*d[1]-cp[1]*d[0])/den
        if -1e-8<=t<=1+1e-8 and -1e-8<=u<=1+1e-8: hits.append(max(0,min(1,float(t))))
    if not hits: raise ValueError('no_boundary_intersection')
    t=max(hits); pos=p+min(1,t+1e-4)*d
    return t,pos.tolist()


def mouth_crossing(a,b):
    # Mouth is [-.5,0] to[.5,0]. Half-open handling prevents double counting.
    if (a['y']>0 and b['y']<=0) or (a['y']<0 and b['y']>=0):
        t=a['y']/(a['y']-b['y'])
        x=a['x']+t*(b['x']-a['x'])
        if -.5<=x<=.5:
            return t,'into' if a['y']>0 else 'out'
    return None


def crosses_physical_wall(a,b,walls):
    p=np.array([a['x'],a['y']]);q=np.array([b['x'],b['y']]);d=q-p
    for w in walls:
        c=np.array(w['p0']);e=np.array(w['p1'])-c
        den=d[0]*e[1]-d[1]*e[0]
        if abs(den)<1e-12:continue
        cp=c-p
        t=(cp[0]*e[1]-cp[1]*e[0])/den
        u=(cp[0]*d[1]-cp[1]*d[0])/den
        if -1e-8<=t<=1+1e-8 and -1e-8<=u<=1+1e-8:return True
    return False
