/* =============================================================================
   Sekolah Siaga Panas — application logic
   Vanilla JS, no framework, no build step. One IIFE, nothing on window.
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ config */

  var CFG = {
    // THIRD-PARTY WRAPPER, NOT BMKG ITSELF.
    // bmkg-restapi.vercel.app is a community REST wrapper around BMKG's public
    // data. It is CORS-enabled and needs no key, which is why it is usable
    // directly from a static page, but it is neither operated nor endorsed by
    // BMKG. Its shared rate limit is 30 requests/minute across ALL users of the
    // deployment. The authoritative endpoint is
    //   https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4={code}
    // which should be used in production if CORS permits, or behind a proxy if
    // not. See README.md.
    BMKG: 'https://bmkg-restapi.vercel.app',

    // Guaranteed-CORS global fallback. Used automatically when BMKG fails,
    // returns malformed data, or rate-limits.
    OPEN_METEO: 'https://api.open-meteo.com/v1/forecast',

    // Reverse geocoding for setup path (a) only. Its answer is never accepted
    // silently — it merely pre-fills the region search, which the user confirms.
    GEOCODE: 'https://api.bigdatacloud.net/data/reverse-geocode-client',

    TIMEOUT_MS: 12000,
    GEO_TIMEOUT_MS: 15000,
    SEARCH_DEBOUNCE_MS: 300,

    STALE_MS: 60 * 60 * 1000,        // older than this -> "DATA LAMA" badge
    MAX_AGE_MS: 24 * 60 * 60 * 1000, // older than this -> no level shown at all

    KEY_LOC: 'ssp.location',
    KEY_READING: 'ssp.lastReading'
  };

  /* -------------------------------------------------------------- computation */

  /**
   * Simplified Wet Bulb Globe Temperature (sWBGT), the Australian Bureau of
   * Meteorology / ACSM-87 approximation:
   *
   *   es    = 6.112 * exp(17.67 * T / (T + 243.5))   saturation vapour pressure, hPa
   *   e     = es * RH / 100                          actual vapour pressure, hPa
   *   sWBGT = 0.567 * T + 0.393 * e + 3.94
   *
   * LIMITATIONS — these matter, and the UI states them too:
   *  - It is derived from temperature and humidity ONLY. It has no input for
   *    solar radiation or wind, so it bakes in an assumption of moderately high
   *    solar radiation and light wind.
   *  - It therefore OVERESTIMATES heat stress when it is cloudy, when it is
   *    windy, and at night — exactly the conditions where the assumption fails.
   *  - It is biased relative to full physical models such as Liljegren, which
   *    solve the actual heat balance of a globe thermometer. Do not treat these
   *    numbers as interchangeable with a measured WBGT.
   *
   * @param {number} T  dry-bulb temperature, °C
   * @param {number} RH relative humidity, %
   * @returns {number}  sWBGT in °C
   */
  function sWBGT(T, RH) {
    var es = 6.112 * Math.exp((17.67 * T) / (T + 243.5));
    var e = (es * RH) / 100;
    return 0.567 * T + 0.393 * e + 3.94;
  }

  /* ------------------------------------------------------------------ levels */

  // Colour is never the only signal: each level also carries a WORD and a
  // distinct icon silhouette, for colour-blind users and for bright sunlight
  // where hue collapses on a phone screen.
  var IC = {
    check: '<svg viewBox="0 0 24 24" role="img" aria-hidden="true"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M7.4 12.4l3.1 3.1 6.2-6.6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="square"/></svg>',
    drop: '<svg viewBox="0 0 24 24" role="img" aria-hidden="true"><path d="M12 2.4c4.1 5.7 6.2 8.7 6.2 11.2A6.2 6.2 0 0 1 5.8 13.6C5.8 11.1 7.9 8.1 12 2.4z" fill="currentColor"/></svg>',
    tri: '<svg viewBox="0 0 24 24" role="img" aria-hidden="true"><path d="M12 2.6l10 18.8H2z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="miter"/><rect x="10.85" y="9" width="2.3" height="6.4" fill="currentColor"/><rect x="10.85" y="16.6" width="2.3" height="2.3" fill="currentColor"/></svg>',
    oct: '<svg viewBox="0 0 24 24" role="img" aria-hidden="true"><path d="M8.2 2.2h7.6l6 6v7.6l-6 6H8.2l-6-6V8.2z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="miter"/><rect x="10.85" y="6.6" width="2.3" height="7" fill="currentColor"/><rect x="10.85" y="15.1" width="2.3" height="2.3" fill="currentColor"/></svg>',
    octx: '<svg viewBox="0 0 24 24" role="img" aria-hidden="true"><path d="M8.2 2.2h7.6l6 6v7.6l-6 6H8.2l-6-6V8.2z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="miter"/><path d="M8.4 8.4l7.2 7.2M15.6 8.4l-7.2 7.2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="square"/></svg>'
  };

  /**
   * PROVISIONAL bands, deliberately shifted upward for a humid tropical
   * climate. The standard US WBGT flag thresholds would read black on nearly
   * every Surabaya afternoon, which would train users to ignore the app. These
   * await calibration against local climatology and are NOT an official
   * standard — the UI says so in the footnote.
   *
   * Bands are cumulative: each level's actions include every lower level's.
   */
  var LEVELS = [
    {
      key: 'PUTIH', min: -Infinity, sub: 'AMAN',
      fill: '#FFFFFF', fg: '#000000', border: true, icon: IC.check,
      actions: [
        'Anak bawa botol minum sendiri.',
        'Guru ingatkan minum saat istirahat.'
      ]
    },
    {
      key: 'HIJAU', min: 31.0, sub: 'SEDANG',
      fill: '#00B41E', fg: '#FFFFFF', icon: IC.drop,
      actions: [
        'Minum tiap jam, guru yang mengingatkan.',
        'Jendela dibuka, kipas menyala.',
        'Topi saat olahraga dan istirahat.'
      ]
    },
    {
      key: 'KUNING', min: 32.5, sub: 'MENINGKAT',
      fill: '#FFF000', fg: '#000000', icon: IC.tri,
      actions: [
        'Olahraga berat hindari 11:00-15:00.',
        'Istirahat main di teduh.',
        'Botol minum di meja, bukan di tas.'
      ]
    },
    {
      key: 'MERAH', min: 34.0, sub: 'RISIKO TINGGI',
      fill: '#ED1C24', fg: '#FFFFFF', icon: IC.oct,
      actions: [
        'Tidak ada kegiatan luar ruang 09:00-16:00.',
        'Olahraga pindah ke jam pertama atau setelah 16:00.',
        'Gorden sisi matahari ditutup.'
      ]
    },
    {
      key: 'HITAM', min: 35.5, sub: 'RISIKO SANGAT TINGGI',
      fill: '#000000', fg: '#FFFFFF', icon: IC.octx,
      actions: [
        'Olahraga luar ruang hanya sebelum 08:00.',
        'Upacara dan ekstrakurikuler luar ruang ditiadakan.',
        'Minum tiap 20 menit, UKS disiapkan.'
      ]
    }
  ];

  function levelIndex(v) {
    var i = 0;
    for (var k = 0; k < LEVELS.length; k++) if (v >= LEVELS[k].min) i = k;
    return i;
  }

  /* --------------------------------------------------------------- messages */

  // Every failure path gets plain Indonesian plus an English subtitle.
  var ERR = {
    GEO_UNSUPPORTED: ['Perangkat ini tidak mendukung lokasi.', 'This device does not support geolocation.', 'Gunakan pencarian manual di bawah.'],
    GEO_DENIED: ['Izin lokasi ditolak.', 'Location permission denied.', 'Tidak apa-apa — cari nama desa/kelurahan secara manual.'],
    GEO_UNAVAILABLE: ['Posisi tidak dapat ditentukan.', 'Position unavailable.', 'Coba di luar ruangan, atau cari manual.'],
    GEO_TIMEOUT: ['Pencarian lokasi terlalu lama.', 'Location request timed out.', 'Coba lagi, atau cari manual.'],
    GEOCODE_FAIL: ['Nama wilayah tidak bisa dibaca dari koordinat.', 'Could not resolve a village name from your coordinates.', 'Silakan cari manual.'],
    NOT_FOUND: ['Wilayah tidak ditemukan.', 'Region not found.', 'Coba nama lain, atau telusuri lewat provinsi.'],
    AMBIGUOUS: ['Ada beberapa wilayah dengan nama yang mirip.', 'Several regions match that name.', 'Pilih salah satu di bawah — jangan sampai keliru desa.'],
    UNREACHABLE: ['Server BMKG tidak dapat dihubungi.', 'The BMKG source is unreachable.', ''],
    MALFORMED: ['Data cuaca tidak terbaca.', 'The weather response was malformed.', ''],
    RATE_LIMIT: ['Terlalu banyak permintaan ke server.', 'Rate limited by the source.', 'Tunggu sebentar lalu coba lagi.'],
    NO_COORDS: ['Koordinat lokasi belum tersimpan.', 'No stored coordinates for this location.', 'Sumber cadangan tidak bisa dipakai. Coba muat ulang saat BMKG pulih, atau atur ulang lokasi.'],
    OFFLINE: ['Tidak ada koneksi internet.', 'You are offline.', ''],
    ALL_FAILED: ['Semua sumber data gagal dihubungi.', 'Every data source failed.', ''],
    NO_DATA: ['Belum ada data cuaca untuk lokasi ini.', 'No weather data available for this location.', 'Coba desa/kelurahan tetangga.']
  };

  function AppError(code, cause) {
    this.code = code;
    this.cause = cause;
    this.message = (ERR[code] && ERR[code][1]) || code;
  }
  AppError.prototype = Object.create(Error.prototype);
  AppError.prototype.name = 'AppError';

  function errOf(e) {
    return (e && e.code && ERR[e.code]) ? e.code : 'MALFORMED';
  }

  /* ------------------------------------------------------------------ utils */

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // Indonesian uses the comma as decimal separator — everywhere in the UI.
  function num(v, dp) {
    if (v == null || !isFinite(v)) return '—';
    dp = dp == null ? 1 : dp;
    try {
      return v.toLocaleString('id-ID', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    } catch (_) {
      return v.toFixed(dp).replace('.', ',');
    }
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /* Wall-clock helpers ------------------------------------------------------
     Every source reports times in the SCHOOL's local timezone, which may differ
     from the device's. So absolute instants and local calendar days are tracked
     separately: `at` (epoch ms) orders things, `dayKey` groups them into the
     school's day. Never rely on the device clock's timezone for either. */

  function dayKeyAt(ms, offsetMin) {
    var d = new Date(ms + offsetMin * 60000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  // "+0700" / "+07:00" -> 420
  function parseTzOffset(s) {
    var m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    var mins = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    return m[1] === '-' ? -mins : mins;
  }

  // "2026-08-01 10:00:00" (UTC) -> epoch ms
  function parseUtcStamp(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  }

  function isNum(v, lo, hi) {
    return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
  }

  /* ---------------------------------------------------------------- storage */

  var store = {
    get: function (k) {
      try {
        var raw = localStorage.getItem(k);
        return raw ? JSON.parse(raw) : null;
      } catch (_) { return null; }
    },
    set: function (k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; }
      catch (_) { return false; } // private mode / quota — app still works, just forgets
    },
    del: function (k) { try { localStorage.removeItem(k); } catch (_) {} }
  };

  /* ------------------------------------------------------------------- net */

  function fetchJSON(url, timeoutMs) {
    var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ac) ac.abort(); }, timeoutMs || CFG.TIMEOUT_MS);

    var opts = { headers: { Accept: 'application/json' } };
    if (ac) opts.signal = ac.signal;

    return fetch(url, opts).then(function (res) {
      // JS cannot read x-ratelimit-* here: the wrapper does not send
      // access-control-expose-headers, so those headers are filtered out by
      // CORS. Rate limiting is detectable only from the 429 status.
      if (res.status === 429) throw new AppError('RATE_LIMIT');
      if (!res.ok) throw new AppError(res.status === 404 ? 'NO_DATA' : 'UNREACHABLE');

      // The service worker tags responses it replays from its cache, so a
      // reading built from a stale body is never labelled as current.
      var cached = res.headers.get('X-SSP-From-Cache') === '1';
      return res.json().then(function (json) {
        return { json: json, fromCache: cached };
      }, function () { throw new AppError('MALFORMED'); });
    }).catch(function (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('UNREACHABLE', e);
    }).then(function (r) {
      clearTimeout(timer);
      return r;
    }, function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  /* --------------------------------------------------------------- sources */

  /* Defensive parsing note ---------------------------------------------------
     The wrapper does publish an OpenAPI schema for these endpoints, and it does
     declare temperature_c/humidity_pct as required integers. That is NOT a
     guarantee: the same schema marks location.district and location.village as
     required, and the live API returns empty strings for both on valid village
     codes. Schema conformance says nothing about whether a value is usable, so
     every field is checked at the point of use and every entry that fails is
     dropped rather than trusted. Values are never invented, mocked or
     interpolated — a gap in the data stays a gap. */

  var sources = {};

  /**
   * BMKG via the community wrapper.
   *
   * The 3-day forecast endpoint is the only endpoint used during normal loads.
   * Setup calls /current once to capture coordinates for the fallback source;
   * subsequent refreshes do not spend a second request on the same current
   * slot. See README.md.
   *
   * Entries are 3-HOURLY, not hourly, and BMKG drops entries whose time has
   * already passed, so "today" shrinks as the day goes on.
   */
  sources.bmkg = function (loc) {
    return fetchJSON(CFG.BMKG + '/v1/weather/' + encodeURIComponent(loc.adm4)).then(function (r) {
      var d = r.json && r.json.data;
      if (!d || !Array.isArray(d.forecast)) throw new AppError('MALFORMED');

      var offset = parseTzOffset(d.location && d.location.timezone);
      if (offset == null) offset = 7 * 60; // WIB; the app's whole audience is Indonesian

      var entries = [];
      for (var i = 0; i < d.forecast.length; i++) {
        var day = d.forecast[i];
        if (!day || !Array.isArray(day.entries)) throw new AppError('MALFORMED');
        for (var j = 0; j < day.entries.length; j++) {
          var e = day.entries[j];
          if (!e) throw new AppError('MALFORMED');
          var t = e.temperature_c, rh = e.humidity_pct;
          if (!isNum(t, -50, 60) || !isNum(rh, 0, 100)) {
            throw new AppError('MALFORMED');
          }

          var at = parseUtcStamp(e.utc_datetime);
          var lm = /^(\d{4}-\d{2}-\d{2})[ T](\d{2})/.exec(String(e.local_datetime || ''));
          if (!lm || !isFinite(parseUtcStamp(e.local_datetime))) {
            throw new AppError('MALFORMED');
          }
          if (!isFinite(at) && lm) at = parseUtcStamp(e.local_datetime) - offset * 60000;
          if (!isFinite(at)) throw new AppError('MALFORMED');

          entries.push({
            at: at,
            dayKey: lm ? lm[1] : dayKeyAt(at, offset),
            hour: lm ? parseInt(lm[2], 10) : new Date(at + offset * 60000).getUTCHours(),
            t: t, rh: rh
          });
        }
      }
      if (!entries.length) throw new AppError('MALFORMED');

      var lat = d.location && d.location.lat, lon = d.location && d.location.lon;
      return finish({
        source: 'bmkg',
        intervalHours: 3,
        tzOffsetMin: offset,
        entries: entries,
        coords: (isNum(lat, -90, 90) && isNum(lon, -180, 180)) ? { lat: lat, lon: lon } : null,
        fromCache: r.fromCache
      });
    });
  };

  /**
   * One-time setup lookup. The current endpoint is used only to capture the
   * confirmed village's coordinates for Open-Meteo; all displayed values still
   * come from the forecast endpoint so the headline can represent the daily
   * peak rather than a single instant.
   */
  sources.bmkgCurrentCoords = function (adm4) {
    return fetchJSON(CFG.BMKG + '/v1/weather/' + encodeURIComponent(adm4) + '/current')
      .then(function (r) {
        var loc = r.json && r.json.data && r.json.data.location;
        var lat = loc && loc.lat, lon = loc && loc.lon;
        if (!isNum(lat, -90, 90) || !isNum(lon, -180, 180)) {
          throw new AppError('MALFORMED');
        }
        return { lat: lat, lon: lon };
      });
  };

  /**
   * Open-Meteo. Global, no key, guaranteed CORS. True hourly, and it includes
   * hours already past today — a fuller picture than BMKG gives, which is why
   * the hour strip changes resolution when this source is in use.
   */
  sources.openMeteo = function (loc) {
    if (!isNum(loc.lat, -90, 90) || !isNum(loc.lon, -180, 180)) throw new AppError('NO_COORDS');

    var url = CFG.OPEN_METEO +
      '?latitude=' + encodeURIComponent(loc.lat) +
      '&longitude=' + encodeURIComponent(loc.lon) +
      '&hourly=temperature_2m,relative_humidity_2m&timezone=auto&forecast_days=2';

    return fetchJSON(url).then(function (r) {
      var d = r.json, hh = d && d.hourly;
      if (!hh || !Array.isArray(hh.time) || !Array.isArray(hh.temperature_2m) ||
          !Array.isArray(hh.relative_humidity_2m)) throw new AppError('MALFORMED');
      if (hh.time.length !== hh.temperature_2m.length ||
          hh.time.length !== hh.relative_humidity_2m.length) {
        throw new AppError('MALFORMED');
      }

      var offsetSec = typeof d.utc_offset_seconds === 'number' ? d.utc_offset_seconds : 7 * 3600;
      var offset = Math.round(offsetSec / 60);

      var entries = [];
      for (var i = 0; i < hh.time.length; i++) {
        var t = hh.temperature_2m[i], rh = hh.relative_humidity_2m[i];
        if (!isNum(t, -50, 60) || !isNum(rh, 0, 100)) {
          throw new AppError('MALFORMED');
        }
        var m = /^(\d{4}-\d{2}-\d{2})T(\d{2})/.exec(String(hh.time[i] || ''));
        if (!m || !isFinite(parseUtcStamp(hh.time[i]))) throw new AppError('MALFORMED');
        entries.push({
          at: parseUtcStamp(hh.time[i]) - offsetSec * 1000,
          dayKey: m[1],
          hour: parseInt(m[2], 10),
          t: t, rh: rh
        });
      }
      if (!entries.length) throw new AppError('MALFORMED');

      return finish({
        source: 'openmeteo',
        intervalHours: 1,
        tzOffsetMin: offset,
        entries: entries,
        coords: null,
        fromCache: r.fromCache
      });
    });
  };

  // Attaches the computed sWBGT + level to every entry and stamps the reading.
  function finish(reading) {
    reading.entries.sort(function (a, b) { return a.at - b.at; });
    for (var i = 0; i < reading.entries.length; i++) {
      var e = reading.entries[i];
      e.w = sWBGT(e.t, e.rh);
      e.lv = levelIndex(e.w);
    }
    reading.fetchedAt = Date.now();
    return reading;
  }

  var SOURCE_LABEL = {
    bmkg: 'BMKG (via wrapper komunitas)',
    openmeteo: 'Open-Meteo (sumber cadangan)'
  };

  /**
   * Primary, then fallback, then cache. Returns { reading, stale, problem }.
   * Never throws for a merely-degraded outcome — offline is a feature, not an
   * error state.
   */
  function load(loc) {
    var cached = store.get(CFG.KEY_READING);
    var cachedFor = cached && cached.adm4 === loc.adm4 ? cached : null;

    function useCache(problem) {
      if (!cachedFor) throw new AppError(problem || 'ALL_FAILED');
      return { reading: cachedFor, stale: true, problem: problem };
    }

    // Offline: do not even attempt the network, and do not pretend the cached
    // number is current.
    if (navigator.onLine === false) return Promise.resolve(useCache('OFFLINE'));

    return sources.bmkg(loc).then(null, function (e1) {
      // BMKG failed / malformed / rate-limited — fall through automatically.
      return sources.openMeteo(loc).then(function (r) {
        r.degradedFrom = errOf(e1);
        return r;
      }, function (e2) {
        throw new AppError(errOf(e2) === 'NO_COORDS' ? 'NO_COORDS' : 'ALL_FAILED', e2);
      });
    }).then(function (reading) {
      reading.adm4 = loc.adm4;
      // A location first saved during an outage has no coordinates. As soon as
      // BMKG later responds, repair the saved location so future Open-Meteo
      // fallback attempts can succeed.
      if (reading.source === 'bmkg' && reading.coords &&
          (!isNum(loc.lat, -90, 90) || !isNum(loc.lon, -180, 180))) {
        loc.lat = reading.coords.lat;
        loc.lon = reading.coords.lon;
        store.set(CFG.KEY_LOC, loc);
      }
      // A body replayed from the service worker's cache is not a fresh reading.
      if (reading.fromCache && cachedFor) return useCache('OFFLINE');
      store.set(CFG.KEY_READING, reading);
      return { reading: reading, stale: !!reading.fromCache, problem: null };
    }, function (e) {
      return useCache(errOf(e));
    });
  }

  /* -------------------------------------------------------------- geocoding */

  function reverseGeocode(lat, lon) {
    var url = CFG.GEOCODE + '?latitude=' + encodeURIComponent(lat) +
      '&longitude=' + encodeURIComponent(lon) + '&localityLanguage=id';
    return fetchJSON(url).then(function (r) {
      var d = r.json || {};
      var admin = (d.localityInfo && d.localityInfo.administrative) || [];
      function byLevel(n) {
        for (var i = 0; i < admin.length; i++) if (admin[i].adminLevel === n) return admin[i].name;
        return '';
      }
      // adminLevel 6 is kelurahan/desa in Indonesia, 5 kota/kabupaten, 4 provinsi.
      var village = byLevel(6) || d.locality || '';
      var city = byLevel(5) || d.city || '';
      var province = byLevel(4) || '';
      if (!village) throw new AppError('GEOCODE_FAIL');
      return { village: village, city: city, province: province };
    }, function () { throw new AppError('GEOCODE_FAIL'); });
  }

  function getPosition() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new AppError('GEO_UNSUPPORTED'));
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve({ lat: p.coords.latitude, lon: p.coords.longitude }); },
        function (err) {
          var code = err && err.code === 1 ? 'GEO_DENIED'
            : err && err.code === 3 ? 'GEO_TIMEOUT' : 'GEO_UNAVAILABLE';
          reject(new AppError(code, err));
        },
        // Village-level precision is all this app needs; high accuracy would
        // cost battery and time for nothing.
        { enableHighAccuracy: false, timeout: CFG.GEO_TIMEOUT_MS, maximumAge: 600000 }
      );
    });
  }

  /* ----------------------------------------------------------- wilayah API */

  function wilayahSearch(q) {
    return fetchJSON(CFG.BMKG + '/v1/wilayah/search?q=' + encodeURIComponent(q) + '&limit=50')
      .then(function (r) {
        var arr = r.json && r.json.data;
        return Array.isArray(arr) ? arr.filter(function (x) { return x && x.code && x.name; }) : [];
      });
  }

  function wilayahList(kind, param, value) {
    return fetchJSON(CFG.BMKG + '/v1/wilayah/' + kind + '?' + param + '=' + encodeURIComponent(value))
      .then(function (r) {
        var arr = r.json && r.json.data;
        return Array.isArray(arr) ? arr.filter(function (x) { return x && x.code && x.name; }) : [];
      });
  }

  function norm(s) {
    return String(s || '').toUpperCase()
      .replace(/\b(KOTA ADMINISTRASI|KOTA|KABUPATEN|KAB\.?|ADM\.?)\b/g, ' ')
      .replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* ============================================================== SETUP UI == */

  var setupState = { browse: null, seq: 0 };

  function showScreen(which) {
    ['screen-boot', 'screen-setup', 'screen-reading', 'screen-fatal'].forEach(function (id) {
      var n = $(id);
      if (n) n.hidden = (id !== which);
    });
    var skip = document.querySelector('.skip-link');
    if (skip) skip.setAttribute('href', '#' + which);
    window.scrollTo(0, 0);
  }

  function msgBox(cls, code, extra) {
    var m = ERR[code] || [code, '', ''];
    var box = el('div', 'banner ' + cls);
    box.appendChild(el('p', 'banner__title', m[0]));
    var body = el('p', 'banner__body');
    if (m[2] || extra) body.appendChild(document.createTextNode(extra || m[2]));
    body.appendChild(el('span', 'banner__en', m[1]));
    box.appendChild(body);
    return box;
  }

  function setSetupMsg(node) {
    var slot = $('setup-msg');
    clear(slot);
    if (node) slot.appendChild(node);
  }

  function renderSetup(opts) {
    opts = opts || {};
    showScreen('screen-setup');
    $('setup-cancel-wrap').hidden = !opts.cancellable;
    clear($('search-results'));
    setSetupMsg(null);
    $('q').value = '';
    renderBrowseRoot();
  }

  /**
   * Result rows. A village row commits the location (after confirmation); a
   * subdistrict row drills into its villages, which is what a user who typed a
   * kecamatan name actually wants.
   */
  function renderResults(items, best) {
    var box = $('search-results');
    clear(box);

    var villages = items.filter(function (x) { return x.level === 'village'; });
    var subs = items.filter(function (x) { return x.level === 'subdistrict'; });

    if (!villages.length && !subs.length) {
      box.appendChild(msgBox('banner--info', 'NOT_FOUND'));
      return;
    }

    // More than one candidate is the dangerous case — say so rather than
    // letting the user tap the first row out of habit.
    if (villages.length > 1) box.appendChild(msgBox('banner--info', 'AMBIGUOUS'));

    villages.forEach(function (v) {
      var isBest = best && v.code === best;
      var b = el('button', 'result' + (isBest ? ' result--best' : ''));
      b.type = 'button';
      b.appendChild(el('span', 'result__name', v.name));
      b.appendChild(el('span', 'result__path', v.full_path || ''));
      if (isBest) b.appendChild(el('span', 'result__badge', 'Paling cocok'));
      b.addEventListener('click', function () {
        commitLocation(v.code, v.full_path || v.name, null);
      });
      box.appendChild(b);
    });

    subs.forEach(function (s) {
      var b = el('button', 'result');
      b.type = 'button';
      b.appendChild(el('span', 'result__name', s.name + ' — telusuri desa'));
      b.appendChild(el('span', 'result__path', (s.full_path || '') + ' · pilih desa di dalamnya'));
      b.addEventListener('click', function () { openBrowseVillages(s.code, s.full_path || s.name); });
      box.appendChild(b);
    });
  }

  function wireSearch() {
    var input = $('q'), timer = null;
    input.addEventListener('input', function () {
      var q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { clear($('search-results')); return; }
      timer = setTimeout(function () {
        var mySeq = ++setupState.seq;
        wilayahSearch(q).then(function (items) {
          if (mySeq !== setupState.seq) return; // a newer keystroke won
          renderResults(items, null);
        }, function (e) {
          if (mySeq !== setupState.seq) return;
          var box = $('search-results');
          clear(box);
          box.appendChild(msgBox('banner--error', errOf(e)));
        });
      }, CFG.SEARCH_DEBOUNCE_MS);
    });
  }

  /* Browse: provinsi > kabupaten/kota > kecamatan > desa ------------------- */

  function browseShell(crumbText, backFn) {
    var box = $('browse');
    clear(box);
    if (crumbText) box.appendChild(el('p', 'browse__crumb', crumbText));
    if (backFn) {
      var back = el('button', 'btn btn--quiet browse__back', '← Kembali');
      back.type = 'button';
      back.addEventListener('click', backFn);
      box.appendChild(back);
    }
    return box;
  }

  function browseLoading(crumb, backFn) {
    browseShell(crumb, backFn).appendChild(el('p', 'hint', 'Memuat… / Loading'));
  }

  function browseError(crumb, backFn, e) {
    browseShell(crumb, backFn).appendChild(msgBox('banner--error', errOf(e)));
  }

  function browseRows(box, items, onPick) {
    if (!items.length) {
      box.appendChild(msgBox('banner--info', 'NOT_FOUND'));
      return;
    }
    items.forEach(function (it) {
      var b = el('button', 'result');
      b.type = 'button';
      b.appendChild(el('span', 'result__name', it.name));
      b.addEventListener('click', function () { onPick(it); });
      box.appendChild(b);
    });
  }

  function renderBrowseRoot() {
    browseLoading('Indonesia', null);
    fetchJSON(CFG.BMKG + '/v1/wilayah/provinces').then(function (r) {
      var items = (r.json && r.json.data) || [];
      var box = browseShell('Indonesia', null);
      browseRows(box, items, function (p) { openBrowseDistricts(p.code, p.name); });
    }, function (e) { browseError('Indonesia', null, e); });
  }

  function openBrowseDistricts(code, name) {
    browseLoading(name, renderBrowseRoot);
    wilayahList('districts', 'province', code).then(function (items) {
      var box = browseShell(name, renderBrowseRoot);
      browseRows(box, items, function (d) { openBrowseSubdistricts(d.code, name + ' > ' + d.name); });
    }, function (e) { browseError(name, renderBrowseRoot, e); });
  }

  function openBrowseSubdistricts(code, path) {
    var back = function () { openBrowseDistricts(code.split('.')[0], path.split(' > ')[0]); };
    browseLoading(path, back);
    wilayahList('subdistricts', 'district', code).then(function (items) {
      var box = browseShell(path, back);
      browseRows(box, items, function (s) { openBrowseVillages(s.code, path + ' > ' + s.name); });
    }, function (e) { browseError(path, back, e); });
  }

  function openBrowseVillages(code, path) {
    var parent = code.split('.').slice(0, 2).join('.');
    var back = function () { openBrowseSubdistricts(parent, path.split(' > ').slice(0, 2).join(' > ')); };
    browseLoading(path, back);
    wilayahList('villages', 'subdistrict', code).then(function (items) {
      var box = browseShell(path, back);
      browseRows(box, items, function (v) { commitLocation(v.code, path + ' > ' + v.name, null); });
      box.scrollIntoView({ block: 'nearest' });
    }, function (e) { browseError(path, back, e); });
  }

  /* Path (a): geolocation ------------------------------------------------- */

  function useGps() {
    setSetupMsg(el('p', 'hint', 'Meminta izin lokasi… / Requesting location…'));

    getPosition().then(function (pos) {
      setSetupMsg(el('p', 'hint', 'Mencari nama wilayah… / Resolving region…'));
      return reverseGeocode(pos.lat, pos.lon).then(function (place) {
        return wilayahSearch(place.village).then(function (items) {
          if (!items.length) throw new AppError('NOT_FOUND');

          // Village names repeat all over Indonesia, so a name match alone is
          // never enough. Rank by agreement with the geocoded city and
          // province, mark the best guess — and still make the user confirm it.
          var nCity = norm(place.city), nProv = norm(place.province);
          var scored = items.map(function (it) {
            var p = norm(it.full_path);
            var s = 0;
            if (nProv && p.indexOf(nProv) !== -1) s += 2;
            if (nCity && p.indexOf(nCity) !== -1) s += 3;
            if (it.level === 'village') s += 1;
            return { it: it, s: s };
          }).sort(function (a, b) { return b.s - a.s; });

          var top = scored[0];
          var best = (top && top.s >= 4 && top.it.level === 'village') ? top.it.code : null;

          setSetupMsg(msgBox('banner--info', 'AMBIGUOUS',
            'Terdeteksi: ' + place.village + (place.city ? ', ' + place.city : '') +
            '. Pastikan desa/kelurahan di bawah ini benar sebelum memilih.'));

          renderResults(scored.map(function (x) { return x.it; }), best);
          $('search-results').scrollIntoView({ block: 'nearest' });
        });
      });
    }).catch(function (e) {
      setSetupMsg(msgBox('banner--error', errOf(e)));
    });
  }

  /* Commit ---------------------------------------------------------------- */

  /**
   * Persist the confirmed location, then take the first reading. Coordinates
   * are captured here so the Open-Meteo fallback can work later without a
   * second setup round-trip; if BMKG is down at this moment the location is
   * still saved, and the app says plainly that the fallback is unavailable
   * until BMKG answers once.
   */
  function commitLocation(adm4, displayName, coords) {
    setSetupMsg(el('p', 'hint', 'Menyimpan lokasi… / Saving…'));

    var loc = {
      adm4: adm4,
      displayName: displayName,
      lat: coords ? coords.lat : null,
      lon: coords ? coords.lon : null,
      savedAt: Date.now()
    };

    sources.bmkgCurrentCoords(adm4).then(function (foundCoords) {
      loc.lat = foundCoords.lat;
      loc.lon = foundCoords.lon;
      store.set(CFG.KEY_LOC, loc);
      boot();
    }, function (e) {
      // Saving anyway is the right call: the school's location is a fact, and
      // a transient outage should not force the user through setup again.
      store.set(CFG.KEY_LOC, loc);
      boot();
      var area = $('banner-area');
      if (area) area.appendChild(msgBox('banner--error', errOf(e),
        'Lokasi tersimpan, tetapi data cuaca belum bisa diambil.'));
    });
  }

  /* ============================================================ READING UI == */

  function applyLevelVars(node, lv) {
    node.style.setProperty('--level-fill', lv.fill);
    node.style.setProperty('--level-fg', lv.fg);
  }

  function renderActions(idx) {
    var box = $('actions-list');
    clear(box);

    // Current level first, then every lower level in descending order —
    // present, grouped by name, and visually de-emphasised.
    var order = [];
    for (var i = idx; i >= 0; i--) order.push(i);

    order.forEach(function (i, pos) {
      var lv = LEVELS[i];
      var wrap = el('div', 'act ' + (pos === 0 ? 'act--current' : 'act--lower'));

      var head = el('div', 'act__head');
      head.style.setProperty('--act-fill', lv.fill);
      head.style.setProperty('--act-fg', lv.fg);
      var ico = el('span');
      ico.innerHTML = lv.icon; // static literal from LEVELS, never API data
      head.appendChild(ico);
      head.appendChild(document.createTextNode(
        lv.key + (pos === 0 ? ' — ' + lv.sub : '')));
      wrap.appendChild(head);

      var ul = el('ul', 'act__list');
      lv.actions.forEach(function (a) { ul.appendChild(el('li', null, a)); });
      wrap.appendChild(ul);
      box.appendChild(wrap);
    });
  }

  function renderStrip(reading, dayKey, nowMs, mark) {
    var strip = $('hour-strip');
    clear(strip);

    var todays = reading.entries.filter(function (e) { return e.dayKey === dayKey; });

    todays.forEach(function (e) {
      var lv = LEVELS[e.lv];
      var isMark = mark && e === mark.entry;
      var cell = el('div', 'slot' + (isMark ? (mark.isNow ? ' slot--now' : ' slot--next') : ''));
      cell.setAttribute('role', 'listitem');
      cell.appendChild(el('span', 'slot__hour', pad2(e.hour) + '.00'));

      var sw = el('span', 'slot__swatch');
      sw.style.setProperty('--slot-fill', lv.fill);
      sw.style.setProperty('--slot-fg', lv.fg);
      sw.appendChild(document.createTextNode(num(e.w, 1)));
      sw.appendChild(el('span', 'slot__code', lv.key));
      cell.appendChild(sw);

      cell.setAttribute('aria-label',
        pad2(e.hour) + ':00 — ' + lv.key + ' ' + lv.sub + ', ' + num(e.w, 1) + ' derajat sWBGT' +
        (isMark ? (mark.isNow ? ' (jam ini)' : ' (perkiraan terdekat)') : ''));
      strip.appendChild(cell);
    });

    if (mark && mark.entry) {
      // Put the marked slot in view. Assignment rather than smooth scrolling,
      // so there is nothing to suppress for prefers-reduced-motion.
      var i = todays.indexOf(mark.entry);
      if (i > -1) strip.scrollLeft = Math.max(0, (i - 1) * 50);
    }

    var note = reading.intervalHours === 3
      ? 'Interval 3 jam — BMKG hanya menyediakan jam yang belum lewat.'
      : 'Interval 1 jam — sumber cadangan Open-Meteo.';
    $('strip-note').textContent = note + ' Sumber: ' + SOURCE_LABEL[reading.source] + '.';
  }

  /** Data older than 24h: no level at all, just a plain statement. */
  function renderVoid(loc, reading) {
    showScreen('screen-reading');

    var block = $('level-block');
    block.className = 'level level--void';
    block.style.removeProperty('--level-fill');
    block.style.removeProperty('--level-fg');
    $('peak-kicker').textContent = 'TIDAK ADA TINGKAT SIAGA';
    clear($('level-icon'));
    $('level-name').textContent = 'DATA LAMA';
    $('level-sub').textContent = 'TIDAK BISA DIPAKAI';
    $('peak-value').textContent = '—';
    $('peak-time').textContent = 'Terakhir diperbarui ' + stampText(reading.fetchedAt);

    var area = $('banner-area');
    clear(area);
    area.appendChild(msgBox('banner--void', 'OFFLINE',
      'Data terakhir berumur lebih dari 24 jam, jadi tingkat siaga tidak ' +
      'ditampilkan. Jangan mengambil keputusan dari angka lama. Sambungkan ' +
      'internet lalu muat ulang.'));

    $('now-label').textContent = 'JAM INI';
    $('now-level-label').textContent = 'Tingkat jam ini';
    $('now-value').textContent = '—';
    $('now-temp').textContent = '—';
    $('now-rh').textContent = '—';
    var chip = $('now-level');
    chip.textContent = '—';
    chip.style.removeProperty('--chip-fill');
    chip.style.removeProperty('--chip-fg');

    clear($('hour-strip'));
    $('strip-note').textContent = 'Tidak ditampilkan — data terlalu lama.';
    clear($('actions-list'));

    $('loc-name').textContent = loc.displayName || loc.adm4;
    $('source-line').textContent = 'Sumber terakhir: ' + (SOURCE_LABEL[reading.source] || '—');
  }

  function stampText(ms) {
    var d = new Date(ms);
    try {
      return d.toLocaleString('id-ID', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
      });
    } catch (_) {
      return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' +
        pad2(d.getHours()) + '.' + pad2(d.getMinutes());
    }
  }

  function renderReading(loc, result) {
    var reading = result.reading;
    var nowMs = Date.now();
    var age = nowMs - (reading.fetchedAt || 0);

    // Past 24 hours old, stop showing a level entirely.
    if (age > CFG.MAX_AGE_MS) return renderVoid(loc, reading);

    showScreen('screen-reading');

    var off = reading.tzOffsetMin;
    var slotMs = reading.intervalHours * 3600000;
    var todayKey = dayKeyAt(nowMs, off);

    // The headline is the day's forecast PEAK: danger peaks in the early
    // afternoon, but people check the app in the morning. Only slots that have
    // not finished yet can still be acted on.
    var scope = reading.entries.filter(function (e) {
      return e.dayKey === todayKey && (e.at + slotMs) > nowMs;
    });
    var kicker = 'PUNCAK HARI INI';
    var scopeDay = todayKey;

    if (!scope.length) {
      // Today is exhausted (BMKG drops past slots, so this happens each night).
      // Roll over rather than showing nothing — tomorrow is what a teacher
      // planning the next school day needs.
      var tomKey = dayKeyAt(nowMs + 86400000, off);
      scope = reading.entries.filter(function (e) { return e.dayKey === tomKey; });
      kicker = 'PUNCAK BESOK';
      scopeDay = tomKey;
    }

    var peak = null;
    scope.forEach(function (e) { if (!peak || e.w > peak.w) peak = e; });

    /* The secondary number is "this hour" ONLY if a slot actually covers this
       instant. BMKG drops slots whose time has passed, so between the start of
       the dropped slot and the start of the next one — up to three hours, every
       day — nothing covers now. Presenting the next slot as "JAM INI" would put
       a future forecast under a present-tense label, so the label changes with
       the facts instead. */
    var current = null, currentIsNow = false;
    reading.entries.forEach(function (e) {
      if (e.at <= nowMs && nowMs < e.at + slotMs) { current = e; currentIsNow = true; }
    });
    if (!current) {
      for (var i = 0; i < reading.entries.length; i++) {
        if (reading.entries[i].at >= nowMs) { current = reading.entries[i]; break; }
      }
    }
    if (!current && reading.entries.length) current = reading.entries[reading.entries.length - 1];

    if (!peak && !current) {
      return renderProblem(loc, 'NO_DATA');
    }

    var headline = peak || current;
    var lv = LEVELS[headline.lv];

    var block = $('level-block');
    block.className = 'level' + (lv.key === 'PUTIH' ? ' level--needs-border' : '');
    applyLevelVars(block, lv);

    $('peak-kicker').textContent = peak ? kicker : (currentIsNow ? 'JAM INI' : 'PERKIRAAN TERDEKAT');
    var iconBox = $('level-icon');
    iconBox.innerHTML = lv.icon; // static literal
    $('level-name').textContent = lv.key;
    $('level-sub').textContent = lv.sub;
    $('peak-value').textContent = num(headline.w, 1);
    $('peak-time').textContent = peak
      ? 'Perkiraan tertinggi pukul ' + pad2(peak.hour) + '.00' +
        (kicker === 'PUNCAK BESOK' ? ' besok' : '')
      : 'Nilai jam berjalan';

    // Secondary: the current-hour value, labelled for what it actually is.
    if (current) {
      var clv = LEVELS[current.lv];
      $('now-label').textContent = currentIsNow
        ? 'JAM INI'
        : 'PERKIRAAN TERDEKAT · ' + pad2(current.hour) + '.00';
      $('now-level-label').textContent = currentIsNow
        ? 'Tingkat jam ini'
        : 'Tingkat pada jam tersebut';
      $('now-value').textContent = num(current.w, 1);
      $('now-temp').textContent = num(current.t, 0) + ' °C';
      $('now-rh').textContent = num(current.rh, 0) + ' %';
      var chip = $('now-level');
      chip.textContent = clv.key + ' · ' + clv.sub;
      chip.style.setProperty('--chip-fill', clv.fill);
      chip.style.setProperty('--chip-fg', clv.fg);
    }

    $('loc-name').textContent = loc.displayName || loc.adm4;
    $('source-line').textContent = 'Sumber: ' + SOURCE_LABEL[reading.source];

    document.querySelector('#screen-reading .h-sub').textContent =
      (kicker === 'PUNCAK BESOK') ? 'PERKIRAAN BESOK' : 'PERKIRAAN HARI INI';

    renderStrip(reading, scopeDay, nowMs,
      current ? { entry: current, isNow: currentIsNow } : null);

    // Actions follow the more severe of peak and current hour — the
    // conservative choice for a safety tool.
    renderActions(Math.max(headline.lv, current ? current.lv : 0));

    /* Banners --------------------------------------------------------- */
    var area = $('banner-area');
    clear(area);

    var isStale = result.stale || age > CFG.STALE_MS;
    if (isStale) {
      area.appendChild(msgBox('banner--stale', result.problem || 'OFFLINE',
        'DATA LAMA — terakhir diperbarui ' + stampText(reading.fetchedAt) +
        '. Angka ini belum tentu berlaku sekarang.'));
    }
    if (reading.degradedFrom) {
      area.appendChild(msgBox('banner--info', reading.degradedFrom,
        'Beralih otomatis ke sumber cadangan Open-Meteo.'));
    }
    if ((!isNum(loc.lat, -90, 90) || !isNum(loc.lon, -180, 180)) && !isStale) {
      area.appendChild(msgBox('banner--info', 'NO_COORDS'));
    }
  }

  function renderProblem(loc, code) {
    showScreen('screen-reading');
    var block = $('level-block');
    block.className = 'level level--void';
    $('peak-kicker').textContent = 'TIDAK ADA DATA';
    clear($('level-icon'));
    $('level-name').textContent = '—';
    $('level-sub').textContent = '';
    $('peak-value').textContent = '—';
    $('peak-time').textContent = '';

    var area = $('banner-area');
    clear(area);
    area.appendChild(msgBox('banner--error', code));

    clear($('hour-strip'));
    $('strip-note').textContent = '';
    clear($('actions-list'));
    $('loc-name').textContent = loc.displayName || loc.adm4;
    $('source-line').textContent = '';
  }

  /* ---------------------------------------------------------------- install */

  var deferredPrompt = null;

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      navigator.standalone === true;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      // iPadOS 13+ reports as a Mac; the touch check disambiguates.
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function renderInstall() {
    var area = $('install-area');
    if (!area) return;
    clear(area);
    if (isStandalone()) return; // already installed — nothing to suggest

    if (deferredPrompt) {
      var box = el('div', 'install');
      box.appendChild(el('p', 'install__title', 'Pasang di ponsel'));
      box.appendChild(el('p', 'install__body',
        'Buka lebih cepat dan tetap bisa dipakai tanpa internet.'));
      var b = el('button', 'btn btn--primary', 'Tambah ke Layar Utama');
      b.type = 'button';
      b.addEventListener('click', function () {
        var p = deferredPrompt;
        deferredPrompt = null;
        b.disabled = true;
        p.prompt();
        p.userChoice.then(function () { renderInstall(); });
      });
      box.appendChild(b);
      area.appendChild(box);
      return;
    }

    // iOS Safari never fires beforeinstallprompt, so it gets instructions.
    if (isIOS()) {
      var ib = el('div', 'install');
      ib.appendChild(el('p', 'install__title', 'Pasang di iPhone / iPad'));
      ib.appendChild(el('p', 'install__body',
        'Ketuk tombol Bagikan (Share) di Safari, lalu pilih “Add to Home Screen”.'));
      ib.appendChild(el('p', 'install__body',
        'Tap Share in Safari, then Add to Home Screen.'));
      area.appendChild(ib);
    }
  }

  /* ------------------------------------------------------------------- boot */

  function boot() {
    var loc = store.get(CFG.KEY_LOC);

    // A school does not move: with a saved location every launch goes straight
    // to the reading. Setup is a one-time event, not a per-load lookup.
    if (!loc || !loc.adm4) {
      renderSetup({ cancellable: false });
      return;
    }

    showScreen('screen-boot');

    load(loc).then(function (result) {
      renderReading(loc, result);
      renderInstall();
    }, function (e) {
      renderProblem(loc, errOf(e));
      renderInstall();
    });
  }

  function wire() {
    $('btn-use-gps').addEventListener('click', useGps);
    wireSearch();

    $('btn-setup-cancel').addEventListener('click', function () { boot(); });

    $('btn-change-loc').addEventListener('click', function () {
      renderSetup({ cancellable: true });
    });

    $('btn-refresh').addEventListener('click', function () { boot(); });

    $('btn-fatal-reload').addEventListener('click', function () { location.reload(); });
    $('btn-fatal-reset').addEventListener('click', function () {
      store.del(CFG.KEY_LOC);
      store.del(CFG.KEY_READING);
      location.reload();
    });

    // The supplied logo is optional. Without it the app still has a mark
    // rather than a broken image: three concentric orange-to-red arcs, the
    // same lockup the icons use.
    var logo = $('logo');
    function logoFallback() {
      if (!logo || !logo.parentNode) return;
      logo.parentNode.classList.add('lockup--fallback');
      var ph = document.createElement('span');
      ph.className = 'lockup__mark';
      ph.setAttribute('aria-hidden', 'true');
      ph.innerHTML =
        '<svg viewBox="0 0 40 40" width="40" height="40">' +
        '<rect width="40" height="40" rx="3" fill="#16160F"/>' +
        '<path d="M6 27a14 14 0 0 1 28 0" fill="none" stroke="#D91E18" stroke-width="4.4"/>' +
        '<path d="M11.5 27a8.5 8.5 0 0 1 17 0" fill="none" stroke="#F04E23" stroke-width="4.4"/>' +
        '<path d="M17 27a3 3 0 0 1 6 0" fill="none" stroke="#F5921E" stroke-width="4.4"/>' +
        '<rect x="6" y="29" width="28" height="3.2" fill="#FDFBEA"/></svg>';
      logo.parentNode.replaceChild(ph, logo);
    }
    logo.addEventListener('error', logoFallback);
    // The image request usually fails BEFORE this script runs, so the error
    // event has already been and gone. A finished-but-zero-width image is the
    // reliable signal that it failed; without this check the app shows a broken
    // image icon whenever assets/logo.svg has not been supplied yet.
    if (logo.complete && logo.naturalWidth === 0) logoFallback();

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      renderInstall();
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      renderInstall();
    });

    // Coming back online, or returning to a backgrounded tab, should refresh —
    // a heat reading goes out of date quickly.
    window.addEventListener('online', function () {
      if (!$('screen-reading').hidden) boot();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !$('screen-reading').hidden) {
        var r = store.get(CFG.KEY_READING);
        if (!r || Date.now() - (r.fetchedAt || 0) > CFG.STALE_MS) boot();
      }
    });
  }

  // Never let an unexpected exception leave a blank screen behind.
  function fatal(detail) {
    try {
      showScreen('screen-fatal');
      $('fatal-msg').textContent =
        'Terjadi kesalahan tak terduga. Coba muat ulang halaman.';
    } catch (_) { /* nothing left to do */ }
  }

  window.addEventListener('error', function (e) { fatal(e && e.message); });
  window.addEventListener('unhandledrejection', function (e) {
    fatal(e && e.reason && (e.reason.message || e.reason.code));
  });

  try {
    wire();
    boot();
  } catch (e) {
    fatal(e && e.message);
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {
        // No offline support, but the app itself keeps working.
      });
    });
  }
})();
