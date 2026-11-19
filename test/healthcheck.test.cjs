const {test}=require('node:test')
const assert=require('node:assert/strict')
const {createServer}=require('node:http')
const {once}=require('node:events')
const {checkHealth}=require('../dist/healthcheck.js')

test('lightweight healthcheck accepts only HTTP 200 and rejects errors and timeouts',async t=>{
  const server=createServer((request,response)=>{
    if(request.url==='/slow')return
    response.writeHead(request.url==='/healthz'?200:503);response.end('ok')
  })
  t.after(()=>{server.closeAllConnections();server.close()})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const base=`http://127.0.0.1:${server.address().port}`
  assert.equal(await checkHealth(base+'/healthz'),true)
  assert.equal(await checkHealth(base+'/bad'),false)
  assert.equal(await checkHealth(base+'/slow',30),false)
  await new Promise(resolve=>server.close(resolve))
  assert.equal(await checkHealth(base+'/healthz'),false)
})
