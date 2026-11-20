 // Validate the complete XZ envelope before using the bounded WASM reader.
 // The upstream buffer API can return a prefix without reaching the footer.
 const xzCrcTable = new Uint32Array(256), xz64Low = new Uint32Array(256), xz64High = new Uint32Array(256);
 for (let n=0;n<256;n++) {
  let crc=n,low=n,high=0;
  for(let k=0;k<8;k++) { crc=crc&1?0xedb88320^(crc>>>1):crc>>>1; const bit=low&1;low=(low>>>1)|(high<<31);high>>>=1;if(bit){low^=0xd7870f42;high^=0xc96c5795;} }
  xzCrcTable[n]=crc>>>0;xz64Low[n]=low>>>0;xz64High[n]=high>>>0;
 }
 function xzCrc32(data){let crc=0xffffffff;for(const value of data)crc=xzCrcTable[(crc^value)&255]^(crc>>>8);return(crc^0xffffffff)>>>0;}
 function xzCrc64(data){let low=0xffffffff,high=0xffffffff;for(const value of data){const index=(low^value)&255;low=((low>>>8)|(high<<24))^xz64Low[index];high=(high>>>8)^xz64High[index];}return[(low^0xffffffff)>>>0,(high^0xffffffff)>>>0];}
 function xzVli(bytes,state,end){let value=0,scale=1;for(let i=0;i<9;i++){if(state.pos>=end)throw new Error('XZ 可变长度整数被截断');const byte=bytes[state.pos++];value+=(byte&127)*scale;if(!Number.isSafeInteger(value))throw new Error('XZ 整数超限');if(!(byte&128)){if(i&&byte===0)throw new Error('XZ 非规范整数');return value;}scale*=128;}throw new Error('XZ 整数过长');}
 function inspectXz(bytes,limit){
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),length=bytes.length;
  if(length<32||length%4||bytes[0]!==253||bytes[1]!==55||bytes[2]!==122||bytes[3]!==88||bytes[4]!==90||bytes[5]!==0||bytes[length-2]!==89||bytes[length-1]!==90)throw new Error('XZ 文件头、尾部或长度无效');
  if(bytes[6]!==0||bytes[7]!==4||bytes[length-4]!==0||bytes[length-3]!==4)throw new Error('LZMA2 分块需要 CRC64 XZ 格式');
  if(xzCrc32(bytes.subarray(6,8))!==v.getUint32(8,true)||xzCrc32(bytes.subarray(length-8,length-2))!==v.getUint32(length-12,true))throw new Error('XZ 头尾校验失败');
  const indexSize=(v.getUint32(length-8,true)+1)*4,indexStart=length-12-indexSize,indexEnd=length-16;
  if(indexSize<8||indexStart<12||bytes[indexStart]!==0||xzCrc32(bytes.subarray(indexStart,indexEnd))!==v.getUint32(indexEnd,true))throw new Error('XZ 索引无效');
  const state={pos:indexStart+1},count=xzVli(bytes,state,indexEnd),records=[];let cursor=12,total=0;
  if(count>1024)throw new Error('XZ 数据块数量超限');
  for(let i=0;i<count;i++){
   const unpadded=xzVli(bytes,state,indexEnd),size=xzVli(bytes,state,indexEnd),padded=Math.ceil(unpadded/4)*4;
   total+=size;if(total>limit)throw new Error('解压数据超过预期长度');
   if(unpadded<16||cursor+padded>indexStart)throw new Error('XZ 块尺寸无效');
   const headerSize=(bytes[cursor]+1)*4,headerEnd=cursor+headerSize-4,flags=bytes[cursor+1];
   if(headerSize<8||headerSize+8>=unpadded||headerEnd>=indexStart||(flags&63)||xzCrc32(bytes.subarray(cursor,headerEnd))!==v.getUint32(headerEnd,true))throw new Error('XZ 块头或滤波器无效');
   const h={pos:cursor+2},compressedSize=unpadded-headerSize-8;
   if(flags&64)if(xzVli(bytes,h,headerEnd)!==compressedSize)throw new Error('XZ 压缩长度不匹配');
   if(flags&128)if(xzVli(bytes,h,headerEnd)!==size)throw new Error('XZ 原始长度不匹配');
   if(xzVli(bytes,h,headerEnd)!==33||xzVli(bytes,h,headerEnd)!==1||h.pos>=headerEnd)throw new Error('XZ 必须使用单一 LZMA2 滤波器');
   if(bytes[h.pos++]>28)throw new Error('LZMA2 字典超过 64 MiB');
   while(h.pos<headerEnd)if(bytes[h.pos++]!==0)throw new Error('XZ 块头填充无效');
   const check=cursor+padded-8;for(let p=cursor+headerSize+compressedSize;p<check;p++)if(bytes[p]!==0)throw new Error('XZ 块填充无效');
   records.push({size,check});cursor+=padded;
  }
  while(state.pos<indexEnd)if(bytes[state.pos++]!==0)throw new Error('XZ 索引填充无效');
  if(cursor!==indexStart)throw new Error('XZ 含多余数据');
  return{total,records};
 }
 let lzReady;
 function readyLzma(){if(!lzReady)lzReady=lzma.initWasm().then(()=>true).catch(()=>false);return lzReady;}
 async function unxz(bytes,limit){
  const {total,records}=inspectXz(bytes,limit);
  if(!await readyLzma())throw new Error('LZMA2 WASM 不可用，无法解码此分块');
  const output=new Uint8Array(total+1),written=lzma.decompressToBuffer(bytes,output,64*1024*1024);
  if(written!==total)throw new Error('LZMA2 实际输出长度不匹配');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=0;
  for(const record of records){const [low,high]=xzCrc64(output.subarray(offset,offset+record.size));if(low!==v.getUint32(record.check,true)||high!==v.getUint32(record.check+4,true))throw new Error('XZ 数据校验失败');offset+=record.size;}
  return output.subarray(0,total);
 }
