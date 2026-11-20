const {test}=require('node:test')
const assert=require('node:assert/strict')
const vm=require('node:vm')
const fs=require('node:fs')

test('batched terrain pixels retain colors, missing data, uncertainty and historical shading',()=>{
  // The page script moved from web.ts to src/ui/app.js (copied to dist/ui).
  const source=fs.readFileSync(require.resolve('../dist/ui/app.js'),'utf8')
  const code=source.slice(source.indexOf('function blockColor ('),source.indexOf('function paintTerrain ()'))
  let pixels,swatches=0,reads=0,writes=0
  const context=vm.createContext({
    document:{createElement:()=>({getContext:()=>({fillRect(){swatches++},getImageData(){reads++;return{data:new Uint8ClampedArray([10,20,30,255])}}})})},
    target:{createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),putImageData(image,x,z){assert.equal(x,0);assert.equal(z,0);pixels=image.data;writes++}}
  })
  vm.runInContext(code,context)
  vm.runInContext(`rasterCells(target,[['minecraft:stone',63,true],null,['minecraft:grass_block',64,false],['minecraft:stone',63,true]],2,null,[false,true,false,true])`,context)
  assert.deepEqual([...pixels],[93,93,93,255,32,43,64,255,105,148,46,255,112,113,115,255])
  assert.equal(writes,1,'One pixel upload replaces per-cell canvas commands')
  vm.runInContext(`rasterCells(target,[['minecraft:grass_block',64,false],['minecraft:unknown_color',64,true],['minecraft:unknown_color',64,true],['minecraft:stone',63,true]],2,null,[true,false,false,false])`,context)
  assert.deepEqual([...pixels.slice(0,4)],[213,180,104,255],'Unconfirmed yellow remains visible beneath light historical fog')
  assert.deepEqual([...pixels.slice(4,8)],[10,19,29,255],'Height tint slightly darkens blocks below the middle of the world height')
  assert.equal(swatches,1,'Non-hex colors are resolved once through native canvas')
  assert.equal(reads,1,'Block color cache survives complete tile raster rebuilds')
  vm.runInContext(`rasterCells(target,[[0,63,true]],1,['minecraft:water'])`,context)
  assert.deepEqual([...pixels],[57,123,184,255],'Legacy palette maps use the same pixel path')
})

function loadRaster (end, globals) {
  const source=fs.readFileSync(require.resolve('../dist/ui/app.js'),'utf8')
  const context=vm.createContext(globals)
  vm.runInContext(source.slice(source.indexOf('function blockColor ('),source.indexOf(end)),context)
  return context
}

test('relief compares each block with its northern neighbour and ignores unknown or unsafe neighbours',()=>{
  let pixels
  const context=loadRaster('function paintTerrain ()',{
    document:{createElement:()=>({getContext:()=>({fillRect(){},getImageData(){return{data:new Uint8ClampedArray([0,0,0,255])}}})})},
    target:{createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),putImageData(image){pixels=image.data}}
  })
  const red=index=>pixels[index*4]
  vm.runInContext(`rasterCells(target,[
    ['minecraft:stone',128,true],['minecraft:stone',128,true],['minecraft:stone',129,true],['minecraft:stone',132,true],
    ['minecraft:stone',131,true],['minecraft:stone',128,true],null,['minecraft:stone',128,true],
    ['minecraft:stone',140,false],['minecraft:stone',150,true],['minecraft:water',50,true],['minecraft:air',null,true],
    ['minecraft:stone',128,true]],1,null,null,0)`,context)
  assert.equal(red(0),96,'Without a northern neighbour only the height tint applies')
  assert.equal(red(1),96,'Equal height keeps the base color')
  assert.equal(red(2),104,'One block higher is slightly brighter')
  assert.equal(red(3),108,'Three or more blocks higher is clearly brighter')
  assert.equal(red(4),88,'One block lower is slightly darker')
  assert.equal(red(5),77,'Three or more blocks lower is clearly darker')
  assert.equal(red(7),96,'An unknown neighbour creates no edge')
  assert.deepEqual([...pixels.slice(32,35)],[213,172,80],'Missing data above keeps its unshaded pattern')
  assert.equal(red(9),97,'An unconfirmed neighbour creates no edge')
  assert.deepEqual([...pixels.slice(40,43)],[57,123,184],'Water stays flat')
  assert.deepEqual([...pixels.slice(44,47)],[51,65,85],'Fully known air is not shaded')
  assert.equal(red(12),96,'Air without height creates no edge')
  vm.runInContext(`rasterCells(target,[['minecraft:stone',64,true]],1,null,null,1)`,context)
  assert.equal(red(0),96,'The tint uses the height range of the dimension')
  vm.runInContext(`rasterCells(target,[['minecraft:stone',64,true]],1,null,null,0)`,context)
  assert.equal(red(0),93)
  vm.runInContext(`rasterCells(target,[['minecraft:stone',128,true]],1,null,null,0,[['minecraft:stone',125,true]])`,context)
  assert.equal(red(0),108,'The first row uses the supplied northern row')
  assert.equal(vm.runInContext(`blockColor('minecraft:oak_stairs')`,context),'#7b6640')
  assert.equal(vm.runInContext(`blockColor('minecraft:stone_brick_slab')`,context),'#606060')
  assert.equal(vm.runInContext(`blockColor('minecraft:light_blue_concrete')`,context),'#5884ba')
  assert.equal(vm.runInContext(`blockColor('minecraft:red_wool')`,context),'#832c2c')
  assert.equal(vm.runInContext(`blockColor('minecraft:red_sandstone')`,context),'#ba6d2c')
})

test('tile relief uses the northern tile and re-rasters when it appears or changes',()=>{
  let rasters=0, key=0
  const context=loadRaster('function drawMap ()',{
    document:{createElement:()=>{const raster={getContext:()=>({createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),putImageData(image){raster.pixels=image.data;rasters++}})};return raster}},
    groundContext:{fillRect(){},drawImage(){}}, currentMap:null, terrainKey:null, renderedTerrainKey:null
  })
  const tile=(z,height,hash)=>({x:0,z,hash,cells:Array.from({length:256},()=>['minecraft:stone',height,true]),live:Array(256).fill(true)})
  const paint=tiles=>{context.currentMap={x:0,z:0,width:16,height:32,dimension:0,tiles};context.terrainKey=String(++key);vm.runInContext('paintTerrain()',context)}
  const south=tile(1,128,'s')
  paint([south])
  assert.equal(rasters,1)
  assert.equal(south.raster.pixels[0],96)
  const north=tile(0,125,'n1')
  paint([south,north])
  assert.equal(rasters,3,'A newly visible northern tile re-rasters the tile below')
  assert.equal(south.raster.pixels[0],108)
  assert.equal(south.raster.pixels[64],96,'Rows inside the tile compare with their own northern row')
  paint([south,north])
  assert.equal(rasters,3,'Unchanged fingerprints reuse both rasters')
  paint([south,tile(0,128,'n2')])
  assert.equal(rasters,5,'A changed northern fingerprint re-rasters the tile below')
  assert.equal(south.raster.pixels[0],96)
})
