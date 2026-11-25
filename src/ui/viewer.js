const THREE = require('three');
const { Viewer } = require('prismarine-viewer/viewer/lib/viewer');
const { io } = require('socket.io-client');

window.createBotViewer = async function (container, report, signal) {
  const assets = await fetch('/viewer/blocksStates/1.21.4.json', { signal });
  if (!assets.ok) throw new Error('Java-Blockmodelle konnten nicht geladen werden.');
  const blockStates = await assets.json();
  const atlas = new Image();
  atlas.src = '/viewer/textures/1.21.4.png';
  await atlas.decode();
  signal?.throwIfAborted();
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  let viewer;
  try { viewer = new Viewer(renderer); }
  catch (error) { renderer.dispose(); renderer.forceContextLoss(); throw error; }
  viewer.world.blockStatesData = blockStates;
  viewer.playerHeight = 0; // Bot positions already contain eye height.
  container.append(renderer.domElement);
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label', '3D-Umgebung. Ziehen zum Umsehen, WASD zum Bewegen, Q/E abwärts/aufwärts.');
  let disposed = false;
  let frame = 0;
  let session = null;
  let pose = null;
  let mode = 'free';
  let invertX = false;
  let invertY = false;
  let centered = false;
  let yaw = 0;
  let pitch = 0;
  let drag = null;
  let lastTime = performance.now();
  const keys = new Set();
  const abort = new AbortController();
  const listen = (target, name, fn) => target.addEventListener(name, fn, { signal: abort.signal });
  const home = () => {
    if (!pose?.position) return;
    viewer.camera.position.copy(pose.position);
    yaw = pose.yaw; pitch = pose.pitch;
    centered = true;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    socket.disconnect();
    cancelAnimationFrame(frame);
    observer.disconnect();
    abort.abort();
    keys.clear();
    viewer.resetAll();
    for (const worker of viewer.world.workers) worker.terminate();
    viewer.world.material.map?.dispose();
    viewer.world.material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  const socket = io({ path: '/api/viewer/socket', transports: ['websocket'], autoConnect: false, reconnection: false });
  const fail = message => { if (!disposed) { report(message, true); dispose(); } };
  socket.on('reset', data => {
    if (disposed) return;
    session = data.session;
    pose = null; centered = false;
    keys.clear();
    viewer.resetAll();
    if (!viewer.setVersion(data.version)) fail('Nicht unterstützte Java-Viewer-Version.');
  });
  socket.on('loadChunk', (data, ack) => {
    try { if (!disposed && data.session === session) viewer.addColumn(data.x, data.z, data.chunk); }
    catch (error) { fail('3D-Chunk konnte nicht geladen werden: ' + error.message); }
    if (typeof ack === 'function') ack();
  });
  socket.on('unloadChunk', data => { if (!disposed && data.session === session) viewer.removeColumn(data.x, data.z); });
  socket.on('position', data => {
    if (disposed || data.session !== session) return;
    pose = data;
    if (!centered) home();
    const c = data.coverage;
    report(`Live-Radius ${c.radius} Chunks · ${c.knownSubchunks}/${c.totalSubchunks} Abschnitte geladen. ` +
      (data.status !== 'spawned' ? 'Bot nicht verbunden. ' : '') +
      (c.error ? c.error + ' ' : '') + 'Leere Bereiche können ungeladen sein. Magenta: Block ohne Java-Zuordnung.');
  });
  socket.on('connect_error', () => fail('3D-Verbindung fehlgeschlagen. Karte bleibt verfügbar.'));
  socket.on('disconnect', () => { if (!disposed) fail('3D-Verbindung beendet. Bitte erneut auswählen.'); });
  socket.on('viewerError', message => fail('3D: ' + message));
  for (const worker of viewer.world.workers) listen(worker, 'error', () => fail('3D-Worker fehlgeschlagen.'));
  listen(renderer.domElement, 'webglcontextlost', event => { event.preventDefault(); fail('WebGL-Kontext verloren.'); });
  const observer = new ResizeObserver(() => {
    if (disposed) return;
    const width = container.clientWidth; const height = container.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height);
    viewer.camera.aspect = width / height;
    viewer.camera.updateProjectionMatrix();
  });
  observer.observe(container);
  signal?.addEventListener('abort', dispose, { once: true });
  listen(renderer.domElement, 'pointerdown', event => {
    if (mode !== 'free' || event.button !== 0) return;
    renderer.domElement.focus();
    renderer.domElement.setPointerCapture(event.pointerId);
    drag = { x: event.clientX, y: event.clientY };
  });
  listen(renderer.domElement, 'pointermove', event => {
    if (!drag || mode !== 'free') return;
    yaw -= (event.clientX - drag.x) * .004 * (invertX ? -1 : 1);
    pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch - (event.clientY - drag.y) * .004 * (invertY ? -1 : 1)));
    drag = { x: event.clientX, y: event.clientY };
  });
  listen(renderer.domElement, 'pointerup', () => { drag = null; });
  listen(renderer.domElement, 'lostpointercapture', () => { drag = null; });
  listen(renderer.domElement, 'keydown', event => {
    if (mode === 'free' && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].includes(event.code)) {
      event.preventDefault(); keys.add(event.code);
    }
  });
  listen(window, 'keyup', event => keys.delete(event.code));
  listen(window, 'blur', () => { keys.clear(); drag = null; });
  listen(renderer.domElement, 'blur', () => keys.clear());
  const animate = time => {
    if (disposed) return;
    const elapsed = Math.max(0, (time - lastTime) / 1000);
    const step = Math.min(elapsed, .05) * 12;
    lastTime = time;
    if (mode === 'bot' && pose?.position) {
      // Snap teleports; damp normal movement between 10-Hz poses without restarting tweens.
      if (viewer.camera.position.distanceToSquared(pose.position) > 64) home();
      const blend = 1 - Math.exp(-elapsed / .06);
      viewer.camera.position.lerp(pose.position, blend);
      yaw += Math.atan2(Math.sin(pose.yaw - yaw), Math.cos(pose.yaw - yaw)) * blend;
      pitch += (pose.pitch - pitch) * blend;
      viewer.setFirstPersonCamera(null, yaw, pitch);
    } else {
      viewer.camera.rotation.set(pitch, yaw, 0, 'YXZ');
      const forward = Number(keys.has('KeyW')) - Number(keys.has('KeyS'));
      const right = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
      viewer.camera.position.x += (-Math.sin(yaw) * forward + Math.cos(yaw) * right) * step;
      viewer.camera.position.z += (-Math.cos(yaw) * forward - Math.sin(yaw) * right) * step;
      viewer.camera.position.y += (Number(keys.has('KeyE')) - Number(keys.has('KeyQ'))) * step;
    }
    try { viewer.update(); renderer.render(viewer.scene, viewer.camera); }
    catch (error) { fail('3D-Rendering fehlgeschlagen: ' + error.message); return; }
    frame = requestAnimationFrame(animate);
  };
  frame = requestAnimationFrame(animate);
  socket.connect();
  return {
    dispose, home,
    setMode (value) { mode = value; keys.clear(); drag = null; home(); },
    setMouseInversion (horizontal, vertical) { invertX = horizontal; invertY = vertical; }
  };
};
