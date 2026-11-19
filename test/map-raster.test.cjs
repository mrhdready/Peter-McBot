const {test}=require('node:test')
const assert=require('node:assert/strict')
const vm=require('node:vm')
const fs=require('node:fs')

test('batched terrain pixels retain colors, missing data, uncertainty and historical shading',()=>{
  const source=fs.readFileSync(require.resolve('../dist/web.js'),'utf8')
  const code=source.slice(source.indexOf('function blockColor ('),source.indexOf('function paintTerrain ()'))
  let pixels,swatches=0,reads=0,writes=0
  const context=vm.createContext({
    document:{createElement:()=>({getContext:()=>({fillRect(){swatches++},getImageData(){reads++;return{data:new Uint8ClampedArray([10,20,30,255])}}})})},
    target:{createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),putImageData(image,x,z){assert.equal(x,0);assert.equal(z,0);pixels=image.data;writes++}}
  })
  vm.runInContext(code,context)
  vm.runInContext(`rasterCells(target,[['minecraft:stone',63,true],null,['minecraft:grass_block',64,false],['minecraft:stone',63,true]],2,null,[false,true,false,true])`,context)
  assert.deepEqual([...pixels],[133,139,146,255,32,43,64,255,118,166,75,255,145,152,160,255])
  assert.equal(writes,1,'One pixel upload replaces per-cell canvas commands')
  vm.runInContext(`rasterCells(target,[['minecraft:grass_block',64,false],['minecraft:unknown_color',64,true],['minecraft:unknown_color',64,true],['minecraft:stone',63,true]],2,null,[true,false,false,false])`,context)
  assert.deepEqual([...pixels.slice(0,4)],[213,180,104,255],'Unconfirmed yellow remains visible beneath light historical fog')
  assert.deepEqual([...pixels.slice(4,8)],[10,20,30,255])
  assert.equal(swatches,1,'Non-hex colors are resolved once through native canvas')
  assert.equal(reads,1,'Block color cache survives complete tile raster rebuilds')
  vm.runInContext(`rasterCells(target,[[0,63,true]],1,['minecraft:water'])`,context)
  assert.deepEqual([...pixels],[57,123,184,255],'Legacy palette maps use the same pixel path')
})
