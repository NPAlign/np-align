// Generates a synthetic warped needlepoint canvas scan with known
// intersection positions, for testing the alignment engine.
//
// The canvas is described by an inverse warp g(x, y) -> (u, v) in "canvas
// units" (1 unit = 1 hole spacing). Threads lie on integer u or integer v;
// intersections are where both u and v are integers.

export function makeCanvas({
  width, height, dpi, mesh,
  rotationDeg = 1.5,
  warp = 1.0, // peak warp in hole spacings
  threadFrac = 0.42, // thread width as fraction of spacing
  dark = true, // holes darker than threads (black backing)
  noise = 10,
  missingHoles = 0.003, // fraction of holes blocked by fibres/dust
  seed = 1,
}) {
  const pitch = dpi / mesh;
  const rot = (rotationDeg * Math.PI) / 180;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const cx = width / 2, cy = height / 2;
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);

  // smooth warp field, in pixels
  const A1 = warp * pitch, A2 = warp * 0.6 * pitch;
  const g = (x, y) => {
    const wx = x + A1 * Math.sin((2 * Math.PI * y) / (height * 0.9) + 0.3) + A2 * Math.sin((2 * Math.PI * x) / (width * 1.3));
    const wy = y + A1 * Math.sin((2 * Math.PI * x) / (width * 0.8) + 1.1) + A2 * Math.cos((2 * Math.PI * y) / (height * 1.1));
    const dx = wx - cx, dy = wy - cy;
    return [(cr * dx + sr * dy) / pitch, (-sr * dx + cr * dy) / pitch];
  };

  const blocked = new Set();
  const gray = new Uint8Array(width * height);
  const half = threadFrac / 2;
  const marginU = 1.5; // canvas edge margin in pixels -> keep holes off the border
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [u, v] = g(x, y);
      // distance to nearest thread centre line (threads at integer + 0.5 so
      // intersections land at half-integers, holes at integer centres)
      const fu = Math.abs(u - Math.round(u - 0.5) - 0.5);
      const fv = Math.abs(v - Math.round(v - 0.5) - 0.5);
      const onThread = fu < half || fv < half;
      let val;
      if (onThread) {
        // twisted-thread texture
        val = 215 + 20 * Math.sin((u + v) * 20) + 10 * Math.sin(u * 37);
      } else {
        const hk = `${Math.round(u)},${Math.round(v)}`;
        if (!blocked.has(hk) && rand() < missingHoles / (pitch * pitch * 0.3)) blocked.add(hk);
        val = blocked.has(hk) ? 200 : 35;
      }
      if (!dark) val = onThread ? val * 0.75 : 245;
      val += (rand() - 0.5) * 2 * noise;
      gray[y * width + x] = Math.max(0, Math.min(255, val));
    }
  }
  void marginU;

  // ground truth: intersections at (u, v) = (k + 0.5, m + 0.5). Solve g = target
  // by Newton iteration from an initial guess.
  const truth = (u, v) => {
    let x = cx + pitch * (cr * u - sr * v), y = cy + pitch * (sr * u + cr * v);
    for (let it = 0; it < 30; it++) {
      const [gu, gv] = g(x, y);
      const e = 0.01;
      const [ux, vx] = g(x + e, y), [uy, vy] = g(x, y + e);
      const a = (ux - gu) / e, b = (uy - gu) / e, c = (vx - gv) / e, d = (vy - gv) / e;
      const det = a * d - b * c;
      const ru = u - gu, rv = v - gv;
      x += (d * ru - b * rv) / det;
      y += (-c * ru + a * rv) / det;
    }
    return [x, y];
  };
  return { gray, truth, pitch, blocked };
}
