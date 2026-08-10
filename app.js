/* 360 Viewer: equirectangular panorama viewer.
   Everything runs locally. The page makes no network requests after load. */

(function () {
  'use strict';

  var intake = document.getElementById('intake');
  var strip  = document.getElementById('strip');
  var fileEl = document.getElementById('file');
  var note   = document.getElementById('note');
  var toast  = document.getElementById('toast');
  var padBtn = document.getElementById('padbtn');
  var arc    = document.getElementById('arc');
  var ax     = arc.getContext('2d');

  /* A 2:1 RGBA texture costs width * height * 4 bytes of video memory, so an
     8192 frame is about 134 MB and a 16384 one about 537 MB. The second
     number fails or thrashes on integrated graphics, so the working size is
     capped here regardless of what the GPU reports as its maximum. */
  var TEXTURE_CEILING = 8192;

  // Where the missing band sits when an image is not a full 2:1 sphere.
  // Drone panoramas normally have full nadir and a hole at zenith.
  var PAD_MODES = ['top', 'centre', 'bottom'];

  var scene, camera, renderer, mesh, maxTex = TEXTURE_CEILING;
  var lon = 0, lat = 0, fov = 74;
  var dragging = false, px = 0, py = 0;
  var padIndex = 0;
  var source = null;              // working canvas, already downscaled
  var sourceW = 0, sourceH = 0;   // dimensions of the file as delivered
  var dragDepth = 0;
  var messageTimer = 0;
  var ink = { rule: '#2A251F', mark: '#C8893F' };

  /* ---------- messages ----------
     The intake plate carries #note, but it is hidden once an image is on
     screen. Messages raised while viewing go to the toast instead, so a
     failed second drop is visible rather than silent. */

  function say(msg, bad, holdMs) {
    var viewing = intake.classList.contains('gone');
    var el = viewing ? toast : note;
    el.textContent = msg;
    el.className = 'show' + (bad ? ' bad' : '');

    clearTimeout(messageTimer);
    if (viewing && holdMs) {
      messageTimer = setTimeout(function () { toast.className = ''; }, holdMs);
    }
  }

  function clearMessage() {
    clearTimeout(messageTimer);
    note.className = '';
    toast.className = '';
  }

  /* ---------- scene ---------- */

  function readInk() {
    var s = getComputedStyle(document.documentElement);
    var rule = s.getPropertyValue('--hairline').trim();
    var mark = s.getPropertyValue('--amber').trim();
    if (rule) ink.rule = rule;
    if (mark) ink.mark = mark;
  }

  function boot() {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(fov, innerWidth / innerHeight, 0.1, 1100);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.domElement.id = 'stage';
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    document.body.appendChild(renderer.domElement);
    maxTex = renderer.capabilities.maxTextureSize || TEXTURE_CEILING;

    var geo = new THREE.SphereGeometry(500, 64, 44);
    geo.scale(-1, 1, 1);          // view from inside
    mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    scene.add(mesh);

    bindPointer(renderer.domElement);
    sizeArc();
    tick();
  }

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    renderer.domElement.classList.remove('dragging');
    if (e && e.pointerId !== undefined) {
      try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    }
  }

  function bindPointer(c) {
    c.addEventListener('pointerdown', function (e) {
      dragging = true; px = e.clientX; py = e.clientY;
      c.classList.add('dragging'); c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      lon -= (e.clientX - px) * 0.13;
      lat = Math.max(-85, Math.min(85, lat + (e.clientY - py) * 0.13));
      px = e.clientX; py = e.clientY;
    });

    // pointerup alone leaves the view glued to the pointer when a touch is
    // cancelled or capture is lost, so all three paths end the drag.
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);
    c.addEventListener('lostpointercapture', endDrag);

    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      fov = Math.max(22, Math.min(100, fov + e.deltaY * 0.04));
      camera.fov = fov; camera.updateProjectionMatrix();
    }, { passive: false });
  }

  /* ---------- decoding ---------- */

  /* Very large panoramas exceed the browser's decode budget. Try full
     resolution first, then step down until one succeeds. Nothing above
     TEXTURE_CEILING is worth attempting as a fallback, because the working
     canvas is capped there anyway. */
  function decode(file) {
    var widths = [null, TEXTURE_CEILING, 4096, 2048];
    var i = 0;
    var firstError = null;

    function attempt() {
      if (i >= widths.length) return Promise.reject(firstError || new Error('no decoder accepted this file'));
      var w = widths[i++];
      var opts = w ? { resizeWidth: w, resizeQuality: 'high' } : undefined;
      return createImageBitmap(file, opts).catch(function (err) {
        if (!firstError) firstError = err;   // the first failure is the useful one
        return attempt();
      });
    }
    return attempt();
  }

  /* Draw the decoded bitmap into a working canvas at the texture ceiling,
     then release the bitmap.

     A full resolution ImageBitmap is expensive: 14848 x 6311 is roughly
     375 MB. Holding one for the lifetime of the session so the Gap control
     can recomposite is the wrong trade, and holding several is a crash. The
     working canvas is a third of that and it is all the recomposite needs.

     Drawing through a canvas rather than handing the ImageBitmap straight to
     three.js also keeps the Y orientation deterministic: ImageBitmap and
     HTMLImageElement disagree on origin, which silently flips the sphere. */
  function makeSource(bmp) {
    var w = Math.min(bmp.width, maxTex, TEXTURE_CEILING);
    var h = Math.max(1, Math.round(bmp.height * (w / bmp.width)));

    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
    return cv;
  }

  /* Composite the working canvas into a true 2:1 texture.

     A source shorter than 2:1 covers less than 180 degrees vertically, so it
     is placed into a 2:1 frame and the missing band is filled by stretching
     the adjacent edge row. That keeps the horizon at the correct latitude
     instead of stretching the whole image to fit.

     A source taller than 2:1 claims more than 180 degrees of vertical
     coverage, which an equirectangular projection cannot mean. It is fitted
     by width and the excess is cropped evenly top and bottom, rather than
     squashed, which would move the horizon. */
  function buildTexture(src) {
    var w = src.width;
    var h = Math.round(w / 2);

    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');

    var gap = h - src.height;

    if (gap < 0) {
      var cropSrc = src.height - h;
      ctx.drawImage(src, 0, Math.round(cropSrc / 2), w, h, 0, 0, w, h);
      return cv;
    }

    var mode = PAD_MODES[padIndex];
    var top = mode === 'top' ? gap : mode === 'bottom' ? 0 : Math.round(gap / 2);
    ctx.drawImage(src, 0, top);

    if (gap > 0) {
      // stretch the outermost row of real pixels across each empty band
      if (top > 0) ctx.drawImage(src, 0, 0, w, 1, 0, 0, w, top);
      var below = h - (top + src.height);
      if (below > 0) ctx.drawImage(src, 0, src.height - 1, w, 1, 0, top + src.height, w, below);
    }
    return cv;
  }

  function applyTexture() {
    if (!source) return;
    var tex = new THREE.CanvasTexture(buildTexture(source));
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    if (mesh.material.map) mesh.material.map.dispose();
    mesh.material.map = tex;
    mesh.material.needsUpdate = true;
  }

  function describe(full, overTall, vertical) {
    if (overTall) return { text: 'Over-tall · cropped to 2:1', bad: true };
    if (full) return { text: 'Full sphere · 2:1', bad: false };
    return { text: 'Partial · ' + vertical.toFixed(0) + '° vertical', bad: true };
  }

  function load(file) {
    if (!renderer) { say('WebGL is unavailable, so nothing can be displayed.', true); return; }
    say('Decoding ' + (file.size / 1048576).toFixed(1) + ' MB…', false);

    decode(file).then(function (bmp) {
      sourceW = bmp.width;
      sourceH = bmp.height;

      source = makeSource(bmp);
      bmp.close();                  // release the decoded bitmap immediately
      padIndex = 0;

      var ratio = sourceW / sourceH;
      var full = Math.abs(ratio - 2) < 0.02;
      var overTall = ratio < 2 - 0.02;
      var vertical = (sourceH / sourceW) * 360;

      var dim = sourceW + '×' + sourceH;
      if (source.width < sourceW) dim += ' → ' + source.width;
      document.getElementById('dim').textContent = dim;

      var verdict = describe(full, overTall, vertical);
      var v = document.getElementById('verdict');
      v.textContent = verdict.text;
      v.className = verdict.bad ? 'bad' : '';

      padBtn.hidden = full || overTall;
      if (!padBtn.hidden) padBtn.textContent = 'Gap: ' + PAD_MODES[padIndex];

      applyTexture();
      clearMessage();
      intake.classList.add('gone');
      strip.classList.add('live');
    }).catch(function (err) {
      say('Could not decode this file.\n' +
          (err && err.message ? err.message : 'Unknown error') +
          '\nTry a JPEG or PNG.', true, 10000);
    });
  }

  /* ---------- azimuth arc ---------- */

  /* The backing store has to be resized whenever the element is, not only on
     window resize. #arc is flex:1 inside the strip, so it shrinks the moment
     Source and Verdict fill in with real text. Sizing it once at boot leaves
     drawArc working in current CSS pixels while painting into a canvas sized
     for the old layout, which slides the azimuth marker off true. */
  function sizeArc() {
    var r = Math.min(devicePixelRatio, 2);
    var w = Math.round(arc.clientWidth * r);
    var h = Math.round(arc.clientHeight * r);
    if (!w || !h) return;
    if (arc.width !== w) arc.width = w;
    if (arc.height !== h) arc.height = h;
    ax.setTransform(r, 0, 0, r, 0, 0);   // resizing a canvas resets its transform
  }

  // camera.fov is vertical. The arc shows how much of the 360 is on screen,
  // which is the horizontal field, so it has to be derived from the aspect.
  function horizontalFov() {
    var half = THREE.MathUtils.degToRad(fov) / 2;
    return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(half) * camera.aspect));
  }

  function drawArc() {
    var w = arc.clientWidth, h = arc.clientHeight, mid = h / 2;
    if (!w) return;
    ax.clearRect(0, 0, w, h);

    ax.strokeStyle = ink.rule; ax.lineWidth = 1;
    ax.beginPath(); ax.moveTo(0, mid); ax.lineTo(w, mid); ax.stroke();
    for (var d = 0; d < 360; d += 45) {
      var x = (d / 360) * w;
      ax.beginPath(); ax.moveTo(x, mid - 4); ax.lineTo(x, mid + 4); ax.stroke();
    }

    var half = Math.min(horizontalFov(), 360) / 360 / 2;
    var centre = (((lon % 360) + 360) % 360) / 360;

    // Drawn at -1, 0 and +1 so a view straddling the 0/360 seam appears at
    // both ends of the arc instead of running off one edge.
    ax.strokeStyle = ink.mark; ax.lineWidth = 3;
    for (var k = -1; k <= 1; k++) {
      ax.beginPath();
      ax.moveTo((centre - half + k) * w, mid);
      ax.lineTo((centre + half + k) * w, mid);
      ax.stroke();
    }
  }

  /* ---------- loop ---------- */

  function tick() {
    requestAnimationFrame(tick);

    var phi = THREE.MathUtils.degToRad(90 - lat);
    var theta = THREE.MathUtils.degToRad(lon);
    camera.lookAt(
      500 * Math.sin(phi) * Math.cos(theta),
      500 * Math.cos(phi),
      500 * Math.sin(phi) * Math.sin(theta)
    );
    renderer.render(scene, camera);

    if (!strip.classList.contains('live')) return;
    document.getElementById('az').textContent =
      (((lon % 360) + 360) % 360).toFixed(1) + '°';
    document.getElementById('pt').textContent = lat.toFixed(1) + '°';
    drawArc();
  }

  /* ---------- wiring ---------- */

  document.getElementById('pick').onclick = function () { fileEl.click(); };

  padBtn.onclick = function () {
    padIndex = (padIndex + 1) % PAD_MODES.length;
    padBtn.textContent = 'Gap: ' + PAD_MODES[padIndex];
    applyTexture();
  };

  document.getElementById('again').onclick = function () {
    intake.classList.remove('gone');
    strip.classList.remove('live');
    clearMessage();
    fileEl.value = '';
  };

  fileEl.onchange = function (e) { if (e.target.files[0]) load(e.target.files[0]); };

  addEventListener('keydown', function (e) {
    if (!intake.classList.contains('gone')) return;
    var step = e.shiftKey ? 12 : 4;
    if (e.key === 'ArrowLeft')  { lon -= step; e.preventDefault(); }
    if (e.key === 'ArrowRight') { lon += step; e.preventDefault(); }
    if (e.key === 'ArrowUp')    { lat = Math.min(85, lat + step); e.preventDefault(); }
    if (e.key === 'ArrowDown')  { lat = Math.max(-85, lat - step); e.preventDefault(); }
  });

  addEventListener('resize', function () {
    if (!renderer) return;
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    sizeArc();
  });

  /* Drag state is counted rather than inferred from relatedTarget, which is
     only reliable in some browsers. Entering a child element fires dragleave
     on the parent, so a depth counter is what keeps the state honest. */
  function setArmed(on) {
    intake.classList.toggle('armed', on);
    document.body.classList.toggle('armed', on);
  }

  addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; setArmed(true); });
  addEventListener('dragover',  function (e) { e.preventDefault(); });
  addEventListener('dragleave', function () { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) setArmed(false); });
  addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0; setArmed(false);
    if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]);
  });

  /* ---------- start ----------
     The renderer boots before any file is chosen so maxTextureSize is known
     when the first image is sized, and so a missing WebGL context is
     reported up front rather than after a decode. */
  readInk();
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(function () { sizeArc(); }).observe(arc);
  }
  try {
    boot();
  } catch (err) {
    say('WebGL is unavailable in this browser, so panoramas cannot be displayed.\n' +
        (err && err.message ? err.message : ''), true);
  }
})();
