/* Extracted from web.ts, adapted to the redesigned layout. */
const byId = id => document.getElementById(id);
const archiveEnabled = false;
// Saved places, navigation history and map pins.
const placesEnabled = false;
const poiIcons = {home:'🏠', mine:'⛏️', portal:'🌀', farm:'🌾', storage:'📦', star:'⭐'};
let places = {dimension:null, pois:[], history:[]};
let placesRevision = null;
let placesDimension = null;
let placesRequest = null;
let placesRenderedAt = null;
let deleteArmed = null;
let pins = new Map();
let overlayPin = null;
let lastPointerType = 'mouse';
let registryReady = false;
let currentMap = null;
let mapRequest = null;
let lastMapAt = 0;
let mapDirty = true;
let mapContext = '';
let previousNavigationStatus = null;
let botPosition = null;
let players = [];
let chatRevision = null;
let chatRequest = null;
// A hash of the gamertag picks the animal, so a player keeps it across reconnects and browser tabs.
const playerAnimals = ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐺','🐗','🐴','🦄','🐲'];
function playerAnimal (name) {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  return playerAnimals[(hash >>> 0) % playerAnimals.length];
}
let mapNavigation = null;
let preview = null;
let previewRequest = null;
let previewTimer = null;
let previewWanted = false;
let previewContext = '';
let navigationBusy = false;
let latestRevision = 0;
let mapCursor = null;
let searchResult = null;
let selectedHit = null;
let searchRequest = null;
let worldSession = null;
const canvas = byId('map');
const context = canvas.getContext('2d');
const ground = byId('map-ground');
const groundContext = ground.getContext('2d');
let terrainKey = null;
let renderedTerrainKey = null;
let view = null;
let followBot = true;
let mapDimension = 0;
let lastDimension = null;
let pointerFrame = null;
let pointerEvent = null;
let drag = null;
let dragged = false;
const tileCache = new Map();
byId('map-controls').hidden = !archiveEnabled;
byId('places-panel').hidden = !placesEnabled;
const skinEnabled = false;
let skinState = null;
let skinPreviewHash = null;
let botStatus = 'disconnected';
byId('skin-panel').hidden = !skinEnabled;
function dimensionNumber (value) {
  return ({overworld:0, nether:1, end:2})[value] ?? (Number.isInteger(value) ? value : null);
}
function setMapSize (width, height) {
  if (canvas.width !== width || canvas.height !== height || ground.width !== width || ground.height !== height) {
    canvas.width = ground.width = width; canvas.height = ground.height = height;
    renderedTerrainKey = null;
  }
  canvas.hidden = false; byId('map-frame').hidden = false;
}
function invalidateView () {
  if (mapRequest) mapRequest.abort();
  mapRequest = null; mapDirty = true; currentMap = null; mapCursor = null; renderedTerrainKey = null;
  // Pins belong to the old viewport.
  clearPins();
  context.clearRect(0, 0, canvas.width, canvas.height);
  groundContext.clearRect(0, 0, ground.width, ground.height);
  void loadMap();
}
function homeMap () {
  if (!archiveEnabled) return;
  followBot = true;
  const dimension = dimensionNumber(lastDimension);
  if (dimension !== null) mapDimension = dimension;
  byId('map-dimension').value = String(mapDimension);
  const size = view?.size || 112;
  view = { x: Math.floor((botPosition?.x || 0) - size / 2), z: Math.floor((botPosition?.z || 0) - size / 2), size };
  invalidateView();
}
function zoomMap (factor) {
  if (!archiveEnabled || !view) return;
  const size = Math.max(16, Math.min(448, Math.round(view.size * factor)));
  if (size === view.size) return;
  view = { x: Math.floor(view.x + (view.size - size) / 2), z: Math.floor(view.z + (view.size - size) / 2), size };
  invalidateView();
}
byId('map-home').onclick = homeMap;
byId('map-zoom-in').onclick = () => zoomMap(.5);
byId('map-zoom-out').onclick = () => zoomMap(2);
byId('map-dimension').onchange = () => {
  followBot = false; mapDimension = Number(byId('map-dimension').value);
  invalidateView();
  void loadPlaces();
};
for (const id of ['target-x', 'target-z']) byId(id).oninput = () => {
  byId('nav-feedback').textContent = 'Ziel geändert. Mit „Navigation starten“ anlaufen.';
  schedulePreview(); drawMap();
};
function selectMapTarget (x, z) {
  if (archiveEnabled && mapDimension !== dimensionNumber(lastDimension)) {
    byId('nav-feedback').textContent = 'Ziele nur in der aktuell verbundenen Dimension wählen. „Zum Bot“ öffnet diese Dimension.'; return;
  }
  if (!currentMap || ![x,z].every(Number.isFinite) || x < 0 || z < 0 || x >= currentMap.width || z >= currentMap.height) return;
  const targetX = currentMap.x + Math.floor(x); const targetZ = currentMap.z + Math.floor(z);
  byId('target-x').value = String(targetX); byId('target-z').value = String(targetZ);
  byId('nav-feedback').textContent = 'Ziel gewählt – X: ' + targetX + ', Z: ' + targetZ + '. Mit „Navigation starten“ anlaufen; Erreichbarkeit wird dann geprüft.';
  schedulePreview();
  describeMapCell(Math.floor(x), Math.floor(z));
  selectMapHits(x, z);
}
function cancelPreview () {
  byId('preview-status').textContent = '';
  if (previewTimer !== null) clearTimeout(previewTimer);
  previewTimer = null;
  if (previewRequest) previewRequest.abort();
  previewRequest = null; preview = null;
}
function schedulePreview (delay = 250) {
  cancelPreview(); previewWanted = true;
  previewContext = JSON.stringify([worldSession,latestRevision,navigationBusy,botPosition,byId('target-x').value,byId('target-z').value]);
  if (!registryReady || !botPosition || navigationBusy) return;
  const x = Number(byId('target-x').value); const z = Number(byId('target-z').value);
  if (!byId('target-x').value.trim() || !byId('target-z').value.trim() || ![x,z].every(n=>Number.isInteger(n)&&Math.abs(n)<=30000000)) {
    byId('preview-status').textContent = 'Gültige ganzzahlige X/Z-Koordinaten für die Vorschau wählen.'; return;
  }
  byId('preview-status').textContent = 'Wegvorschau wird berechnet; der Bot bleibt stehen.';
  previewTimer = setTimeout(async () => {
    previewTimer = null;
    const controller = previewRequest = new AbortController();
    try {
      const response = await fetch('/api/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x,z}),signal:controller.signal});
      const result = await response.json();
      if (previewRequest !== controller) return;
      if (!response.ok) throw new Error(result.error);
      if (result.session !== worldSession || !botPosition || Math.hypot(result.origin.x-botPosition.x,result.origin.y-botPosition.y,result.origin.z-botPosition.z)>.001) return;
      preview = result;
      byId('preview-status').textContent = 'Wegvorschau: ' + result.path.length + ' Wegpunkte. Erst „Navigation starten“ bewegt den Bot.';
      drawMap();
    } catch(error) { if (previewRequest === controller) byId('preview-status').textContent = 'Keine Wegvorschau: ' + error.message; }
    finally { if (previewRequest === controller) previewRequest = null; }
  },delay);
}
byId('navigate').onsubmit = async event => {
  event.preventDefault();
  cancelPreview(); previewWanted = false; drawMap();
  const x = Number(byId('target-x').value); const z = Number(byId('target-z').value);
  try {
    if (!byId('target-x').value.trim() || !byId('target-z').value.trim() || ![x,z].every(n => Number.isInteger(n) && Math.abs(n) <= 30000000)) throw new Error('Gültige ganzzahlige X/Z-Koordinaten eingeben.');
    const response = await fetch('/api/navigate', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({x,z}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    byId('nav-feedback').textContent = 'Navigationsauftrag für X: ' + x + ', Z: ' + z + ' eingereiht.';
  } catch (error) { byId('nav-feedback').textContent = error.message; }
};
byId('nav-stop').onclick = async () => {
  cancelPreview(); previewWanted = false; drawMap();
  try {
    const response = await fetch('/api/stop_navigation', {method:'POST',headers:{'Content-Type':'application/json'}});
    if (!response.ok) throw new Error((await response.json()).error);
    byId('nav-feedback').textContent = 'Stopp eingereiht.';
  } catch (error) { byId('nav-feedback').textContent = error.message; }
};
function clearSearchResults () {
  if (searchRequest) searchRequest.abort();
  searchRequest = null; searchResult = null; selectedHit = null;
  byId('hits').replaceChildren(); byId('map-hit-options').replaceChildren(); byId('search-reset').disabled = true;
  byId('map-hit-info').textContent = '⛏️: Treffer der letzten Blocksuche, auch unter der Oberfläche. Marker anklicken oder mit Pfeiltasten und Enter auswählen.';
  drawMap();
}
function selectHit (hit) {
  selectedHit = hit;
  byId('map-hit-info').textContent = searchResult.blockId + ' – X: ' + hit.x + ', Y: ' + hit.y + ', Z: ' + hit.z + '. Treffer der letzten Suche; bei Weltänderungen erneut suchen.';
  drawMap();
}
// Hits come from the live dimension, so they are valid targets even while another archive dimension is shown.
function selectHitTarget (hit) {
  byId('target-x').value = String(hit.x); byId('target-z').value = String(hit.z);
  byId('nav-feedback').textContent = 'Ziel gewählt – X: ' + hit.x + ', Z: ' + hit.z + '. Mit „Navigation starten“ anlaufen; Erreichbarkeit wird dann geprüft.';
  schedulePreview();
  selectHit(hit);
}
function selectMapHits (x, z) {
  if (archiveEnabled && mapDimension !== dimensionNumber(lastDimension)) return;
  if (!currentMap || !searchResult || currentMap.coverage.session !== searchResult.coverage.session) return;
  const distance = hit => (hit.x + .5 - currentMap.x - x) ** 2 + (hit.z + .5 - currentMap.z - z) ** 2;
  const hits = searchResult.hits.filter(hit => distance(hit) <= 4 && hit.x >= currentMap.x && hit.x < currentMap.x + currentMap.width && hit.z >= currentMap.z && hit.z < currentMap.z + currentMap.height)
    .sort((a, b) => distance(a) - distance(b));
  byId('map-hit-options').replaceChildren();
  if (!hits.length) {
    selectedHit = null;
    byId('map-hit-info').textContent = 'Kein Suchtreffer an dieser Kartenposition.';
    drawMap(); return;
  }
  selectHit(hits[0]);
  if (hits.length > 1) for (const hit of hits) {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = searchResult.blockId + ' – X: ' + hit.x + ', Y: ' + hit.y + ', Z: ' + hit.z;
    button.onclick = () => selectHit(hit);
    byId('map-hit-options').append(button);
  }
}
function blockColor (id) {
  const name = id.replace(/^minecraft:/, '');
  const dye = name.match(dyePattern);
  if (dye && /wool|carpet|concrete|glass|terracotta|shulker|candle|bed$|banner/.test(name)) return dyeColors[dye[1]];
  const base = name.replace(/_(stairs|double_slab|slab|wall|fence_gate|fence|trapdoor|door|pressure_plate|button)$/, '');
  const known = blockColors[name] || blockColors[base] || blockColors[base + 's'] || blockColors[base + '_planks'];
  if (known) return known;
  if (/water/.test(id)) return '#397bb8';
  if (/lava|magma/.test(id)) return '#e96325';
  if (/snow|ice|quartz/.test(id)) return '#dcebf0';
  if (/grass|moss/.test(id)) return '#76a64b';
  if (/leaves|vine|azalea/.test(id)) return '#387844';
  if (/sand|end_stone/.test(id)) return '#d5c38c';
  if (/dirt|mud|farmland|path/.test(id)) return '#886344';
  if (/log|wood|planks|stem/.test(id)) return '#a9804d';
  if (/netherrack|nether_brick/.test(id)) return '#914744';
  if (/stone|ore|gravel|andesite|diorite|granite|bedrock/.test(id)) return '#858b92';
  if (id === 'minecraft:air') return '#334155';
  let hash = 0; for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return 'hsl(' + ((hash >>> 0) % 360) + ' 35% 55%)';
}
// Colors follow the vanilla map palette at its flat shade, slightly muted; patterns above stay as fallback.
const dyePattern = /^(light_blue|light_gray|white|orange|magenta|yellow|lime|pink|gray|cyan|purple|blue|brown|green|red|black)_/;
const dyeColors = {
  white:'#dcdcdc', orange:'#ba6d2c', magenta:'#9941ba', light_blue:'#5884ba', yellow:'#c5c52c', lime:'#6daf15', pink:'#d06d8e', gray:'#414141',
  light_gray:'#848484', cyan:'#416d84', purple:'#6d3699', blue:'#2c4199', brown:'#58412c', green:'#586d2c', red:'#832c2c', black:'#151515'
};
const blockColors = {
  grass_block:'#6d9930', grass:'#6d9930', grass_path:'#94795a', dirt_path:'#94795a', dirt:'#825e42', coarse_dirt:'#825e42', rooted_dirt:'#825e42',
  farmland:'#6f4e36', podzol:'#6f4a2a', mycelium:'#6d5a6e', mud:'#4c4545', clay:'#8d909e', moss_block:'#4e6b28', moss_carpet:'#4e6b28',
  sand:'#d5c88c', sandstone:'#d5c88c', smooth_sandstone:'#d5c88c', cut_sandstone:'#d5c88c', red_sand:'#ba6d2c', red_sandstone:'#ba6d2c', gravel:'#7f7d7c',
  stone:'#606060', cobblestone:'#606060', stone_bricks:'#606060', stone_brick:'#606060', smooth_stone:'#606060', mossy_cobblestone:'#5c6b4c',
  andesite:'#6e6e6e', diorite:'#bdbdb8', granite:'#8a6252', deepslate:'#565656', cobbled_deepslate:'#565656', tuff:'#6b6d64', calcite:'#d6d3cd',
  dripstone_block:'#7a5a47', bedrock:'#4a4a4a', obsidian:'#1c1828', bricks:'#833d2c', brick_block:'#833d2c', quartz_block:'#dbd8d2', glass:'#bcd7dc',
  snow:'#f2f6f8', snow_layer:'#f2f6f8', powder_snow:'#f2f6f8', ice:'#8a8adb', packed_ice:'#8a8adb', blue_ice:'#7a86db',
  water:'#397bb8', flowing_water:'#397bb8', lava:'#e96325', flowing_lava:'#e96325', magma:'#8a3a12',
  netherrack:'#7a2e2a', nether_brick:'#4a1e22', soul_sand:'#55402f', soul_soil:'#55402f', crimson_nylium:'#a22a2a', warped_nylium:'#13706f',
  basalt:'#3e3e44', blackstone:'#2b2529', glowstone:'#d7cc6a', end_stone:'#d5d59a', purpur_block:'#9a6d9a',
  oak_leaves:'#2f6a1f', spruce_leaves:'#3a5a3a', birch_leaves:'#59803a', jungle_leaves:'#2f7a1c', acacia_leaves:'#3f7a24', dark_oak_leaves:'#2a5a1a',
  mangrove_leaves:'#3d6e22', cherry_leaves:'#e3a9b9', azalea_leaves:'#4e7a30', azalea_leaves_flowered:'#6e7a50', leaves:'#2f6a1f', leaves2:'#3f7a24',
  short_grass:'#3f8a2a', tallgrass:'#3f8a2a', tall_grass:'#3f8a2a', fern:'#3f8a2a', large_fern:'#3f8a2a', vine:'#2f6a1f', waterlily:'#2f7a1c',
  oak_planks:'#7b6640', spruce_planks:'#6b4a2a', birch_planks:'#c3b07b', jungle_planks:'#8a6142', acacia_planks:'#a95a2e', dark_oak_planks:'#4a311b',
  mangrove_planks:'#6e2a24', cherry_planks:'#d9b4ae', crimson_planks:'#7d3a52', warped_planks:'#2a6d66', bamboo_planks:'#c0ac58', planks:'#7b6640',
  oak_log:'#6a5232', spruce_log:'#3e2b17', birch_log:'#d5d0c4', jungle_log:'#5a4628', acacia_log:'#5e5850', dark_oak_log:'#3a2a16', mangrove_log:'#5a3a2a',
  cherry_log:'#3a2128', crimson_stem:'#5c1a2e', warped_stem:'#3a2a40',
  cactus:'#2f6e20', pumpkin:'#ba6d2c', melon_block:'#6e8a2c', hay_block:'#c5a52c', reeds:'#6e9a4a', sugar_cane:'#6e9a4a', bamboo:'#5e8a2a',
  coal_block:'#151515', iron_block:'#a8a8a8', gold_block:'#d7cd42', diamond_block:'#4fbcb7', emerald_block:'#00ba32', lapis_block:'#3f6edb',
  redstone_block:'#a00000', copper_block:'#b0603f', hardened_clay:'#8a4e3a', terracotta:'#8a4e3a', bone_block:'#d6d0b4'
};
const heightRanges = [[-64,320],[0,128],[0,256]];
// Relative brightness from absolute height (tint) and the step to the northern neighbour (relief, like vanilla maps).
function shade (cell, north, dimension, palette) {
  if (cell[1] === null || /water|lava/.test(palette ? palette[cell[0]] : cell[0])) return 1;
  const [low, high] = heightRanges[dimension] || heightRanges[0];
  let factor = 1 + Math.max(-1, Math.min(1, (cell[1] - (low + high) / 2) / ((high - low) / 2))) * .1;
  if (cell[2] && north && north[2] && north[1] !== null) {
    const step = cell[1] - north[1];
    factor += step >= 3 ? .12 : step > 0 ? .08 : step <= -3 ? -.2 : step < 0 ? -.08 : 0;
  }
  return factor;
}
const blockPixels = new Map();
let colorContext = null;
const unknownPixel = [32,43,64];
const unconfirmedPixel = [213,172,80];
function blockPixel (id) {
  let pixel = blockPixels.get(id);
  if (pixel) return pixel;
  const color = blockColor(id);
  if (color.startsWith('#')) pixel = [1,3,5].map(offset => parseInt(color.slice(offset,offset+2),16));
  else {
    if (!colorContext) {
      const swatch = document.createElement('canvas'); swatch.width = swatch.height = 1;
      colorContext = swatch.getContext('2d');
    }
    colorContext.fillStyle = color; colorContext.fillRect(0,0,1,1);
    pixel = colorContext.getImageData(0,0,1,1).data.slice(0,3);
  }
  if (blockPixels.size >= 2048) blockPixels.delete(blockPixels.keys().next().value);
  blockPixels.set(id,pixel);
  return pixel;
}
function rasterCells (target, cells, width, palette, historical, dimension, northRow) {
  const image = target.createImageData(width,cells.length/width);
  const pixels = image.data;
  for (let i=0;i<cells.length;i++) {
    const cell = cells[i];
    let color = cell ? blockPixel(palette ? palette[cell[0]] : cell[0]) : unknownPixel;
    let factor = 1;
    if (cell && !cell[2] && (i%width+Math.floor(i/width))%2===0) color = unconfirmedPixel;
    else if (cell) factor = shade(cell, i < width ? northRow?.[i] : cells[i-width], dimension, palette);
    const offset = i*4;
    if (cell && historical?.[i]) {
      pixels[offset] = color[0]*factor*.84+210*.16;
      pixels[offset+1] = color[1]*factor*.84+222*.16;
      pixels[offset+2] = color[2]*factor*.84+232*.16;
    } else {
      pixels[offset] = color[0]*factor; pixels[offset+1] = color[1]*factor; pixels[offset+2] = color[2]*factor;
    }
    pixels[offset+3] = 255;
  }
  target.putImageData(image,0,0);
}
function paintTerrain () {
  if (renderedTerrainKey === terrainKey) return;
  const map = currentMap;
  groundContext.fillStyle = '#202b40'; groundContext.fillRect(0, 0, map.width, map.height);
  groundContext.imageSmoothingEnabled = false;
  if (map.tiles) {
    const visible = new Map(map.tiles.map(tile => [tile.x + ':' + tile.z, tile]));
    for (const tile of map.tiles) {
      // The top row's relief depends on the northern tile, so its fingerprint is part of the raster key.
      const north = visible.get(tile.x + ':' + (tile.z - 1));
      const rasterKey = tile.hash + ':' + (north ? north.hash : '');
      if (!tile.raster || tile.rasterKey !== rasterKey) {
        if (!tile.raster) { tile.raster = document.createElement('canvas'); tile.raster.width = tile.raster.height = 16; }
        rasterCells(tile.raster.getContext('2d'), tile.cells, 16, null, tile.live.map(live => !live), map.dimension, north ? north.cells.slice(240) : null);
        tile.rasterKey = rasterKey;
      }
      groundContext.drawImage(tile.raster, tile.x * 16 - map.x, tile.z * 16 - map.z);
    }
  } else rasterCells(groundContext, map.cells, map.width, map.palette, null, dimensionNumber(lastDimension));
  renderedTerrainKey = terrainKey;
}
function drawMap () {
  if (!currentMap || !context) return;
  const map = currentMap;
  paintTerrain();
  context.clearRect(0, 0, map.width, map.height);
  context.strokeStyle = '#ffffff30'; context.lineWidth = .15; context.beginPath();
  for (let x = ((-map.x % 16) + 16) % 16; x <= map.width; x += 16) { context.moveTo(x, 0); context.lineTo(x, map.height); }
  for (let z = ((-map.z % 16) + 16) % 16; z <= map.height; z += 16) { context.moveTo(0, z); context.lineTo(map.width, z); }
  context.stroke();
  const route = !archiveEnabled || mapDimension === dimensionNumber(lastDimension) ? mapNavigation || preview : null;
  if (route && route.session === map.coverage.session && route.path.length && botPosition) {
    const origin = route.origin || botPosition;
    // Thin dark line of constant screen width; dashed preview, solid active navigation.
    // Corners are rounded for display only: each waypoint is a curve control point, the curve passes through segment midpoints.
    const points = route.path.map(point => [point.x - map.x, point.z - map.z]);
    context.beginPath(); context.moveTo(origin.x - map.x, origin.z - map.z);
    for (let i = 0; i < points.length - 1; i++) {
      context.quadraticCurveTo(points[i][0], points[i][1], (points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2);
    }
    context.lineTo(points.at(-1)[0], points.at(-1)[1]);
    const pixel = map.width / Math.max(1, canvas.getBoundingClientRect().width);
    context.lineJoin = 'round'; context.lineCap = 'round';
    context.setLineDash(route === preview ? [6 * pixel, 4 * pixel] : []);
    context.strokeStyle = '#111111'; context.lineWidth = 2 * pixel; context.stroke();
    context.setLineDash([]);
  }
  if (mapCursor) {
    context.strokeStyle = '#fff'; context.lineWidth = .4;
    context.strokeRect(mapCursor.x, mapCursor.z, 1, 1);
  }
  // Bot, target, places, players and search hits are DOM pins above the canvas.
  updatePins(map);
}
/* Map pins, pin overlay, saved places and navigation history. */
function pinSpecs (map) {
  const specs = [];
  const live = !archiveEnabled || mapDimension === dimensionNumber(lastDimension);
  if (placesEnabled && places.dimension === mapDimension) {
    for (const poi of places.pois) specs.push({key:'poi:' + poi.id, kind:'poi', x:poi.x + .5, z:poi.z + .5, poi});
  }
  // One hit pin per X/Z column; hits below each other are chosen via #map-hit-options.
  if (live && searchResult && searchResult.coverage.session === map.coverage.session) {
    const columns = new Map();
    for (const hit of searchResult.hits) {
      const key = 'hit:' + hit.x + ':' + hit.z;
      if (!columns.has(key)) columns.set(key, {key, kind:'hit', x:hit.x + .5, z:hit.z + .5, hits:[]});
      columns.get(key).hits.push(hit);
    }
    specs.push(...columns.values());
  }
  if (live) for (const player of players) specs.push({key:'player:' + player.id, kind:'player', x:player.x, z:player.z, player});
  const targetX = Number(byId('target-x').value); const targetZ = Number(byId('target-z').value);
  if (live && byId('target-x').value.trim() && byId('target-z').value.trim() && [targetX,targetZ].every(Number.isInteger)) {
    specs.push({key:'target', kind:'target', x:targetX + .5, z:targetZ + .5});
  }
  if (live && botPosition) specs.push({key:'bot', kind:'bot', x:botPosition.x, z:botPosition.z});
  return specs.filter(spec => spec.x >= map.x && spec.x < map.x + map.width && spec.z >= map.z && spec.z < map.z + map.height);
}
function createPin (spec) {
  if (spec.kind === 'poi') {
    // Places are buttons so keyboard users reach them with Tab; Enter selects them as target.
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'pin pin-tip'; button.textContent = '📍';
    button.onclick = () => activatePin(pins.get(spec.key));
    button.onfocus = () => showOverlay(spec.key);
    button.onblur = () => { if (overlayPin === spec.key) hideOverlay(); };
    return button;
  }
  const element = document.createElement('span'); element.ariaHidden = 'true';
  if (spec.kind === 'player') {
    element.className = 'pin pin-center pin-player'; element.textContent = playerAnimal(spec.player.name);
    return element;
  }
  if (spec.kind === 'hit') { element.textContent = '⛏️'; return element; }
  element.className = spec.kind === 'bot' ? 'pin pin-center' : 'pin pin-pushpin';
  element.textContent = spec.kind === 'bot' ? '🤖' : '📌';
  return element;
}
function updatePins (map) {
  const next = new Map();
  for (const spec of pinSpecs(map)) {
    const pin = pins.get(spec.key) || {key:spec.key, element:createPin(spec)};
    pin.spec = spec;
    pin.element.style.left = (spec.x - map.x) / map.width * 100 + '%';
    pin.element.style.top = (spec.z - map.z) / map.height * 100 + '%';
    if (spec.kind === 'hit') pin.element.className = 'pin pin-center pin-hit' + (spec.hits.includes(selectedHit) ? ' selected' : '');
    if (spec.kind === 'poi') pin.element.ariaLabel = 'Ort ' + spec.poi.name + ' – X: ' + spec.poi.x + ', Z: ' + spec.poi.z + '. Enter übernimmt ihn als Ziel.';
    next.set(spec.key, pin);
  }
  const changed = next.size !== pins.size || [...next.keys()].some(key => !pins.has(key));
  pins = next;
  if (changed) byId('map-pins').replaceChildren(...[...pins.values()].map(pin => pin.element));
  if (overlayPin) showOverlay(overlayPin);
}
function clearPins () {
  pins = new Map(); byId('map-pins').replaceChildren(); hideOverlay();
}
function distanceText (x, z) {
  if (!botPosition || dimensionNumber(lastDimension) !== places.dimension) return '';
  return Math.round(Math.hypot(x + .5 - botPosition.x, z + .5 - botPosition.z)) + ' Blöcke entfernt';
}
function overlayText (spec) {
  const hint = lastPointerType === 'touch' ? 'Erneut tippen: als Ziel übernehmen' : 'Klicken: als Ziel übernehmen';
  if (spec.kind === 'poi') {
    const distance = distanceText(spec.poi.x, spec.poi.z);
    return (poiIcons[spec.poi.icon] || '📍') + ' ' + spec.poi.name + '\nX: ' + spec.poi.x + ', Z: ' + spec.poi.z + (distance ? '\n' + distance : '') + '\n' + hint;
  }
  if (spec.kind === 'bot') {
    return '🤖 Bot\nX: ' + botPosition.x.toFixed(1) + ', Y: ' + botPosition.y.toFixed(1) + ', Z: ' + botPosition.z.toFixed(1) + '\n' + byId('nav-status').textContent;
  }
  if (spec.kind === 'player') {
    const player = spec.player;
    return playerAnimal(player.name) + ' ' + (player.name || 'Spieler') + '\nX: ' + player.x.toFixed(1) + ', Y: ' + player.y.toFixed(1) + ', Z: ' + player.z.toFixed(1) +
      (botPosition ? '\n' + Math.round(Math.hypot(player.x - botPosition.x, player.z - botPosition.z)) + ' Blöcke vom Bot entfernt' : '');
  }
  if (spec.kind === 'hit') {
    const levels = spec.hits.map(hit => hit.y).sort((a, b) => a - b);
    return '⛏️ ' + searchResult.blockId + ' (' + levels.length + ' Treffer)\nX: ' + Math.floor(spec.x) + ', Z: ' + Math.floor(spec.z) +
      '\nY: ' + levels.slice(0, 5).join(', ') + (levels.length > 5 ? ' +' + (levels.length - 5) + ' weitere' : '') +
      (botPosition ? '\n' + Math.round(Math.hypot(spec.x - botPosition.x, spec.z - botPosition.z)) + ' Blöcke vom Bot entfernt' : '') + '\n' + hint;
  }
  return '📌 Ziel\nX: ' + Math.floor(spec.x) + ', Z: ' + Math.floor(spec.z) + '\n' + (byId('preview-status').textContent || byId('nav-status').textContent);
}
function showOverlay (key) {
  const pin = pins.get(key);
  if (!pin || !currentMap) { hideOverlay(); return; }
  overlayPin = key;
  const overlay = byId('map-pin-overlay');
  const left = (pin.spec.x - currentMap.x) / currentMap.width * 100;
  const top = (pin.spec.z - currentMap.z) / currentMap.height * 100;
  overlay.textContent = overlayText(pin.spec);
  overlay.style.left = Math.max(15, Math.min(85, left)) + '%';
  overlay.style.top = top + '%';
  overlay.className = 'pin-overlay ' + (top < 30 ? 'below' : 'above');
  overlay.hidden = false;
}
function hideOverlay () {
  overlayPin = null; byId('map-pin-overlay').hidden = true;
}
// Pins ignore the pointer so dragging and zooming stay on the canvas; the canvas hit-tests them in screen pixels.
function pinAt (clientX, clientY) {
  if (!currentMap) return null;
  const bounds = canvas.getBoundingClientRect(); const scale = bounds.width / currentMap.width;
  let best = null; let bestDistance = 20;
  for (const pin of pins.values()) {
    const x = bounds.left + (pin.spec.x - currentMap.x) * scale;
    const z = bounds.top + (pin.spec.z - currentMap.z) * scale - (pin.spec.kind === 'bot' || pin.spec.kind === 'player' || pin.spec.kind === 'hit' ? 0 : 14);
    const distance = Math.hypot(clientX - x, clientY - z);
    // Strictly nearer only: on a tie the earlier pin wins, so a place beats the target or bot on the same cell.
    if (distance < bestDistance) { best = pin; bestDistance = distance; }
  }
  return best;
}
function activatePin (pin) {
  if (!pin || !currentMap) return;
  hideOverlay();
  if (pin.spec.kind === 'poi') selectPlaceTarget(pin.spec.poi.x, pin.spec.poi.z, pin.spec.poi.name);
  else selectMapTarget(pin.spec.x - currentMap.x, pin.spec.z - currentMap.z);
}
byId('map-pin-overlay').onclick = () => activatePin(pins.get(overlayPin));
byId('map-pin-overlay').onpointerleave = () => { if (lastPointerType !== 'touch') hideOverlay(); };
function selectPlaceTarget (x, z, label) {
  if (dimensionNumber(lastDimension) !== places.dimension) {
    byId('nav-feedback').textContent = 'Orte nur in der aktuell verbundenen Dimension ansteuern. „Zum Bot“ öffnet diese Dimension.'; return;
  }
  byId('target-x').value = String(x); byId('target-z').value = String(z);
  byId('nav-feedback').textContent = 'Ziel gewählt – ' + label + ' (X: ' + x + ', Z: ' + z + '). Mit „Navigation starten“ anlaufen; Erreichbarkeit wird dann geprüft.';
  schedulePreview(); drawMap();
}
async function loadPlaces () {
  if (!placesEnabled) return;
  if (placesRequest) placesRequest.abort();
  const controller = placesRequest = new AbortController();
  placesDimension = mapDimension;
  try {
    const response = await fetch('/api/pois?dimension=' + mapDimension, {signal:controller.signal});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (placesRequest !== controller) return;
    places = result; renderPlaces(); drawMap();
  } catch (error) {
    if (placesRequest === controller) byId('poi-feedback').textContent = 'Orte konnten nicht geladen werden: ' + error.message;
  } finally { if (placesRequest === controller) placesRequest = null; }
}
function listButton (label, ariaLabel, onclick) {
  const button = document.createElement('button'); button.type = 'button';
  button.textContent = label; button.ariaLabel = ariaLabel; button.onclick = onclick;
  return button;
}
function renderPlaces () {
  placesRenderedAt = botPosition ? {x:botPosition.x, z:botPosition.z} : null;
  const live = dimensionNumber(lastDimension) === places.dimension;
  const distance = poi => botPosition && live ? Math.hypot(poi.x + .5 - botPosition.x, poi.z + .5 - botPosition.z) : 0;
  const pois = [...places.pois].sort((a, b) => distance(a) - distance(b) || a.name.localeCompare(b.name));
  byId('poi-list').replaceChildren(...pois.map(poi => {
    const item = document.createElement('li'); const text = document.createElement('span');
    const away = distanceText(poi.x, poi.z);
    text.textContent = (poiIcons[poi.icon] || '📍') + ' ' + poi.name + ' – X: ' + poi.x + ', Z: ' + poi.z + (away ? ' (' + away + ')' : '');
    const armed = deleteArmed?.id === poi.id;
    const remove = listButton(armed ? 'Wirklich löschen?' : 'Löschen', (armed ? 'Löschen bestätigen: ' : 'Ort löschen: ') + poi.name, () => deletePoi(poi));
    remove.className = 'danger';
    item.append(text, listButton('Ziel', 'Ort ' + poi.name + ' als Ziel übernehmen', () => selectPlaceTarget(poi.x, poi.z, poi.name)), remove);
    return item;
  }));
  byId('poi-empty').hidden = places.pois.length > 0;
  byId('history-list').replaceChildren(...places.history.map(entry => {
    const item = document.createElement('li'); const text = document.createElement('span');
    text.textContent = 'X: ' + entry.x + ', Z: ' + entry.z + ' – ' + new Date(entry.at).toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'});
    item.append(text,
      listButton('Ziel', 'X: ' + entry.x + ', Z: ' + entry.z + ' als Ziel übernehmen', () => selectPlaceTarget(entry.x, entry.z, 'Verlauf')),
      listButton('Als Ort', 'X: ' + entry.x + ', Z: ' + entry.z + ' als Ort speichern', () => savePoi(entry.x, entry.z)));
    return item;
  }));
  byId('history-empty').hidden = places.history.length > 0;
}
// Players in range first by distance, then everyone else alphabetically.
function renderPlayers (roster, spawned) {
  const distance = player => player.position && botPosition ? Math.hypot(player.position.x - botPosition.x, player.position.z - botPosition.z) : null;
  const entries = roster.map(player => ({player, distance:distance(player)}));
  entries.sort((a, b) => (a.distance === null) - (b.distance === null) || (a.distance ?? 0) - (b.distance ?? 0) ||
    a.player.name.localeCompare(b.player.name, 'de', {sensitivity:'base'}));
  byId('players-heading').textContent = 'Spieler (' + roster.length + ')';
  byId('player-list').replaceChildren(...entries.map(({player, distance}) => {
    const item = document.createElement('li'); const text = document.createElement('span');
    text.textContent = playerAnimal(player.name) + ' ' + (player.name || 'Spieler') + ' – ' + (distance === null ? 'nicht in Reichweite' : Math.round(distance) + ' Blöcke entfernt');
    if (distance === null) item.className = 'player-far';
    item.append(text);
    return item;
  }));
  byId('player-empty').hidden = roster.length > 0;
  byId('player-empty').textContent = spawned ? 'Keine anderen Spieler online.' : 'Nicht verbunden.';
}
async function loadChat () {
  if (chatRequest) chatRequest.abort();
  const controller = chatRequest = new AbortController();
  try {
    const response = await fetch('/api/chat', {signal:controller.signal});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (chatRequest === controller) renderChat(Array.isArray(result.lines) ? result.lines : []);
  } catch (error) {
    // The next status update retries.
    if (chatRequest === controller) chatRevision = null;
  } finally { if (chatRequest === controller) chatRequest = null; }
}
function chatSpan (className, text) {
  const span = document.createElement('span'); span.className = className; span.textContent = text;
  return span;
}
// Follows new lines only while the log is scrolled to the end, so reading older lines is not interrupted.
function renderChat (lines) {
  const log = byId('chat-log');
  const atEnd = !(log.scrollHeight - log.scrollTop - log.clientHeight > 8);
  log.replaceChildren(...lines.map(line => {
    const item = document.createElement('div');
    const time = new Date(line.at).toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'});
    item.className = 'chat-line chat-' + line.kind;
    if (line.kind === 'event') { item.textContent = time + ' · ' + line.text; return item; }
    const icon = line.kind === 'bot' ? '🤖' : playerAnimal(line.name);
    item.append(chatSpan('chat-time', time + ' '));
    item.append(chatSpan('chat-name', icon + ' ' + line.name + (line.kind === 'whisper' ? ' flüstert' : '') + ': '));
    item.append(chatSpan('chat-text', line.text));
    return item;
  }));
  byId('chat-empty').hidden = lines.length > 0;
  if (atEnd) log.scrollTop = log.scrollHeight;
}
async function deletePoi (poi) {
  if (deleteArmed?.id !== poi.id) {
    if (deleteArmed) clearTimeout(deleteArmed.timer);
    deleteArmed = {id:poi.id, timer:setTimeout(() => { deleteArmed = null; renderPlaces(); }, 4000)};
    renderPlaces(); return;
  }
  clearTimeout(deleteArmed.timer); deleteArmed = null;
  try {
    const response = await fetch('/api/pois/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id:poi.id})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    byId('poi-feedback').textContent = 'Ort „' + poi.name + '“ gelöscht.';
  } catch (error) { byId('poi-feedback').textContent = 'Löschen fehlgeschlagen: ' + error.message; }
  void loadPlaces();
}
async function savePoi (x, z) {
  const name = byId('poi-name').value.trim();
  const dimension = dimensionNumber(lastDimension);
  if (!name) { byId('poi-feedback').textContent = 'Zuerst einen Namen eingeben.'; byId('poi-name').focus?.(); return; }
  if (dimension === null) { byId('poi-feedback').textContent = 'Dimension unbekannt; erst verbinden.'; return; }
  try {
    const response = await fetch('/api/pois', {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name, icon:byId('poi-icon').value, x, z, dimension})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    byId('poi-name').value = '';
    byId('poi-feedback').textContent = 'Ort „' + result.poi.name + '“ gespeichert (X: ' + x + ', Z: ' + z + ').' +
      (dimension !== mapDimension ? ' Er gehört zur verbundenen Dimension.' : '');
  } catch (error) { byId('poi-feedback').textContent = 'Speichern fehlgeschlagen: ' + error.message; }
  void loadPlaces();
}
byId('poi-save-target').onclick = () => {
  const x = Number(byId('target-x').value); const z = Number(byId('target-z').value);
  if (!byId('target-x').value.trim() || !byId('target-z').value.trim() || ![x,z].every(n => Number.isInteger(n) && Math.abs(n) <= 30000000)) {
    byId('poi-feedback').textContent = 'Zuerst ein gültiges Ziel wählen.'; return;
  }
  return savePoi(x, z);
};
byId('poi-save-bot').onclick = () => {
  if (!botPosition) { byId('poi-feedback').textContent = 'Bot-Position unbekannt.'; return; }
  return savePoi(Math.floor(botPosition.x), Math.floor(botPosition.z));
};
function describeMapCell (x, z) {
  if (!currentMap) return;
  const map = currentMap;
  x = Math.max(0, Math.min(map.width - 1, x)); z = Math.max(0, Math.min(map.height - 1, z));
  mapCursor = { x, z };
  const cell = map.cells[z * map.width + x];
  byId('map-info').textContent = 'X: ' + (map.x + x) + ', Z: ' + (map.z + z) + ': ' +
    (cell ? map.palette[cell[0]] + (cell[1] === null ? ' (vollständig Luft)' : ', Y: ' + cell[1]) +
      (cell[2] ? '' : ' – Oberhalb fehlen Daten; keine bestätigte Oberfläche.') + (map.historical?.[z * map.width + x] ? ' – Historische Beobachtung; aktuell nicht bestätigt.' : '') : 'Unbekannte Daten.');
  drawMap();
}
canvas.onpointerdown = event => {
  // Touch shows a pin's overlay first, mouse uses hover.
  lastPointerType = event.pointerType || 'mouse';
  if (!archiveEnabled || !view || (event.button !== undefined && event.button !== 0)) return;
  drag = { x: event.clientX, z: event.clientY, view: { ...view } }; dragged = false;
  canvas.setPointerCapture(event.pointerId);
};
function applyPointer () {
  pointerFrame = null;
  const event = pointerEvent; pointerEvent = null;
  if (!event || !currentMap) return;
  const bounds = canvas.getBoundingClientRect();
  if (drag) {
    const dx = (event.clientX - drag.x) / bounds.width * drag.view.size;
    const dz = (event.clientY - drag.z) / bounds.height * drag.view.size;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.z) > 4) dragged = true;
    if (dragged) {
      followBot = false;
      view = { ...drag.view, x: Math.max(-30000000, Math.min(30000000 - drag.view.size, Math.round(drag.view.x - dx))), z: Math.max(-30000000, Math.min(30000000 - drag.view.size, Math.round(drag.view.z - dz))) };
      // Reuse the current raster while dragging; request the final viewport on release.
      context.clearRect(0, 0, canvas.width, canvas.height);
      ground.style.transform = 'translate(' + (drag.view.x - view.x) / view.size * bounds.width + 'px,' + (drag.view.z - view.z) / view.size * bounds.height + 'px)';
      // Pins move with the terrain while dragging.
      byId('map-pins').style.transform = ground.style.transform; hideOverlay();
      return;
    }
  }
  const x = Math.floor((event.clientX - bounds.left) / bounds.width * currentMap.width);
  const z = Math.floor((event.clientY - bounds.top) / bounds.height * currentMap.height);
  if (mapCursor?.x !== x || mapCursor?.z !== z) describeMapCell(x, z);
  // Hovering a pin shows its overlay.
  if (event.pointerType !== 'touch') {
    const pin = pinAt(event.clientX, event.clientY);
    if (pin) { if (overlayPin !== pin.key) showOverlay(pin.key); }
    else if (overlayPin && lastPointerType !== 'touch') hideOverlay();
    canvas.style.cursor = pin?.spec.kind === 'poi' || pin?.spec.kind === 'hit' ? 'pointer' : '';
  }
}
canvas.onpointermove = event => {
  pointerEvent = { clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType };
  if (pointerFrame === null) pointerFrame = requestAnimationFrame(applyPointer);
};
canvas.onpointerup = event => {
  if (!drag) return;
  // Keep the pointer type so lifting a finger is not taken as a hover.
  pointerEvent = { clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType }; applyPointer();
  drag = null; ground.style.transform = ''; byId('map-pins').style.transform = '';
  if (dragged) invalidateView();
};
canvas.onpointercancel = () => {
  if (drag) { view = drag.view; drag = null; ground.style.transform = ''; byId('map-pins').style.transform = ''; drawMap(); }
  dragged = false;
};
canvas.onwheel = event => {
  if (!archiveEnabled) return;
  event.preventDefault(); zoomMap(event.deltaY > 0 ? 2 : .5);
};
canvas.onclick = event => {
  if (dragged) { dragged = false; return; }
  if (!currentMap) return;
  // First tap on a pin shows its overlay, the next tap marks it;
  // a mouse click on a place or search hit selects it directly, while bot and target pins keep the plain cell click.
  const pin = pinAt(event.clientX, event.clientY);
  if (lastPointerType === 'touch') {
    if (pin && overlayPin !== pin.key) { showOverlay(pin.key); return; }
    hideOverlay();
    if (pin) { activatePin(pin); return; }
  } else if (pin?.spec.kind === 'poi' || pin?.spec.kind === 'hit') { activatePin(pin); return; }
  const bounds = canvas.getBoundingClientRect();
  selectMapTarget((event.clientX - bounds.left) / bounds.width * currentMap.width, (event.clientY - bounds.top) / bounds.height * currentMap.height);
};
canvas.onkeydown = event => {
  if (archiveEnabled && view && event.shiftKey && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) {
    event.preventDefault(); followBot = false;
    view.x += event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0;
    view.z += event.key === 'ArrowDown' ? 16 : event.key === 'ArrowUp' ? -16 : 0;
    invalidateView(); return;
  }
  if (pointerEvent && !drag) applyPointer();
  if (currentMap && mapCursor && ['Enter', ' '].includes(event.key)) {
    event.preventDefault(); selectMapTarget(mapCursor.x + .5, mapCursor.z + .5); return;
  }
  if (!currentMap || !['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const cursor = mapCursor || { x: Math.floor(currentMap.width / 2), z: Math.floor(currentMap.height / 2) };
  describeMapCell(cursor.x + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0), cursor.z + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0));
};
async function loadMap () {
  if (drag || mapRequest || (!mapDirty && Date.now() - lastMapAt < 5000)) return;
  const controller = mapRequest = new AbortController();
  lastMapAt = Date.now(); mapDirty = false;
  try {
    if (archiveEnabled) { await loadTiles(controller); return; }
    const response = await fetch('/api/map', { signal: controller.signal });
    const map = await response.json();
    if (!response.ok) throw new Error(map.error);
    if (mapRequest !== controller) return;
    currentMap = map; mapCursor = null;
    if (map.stale) mapDirty = true;
    setMapSize(map.width, map.height);
    terrainKey = JSON.stringify([map.x, map.z, map.palette, map.cells]);
    byId('map-status').textContent = map.width + ' × ' + map.height + ' Blöcke, X: ' + map.x + ' bis ' + (map.x + map.width - 1) +
      ', Z: ' + map.z + ' bis ' + (map.z + map.height - 1) + '. Höchste bekannte Blöcke. Aktualisierung bei neuen Daten und Ankunft, sonst etwa alle 5 Sekunden.' +
      (map.stale ? ' Weltdaten wurden inzwischen aktualisiert.' : '');
    byId('map-info').textContent = 'Maus oder Finger über die Karte bewegen; Pfeiltasten zeigen benachbarte Blöcke.';
    drawMap();
  } catch (error) {
    if (mapRequest === controller) byId('map-status').textContent = 'Karte konnte nicht aktualisiert werden: ' + error.message;
  } finally { if (mapRequest === controller) mapRequest = null; }
}
async function loadTiles (controller) {
  if (!view) { const size = 112; view = { x: Math.floor((botPosition?.x || 0) - size / 2), z: Math.floor((botPosition?.z || 0) - size / 2), size }; }
  view.x = Math.max(-30000000, Math.min(30000000 - view.size, view.x));
  view.z = Math.max(-30000000, Math.min(30000000 - view.size, view.z));
  const viewport = { ...view }; const dimension = mapDimension;
  const x = Math.floor(viewport.x / 16); const z = Math.floor(viewport.z / 16);
  const width = Math.ceil((viewport.x + viewport.size) / 16) - x;
  const height = Math.ceil((viewport.z + viewport.size) / 16) - z;
  const regions = [];
  for (let dz=0;dz<height;dz+=8) for (let dx=0;dx<width;dx+=8) {
    regions.push({dimension,x:x+dx,z:z+dz,width:Math.min(8,width-dx),height:Math.min(8,height-dz)});
  }
  const manifest = {tiles:[],session:worldSession,error:null};
  for (let offset=0;offset<regions.length;offset+=4) {
    const pages = await Promise.all(regions.slice(offset,offset+4).map(async region => {
      const query = new URLSearchParams(region);
      const response = await fetch('/api/map/tiles?' + query, {signal:controller.signal});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result;
    }));
    if (mapRequest !== controller || pages.some(page => page.session !== worldSession)) { mapDirty = true; return; }
    for (const page of pages) {
      manifest.tiles.push(...page.tiles.filter(tile => !tile.empty));
      if (page.error) manifest.error = page.error;
    }
  }
  const visibleTiles = new Map((currentMap?.tiles || []).map(tile => [tile.dimension + ':' + tile.x + ':' + tile.z,tile]));
  const tiles = [];
  for (let offset = 0; offset < manifest.tiles.length; offset += 4) {
    const batch = await Promise.all(manifest.tiles.slice(offset, offset + 4).map(async item => {
      const key = dimension + ':' + item.x + ':' + item.z;
      let tile = tileCache.get(key) || visibleTiles.get(key);
      if (tile?.hash !== item.hash) {
        const params = new URLSearchParams({dimension, x:item.x, z:item.z});
        const result = await fetch('/api/map/tile?' + params, {signal:controller.signal, headers:tile ? {'If-None-Match':'"' + tile.hash + '"'} : {}});
        if (result.status !== 304) {
          const data = await result.json();
          if (!result.ok) throw new Error(data.error);
          if (mapRequest !== controller || data.session !== worldSession) { mapDirty = true; return null; }
          tile = data;
          if (tile.hash !== item.hash) mapDirty = true;
        }
      }
      if (mapRequest !== controller) return null;
      tileCache.delete(key); tileCache.set(key, tile);
      while (tileCache.size > 128) tileCache.delete(tileCache.keys().next().value);
      return tile;
    }));
    if (mapRequest !== controller || batch.some(tile => !tile)) return;
    tiles.push(...batch);
  }
  if (mapRequest !== controller) return;
  const palette = []; const indices = new Map();
  const cells = Array(viewport.size * viewport.size).fill(null); const historical = Array(cells.length).fill(false);
  for (const tile of tiles) tile.cells.forEach((cell, i) => {
    if (!cell) return;
    const localX = tile.x * 16 + i % 16 - viewport.x; const localZ = tile.z * 16 + Math.floor(i / 16) - viewport.z;
    if (localX < 0 || localZ < 0 || localX >= viewport.size || localZ >= viewport.size) return;
    if (!indices.has(cell[0])) { indices.set(cell[0], palette.length); palette.push(cell[0]); }
    const offset = localZ * viewport.size + localX;
    cells[offset] = [indices.get(cell[0]), cell[1], cell[2]]; historical[offset] = !tile.live[i];
  });
  currentMap = {x:viewport.x, z:viewport.z, width:viewport.size, height:viewport.size, dimension, cells, historical, palette, tiles, coverage:{session:manifest.session}};
  terrainKey = JSON.stringify([dimension, viewport, tiles.map(tile => tile.hash)]);
  setMapSize(viewport.size, viewport.size);
  byId('map-status').textContent = viewport.size + ' × ' + viewport.size + ' Blöcke. Erkundete Oberflächen bleiben gespeichert; leicht vernebelte Flächen sind historisch.' + (manifest.error ? ' Speicherfehler: ' + manifest.error : '');
  drawMap();
}
let loadingBlockIds = false;
async function loadBlockIds () {
  if (loadingBlockIds || byId('block-ids').children.length) return;
  loadingBlockIds = true;
  try {
    const response = await fetch('/api/block-ids');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const result = await response.json();
    if (!registryReady) return;
    const options = result.blockIds.map(id => { const option = document.createElement('option'); option.value = id; return option; });
    byId('block-ids').replaceChildren(...options);
    byId('block-hint').textContent = options.length + ' Block-IDs verfügbar. Zum Filtern einen Teil der ID eingeben.';
  } catch (error) {
    if (registryReady) byId('block-hint').textContent = 'Blockvorschläge konnten nicht geladen werden. Erneuter Versuch folgt.';
  } finally { loadingBlockIds = false; }
}
byId('search').onsubmit = async event => {
  event.preventDefault(); byId('find').disabled = true; byId('result').textContent = 'Suche läuft …';
  clearSearchResults();
  const controller = searchRequest = new AbortController(); byId('search-reset').disabled = false;
  try {
    const query = new URLSearchParams({block:byId('block').value.trim(), limit:byId('limit').value});
    const response = await fetch('/api/blocks?' + query, { signal: controller.signal });
    const result = await response.json();
    if (searchRequest !== controller) return;
    if (result.coverage && result.coverage.session !== worldSession) throw new Error('Weltsitzung geändert; erneut suchen.');
    if (!response.ok) throw new Error(result.error);
    searchResult = result;
    byId('map-hit-info').textContent = result.hits.length + ' Treffer der letzten Suche mit ⛏️ markiert, auch unter der Oberfläche. Marker anklicken; bei Weltänderungen erneut suchen.';
    drawMap();
    const labels = {found:'Treffer gefunden', not_found:'Keine Treffer im vollständig bekannten Bereich', unknown:'Keine Treffer in bekannten Daten; Umgebung ist unvollständig'};
    byId('result').textContent = labels[result.outcome] + ': ' + result.hits.length + (result.limitReached ? ' (Trefferlimit erreicht)' : '') +
      '. Abdeckung bei Suche: ' + result.coverage.knownSubchunks + '/' + result.coverage.totalSubchunks + ' Subchunks.' +
      (result.stale ? ' Weltdaten wurden inzwischen aktualisiert; bei Bedarf erneut suchen.' : '');
    for (const hit of result.hits) {
      const row = document.createElement('tr');
      for (const value of [hit.x,hit.y,hit.z,hit.distance.toFixed(2)]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
      // A hit row can set the navigation target directly.
      const action = document.createElement('td'); const button = document.createElement('button');
      button.type = 'button'; button.textContent = 'Ziel'; button.ariaLabel = 'Ziel X: ' + hit.x + ', Z: ' + hit.z + ' übernehmen';
      button.onclick = () => selectHitTarget(hit);
      action.append(button); row.append(action);
      byId('hits').append(row);
    }
  } catch (error) { if (searchRequest === controller) byId('result').textContent = error.message; }
  finally { if (searchRequest === controller) { searchRequest = null; byId('find').disabled = false; byId('search-reset').disabled = !searchResult; } }
};
// Reset aborts a running search and clears its results; block ID, limit and target stay.
byId('search-reset').onclick = () => {
  clearSearchResults(); byId('result').textContent = ''; byId('find').disabled = false;
};
// One toggle replaces the separate connect/disconnect buttons.
let connectionCommand = 'connect';
const statusLabels = {disconnected:'Getrennt', connecting:'Verbindet …', spawned:'Verbunden', reconnecting:'Verbindet erneut …', dead:'Verbunden (tot)', error:'Fehler'};
const statusTones = {disconnected:'', connecting:'busy', spawned:'ok', reconnecting:'busy', dead:'bad', error:'bad'};
function showConnection (status) {
  connectionCommand = ['disconnected', 'error'].includes(status) ? 'connect' : 'disconnect';
  byId('connection-toggle').textContent = connectionCommand === 'connect' ? 'Verbinden' : 'Trennen';
  byId('status').textContent = statusLabels[status] || status;
  byId('status').className = 'badge ' + (statusTones[status] || '');
}
byId('connection-toggle').onclick = async () => {
  const command = connectionCommand;
  try {
    const response = await fetch('/api/' + command, {method:'POST',headers:{'Content-Type':'application/json'}});
    if (!response.ok) throw new Error((await response.json()).error || 'HTTP ' + response.status);
    byId('feedback').textContent = 'Befehl angenommen: ' + command;
  } catch (error) { byId('feedback').textContent = error.message; }
};
// The skin is sent at login only: a saved skin that differs from the connection's skin needs a reconnect.
function skinConnected () { return ['connecting','spawned','reconnecting','dead'].includes(botStatus); }
function renderSkin () {
  if (!skinEnabled || !skinState) return;
  const preview = byId('skin-preview');
  preview.hidden = !skinState.saved;
  if (skinState.saved && skinPreviewHash !== skinState.saved) { skinPreviewHash = skinState.saved; preview.src = '/api/skin?h=' + skinState.saved; }
  const pending = skinConnected() && skinState.saved !== skinState.active;
  const label = skinState.saved ? 'Eigener Skin (' + (skinState.model === 'slim' ? 'Slim' : 'Classic') + ')' : 'Standard-Skin';
  byId('skin-status').textContent = skinState.error ? 'Skin-Datei fehlerhaft: ' + skinState.error + '. Der Bot verbindet mit dem Standard-Skin.'
    : label + (pending ? ' gespeichert – beim nächsten Verbinden aktiv.' : skinConnected() ? ' aktiv.' : ' wird beim Verbinden verwendet.');
  byId('skin-reconnect').hidden = !pending;
  byId('skin-reset').disabled = !skinState.saved && !skinState.error;
}
async function skinRequest (url, body) {
  const response = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status);
  return result;
}
byId('skin-upload').onclick = async () => {
  const file = byId('skin-file').files?.[0];
  if (!file) { byId('skin-feedback').textContent = 'Zuerst eine PNG-Datei wählen.'; return; }
  if (file.size > 49152) { byId('skin-feedback').textContent = 'Die Datei ist größer als 48 KB.'; return; }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    skinState = await skinRequest('/api/skin', JSON.stringify({png:btoa(binary), model:byId('skin-model').value}));
    byId('skin-file').value = '';
    byId('skin-feedback').textContent = 'Skin gespeichert.' + (skinConnected() ? ' Er gilt ab der nächsten Verbindung.' : '');
  } catch (error) { byId('skin-feedback').textContent = 'Hochladen fehlgeschlagen: ' + error.message; }
  renderSkin();
};
byId('skin-reset').onclick = async () => {
  try {
    skinState = await skinRequest('/api/skin/delete');
    byId('skin-feedback').textContent = 'Standard-Skin wiederhergestellt.' + (skinConnected() ? ' Er gilt ab der nächsten Verbindung.' : '');
  } catch (error) { byId('skin-feedback').textContent = 'Zurücksetzen fehlgeschlagen: ' + error.message; }
  renderSkin();
};
byId('skin-reconnect').onclick = async () => {
  try {
    await skinRequest('/api/disconnect');
    await skinRequest('/api/connect');
    byId('skin-feedback').textContent = 'Verbindet mit dem neuen Skin neu …';
  } catch (error) { byId('skin-feedback').textContent = 'Neu verbinden fehlgeschlagen: ' + error.message; }
};
// The chat starts collapsed on phones; from 1400px it is a left column that always stays open.
const wideChat = globalThis.matchMedia?.('(min-width: 1400px)');
if (wideChat) {
  byId('chat-panel').open = !globalThis.matchMedia('(max-width: 900px)').matches;
  wideChat.onchange = () => { if (wideChat.matches) byId('chat-panel').open = true; };
}
byId('chat-panel').ontoggle = () => { const log = byId('chat-log'); log.scrollTop = log.scrollHeight; };
const events = new EventSource('/api/events');
events.onmessage = event => {
  const state = JSON.parse(event.data);
  showConnection(state.status);
  botStatus = state.status;
  if (state.skin) skinState = state.skin;
  renderSkin();
  byId('position').textContent = state.position ? Object.entries(state.position).map(([k,v])=>k+': '+v.toFixed(2)).join(' / ') + (state.positionSource === 'predicted' ? ' (Client-Prognose)' : ' (Server)') : 'Unbekannt';
  const nextDimension = dimensionNumber(state.dimension);
  if (archiveEnabled && followBot && nextDimension !== null && mapDimension !== nextDimension) {
    mapDimension = nextDimension; byId('map-dimension').value = String(mapDimension); mapDirty = true;
    if (mapRequest) mapRequest.abort(); mapRequest = null; currentMap = null;
  }
  lastDimension = state.dimension;
  const navigation = state.navigation;
  navigationBusy = ['planning','moving'].includes(navigation?.status);
  latestRevision = state.worldRevision ?? 0;
  byId('nav-start').disabled = state.status !== 'spawned' || ['planning','moving'].includes(navigation?.status);
  if (navigation) {
    const labels = {idle:'Inaktiv', planning:'Weg wird gesucht', moving:'Unterwegs', stopped:'Gestoppt', arrived:'Ziel laut Client-Prognose erreicht', error:'Navigation abgebrochen'};
    byId('nav-status').textContent = labels[navigation.status] + (navigation.target ? ' – X: ' + navigation.target.x + ', Z: ' + navigation.target.z + ', Fußhöhe Y: ' + (navigation.feetY === null ? '—' : navigation.feetY.toFixed(2)) : '') +
      ', verbleibende Wegpunkte: ' + navigation.remaining + (navigation.message ? '. ' + navigation.message : '');
  }
  byId('dimension').textContent = state.dimension ?? 'Unbekannt';
  byId('chunks').textContent = state.loadedChunks;
  byId('tick').textContent = state.tick;
  byId('error').textContent = state.lastError || '—';
  const coverage = state.coverage;
  const nextMapContext = JSON.stringify([coverage?.session,latestRevision,coverage?.knownSubchunks,state.position ? Math.floor(state.position.x/16) : null,state.position ? Math.floor(state.position.z/16) : null]);
  // The target pin disappears once the bot arrives at that target.
  if (navigation?.status === 'arrived' && previousNavigationStatus !== 'arrived' && navigation.target &&
      byId('target-x').value === String(navigation.target.x) && byId('target-z').value === String(navigation.target.z)) {
    byId('target-x').value = ''; byId('target-z').value = ''; previewWanted = false; cancelPreview();
  }
  if (nextMapContext !== mapContext || (navigation?.status === 'arrived' && previousNavigationStatus !== 'arrived')) mapDirty = true;
  mapContext = nextMapContext; previousNavigationStatus = navigation?.status;
  if (worldSession !== coverage?.session) {
    worldSession = coverage?.session; cancelPreview(); previewWanted = false;
    clearSearchResults(); byId('find').disabled = false; byId('result').textContent = '';
    if (mapRequest) mapRequest.abort();
    mapRequest = null; currentMap = null; mapCursor = null; lastMapAt = 0; canvas.hidden = true; byId('map-frame').hidden = true; renderedTerrainKey = null;
  }
  registryReady = Boolean(coverage?.ready);
  botPosition = state.position;
  players = Array.isArray(state.players) ? state.players : [];
  renderPlayers(Array.isArray(state.roster) ? state.roster : [], state.status === 'spawned');
  if (state.chatRevision !== chatRevision) { chatRevision = state.chatRevision; void loadChat(); }
  if (archiveEnabled && followBot && botPosition && view && !drag) {
    const x = Math.floor(botPosition.x - view.size / 2); const z = Math.floor(botPosition.z - view.size / 2);
    if (Math.abs(x - view.x) >= 16 || Math.abs(z - view.z) >= 16) {
      view = { ...view, x, z }; mapDirty = true;
      if (mapRequest) mapRequest.abort(); mapRequest = null;
    }
  }
  // Refetch places after server-side changes or a dimension switch; refresh distances after movement.
  if (placesEnabled) {
    if (state.placesRevision !== placesRevision || placesDimension !== mapDimension) { placesRevision = state.placesRevision; void loadPlaces(); }
    else if (botPosition && (!placesRenderedAt || Math.hypot(botPosition.x - placesRenderedAt.x, botPosition.z - placesRenderedAt.z) >= 4)) renderPlaces();
  }
  if (navigationBusy || !registryReady) cancelPreview();
  else if (previewWanted && previewContext !== JSON.stringify([worldSession,latestRevision,navigationBusy,botPosition,byId('target-x').value,byId('target-z').value])) schedulePreview();
  mapNavigation = state.status === 'spawned' && navigation?.status === 'moving' && registryReady ?
    {session:coverage.session, path:navigation.path || []} : null;
  if (registryReady) { byId('find').disabled = Boolean(searchRequest); void loadBlockIds(); void loadMap(); drawMap(); }
  else if (archiveEnabled) {
    clearSearchResults(); byId('find').disabled = true; byId('block-ids').replaceChildren();
    byId('block-hint').textContent = 'Blockvorschläge verfügbar, sobald die Registry geladen ist.';
    void loadMap(); drawMap();
  }
  else {
    clearSearchResults(); byId('find').disabled = false; byId('result').textContent = '';
    if (mapRequest) mapRequest.abort();
    mapRequest = null; currentMap = null; mapCursor = null; lastMapAt = 0; canvas.hidden = true; byId('map-frame').hidden = true; renderedTerrainKey = null;
    byId('map-status').textContent = 'Karte verfügbar, sobald Weltdaten geladen sind.';
    byId('map-info').textContent = 'Noch keine Karte geladen.';
    byId('block-ids').replaceChildren();
    byId('block-hint').textContent = 'Blockvorschläge verfügbar, sobald die Registry geladen ist.';
  }
  if (coverage) byId('coverage').textContent = coverage.knownSubchunks + '/' + coverage.totalSubchunks + ' Subchunks bekannt, ' +
    coverage.completeChunks + '/' + coverage.expectedChunks + ' Chunks vollständig, Radius ' + coverage.radius + '. ' +
    (coverage.complete ? 'Bereich vollständig geladen.' : 'Unbekannte Bereiche werden nicht als Luft gewertet.') +
    (coverage.error ? ' Letzter Datenfehler: ' + coverage.error : '');
};
events.onerror = () => { cancelPreview(); mapNavigation = null; drawMap(); byId('feedback').textContent = 'Statusverbindung unterbrochen. Wiederverbindung läuft.'; };
events.onopen = () => { byId('feedback').textContent = 'Statusverbindung aktiv.'; };
