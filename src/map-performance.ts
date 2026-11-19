import { readFile } from 'node:fs/promises'

export async function mapRuntimeMetrics () {
  const read = async (name: string) => {
    try { return (await readFile('/sys/fs/cgroup/' + name, 'utf8')).trim() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  const [cpu, memory, limit, quota, memoryStat] = await Promise.all(['cpu.stat', 'memory.current', 'memory.max', 'cpu.max', 'memory.stat'].map(read))
  const fields = (text: string | null) => Object.fromEntries((text || '').split('\n').filter(Boolean).map(line => { const [key, value] = line.split(/\s+/); return [key, Number(value)] }))
  const cpuStat = fields(cpu); const memStat = fields(memoryStat)
  const cpuMax = quota?.split(/\s+/)
  return {
    timestamp: new Date().toISOString(), monotonicMs: performance.now(),
    process: { cpu: process.cpuUsage(), memory: process.memoryUsage() },
    container: {
      cpuUsageUsec: cpuStat.usage_usec ?? null, throttledUsec: cpuStat.throttled_usec ?? null,
      memoryBytes: memory === null ? null : Number(memory),
      memoryLimitBytes: limit === null || limit === 'max' ? null : Number(limit),
      inactiveFileBytes: memStat.inactive_file ?? null,
      cpuLimitCores: !cpuMax || cpuMax[0] === 'max' ? null : Number(cpuMax[0]) / Number(cpuMax[1])
    }
  }
}

export const mapPerformancePanel = `<script>
(() => {
  const panel = document.createElement('section');
  panel.innerHTML = '<h2>Kartenperformance messen</h2><p>10 s Ruhe, 10 s Cursorbewegung, 60 erzwungene Gelände-Neuaufbauten. Keine Navigation. Renderzeiten messen JavaScript-/Canvas-Aufrufe; FPS messen requestAnimationFrame-Abstände, keine garantierten GPU-Presentations.</p><button id="measure-map" type="button">Kartenmessung starten</button><p id="measure-status" role="status">Bereit, sobald die Karte geladen ist.</p><pre id="measure-result" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>';
  byId('map-controls').before(panel);
  let active = null;
  const originalDraw = drawMap;
  drawMap = function () {
    const start = performance.now();
    try { return originalDraw(); }
    finally { if (active) active.drawMs.push(performance.now() - start); }
  };
  const originalTerrain = paintTerrain;
  paintTerrain = function () {
    const changed = renderedTerrainKey !== terrainKey; const start = performance.now();
    try { return originalTerrain(); }
    finally { if (active && changed) active.terrainMs.push(performance.now() - start); }
  };
  const stats = values => {
    const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
    return { count:sorted.length, mean:sorted.length ? sorted.reduce((a,b)=>a+b,0)/sorted.length : null,
      p50:sorted.length ? sorted[Math.ceil(sorted.length*.5)-1] : null,
      p95:sorted.length ? sorted[Math.ceil(sorted.length*.95)-1] : null, max:sorted.at(-1) ?? null };
  };
  const runtime = async () => {
    const response = await fetch('/api/map-performance');
    if (!response.ok) throw new Error('Laufzeitmessung: HTTP ' + response.status);
    return response.json();
  };
  async function phase (name, mode) {
    const sample = {name, drawMs:[], terrainMs:[], frameMs:[], runtime:[await runtime()], longTasks:[]};
    let observer = null;
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      observer = new PerformanceObserver(list => sample.longTasks.push(...list.getEntries().map(entry => entry.duration)));
      observer.observe({type:'longtask'});
    }
    let reading = null;
    const timer = setInterval(() => {
      if (!reading) reading = runtime().then(value => sample.runtime.push(value)).catch(error => {sample.error=error.message;}).finally(()=>{reading=null;});
    },1000);
    const bounds = canvas.getBoundingClientRect();
    let start = null; let last = null; let frames = 0;
    active = sample;
    try {
      await new Promise((resolve,reject) => {
        const frame = at => {
          if (document.visibilityState !== 'visible') return reject(new Error('Messung abgebrochen: Tab muss sichtbar bleiben.'));
          if (!currentMap) return reject(new Error('Karte wurde während der Messung verworfen.'));
          if (start === null) start = at;
          if (last !== null) sample.frameMs.push(at-last);
          last = at; frames++;
          if (mode === 'cursor') {
            for (let event=0;event<5;event++) canvas.dispatchEvent(new PointerEvent('pointermove',{
              clientX:bounds.left+(frames*7+event)%Math.max(1,Math.floor(bounds.width)),
              clientY:bounds.top+bounds.height*.55, bubbles:true
            }));
          } else if (mode === 'terrain') {
            for (const tile of currentMap.tiles || []) tile.raster = null;
            renderedTerrainKey = null; drawMap();
          }
          if (mode === 'terrain' ? frames >= 60 : at-start >= 10000) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
    } finally {
      active = null; clearInterval(timer); if (reading) await reading;
      if (observer) { sample.longTasks.push(...observer.takeRecords().map(entry=>entry.duration)); observer.disconnect(); }
    }
    sample.runtime.push(await runtime());
    const first = sample.runtime[0]; const end = sample.runtime.at(-1);
    const elapsedMs = end.monotonicMs-first.monotonicMs;
    const rates = sample.runtime.slice(1).map((value,i) => {
      const old = sample.runtime[i]; const ms = value.monotonicMs-old.monotonicMs;
      return {
        processCpuPercent:100*((value.process.cpu.user+value.process.cpu.system)-(old.process.cpu.user+old.process.cpu.system))/(ms*1000),
        containerCpuPercent:value.container.cpuUsageUsec === null || old.container.cpuUsageUsec === null ? null : 100*(value.container.cpuUsageUsec-old.container.cpuUsageUsec)/(ms*1000)
      };
    });
    return {
      name, durationMs:last-start, visibility:document.visibilityState, frameIntervalMs:stats(sample.frameMs),
      rafFps:sample.frameMs.length*1000/sample.frameMs.reduce((a,b)=>a+b,0),
      framesOver25ms:sample.frameMs.filter(ms=>ms>25).length, drawMs:stats(sample.drawMs),terrainMs:stats(sample.terrainMs),
      longTaskMs:stats(sample.longTasks), browserJsHeapBytes:performance.memory?.usedJSHeapSize ?? null,
      processCpuPercent:100*((end.process.cpu.user+end.process.cpu.system)-(first.process.cpu.user+first.process.cpu.system))/(elapsedMs*1000),
      containerCpuPercent:end.container.cpuUsageUsec === null || first.container.cpuUsageUsec === null ? null : 100*(end.container.cpuUsageUsec-first.container.cpuUsageUsec)/(elapsedMs*1000),
      containerCpuPeakPercent:stats(rates.map(value=>value.containerCpuPercent).filter(value=>value!==null)).max,
      processRssBytes:stats(sample.runtime.map(value=>value.process.memory.rss)),
      containerMemoryBytes:stats(sample.runtime.map(value=>value.container.memoryBytes).filter(value=>value!==null)),
      containerWorkingSetBytes:stats(sample.runtime.filter(value=>value.container.memoryBytes!==null&&value.container.inactiveFileBytes!==null).map(value=>value.container.memoryBytes-value.container.inactiveFileBytes)),
      limits:end.container, throttledUsecDelta:end.container.throttledUsec===null||first.container.throttledUsec===null?null:end.container.throttledUsec-first.container.throttledUsec,
      raw:sample, error:sample.error || null
    };
  }
  byId('measure-map').onclick = async () => {
    if (!currentMap || navigationBusy) { byId('measure-status').textContent='Karte muss geladen und Navigation beendet sein.'; return; }
    byId('measure-map').disabled = true; byId('measure-result').textContent = '';
    const result = { startedAt:new Date().toISOString(), userAgent:navigator.userAgent, width:currentMap.width,height:currentMap.height,devicePixelRatio, phases:[] };
    try {
      canvas.scrollIntoView({block:'center'});
      for (const [name,mode] of [['Ruhe','idle'],['Cursor, 5 Ereignisse pro Frame','cursor'],['Gelände-Neuaufbau, Cache absichtlich geleert','terrain']]) {
        byId('measure-status').textContent = 'Messung läuft: ' + name;
        result.phases.push(await phase(name,mode));
      }
      result.finishedAt = new Date().toISOString();
      byId('measure-result').textContent = JSON.stringify(result,null,2);
      byId('measure-status').textContent = 'Messung abgeschlossen.';
    } catch (error) { byId('measure-status').textContent = 'Messfehler: ' + error.message; }
    finally { byId('measure-map').disabled = false; }
  };
})();
</script>`
