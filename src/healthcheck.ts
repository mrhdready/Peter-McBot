import { get } from 'node:http'

export function checkHealth (url = 'http://127.0.0.1:3000/healthz', timeout = 2000): Promise<boolean> {
  return new Promise(resolve => {
    const request = get(url, { agent: false }, response => {
      response.resume()
      resolve(response.statusCode === 200)
    })
    request.setTimeout(timeout, () => request.destroy())
    request.on('error', () => resolve(false))
  })
}

if (require.main === module) void checkHealth().then(ok => { process.exitCode = ok ? 0 : 1 })
