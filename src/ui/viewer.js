const THREE = require('three');
const { Viewer } = require('prismarine-viewer/viewer/lib/viewer');
const { io } = require('socket.io-client');

const EYE_HEIGHT = 1.62;
const BOT_COLOR = 0x3b82f6;

// Same FNV-1a hash as the map's animal emoji, so a player keeps the colour across sessions.
function nameHue (name) {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 360) / 360;
}

window.createBotViewer = async function (container, report, signal, playerLabel = () => '') {
  const assets = await fetch('/viewer/blocksStates.json', { signal });
  if (!assets.ok) throw new Error('Java-Blockmodelle konnten nicht geladen werden.');
  const blockStates = await assets.json();
  const atlas = new Image();
  atlas.src = '/viewer/atlas.png';
  await atlas.decode();
  signal?.throwIfAborted();
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  let viewer;
  try { viewer = new Viewer(renderer); }
  catch (error) { renderer.dispose(); renderer.forceContextLoss(); throw error; }
  viewer.world.blockStatesData = blockStates;
  viewer.world.texturesDataUrl = '/viewer/atlas.png';
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
  // Placeholder figures: body box, head with a light face marker on the -Z (forward) side, name tag above.
  const geometry = { body: new THREE.BoxGeometry(.6, 1.35, .3), head: new THREE.BoxGeometry(.5, .5, .5), face: new THREE.BoxGeometry(.3, .1, .02) };
  const faceMaterial = new THREE.MeshLambertMaterial({ color: 0xf5f5f5 });
  const players = new Map();
  let botFigure = null;
  let botInfo = null;
  const nameTag = text => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = '28px sans-serif';
    canvas.width = Math.ceil(context.measureText(text).width) + 16; canvas.height = 40;
    context.font = '28px sans-serif';
    context.fillStyle = 'rgba(0,0,0,.45)'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fff'; context.textBaseline = 'middle'; context.fillText(text, 8, canvas.height / 2);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true }));
    sprite.scale.set(canvas.width / canvas.height * .3, .3, 1);
    sprite.position.y = 2.15;
    return sprite;
  };
  const createFigure = (color, label) => {
    const root = new THREE.Group();
    const model = new THREE.Group();
    const material = new THREE.MeshLambertMaterial({ color });
    const body = new THREE.Mesh(geometry.body, material);
    body.position.y = .675;
    const head = new THREE.Group();
    head.position.y = 1.6;
    head.add(new THREE.Mesh(geometry.head, material));
    const face = new THREE.Mesh(geometry.face, faceMaterial);
    face.position.set(0, .05, -.26);
    head.add(face);
    model.add(body, head);
    const tag = nameTag(label);
    root.add(model, tag);
    viewer.scene.add(root);
    return { label, root, model, head, material, tag, yaw: 0, pitch: 0, placed: false };
  };
  const removeFigure = figure => {
    viewer.scene.remove(figure.root);
    figure.material.dispose();
    figure.tag.material.map.dispose();
    figure.tag.material.dispose();
  };
  const clearFigures = () => {
    for (const figure of players.values()) removeFigure(figure);
    players.clear();
    if (botFigure) removeFigure(botFigure);
    botFigure = null; botInfo = null;
  };
  // Damped like the bot camera; jumps over eight blocks snap. Lying figures rest on their back, head forward.
  const follow = (figure, target, lying, blend) => {
    const feet = { x: target.position.x, y: target.position.y - EYE_HEIGHT + (lying ? .2 : 0), z: target.position.z };
    if (!figure.placed || figure.root.position.distanceToSquared(feet) > 64) {
      figure.root.position.copy(feet); figure.yaw = target.yaw; figure.pitch = target.pitch; figure.placed = true;
    } else {
      figure.root.position.lerp(feet, blend);
      figure.yaw += Math.atan2(Math.sin(target.yaw - figure.yaw), Math.cos(target.yaw - figure.yaw)) * blend;
      figure.pitch += (target.pitch - figure.pitch) * blend;
    }
    figure.model.rotation.set(lying ? -Math.PI / 2 : 0, figure.yaw, 0, 'YXZ');
    figure.head.rotation.x = lying ? 0 : figure.pitch;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    socket.disconnect();
    cancelAnimationFrame(frame);
    observer.disconnect();
    abort.abort();
    keys.clear();
    clearFigures();
    for (const shared of Object.values(geometry)) shared.dispose();
    faceMaterial.dispose();
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
    clearFigures();
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
    if (data.players) updateEntities(data);
  });
  const updateEntities = data => {
    botInfo = data.self;
    const label = '🤖 ' + botInfo.name;
    if (botFigure?.label !== label) {
      if (botFigure) removeFigure(botFigure);
      botFigure = createFigure(BOT_COLOR, label);
    }
    const seen = new Set();
    for (const player of data.players) {
      if (!player.position) continue;
      seen.add(player.id);
      let figure = players.get(player.id);
      const tag = (playerLabel(player.name) + ' ' + player.name).trim();
      if (figure?.label !== tag) {
        if (figure) removeFigure(figure);
        figure = createFigure(new THREE.Color().setHSL(nameHue(player.name), .55, .55), tag);
        players.set(player.id, figure);
      }
      figure.target = player;
    }
    for (const [id, figure] of players) if (!seen.has(id)) { removeFigure(figure); players.delete(id); }
  };
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
    const blend = 1 - Math.exp(-elapsed / .06);
    for (const figure of players.values()) follow(figure, figure.target, false, blend);
    if (botFigure) {
      // The bot's own figure would sit inside the bot-view camera, and inside a free camera that starts at the bot's eyes.
      botFigure.root.visible = mode === 'free' && !!pose?.position && viewer.camera.position.distanceToSquared(pose.position) > 2.25;
      if (pose?.position) follow(botFigure, pose, botInfo?.sleeping === true, blend);
    }
    if (mode === 'bot' && pose?.position) {
      // Snap teleports; damp normal movement between 10-Hz poses without restarting tweens.
      if (viewer.camera.position.distanceToSquared(pose.position) > 64) home();
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
