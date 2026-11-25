import { parentPort } from 'node:worker_threads'
import { ViewerMapping } from './viewer-mapping.js'

let mapping: ViewerMapping | null = null
parentPort!.on('message', async ({ id, version, x, z, sections }) => {
  try {
    mapping ??= new ViewerMapping(version)
    const result = await mapping.column({ x, z, sections: new Map(sections) } as any, () => false)
    parentPort!.postMessage({ id, chunk: result!.chunk, missing: mapping.missing })
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : 'Chunk conversion failed' })
  }
})
