/* Local vendored codecs; see vendor/README.md and bundled licenses. */
function LocalCodecs() {
 if (LocalCodecs.instance) return LocalCodecs.instance;
 const fflate = (() => { const module={exports:{}}, exports=module.exports;
__FFLATE_SOURCE__
 return module.exports; })();
 const brotli = (() => {
__BROTLI_SOURCE__
 return {init, compress, DecompressStream}; })();
 const lzma = (() => {
__LZMA_SOURCE__
 return lzma_wasm;
 })();
__XZ_ADAPTER__
 const base64=__BROTLI_BASE64__;
 let brReady;
 function ready() {
  if (!brReady) brReady=(async()=>{ const raw=atob(base64), bytes=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i); await brotli.init(bytes); return true; })().catch(()=>false);
  return brReady;
 }
 function collect(chunks,length) {const out=new Uint8Array(length);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length;}return out;}
 function inflate(bytes,limit) {
  const chunks=[];let length=0;const decoder=new fflate.Inflate(chunk=>{length+=chunk.length;if(length>limit)throw new Error('解压数据超过预期长度');chunks.push(chunk);});
  for(let start=0;start<bytes.length;start+=1024)decoder.push(bytes.subarray(start,start+1024),start+1024>=bytes.length);
  return collect(chunks,length);
 }
 async function unbrotli(bytes,limit) {
  if (!await ready()) throw new Error('Brotli WASM 不可用，无法解码此分块');
  const decoder=new brotli.DecompressStream(),chunks=[];let offset=0,length=0;
  try {for(;;){let result;try{
   result=decoder.decompress(bytes.subarray(offset),Math.min(65536,limit-length+1));
   const chunk=result.buf, consumed=result.input_offset, code=result.code;offset+=consumed;length+=chunk.length;
   if(length>limit)throw new Error('解压数据超过预期长度');chunks.push(chunk);
   if(code===1){if(offset!==bytes.length)throw new Error('Brotli 分块含未定义尾部');return collect(chunks,length);}
   if(code===2&&offset===bytes.length)throw new Error('Brotli 分块被截断');
   if(!consumed&&!chunk.length)throw new Error('Brotli 解码未推进');
  }finally{if(result)result.free();}}}finally{decoder.free();}
 }
 const api={ready,readyLzma,async available(format){if(format==='deflate-js9')return true;if(format==='brotli-wasm5'||format==='brotli-wasm11')return ready();if(format==='lzma2-xz3')return readyLzma();return false;},async run(bytes,format,decode,limit=160000000){
  if(!Number.isFinite(limit))limit=160000000;
  if(!Number.isInteger(limit)||limit<0||limit>160000000)throw new Error('解压长度限制无效');
  if(format==='deflate-js9')return decode?inflate(bytes,limit):fflate.deflateSync(bytes,{level:9,mem:8});
  if(format==='lzma2-xz3'){if(decode)return unxz(bytes,limit);if(!await readyLzma())throw new Error('LZMA2 WASM 不可用');if(!bytes.length)return Uint8Array.from([253,55,122,88,90,0,0,4,230,214,180,70,0,0,0,0,28,223,68,33,31,182,243,125,1,0,0,0,0,4,89,90]);return lzma.compress(bytes,{format:'xz',level:3});}
  if(format==='brotli-wasm5'||format==='brotli-wasm11'){if(!await ready())throw new Error('Brotli WASM 不可用');return decode?unbrotli(bytes,limit):brotli.compress(bytes,{quality:format==='brotli-wasm11'?11:5});}
  throw new Error('未知本地压缩格式');
 }};
 return LocalCodecs.instance=api;
}
if(typeof module!=='undefined')module.exports=LocalCodecs;
