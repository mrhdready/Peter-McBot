import { parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { ViewerMapping, VIEWER_VERSION } from './viewer-mapping.js'

let mapping: ViewerMapping | null = null
// One worker lives while 3D viewers are connected, so each fallback state is logged once per viewer session.
const reported = new Set<number>()
parentPort!.on('message', async ({ id, version, assets, x, z, sections }) => {
  try {
    if (!mapping) {
      let names: Set<string> | undefined
      try { names = new Set(Object.keys(JSON.parse(readFileSync(assets.blockStates, 'utf8')))) } catch { names = undefined }
      mapping = new ViewerMapping(version, names)
      console.log(`[viewer] palette java ${VIEWER_VERSION}, assets ${assets.source}, ${mapping.missing} bedrock states unmapped` +
        (names ? `, ${mapping.withoutModel} without model` : ', model check unavailable'))
    }
    const current = mapping
    const result = await current.column({ x, z, sections: new Map(sections) } as any, () => false, (state, bx, by, bz) => {
      if (reported.has(state)) return
      reported.add(state)
      console.log(`[viewer] unmapped ${current.describe(state)} reason=${current.issue(state)} at ${bx},${by},${bz}`)
    })
    parentPort!.postMessage({ id, chunk: result!.chunk, missing: current.missing })
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : 'Chunk conversion failed' })
  }
})
