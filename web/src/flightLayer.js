const HEIGHT_SCALE = 30;

export function buildTimeline(route) {
  const climbSeconds = route.height_m / 3;
  const descentSeconds = climbSeconds;
  const cruiseSeconds = route.time_s;
  const frames = [];
  route.climb.forEach((point, index) => {
    const fraction = route.climb.length === 1 ? 0 : index / (route.climb.length - 1);
    frames.push({ point, time: fraction * climbSeconds, phase: "climb" });
  });
  const cruiseDistance = cumulativeDistance(route.cruise);
  const totalCruise = cruiseDistance[cruiseDistance.length - 1] || 1;
  route.cruise.forEach((point, index) => {
    frames.push({
      point,
      time: climbSeconds + (cruiseDistance[index] / totalCruise) * cruiseSeconds,
      phase: "cruise",
      cruiseIndex: index,
    });
  });
  route.descent.forEach((point, index) => {
    const fraction = route.descent.length === 1 ? 1 : index / (route.descent.length - 1);
    frames.push({
      point,
      time: climbSeconds + cruiseSeconds + fraction * descentSeconds,
      phase: "descent",
    });
  });
  return { frames, total: climbSeconds + cruiseSeconds + descentSeconds };
}

export function frameAt(timeline, time) {
  const frames = timeline.frames;
  if (!frames.length) return null;
  if (time <= frames[0].time) return frames[0];
  if (time >= frames[frames.length - 1].time) return frames[frames.length - 1];
  let high = 1;
  while (high < frames.length && frames[high].time < time) high += 1;
  const left = frames[high - 1];
  const right = frames[high];
  const span = right.time - left.time || 1;
  const mix = (time - left.time) / span;
  return {
    point: left.point.map((value, index) => value + (right.point[index] - value) * mix),
    phase: left.phase,
    cruiseIndex: left.cruiseIndex ?? 0,
  };
}

export function createFlightLayer(map, AMap, THREE) {
  let camera;
  let renderer;
  let scene;
  let line;
  let drone;
  let pending = null;
  const customCoords = map.customCoords;

  function draw(points) {
    if (!scene || !points?.length) return;
    customCoords.setCenter([points[0][0], points[0][1]]);
    const flat = customCoords.lngLatsToCoords(points.map((point) => [point[0], point[1]]));
    const positions = [];
    flat.forEach((pair, index) => {
      positions.push(pair[0], pair[1], points[index][2] * HEIGHT_SCALE);
    });
    if (line) {
      line.geometry.dispose();
      scene.remove(line);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x0e7490 }));
    scene.add(line);
    const first = flat[0];
    drone.position.set(first[0], first[1], points[0][2] * HEIGHT_SCALE);
    map.render();
  }

  const layer = new AMap.GLCustomLayer({
    zIndex: 30,
    init(gl) {
      camera = new THREE.PerspectiveCamera(60, 1, 1, 1 << 30);
      renderer = new THREE.WebGLRenderer({ context: gl, antialias: true });
      renderer.autoClear = false;
      scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 0.85));
      const sun = new THREE.DirectionalLight(0xffffff, 0.8);
      sun.position.set(1000, -2000, 4000);
      scene.add(sun);
      drone = new THREE.Mesh(
        new THREE.ConeGeometry(700, 1800, 10),
        new THREE.MeshStandardMaterial({ color: 0xc25a26 })
      );
      drone.rotation.x = Math.PI / 2;
      scene.add(drone);
      if (pending) draw(pending);
    },
    render() {
      if (!renderer || !camera) return;
      const params = customCoords.getCameraParams();
      camera.near = params.near;
      camera.far = params.far;
      camera.fov = params.fov;
      camera.position.set(...params.position);
      camera.up.set(...params.up);
      camera.lookAt(...params.lookAt);
      camera.updateProjectionMatrix();
      renderer.resetState();
      renderer.render(scene, camera);
      renderer.resetState();
    },
  });
  map.add(layer);

  return {
    place(points) {
      pending = points;
      draw(points);
    },
    move(point) {
      if (!drone || !point) return;
      const pair = customCoords.lngLatsToCoords([[point[0], point[1]]])[0];
      drone.position.set(pair[0], pair[1], point[2] * HEIGHT_SCALE);
      map.render();
    },
    layer,
  };
}

function cumulativeDistance(points) {
  const totals = [0];
  for (let index = 1; index < points.length; index += 1) {
    totals.push(totals[index - 1] + roughMeters(points[index - 1], points[index]));
  }
  return totals;
}

function roughMeters(a, b) {
  const x = (a[0] - b[0]) * 111320 * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  const y = (a[1] - b[1]) * 110540;
  return Math.hypot(x, y);
}
