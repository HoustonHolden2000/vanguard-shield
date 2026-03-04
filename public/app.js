/* ═══════════════════════════════════════════════════════════════
   Iron Halo — Vanguard Shield Scanner
   Client-side Dynamsoft PDF417 decode → /api/scans
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── State ──
  var authToken = null;
  var cvRouter = null;
  var codeParser = null;
  var engineReady = false;
  var capturedBlob = null; // DL photo from last scan

  // ── DOM refs ──
  var $ = function (id) { return document.getElementById(id); };

  // ── Field definitions (order shown on Confirm / Manual screens) ──
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
      Dynamsoft.License.LicenseManager.initLicense(
        'DLS2eyJoYW5kc2hha2VDb2RlIjoiMTA1MjUzODIxLU1UQTFNalV6T0RJeExYZGxZaTFVY21saGJGQnliMm8iLCJtYWluU2VydmVyVVJMIjoiaHR0cHM6Ly9tZGxzLmR5bmFtc29mdG9ubGluZS5jb20vIiwib3JnYW5pemF0aW9uSUQiOiIxMDUyNTM4MjEiLCJzdGFuZGJ5U2VydmVyVVJMIjoiaHR0cHM6Ly9zZGxzLmR5bmFtc29mdG9ubGluZS5jb20vIiwiY2hlY2tDb2RlIjotMTcyMDI3MzcyOX0='
      );
      await Dynamsoft.Core.CoreModule.loadWasm(['DBR', 'DCP']);
      await Dynamsoft.DCP.CodeParserModule.loadSpec('AAMVA_DL_ID');
      cvRouter = await Dynamsoft.CVR.CaptureVisionRouter.createInstance();
      codeParser = await Dynamsoft.DCP.CodeParser.createInstance();
      engineReady = true;
      console.log('[Halo] Dynamsoft engine ready');
    } catch (err) {
      console.error('[Halo] Engine init failed:', err);
      // Engine failed — scans will fail gracefully with toast
    }
    banner.classList.remove('show');
  }

  // Fire init immediately (non-blocking to page render)
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
    showOverlay('Decoding barcode\u2026');

    try {
      var img = await fileToImage(file);
      var canvas = imageToCanvas(img);
      var parsed = await decodeAndParse(canvas);

      // Success path
      hideOverlay();
      greenFlash();
      if (navigator.vibrate) navigator.vibrate(80);
      showConfirmScreen(parsed);
    } catch (err) {
      // Failure path
      hideOverlay();
      console.warn('[Halo] Decode failed:', err);
      showToast('Could not read barcode. Try again or use Manual Entry.');
    }
  });

  /* ================================================================
     5. DECODE + PARSE (Dynamsoft v11)
     ================================================================ */
  async function decodeAndParse(canvas) {
    // Try balanced first, then rate-first fallback
    var result = await cvRouter.capture(canvas, 'ReadBarcodes_Balance');
    if (!result.items || result.items.length === 0) {
      result = await cvRouter.capture(canvas, 'ReadBarcodes_ReadRateFirst');
    }

    var barcodeItem = null;
    for (var i = 0; i < (result.items || []).length; i++) {
      if (result.items[i].type === 2) { barcodeItem = result.items[i]; break; }
    }
    if (!barcodeItem) throw new Error('No PDF417 barcode found');

    var parsedResult = await codeParser.parse(barcodeItem.bytes);
    var dlInfo = JSON.parse(parsedResult.jsonString);
    return mapAAMVA(dlInfo);
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

  // AAMVA dates come as MMDDYYYY — format to MM/DD/YYYY
  function formatDate(raw) {
    if (!raw) return '';
    var s = raw.replace(/[^0-9]/g, '');
    if (s.length === 8) return s.slice(0, 2) + '/' + s.slice(2, 4) + '/' + s.slice(4, 8);
    return raw;
  }

  /* ================================================================
     6. CONFIRM SCREEN (populated from decode)
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

    // Gauge
    var circle = $('risk-circle');
    circle.style.strokeDashoffset = '314'; // reset
    circle.className.baseVal = 'fill ' + level;
    var offset = 314 - (score / 100) * 314;
    setTimeout(function () { circle.style.strokeDashoffset = offset; }, 50);

    // Score number
    var scoreEl = $('risk-score-num');
    scoreEl.textContent = score;
    var color = level === 'RED' ? 'var(--red)' : level === 'YELLOW' ? 'var(--yellow)' : 'var(--green)';
    scoreEl.style.color = color;

    // Label
    var labelEl = $('risk-label');
    var labels = { GREEN: 'LOW RISK', YELLOW: 'ELEVATED', RED: 'HIGH RISK' };
    labelEl.textContent = labels[level];
    labelEl.style.color = color;

    // Name
    var name = ((scanData.first_name || '') + ' ' + (scanData.last_name || '')).trim();
    $('risk-name').textContent = name;

    // Flags
    var flagsEl = $('risk-flags');
    if (flags.length > 0) {
      flagsEl.innerHTML = flags.map(function (f) {
        return '<div class="risk-flag">' + escHtml(f) + '</div>';
      }).join('');
    } else {
      flagsEl.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:13px;margin-top:8px;">No risk flags triggered</div>';
    }

    // Actions
    var actionsEl = $('result-actions');
    var html = '<button class="btn btn-blue btn-full" onclick="showScreen(\'scan-screen\')">New Scan</button>';
    if (level === 'RED') {
      html = '<button class="btn btn-danger btn-full" onclick="showScreen(\'scan-screen\')">\uD83D\uDEA8 HIGH RISK — New Scan</button>';
    }
    actionsEl.innerHTML = html;
  }

  /* ================================================================
     HELPERS
     ================================================================ */

  // Build a field row DOM element
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

  // Gather field values from a container
  function gatherFields(containerId) {
    var data = {};
    $(containerId).querySelectorAll('input').forEach(function (inp) {
      data[inp.name] = inp.value.trim();
    });
    return data;
  }

  // Load file into Image element
  function fileToImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
      img.src = url;
    });
  }

  // Draw image to canvas (Dynamsoft needs a canvas or image source)
  function imageToCanvas(img) {
    var canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas;
  }

  // Overlay
  function showOverlay(text) {
    $('overlay-text').textContent = text || 'Processing\u2026';
    $('overlay').classList.add('active');
  }
  function hideOverlay() {
    $('overlay').classList.remove('active');
  }

  // Green flash
  function greenFlash() {
    var el = document.createElement('div');
    el.className = 'green-flash';
    document.body.appendChild(el);
    el.addEventListener('animationend', function () { el.remove(); });
  }

  // Toast
  function showToast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 4000);
  }

  // Escape HTML
  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

})();
