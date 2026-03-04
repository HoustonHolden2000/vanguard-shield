/* ═══════════════════════════════════════════════════════════════
   Iron Halo — Vanguard Shield Scanner (DEBUG BUILD)
   Client-side Dynamsoft PDF417 decode → /api/scans
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── State ──
  var authToken = null;
  var cvRouter = null;
  var codeParser = null;
  var engineReady = false;
  var engineInitError = null;
  var capturedBlob = null;

  // ── Debug state ──
  var lastRawResult = null;
  var lastRawBarcodeText = null;
  var lastRawParserJSON = null;

  // ── DOM refs ──
  var $ = function (id) { return document.getElementById(id); };

  // ── Field definitions ──
  var FIELDS = [
    { key: 'first_name',  label: 'First Name',  type: 'text' },
    { key: 'last_name',   label: 'Last Name',   type: 'text' },
    { key: 'middle_name', label: 'Middle Name',  type: 'text' },
    { key: 'dl_number',   label: 'DL Number',    type: 'text' },
    { key: 'dob',         label: 'Date of Birth', type: 'text', placeholder: 'MM/DD/YYYY' },
    { key: 'expiration',  label: 'Expiration',    type: 'text', placeholder: 'MM/DD/YYYY' },
    { key: 'address',     label: 'Address',       type: 'text' },
    { key: 'city',        label: 'City',          type: 'text' },
    { key: 'state',       label: 'State',         type: 'text', placeholder: 'XX' },
    { key: 'postal_code', label: 'ZIP',           type: 'text' },
    { key: 'sex',         label: 'Sex',           type: 'text', placeholder: 'M / F' }
  ];

  /* ================================================================
     1. DYNAMSOFT INIT — runs once on page load
     ================================================================ */
  async function initEngine() {
    var banner = $('init-banner');
    banner.classList.add('show');
    try {
      console.log('[Halo] initEngine: Dynamsoft global exists:', typeof Dynamsoft !== 'undefined');
      if (typeof Dynamsoft !== 'undefined') {
        console.log('[Halo] initEngine: License:', typeof Dynamsoft.License);
        console.log('[Halo] initEngine: Core:', typeof Dynamsoft.Core);
        console.log('[Halo] initEngine: CVR:', typeof Dynamsoft.CVR);
        console.log('[Halo] initEngine: DCP:', typeof Dynamsoft.DCP);
      }

      console.log('[Halo] Calling initLicense...');
      Dynamsoft.License.LicenseManager.initLicense(
        'DLS2eyJoYW5kc2hha2VDb2RlIjoiMTA1MjUzODIxLU1UQTFNalV6T0RJeExYZGxZaTFVY21saGJGQnliMm8iLCJtYWluU2VydmVyVVJMIjoiaHR0cHM6Ly9tZGxzLmR5bmFtc29mdG9ubGluZS5jb20vIiwib3JnYW5pemF0aW9uSUQiOiIxMDUyNTM4MjEiLCJzdGFuZGJ5U2VydmVyVVJMIjoiaHR0cHM6Ly9zZGxzLmR5bmFtc29mdG9ubGluZS5jb20vIiwiY2hlY2tDb2RlIjotMTcyMDI3MzcyOX0='
      );
      console.log('[Halo] License set OK');

      console.log('[Halo] Loading WASM [DBR, DCP]...');
      await Dynamsoft.Core.CoreModule.loadWasm(['DBR', 'DCP']);
      console.log('[Halo] WASM loaded OK');

      console.log('[Halo] Loading AAMVA_DL_ID spec...');
      await Dynamsoft.DCP.CodeParserModule.loadSpec('AAMVA_DL_ID');
      console.log('[Halo] AAMVA spec loaded OK');

      console.log('[Halo] Creating CaptureVisionRouter...');
      cvRouter = await Dynamsoft.CVR.CaptureVisionRouter.createInstance();
      console.log('[Halo] cvRouter created:', !!cvRouter);

      console.log('[Halo] Creating CodeParser...');
      codeParser = await Dynamsoft.DCP.CodeParser.createInstance();
      console.log('[Halo] codeParser created:', !!codeParser);

      engineReady = true;
      console.log('[Halo] ENGINE READY');
    } catch (err) {
      engineInitError = err;
      console.error('[Halo] ENGINE INIT FAILED:', err.message || err);
      console.error('[Halo] Stack:', err.stack || '(none)');
    }
    banner.classList.remove('show');
  }

  initEngine();

  /* ================================================================
     2. SCREEN NAVIGATION
     ================================================================ */
  window.showScreen = function (id) {
    document.querySelectorAll('.screen').forEach(function (s) {
      s.classList.remove('active');
    });
    $(id).classList.add('active');
  };

  /* ================================================================
     3. LOGIN
     ================================================================ */
  $('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var user = $('login-user').value.trim();
    var pass = $('login-pass').value;
    $('login-error').textContent = '';

    try {
      var res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      authToken = data.token;
      showScreen('scan-screen');
    } catch (err) {
      $('login-error').textContent = err.message;
    }
  });

  $('btn-logout').addEventListener('click', function () {
    authToken = null;
    $('login-user').value = '';
    $('login-pass').value = '';
    showScreen('login-screen');
  });

  /* ================================================================
     4. SCAN BUTTON → CAMERA → DECODE
     ================================================================ */
  $('btn-scan').addEventListener('click', function () {
    console.log('[Halo] Scan tapped. engineReady=' + engineReady + ' cvRouter=' + !!cvRouter + ' codeParser=' + !!codeParser);
    if (engineInitError) console.error('[Halo] Engine had init error:', engineInitError.message);
    if (!engineReady) {
      showToast('Barcode engine still loading. Wait a moment and try again.');
      return;
    }
    capturedBlob = null;
    $('cam-input').value = '';
    $('cam-input').click();
  });

  $('cam-input').addEventListener('change', async function () {
    var file = this.files && this.files[0];
    if (!file) return;

    capturedBlob = file;
    console.log('[Halo] ═══ SCAN START ═══');
    console.log('[Halo] File: type=' + file.type + ' size=' + file.size + ' bytes');
    showOverlay('Decoding barcode\u2026');

    try {
      var img = await fileToImage(file);
      var canvas = imageToCanvas(img);
      console.log('[Halo] Photo resolution: ' + canvas.width + ' x ' + canvas.height);

      var parsed = await decodeAndParse(canvas);

      hideOverlay();
      greenFlash();
      if (navigator.vibrate) navigator.vibrate(80);
      console.log('[Halo] ═══ SCAN SUCCESS ═══');
      console.log('[Halo] Parsed fields:', JSON.stringify(parsed, null, 2));
      showConfirmScreen(parsed);
    } catch (err) {
      hideOverlay();
      var debugMsg = 'DEBUG: ' + (err.message || String(err));
      console.error('[Halo] ═══ SCAN FAILED ═══');
      console.error('[Halo] ' + debugMsg);
      if (err.stack) console.error('[Halo] Stack:', err.stack);
      showToast('Could not read barcode. Try again or use Manual Entry.');
      showDebugLine(debugMsg);
    }
  });

  /* ================================================================
     5. DECODE + PARSE (Dynamsoft v11) — FULLY INSTRUMENTED
     ================================================================ */
  async function decodeAndParse(canvas) {
    lastRawResult = null;
    lastRawBarcodeText = null;
    lastRawParserJSON = null;

    if (!cvRouter) throw new Error('cvRouter is null — engine never initialized');
    if (!codeParser) throw new Error('codeParser is null — engine never initialized');
    if (engineInitError) throw new Error('Engine init error: ' + (engineInitError.message || engineInitError));

    // Pass 1: Balance
    console.log('[Halo] Pass 1: ReadBarcodes_Balance...');
    var t0 = performance.now();
    var result = await cvRouter.capture(canvas, 'ReadBarcodes_Balance');
    var t1 = performance.now();
    var pass1Count = (result.items || []).length;
    console.log('[Halo] Pass 1: ' + pass1Count + ' items in ' + Math.round(t1 - t0) + 'ms');
    logItems(result);

    // Pass 2: ReadRateFirst fallback
    if (!result.items || result.items.length === 0) {
      console.log('[Halo] Pass 2: ReadBarcodes_ReadRateFirst...');
      var t2 = performance.now();
      result = await cvRouter.capture(canvas, 'ReadBarcodes_ReadRateFirst');
      var t3 = performance.now();
      console.log('[Halo] Pass 2: ' + (result.items || []).length + ' items in ' + Math.round(t3 - t2) + 'ms');
      logItems(result);
    }

    lastRawResult = result;
    var totalItems = (result.items || []).length;
    var totalMs = Math.round(performance.now() - t0);
    console.log('[Halo] Total: ' + totalItems + ' items, ' + totalMs + 'ms');

    // Find barcode item (type=2)
    var barcodeItem = null;
    for (var i = 0; i < (result.items || []).length; i++) {
      if (result.items[i].type === 2) { barcodeItem = result.items[i]; break; }
    }

    if (!barcodeItem) {
      var types = (result.items || []).map(function (it) { return 'type=' + it.type; }).join(', ');
      throw new Error('0 PDF417 barcodes. ' + totalItems + ' items [' + types + '] in ' + totalMs + 'ms');
    }

    // Dump raw barcode text
    try {
      lastRawBarcodeText = barcodeItem.text || new TextDecoder().decode(new Uint8Array(barcodeItem.bytes));
    } catch (e) {
      lastRawBarcodeText = '(could not read bytes)';
    }
    console.log('[Halo] Barcode text (' + (barcodeItem.bytes ? barcodeItem.bytes.length : 0) + ' bytes):');
    console.log(lastRawBarcodeText);

    // Parse with CodeParser
    console.log('[Halo] Calling CodeParser.parse()...');
    var parsedResult;
    try {
      parsedResult = await codeParser.parse(barcodeItem.bytes);
    } catch (parseErr) {
      console.error('[Halo] CodeParser.parse() threw:', parseErr.message || parseErr);
      throw new Error('Barcode decoded but CodeParser failed: ' + (parseErr.message || parseErr));
    }

    var dlInfo;
    try {
      dlInfo = JSON.parse(parsedResult.jsonString);
    } catch (jsonErr) {
      console.error('[Halo] jsonString not valid JSON:', parsedResult.jsonString);
      throw new Error('CodeParser returned bad JSON: ' + (jsonErr.message || jsonErr));
    }

    lastRawParserJSON = dlInfo;
    console.log('[Halo] CodeParser JSON:', JSON.stringify(dlInfo, null, 2));

    return mapAAMVA(dlInfo);
  }

  function logItems(result) {
    (result.items || []).forEach(function (it, idx) {
      var info = '  item[' + idx + '] type=' + it.type;
      if (it.formatString) info += ' format=' + it.formatString;
      if (it.text) info += ' text=' + it.text.substring(0, 80) + (it.text.length > 80 ? '...' : '');
      console.log('[Halo] ' + info);
    });
  }

  function mapAAMVA(dlInfo) {
    var src = dlInfo.CodeParserResult || dlInfo.ResultInfo || dlInfo;
    return {
      first_name:  src.firstName   || src.givenName        || dlInfo.firstName   || dlInfo.givenName        || '',
      last_name:   src.lastName    || dlInfo.lastName       || '',
      middle_name: src.middleName  || dlInfo.middleName     || '',
      dl_number:   src.licenseNumber || src.customerIdentifier || dlInfo.licenseNumber || dlInfo.customerIdentifier || '',
      dob:         formatDate(src.birthDate      || dlInfo.birthDate      || ''),
      expiration:  formatDate(src.expirationDate  || dlInfo.expirationDate  || ''),
      address:     src.street_1    || src.street_2 || dlInfo.street_1 || dlInfo.street_2 || '',
      city:        src.city        || dlInfo.city           || '',
      state:       src.jurisdictionCode || dlInfo.jurisdictionCode || '',
      postal_code: (src.postalCode || dlInfo.postalCode || '').substring(0, 5),
      sex:         src.sex         || dlInfo.sex            || ''
    };
  }

  function formatDate(raw) {
    if (!raw) return '';
    var s = raw.replace(/[^0-9]/g, '');
    if (s.length === 8) return s.slice(0, 2) + '/' + s.slice(2, 4) + '/' + s.slice(4, 8);
    return raw;
  }

  /* ================================================================
     6. CONFIRM SCREEN
     ================================================================ */
  function showConfirmScreen(data) {
    var container = $('confirm-fields');
    container.innerHTML = '';
    FIELDS.forEach(function (f) {
      container.appendChild(makeFieldRow(f, data[f.key] || ''));
    });
    showScreen('confirm-screen');
  }

  $('btn-confirm').addEventListener('click', function () {
    var data = gatherFields('confirm-fields');
    submitScan(data);
  });

  /* ================================================================
     7. MANUAL ENTRY SCREEN
     ================================================================ */
  $('btn-manual').addEventListener('click', function () {
    var container = $('manual-fields');
    container.innerHTML = '';
    FIELDS.forEach(function (f) {
      container.appendChild(makeFieldRow(f, ''));
    });
    capturedBlob = null;
    showScreen('manual-screen');
  });

  $('btn-manual-save').addEventListener('click', function () {
    var data = gatherFields('manual-fields');
    submitScan(data);
  });

  /* ================================================================
     8. SUBMIT TO /api/scans
     ================================================================ */
  async function submitScan(data) {
    showOverlay('Saving scan\u2026');
    try {
      var formData = new FormData();
      Object.keys(data).forEach(function (k) { formData.append(k, data[k]); });
      if (capturedBlob) formData.append('dl_photo', capturedBlob, 'dl.jpg');

      var res = await fetch('/api/scans', {
        method: 'POST',
        headers: { 'x-auth-token': authToken },
        body: formData
      });
      if (!res.ok) {
        var errBody = await res.json().catch(function () { return {}; });
        throw new Error(errBody.error || 'Save failed (' + res.status + ')');
      }
      var result = await res.json();
      hideOverlay();
      showRiskResult(result, data);
    } catch (err) {
      hideOverlay();
      showToast(err.message);
    }
  }

  /* ================================================================
     9. RISK RESULT SCREEN
     ================================================================ */
  function showRiskResult(result, scanData) {
    var score = result.risk_score || 0;
    var level = score >= 70 ? 'RED' : score >= 30 ? 'YELLOW' : 'GREEN';
    var flags = result.risk_flags || [];

    showScreen('result-screen');

    var circle = $('risk-circle');
    circle.style.strokeDashoffset = '314';
    circle.className.baseVal = 'fill ' + level;
    var offset = 314 - (score / 100) * 314;
    setTimeout(function () { circle.style.strokeDashoffset = offset; }, 50);

    var scoreEl = $('risk-score-num');
    scoreEl.textContent = score;
    var color = level === 'RED' ? 'var(--red)' : level === 'YELLOW' ? 'var(--yellow)' : 'var(--green)';
    scoreEl.style.color = color;

    var labelEl = $('risk-label');
    var labels = { GREEN: 'LOW RISK', YELLOW: 'ELEVATED', RED: 'HIGH RISK' };
    labelEl.textContent = labels[level];
    labelEl.style.color = color;

    var name = ((scanData.first_name || '') + ' ' + (scanData.last_name || '')).trim();
    $('risk-name').textContent = name;

    var flagsEl = $('risk-flags');
    if (flags.length > 0) {
      flagsEl.innerHTML = flags.map(function (f) {
        return '<div class="risk-flag">' + escHtml(f) + '</div>';
      }).join('');
    } else {
      flagsEl.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:13px;margin-top:8px;">No risk flags triggered</div>';
    }

    var actionsEl = $('result-actions');
    var html = '<button class="btn btn-blue btn-full" onclick="showScreen(\'scan-screen\')">New Scan</button>';
    if (level === 'RED') {
      html = '<button class="btn btn-danger btn-full" onclick="showScreen(\'scan-screen\')">\uD83D\uDEA8 HIGH RISK \u2014 New Scan</button>';
    }
    actionsEl.innerHTML = html;
  }

  /* ================================================================
     HELPERS
     ================================================================ */
  function makeFieldRow(fieldDef, value) {
    var row = document.createElement('div');
    row.className = 'field-row';
    var lbl = document.createElement('label');
    lbl.textContent = fieldDef.label;
    var inp = document.createElement('input');
    inp.type = fieldDef.type || 'text';
    inp.name = fieldDef.key;
    inp.value = value;
    if (fieldDef.placeholder) inp.placeholder = fieldDef.placeholder;
    row.appendChild(lbl);
    row.appendChild(inp);
    return row;
  }

  function gatherFields(containerId) {
    var data = {};
    $(containerId).querySelectorAll('input').forEach(function (inp) {
      data[inp.name] = inp.value.trim();
    });
    return data;
  }

  function fileToImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
      img.src = url;
    });
  }

  function imageToCanvas(img) {
    var canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas;
  }

  function showOverlay(text) {
    $('overlay-text').textContent = text || 'Processing\u2026';
    $('overlay').classList.add('active');
  }
  function hideOverlay() {
    $('overlay').classList.remove('active');
  }

  function greenFlash() {
    var el = document.createElement('div');
    el.className = 'green-flash';
    document.body.appendChild(el);
    el.addEventListener('animationend', function () { el.remove(); });
  }

  function showToast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 4000);
  }

  function showDebugLine(msg) {
    var el = $('debug-line');
    if (!el) {
      el = document.createElement('div');
      el.id = 'debug-line';
      el.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);color:#666;font-size:11px;font-family:monospace;max-width:90%;text-align:center;z-index:301;word-break:break-all;';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    setTimeout(function () { el.textContent = ''; }, 15000);
  }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /* ================================================================
     DEBUG: Dump raw decode data to console
     ================================================================ */
  window.dumpRawDecode = function () {
    console.log('═══════════════════════════════════════');
    console.log('[Halo] DEBUG DUMP');
    console.log('═══════════════════════════════════════');
    console.log('[Halo] engineReady:', engineReady);
    console.log('[Halo] engineInitError:', engineInitError ? engineInitError.message : 'none');
    console.log('[Halo] cvRouter:', !!cvRouter);
    console.log('[Halo] codeParser:', !!codeParser);
    if (lastRawResult) {
      var items = lastRawResult.items || [];
      console.log('[Halo] lastRawResult: ' + items.length + ' items');
      items.forEach(function (it, idx) {
        console.log('[Halo]   [' + idx + '] type=' + it.type + ' format=' + (it.formatString || 'N/A'));
        try {
          var txt = it.text || new TextDecoder().decode(new Uint8Array(it.bytes));
          console.log('[Halo]   [' + idx + '] text (first 500):', txt.substring(0, 500));
        } catch (e) {
          console.log('[Halo]   [' + idx + '] could not read text');
        }
      });
    } else {
      console.log('[Halo] lastRawResult: null');
    }
    console.log('[Halo] lastRawBarcodeText:', lastRawBarcodeText || '(none)');
    if (lastRawParserJSON) {
      console.log('[Halo] lastRawParserJSON:', JSON.stringify(lastRawParserJSON, null, 2));
    } else {
      console.log('[Halo] lastRawParserJSON: null');
    }
    console.log('═══════════════════════════════════════');
  };

  // Press 'd' on Scan screen to dump
  document.addEventListener('keydown', function (e) {
    if (e.key === 'd' && $('scan-screen').classList.contains('active')) {
      window.dumpRawDecode();
    }
  });

})();
