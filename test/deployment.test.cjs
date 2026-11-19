const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {spawnSync}=require('node:child_process')

test('Arcane preparation requires explicit server configuration and preserves configured values', t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mc-bot-deployment-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  const project=path.resolve(__dirname,'..')
  for(const name of ['Dockerfile','.dockerignore','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','src','patches','test/terrain.test.cjs','deploy/arcane-template','scripts/prepare-arcane.cjs']){
    fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true})
    fs.cpSync(path.join(project,name),path.join(root,name),{recursive:true})
  }
  const env={...process.env}
  delete env.BEDROCK_HOST
  const missing=spawnSync(process.execPath,['scripts/prepare-arcane.cjs'],{cwd:root,env,encoding:'utf8'})
  assert.notEqual(missing.status,0)
  assert.match(missing.stderr,/BEDROCK_HOST is required/)
  assert.equal(fs.existsSync(path.join(root,'deploy/arcane')),false)
  const configured=spawnSync(process.execPath,['scripts/prepare-arcane.cjs'],{cwd:root,encoding:'utf8',env:{...env,
    BEDROCK_HOST:'192.0.2.10',BEDROCK_PORT:'19133',BEDROCK_VERSION:'1.26.60',BEDROCK_ICE_HOST:'192.0.2.20',BOT_NAME:'PublicTest',CHUNK_RADIUS:'5'}})
  assert.equal(configured.status,0,configured.stderr)
  const compose=JSON.parse(fs.readFileSync(path.join(root,'deploy/arcane/compose.yaml'),'utf8'))
  assert.deepEqual(compose.services.bot.environment,{
    BEDROCK_HOST:'192.0.2.10',BEDROCK_PORT:'19133',BEDROCK_VERSION:'1.26.60',BEDROCK_TRANSPORT:'nethernet',
    BEDROCK_ICE_HOST:'192.0.2.20',BOT_NAME:'PublicTest',CHUNK_RADIUS:'5',WEB_HOST:'0.0.0.0',WEB_PORT:'3000'
  })
  assert.equal(compose.services.bot.cpus,.5)
  assert.equal(compose.services.bot.mem_limit,'256m')
  assert.ok(fs.existsSync(path.join(root,'deploy/arcane/src/main.ts')))
  assert.equal(fs.existsSync(path.join(root,'deploy/arcane/.env')),false)
  assert.equal(fs.existsSync(path.join(root,'deploy/arcane/config')),false)
})
