import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { bratVid } from 'brat-canvas/video';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.RENDER_SERVICE_TOKEN || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;
const W = 720;
const H = 1280;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n)));
function run(args) {
  return new Promise((resolve,reject)=>{
    const p=spawn(ffmpegPath,args,{stdio:['ignore','ignore','pipe']});
    let err='';p.stderr.on('data',d=>err+=d.toString());p.on('error',reject);
    p.on('close',code=>code===0?resolve():reject(new Error(`FFmpeg failed (${code}): ${err.slice(-1800)}`)));
  });
}
function audioUrlAllowed(value) {
  if (!value) return false;
  try {
    const url=new URL(value); const base=SUPABASE_URL?new URL(SUPABASE_URL):null;
    return url.protocol==='https:' && !!base && url.host===base.host && url.pathname.includes('/storage/v1/object/sign/song-library/');
  } catch { return false; }
}
async function render(body) {
  const text=String(body.text||'').trim();
  if(!text||text.length>3000)throw new Error('Provide meme text up to 3000 characters.');
  const freeze=clamp(body.freeze_seconds??2,0,5);
  const dir=await mkdtemp(path.join(tmpdir(),'memeos-'));
  const source=path.join(dir,'bratext-source.mp4');
  const finalVideo=path.join(dir,'reel.mp4');
  const finalFrame=path.join(dir,'final-frame.png');
  const poster=path.join(dir,'poster.png');
  try {
    // The BRAT video engine renders the progressive word reveal. Keep a single layer
    // so the configured end-frame hold applies once, at the very end of the video.
    const generated=await bratVid(text,{
      outputFormat:'mp4',
      fast_progress:false,
      theme:'brat',
      lyric:{maxWordPerLayer:999,frameDuration:0.24,lastFrameDuration:0.001},
      brat:{W,H,BOX_W:640,BOX_H:1120,BOX_PAD:40,C_BG:'#b7ff3c',C_TEXT:'#111111',FONT_NAME:'Arimo',FONT_WEIGHT:700,fontPaths:[path.join(__dirname,'fonts','Arimo-Bold.ttf')]}
    });
    await writeFile(source,generated);
    const audioUrl=body.audio_url?String(body.audio_url):'';
    let audioPath='';
    if(audioUrl){
      if(!audioUrlAllowed(audioUrl))throw new Error('Audio URL must be a signed URL from this MemeOS Supabase song library.');
      const response=await fetch(audioUrl);
      if(!response.ok)throw new Error(`Could not fetch selected song (${response.status}).`);
      const bytes=await response.arrayBuffer();
      if(bytes.byteLength>MAX_AUDIO_BYTES)throw new Error('Selected song exceeds 30 MB.');
      audioPath=path.join(dir,'track.audio');
      await writeFile(audioPath,Buffer.from(bytes));
    }
    const args=['-y','-hide_banner','-loglevel','error','-i',source];
    if(audioPath)args.push('-stream_loop','-1','-i',audioPath);
    // tpad clones the final encoded frame for exactly the user-selected 0–5 seconds.
    args.push('-vf',`tpad=stop_mode=clone:stop_duration=${freeze},scale=${W}:${H}:flags=lanczos,format=yuv420p`,'-map','0:v:0');
    if(audioPath)args.push('-map','1:a:0');
    args.push('-c:v','libx264','-preset','veryfast','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart');
    if(audioPath)args.push('-c:a','aac','-b:a','160k','-shortest');
    args.push(finalVideo);
    await run(args);
    // Photo publishing uses the literal last frame of the finished, audio-mixed Reel MP4.
    await run(['-y','-hide_banner','-loglevel','error','-sseof','-0.05','-i',finalVideo,'-frames:v','1','-update','1',finalFrame]);
    // Instagram feed photos have a taller-than-4:5 limit. Fit the entire last frame
    // into a 4:5 canvas (no content crop) for the native photo-post asset.
    await run(['-y','-hide_banner','-loglevel','error','-i',finalFrame,'-vf','scale=500:900:force_original_aspect_ratio=decrease,pad=720:900:(ow-iw)/2:(oh-ih)/2:color=0xB7FF3C,format=rgb24','-frames:v','1',poster]);
    const [video,posterBytes]=await Promise.all([readFile(finalVideo),readFile(poster)]);
    return {video_base64:video.toString('base64'),poster_base64:posterBytes.toString('base64'),freeze_seconds:freeze,width:W,height:H,poster_width:720,poster_height:900,has_audio:!!audioPath,renderer:'brat-canvas-video'};
  } finally { await rm(dir,{recursive:true,force:true}); }
}
// Renders are memory-heavy (BRAT frames + FFmpeg + base64 output). Run them strictly
// one at a time so a 512 MB instance never holds two jobs at once. Extra requests wait
// in this queue; /health and auth checks stay immediate.
let renderChain=Promise.resolve();
let queued=0;
function runSerially(task){
  queued+=1;
  const next=renderChain.then(()=>task());
  renderChain=next.catch(()=>{}).finally(()=>{queued-=1;});
  return next;
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','content-type,x-render-token');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
  if(req.url==='/health'&&req.method==='GET'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,service:'memeos-render-service',renderer:'brat-canvas-video'}));return;}
  if(req.url!=='/render'||req.method!=='POST'){res.writeHead(404).end('Not found');return;}
  if(!TOKEN||req.headers['x-render-token']!==TOKEN){res.writeHead(401).end('Unauthorized');return;}
  try{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2_000_000)throw new Error('Request too large.');}console.log(`render queued (waiting: ${queued})`);const result=await runSerially(()=>render(JSON.parse(raw)));res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));}
  catch(e){res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:e.message||'Render failed'}));}
});
// A queued render can wait behind another; don't let Node cut the connection.
server.requestTimeout=0;
server.headersTimeout=120000;
server.listen(PORT,'0.0.0.0',()=>console.log(`MemeOS render service listening on ${PORT}`));
