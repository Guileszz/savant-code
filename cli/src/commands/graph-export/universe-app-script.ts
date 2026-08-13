/**
 * The offline Code Universe browser app (Sigma/Graphology renderer, state
 * machine, planet effects, audio, search, tooltips, keyboard nav).
 *
 * Extracted verbatim from template.ts by FID-2026-0809-011 Phase B-1: the
 * region had zero ${} interpolations, zero backticks, and zero escape
 * sequences, so the lift into a static string constant is byte-identical
 * (deterministic-artifact gate preserved). buildGraphExportHtml interpolates
 * this inside the HTML shell.
 */
export const UNIVERSE_APP_SCRIPT = `
(function () {
  'use strict';
  var DATA = JSON.parse(document.getElementById('savant-graph-data').textContent);
  var AUDIO = JSON.parse(document.getElementById('savant-audio-data').textContent);
  var audioContext = null;
  var audioMaster = null;
  var audioUnlocked = false;
  var soundEnabled = false;
  var soundVolume = 0.4;
  var audioBuffers = {};
  var activeSources = [];
  var activeProcedural = [];
  var activePending = 0;
  var audioBootstrapping = true;
  var sigma = null;
  var graph = null;
  var state = 'universe';
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var selected = null;
  var selectedRegion = null;
  var motionFrame = 0;
  var planetCanvas = null;
  var brandLogo = null;
  var systemById = {};
  var objectById = {};
  var folderById = {};
  var browserFolderId = null;
  var browserDocumentId = null;
  var browserPage = 0;
  var searchIndex = (DATA.universe.searchIndex || []).slice();
  var searchActive = -1;
  var docWrapOff = false;
  var LARGE_DOCUMENT_LINE_THRESHOLD = 10000;
  DATA.universe.regions.forEach(function (r) { systemById[r.id] = r; objectById[r.id] = r; });    DATA.universe.files.forEach(function (f) { objectById[f.id] = f; });
  var folderByPath = {};
  (DATA.universe.folders || []).forEach(function (folder) { folderById[folder.id] = folder; folderByPath[folder.path] = folder; });
  var regionTrees = {};
  var navRowCounter = 0;
  var filesByRegion = {};
  DATA.universe.files.forEach(function (f) { (filesByRegion[f.regionId] = filesByRegion[f.regionId] || []).push(f); });

  // FID-2026-0807-020: documents ship in a separate gzip+base64 block and are
  // decompressed off the critical path. The graph (universe) boots first; the
  // docs promise resolves as soon as the payload is decoded. renderDocument
  // awaits it so a fast first frame is never blocked by the 10+ MB text block.
  var documentsData = {};
  var documentsReady = (function decodeDocuments() {
    try {
      var raw = document.getElementById('savant-docs-payload').textContent;
      var meta = JSON.parse(raw);
      if (!meta || meta.mode !== 'gzip') {
        documentsData = meta && typeof meta.payload === 'string' ? JSON.parse(meta.payload) : {};
        return Promise.resolve();
      }
      if (typeof Uint8Array.fromBase64 !== 'function' || typeof DecompressionStream !== 'function') {
        throw new Error('compression streams unsupported');
      }
      var compressed = Uint8Array.fromBase64(meta.payload);
      var stream = new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')));
      return stream.json().then(function (docs) { documentsData = docs || {}; });
    } catch (error) {
      setStatus('Document payload decode unavailable · graph remains fully usable');
      documentsData = {};
      return Promise.resolve();
    }
  })();

  var tooltipNodeId = null;
  function setStatus(text) { var el = document.getElementById('graph-status'); if (el) el.textContent = text; }
  function hideUniverseTooltip() {
    tooltipNodeId = null;
    var tooltip = document.getElementById('universe-tooltip');
    if (tooltip) { tooltip.classList.remove('visible'); tooltip.setAttribute('aria-hidden', 'true'); }
  }
  function showUniverseTooltip(node, nodeId) {
    var tooltip = document.getElementById('universe-tooltip');
    if (!tooltip || !sigma || !node) return;
    tooltipNodeId = nodeId;
    var isSystem = node.fileCount !== undefined;
    var kind = tooltip.querySelector('.universe-tooltip-kind');
    var title = tooltip.querySelector('.universe-tooltip-title');
    var path = tooltip.querySelector('.universe-tooltip-path');
    var meta = tooltip.querySelector('.universe-tooltip-meta');
    if (kind) kind.textContent = isSystem ? 'SYSTEM / REGION' : 'FILE / NODE';
    if (title) title.textContent = node.label || node.path || 'Unnamed object';
    if (path) path.textContent = node.path || '';
    if (meta) meta.textContent = isSystem
      ? (node.fileCount || 0) + ' files · ' + (node.edgeCount || 0) + ' edges'
      : 'Click to inspect · ' + (regionFor(nodeId) ? regionFor(nodeId).label : 'Code Universe');
    tooltip.classList.add('visible');
    tooltip.setAttribute('aria-hidden', 'false');
    positionUniverseTooltip();
  }
  function positionUniverseTooltip() {
    if (!tooltipNodeId || !sigma || !graph || !graph.hasNode(tooltipNodeId)) return;
    var tooltip = document.getElementById('universe-tooltip');
    var viewport = document.querySelector('.viewport-wrap');
    if (!tooltip || !viewport || !tooltip.classList.contains('visible')) return;
    var point;
    try { point = sigma.graphToViewport(graph.getNodeAttributes(tooltipNodeId)); } catch (error) { hideUniverseTooltip(); return; }
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) { hideUniverseTooltip(); return; }
    var margin = 14;
    var width = viewport.clientWidth;
    var height = viewport.clientHeight;
    var tooltipWidth = tooltip.offsetWidth || 250;
    var tooltipHeight = tooltip.offsetHeight || 72;
    var left = Math.max(margin, Math.min(point.x - tooltipWidth / 2, width - tooltipWidth - margin));
    var above = point.y - tooltipHeight - 18;
    var top = above >= margin ? above : Math.min(height - tooltipHeight - margin, point.y + 18);
    top = Math.max(margin, top);
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }
  function updateSoundUi() {
    var toggle = document.getElementById('sound-toggle');
    var status = document.getElementById('sound-status');
    if (toggle) { toggle.textContent = !audioUnlocked ? 'SFX LOCKED' : soundEnabled ? 'SFX ON' : 'SFX OFF'; toggle.setAttribute('aria-pressed', soundEnabled ? 'true' : 'false'); }
    if (status) status.textContent = !audioUnlocked ? 'Interact to unlock' : soundEnabled ? 'Online · volume ' + Math.round(soundVolume * 100) + '%' : 'Muted';
  }
  function stopActiveSounds() {
    activeSources.forEach(function (source) {
      try { source.stop(); } catch (error) { void error; }
      try { source.disconnect(); } catch (error) { void error; }
    });
    activeSources = [];
    activeProcedural.forEach(function (oscillator) {
      try { oscillator.stop(); } catch (error) { void error; }
      try { oscillator.disconnect(); } catch (error) { void error; }
    });
    activeProcedural = [];
    activePending = 0;
  }
  function getAudioCtor() { return window.AudioContext || window.webkitAudioContext; }
  function unlockAudio() {
    if (audioUnlocked && audioContext) return Promise.resolve(true);
    var AudioCtor = getAudioCtor();
    if (!AudioCtor) { updateSoundUi(); return Promise.resolve(false); }
    try {
      audioContext = audioContext || new AudioCtor();
      audioMaster = audioMaster || audioContext.createGain();
      audioMaster.gain.value = soundVolume;
      audioMaster.connect(audioContext.destination);
      var resumed = audioContext.state === 'running' ? Promise.resolve() : audioContext.resume();
      return resumed.then(function () { audioUnlocked = true; soundEnabled = true; updateSoundUi(); return true; }).catch(function () { updateSoundUi(); return false; });
    } catch (error) { updateSoundUi(); return Promise.resolve(false); }
  }
  function setSoundVolume(value) {
    soundVolume = Math.max(0, Math.min(1, Number(value) || 0));
    if (audioMaster) audioMaster.gain.value = soundVolume;
    updateSoundUi();
  }
  function toggleSoundPanel(event) {
    if (event) event.stopPropagation();
    var panel = document.getElementById('sound-panel'); var control = document.getElementById('sound-control');
    if (!panel) return;
    var open = panel.classList.toggle('hidden');
    if (control) control.setAttribute('aria-expanded', open ? 'false' : 'true');
    if (!audioUnlocked) void unlockAudio().then(function (ready) { if (ready) { soundEnabled = true; playSound('toggle'); updateSoundUi(); } });
    updateSoundUi();
  }
  function toggleSound(event) {
    if (event) event.stopPropagation();
    if (!audioUnlocked) { void unlockAudio().then(function (ready) { if (ready) { soundEnabled = true; playSound('toggle'); updateSoundUi(); } }); return; }
    soundEnabled = !soundEnabled;
    if (!soundEnabled) stopActiveSounds();
    updateSoundUi();
    if (soundEnabled) playProcedural('toggle');
  }
  function audioCue(cue) { return (AUDIO.cues || []).find(function (item) { return item.cue === cue; }); }
  function playProcedural(cue) {
    if (!audioContext || !audioMaster || !soundEnabled || activeSources.length + activeProcedural.length + activePending >= 4) return;
    var now = audioContext.currentTime;
    var oscillator = audioContext.createOscillator(); var gain = audioContext.createGain();
    var frequency = cue === 'warning' ? 180 : cue === 'confirm' ? 880 : cue === 'toggle' ? 520 : 620;
    oscillator.type = cue === 'warning' ? 'sawtooth' : 'sine'; oscillator.frequency.setValueAtTime(frequency, now);
    if (cue === 'confirm') oscillator.frequency.exponentialRampToValueAtTime(1320, now + 0.08);
    gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(0.16, now + 0.008); gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    oscillator.connect(gain); gain.connect(audioMaster); activeProcedural.push(oscillator); oscillator.start(now); oscillator.onended = function () { activeProcedural = activeProcedural.filter(function (item) { return item !== oscillator; }); try { oscillator.disconnect(); } catch (error) { void error; } }; oscillator.stop(now + 0.13);
  }
  function playSound(cue) {
    void unlockAudio().then(function (ready) {
      if (!ready || !soundEnabled || !audioContext || !audioMaster) return;
      var asset = audioCue(cue);
      if (!asset) { playProcedural(cue); return; }
      if (activeSources.length + activeProcedural.length + activePending >= 4) return;
      activePending += 1;
      var decoded = audioBuffers[cue];
      var decodePromise = decoded ? Promise.resolve(decoded) : Promise.resolve().then(function () {
        var separator = asset.dataUri.indexOf(',');
        if (separator < 0 || asset.dataUri.slice(0, separator) !== 'data:audio/ogg;base64') throw new Error('Invalid embedded audio data URI');
        var encoded = asset.dataUri.slice(separator + 1);
        var binary = window.atob(encoded);
        var bytes = new Uint8Array(binary.length);
        for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return audioContext.decodeAudioData(bytes.buffer);
      }).then(function (result) { audioBuffers[cue] = result; return result; });
      decodePromise.then(function (buffer) {
        activePending = Math.max(0, activePending - 1);
        if (!soundEnabled || !audioContext || !audioMaster || activeSources.length + activeProcedural.length >= 4) return;
        var source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(audioMaster); activeSources.push(source);
        source.onended = function () {
          activeSources = activeSources.filter(function (item) { return item !== source; });
          try { source.disconnect(); } catch (error) { void error; }
        };
        source.start();
      }).catch(function () {
        activePending = Math.max(0, activePending - 1);
        playProcedural(cue);
      });
    });
  }
  function setState(next) { state = next; var pill = document.getElementById('state-pill'); if (pill) pill.textContent = next.toUpperCase() + ' / ' + (next === 'universe' ? 'MACRO' : next === 'system' ? 'MESO' : 'MICRO'); }
  function colorFor(cluster, fallback) { return cluster === null || cluster === undefined ? fallback : ['#18faf9','#4fa8ff','#a78bfa','#f472b6','#f59e0b','#34d399','#fb7185'][Math.abs(cluster) % 7]; }
  function nodeData(id) { return objectById[id]; }
  function regionFor(id) { var n = nodeData(id); return n && n.regionId ? systemById[n.regionId] : n; }

  function hideGraphLoading() {
    var loading = document.getElementById('graph-loading')
    if (loading) loading.style.display = 'none'
  }
  function showGraphFailure(message) {
    hideGraphLoading()
    var fallback = document.getElementById('graph-fallback')
    if (fallback) {
      fallback.classList.remove('hidden')
      fallback.textContent = message
    }
    setStatus('Text fallback active · graph data remains available')
  }

  function buildGraph() {
    // Multiple source relationships can share a file pair (for example an
    // import plus a call); preserve each relationship instead of throwing on
    // a duplicate non-multigraph edge.
    graph = new Graphology({ multi: true, type: 'mixed' });
    DATA.universe.regions.forEach(function (r, index) {
      graph.addNode(r.id, { x: r.position.x, y: r.position.y, size: r.size, label: r.label, color: cyberColor(index), kind: 'region', path: r.path, fileCount: r.fileCount, edgeCount: r.edgeCount });
    });
    DATA.universe.files.forEach(function (f) {
      graph.addNode(f.id, { x: f.position.x, y: f.position.y, size: f.size, label: f.label, color: colorFor(f.cluster, '#a7b4d8'), kind: 'file', path: f.path, regionId: f.regionId, importance: f.importance, cluster: f.cluster });
    });
    DATA.universe.corridors.forEach(function (c) {
      if (graph.hasNode(c.source) && graph.hasNode(c.target)) graph.addEdge(c.source, c.target, { size: Math.min(8, 1 + Math.log1p(c.totalWeight)), color: '#4c9aa8', kind: 'corridor', label: c.edgeCount + ' relationships', weight: c.totalWeight });
    });
    DATA.universe.edges.forEach(function (e) {
      if (graph.hasNode(e.source) && graph.hasNode(e.target)) graph.addEdge(e.source, e.target, { size: Math.min(3, 0.5 + e.weight), color: '#6c82a8', kind: 'exact', label: e.type, weight: e.weight });
    });
    // Build navigation before renderer construction so region/path access still
    // works if WebGL context creation fails.
    buildRegionNav();
    sigma = new Sigma(graph, document.getElementById('sigma-container'), {
      renderLabels: true,
      labelColor: { color: '#dbeafe' },
      labelSize: 12,
      labelDensity: 0.08,
      labelGridCellSize: 80,
      labelRenderedSizeThreshold: 18,
      defaultDrawNodeHover: function () {},
      zIndex: true,
      nodeReducer: function (id, attrs) { return reduceNode(id, attrs); },
      edgeReducer: function (id, attrs) { return reduceEdge(id, attrs); },
    });
    sigma.on('clickNode', function (event) { navigateToObject(event.node); });
    sigma.on('clickEdge', function (event) { selectEdge(event.edge); });
    sigma.on('clickStage', function () {
      hideUniverseTooltip();
      setStatus(selected ? 'Selection preserved · choose another object or use Universe to reset' : 'Drag through the universe · select a system to enter its orbit')
    });
    sigma.on('enterNode', function (event) {
      var n = nodeData(event.node);
      if (n) { setStatus((n.label || n.path) + ' · click to enter'); showUniverseTooltip(n, event.node); }
    });
    sigma.on('leaveNode', function () { hideUniverseTooltip(); setStatus('Drag through the universe · select a system to enter its orbit'); });
    sigma.getCamera().on('updated', function () { updateZoomState(); drawPlanetEffects(); positionUniverseTooltip(); });
    hideGraphLoading();
    initializePlanetEffects();
    fitUniverseSilently();
    audioBootstrapping = false;
  }

  function cyberColor(index) { return ['#00f0ff', '#ff2bd6', '#7c5cff', '#00ff9d', '#ff5c8a', '#ffd166', '#39a0ff'][index % 7]; }
  function colorWithAlpha(hex, alpha) {
    var value = String(hex || '#18faf9').replace('#', '');
    if (value.length === 3) value = value.split('').map(function (c) { return c + c; }).join('');
    var number = parseInt(value, 16);
    return 'rgba(' + ((number >> 16) & 255) + ',' + ((number >> 8) & 255) + ',' + (number & 255) + ',' + alpha + ')';
  }
  function resizePlanetCanvas() {
    planetCanvas = planetCanvas || document.getElementById('planet-effects');
    if (!planetCanvas) return;
    var width = planetCanvas.clientWidth;
    var height = planetCanvas.clientHeight;
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (planetCanvas.width !== Math.round(width * ratio) || planetCanvas.height !== Math.round(height * ratio)) {
      planetCanvas.width = Math.round(width * ratio);
      planetCanvas.height = Math.round(height * ratio);
    }
  }
  function drawPlanetBody(ctx, point, radius, color, pulse) {
    ctx.fillStyle = '#020611';
    ctx.beginPath(); ctx.arc(point.x, point.y, radius * 0.54, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 1.5 + pulse;
    ctx.strokeStyle = colorWithAlpha(color, 0.9);
    ctx.stroke();
    ctx.fillStyle = colorWithAlpha(color, 0.9);
    ctx.beginPath(); ctx.arc(point.x, point.y, 2.4 + pulse * 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 14 + pulse * 12; ctx.shadowColor = color;
    ctx.beginPath(); ctx.arc(point.x, point.y, 1.4, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }
  function drawPlanetEffects() {
    if (!sigma) return;
    planetCanvas = planetCanvas || document.getElementById('planet-effects');
    if (!planetCanvas || typeof sigma.graphToViewport !== 'function') return;
    resizePlanetCanvas();
    var width = planetCanvas.clientWidth;
    var height = planetCanvas.clientHeight;
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    var ctx = planetCanvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    var pulse = reducedMotion ? 0.5 : (Math.sin(performance.now() / 900) + 1) / 2;
    DATA.universe.regions.forEach(function (region, index) {
      if (!graph.hasNode(region.id)) return;
      var attrs = graph.getNodeAttributes(region.id);
      var point = sigma.graphToViewport({ x: attrs.x, y: attrs.y });
      if (!point || point.x < -180 || point.x > width + 180 || point.y < -180 || point.y > height + 180) return;
      var radius = Math.max(25, Math.min(112, Math.sqrt(attrs.size || 20) * 10));
      var color = attrs.color || cyberColor(index);
      var halo = ctx.createRadialGradient(point.x, point.y, radius * 0.12, point.x, point.y, radius * 1.65);
      halo.addColorStop(0, colorWithAlpha(color, 0.22));
      halo.addColorStop(0.45, colorWithAlpha(color, 0.06));
      halo.addColorStop(1, colorWithAlpha(color, 0));
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(point.x, point.y, radius * 1.65, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.translate(point.x, point.y);
      ctx.rotate((index * 0.71) + pulse * 0.08);
      ctx.setLineDash([radius * 0.22, radius * 0.11, radius * 0.06, radius * 0.18]);
      ctx.lineWidth = 1 + (index % 3) * 0.65;
      ctx.strokeStyle = colorWithAlpha(color, 0.65);
      ctx.beginPath(); ctx.arc(0, 0, radius * (1.18 + pulse * 0.04), 0.1, Math.PI * 1.75); ctx.stroke();
      ctx.setLineDash([radius * 0.08, radius * 0.24]);
      ctx.lineWidth = 0.7 + (index % 4) * 0.35;
      ctx.strokeStyle = colorWithAlpha(index % 2 ? '#ff2bd6' : '#00f0ff', 0.5);
      ctx.beginPath(); ctx.arc(0, 0, radius * 1.38, -1.7, 0.9); ctx.stroke();
      ctx.restore();
      // FID-2026-0807-008 F2: the ROOT region is the universe's brand
      // backdrop — render the Savant logo at the planet's core (inside the
      // ambient halo + orbit rings) instead of a generic planet body. Other
      // regions keep the procedural planet so the mark stays a single focal
      // point. Falls back to the procedural body while the image decodes.
      if (region.path === 'root') {
        if (!brandLogo) {
          // Reuse the header logo's data URI (the base64 constant is a
          // multi-line template literal; re-reading it from the DOM keeps the
          // app script a single-line-safe JS string and avoids a second
          // ~250 KB copy of the payload in the artifact).
          var headerLogo = document.querySelector('.logo');
          brandLogo = new Image();
          brandLogo.src = headerLogo ? headerLogo.getAttribute('src') : '';
        }
        if (brandLogo.complete && brandLogo.naturalWidth > 0) {
          var logoSize = radius * 1.32;
          ctx.save();
          if (ctx.filter !== undefined) ctx.filter = 'brightness(1.35) saturate(1.15)';
          ctx.shadowBlur = 24 + pulse * 12; ctx.shadowColor = color;
          ctx.drawImage(brandLogo, point.x - logoSize / 2, point.y - logoSize / 2, logoSize, logoSize);
          if (ctx.filter !== undefined) ctx.filter = 'none';
          ctx.lineWidth = 2 + pulse; ctx.strokeStyle = colorWithAlpha(color, 0.85);
          ctx.beginPath(); ctx.arc(point.x, point.y, logoSize / 2 + 2, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        } else {
          drawPlanetBody(ctx, point, radius, color, pulse);
        }
      } else {
        drawPlanetBody(ctx, point, radius, color, pulse);
      }
    });
  }
  function animatePlanetEffects() {
    if (document.hidden || reducedMotion) { motionFrame = 0; return; }
    drawPlanetEffects();
    motionFrame = requestAnimationFrame(animatePlanetEffects);
  }
  function initializePlanetEffects() {
    planetCanvas = document.getElementById('planet-effects');
    if (!planetCanvas) return;
    document.querySelector('.universe-shell').classList.toggle('motion-off', reducedMotion);
    window.addEventListener('resize', drawPlanetEffects);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (motionFrame) cancelAnimationFrame(motionFrame);
        motionFrame = 0;
      } else if (!reducedMotion && !motionFrame) {
        motionFrame = requestAnimationFrame(animatePlanetEffects);
      }
      drawPlanetEffects();
    });
    if (!reducedMotion && !motionFrame) motionFrame = requestAnimationFrame(animatePlanetEffects);
  }

  function reduceNode(id, attrs) {
    var data = nodeData(id);
    var result = Object.assign({}, attrs);
    if (!data) return result;
    result.hidden = false;
    if (data.kind === 'region' || data.fileCount !== undefined) {
      result.color = attrs.color || '#00f0ff'; result.size = attrs.size || 20; result.label = attrs.label; result.zIndex = selected === id ? 12 : 2;
      if (selected && selected !== id && !isContextNode(id)) result.alpha = 0.28;
      // FID-2026-0807-009 F9: the ROOT region's ambient emblem (logo planet)
      // is the backdrop — shrink its sigma node to a dim dot so the node
      // circle + label never cover the mark. Still clickable via dot + nav.
      if (data.kind === 'region' && data.path === 'root' && selected !== id && state !== 'detail') {
        result.size = 4; result.label = ''; result.alpha = 0.32; result.zIndex = 1;
      }
    } else {
      result.color = attrs.color || '#a7b4d8'; result.size = attrs.size || 4; result.label = state === 'neighborhood' || state === 'detail' ? attrs.label : '';
      if (selected && id !== selected && !isContextNode(id)) { result.color = '#182540'; result.alpha = 0.2; }
    }
    if (selected === id) { result.color = '#ffffff'; result.size = (attrs.size || 5) * 1.8; result.zIndex = 10; result.alpha = 1; }
    return result;
  }
  function reduceEdge(id, attrs) {
    var result = Object.assign({}, attrs);
    var ext = graph.extremities(id); var corridor = attrs.kind === 'corridor';
    result.hidden = false;
    if (state === 'universe') { result.hidden = !corridor; result.size = corridor ? attrs.size : 0; result.color = corridor ? '#00dbe8' : '#314463'; result.alpha = corridor ? 0.82 : 0; }
    else if (state === 'system') { result.alpha = isContextEdge(ext) ? (corridor ? 0.72 : 0.78) : 0.12; result.color = isContextEdge(ext) ? (corridor ? '#00e5f5' : '#5898bd') : '#17243b'; }
    else { result.alpha = isRelevantEdge(ext) ? 0.98 : 0.1; result.color = isRelevantEdge(ext) ? '#8eeeff' : '#25344f'; }
    return result;
  }
  function isNeighbor(id, root) { return graph.hasNode(root) && graph.hasEdge(root, id); }
  function isContextNode(id) {
    if (!selected) return true;
    if (id === selected) return true;
    var data = nodeData(id);
    var region = regionFor(selected);
    if (!data || !region) return false;
    if (data.kind === 'region' || data.fileCount !== undefined) return true;
    return data.regionId === region.id || (state === 'detail' && isNeighbor(id, selected));
  }
  function isInSelectedSystem(ext) { var r = selected && regionFor(selected); return !!r && ext.some(function (id) { return id === r.id || (nodeData(id) && nodeData(id).regionId === r.id); }); }
  function isContextEdge(ext) { return isInSelectedSystem(ext) || (selected && ext.indexOf(selected) >= 0); }
  function isRelevantEdge(ext) { return selected ? ext.indexOf(selected) >= 0 || isInSelectedSystem(ext) : true; }
  function refresh() { if (sigma) sigma.refresh(); }
  function animateTo(id, ratio) {
    if (!sigma || !graph || !graph.hasNode(id)) return
    var attrs = graph.getNodeAttributes(id)
    sigma.getCamera().animate(
      { x: attrs.x, y: attrs.y, ratio: ratio },
      { duration: reducedMotion ? 0 : 850 },
    )
  }
  function selectionNodes(id) {
    // FID-2026-0807-020: callback iteration instead of graph.nodes().filter()
    // so selection framing never allocates a full node-key array per call.
    if (!graph || !graph.hasNode(id)) return []
    var target = nodeData(id)
    if (!target) return []
    var ids = []
    if (target.kind === 'region' || target.fileCount !== undefined) {
      graph.forEachNode(function (nodeId) {
        var data = nodeData(nodeId)
        if (nodeId === id || (data && data.regionId === id)) ids.push(nodeId)
      })
    } else {
      ids = [id]
      graph.forEachNeighbor(id, function (nodeId) {
        var data = nodeData(nodeId)
        if (!!data && (data.kind === 'region' || data.regionId === target.regionId)) ids.push(nodeId)
      })
    }
    return ids.filter(function (nodeId) {
      var attrs = graph.getNodeAttributes(nodeId)
      return attrs && Number.isFinite(attrs.x) && Number.isFinite(attrs.y)
    })
  }
  function fitSelection(id) {
    if (!sigma || !graph || !graph.hasNode(id)) return
    var ids = selectionNodes(id)
    if (!ids.length) { animateTo(id, 0.5); return }
    var bounds = ids.reduce(function (result, nodeId) {
      var attrs = graph.getNodeAttributes(nodeId)
      return {
        minX: Math.min(result.minX, attrs.x), maxX: Math.max(result.maxX, attrs.x),
        minY: Math.min(result.minY, attrs.y), maxY: Math.max(result.maxY, attrs.y),
      }
    }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
    var spanX = Math.max(bounds.maxX - bounds.minX, 120)
    var spanY = Math.max(bounds.maxY - bounds.minY, 120)
    var viewport = document.getElementById('sigma-container')
    var width = Math.max(viewport ? viewport.clientWidth : 0, 480)
    var height = Math.max(viewport ? viewport.clientHeight : 0, 360)
    var camera = sigma.getCamera()
    var current = camera.getState()
    var ratio = current.ratio
    try {
      var a = sigma.graphToViewport({ x: bounds.minX, y: bounds.minY })
      var b = sigma.graphToViewport({ x: bounds.maxX, y: bounds.maxY })
      var scaleX = Math.abs(b.x - a.x) / spanX
      var scaleY = Math.abs(b.y - a.y) / spanY
      var projected = Math.max(spanX * (scaleX || 0), spanY * (scaleY || 0))
      var available = Math.max(Math.min(width, height) - 96, 240)
      ratio = current.ratio * Math.max(projected / available, 0.08) * 1.18
    } catch (error) {
      ratio = ids.length === 1 ? 0.3 : 0.5
      setStatus('Selection framing fallback · orbit remains available')
      void error
    }
    ratio = Math.max(0.06, Math.min(1.15, ratio))
    camera.animate(
      { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, ratio: ratio },
      { duration: reducedMotion ? 0 : 850 },
    )
  }
  function browserButton(label, className, action, text) {
    var button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.dataset.browserAction = action || ''
    if (action === 'folder') button.dataset.folderId = text
    if (action === 'file') button.dataset.fileId = text
    button.textContent = label
    return button
  }
  function folderChildren(folder) {
    return (folder.childIds || []).map(function (id) {
      return folderById[id] || nodeData(id)
    }).filter(Boolean)
  }
  function folderForFile(fileId) {
    if (!nodeData(fileId)) return folderById[DATA.universe.rootFolderId]
    return (DATA.universe.folders || []).find(function (folder) {
      return (folder.childIds || []).indexOf(fileId) >= 0
    }) || folderById[DATA.universe.rootFolderId]
  }
  function formatBytes(n) {
    if (!n) return ''
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B'
  }
  function siblingFiles() {
    var folder = folderById[browserFolderId || DATA.universe.rootFolderId]
    if (!folder || !folder.childIds) return []
    var out = []
    folder.childIds.forEach(function (id) {
      var child = nodeData(id)
      if (child && !child.childIds) out.push(child)
    })
    return out
  }
  function renderDocument(file) {
    var root = document.getElementById('center-browser')
    if (!root) return
    var doc = documentsData && documentsData[file.id]
    if (
      doc === undefined &&
      DATA.universe.documentPolicy.enabled &&
      documentsData &&
      !Object.keys(documentsData).length
    ) {
      // Documents are enabled but the lazy payload has not finished decoding
      // yet — await it once, then render with the resolved body.
      void documentsReady.then(function () {
        var current = documentsData && documentsData[file.id]
        renderDocumentBody(file, current)
      })
      return
    }
    renderDocumentBody(file, doc)
  }
  function renderDocumentBody(file, doc) {
    var root = document.getElementById('center-browser')
    if (!root) return
    root.textContent = ''
    var header = document.createElement('div'); header.className = 'document-header'
    var toolbar = document.createElement('div'); toolbar.className = 'document-toolbar'
    var navigation = document.createElement('div'); navigation.className = 'document-navigation'; navigation.setAttribute('role', 'group'); navigation.setAttribute('aria-label', 'Document navigation')
    var back = browserButton('← BACK TO FOLDER', 'browser-back', 'document-back', '')
    back.onclick = function () { browserDocumentId = null; playSound('close'); renderCenterBrowser() }
    navigation.appendChild(back)
    toolbar.appendChild(navigation)
    var actionsSlot = document.getElementById('center-focus-actions')
    if (actionsSlot) actionsSlot.textContent = ''
    if (doc && doc.kind === 'text') {
      var copy = document.createElement('button'); copy.type = 'button'; copy.className = 'document-copy'
      copy.textContent = '⧉ COPY CONTENT'
      copy.onclick = function () { copyDocumentContent(file, doc) }
      if (actionsSlot) actionsSlot.appendChild(copy)
      var wrap = document.createElement('button'); wrap.type = 'button'; wrap.className = 'document-wrap-btn'; wrap.id = 'document-wrap-toggle'
      wrap.textContent = docWrapOff ? '⤼ NO WRAP' : '⤺ WRAP'; wrap.title = 'Toggle line wrapping'
      wrap.onclick = function () { toggleDocWrap(wrap) }
      toolbar.appendChild(wrap)
    }
    var sibs = siblingFiles()
    var sibIndex = sibs.indexOf(file)
    if (sibs.length > 1) {
      var prev = browserButton('← PREV FILE', 'browser-back', 'doc-prev', '')
      prev.disabled = sibIndex <= 0
      prev.onclick = function () { browserDocumentId = sibs[sibIndex - 1].id; playSound('open'); renderDocument(nodeData(browserDocumentId)) }
      var next = browserButton('NEXT FILE →', 'browser-back', 'doc-next', '')
      next.disabled = sibIndex < 0 || sibIndex >= sibs.length - 1
      next.onclick = function () { browserDocumentId = sibs[sibIndex + 1].id; playSound('open'); renderDocument(nodeData(browserDocumentId)) }
      navigation.appendChild(prev); navigation.appendChild(next)
    }
    header.appendChild(toolbar)
    var title = document.createElement('h2'); title.textContent = file.label
    var metaBadge = document.createElement('span'); metaBadge.className = 'document-file-meta'
    if (doc && doc.kind === 'text') {
      metaBadge.textContent = '[' + doc.lineCount + ' lines' + (doc.truncated ? ' · truncated' : '') + ' · ' + doc.byteCount + ' bytes' + (doc.explicitlyCapped ? ' · explicit cap' : '') + ']'
    } else if (doc && doc.kind === 'image') {
      metaBadge.textContent = '[' + doc.mime + ' · ' + doc.byteCount + ' bytes]'
    } else {
      metaBadge.textContent = '[' + (DATA.universe.documentPolicy.enabled ? 'content unavailable' : 'documents disabled') + ']'
    }
    title.appendChild(metaBadge)
    header.appendChild(title)
    var pathEl = document.createElement('code'); pathEl.textContent = file.path; header.appendChild(pathEl)
    var crumbs = document.createElement('nav'); crumbs.className = 'document-breadcrumb'; crumbs.setAttribute('aria-label', 'File path')
    var segments = String(file.path || '').split('/').filter(Boolean)
    var acc = ''
    segments.forEach(function (segment, index) {
      var isLast = index === segments.length - 1
      if (index > 0) {
        var sep = document.createElement('span'); sep.className = 'document-breadcrumb-sep'; sep.textContent = '/'
        crumbs.appendChild(sep)
      }
      if (isLast) {
        var leaf = document.createElement('span'); leaf.className = 'document-breadcrumb-leaf'; leaf.textContent = segment
        crumbs.appendChild(leaf)
      } else {
        acc = acc ? acc + '/' + segment : segment
        var folder = folderByPath[acc]
        var crumb = document.createElement('button'); crumb.type = 'button'; crumb.className = 'document-breadcrumb-folder'
        crumb.textContent = segment
        crumb.onclick = function () {
          if (folder) navigateToFolder(folder)
          else setStatus('Folder not exported in this universe')
        }
        crumbs.appendChild(crumb)
      }
    })
    header.appendChild(crumbs)
    root.appendChild(header)
    updateWindowTitle(document.getElementById('center-focus'))
    if (doc && doc.kind === 'text' && doc.explicitlyCapped && doc.truncated) {
      var banner = document.createElement('div'); banner.className = 'document-preview-banner'
      banner.setAttribute('role', 'note')
      var glyph = document.createElement('span'); glyph.className = 'document-preview-glyph'; glyph.textContent = 'i'
      banner.appendChild(glyph)
      banner.appendChild(document.createTextNode(' TEXT CAPPED BY EXPLICIT EXPORT LIMIT — showing ' + doc.lineCount + ' lines from ' + formatBytes(doc.byteCount) + '.'))
      root.appendChild(banner)
    }
    var surface = document.createElement('div'); surface.className = 'document-surface'
    if (docWrapOff) surface.classList.add('wrap-off')
    if (doc && doc.kind === 'text') {
      if (doc.lineCount > LARGE_DOCUMENT_LINE_THRESHOLD) {
        var largeNote = document.createElement('div'); largeNote.className = 'large-document-note'; largeNote.textContent = 'LINE NUMBERS HIDDEN FOR LARGE FILE · ' + doc.lineCount + ' LINES'
        surface.appendChild(largeNote)
        var pre = document.createElement('pre'); pre.className = 'document-compact-text'; pre.textContent = doc.text
        surface.appendChild(pre)
      } else {
        doc.text.split(String.fromCharCode(10)).forEach(function (line, index) {
          var row = document.createElement('div'); row.className = 'document-line'
          var number = document.createElement('span'); number.className = 'document-line-number'; number.textContent = String(index + 1)
          var content = document.createElement('code'); content.textContent = line
          row.appendChild(number); row.appendChild(content); surface.appendChild(row)
        })
      }
    } else if (doc && doc.kind === 'image') {
      var image = document.createElement('img')
      image.className = 'document-image'
      image.src = doc.dataUri
      image.alt = file.path
      image.loading = 'eager'
      image.onerror = function () {
        playSound('warning')
        image.remove()
        var failedImage = document.createElement('div')
        failedImage.className = 'document-unavailable'
        var glyph = document.createElement('span'); glyph.className = 'document-unavailable-glyph'; glyph.textContent = '⚠'
        var strong = document.createElement('strong'); strong.textContent = 'DOCUMENT UNAVAILABLE'
        var hint = document.createElement('small'); hint.textContent = 'The embedded image could not be decoded by this browser.'
        failedImage.appendChild(glyph); failedImage.appendChild(strong); failedImage.appendChild(hint)
        surface.appendChild(failedImage)
      }
      surface.appendChild(image)
    } else {
      var reason = doc && doc.kind === 'unavailable' ? doc.unavailableReason : 'disabled'
      var unavailable = document.createElement('div'); unavailable.className = 'document-unavailable'
      var glyph = document.createElement('span'); glyph.className = 'document-unavailable-glyph'
      glyph.textContent = reason === 'binary' ? '◇' : '◌'
      var strong = document.createElement('strong')
      strong.textContent = reason === 'binary' ? 'BINARY CONTENT NOT EXPORTED' : reason === 'disabled' ? 'DOCUMENT NOT EXPORTED' : 'DOCUMENT UNAVAILABLE'
      var hint = document.createElement('small')
      hint.textContent = reason === 'binary'
        ? 'This file is binary or uses an unsupported format. Text documents are unlimited by default; binary media remains protected.'
        : reason === 'disabled'
          ? 'Document content is disabled for this export. Enable documents when exporting to read it here.'
          : 'The document could not be read safely from the project root.'
      unavailable.appendChild(glyph); unavailable.appendChild(strong); unavailable.appendChild(hint)
      if (doc && doc.byteCount) {
        var size = document.createElement('small'); size.className = 'document-size-note'
        size.textContent = 'Source file: ' + formatBytes(doc.byteCount)
        unavailable.appendChild(size)
      }
      surface.appendChild(unavailable)
    }
    root.appendChild(surface)
  }
  function renderCenterBrowser() {
    var focus = document.getElementById('center-focus'); var root = document.getElementById('center-browser')
    if (!focus || !root) return
    focus.classList.remove('hidden'); root.textContent = ''
    var actionsSlot = document.getElementById('center-focus-actions')
    if (actionsSlot) actionsSlot.textContent = ''
    if (browserDocumentId) { renderDocument(nodeData(browserDocumentId)); return }
    var folder = folderById[browserFolderId || DATA.universe.rootFolderId]
    if (!folder) return
    var heading = document.createElement('div'); heading.className = 'browser-heading'
    var eyebrow = document.createElement('div'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'CODE EXPLORER / FOLDER'; heading.appendChild(eyebrow)
    var title = document.createElement('h2'); title.textContent = folder.label; heading.appendChild(title)
    var pathEl = document.createElement('code'); pathEl.textContent = folder.path || '/'; heading.appendChild(pathEl); root.appendChild(heading)
    updateWindowTitle(focus)
    var children = folderChildren(folder); var pageSize = folder.parentId ? 118 : 119
    var start = browserPage * pageSize; var visible = children.slice(start, start + pageSize)
    var grid = document.createElement('div'); grid.className = children.length === 1 ? 'browser-grid single' : 'browser-grid'
    if (folder.parentId) {
      var up = browserButton('↑ UP / BACK', 'browser-card browser-up', 'up', '')
      up.onclick = function () { browserFolderId = folder.parentId; browserPage = 0; playSound('close'); renderCenterBrowser() }; grid.appendChild(up)
    }
    visible.forEach(function (child) {
      var isFolder = !!child.childIds
      var card = browserButton((isFolder ? '◈ ' : '✦ ') + (child.label || child.path), 'browser-card ' + (isFolder ? 'folder-card' : 'file-card'), isFolder ? 'folder' : 'file', child.id)
      var detail = document.createElement('small'); detail.textContent = isFolder ? ((child.childIds || []).length + ' items') : (child.path || '')
      card.appendChild(detail)
      card.onclick = function () { if (isFolder) { browserFolderId = child.id; browserPage = 0; playSound('open'); renderCenterBrowser() } else { browserDocumentId = child.id; playSound('open'); renderCenterBrowser() } }
      grid.appendChild(card)
    })
    if (!visible.length) { var empty = document.createElement('div'); empty.className = 'browser-empty'; empty.textContent = 'EMPTY ORBIT · NO CHILDREN EXPORTED'; grid.appendChild(empty) }
    if (start + pageSize < children.length) {
      var next = browserButton('MORE / NEXT →', 'browser-card browser-next', 'next', '')
      next.onclick = function () { browserPage += 1; renderCenterBrowser() }; grid.appendChild(next)
    }
    root.appendChild(grid)
  }
  function renderFocusView(n, kind) {
    var isSystem = n.fileCount !== undefined
    browserFolderId = isSystem ? (DATA.universe.folders || []).find(function (folder) { return folder.path === n.path })?.id : folderForFile(n.id)?.id
    browserFolderId = browserFolderId || DATA.universe.rootFolderId
    browserDocumentId = isSystem ? null : n.id
    browserPage = 0
    renderCenterBrowser()
  }
  function clearFocusView() {
    var focus = document.getElementById('center-focus')
    if (focus) focus.classList.add('hidden')
  }
  function fitUniverse() {
    fitUniverseInternal(false)
  }
  function fitUniverseSilently() {
    fitUniverseInternal(true)
  }
  function fitUniverseInternal(silent) {
    if (sigma) sigma.getCamera().animatedReset({ duration: reducedMotion ? 0 : 700 })
    setState('universe')
    selected = null
    selectedRegion = null
    document.querySelectorAll('.region-row').forEach(function (row) { row.classList.remove('active') })
    document.querySelectorAll('.region-nav [data-nav-id]').forEach(function (el) { el.classList.remove('nav-active') })
    refresh()
    drawPlanetEffects()
    hideUniverseTooltip()
    closeSidebar(silent)
    clearFocusView()
  }
  function resetUniverse() {
    fitUniverse()
    setStatus('Universe restored · select a system to enter its orbit')
  }
  function updateZoomState() {
    if (!sigma) return
    var ratio = sigma.getCamera().getState().ratio
    if (state === 'universe' && ratio < 0.62) {
      setState('system')
      refresh()
    } else if (state === 'system' && ratio > 0.86 && !selected) {
      setState('universe')
      refresh()
    } else if (state === 'system' && ratio < 0.32) {
      setState('neighborhood')
      refresh()
    } else if (state === 'neighborhood' && ratio > 0.48) {
      setState('system')
      refresh()
    }
  }
  function navigateToObject(id) {
    navigateToObjectWithCue(id, 'open')
  }
  function navigateToObjectWithCue(id, cue) {
    var n = nodeData(id)
    if (!n) {
      setStatus('That universe object is no longer available')
      return
    }
    selected = id
    var region = regionFor(id)
    selectedRegion = region && region.id
    document.querySelectorAll('.region-row').forEach(function (row) {
      row.classList.toggle('active', row.dataset.regionId === String(region && region.id))
    })
    highlightNav(id)
    playSound(cue || 'open')
    if (n.fileCount !== undefined) {
      setState('system')
      openSidebar(n, 'SYSTEM')
      renderFocusView(n, 'SYSTEM ORBIT')
      setStatus('Entering orbit of ' + n.label)
      fitSelection(id)
    } else {
      setState('detail')
      openSidebar(n, 'FILE')
      renderFocusView(n, 'FILE NODE')
      setStatus('Inspecting ' + n.path)
      fitSelection(id)
    }
    if (n.fileCount === undefined) revealInNav(id)
    refresh()
    drawPlanetEffects()
  }
  function selectEdge(id) {
    if (!graph || !graph.hasEdge(id)) return;
    var ext = graph.extremities(id);
    var attrs = graph.getEdgeAttributes(id);
    navigateToObject(ext[0]);
    setStatus((attrs.label || 'Relationship') + ' · connected path selected');
  }
  function searchScore(entry, query) {
    var label = (entry.label || '').toLowerCase();
    var path = (entry.path || '').toLowerCase();
    var segments = path.split('/');
    if (label === query) return 100;
    if (label.indexOf(query) === 0) return 80;
    if (segments.indexOf(query) >= 0) return 60;
    if (label.indexOf(query) >= 0) return 45;
    if ((segments[segments.length - 1] || '').indexOf(query) >= 0) return 30;
    if (path.indexOf(query) >= 0) return 20;
    return 0;
  }
  function kindOrder(kind) { return kind === 'system' ? 0 : kind === 'folder' ? 1 : 2; }
  function kindGlyph(kind) { return kind === 'system' ? '◎' : kind === 'folder' ? '◈' : '✦'; }
  function renderSearchResults(query) {
    var panel = document.getElementById('search-results');
    if (!panel) return;
    panel.textContent = '';
    query = (query || '').trim().toLowerCase();
    if (!query) { closeSearchPanel(); return; }
    var scored = [];
    for (var i = 0; i < searchIndex.length; i += 1) {
      var score = searchScore(searchIndex[i], query);
      if (score > 0) scored.push({ entry: searchIndex[i], score: score });
    }
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var kindDiff = kindOrder(a.entry.kind) - kindOrder(b.entry.kind);
      if (kindDiff !== 0) return kindDiff;
      return (a.entry.label || '').length - (b.entry.label || '').length;
    });
    if (!scored.length) {
      var empty = document.createElement('div'); empty.className = 'search-empty'
      empty.textContent = 'NO MATCHES FOR “' + query + '”'
      panel.appendChild(empty); panel.classList.remove('hidden'); searchActive = -1; return
    }
    var inputEl = document.getElementById('universe-search-input')
    if (inputEl) inputEl.setAttribute('aria-expanded', 'true')
    var limit = 12
    scored.slice(0, limit).forEach(function (item, index) {
      var row = document.createElement('button')
      row.type = 'button'
      row.className = 'search-row'
      row.id = 'search-option-' + index
      row.setAttribute('role', 'option')
      row.dataset.searchId = item.entry.id
      var glyph = document.createElement('span'); glyph.className = 'search-glyph'; glyph.textContent = kindGlyph(item.entry.kind)
      var text = document.createElement('span'); text.className = 'search-text'
      text.appendChild(highlightMatch(item.entry.label || item.entry.path, query))
      var pathEl = document.createElement('small'); pathEl.className = 'search-path'; pathEl.textContent = item.entry.path || ''
      text.appendChild(pathEl)
      row.appendChild(glyph); row.appendChild(text)
      row.onclick = function () { selectSearchRow(index); }
      panel.appendChild(row)
    })
    if (scored.length > limit) {
      var more = document.createElement('div'); more.className = 'search-more'
      more.textContent = '+' + (scored.length - limit) + ' MORE'
      panel.appendChild(more)
    }
    panel.classList.remove('hidden')
    setSearchActive(0)
  }
  function highlightMatch(text, query) {
    var frag = document.createDocumentFragment()
    var lower = String(text || '').toLowerCase()
    var at = lower.indexOf(query)
    if (at < 0) { frag.appendChild(document.createTextNode(String(text || ''))); return frag }
    if (at > 0) frag.appendChild(document.createTextNode(String(text).slice(0, at)))
    var mark = document.createElement('mark'); mark.textContent = String(text).slice(at, at + query.length)
    frag.appendChild(mark)
    if (at + query.length < String(text).length) frag.appendChild(document.createTextNode(String(text).slice(at + query.length)))
    return frag
  }
  function setSearchActive(next) {
    var panel = document.getElementById('search-results')
    if (!panel) return
    var rows = panel.querySelectorAll('.search-row')
    if (!rows.length) { searchActive = -1; return }
    searchActive = Math.max(0, Math.min(next, rows.length - 1))
    rows.forEach(function (row, index) {
      var active = index === searchActive
      row.classList.toggle('active', active)
      row.setAttribute('aria-selected', String(active))
      if (active && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
    })
    var input = document.getElementById('universe-search-input')
    if (input) input.setAttribute('aria-activedescendant', activeRowId(searchActive))
  }
  function activeRowId(index) {
    var panel = document.getElementById('search-results')
    if (!panel) return ''
    var rows = panel.querySelectorAll('.search-row')
    return rows[index] ? rows[index].id : ''
  }
  function selectSearchRow(index) {
    var panel = document.getElementById('search-results')
    if (!panel) return
    var rows = panel.querySelectorAll('.search-row')
    var row = rows[index]
    if (!row) return
    var id = row.dataset.searchId
    if (!id) return
    closeSearchPanel()
    var folder = folderById[id]
    if (folder) {
      // Folders live in folderById, not objectById — route through the
      // center browser directly instead of the node navigator. Mirror the
      // detail state so the pill/zoom state stay consistent with the open
      // explorer.
      browserFolderId = folder.id
      browserDocumentId = null
      browserPage = 0
      setState('detail')
      playSound('open')
      renderCenterBrowser()
      refresh()
      setStatus('Exploring ' + (folder.path || folder.label))
      return
    }
    navigateToObjectWithCue(id, 'confirm')
    var n = nodeData(id)
    setStatus('Traveling to ' + ((n && (n.path || n.label)) || id))
  }
  function closeSearchPanel() {
    var panel = document.getElementById('search-results')
    if (panel) panel.classList.add('hidden')
    searchActive = -1
    var input = document.getElementById('universe-search-input')
    if (input) {
      input.removeAttribute('aria-activedescendant')
      input.setAttribute('aria-expanded', 'false')
    }
  }
  function handleSearchInput() {
    var input = document.getElementById('universe-search-input')
    var query = input && input.value || ''
    if (!query.trim()) { closeSearchPanel(); return }
    renderSearchResults(query)
  }
  function searchUniverse(event) {
    if (event) event.preventDefault();
    var input = document.getElementById('universe-search-input');
    var query = (input && input.value || '').trim().toLowerCase();
    if (!query) { closeSearchPanel(); return; }
    var panel = document.getElementById('search-results');
    if (panel && panel.classList.contains('hidden')) {
      renderSearchResults(query);
    }
    var rows = panel ? panel.querySelectorAll('.search-row') : [];
    if (searchActive >= 0 && rows[searchActive]) {
      selectSearchRow(searchActive);
      return;
    }
    if (rows.length > 0) { setSearchActive(0); selectSearchRow(0); return; }
    playSound('warning'); setStatus('No universe object matches “' + query + '”');
  }
  function copySelectedPath() {
    var path = selected && nodeData(selected) && nodeData(selected).path;
    if (!path) return;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(path).then(function () { setStatus('Copied ' + path); });
    else setStatus(path);
  }
  function copyDocumentContent(file, doc) {
    if (!doc || doc.kind !== 'text' || !doc.text) { setStatus('Nothing to copy for this document'); return; }
    var done = function () { setStatus('Copied ' + (file.path || file.label) + ' (' + doc.text.length + ' chars)'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(doc.text).then(done).catch(function () { setStatus('Copy blocked by browser — select the text manually'); });
      return;
    }
    var textarea = document.createElement('textarea');
    textarea.value = doc.text;
    textarea.style.position = 'fixed'; textarea.style.opacity = '0';
    document.body.appendChild(textarea); textarea.select();
    try { document.execCommand('copy'); done(); } catch (error) { setStatus('Copy unavailable in this browser'); void error; }
    document.body.removeChild(textarea);
  }
  // Document readability toggle (FID-2026-0807-014 F8): wrap toggles pre-wrap
  // vs pre (horizontal scroll). Font-size buttons removed (FID-2026-0807-021).
  function toggleDocWrap(btn) {
    var surface = document.querySelector('.document-surface')
    if (!surface) return
    docWrapOff = surface.classList.toggle('wrap-off')
    if (btn) btn.textContent = docWrapOff ? '⤼ NO WRAP' : '⤺ WRAP'
    playSound('toggle')
    setStatus(docWrapOff ? 'Word wrap off · horizontal scroll enabled' : 'Word wrap on')
  }
  function openSidebar(n, kind) {
    var side = document.getElementById('graph-sidebar'); side.classList.remove('hidden');
    document.getElementById('sidebar-kind').textContent = kind || 'SELECTED OBJECT';
    document.getElementById('sidebar-title').textContent = n.label || n.path;
    document.getElementById('sidebar-path').textContent = n.path || '';
    var metrics = document.getElementById('sidebar-metrics'); metrics.textContent = '';
    var values = n.fileCount !== undefined ? [['FILES', n.fileCount], ['EDGES', n.edgeCount], ['STATUS', n.disconnected ? 'ISOLATED' : 'CONNECTED']] : [['REGION', (regionFor(n.id) || {}).label || '—'], ['IMPORTANCE', Math.round((n.importance || 0) * 100) + '%'], ['CLUSTER', n.cluster === null || n.cluster === undefined ? '—' : n.cluster]];
    values.forEach(function (pair) { var item = document.createElement('span'); item.textContent = pair[0] + ' ' + pair[1]; metrics.appendChild(item); });
    var list = document.getElementById('sidebar-connections'); list.textContent = '';
    var neighbors = graph && graph.hasNode(n.id) ? graph.neighbors(n.id).slice(0, 12) : [];
    if (!neighbors.length) { var empty = document.createElement('li'); empty.textContent = 'No direct connections'; list.appendChild(empty); }
    updateSoundUi();
    neighbors.forEach(function (id) { var li = document.createElement('li'); var other = nodeData(id); li.textContent = other ? (other.path || other.label) : id; list.appendChild(li); });
    document.getElementById('sidebar-preview').textContent = n.preview || 'No preview (previews are opt-in at export time).';
    updateWindowTitle(side);
  }
  function closeSidebar(silent) {
    document.getElementById('graph-sidebar').classList.add('hidden')
    clearFocusView()
    if (!silent && !audioBootstrapping) playSound('close')
  }
  function buildRegionNav() {
    var root = document.getElementById('region-list'); root.textContent = '';
    DATA.universe.regions.forEach(function (r, index) {
      var item = document.createElement('div'); item.className = 'region-item'
      var row = document.createElement('button'); row.type = 'button'; row.className = 'region-row'; row.dataset.regionId = r.id; row.id = 'region-row-' + index
      var tree = regionRootTree(r)
      var hasChildren = Object.keys(tree.folders).length > 0 || tree.files.length > 0
      var chevron = document.createElement('span'); chevron.className = 'region-chevron'; chevron.textContent = hasChildren ? '▸' : ''
      var label = document.createElement('span'); label.className = 'region-label'; label.textContent = r.label
      var count = document.createElement('span'); count.className = 'region-count'; count.textContent = String(r.fileCount)
      row.appendChild(chevron); row.appendChild(label); row.appendChild(count)
      row.onclick = function () { navigateToObject(r.id); toggleRegionFiles(item, r); navKeyFocusRow(row) }
      item.appendChild(row)
      var list = document.createElement('div'); list.className = 'region-files hidden'; list.id = 'region-files-' + index
      if (hasChildren) { row.setAttribute('aria-expanded', 'false'); row.setAttribute('aria-controls', list.id); }
      item.appendChild(list)
      root.appendChild(item)
    })
  }
  // Trees are folded once per region and rendered level-by-level on expand
  // so a repo with many large regions never pays DOM cost up front.
  function regionSkipSegments(region) {
    if (region.path === 'root') return 0
    return String(region.path || '').split('/').filter(Boolean).length
  }
  function regionRootTree(region) {
    if (!regionTrees[region.id]) {
      regionTrees[region.id] = buildRegionTree(filesByRegion[region.id] || [], regionSkipSegments(region))
    }
    return regionTrees[region.id]
  }
  function buildRegionTree(files, skipSegments) {
    var root = { name: '', path: '', relPath: '', folders: {}, files: [] }
    files.forEach(function (f) {
      var parts = f.path.split('/').filter(Boolean)
      var relParts = parts.slice(skipSegments)
      var node = root
      var full = ''
      var rel = ''
      for (var i = skipSegments; i < parts.length - 1; i++) {
        full = full ? full + '/' + parts[i] : parts[i]
        var relKey = relParts[i - skipSegments]
        rel = rel ? rel + '/' + relKey : relKey
        var child = node.folders[relKey] || (node.folders[relKey] = { name: relKey, path: full, relPath: rel, folders: {}, files: [] })
        node = child
      }
      node.files.push(f)
    })
    return root
  }
  var LEVEL_CAP = 60
  function toggleRegionFiles(item, region) {
    var list = item.querySelector('.region-files')
    var row = item.querySelector('.region-row')
    if (!list) return
    var tree = regionRootTree(region)
    if (Object.keys(tree.folders).length === 0 && tree.files.length === 0) return
    if (!list.children.length) renderTreeLevel(list, tree)
    var open = list.classList.toggle('hidden')
    var chevron = item.querySelector('.region-chevron')
    if (chevron) chevron.textContent = open ? '▸' : '▾'
    if (row) row.setAttribute('aria-expanded', open ? 'false' : 'true')
    playSound(open ? 'close' : 'open')
  }
  function renderTreeLevel(container, node) {
    var folderKeys = Object.keys(node.folders || {}).sort()
    var files = (node.files || []).slice().sort(function (a, b) { return a.label.localeCompare(b.label) })
    var shown = 0
    folderKeys.forEach(function (key) {
      if (shown >= LEVEL_CAP) return
      shown += 1
      renderFolderRow(container, node.folders[key])
    })
    files.forEach(function (f) {
      if (shown >= LEVEL_CAP) return
      shown += 1
      renderFileRow(container, f)
    })
    if (folderKeys.length + files.length > LEVEL_CAP) {
      var more = document.createElement('div'); more.className = 'region-more'
      more.textContent = '+' + (folderKeys.length + files.length - LEVEL_CAP) + ' more in explorer'
      container.appendChild(more)
    }
  }
  function renderFolderRow(container, node) {
    var row = document.createElement('button'); row.type = 'button'; row.className = 'region-tree-folder'
    var folder = folderByPath[node.path]
    row.dataset.treePath = node.relPath
    if (folder) row.dataset.navId = folder.id
    var chevron = document.createElement('span'); chevron.className = 'region-chevron'; chevron.textContent = '▸'
    var name = document.createElement('span'); name.className = 'region-tree-name'; name.textContent = node.name
    var count = document.createElement('span'); count.className = 'region-count'
    count.textContent = String(Object.keys(node.folders).length + node.files.length)
    row.appendChild(chevron); row.appendChild(name); row.appendChild(count)
    var rowSeq = (navRowCounter += 1)
    row.id = 'region-tree-' + rowSeq + '-row'
    var list = document.createElement('div'); list.className = 'region-files hidden'; list.id = 'region-tree-' + rowSeq
    row.setAttribute('aria-expanded', 'false'); row.setAttribute('aria-controls', list.id)
    row.onclick = function () {
      if (folder) navigateToFolder(folder)
      toggleFolderRow(row, node)
      navKeyFocusRow(row)
    }
    container.appendChild(row); container.appendChild(list)
  }
  function renderFileRow(container, file) {
    var button = document.createElement('button'); button.type = 'button'; button.className = 'region-file'
    button.dataset.navId = file.id
    button.id = 'region-file-' + (navRowCounter += 1)
    var name = document.createElement('span'); name.className = 'region-file-name'; name.textContent = file.label
    button.appendChild(name)
    button.onclick = function () { navigateToObjectWithCue(file.id, 'open'); navKeyFocusRow(button) }
    container.appendChild(button)
  }
  function toggleFolderRow(row, node) {
    var list = row.parentElement ? row.parentElement.querySelector('.region-files') : null
    if (!list) return
    if (!list.children.length) renderTreeLevel(list, node)
    var open = list.classList.toggle('hidden')
    var chevron = row.querySelector('.region-chevron')
    if (chevron) chevron.textContent = open ? '▸' : '▾'
    row.setAttribute('aria-expanded', open ? 'false' : 'true')
    playSound(open ? 'close' : 'open')
  }
  // Keyboard navigation over the visible tree rows (FID-2026-0807-014 F5):
  // ArrowUp/Down move focus across region/folder/file rows in DOM order,
  // ArrowRight expands the focused collapsible, ArrowLeft collapses or moves
  // up to its parent row. Rows hidden by a collapsed ancestor are skipped.
  function regionNavRows() {
    return Array.prototype.slice.call(document.querySelectorAll('.region-nav .region-row, .region-nav .region-tree-folder, .region-nav .region-file')).filter(function (row) {
      return row.offsetParent !== null
    })
  }
  function nextRegionList(row) {
    var next = row.nextElementSibling
    return next && next.classList.contains('region-files') ? next : null
  }
  function treeNodeForFolderRow(row) {
    var item = row.closest ? row.closest('.region-item') : null
    var regionRow = item ? item.querySelector('.region-row') : null
    var region = regionRow && systemById[regionRow.dataset.regionId]
    var tree = region ? regionRootTree(region) : null
    if (!tree) return null
    var node = tree
    String(row.dataset.treePath || '').split('/').filter(Boolean).forEach(function (part) {
      if (node) node = node.folders[part]
    })
    return node || null
  }
  function navKeyFocusRow(row) {
    var rows = regionNavRows()
    rows.forEach(function (r) { r.classList.toggle('nav-key-focus', r === row) })
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
    var list = document.getElementById('region-list')
    if (list) list.setAttribute('aria-activedescendant', row && row.id ? row.id : '')
  }
  // Collapse-all / expand-all (FID-2026-0807-014 F6). Expand-all walks each
  // region tree to depth 2 (capped at the existing LEVEL_CAP per level);
  // collapse-all re-hides every region-files container and resets chevrons.
  function expandAllRegions() {
    document.querySelectorAll('.region-item').forEach(function (item) {
      var row = item.querySelector('.region-row')
      var list = item.querySelector('.region-files')
      if (!row || !list) return
      var region = systemById[row.dataset.regionId]
      if (!region) return
      if (!list.children.length) renderTreeLevel(list, regionRootTree(region))
      list.classList.remove('hidden')
      var chevron = item.querySelector('.region-chevron')
      if (chevron && chevron.textContent === '▸') chevron.textContent = '▾'
      row.setAttribute('aria-expanded', 'true')
      expandTreeFolders(list, 2)
    })
    playSound('open')
    setStatus('All systems expanded')
  }
  function expandTreeFolders(container, depth) {
    if (depth <= 0) return
    Array.prototype.slice.call(container.children).forEach(function (row) {
      if (!row.classList.contains('region-tree-folder')) return
      var list = row.nextElementSibling
      var node = treeNodeForFolderRow(row)
      if (!list || !list.classList.contains('region-files') || !node) return
      if (!list.children.length) renderTreeLevel(list, node)
      list.classList.remove('hidden')
      var chevron = row.querySelector('.region-chevron')
      if (chevron && chevron.textContent === '▸') chevron.textContent = '▾'
      row.setAttribute('aria-expanded', 'true')
      expandTreeFolders(list, depth - 1)
    })
  }
  function collapseAllRegions() {
    document.querySelectorAll('.region-files').forEach(function (list) { list.classList.add('hidden') })
    document.querySelectorAll('.region-chevron').forEach(function (chevron) {
      if (chevron.textContent === '▾') chevron.textContent = '▸'
    })
    document.querySelectorAll('.region-row, .region-tree-folder').forEach(function (row) {
      row.setAttribute('aria-expanded', 'false')
    })
    // Drop the keyboard focus marker too — its row just became invisible, so
    // the next ArrowDown/Up restarts from the top instead of jumping stale.
    document.querySelectorAll('.region-nav .nav-key-focus').forEach(function (row) {
      row.classList.remove('nav-key-focus')
    })
    playSound('close')
    setStatus('All systems collapsed')
  }
  function navigateToFolder(folder) {
    browserFolderId = folder.id
    browserDocumentId = null
    browserPage = 0
    setState('detail')
    playSound('open')
    selected = folder.id
    highlightNav(folder.id)
    renderCenterBrowser()
    refresh()
    setStatus('Exploring ' + (folder.path || folder.label))
  }
  function highlightNav(id) {
    var target = String(id)
    document.querySelectorAll('.region-nav [data-nav-id]').forEach(function (el) {
      el.classList.toggle('nav-active', el.dataset.navId === target)
    })
  }
  function revealInNav(id) {
    var n = nodeData(id)
    if (!n || n.fileCount !== undefined) return
    var region = regionFor(id)
    if (!region) return
    var item = null
    var items = document.querySelectorAll('.region-item')
    for (var i = 0; i < items.length; i++) {
      var regionRow = items[i].querySelector('.region-row')
      if (regionRow && regionRow.dataset.regionId === String(region.id)) { item = items[i]; break }
    }
    if (!item) return
    var row = item.querySelector('.region-row')
    if (row && row.getAttribute('aria-expanded') === 'false') toggleRegionFiles(item, region)
    var parts = String(n.path || '').split('/').filter(Boolean).slice(regionSkipSegments(region))
    var acc = ''
    var node = regionTrees[region.id]
    for (var j = 0; j < parts.length - 1; j++) {
      acc = acc ? acc + '/' + parts[j] : parts[j]
      node = node && node.folders[parts[j]]
      var folderRow = item.querySelector('.region-tree-folder[data-tree-path="' + acc + '"]')
      if (!folderRow || !node) return
      if (folderRow.getAttribute('aria-expanded') === 'false') toggleFolderRow(folderRow, node)
    }
    var target = item.querySelector('[data-nav-id="' + id + '"]')
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' })
  }
  function toggleMotion() {
    reducedMotion = !reducedMotion;
    var shell = document.querySelector('.universe-shell');
    if (shell) shell.classList.toggle('motion-off', reducedMotion);
    if (reducedMotion) { if (motionFrame) cancelAnimationFrame(motionFrame); motionFrame = 0; drawPlanetEffects(); }
    else if (!motionFrame) motionFrame = requestAnimationFrame(animatePlanetEffects);
    playSound('click')
    setStatus(reducedMotion ? 'Reduced motion enabled · topology and depth preserved' : 'Full motion enabled · selected paths flow through the universe');
  }
  // OS-style window controls (FID-2026-0807-012 + FID-2026-0807-014). Minimize
  // docks the panel to the viewport bottom as a taskbar bar WITHOUT closing
  // the open document; maximize expands near-fullscreen; close follows
  // per-window semantics — each panel's × closes ONLY that panel, so the
  // sidebar × keeps an open center document and the center × keeps the
  // sidebar. resetUniverse() remains the only close-everything path.
  function windowPanel(btn) { return btn && btn.closest ? btn.closest('.center-focus, .graph-sidebar') : null }
  function updateWindowTitle(panel) {
    var bar = panel.querySelector('.window-title-bar')
    if (!bar) return
    var heading = panel.querySelector('.document-header h2, .browser-heading h2, #sidebar-title')
    // The file-name h2 carries a bracketed meta badge ([711 lines · …]); keep
    // it out of the title-bar text so the bar stays a clean file label.
    var label = ''
    if (heading) {
      var badge = heading.querySelector('.document-file-meta')
      label = heading.textContent.replace(badge ? badge.textContent : '', '').trim()
    }
    bar.textContent = label || 'CODE UNIVERSE'
  }
  function syncDockedTaskbars() {
    var panels = []
    var center = document.getElementById('center-focus')
    var side = document.getElementById('graph-sidebar')
    if (center && center.classList.contains('window-minimized')) panels.push(center)
    if (side && side.classList.contains('window-minimized')) panels.push(side)
    panels.forEach(function (panel, index) { panel.classList.toggle('docked-sibling', index > 0) })
  }
  function windowMinimize(btn) {
    var panel = windowPanel(btn)
    if (!panel) return
    var minimized = panel.classList.toggle('window-minimized')
    if (minimized) {
      panel.classList.remove('window-maximized')
      updateWindowTitle(panel)
    }
    syncDockedTaskbars()
    playSound(minimized ? 'close' : 'open')
    setStatus(minimized ? 'Panel minimized · click the taskbar bar to restore' : 'Panel restored')
  }
  function windowMaximize(btn) {
    var panel = windowPanel(btn)
    if (!panel) return
    var maximized = panel.classList.toggle('window-maximized')
    if (maximized) panel.classList.remove('window-minimized')
    syncDockedTaskbars()
    playSound('click')
    setStatus(maximized ? 'Panel maximized' : 'Panel restored to size')
  }
  function windowClose(btn) {
    var panel = windowPanel(btn)
    if (!panel) return
    panel.classList.remove('window-minimized', 'window-maximized')
    if (panel.classList.contains('graph-sidebar')) {
      panel.classList.add('hidden')
    } else {
      clearFocusView()
    }
    syncDockedTaskbars()
    playSound('close')
    setStatus('Panel closed')
  }
  function windowRestore(btn) {
    var panel = windowPanel(btn)
    if (!panel) return
    panel.classList.remove('window-minimized', 'window-maximized')
    syncDockedTaskbars()
    playSound('open')
    setStatus('Panel restored')
  }
  // Clicking the title bar restores ONLY a minimized taskbar; a click on an
  // open panel's bar is a no-op (the bar is a drag handle, FID-2026-0807-015).
  function windowTitleBarClick(bar) {
    var panel = windowPanel(bar)
    if (panel && panel.classList.contains('window-minimized')) windowRestore(bar)
  }
  // Draggable windows (FID-2026-0807-015 F2): the always-visible title bar is
  // a grab handle. Pointer-based so mouse + touch both work; positions are
  // session-only inline styles (export stays deterministic).
  var dragPanel = null
  var dragStartX = 0
  var dragStartY = 0
  var dragOriginLeft = 0
  var dragOriginTop = 0
  var dragParentLeft = 0
  var dragParentTop = 0
  var dragParentWidth = 0
  var dragParentHeight = 0
  var dragMoved = false
  var dragBar = null
  var dragWasMaximized = false
  function windowDragStart(bar, event) {
    if (!event || (event.button !== undefined && event.button !== 0)) return
    var panel = windowPanel(bar)
    if (!panel) return
    var wasMinimized = panel.classList.contains('window-minimized')
    dragWasMaximized = panel.classList.contains('window-maximized')
    if (wasMinimized) windowRestore(bar)
    if (dragWasMaximized) panel.classList.remove('window-maximized')
    dragPanel = panel
    dragBar = bar
    dragMoved = false
    dragStartX = event.clientX
    dragStartY = event.clientY
    var rect = panel.getBoundingClientRect()
    var parent = panel.offsetParent || panel.parentElement
    var parentRect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 }
    dragParentLeft = parentRect.left
    dragParentTop = parentRect.top
    dragParentWidth = parent && parent.clientWidth ? parent.clientWidth : window.innerWidth
    dragParentHeight = parent && parent.clientHeight ? parent.clientHeight : window.innerHeight
    // Keep the origin in the panel's containing-block coordinate system. Do
    // not write styles yet: a title-bar click without movement must not break
    // the centered/right-anchored responsive layout.
    dragOriginLeft = rect.left - dragParentLeft
    dragOriginTop = rect.top - dragParentTop
    if (bar.setPointerCapture) {
      try { bar.setPointerCapture(event.pointerId) } catch (error) { void error }
    }
    if (event.preventDefault) event.preventDefault()
  }
  function windowDragMove(event) {
    if (!dragPanel) return
    var dx = event.clientX - dragStartX
    var dy = event.clientY - dragStartY
    if (!dragMoved && Math.abs(dx) + Math.abs(dy) < 4) return
    if (!dragMoved) {
      dragMoved = true
      dragPanel.classList.add('window-dragging')
      // Movement crossed the threshold, so now switch from CSS anchoring to
      // explicit containing-block coordinates.
      dragPanel.style.left = Math.round(dragOriginLeft) + 'px'
      dragPanel.style.top = Math.round(dragOriginTop) + 'px'
      dragPanel.style.right = 'auto'
      dragPanel.style.transform = 'none'
    }
    var width = dragPanel.offsetWidth
    var height = dragPanel.offsetHeight
    // Keep at least 48px of the panel inside its containing block. The panel
    // rect and these coordinates are both viewport-relative through the
    // containing-block origin, avoiding header/footer coordinate jumps.
    var nextLeft = Math.max(48 - width, Math.min(dragOriginLeft + dx, dragParentWidth - 48))
    var nextTop = Math.max(48 - height, Math.min(dragOriginTop + dy, dragParentHeight - 48))
    dragPanel.style.left = Math.round(nextLeft) + 'px'
    dragPanel.style.top = Math.round(nextTop) + 'px'
  }
  function windowDragEnd(event) {
    if (!dragPanel) return
    dragPanel.classList.remove('window-dragging')
    if (!dragMoved && dragWasMaximized) {
      dragPanel.classList.add('window-maximized')
    }
    var bar = dragBar || (event && event.currentTarget)
    if (bar && bar.releasePointerCapture && event && event.pointerId !== undefined) {
      try { bar.releasePointerCapture(event.pointerId) } catch (error) { void error }
    }
    dragPanel = null
    dragBar = null
    dragWasMaximized = false
  }
  window.resetUniverse = resetUniverse; window.fitUniverse = fitUniverse; window.closeSidebar = closeSidebar; window.toggleMotion = toggleMotion; window.searchUniverse = searchUniverse; window.copySelectedPath = copySelectedPath; window.playSound = playSound; window.toggleSoundPanel = toggleSoundPanel; window.toggleSound = toggleSound; window.setSoundVolume = setSoundVolume; window.collapseAllRegions = collapseAllRegions; window.expandAllRegions = expandAllRegions; window.windowMinimize = windowMinimize; window.windowMaximize = windowMaximize; window.windowClose = windowClose; window.windowRestore = windowRestore; window.windowTitleBarClick = windowTitleBarClick; window.windowDragStart = windowDragStart; window.windowDragMove = windowDragMove; window.windowDragEnd = windowDragEnd;
  updateSoundUi();
  var searchInput = document.getElementById('universe-search-input');
  if (searchInput) {
    var searchTimer = 0;
    searchInput.addEventListener('input', function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { searchTimer = 0; handleSearchInput(); }, 120);
    });
    searchInput.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        var panel = document.getElementById('search-results');
        var count = panel ? panel.querySelectorAll('.search-row').length : 0;
        if (!count) return;
        event.preventDefault();
        var delta = event.key === 'ArrowDown' ? 1 : -1;
        setSearchActive(searchActive < 0 ? (delta === 1 ? 0 : count - 1) : searchActive + delta);
      } else if (event.key === 'Escape') {
        closeSearchPanel();
        if (document.activeElement === searchInput) searchInput.blur();
        event.stopPropagation();
      } else if (event.key === 'Enter') {
        var panelEl = document.getElementById('search-results');
        var visible = panelEl && !panelEl.classList.contains('hidden') ? panelEl.querySelectorAll('.search-row').length : 0;
        if (visible > 0) { event.preventDefault(); searchUniverse(event); }
      }
    });
  }
  var regionList = document.getElementById('region-list');
  if (regionList) {
    regionList.addEventListener('click', function (event) {
      var row = event.target.closest ? event.target.closest('.region-row, .region-tree-folder, .region-file') : null
      if (row) navKeyFocusRow(row)
    })
    regionList.addEventListener('keydown', function (event) {
      var key = event.key
      if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return
      var rows = regionNavRows()
      if (!rows.length) return
      event.preventDefault()
      var active = rows.indexOf(document.querySelector('.region-nav .nav-key-focus'))
      if (key === 'Home') { navKeyFocusRow(rows[0]); return }
      if (key === 'End') { navKeyFocusRow(rows[rows.length - 1]); return }
      if (key === 'ArrowDown') { navKeyFocusRow(rows[active < 0 ? 0 : Math.min(active + 1, rows.length - 1)]); return }
      if (key === 'ArrowUp') { navKeyFocusRow(rows[active < 0 ? rows.length - 1 : Math.max(0, active - 1)]); return }
      if (active < 0) { navKeyFocusRow(rows[0]); return }
      var row = rows[active]
      if (key === 'ArrowRight') {
        if (row.classList.contains('region-tree-folder')) {
          var list = nextRegionList(row)
          var node = treeNodeForFolderRow(row)
          if (list && node && list.classList.contains('hidden')) toggleFolderRow(row, node)
        } else if (row.classList.contains('region-row')) {
          var item = row.closest('.region-item')
          var region = systemById[row.dataset.regionId]
          var regionListEl = item ? item.querySelector('.region-files') : null
          if (regionListEl && region && regionListEl.classList.contains('hidden')) toggleRegionFiles(item, region)
        }
      } else if (key === 'ArrowLeft') {
        if (row.classList.contains('region-tree-folder')) {
          var list2 = nextRegionList(row)
          var node2 = treeNodeForFolderRow(row)
          if (list2 && node2 && !list2.classList.contains('hidden')) {
            toggleFolderRow(row, node2)
          } else {
            var upRow = row.parentElement ? row.parentElement.previousElementSibling : null
            if (upRow && (upRow.classList.contains('region-row') || upRow.classList.contains('region-tree-folder'))) navKeyFocusRow(upRow)
          }
        } else if (row.classList.contains('region-file')) {
          var fileParent = row.parentElement ? row.parentElement.previousElementSibling : null
          if (fileParent && (fileParent.classList.contains('region-row') || fileParent.classList.contains('region-tree-folder'))) navKeyFocusRow(fileParent)
        } else if (row.classList.contains('region-row')) {
          var item3 = row.closest('.region-item')
          var region3 = systemById[row.dataset.regionId]
          var regionListEl3 = item3 ? item3.querySelector('.region-files') : null
          if (regionListEl3 && region3 && !regionListEl3.classList.contains('hidden')) toggleRegionFiles(item3, region3)
        }
      }
    })
  }
  function escDismiss() {
    // Staged dismissal (FID-2026-0807-014 F1): the first Escape only removes
    // the visible overlay layer — restores a minimized taskbar, otherwise
    // hides the sidebar AND the center focus — while preserving the selection
    // and zoom state (STATE_PILL stays DETAIL). Only a second Escape (nothing
    // left open) restores the universe to MACRO.
    var minimized = document.querySelectorAll('.center-focus.window-minimized, .graph-sidebar.window-minimized')
    if (minimized.length) {
      minimized.forEach(function (panel) { panel.classList.remove('window-minimized', 'window-maximized') })
      syncDockedTaskbars()
      playSound('open')
      setStatus('Panel restored')
      return
    }
    var sidebar = document.getElementById('graph-sidebar')
    var focus = document.getElementById('center-focus')
    var anyVisible = (sidebar && !sidebar.classList.contains('hidden')) || (focus && !focus.classList.contains('hidden'))
    if (anyVisible) {
      if (sidebar && !sidebar.classList.contains('hidden')) {
        sidebar.classList.add('hidden')
        sidebar.classList.remove('window-minimized', 'window-maximized')
      }
      if (focus && !focus.classList.contains('hidden')) {
        clearFocusView()
        focus.classList.remove('window-minimized', 'window-maximized')
      }
      playSound('close')
      setStatus('Panels dismissed · selection preserved')
      return
    }
    resetUniverse()
  }
  document.addEventListener('keydown', function (event) {
    var target = event.target
    var typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    // Search shortcut (FID-2026-0807-014 F10): '/' or Ctrl/Cmd+K focuses the
    // universe search. Skipped while the user is typing so '/' typed into any
    // input never hijacks it.
    if (!typing && (event.key === '/' || ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K')))) {
      event.preventDefault()
      var searchInputEl = document.getElementById('universe-search-input')
      if (searchInputEl) { searchInputEl.focus(); searchInputEl.select() }
      playSound('toggle')
      return
    }
    if (event.key !== 'Escape') return
    var results = document.getElementById('search-results')
    if (results && !results.classList.contains('hidden')) {
      closeSearchPanel()
      event.stopPropagation()
      return
    }
    escDismiss()
  });
  try { buildGraph(); } catch (error) { showGraphFailure('WebGL unavailable. ' + DATA.meta.files + ' files, ' + DATA.meta.edges + ' relationships indexed. Use the systems list to inspect regions and full paths.'); }
})();
`
