// geo.js - offline conversion of British/Irish national grid references to WGS84 lat/lon.
// Implements the standard published formulae (OS "Guide to coordinate systems in Great
// Britain" transverse Mercator + Helmert datum transform; equivalent approach for the
// Irish National Grid). No network access required. Accuracy is approximate — a few
// metres to a few tens of metres — which is appropriate for tagging an inspection
// location, not survey-grade positioning.

const GeoGrid = (() => {
  function toRad(deg) { return deg * Math.PI / 180; }
  function toDeg(rad) { return rad * 180 / Math.PI; }

  // Parses a grid reference string into { easting, northing } in metres.
  // British National Grid uses a two-letter 100km-square prefix (skipping 'I').
  // Irish National Grid uses a single-letter 100km-square prefix (skipping 'I'), in a
  // separate 5x5 lettering scheme.
  function parseGridRef(ref, gridType) {
    const clean = ref.trim().toUpperCase().replace(/\s+/g, '');

    if (gridType === 'irish') {
      const m = clean.match(/^([A-HJ-Z])(\d+)$/);
      if (!m) return null;
      const letters = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'; // 25 letters, 'I' excluded
      const idx = letters.indexOf(m[1]);
      if (idx < 0) return null;
      const e100km = idx % 5;
      const n100km = Math.floor(idx / 5);

      const digits = m[2];
      if (digits.length === 0 || digits.length % 2 !== 0) return null;
      const half = digits.length / 2;
      const eDigits = (digits.slice(0, half) + '00000').slice(0, 5);
      const nDigits = (digits.slice(half) + '00000').slice(0, 5);
      return {
        easting: e100km * 100000 + Number(eDigits),
        northing: n100km * 100000 + Number(nDigits)
      };
    }

    if (!/^[A-Z]{2}\d+$/.test(clean)) return null;
    let l1 = clean.charCodeAt(0) - 65;
    let l2 = clean.charCodeAt(1) - 65;
    if (l1 > 7) l1--; // skip 'I'
    if (l2 > 7) l2--;
    const e100km = ((l1 - 2) % 5) * 5 + (l2 % 5);
    const n100km = (19 - Math.floor(l1 / 5) * 5) - Math.floor(l2 / 5);

    const digits = clean.slice(2);
    if (digits.length === 0 || digits.length % 2 !== 0) return null;
    const half = digits.length / 2;
    const eDigits = (digits.slice(0, half) + '00000').slice(0, 5);
    const nDigits = (digits.slice(half) + '00000').slice(0, 5);

    return {
      easting: e100km * 100000 + Number(eDigits),
      northing: n100km * 100000 + Number(nDigits)
    };
  }

  // Inverse transverse Mercator: easting/northing (on the given ellipsoid/projection) -> lat/lon
  // on that same (pre-WGS84) datum.
  function gridToLatLonOnDatum(easting, northing, ellipsoid, proj) {
    const { a, b } = ellipsoid;
    const { lat0, lon0, N0, E0, F0 } = proj;
    const e2 = 1 - (b * b) / (a * a);
    const n = (a - b) / (a + b);
    const n2 = n * n, n3 = n * n * n;

    let lat = lat0;
    let M = 0;
    do {
      lat = (northing - N0 - M) / (a * F0) + lat;
      const Ma = (1 + n + 1.25 * n2 + 1.25 * n3) * (lat - lat0);
      const Mb = (3 * n + 3 * n2 + 2.625 * n3) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
      const Mc = (1.875 * n2 + 1.875 * n3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
      const Md = (35 / 24) * n3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
      M = b * F0 * (Ma - Mb + Mc - Md);
    } while (Math.abs(northing - N0 - M) >= 0.00001);

    const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
    const nu = a * F0 / Math.sqrt(1 - e2 * sinLat * sinLat);
    const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
    const eta2 = nu / rho - 1;

    const tanLat = Math.tan(lat);
    const tan2 = tanLat * tanLat, tan4 = tan2 * tan2, tan6 = tan4 * tan2;
    const secLat = 1 / cosLat;
    const nu3 = nu * nu * nu, nu5 = nu3 * nu * nu, nu7 = nu5 * nu * nu;

    const VII = tanLat / (2 * rho * nu);
    const VIII = (tanLat / (24 * rho * nu3)) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
    const IX = (tanLat / (720 * rho * nu5)) * (61 + 90 * tan2 + 45 * tan4);
    const X = secLat / nu;
    const XI = (secLat / (6 * nu3)) * (nu / rho + 2 * tan2);
    const XII = (secLat / (120 * nu5)) * (5 + 28 * tan2 + 24 * tan4);
    const XIIA = (secLat / (5040 * nu7)) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);

    const dE = easting - E0;
    const latRad = lat - VII * dE * dE + VIII * Math.pow(dE, 4) - IX * Math.pow(dE, 6);
    const lonRad = lon0 + X * dE - XI * Math.pow(dE, 3) + XII * Math.pow(dE, 5) - XIIA * Math.pow(dE, 7);

    return { lat: toDeg(latRad), lon: toDeg(lonRad) };
  }

  // 7-parameter Helmert transform (small-angle form), datum A -> datum B.
  function helmertTransform(lat, lon, h, ellipsoidA, params) {
    const { a, b } = ellipsoidA;
    const e2 = 1 - (b * b) / (a * a);
    const latR = toRad(lat), lonR = toRad(lon);
    const sinLat = Math.sin(latR), cosLat = Math.cos(latR);
    const sinLon = Math.sin(lonR), cosLon = Math.cos(lonR);
    const nu = a / Math.sqrt(1 - e2 * sinLat * sinLat);

    const x1 = (nu + h) * cosLat * cosLon;
    const y1 = (nu + h) * cosLat * sinLon;
    const z1 = ((1 - e2) * nu + h) * sinLat;

    const s1 = params.s / 1e6 + 1;
    const rx = toRad(params.rx / 3600);
    const ry = toRad(params.ry / 3600);
    const rz = toRad(params.rz / 3600);

    const x2 = params.tx + x1 * s1 - y1 * rz + z1 * ry;
    const y2 = params.ty + x1 * rz + y1 * s1 - z1 * rx;
    const z2 = params.tz - x1 * ry + y1 * rx + z1 * s1;

    // Cartesian -> geodetic (WGS84 ellipsoid), iterative
    const wgs84 = { a: 6378137, b: 6356752.314245 };
    const e2b = 1 - (wgs84.b * wgs84.b) / (wgs84.a * wgs84.a);
    const p = Math.sqrt(x2 * x2 + y2 * y2);
    let latB = Math.atan2(z2, p * (1 - e2b));
    for (let i = 0; i < 6; i++) {
      const sinLatB = Math.sin(latB);
      const nuB = wgs84.a / Math.sqrt(1 - e2b * sinLatB * sinLatB);
      latB = Math.atan2(z2 + e2b * nuB * sinLatB, p);
    }
    const lonB = Math.atan2(y2, x2);

    return { lat: toDeg(latB), lon: toDeg(lonB) };
  }

  const OSGB36_ELLIPSOID = { a: 6377563.396, b: 6356256.909 };
  const OSGB36_PROJ = { lat0: toRad(49), lon0: toRad(-2), N0: -100000, E0: 400000, F0: 0.9996012717 };
  // Published approximate OSGB36 -> WGS84 Helmert parameters
  const OSGB36_TO_WGS84 = { tx: 446.448, ty: -125.157, tz: 542.060, s: -20.4894, rx: 0.1502, ry: 0.2470, rz: 0.8421 };

  const IRISH_ELLIPSOID = { a: 6377340.189, b: 6356034.447 };
  const IRISH_PROJ = { lat0: toRad(53.5), lon0: toRad(-8), N0: 250000, E0: 200000, F0: 1.000035 };
  // Published approximate Irish Grid (1965/OSNI) -> WGS84 Helmert parameters
  const IRISH_TO_WGS84 = { tx: 482.530, ty: -130.596, tz: 564.557, s: -8.150, rx: 1.042, ry: 0.214, rz: 0.631 };

  function convert(gridRefString, gridType) {
    const parsed = parseGridRef(gridRefString, gridType);
    if (!parsed) return null;
    const ellipsoid = gridType === 'irish' ? IRISH_ELLIPSOID : OSGB36_ELLIPSOID;
    const proj = gridType === 'irish' ? IRISH_PROJ : OSGB36_PROJ;
    const helmert = gridType === 'irish' ? IRISH_TO_WGS84 : OSGB36_TO_WGS84;

    const onDatum = gridToLatLonOnDatum(parsed.easting, parsed.northing, ellipsoid, proj);
    const wgs84 = helmertTransform(onDatum.lat, onDatum.lon, 0, ellipsoid, helmert);
    return wgs84;
  }

  return { convert, parseGridRef };
})();

window.GeoGrid = GeoGrid;
