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
    SCHOOL_START_HOUR: 7,
    SCHOOL_END_HOUR: 17,

    KEY_LOC: 'ssp.location',
    KEY_READING: 'ssp.lastReading',
    KEY_LANG: 'ssp.language'
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

  function isSchoolHour(entry) {
    return entry.hour >= CFG.SCHOOL_START_HOUR &&
      entry.hour < CFG.SCHOOL_END_HOUR;
  }

  /* ------------------------------------------------------------------ levels */

  /**
   * PROVISIONAL bands, deliberately shifted upward for a humid tropical
   * climate. The standard US WBGT flag thresholds would read black on nearly
   * every Surabaya afternoon, which would train users to ignore the app. These
   * await calibration against local climatology and are NOT an official
   * standard — the UI says so in the footnote.
   *
   * The translated names and cumulative actions live in I18N below.
   */
  var LEVELS = [
    { key: 'PUTIH',  min: -Infinity, fill: '#FFFFFF', fg: '#000000' },
    { key: 'HIJAU',  min: 31.0,      fill: '#00B41E', fg: '#FFFFFF' },
    { key: 'KUNING', min: 32.5,      fill: '#FFF000', fg: '#000000' },
    { key: 'MERAH',  min: 34.0,      fill: '#ED1C24', fg: '#FFFFFF' },
    { key: 'HITAM',  min: 35.5,      fill: '#000000', fg: '#FFFFFF' }
  ];

  /* --------------------------------------------------------------- language */

  var language = 'id';
  var lastReadingView = null;

  var I18N = {
    id: {
      locale: 'id-ID',
      text: {
        skip: 'Lewati ke isi', languageLabel: 'Bahasa', loading: 'MEMUAT…',
        setupTitle: 'ATUR LOKASI SEKOLAH',
        setupIntro: 'Pilih desa atau kelurahan sekolah. Lokasi ini akan diingat.',
        useLocation: 'Gunakan lokasi saya', confirmLocation: 'Anda tetap memilih hasil yang benar.',
        or: 'ATAU', searchLabel: 'Cari desa / kelurahan', searchPlaceholder: 'Contoh: Gubeng',
        searchHint: 'Ketik minimal 2 huruf.', browseProvince: 'Telusuri lewat provinsi',
        cancel: 'Batal', back: '← Kembali', loadingShort: 'Memuat…',
        requestingLocation: 'Meminta izin lokasi…', resolvingRegion: 'Mencari nama wilayah…',
        savingLocation: 'Menyimpan lokasi…', bestMatch: 'Paling cocok',
        browseVillages: 'Telusuri desa di {name}', chooseVillage: 'Pilih desa di kecamatan ini',
        detected: 'Terdeteksi: {place}. Pastikan wilayah di bawah ini benar.',
        locationSavedNoWeather: 'Lokasi tersimpan, tetapi data cuaca belum bisa diambil.',
        peakToday: 'PERKIRAAN PUNCAK HARI INI', peakTomorrow: 'PERKIRAAN PUNCAK BESOK',
        currentHour: 'JAM INI', atTime: 'PUKUL {time}', temperature: 'SUHU',
        humidity: 'KELEMBAPAN', location: 'LOKASI', changeLocation: 'Ganti lokasi',
        forecastToday: 'PERKIRAAN HARI INI', forecastTomorrow: 'PERKIRAAN BESOK',
        actions: 'TINDAKAN', actionsIntro: 'Lakukan semua langkah berikut.',
        interval3: 'Prakiraan setiap 3 jam.', interval1: 'Prakiraan setiap 1 jam.',
        nowA11y: 'jam ini', nearestA11y: 'perkiraan terdekat',
        dangerTitle: 'LAPOR GURU SEKARANG', dangerIntro: 'Jika ada tanda bahaya panas:',
        danger1: 'Pusing, mual, sakit kepala', danger2: 'Kulit panas tapi tidak berkeringat',
        danger3: 'Bingung atau sangat lemas',
        dangerDo: 'Bawa ke UKS, pindahkan ke tempat teduh, beri air.',
        aboutCalculation: 'Tentang perhitungan',
        about1: 'Ambang level masih sementara, belum dikalibrasi terhadap klimatologi setempat, dan bukan standar resmi.',
        about2: 'sWBGT dihitung dari suhu dan kelembapan. Nilainya cenderung terlalu tinggi saat berawan, berangin, atau malam hari.',
        about3: 'Angka desimal sWBGT adalah hasil perhitungan, bukan ketelitian pengukuran.',
        weatherSource: 'Data cuaca: BMKG', fallbackSource: 'Cadangan: Open-Meteo',
        regionCodes: 'Kode wilayah: Permendagri 72/2019', refresh: 'Muat ulang data',
        fatalTitle: 'APLIKASI BERMASALAH', fatalBody: 'Terjadi kesalahan tak terduga. Coba muat ulang halaman.',
        reload: 'Muat ulang', resetLocation: 'Atur ulang lokasi',
        drink: 'MINUM', shade: 'TEDUH', report: 'LAPOR',
        meterTitle: 'Meter tingkat siaga panas',
        meterDesc: 'Jarum menunjukkan tingkat berdasarkan nilai puncak sWBGT.',
        noAlertLevel: 'TIDAK ADA TINGKAT SIAGA', dataTooOld: 'DATA TERLALU LAMA',
        lastUpdated: 'Terakhir diperbarui {time}', tooOldStrip: 'Tidak ditampilkan karena data terlalu lama.',
        noData: 'TIDAK ADA DATA', staleMessage: 'Data lama. Terakhir diperbarui {time}. Angka ini belum tentu berlaku sekarang.',
        fallbackMessage: 'Beralih otomatis ke Open-Meteo.',
        tooOldMessage: 'Data terakhir berumur lebih dari 24 jam. Tingkat siaga tidak ditampilkan. Sambungkan internet lalu muat ulang.',
        installTitle: 'Pasang di ponsel', installBody: 'Buka lebih cepat dan tetap bisa dipakai tanpa internet.',
        installButton: 'Tambah ke Layar Utama', iosInstallTitle: 'Pasang di iPhone atau iPad',
        iosInstallBody: 'Ketuk Bagikan di Safari, lalu pilih “Add to Home Screen”.'
      },
      levels: [
        { name: 'AMAN', actions: ['Anak bawa botol minum sendiri.', 'Guru ingatkan minum saat istirahat.'] },
        { name: 'SEDANG', actions: ['Minum tiap jam, guru yang mengingatkan.', 'Buka jendela dan nyalakan kipas.', 'Pakai topi saat olahraga dan istirahat.'] },
        { name: 'MENINGKAT', actions: ['Hindari olahraga berat pukul 11.00–15.00.', 'Bermain di tempat teduh saat istirahat.', 'Taruh botol minum di meja.'] },
        { name: 'RISIKO TINGGI', actions: ['Hentikan kegiatan luar ruang pukul 09.00–16.00.', 'Pindahkan olahraga ke jam pertama atau setelah 16.00.', 'Tutup gorden di sisi yang terkena matahari.'] },
        { name: 'RISIKO SANGAT TINGGI', actions: ['Olahraga luar ruang hanya sebelum 08.00.', 'Tiadakan upacara dan ekstrakurikuler luar ruang.', 'Minum tiap 20 menit dan siapkan UKS.'] }
      ],
      errors: {
        GEO_UNSUPPORTED: ['Perangkat tidak mendukung lokasi.', 'Gunakan pencarian manual.'],
        GEO_DENIED: ['Izin lokasi ditolak.', 'Cari desa atau kelurahan secara manual.'],
        GEO_UNAVAILABLE: ['Posisi tidak dapat ditentukan.', 'Coba lagi atau cari manual.'],
        GEO_TIMEOUT: ['Pencarian lokasi terlalu lama.', 'Coba lagi atau cari manual.'],
        GEOCODE_FAIL: ['Nama wilayah tidak ditemukan dari posisi Anda.', 'Silakan cari manual.'],
        NOT_FOUND: ['Wilayah tidak ditemukan.', 'Coba nama lain atau telusuri lewat provinsi.'],
        AMBIGUOUS: ['Ada beberapa wilayah dengan nama serupa.', 'Pilih wilayah yang benar.'],
        UNREACHABLE: ['Sumber cuaca tidak dapat dihubungi.', 'Coba lagi sebentar lagi.'],
        MALFORMED: ['Data cuaca tidak terbaca.', 'Coba muat ulang.'],
        RATE_LIMIT: ['Terlalu banyak permintaan.', 'Tunggu sebentar lalu coba lagi.'],
        NO_COORDS: ['Koordinat lokasi belum tersimpan.', 'Sumber cadangan belum dapat dipakai.'],
        OFFLINE: ['Tidak ada koneksi internet.', 'Data terakhir mungkin sudah lama.'],
        ALL_FAILED: ['Semua sumber cuaca gagal dihubungi.', 'Coba lagi saat internet tersedia.'],
        NO_DATA: ['Belum ada data cuaca untuk lokasi ini.', 'Coba wilayah terdekat.']
      }
    },
    jv: {
      locale: 'jv-ID',
      text: {
        skip: 'Langsung menyang isi', languageLabel: 'Basa', loading: 'NGLADHÈK…',
        setupTitle: 'ATUR PANGGONAN SEKOLAH',
        setupIntro: 'Pilih désa utawa kelurahan sekolah. Panggonan iki bakal dieling.',
        useLocation: 'Gunakna panggonanku', confirmLocation: 'Sampeyan tetep milih asil sing bener.',
        or: 'UTAWA', searchLabel: 'Goleki désa / kelurahan', searchPlaceholder: 'Tuladha: Gubeng',
        searchHint: 'Ketik paling ora 2 aksara.', browseProvince: 'Telusuri liwat provinsi',
        cancel: 'Batal', back: '← Bali', loadingShort: 'Ngundhuh…',
        requestingLocation: 'Nyuwun idin panggonan…', resolvingRegion: 'Nggoleki jeneng wilayah…',
        savingLocation: 'Nyimpen panggonan…', bestMatch: 'Paling cocog',
        browseVillages: 'Telusuri désa ing {name}', chooseVillage: 'Pilih désa ing kecamatan iki',
        detected: 'Katemokake: {place}. Pesthekake wilayah ing ngisor iki bener.',
        locationSavedNoWeather: 'Panggonan wis disimpen, nanging data cuaca durung bisa dijupuk.',
        peakToday: 'PUNCAK DIPRAKIRAKAKE DINA IKI', peakTomorrow: 'PUNCAK DIPRAKIRAKAKE SESUK',
        currentHour: 'SAIKI', atTime: 'JAM {time}', temperature: 'SUHU',
        humidity: 'KELEMBAPAN', location: 'PANGGONAN', changeLocation: 'Ganti panggonan',
        forecastToday: 'PRAKIRAAN DINA IKI', forecastTomorrow: 'PRAKIRAAN SESUK',
        actions: 'TINDAKAN', actionsIntro: 'Tindakna kabèh langkah iki.',
        interval3: 'Prakiraan saben 3 jam.', interval1: 'Prakiraan saben 1 jam.',
        nowA11y: 'saiki', nearestA11y: 'prakiraan paling cedhak',
        dangerTitle: 'LAPOR GURU SAIKI', dangerIntro: 'Yen ana tandha bebaya panas:',
        danger1: 'Mumet, mual, utawa sirah lara', danger2: 'Kulit panas nanging ora kringetan',
        danger3: 'Bingung utawa lemes banget',
        dangerDo: 'Gawa menyang UKS, pindhahna menyang panggonan sing ayom, lan wènèhana banyu.',
        aboutCalculation: 'Bab petungan',
        about1: 'Wates tingkat iki isih sementara, durung dikalibrasi karo iklim lokal, lan dudu standar resmi.',
        about2: 'sWBGT diitung saka suhu lan kelembapan. Nilai bisa kakehan nalika mendhung, ana angin, utawa wengi.',
        about3: 'Angka desimal sWBGT iku asil petungan, dudu ketelitian pangukuran.',
        weatherSource: 'Data cuaca: BMKG', fallbackSource: 'Cadangan: Open-Meteo',
        regionCodes: 'Kode wilayah: Permendagri 72/2019', refresh: 'Anyari data',
        fatalTitle: 'APLIKASI ANA MASALAH', fatalBody: 'Ana kaluputan sing ora dinyana. Coba bukak ulang kaca iki.',
        reload: 'Bukak ulang', resetLocation: 'Atur ulang panggonan',
        drink: 'NGOMBA', shade: 'AYOM', report: 'LAPOR',
        meterTitle: 'Meter tingkat siaga panas',
        meterDesc: 'Jarum nuduhake tingkat adhedhasar nilai puncak sWBGT.',
        noAlertLevel: 'ORA ANA TINGKAT SIAGA', dataTooOld: 'DATA KESELAREN',
        lastUpdated: 'Pungkasan dianyari {time}', tooOldStrip: 'Ora ditampilake amarga data wis kesuwen.',
        noData: 'ORA ANA DATA', staleMessage: 'Data lawas. Pungkasan dianyari {time}. Angka iki bisa wis ora trep.',
        fallbackMessage: 'Ngalih otomatis menyang Open-Meteo.',
        tooOldMessage: 'Data pungkasan wis luwih saka 24 jam. Tingkat siaga ora ditampilake. Sambungna internet banjur anyari.',
        installTitle: 'Pasang ing ponsel', installBody: 'Luwih cepet dibukak lan tetep bisa dienggo tanpa internet.',
        installButton: 'Tambah menyang Layar Ngarep', iosInstallTitle: 'Pasang ing iPhone utawa iPad',
        iosInstallBody: 'Tutul Bagikan ing Safari, banjur pilih “Add to Home Screen”.'
      },
      levels: [
        { name: 'AMAN', actions: ['Bocah nggawa botol ngombé dhéwé.', 'Guru ngélingaké ngombé nalika ngaso.'] },
        { name: 'SEDHENG', actions: ['Ngombé saben jam kanthi pangéling saka guru.', 'Bukak jendhéla lan uripna kipas.', 'Nganggo topi nalika olahraga lan ngaso.'] },
        { name: 'MUNDHAK', actions: ['Aja olahraga abot jam 11.00–15.00.', 'Dolanan ing panggonan ayom nalika ngaso.', 'Selehna botol ngombé ing méja.'] },
        { name: 'RISIKO DHUWUR', actions: ['Mandhegaké kegiatan njaba jam 09.00–16.00.', 'Pindhahna olahraga menyang jam kapisan utawa sawisé 16.00.', 'Tutup gordhèn ing sisih sing kena srengéngé.'] },
        { name: 'RISIKO DHUWUR BANGET', actions: ['Olahraga njaba mung sadurungé 08.00.', 'Ora ana upacara lan ekstrakurikuler njaba.', 'Ngombé saben 20 menit lan siapna UKS.'] }
      ],
      errors: {
        GEO_UNSUPPORTED: ['Piranti iki ora ndhukung panggonan.', 'Gunakna panelusuran manual.'],
        GEO_DENIED: ['Idin panggonan ditolak.', 'Goleki désa utawa kelurahan kanthi manual.'],
        GEO_UNAVAILABLE: ['Panggonan ora bisa ditemtokake.', 'Coba manèh utawa goleki manual.'],
        GEO_TIMEOUT: ['Panelusuran panggonan kelamaan.', 'Coba manèh utawa goleki manual.'],
        GEOCODE_FAIL: ['Jeneng wilayah ora ditemokake saka posisi sampeyan.', 'Mangga goleki manual.'],
        NOT_FOUND: ['Wilayah ora ditemokake.', 'Coba jeneng liya utawa telusuri liwat provinsi.'],
        AMBIGUOUS: ['Ana sawetara wilayah kanthi jeneng sing padha.', 'Pilih wilayah sing bener.'],
        UNREACHABLE: ['Sumber cuaca ora bisa dihubungi.', 'Coba manèh mengko.'],
        MALFORMED: ['Data cuaca ora bisa diwaca.', 'Coba anyari.'],
        RATE_LIMIT: ['Panjalukan kakehan.', 'Entèni sedhéla banjur coba manèh.'],
        NO_COORDS: ['Koordinat panggonan durung disimpen.', 'Sumber cadangan durung bisa dienggo.'],
        OFFLINE: ['Ora ana sambungan internet.', 'Data pungkasan bisa wis lawas.'],
        ALL_FAILED: ['Kabèh sumber cuaca ora bisa dihubungi.', 'Coba manèh nalika ana internet.'],
        NO_DATA: ['Durung ana data cuaca kanggo panggonan iki.', 'Coba wilayah cedhak.']
      }
    },
    en: {
      locale: 'en',
      text: {
        skip: 'Skip to content', languageLabel: 'Language', loading: 'LOADING…',
        setupTitle: 'SET SCHOOL LOCATION',
        setupIntro: 'Choose the school’s village or urban ward. This location will be remembered.',
        useLocation: 'Use my location', confirmLocation: 'You will still confirm the correct result.',
        or: 'OR', searchLabel: 'Search village / ward', searchPlaceholder: 'Example: Gubeng',
        searchHint: 'Type at least 2 letters.', browseProvince: 'Browse by province',
        cancel: 'Cancel', back: '← Back', loadingShort: 'Loading…',
        requestingLocation: 'Requesting location permission…', resolvingRegion: 'Finding your region…',
        savingLocation: 'Saving location…', bestMatch: 'Best match',
        browseVillages: 'Browse villages in {name}', chooseVillage: 'Choose a village in this subdistrict',
        detected: 'Detected: {place}. Confirm the correct region below.',
        locationSavedNoWeather: 'Location saved, but weather data is not available yet.',
        peakToday: 'TODAY’S FORECAST PEAK', peakTomorrow: 'TOMORROW’S FORECAST PEAK',
        currentHour: 'NOW', atTime: 'AT {time}', temperature: 'TEMPERATURE',
        humidity: 'HUMIDITY', location: 'LOCATION', changeLocation: 'Change location',
        forecastToday: 'TODAY’S FORECAST', forecastTomorrow: 'TOMORROW’S FORECAST',
        actions: 'ACTIONS', actionsIntro: 'Take all of the following steps.',
        interval3: 'Forecast every 3 hours.', interval1: 'Forecast every hour.',
        nowA11y: 'now', nearestA11y: 'nearest forecast',
        dangerTitle: 'TELL A TEACHER NOW', dangerIntro: 'If anyone shows signs of heat illness:',
        danger1: 'Dizziness, nausea, or headache', danger2: 'Hot skin without sweating',
        danger3: 'Confusion or severe weakness',
        dangerDo: 'Go to the school clinic, move into shade, and give water.',
        aboutCalculation: 'About this calculation',
        about1: 'These thresholds are provisional, not calibrated to local climate, and are not an official standard.',
        about2: 'sWBGT uses temperature and humidity. It can read too high when cloudy, windy, or at night.',
        about3: 'The decimal sWBGT value is calculated precision, not measurement precision.',
        weatherSource: 'Weather data: BMKG', fallbackSource: 'Fallback: Open-Meteo',
        regionCodes: 'Region codes: Permendagri 72/2019', refresh: 'Refresh data',
        fatalTitle: 'THE APP HAS A PROBLEM', fatalBody: 'Something unexpected happened. Reload the page.',
        reload: 'Reload', resetLocation: 'Reset location',
        drink: 'DRINK', shade: 'SHADE', report: 'REPORT',
        meterTitle: 'Heat alert meter',
        meterDesc: 'The needle shows the level based on the peak sWBGT value.',
        noAlertLevel: 'NO ALERT LEVEL', dataTooOld: 'DATA TOO OLD',
        lastUpdated: 'Last updated {time}', tooOldStrip: 'Hidden because the data is too old.',
        noData: 'NO DATA', staleMessage: 'Old data. Last updated {time}. It may no longer apply.',
        fallbackMessage: 'Automatically switched to Open-Meteo.',
        tooOldMessage: 'The latest data is over 24 hours old. No alert level is shown. Connect to the internet and refresh.',
        installTitle: 'Install on your phone', installBody: 'Open faster and keep using it without internet.',
        installButton: 'Add to Home Screen', iosInstallTitle: 'Install on iPhone or iPad',
        iosInstallBody: 'Tap Share in Safari, then choose “Add to Home Screen”.'
      },
      levels: [
        { name: 'SAFE', actions: ['Each student brings a water bottle.', 'Teachers remind students to drink during breaks.'] },
        { name: 'MODERATE', actions: ['Drink every hour with teacher reminders.', 'Open windows and turn on fans.', 'Wear a hat during sports and breaks.'] },
        { name: 'ELEVATED', actions: ['Avoid strenuous exercise from 11:00–15:00.', 'Play in the shade during breaks.', 'Keep water bottles on desks.'] },
        { name: 'HIGH RISK', actions: ['Stop outdoor activities from 09:00–16:00.', 'Move sports to first period or after 16:00.', 'Close curtains on the sunny side.'] },
        { name: 'VERY HIGH RISK', actions: ['Outdoor sports only before 08:00.', 'Cancel outdoor assemblies and extracurriculars.', 'Drink every 20 minutes and prepare the school clinic.'] }
      ],
      errors: {
        GEO_UNSUPPORTED: ['This device does not support location.', 'Use manual search.'],
        GEO_DENIED: ['Location permission was denied.', 'Search for the village or ward manually.'],
        GEO_UNAVAILABLE: ['Your position could not be determined.', 'Try again or search manually.'],
        GEO_TIMEOUT: ['The location request took too long.', 'Try again or search manually.'],
        GEOCODE_FAIL: ['No region name was found for your position.', 'Please search manually.'],
        NOT_FOUND: ['Region not found.', 'Try another name or browse by province.'],
        AMBIGUOUS: ['Several regions have a similar name.', 'Choose the correct region.'],
        UNREACHABLE: ['The weather source cannot be reached.', 'Try again shortly.'],
        MALFORMED: ['The weather data could not be read.', 'Refresh and try again.'],
        RATE_LIMIT: ['Too many requests.', 'Wait a moment and try again.'],
        NO_COORDS: ['Location coordinates have not been saved.', 'The fallback source is not available yet.'],
        OFFLINE: ['There is no internet connection.', 'The latest data may be old.'],
        ALL_FAILED: ['All weather sources failed.', 'Try again when internet is available.'],
        NO_DATA: ['No weather data is available for this location.', 'Try a nearby region.']
      }
    },
    zh: {
      locale: 'zh-CN',
      text: {
        skip: '跳到主要内容', languageLabel: '语言', loading: '加载中…',
        setupTitle: '设置学校位置',
        setupIntro: '请选择学校所在的村或社区。系统会记住此位置。',
        useLocation: '使用我的位置', confirmLocation: '您仍需确认正确的搜索结果。',
        or: '或', searchLabel: '搜索村或社区', searchPlaceholder: '例如：Gubeng',
        searchHint: '请至少输入两个字符。', browseProvince: '按省份浏览',
        cancel: '取消', back: '← 返回', loadingShort: '加载中…',
        requestingLocation: '正在请求位置权限…', resolvingRegion: '正在查找所在地区…',
        savingLocation: '正在保存位置…', bestMatch: '最匹配',
        browseVillages: '浏览{name}的村或社区', chooseVillage: '选择此区内的村或社区',
        detected: '检测到：{place}。请确认下面的地区是否正确。',
        locationSavedNoWeather: '位置已保存，但暂时无法获取天气数据。',
        peakToday: '预计今日最高风险', peakTomorrow: '预计明日最高风险',
        currentHour: '当前', atTime: '{time}', temperature: '温度',
        humidity: '湿度', location: '位置', changeLocation: '更改位置',
        forecastToday: '今日预报', forecastTomorrow: '明日预报',
        actions: '应对措施', actionsIntro: '请执行以下所有措施。',
        interval3: '每3小时一条预报。', interval1: '每小时一条预报。',
        nowA11y: '当前', nearestA11y: '最近一条预报',
        dangerTitle: '立即告知老师', dangerIntro: '如果有人出现中暑迹象：',
        danger1: '头晕、恶心或头痛', danger2: '皮肤发热但不出汗',
        danger3: '意识混乱或极度虚弱',
        dangerDo: '前往校医室，转移到阴凉处，并补充饮水。',
        aboutCalculation: '关于计算方法',
        about1: '这些分级阈值仍是临时标准，尚未按当地气候校准，也不是官方标准。',
        about2: 'sWBGT仅使用温度和湿度计算。在阴天、有风或夜间，数值可能偏高。',
        about3: 'sWBGT的小数位来自计算，并不代表测量精度。',
        weatherSource: '天气数据：BMKG', fallbackSource: '备用来源：Open-Meteo',
        regionCodes: '地区代码：Permendagri 72/2019', refresh: '刷新数据',
        fatalTitle: '应用发生问题', fatalBody: '发生意外错误，请重新加载页面。',
        reload: '重新加载', resetLocation: '重置位置',
        drink: '喝水', shade: '阴凉处', report: '报告',
        meterTitle: '高温警戒仪表',
        meterDesc: '指针根据最高sWBGT值显示警戒等级。',
        noAlertLevel: '无警戒等级', dataTooOld: '数据过旧',
        lastUpdated: '上次更新：{time}', tooOldStrip: '数据过旧，已隐藏。',
        noData: '暂无数据', staleMessage: '数据较旧。上次更新：{time}。当前情况可能已经变化。',
        fallbackMessage: '已自动切换到Open-Meteo。',
        tooOldMessage: '最新数据已超过24小时，因此不显示警戒等级。请连接互联网并刷新。',
        installTitle: '安装到手机', installBody: '打开更快，离线时仍可使用。',
        installButton: '添加到主屏幕', iosInstallTitle: '安装到iPhone或iPad',
        iosInstallBody: '在Safari中点按“分享”，然后选择“添加到主屏幕”。'
      },
      levels: [
        { name: '安全', actions: ['每名学生自带水瓶。', '老师在课间提醒学生喝水。'] },
        { name: '中等', actions: ['每小时喝水，并由老师提醒。', '打开窗户和风扇。', '运动和课间活动时戴帽子。'] },
        { name: '升高', actions: ['11:00至15:00避免剧烈运动。', '课间在阴凉处活动。', '把水瓶放在桌上。'] },
        { name: '高风险', actions: ['09:00至16:00停止户外活动。', '将体育课改到第一节或16:00以后。', '拉上向阳一侧的窗帘。'] },
        { name: '极高风险', actions: ['户外运动仅限08:00以前。', '取消户外集会和课外活动。', '每20分钟喝水，并准备好校医室。'] }
      ],
      errors: {
        GEO_UNSUPPORTED: ['此设备不支持定位。', '请使用手动搜索。'],
        GEO_DENIED: ['位置权限被拒绝。', '请手动搜索村或社区。'],
        GEO_UNAVAILABLE: ['无法确定您的位置。', '请重试或手动搜索。'],
        GEO_TIMEOUT: ['位置请求超时。', '请重试或手动搜索。'],
        GEOCODE_FAIL: ['无法根据位置找到地区名称。', '请手动搜索。'],
        NOT_FOUND: ['未找到地区。', '请尝试其他名称或按省份浏览。'],
        AMBIGUOUS: ['有多个名称相近的地区。', '请选择正确的地区。'],
        UNREACHABLE: ['无法连接天气数据源。', '请稍后重试。'],
        MALFORMED: ['无法读取天气数据。', '请刷新后重试。'],
        RATE_LIMIT: ['请求过多。', '请稍候再试。'],
        NO_COORDS: ['尚未保存位置坐标。', '暂时无法使用备用数据源。'],
        OFFLINE: ['当前没有网络连接。', '最新数据可能已经过时。'],
        ALL_FAILED: ['所有天气数据源均不可用。', '请在网络恢复后重试。'],
        NO_DATA: ['此位置暂无天气数据。', '请尝试附近地区。']
      }
    }
  };

  function langPack() { return I18N[language] || I18N.id; }

  function t(key, vars) {
    var value = langPack().text[key];
    if (value == null) value = I18N.id.text[key] || key;
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        value = value.replace(new RegExp('\\{' + name + '\\}', 'g'), vars[name]);
      });
    }
    return value;
  }

  function translatedLevel(i) {
    return langPack().levels[i] || I18N.id.levels[i];
  }

  function translatedError(code) {
    return langPack().errors[code] || I18N.id.errors[code] || [code, ''];
  }

  function applyStaticLanguage() {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : language;
    document.title = language === 'en' ? 'Heat-Ready Schools' : 'Sekolah Siaga Panas';
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (node) {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-i18n-placeholder]'), function (node) {
      node.setAttribute('placeholder', t(node.getAttribute('data-i18n-placeholder')));
    });
    var select = $('language-selector');
    if (select) {
      select.value = language;
      select.setAttribute('aria-label', t('languageLabel'));
    }
    $('meter-title').textContent = t('meterTitle');
    $('meter-desc').textContent = t('meterDesc');
  }

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

  // Use the selected language's number formatting.
  function num(v, dp) {
    if (v == null || !isFinite(v)) return '—';
    dp = dp == null ? 1 : dp;
    try {
      return v.toLocaleString(langPack().locale, {
        minimumFractionDigits: dp,
        maximumFractionDigits: dp
      });
    } catch (_) {
      return (language === 'id' || language === 'jv')
        ? v.toFixed(dp).replace('.', ',')
        : v.toFixed(dp);
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
    bmkg: 'BMKG',
    openmeteo: 'Open-Meteo'
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
    var m = translatedError(code);
    var box = el('div', 'banner ' + cls);
    box.appendChild(el('p', 'banner__title', m[0]));
    var body = el('p', 'banner__body');
    if (m[1] || extra) body.appendChild(document.createTextNode(extra || m[1]));
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
      if (isBest) b.appendChild(el('span', 'result__badge', t('bestMatch')));
      b.addEventListener('click', function () {
        commitLocation(v.code, v.full_path || v.name, null);
      });
      box.appendChild(b);
    });

    subs.forEach(function (s) {
      var b = el('button', 'result');
      b.type = 'button';
      b.appendChild(el('span', 'result__name', t('browseVillages', { name: s.name })));
      b.appendChild(el('span', 'result__path', s.full_path || t('chooseVillage')));
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
      var back = el('button', 'btn btn--quiet browse__back', t('back'));
      back.type = 'button';
      back.addEventListener('click', backFn);
      box.appendChild(back);
    }
    return box;
  }

  function browseLoading(crumb, backFn) {
    browseShell(crumb, backFn).appendChild(el('p', 'hint', t('loadingShort')));
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
    setSetupMsg(el('p', 'hint', t('requestingLocation')));

    getPosition().then(function (pos) {
      setSetupMsg(el('p', 'hint', t('resolvingRegion')));
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

          setSetupMsg(msgBox('banner--info', 'AMBIGUOUS', t('detected', {
            place: place.village + (place.city ? ', ' + place.city : '')
          })));

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
    setSetupMsg(el('p', 'hint', t('savingLocation')));

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
        t('locationSavedNoWeather')));
    });
  }

  /* ============================================================ READING UI == */

  function setMeter(value) {
    var meter = $('heat-meter');
    if (!meter) return;
    if (!isFinite(value)) {
      meter.hidden = true;
      return;
    }
    meter.hidden = false;
    // The visible scale spans 29.5–37.0 °C, with the four provisional
    // thresholds (31.0, 32.5, 34.0, 35.5) dividing five equal bands.
    var clamped = Math.max(29.5, Math.min(37.0, value));
    var angle = -180 + ((clamped - 29.5) / 7.5) * 180;
    $('meter-needle').setAttribute('transform',
      'rotate(' + angle.toFixed(1) + ' 160 150)');
  }

  function renderActions(idx) {
    var box = $('actions-list');
    clear(box);

    // One checklist is easier to scan than repeating a coloured header for
    // every cumulative level. The headline already communicates the risk.
    var ul = el('ul', 'act__list act__list--flat');
    for (var i = 0; i <= idx; i++) {
      translatedLevel(i).actions.forEach(function (a) {
        ul.appendChild(el('li', null, a));
      });
    }
    box.appendChild(ul);
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
      cell.appendChild(sw);

      cell.setAttribute('aria-label',
        pad2(e.hour) + ':00, ' + translatedLevel(e.lv).name + ', ' +
        num(e.w, 1) + ' °C sWBGT' +
        (isMark ? ' (' + (mark.isNow ? t('nowA11y') : t('nearestA11y')) + ')' : ''));
      strip.appendChild(cell);
    });

    if (mark && mark.entry) {
      // Put the marked slot in view. Assignment rather than smooth scrolling,
      // so there is nothing to suppress for prefers-reduced-motion.
      var i = todays.indexOf(mark.entry);
      if (i > -1) strip.scrollLeft = Math.max(0, (i - 1) * 50);
    }

    $('strip-note').textContent = reading.intervalHours === 3 ? t('interval3') : t('interval1');
  }

  /** Data older than 24h: no level at all, just a plain statement. */
  function renderVoid(loc, reading) {
    lastReadingView = { loc: loc, result: { reading: reading, stale: true, problem: 'OFFLINE' } };
    showScreen('screen-reading');

    var block = $('level-block');
    block.className = 'level level--void level--compact';
    setMeter(null);
    $('peak-kicker').textContent = t('noAlertLevel');
    $('level-name').textContent = t('dataTooOld');
    $('peak-value').textContent = '—';

    var area = $('banner-area');
    clear(area);
    area.appendChild(msgBox('banner--void', 'OFFLINE', t('tooOldMessage')));

    $('now-label').textContent = t('currentHour');
    $('now-value').textContent = '—';
    $('now-temp').textContent = '—';
    $('now-rh').textContent = '—';
    $('current-block').hidden = true;

    clear($('hour-strip'));
    $('strip-note').textContent = t('tooOldStrip');
    clear($('actions-list'));

    $('loc-name').textContent = loc.displayName || loc.adm4;
    $('source-line').textContent = SOURCE_LABEL[reading.source] || '—';
  }

  function stampText(ms) {
    var d = new Date(ms);
    try {
      return d.toLocaleString(langPack().locale, {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
      });
    } catch (_) {
      return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' +
        pad2(d.getHours()) + '.' + pad2(d.getMinutes());
    }
  }

  function renderReading(loc, result) {
    lastReadingView = { loc: loc, result: result };
    var reading = result.reading;
    var nowMs = Date.now();
    var age = nowMs - (reading.fetchedAt || 0);

    // Past 24 hours old, stop showing a level entirely.
    if (age > CFG.MAX_AGE_MS) return renderVoid(loc, reading);

    showScreen('screen-reading');

    var off = reading.tzOffsetMin;
    var slotMs = reading.intervalHours * 3600000;
    var todayKey = dayKeyAt(nowMs, off);

    // The headline is the remaining SCHOOL-DAY forecast peak. Night-time
    // humidity can produce a high sWBGT even after the daytime temperature peak,
    // but an evening slot is not useful as a school heat-action headline.
    var scope = reading.entries.filter(function (e) {
      return e.dayKey === todayKey && isSchoolHour(e) &&
        (e.at + slotMs) > nowMs;
    });
    var peakKey = 'peakToday';
    var isTomorrow = false;
    var scopeDay = todayKey;

    if (!scope.length) {
      // Today is exhausted (BMKG drops past slots, so this happens each night).
      // Roll over rather than showing nothing — tomorrow is what a teacher
      // planning the next school day needs.
      var tomKey = dayKeyAt(nowMs + 86400000, off);
      scope = reading.entries.filter(function (e) {
        return e.dayKey === tomKey && isSchoolHour(e);
      });
      peakKey = 'peakTomorrow';
      isTomorrow = true;
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
    var translated = translatedLevel(headline.lv);

    var block = $('level-block');
    block.className = 'level' + (translated.name.length > 12 ? ' level--compact' : '');
    setMeter(headline.w);

    $('peak-kicker').textContent = peak
      ? t(peakKey)
      : (currentIsNow ? t('currentHour') : t('nearestA11y'));
    $('level-name').textContent = translated.name;
    $('peak-value').textContent = num(headline.w, 1);

    // Secondary: the current-hour value, labelled for what it actually is.
    $('current-block').hidden = !current || current === headline;
    if (current && current !== headline) {
      $('now-label').textContent = currentIsNow
        ? t('currentHour')
        : t('atTime', { time: pad2(current.hour) + '.00' });
      $('now-value').textContent = num(current.w, 1);
      $('now-temp').textContent = num(current.t, 0) + ' °C';
      $('now-rh').textContent = num(current.rh, 0) + ' %';
    }

    $('loc-name').textContent = loc.displayName || loc.adm4;
    $('source-line').textContent = SOURCE_LABEL[reading.source];

    $('forecast-heading').textContent = t(isTomorrow ? 'forecastTomorrow' : 'forecastToday');

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
        t('staleMessage', { time: stampText(reading.fetchedAt) })));
    }
    if (reading.degradedFrom) {
      area.appendChild(msgBox('banner--info', reading.degradedFrom,
        t('fallbackMessage')));
    }
    if ((!isNum(loc.lat, -90, 90) || !isNum(loc.lon, -180, 180)) && !isStale) {
      area.appendChild(msgBox('banner--info', 'NO_COORDS'));
    }
  }

  function renderProblem(loc, code) {
    lastReadingView = null;
    showScreen('screen-reading');
    var block = $('level-block');
    block.className = 'level level--void';
    $('current-block').hidden = true;
    $('peak-kicker').textContent = t('noData');
    setMeter(null);
    $('level-name').textContent = '—';
    $('peak-value').textContent = '—';

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
      box.appendChild(el('p', 'install__title', t('installTitle')));
      box.appendChild(el('p', 'install__body', t('installBody')));
      var b = el('button', 'btn btn--primary', t('installButton'));
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
      ib.appendChild(el('p', 'install__title', t('iosInstallTitle')));
      ib.appendChild(el('p', 'install__body', t('iosInstallBody')));
      area.appendChild(ib);
    }
  }

  function changeLanguage(next) {
    if (!I18N[next]) return;
    language = next;
    store.set(CFG.KEY_LANG, language);
    applyStaticLanguage();

    if (!$('screen-reading').hidden) {
      if (lastReadingView) {
        renderReading(lastReadingView.loc, lastReadingView.result);
      } else {
        boot();
      }
      renderInstall();
    } else if (!$('screen-setup').hidden) {
      renderSetup({ cancellable: !$('setup-cancel-wrap').hidden });
    } else if (!$('screen-fatal').hidden) {
      $('fatal-msg').textContent = t('fatalBody');
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
    $('language-selector').addEventListener('change', function (e) {
      changeLanguage(e.target.value);
    });
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
      $('fatal-msg').textContent = t('fatalBody');
    } catch (_) { /* nothing left to do */ }
  }

  window.addEventListener('error', function (e) { fatal(e && e.message); });
  window.addEventListener('unhandledrejection', function (e) {
    fatal(e && e.reason && (e.reason.message || e.reason.code));
  });

  try {
    var savedLanguage = store.get(CFG.KEY_LANG);
    if (I18N[savedLanguage]) language = savedLanguage;
    applyStaticLanguage();
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
