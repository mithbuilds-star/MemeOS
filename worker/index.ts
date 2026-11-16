export interface Env {
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_SECRET_KEY: string;
  CREDENTIALS_ENCRYPTION_KEY?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_REDIRECT_URI?: string;
  META_GRAPH_VERSION?: string;
  APP_ENV?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  AI?: { run: (model: string, input: any) => Promise<any> };
}
type Ctx = { userId: string; token: string };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (message: string, status = 400) => json({ error: message }, status);
// Supabase publishable/secret API keys are not JWTs. Send the secret key only in apikey;
// do not put it in Authorization: Bearer. Supabase API Gateway derives the service role.
const headers = (env: Env) => ({ apikey: env.SUPABASE_SECRET_KEY, "Content-Type": "application/json" });
type AuthResult = { ctx: Ctx; error?: never } | { ctx?: never; error: string };
async function auth(req: Request, env: Env): Promise<AuthResult> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { error: "No Supabase session token was sent. Sign out and sign in again." };
  if (!env.SUPABASE_URL) return { error: "Worker configuration is missing SUPABASE_URL." };
  if (!env.SUPABASE_SECRET_KEY) return { error: "Worker secret SUPABASE_SECRET_KEY is missing. Add it under Cloudflare Worker Secrets and redeploy." };
  try {
    // This is a server-to-server Auth request: use the secret API key in `apikey`
    // and the user's actual Supabase access token in `Authorization: Bearer`.
    // The API key itself is never used as a bearer token or sent to the browser.
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${token}` }
    });
    const body = await r.text();
    if (!r.ok) {
      let detail = body;
      try { const parsed = JSON.parse(body); detail = parsed.msg || parsed.message || parsed.error_description || parsed.error || body; } catch {}
      return { error: `Supabase rejected the session (HTTP ${r.status}): ${String(detail).slice(0, 220) || "No error details returned."} Sign out and sign in again if the session has expired.` };
    }
    let u: any;
    try { u = JSON.parse(body); } catch { return { error: "Supabase Auth returned an unreadable user response." }; }
    if (!u?.id) return { error: "Supabase accepted the request but returned no user ID. Sign in again." };
    return { ctx: { userId: u.id, token } };
  } catch (e: any) {
    return { error: `Could not reach Supabase Auth: ${String(e?.message || e).slice(0, 180)}` };
  }
}
async function db(env: Env, table: string, path = "", init: RequestInit = {}) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}${path}`, { ...init, headers: { ...headers(env), Prefer: "return=representation", ...(init.headers || {}) } });
  const body = await r.text();
  if (!r.ok) throw new Error(`Database error ${r.status}: ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : null;
}

function b64ToBytes(value: string): Uint8Array {
  const raw = atob(value); return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function bytesToB64(value: Uint8Array): string {
  let raw = ""; value.forEach(v => raw += String.fromCharCode(v)); return btoa(raw);
}
async function cryptoKey(env: Env): Promise<CryptoKey> {
  if (!env.CREDENTIALS_ENCRYPTION_KEY) throw new Error("API Manager encryption is not configured. Set CREDENTIALS_ENCRYPTION_KEY once in Worker runtime secrets.");
  const raw = b64ToBytes(env.CREDENTIALS_ENCRYPTION_KEY);
  if (raw.length !== 32) throw new Error("CREDENTIALS_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptSecret(env: Env, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name:"AES-GCM",iv}, await cryptoKey(env), new TextEncoder().encode(secret));
  return { encrypted_secret: bytesToB64(new Uint8Array(encrypted)), encryption_iv: bytesToB64(iv) };
}
async function decryptSecret(env: Env, row: any): Promise<string> {
  const plain = await crypto.subtle.decrypt({name:"AES-GCM",iv:b64ToBytes(row.encryption_iv)}, await cryptoKey(env), b64ToBytes(row.encrypted_secret));
  return new TextDecoder().decode(plain);
}
function credentialView(row: any) {
  return {id:row.id,provider:row.provider,label:row.label,key_hint:row.key_hint,actor_id:row.actor_id||(row.provider==="apify"?DEFAULT_APIFY_ACTOR:null),enabled:row.enabled,status:row.status,last_tested_at:row.last_tested_at,last_used_at:row.last_used_at,created_at:row.created_at};
}

function userFilter(ctx: Ctx) { return `owner_id=eq.${encodeURIComponent(ctx.userId)}`; }
async function owned(env: Env, table: string, id: string, ctx: Ctx) {
  const rows = await db(env, table, `?id=eq.${encodeURIComponent(id)}&${userFilter(ctx)}&select=id`);
  return rows?.length > 0;
}

async function storageUpload(env: Env, path: string, bytes: ArrayBuffer, contentType: string) {
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/meme-assets/${path}`, {
    method: "POST", headers: { ...headers(env), "Content-Type": contentType, "x-upsert": "true" }, body: bytes
  });
  if (!r.ok) throw new Error(`Storage upload failed (${r.status}): ${(await r.text()).slice(0,200)}`);
  return `${env.SUPABASE_URL}/storage/v1/object/public/meme-assets/${path}`;
}
function firstString(obj: any, keys: string[]) { for (const k of keys) { const v = k.split(".").reduce((a:any,b:string)=>a?.[b],obj); if (typeof v === "string" && v.trim()) return v.trim(); } return null; }
async function readBoundedBody(response:Response,maxBytes:number){
  const reader=response.body?.getReader();if(!reader){const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.byteLength>maxBytes)throw new Error("Media file exceeds the download limit.");return bytes;}
  const chunks:Uint8Array[]=[];let total=0;while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){await reader.cancel();throw new Error("Media file exceeds the download limit.");}chunks.push(value);}
  const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
}
function normalizeApifyItem(item: any) {
  const rawUsername = firstString(item,["ownerUsername","username","author.username","owner.username","user.username"]);
  const username = rawUsername?rawUsername.replace(/^@/,"").toLowerCase():null;
  const permalink = firstString(item,["url","permalink","postUrl","post_url"]);
  const postId = firstString(item,["id","shortCode","shortcode","postId","pk"]) || permalink;
  const image = firstString(item,["displayUrl","display_url","imageUrl","image_url","images.0.url","thumbnailUrl"]);
  const caption = firstString(item,["caption","text","description","alt"]);
  const type = firstString(item,["type","productType","mediaType"]) || "IMAGE";
  return { username, permalink, postId, image, caption, type };
}
async function assignDiscoveredMeme(env:Env,ctx:Ctx,memeId:string,sourceId:string|null){
  const accounts=await db(env,"instagram_accounts",`?${userFilter(ctx)}&select=id,discovery_enabled`);
  const mappings=await db(env,"destination_sources",`?${userFilter(ctx)}&select=destination_account_id,reference_account_id`);
  const direct=new Set<string>();
  for(const account of accounts){
    if(!account.discovery_enabled)continue;
    const own=mappings.filter((m:any)=>m.destination_account_id===account.id);
    if(!own.length||own.some((m:any)=>m.reference_account_id===sourceId))direct.add(account.id);
  }
  const selected=new Set(direct);
  // Propagate once through the complete parent graph; the Set prevents duplicate/cyclic work.
  const links=await db(env,"account_relationships",`?${userFilter(ctx)}&select=parent_account_id,child_account_id`);
  let changed=true;while(changed){changed=false;for(const link of links){if(selected.has(link.parent_account_id)&&!selected.has(link.child_account_id)){selected.add(link.child_account_id);changed=true;}}}
  for(const destination of selected){const existing=await db(env,"account_meme_assignments",`?${userFilter(ctx)}&meme_id=eq.${memeId}&destination_account_id=eq.${destination}&select=id`);if(!existing.length){await db(env,"account_meme_assignments","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,meme_id:memeId,destination_account_id:destination,assignment_source:direct.has(destination)?"discovery":"inheritance",approval_status:"pending",status:"pending"})});}}
}

async function runApifyPoll(env: Env, ctx: Ctx, job: any) {
  const creds = await db(env,"api_credentials",`?id=eq.${job.metadata?.credential_id}&${userFilter(ctx)}&select=*`);
  if (!creds.length) throw new Error("The Apify credential used for this run no longer exists.");
  const secret = await decryptSecret(env,creds[0]);
  const runId = job.provider_run_id;
  if (!runId) throw new Error("Discovery job has no Apify run ID.");
  const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`,{headers:{Authorization:`Bearer ${secret}`}});
  const statusData:any = await statusRes.json().catch(()=>({}));
  if (!statusRes.ok) throw new Error(statusData.error?.message || `Apify run lookup failed (${statusRes.status}).`);
  const run = statusData.data || {};
  if (!["SUCCEEDED","FAILED","ABORTED","TIMED-OUT"].includes(run.status)) return { done:false, status:run.status };
  if (run.status !== "SUCCEEDED") {
    await db(env,"jobs",`?id=eq.${job.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"failed",last_error:`Apify run finished with status ${run.status}.`,completed_at:new Date().toISOString(),next_retry_at:null,locked_until:null})});
    throw new Error(`Apify run finished with status ${run.status}.`);
  }
  const datasetId = run.defaultDatasetId || job.metadata?.dataset_id;
  if (!datasetId) throw new Error("Apify run completed without a dataset ID.");
  const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json&limit=200`,{headers:{Authorization:`Bearer ${secret}`}});
  if (!itemsRes.ok) throw new Error(`Could not retrieve Apify dataset (${itemsRes.status}).`);
  const items:any[] = await itemsRes.json();
  let inserted = 0, skipped = 0, failedMedia = 0;
  for (const item of items) {
    const n = normalizeApifyItem(item);
    if (!n.postId) { skipped++; continue; }
    const exists = await db(env,"memes",`?${userFilter(ctx)}&source_post_id=eq.${encodeURIComponent(n.postId)}&select=id`);
    if (exists.length) { skipped++; continue; }
    let assetUrl:string|null=null, assetPath:string|null=null;
    if (n.image) {
      try {
        const mediaUrl=new URL(n.image);
        if(mediaUrl.protocol!=="https:"||["localhost","127.0.0.1","0.0.0.0","169.254.169.254"].includes(mediaUrl.hostname)||/^10\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[01])\./.test(mediaUrl.hostname))throw new Error("Unsafe media URL rejected.");
        const media = await fetch(mediaUrl.toString());
        const ct = media.headers.get("content-type") || "image/jpeg";
        const advertisedSize=Number(media.headers.get("content-length")||0);
        const supportedImage=["image/jpeg","image/png","image/webp"].includes(ct.split(";")[0].trim().toLowerCase());
        if (media.ok && supportedImage && (!advertisedSize||advertisedSize<=10*1024*1024)) {
          const ext = ct.includes("png")?"png":ct.includes("webp")?"webp":"jpg";
          assetPath = `${ctx.userId}/discovered/${crypto.randomUUID()}.${ext}`;
          const mediaBytes=await readBoundedBody(media,10*1024*1024);assetUrl = await storageUpload(env,assetPath,mediaBytes.buffer as ArrayBuffer,ct);
        }
      } catch { failedMedia++; }
    }
    const src = await db(env,"reference_accounts",`?${userFilter(ctx)}&username=eq.${encodeURIComponent((n.username||"").replace(/^@/,""))}&select=id`);
    const payload:any = {owner_id:ctx.userId,source_type:"discovery",source_reference_account_id:src[0]?.id||null,source_post_id:n.postId,source_permalink:n.permalink,source_username:n.username,original_caption:n.caption,extracted_text:null,classification:"needs_review",classification_reason:"Awaiting text extraction and review.",processing_status:assetUrl?"needs_ocr":"media_unavailable",original_post_type:n.type,asset_path:assetPath,asset_url:assetUrl,source_asset_path:assetPath,source_asset_url:assetUrl};
    try { const created=await db(env,"memes","",{method:"POST",body:JSON.stringify(payload)}); inserted++; if(created?.[0]?.id)await assignDiscoveredMeme(env,ctx,created[0].id,src[0]?.id||null); } catch { skipped++; }
  }
  await db(env,"jobs",`?id=eq.${job.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"completed",completed_at:new Date().toISOString(),locked_until:null,next_retry_at:null,metadata:{...job.metadata,dataset_id:datasetId,items_seen:items.length,inserted,skipped,failed_media:failedMedia}})});
  const scrapedAt=new Date().toISOString();const sourceNames=Array.isArray(job.metadata?.source_usernames)?job.metadata.source_usernames:[];for(const username of sourceNames){const sourceRows=await db(env,"reference_accounts",`?${userFilter(ctx)}&username=eq.${encodeURIComponent(String(username).replace(/^@/,""))}&select=id`);for(const source of sourceRows)await db(env,"reference_accounts",`?id=eq.${source.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({last_scraped_at:scrapedAt,last_scrape_status:"completed"})});}
  return {done:true,status:"SUCCEEDED",items_seen:items.length,inserted,skipped,failed_media:failedMedia};
}


async function classifyTextWithGroq(env:Env,ctx:Ctx,text:string){
  const creds=await db(env,"api_credentials",`?${userFilter(ctx)}&provider=eq.groq&enabled=eq.true&or=(cooldown_until.is.null,cooldown_until.lte.${encodeURIComponent(new Date().toISOString())})&status=neq.error&select=*&order=last_used_at.asc.nullsfirst,created_at.asc`);
  if(!creds.length)throw new Error("No enabled Groq API key. Add one in Settings → API Manager.");
  let lastError="No Groq key could process this request.";
  for(const credential of creds){
    try{
      const secret=await decryptSecret(env,credential);
      const response=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify({model:"openai/gpt-oss-20b",temperature:0,response_format:{type:"json_object"},messages:[{role:"system",content:"Classify whether a meme can be faithfully converted into a text-only BRAT-style image. Return JSON only: {\"suitable\":boolean,\"reason\":string}. suitable=true only when the complete joke/meaning is carried by the extracted words alone and does not depend on a photo, reaction face, screenshot layout, visual context, or image-specific details. Never rewrite, correct, summarize, or improve the text."},{role:"user",content:`Extracted text (preserve exactly):\\n${text}`} ]})});
      const data:any=await response.json().catch(()=>({}));
      if(!response.ok){lastError=data.error?.message||`Groq returned ${response.status}.`;await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:response.status===429?"rate_limited":"error",cooldown_until:response.status===429?new Date(Date.now()+5*60*1000).toISOString():null,last_used_at:new Date().toISOString()})});if(response.status===429||response.status===401||response.status>=500)continue;break;}
      const parsed=JSON.parse(data.choices?.[0]?.message?.content||"{}");
      await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"connected",cooldown_until:null,last_used_at:new Date().toISOString()})});
      return {suitable:parsed.suitable===true,reason:String(parsed.reason||"No explanation provided.").slice(0,500)};
    }catch(e:any){lastError=e.message||lastError;}
  }
  throw new Error(lastError);
}

async function extractTextWithWorkersAI(env:Env,imageBytes:ArrayBuffer,contentType:string){
  if(!env.AI)throw new Error("Cloudflare Workers AI binding is missing. Server-side OCR cannot run until the AI binding is enabled.");
  const bytes=new Uint8Array(imageBytes);
  const imageData=`data:${contentType};base64,${bytesToB64(bytes)}`;
  const result:any=await env.AI.run("@cf/google/gemma-4-26b-a4b-it",{messages:[{role:"user",content:[{type:"text",text:"Transcribe every visible word in this image exactly as written. Preserve capitalization, punctuation, spelling, emojis, and line breaks as closely as possible. Do not describe the image, explain it, infer missing words, or add commentary. If there is no readable text, return exactly [NO_TEXT]."},{type:"image_url",image_url:{url:imageData}}]}],temperature:0,max_completion_tokens:700});
  const output=String(result?.response||result?.choices?.[0]?.message?.content||result?.output_text||"").trim();
  const cleaned=output.replace(/^```(?:text)?\s*/i,"").replace(/\s*```$/i,"").trim();
  if(!cleaned||cleaned==="[NO_TEXT]")return "";
  return cleaned.slice(0,3000);
}

async function signedSongUrl(env:Env,path:string){
  const r=await fetch(`${env.SUPABASE_URL}/storage/v1/object/sign/song-library/${path.split("/").map(encodeURIComponent).join("/")}`,{method:"POST",headers:headers(env),body:JSON.stringify({expiresIn:900})});
  const data:any=await r.json().catch(()=>({}));if(!r.ok)throw new Error(`Could not create a temporary song URL (${r.status}).`);
  const signed=data.signedURL||data.signedUrl;if(!signed)throw new Error("Supabase did not return a signed song URL.");
  return signed.startsWith("http")?signed:`${env.SUPABASE_URL}/storage/v1${signed}`;
}
async function renderReelForMeme(env:Env,meme:any){
  const ctx:Ctx={userId:meme.owner_id,token:""};
  const nowMs=Date.now();
  // A render was already dispatched (or failed and is backing off): don't start another.
  if(meme.reel_render_next_retry_at&&new Date(meme.reel_render_next_retry_at).getTime()>nowMs)return {status:"rendering_on_github"};
  if(!env.GITHUB_TOKEN||!env.GITHUB_REPO){await db(env,"memes",`?id=eq.${meme.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({reel_status:"renderer_not_configured",reel_render_locked_until:null})});return {status:"renderer_not_configured"};}
  const songs=await db(env,"song_library",`?${userFilter(ctx)}&is_active=eq.true&select=*&order=times_used.asc,last_used_at.asc.nullsfirst&limit=100`);
  const minUses=songs.length?Math.min(...songs.map((s:any)=>Number(s.times_used||0))):null;
  const leastUsed=songs.length?songs.filter((s:any)=>Number(s.times_used||0)===minUses):[];
  const song=leastUsed.length?leastUsed[Math.floor(Math.random()*leastUsed.length)]:null;
  const songUrl=song?await signedSongUrl(env,song.storage_path):null;
  const settings=await db(env,"user_settings",`?${userFilter(ctx)}&select=video_freeze_seconds`);
  const freeze=Math.max(0,Math.min(5,Number(settings[0]?.video_freeze_seconds??2)));
  const dispatch=await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/render-meme.yml/dispatches`,{method:"POST",headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"memeos-worker","Content-Type":"application/json"},body:JSON.stringify({ref:"main",inputs:{meme_id:String(meme.id),owner_id:String(ctx.userId),text:String(meme.extracted_text||"").slice(0,3000),freeze_seconds:String(freeze),audio_url:songUrl||"",song_id:song?.id||""}})});
  if(!dispatch.ok){const detail=(await dispatch.text()).slice(0,200);throw new Error(`GitHub render dispatch failed (${dispatch.status}): ${detail}`);}
  if(song)await db(env,"song_library",`?id=eq.${song.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({times_used:Number(song.times_used||0)+1,last_used_at:new Date().toISOString()})});
  // The workflow writes the final status; keep the meme waiting until then.
  await db(env,"memes",`?id=eq.${meme.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({reel_status:"rendering",reel_song_id:song?.id||null,reel_render_locked_until:null,reel_render_next_retry_at:new Date(nowMs+30*60*1000).toISOString(),processing_error:null})});
  return {status:"dispatched"};
}

async function processMemeInBackground(env:Env,meme:any){
  const ctx:Ctx={userId:meme.owner_id,token:""};
  let current=meme;
  if(current.processing_status==="needs_ocr"){
    const sourceUrl=current.source_asset_url||current.asset_url;
    if(!sourceUrl)throw new Error("No original image is available for OCR.");
    const media=await fetch(sourceUrl);
    if(!media.ok)throw new Error(`Original image download failed (${media.status}).`);
    const contentType=media.headers.get("content-type")||"image/jpeg";
    if(!contentType.startsWith("image/"))throw new Error("The discovered media is not a supported image. Video processing is a later milestone.");
    const bytes=await media.arrayBuffer();
    if(bytes.byteLength>8*1024*1024)throw new Error("Image exceeds the 8 MB OCR processing limit.");
    const extracted=await extractTextWithWorkersAI(env,bytes,contentType);
    if(!extracted){
      await db(env,"memes",`?id=eq.${current.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({processing_status:"low_confidence",classification:"needs_review",classification_reason:"No readable text was confidently extracted. Manual review required.",processing_error:null,processing_locked_until:null,processing_next_retry_at:null})});
      return {status:"manual_review",reason:"No readable text"};
    }
    const rows=await db(env,"memes",`?id=eq.${current.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({extracted_text:extracted,ocr_confidence:null,processing_status:"ocr_complete",classification:"needs_review",classification_reason:"Server-side OCR completed. OCR confidence is not provided by the vision model; verify the transcription before approval.",processing_error:null,processing_attempts:0,processing_next_retry_at:null})});
    current=rows?.[0]||{...current,extracted_text:extracted,processing_status:"ocr_complete"};
  }
  if(current.processing_status==="ocr_complete"){
    if(!current.extracted_text?.trim())throw new Error("OCR produced no text to classify.");
    const classification=await classifyTextWithGroq(env,ctx,current.extracted_text);
    const next=classification.suitable?"ready_for_asset":"rejected";
    const rows=await db(env,"memes",`?id=eq.${current.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({classification:classification.suitable?"suitable":"rejected",classification_reason:classification.reason,processing_status:next,processing_error:null,processing_attempts:0,processing_next_retry_at:null})});
    current=rows?.[0]||{...current,classification:classification.suitable?"suitable":"rejected",processing_status:next};
  }
  if(current.processing_status==="ready_for_asset"){
    const text=String(current.extracted_text||"").trim();
    if(!text)throw new Error("Cannot generate BRAT assets without extracted text.");
    let reel:any;
    try{reel=await renderReelForMeme(env,{...current,owner_id:ctx.userId,extracted_text:text});}
    catch(e:any){await db(env,"memes",`?id=eq.${current.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({reel_status:"render_failed",reel_render_next_retry_at:null,processing_error:String(e?.message||e).slice(0,500),processing_locked_until:null,processing_next_retry_at:new Date(Date.now()+15*60*1000).toISOString()})});return {status:"render_failed"};}
    if(reel.status==="dispatched"||reel.status==="rendering_on_github"){await db(env,"memes",`?id=eq.${current.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({processing_locked_until:null})});return {status:"rendering_on_github"};}
    if(reel.status==="renderer_not_configured"){await db(env,"memes",`?id=eq.${current.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({processing_locked_until:null})});return {status:"waiting_for_renderer"};}
    const rows=await db(env,"memes",`?id=eq.${current.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({source_asset_path:current.source_asset_path||current.asset_path,source_asset_url:current.source_asset_url||current.asset_url,processing_status:"generated",processing_error:null,processing_attempts:0,processing_next_retry_at:null,processing_locked_until:null})});

    return {status:"generated",reel_status:reel.status,meme:rows?.[0]};
  }
  await db(env,"memes",`?id=eq.${current.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({processing_locked_until:null})});
  return {status:current.processing_status};
}

async function runBackgroundProcessing(env:Env){
  const now=new Date().toISOString();
  const pending=await db(env,"memes",`?processing_status=in.(needs_ocr,ocr_complete,ready_for_asset)&or=(processing_next_retry_at.is.null,processing_next_retry_at.lte.${encodeURIComponent(now)})&select=*&order=created_at.asc&limit=20`);
  let processed=0;
  for(const meme of pending){
    if(processed>=5)break;
    const ctx:Ctx={userId:meme.owner_id,token:""};
    const settings=await db(env,"user_settings",`?${userFilter(ctx)}&select=global_paused,auto_process_enabled,discovery_interval_minutes`);
    if(settings[0]?.global_paused||settings[0]?.auto_process_enabled===false)continue;
    const claim=await db(env,"memes",`?id=eq.${meme.id}&owner_id=eq.${meme.owner_id}&processing_status=eq.${meme.processing_status}&or=(processing_locked_until.is.null,processing_locked_until.lte.${encodeURIComponent(now)})`,{method:"PATCH",body:JSON.stringify({processing_locked_until:new Date(Date.now()+10*60*1000).toISOString()})});
    if(!claim?.length)continue;
    processed++;
    try{
      await processMemeInBackground(env,{...meme,...claim[0]});
    }catch(e:any){
      const latestRows=await db(env,"memes",`?id=eq.${meme.id}&${userFilter(ctx)}&select=processing_status,processing_attempts`);
      const latest=latestRows?.[0]||meme;
      const attempts=Number(latest.processing_attempts||0)+1;
      const exhausted=attempts>=3;
      const delay=Math.min(360,Math.pow(2,attempts)*5);
      const patch:any={processing_attempts:attempts,processing_error:String(e?.message||e).slice(0,500),processing_status:exhausted?"rejected":latest.processing_status,processing_next_retry_at:exhausted?null:new Date(Date.now()+delay*60*1000).toISOString(),processing_locked_until:null};
      // After 3 failed automatic attempts the item is discarded rather than left in limbo.
      if(exhausted){patch.classification="rejected";patch.classification_reason="Discarded automatically after 3 failed processing attempts.";}
      await db(env,"memes",`?id=eq.${meme.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify(patch)});
    }
  }
}


async function runWaitingReels(env:Env){
  const now=new Date().toISOString();
  await db(env,"memes",`?reel_status=eq.rendering&reel_render_next_retry_at=lte.${encodeURIComponent(now)}`,{method:"PATCH",body:JSON.stringify({reel_status:"render_failed",reel_render_next_retry_at:null,reel_render_locked_until:null,processing_error:"The GitHub render did not report back within 30 minutes. Press Retry to render again."})});
  const sel="&select=id,owner_id,extracted_text,reel_asset_url,reel_song_id,reel_status&order=created_at.asc&limit=10";
  const auto=await db(env,"memes",`?reel_status=eq.renderer_not_configured&or=(reel_render_next_retry_at.is.null,reel_render_next_retry_at.lte.${encodeURIComponent(now)})${sel}`);
  const manual=await db(env,"memes",`?reel_status=eq.render_failed&reel_render_next_retry_at=lte.${encodeURIComponent(now)}${sel}`);
  const pending=[...auto,...manual].slice(0,10);
  for(const meme of pending){
    const ctx:Ctx={userId:meme.owner_id,token:""};
    const settings=await db(env,"user_settings",`?${userFilter(ctx)}&select=global_paused,auto_process_enabled`);
    if(settings[0]?.global_paused||settings[0]?.auto_process_enabled===false)continue;
    const lease=await db(env,"memes",`?id=eq.${meme.id}&${userFilter(ctx)}&reel_status=eq.${meme.reel_status}&or=(reel_render_locked_until.is.null,reel_render_locked_until.lte.${encodeURIComponent(now)})`,{method:"PATCH",body:JSON.stringify({reel_render_locked_until:new Date(Date.now()+10*60*1000).toISOString()})});
    if(!lease?.length)continue;
    try{
      const result=await renderReelForMeme(env,meme);
      const patch:any={reel_render_locked_until:null};
      if(!["renderer_not_configured","dispatched","rendering_on_github"].includes(result.status)){
        const state=await db(env,"memes",`?id=eq.${meme.id}&${userFilter(ctx)}&select=processing_status`);
        if(state[0]?.processing_status==="ready_for_asset")patch.processing_status="generated";
        patch.processing_error=null;
      }
      await db(env,"memes",`?id=eq.${meme.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify(patch)});
    }catch(e:any){
      await db(env,"memes",`?id=eq.${meme.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({reel_status:"render_failed",reel_render_next_retry_at:null,reel_render_locked_until:null,processing_error:String(e?.message||e).slice(0,500),processing_next_retry_at:new Date(Date.now()+15*60*1000).toISOString()})});
    }
  }
}

const DEFAULT_APIFY_ACTOR = "apify/instagram-scraper";
function buildActorInput(template:any,usernames:string[],actorId=DEFAULT_APIFY_ACTOR){
  const input=template&&typeof template==="object"&&!Array.isArray(template)?structuredClone(template):{};
  const replace=(value:any):any=>{
    if(typeof value==="string"){if(value==="{{usernames}}")return usernames;if(value==="{{profile_urls}}")return usernames.map(u=>`https://www.instagram.com/${u.replace(/^@/,"")}/`);if(value==="{{start_urls}}")return usernames.map(u=>({url:`https://www.instagram.com/${u.replace(/^@/,"")}/`}));return value;}
    if(Array.isArray(value))return value.map(replace);
    if(value&&typeof value==="object"){const out:any={};for(const [k,v] of Object.entries(value))out[k]=replace(v);return out;}
    return value;
  };
  const result=replace(input);
  // The recommended Apify-maintained Instagram Scraper expects profile URLs in directUrls.
  // Convert the older MemeOS default `usernames` input so existing saved keys keep working.
  if(actorId===DEFAULT_APIFY_ACTOR){
    if(!Array.isArray(result.directUrls)){
      const source=Array.isArray(result.usernames)?result.usernames:usernames;
      result.directUrls=source.map((u:string)=>`https://www.instagram.com/${String(u).replace(/^@/,"")}/`);
    }
    delete result.usernames;
  }else if(!("usernames" in result)&&!("directUrls" in result)&&!("startUrls" in result))result.usernames=usernames;
  if(!("resultsLimit" in result))result.resultsLimit=20;
  return result;
}

async function syncMetaAnalyticsForHistory(env:Env,history:any){
  const ctx:Ctx={userId:history.owner_id,token:""};
  const rows=await db(env,"publishing_history",`?id=eq.${history.id}&${userFilter(ctx)}&select=*,instagram_accounts(*)`);
  const item=rows?.[0];const account=item?.instagram_accounts;
  if(!item?.meta_media_id||!account?.meta_access_token_enc||!account?.meta_access_token_iv)throw new Error("Published media or connected Meta token is unavailable.");
  const token=await decryptSecret(env,{encrypted_secret:account.meta_access_token_enc,encryption_iv:account.meta_access_token_iv});
  const version=env.META_GRAPH_VERSION||"v27.0";
  const media=await graphRequest(version,`${encodeURIComponent(item.meta_media_id)}?fields=id,like_count,comments_count,media_type,media_product_type,timestamp,permalink&access_token=${encodeURIComponent(token)}`);
  const today=new Date().toISOString().slice(0,10);
  const metrics:any={likes:media.like_count,comments:media.comments_count};
  const insightMetrics=["reach","views","saved","shares","total_interactions"];
  try{
    const all=await graphRequest(version,`${encodeURIComponent(item.meta_media_id)}/insights?metric=${insightMetrics.join(",")}&access_token=${encodeURIComponent(token)}`);
    for(const entry of all.data||[]){const key=entry.name==="saved"?"saves":entry.name;const value=entry.values?.[0]?.value??entry.total_value?.value;if(typeof value==="number")metrics[key]=value;}
  }catch{
    // Metric support varies by media type and account. Retry individually so one
    // unsupported metric does not suppress other values that Meta does provide.
    for(const metric of insightMetrics){try{const one=await graphRequest(version,`${encodeURIComponent(item.meta_media_id)}/insights?metric=${metric}&access_token=${encodeURIComponent(token)}`);const entry=(one.data||[])[0];const value=entry?.values?.[0]?.value??entry?.total_value?.value;if(typeof value==="number")metrics[metric==="saved"?"saves":metric]=value;}catch{}}
  }
  for(const [metric_name,metric_value] of Object.entries(metrics)){if(typeof metric_value!=="number"||!Number.isFinite(metric_value))continue;
    const memeFilter=item.meme_id?`meme_id=eq.${item.meme_id}`:"meme_id=is.null";
    const existing=await db(env,"analytics",`?${userFilter(ctx)}&${memeFilter}&destination_account_id=eq.${item.destination_account_id}&metric_name=eq.${metric_name}&collected_on=eq.${today}&select=id`);
    const payload={owner_id:item.owner_id,meme_id:item.meme_id,destination_account_id:item.destination_account_id,meta_media_id:item.meta_media_id,metric_name,metric_value,source:"meta_graph_media",collected_on:today};
    if(existing.length)await db(env,"analytics",`?id=eq.${existing[0].id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify(payload)});
    else await db(env,"analytics","",{method:"POST",body:JSON.stringify(payload)});
  }
  await db(env,"publishing_history",`?id=eq.${item.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({analytics_synced_at:new Date().toISOString(),analytics_sync_error:null,permalink:media.permalink||item.permalink})});
  return {ok:true,metrics:Object.keys(metrics).filter(k=>typeof metrics[k]==="number").length};
}
async function syncMetaAnalyticsForOwner(env:Env,ctx:Ctx){
  const history=await db(env,"publishing_history",`?${userFilter(ctx)}&status=eq.published&meta_media_id=not.is.null&select=id&order=published_at.desc&limit=25`);
  let synced=0,failed=0;
  for(const row of history){try{await syncMetaAnalyticsForHistory(env,{...row,owner_id:ctx.userId});synced++;}catch(e:any){failed++;await db(env,"publishing_history",`?id=eq.${row.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({analytics_sync_error:String(e?.message||e).slice(0,500)})});}}
  return {synced,failed};
}
async function runScheduledDiscovery(env:Env){
  const active=await db(env,"instagram_accounts","?discovery_enabled=eq.true&select=owner_id");
  const owners=[...new Set(active.map((a:any)=>a.owner_id))];const now=Date.now();
  for(const ownerId of owners){
    const ctx:Ctx={userId:ownerId,token:""};
    const settingsRows=await db(env,"user_settings",`?${userFilter(ctx)}&select=global_paused,discovery_interval_minutes,last_discovery_started_at`);
    const settings=settingsRows[0]||{};if(settings.global_paused)continue;
    const interval=Math.max(15,Number(settings.discovery_interval_minutes||60));
    if(settings.last_discovery_started_at&&now-new Date(settings.last_discovery_started_at).getTime()<interval*60000)continue;
    const accounts=await db(env,"instagram_accounts",`?${userFilter(ctx)}&discovery_enabled=eq.true&select=id`);if(!accounts.length)continue;
    const mappings=await db(env,"destination_sources",`?${userFilter(ctx)}&select=destination_account_id,reference_account_id`);
    const allowed=new Set<string>();let all=false;for(const a of accounts){const own=mappings.filter((m:any)=>m.destination_account_id===a.id);if(!own.length)all=true;for(const m of own)allowed.add(m.reference_account_id);}
    const sources=await db(env,"reference_accounts",`?${userFilter(ctx)}&enabled=eq.true&select=id,username`);
    const selected=all?sources:sources.filter((s:any)=>allowed.has(s.id));if(!selected.length)continue;
    const creds=await db(env,"api_credentials",`?${userFilter(ctx)}&provider=eq.apify&enabled=eq.true&or=(cooldown_until.is.null,cooldown_until.lte.${encodeURIComponent(new Date().toISOString())})&status=neq.error&select=*&order=last_used_at.asc.nullsfirst,created_at.asc`);if(!creds.length)continue;
    const lockUntil=new Date(Date.now()+10*60*1000).toISOString();
    if(settingsRows.length){const lock=await db(env,"user_settings",`?${userFilter(ctx)}&or=(discovery_lock_until.is.null,discovery_lock_until.lte.${encodeURIComponent(new Date().toISOString())})`,{method:"PATCH",body:JSON.stringify({discovery_lock_until:lockUntil})});if(!lock?.length)continue;}else{try{await db(env,"user_settings","",{method:"POST",body:JSON.stringify({owner_id:ownerId,discovery_interval_minutes:60,discovery_lock_until:lockUntil})});}catch{continue;}}
    let started:any=null,used:any=null;
    for(const credential of creds){try{const secret=await decryptSecret(env,credential);const actor=encodeURIComponent((credential.actor_id||DEFAULT_APIFY_ACTOR).replace("/","~"));const input=buildActorInput(credential.actor_input,selected.map((s:any)=>s.username),credential.actor_id||DEFAULT_APIFY_ACTOR);const response=await fetch(`https://api.apify.com/v2/acts/${actor}/runs?waitForFinish=0`,{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify(input)});const data:any=await response.json().catch(()=>({}));if(response.ok){started=data;used=credential;break;}await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:response.status===429?"rate_limited":"error",cooldown_until:response.status===429?new Date(Date.now()+5*60*1000).toISOString():null,last_used_at:new Date().toISOString()})});}catch{}}
    if(!started?.data?.id){await db(env,"user_settings",`?${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({discovery_lock_until:null})});continue;}
    await db(env,"api_credentials",`?id=eq.${used.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"connected",cooldown_until:null,last_used_at:new Date().toISOString()})});
    await db(env,"jobs","",{method:"POST",body:JSON.stringify({owner_id:ownerId,job_type:"discovery",status:"running",provider_run_id:started.data.id,attempt_count:0,max_attempts:5,metadata:{dataset_id:started.data.defaultDatasetId,credential_id:used.id,actor_id:used.actor_id,source_usernames:selected.map((s:any)=>s.username),scheduled:true}})});
    if(settingsRows.length)await db(env,"user_settings",`?${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({last_discovery_started_at:new Date().toISOString(),discovery_lock_until:null})});else await db(env,"user_settings","",{method:"POST",body:JSON.stringify({owner_id:ownerId,last_discovery_started_at:new Date().toISOString(),discovery_interval_minutes:60,discovery_lock_until:null})});
  }
}

async function route(req: Request, env: Env, ctx: Ctx, url: URL): Promise<Response> {
  const p = url.pathname.replace(/^\/api/, "");
  const method = req.method;
  const body = method === "GET" || method === "DELETE" ? {} : await req.json().catch(() => ({})) as any;

  if (p === "/overview" && method === "GET") {
    const [a,m,q,pub] = await Promise.all([
      db(env,"instagram_accounts",`?${userFilter(ctx)}&select=id`),
      db(env,"memes",`?${userFilter(ctx)}&select=id`),
      db(env,"account_meme_assignments",`?${userFilter(ctx)}&approval_status=eq.pending&select=id`),
      db(env,"publishing_history",`?${userFilter(ctx)}&status=eq.published&select=id`)
    ]);
    return json({ accounts:a.length, memes:m.length, pending:q.length, published:pub.length });
  }
  if (p === "/accounts" && method === "GET") return json({ accounts: await db(env,"instagram_accounts",`?${userFilter(ctx)}&select=*&order=created_at.desc`) });
  if (p === "/accounts" && method === "POST") {
    const username = String(body.username || "").trim().replace(/^@/,"").toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(username)) return fail("Enter a valid Instagram username.");
    const rows = await db(env,"instagram_accounts","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,username,connection_status:"not_connected",discovery_enabled:true})});
    return json({ account:rows?.[0] },201);
  }
  const metaConnect=p.match(/^\/accounts\/([0-9a-f-]+)\/meta-connect$/);
  if(metaConnect&&method==="POST"){
    if(!env.META_APP_ID||!env.META_REDIRECT_URI)return fail("Meta app credentials and callback URL are not configured in the Worker.",503);
    if(!await owned(env,"instagram_accounts",metaConnect[1],ctx))return fail("Account not found.",404);
    const state=crypto.randomUUID();await db(env,"meta_oauth_states","",{method:"POST",body:JSON.stringify({state,owner_id:ctx.userId,destination_account_id:metaConnect[1],expires_at:new Date(Date.now()+10*60*1000).toISOString()})});
    const scope="pages_show_list,pages_read_engagement,instagram_basic,instagram_content_publish,instagram_manage_insights";
    const target=`https://www.facebook.com/${env.META_GRAPH_VERSION||"v27.0"}/dialog/oauth?client_id=${encodeURIComponent(env.META_APP_ID)}&redirect_uri=${encodeURIComponent(env.META_REDIRECT_URI)}&state=${encodeURIComponent(state)}&response_type=code&scope=${encodeURIComponent(scope)}`;
    return json({authorization_url:target});
  }
  const accountMatch = p.match(/^\/accounts\/([0-9a-f-]+)$/);
  if (accountMatch && method === "PATCH") {
    if (!await owned(env,"instagram_accounts",accountMatch[1],ctx)) return fail("Account not found.",404);
    const allowed: any = {};
    if (typeof body.discovery_enabled === "boolean") allowed.discovery_enabled = body.discovery_enabled;
    if (body.display_name !== undefined) allowed.display_name = String(body.display_name).slice(0,100);
    const rows = await db(env,"instagram_accounts",`?id=eq.${accountMatch[1]}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify(allowed)});
    return json({account:rows?.[0]});
  }
  if (accountMatch && method === "DELETE") {
    if (!await owned(env,"instagram_accounts",accountMatch[1],ctx)) return fail("Destination account not found.",404);
    // Foreign keys cascade account relationships, destination-source mappings and pending assignments.
    await db(env,"instagram_accounts",`?id=eq.${accountMatch[1]}&${userFilter(ctx)}`,{method:"DELETE"});
    return json({ok:true});
  }
  if (p === "/sources" && method === "GET") return json({sources:await db(env,"reference_accounts",`?${userFilter(ctx)}&select=*&order=created_at.desc`)});
  if (p === "/sources" && method === "POST") {
    const username=String(body.username||"").trim().replace(/^@/,"").toLowerCase();
    if(!/^[a-z0-9._]{1,30}$/.test(username))return fail("Enter a valid Instagram username.");
    const rows=await db(env,"reference_accounts","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,username,enabled:true})});
    return json({source:rows?.[0]},201);
  }
  const sourceMatch=p.match(/^\/sources\/([0-9a-f-]+)$/);
  if(sourceMatch&&method==="PATCH"){
    if(!await owned(env,"reference_accounts",sourceMatch[1],ctx))return fail("Source not found.",404);
    if(typeof body.enabled!=="boolean")return fail("Provide enabled=true or false.");
    const rows=await db(env,"reference_accounts",`?id=eq.${sourceMatch[1]}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({enabled:body.enabled})});return json({source:rows?.[0]});
  }
  if(sourceMatch&&method==="DELETE"){
    if(!await owned(env,"reference_accounts",sourceMatch[1],ctx))return fail("Source not found.",404);
    await db(env,"reference_accounts",`?id=eq.${sourceMatch[1]}&${userFilter(ctx)}`,{method:"DELETE"});
    return json({ok:true});
  }
  if(p==="/destination-sources"&&method==="GET")return json({items:await db(env,"destination_sources",`?${userFilter(ctx)}&select=*,instagram_accounts(username),reference_accounts(username)`)});
  if(p==="/destination-sources"&&method==="POST"){
    const destination=String(body.destination_account_id||""),source=String(body.reference_account_id||"");
    if(!await owned(env,"instagram_accounts",destination,ctx)||!await owned(env,"reference_accounts",source,ctx))return fail("Choose an account and source from your workspace.",404);
    const rows=await db(env,"destination_sources","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,destination_account_id:destination,reference_account_id:source})});return json({item:rows?.[0]},201);
  }
  const destSourceMatch=p.match(/^\/destination-sources\/([0-9a-f-]+)$/);
  if(destSourceMatch&&method==="DELETE"){if(!await owned(env,"destination_sources",destSourceMatch[1],ctx))return fail("Source assignment not found.",404);await db(env,"destination_sources",`?id=eq.${destSourceMatch[1]}&${userFilter(ctx)}`,{method:"DELETE"});return json({ok:true});}
  if(p==="/memes"&&method==="GET")return json({memes:await db(env,"memes",`?${userFilter(ctx)}&select=*&order=created_at.desc&limit=100`)});
  const memeEdit=p.match(/^\/memes\/([0-9a-f-]+)$/);
  if(memeEdit&&method==="PATCH"){
    const memeId=memeEdit[1];if(!await owned(env,"memes",memeId,ctx))return fail("Meme not found.",404);
    const text=String(body.extracted_text||"").trim();if(!text||text.length>3000)return fail("Meme text must be between 1 and 3000 characters.");
    const updated=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({extracted_text:text,classification:"needs_review",classification_reason:"Text edited by user. Reclassification and asset regeneration queued.",processing_status:"ocr_complete",processing_attempts:0,processing_next_retry_at:null,processing_locked_until:null,processing_error:null,reel_status:"not_started",reel_asset_path:null,reel_asset_url:null,reel_song_id:null})});
    const assignments=await db(env,"account_meme_assignments",`?${userFilter(ctx)}&meme_id=eq.${memeId}&select=id`);for(const assignment of assignments)await db(env,"account_meme_assignments",`?id=eq.${assignment.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({approval_status:"pending",status:"pending",scheduled_at:null,publishing_locked_until:null,rejection_reason:"Content text changed; approval reset."})});
    return json({meme:updated?.[0],queued:true,approvals_reset:assignments.length});
  }
  if(p==="/memes/manual"&&method==="POST"){
    const text=String(body.extracted_text||"").trim();
    if(!text||text.length>2000)return fail("Meme text must be between 1 and 2000 characters.");
    const rows=await db(env,"memes","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,extracted_text:text,classification:"suitable",classification_reason:"Manually created text. Sent to the BRAT video renderer.",processing_status:"ready_for_asset",reel_status:"not_started",source_type:"manual"})});
    return json({meme:rows?.[0]},201);
  }
  const rejectMatch=p.match(/^\/memes\/([0-9a-f-]+)\/reject$/);
  if(rejectMatch&&method==="POST"){
    const memeId=rejectMatch[1];
    if(!await owned(env,"memes",memeId,ctx))return fail("Meme not found.",404);
    const updated=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({classification:"rejected",classification_reason:"Rejected by user in content library.",processing_status:"rejected",processing_locked_until:null,reel_status:"not_started",reel_render_locked_until:null,reel_render_next_retry_at:null})});
    await db(env,"account_meme_assignments",`?${userFilter(ctx)}&meme_id=eq.${memeId}`,{method:"PATCH",body:JSON.stringify({approval_status:"rejected",status:"rejected",scheduled_at:null,rejection_reason:"Rejected by user."})});
    return json({meme:updated?.[0]});
  }
  const approveMatch=p.match(/^\/memes\/([0-9a-f-]+)\/approve$/);
  if(approveMatch&&method==="POST"){
    const memeId=approveMatch[1];
    if(!await owned(env,"memes",memeId,ctx))return fail("Meme not found.",404);
    const decision=body.decision;
    if(!["approved","rejected"].includes(decision))return fail("Decision must be approved or rejected.");
    let publishFormat=body.publish_format||"auto";if(!["photo","reel","auto"].includes(publishFormat))return fail("publish_format must be photo, reel or auto.");
    const memeReady=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}&select=processing_status,asset_url,reel_status,reel_asset_url,reel_song_id`);const ready=memeReady[0];
    // auto: about 30% of approved memes become Reels (when a Reel with a song exists), the rest are photo posts.
    if(publishFormat==="auto"){const reelReady=ready?.reel_status==="generated"&&!!ready?.reel_asset_url&&!!ready?.reel_song_id;publishFormat=reelReady&&Math.random()<0.3?"reel":"photo";}
    if(decision==="approved"&&publishFormat==="photo"&&(ready?.processing_status!=="generated"||!ready?.asset_url))return fail("The BRAT final-frame photo asset is not ready yet.",409);
    if(decision==="approved"&&publishFormat==="reel"&&(ready?.reel_status!=="generated"||!ready?.reel_asset_url||!ready?.reel_song_id))return fail("The Reel and selected song are not ready yet.",409);
    if(body.account_id){
      if(!await owned(env,"instagram_accounts",String(body.account_id),ctx))return fail("Destination account not found.",404);
      const existing=await db(env,"account_meme_assignments",`?${userFilter(ctx)}&meme_id=eq.${memeId}&destination_account_id=eq.${body.account_id}&select=id`);
      let rows:any[];
      if(existing.length) rows=await db(env,"account_meme_assignments",`?id=eq.${existing[0].id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({approval_status:decision,status:decision,publish_format:publishFormat})});
      else rows=await db(env,"account_meme_assignments","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,meme_id:memeId,destination_account_id:body.account_id,approval_status:decision,status:decision,publish_format:publishFormat})});
      return json({assignments:rows});
    }
    const accounts=await db(env,"instagram_accounts",`?${userFilter(ctx)}&select=id`);
    if(!accounts.length)return fail("Add a destination account before approving content.");
    const rows=[];for(const a of accounts){const ex=await db(env,"account_meme_assignments",`?${userFilter(ctx)}&meme_id=eq.${memeId}&destination_account_id=eq.${a.id}&select=id`);if(ex.length){const upd=await db(env,"account_meme_assignments",`?id=eq.${ex[0].id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({approval_status:decision,status:decision,publish_format:publishFormat})});rows.push(...(upd||[]));}else{const ins=await db(env,"account_meme_assignments","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,meme_id:memeId,destination_account_id:a.id,approval_status:decision,status:decision,publish_format:publishFormat})});rows.push(...(ins||[]));}}
    return json({assignments:rows});
  }

  if(p==="/discovery/jobs"&&method==="GET") return json({jobs:await db(env,"jobs",`?${userFilter(ctx)}&job_type=eq.discovery&select=*&order=created_at.desc&limit=30`)});
  const pollMatch=p.match(/^\/discovery\/jobs\/([0-9a-f-]+)\/poll$/);
  if(pollMatch&&method==="POST"){
    const rows=await db(env,"jobs",`?id=eq.${pollMatch[1]}&${userFilter(ctx)}&select=*`); if(!rows.length)return fail("Discovery job not found.",404);
    const result=await runApifyPoll(env,ctx,rows[0]); return json(result);
  }
  if(p==="/relationships"&&method==="GET") return json({relationships:await db(env,"account_relationships",`?${userFilter(ctx)}&select=*,parent:instagram_accounts!account_relationships_parent_account_id_fkey(id,username),child:instagram_accounts!account_relationships_child_account_id_fkey(id,username)`) });
  if(p==="/relationships"&&method==="POST"){
    const parent=String(body.parent_account_id||""), child=String(body.child_account_id||"");
    if(!parent||!child||parent===child)return fail("Choose two different accounts.");
    if(!await owned(env,"instagram_accounts",parent,ctx)||!await owned(env,"instagram_accounts",child,ctx))return fail("Both accounts must belong to your workspace.",404);
    const rows=await db(env,"account_relationships","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,parent_account_id:parent,child_account_id:child})});
    // Inherit existing parent assignments to the child, without overwriting existing decisions.
    const links=await db(env,"account_relationships",`?${userFilter(ctx)}&select=parent_account_id,child_account_id`);
    const descendants=new Set<string>([parent]);let changed=true;while(changed){changed=false;for(const link of links){if(descendants.has(link.parent_account_id)&&!descendants.has(link.child_account_id)){descendants.add(link.child_account_id);changed=true;}}}
    const parentAssignments=await db(env,"account_meme_assignments",`?${userFilter(ctx)}&destination_account_id=eq.${parent}&select=meme_id`);
    for(const meme of parentAssignments){for(const destination of [...descendants].filter(id=>id!==parent)){const exists=await db(env,"account_meme_assignments",`?${userFilter(ctx)}&destination_account_id=eq.${destination}&meme_id=eq.${meme.meme_id}&select=id`);if(!exists.length)await db(env,"account_meme_assignments","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,meme_id:meme.meme_id,destination_account_id:destination,assignment_source:"inheritance",approval_status:"pending",status:"pending"})});}}
    return json({relationship:rows?.[0]},201);
  }
  const relMatch=p.match(/^\/relationships\/([0-9a-f-]+)$/);
  if(relMatch&&method==="DELETE") {const r=await db(env,"account_relationships",`?id=eq.${relMatch[1]}&${userFilter(ctx)}&select=id`);if(!r.length)return fail("Relationship not found.",404);await db(env,"account_relationships",`?id=eq.${relMatch[1]}&${userFilter(ctx)}`,{method:"DELETE"});return json({ok:true});}
  if(p==="/assignments"&&method==="GET") return json({assignments:await db(env,"account_meme_assignments",`?${userFilter(ctx)}&select=*,memes(id,extracted_text,asset_url,source_permalink,classification,reel_asset_url,reel_status,reel_song_id),instagram_accounts(id,username)&order=created_at.desc&limit=300`)});
  const assignmentMatch=p.match(/^\/assignments\/([0-9a-f-]+)$/);
  if(assignmentMatch&&method==="PATCH"){
    const rows=await db(env,"account_meme_assignments",`?id=eq.${assignmentMatch[1]}&${userFilter(ctx)}&select=*`);if(!rows.length)return fail("Assignment not found.",404);
    const patch:any={};if(["pending","approved","rejected"].includes(body.approval_status))patch.approval_status=body.approval_status;
    if(body.rejection_reason!==undefined)patch.rejection_reason=String(body.rejection_reason).slice(0,500);
    if(body.publish_format!==undefined){if(!["photo","reel"].includes(body.publish_format))return fail("publish_format must be photo or reel.");patch.publish_format=body.publish_format;}
    if(body.scheduled_at!==undefined){const d=new Date(body.scheduled_at);if(Number.isNaN(d.getTime())||d.getTime()<=Date.now())return fail("Choose a future schedule time.");if(rows[0].approval_status!=="approved"&&patch.approval_status!=="approved")return fail("Approve this account assignment before scheduling.");if(rows[0].publish_format==="reel"){const m=await db(env,"memes",`?id=eq.${rows[0].meme_id}&${userFilter(ctx)}&select=reel_status,reel_song_id`);if(m[0]?.reel_status!=="generated"||!m[0]?.reel_song_id)return fail("This Reel is not ready yet. Add an enabled song and wait for Reel rendering to finish.",409);}patch.scheduled_at=d.toISOString();patch.status="scheduled";}
    if(body.scheduled_at===null){patch.scheduled_at=null;patch.status="pending";}
    const updated=await db(env,"account_meme_assignments",`?id=eq.${assignmentMatch[1]}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify(patch)});return json({assignment:updated?.[0]});
  }
  if (p === "/pipeline" && method === "GET") {
    const rows: any[] = await db(env,"memes",`?${userFilter(ctx)}&select=id,processing_status,reel_status,processing_error,processing_attempts,classification,extracted_text,source_username,created_at,processing_next_retry_at,processing_locked_until,reel_render_locked_until&order=created_at.desc&limit=500`);
    const processing: Record<string, number> = {};
    const reel: Record<string, number> = {};
    for (const r of rows) {
      const ps = r.processing_status || "unknown";
      processing[ps] = (processing[ps] || 0) + 1;
      if (r.reel_status) reel[r.reel_status] = (reel[r.reel_status] || 0) + 1;
    }
    const items = rows.filter((r) =>
      !["generated", "rejected", "media_unavailable"].includes(r.processing_status || "") ||
      ["render_failed", "renderer_not_configured"].includes(r.reel_status || "")
    ).slice(0, 200);
    const nowMs = Date.now();
    const total = rows.length;
    const stages = [
      { label: "Text read", count: rows.filter((r) => !!r.extracted_text).length, total },
      { label: "Classified", count: rows.filter((r) => r.classification === "suitable" || r.classification === "rejected").length, total },
      { label: "Rendered and ready to approve", count: rows.filter((r) => r.processing_status === "generated").length, total },
    ];
    const stepFor = (st: string) => ({ needs_ocr: "Reading text (OCR)", ocr_complete: "Classifying", ready_for_asset: "Rendering BRAT video" } as Record<string, string>)[st] || st;
    const isLocked = (r: any) => (r.processing_locked_until && new Date(r.processing_locked_until).getTime() > nowMs) || (r.reel_render_locked_until && new Date(r.reel_render_locked_until).getTime() > nowMs);
    // Only count real work: a stale lease on a finished meme is not "running".
    const running = rows
      .filter((r) => isLocked(r) && (r.processing_status !== "generated" || r.reel_status === "rendering"))
      .map((r) => ({ ...r, step: r.reel_status === "rendering" ? "Rendering video on GitHub" : stepFor(r.processing_status) }));
    const queued = rows.filter((r) => ["needs_ocr", "ocr_complete", "ready_for_asset"].includes(r.processing_status) && !isLocked(r))
      .filter((r) => !r.processing_next_retry_at || new Date(r.processing_next_retry_at).getTime() <= nowMs)
      .map((r) => ({ ...r, step: stepFor(r.processing_status) }));
    const renderer = env.GITHUB_TOKEN && env.GITHUB_REPO ? "github_actions" : "not_configured";
    const explain = (r: any): string => {
      const err = r.processing_error ? ` Error: ${r.processing_error}` : "";
      const locked = isLocked(r);
      if (r.reel_status === "rendering") return "Video is rendering on GitHub Actions. It retries if no result comes back in 30 minutes.";
      if (r.reel_status === "renderer_not_configured") return "The GitHub renderer is not configured. Set GITHUB_TOKEN and GITHUB_REPO on the Worker.";
      if (r.reel_status === "render_failed") return `Video render failed.${err} It retries automatically.`;
      if (r.reel_status === "waiting_for_song") return "Photo is ready. The reel needs a track in Song Library.";
      switch (r.processing_status) {
        case "needs_ocr": return locked ? "Reading text now." : (r.processing_attempts > 0 ? `Text reading failed.${err}` : "Waiting for the background job to read the text (runs every minute).");
        case "ocr_complete": return locked ? "Classifying now." : `Waiting for classification.${err}`;
        case "ready_for_asset": return locked ? "Starting the video render." : `Waiting to start the video render.${err}`;
        case "low_confidence": return "No readable text was found. Needs manual review.";
        case "processing_failed": return `Stopped after ${r.processing_attempts ?? 0} attempts.${err}`;
        default: return `Status: ${r.processing_status}.${err}`;
      }
    };
    const itemsWithWhy = items.map((r: any) => ({ ...r, why: explain(r) }));
    return json({ counts: { processing, reel }, renderer, items: itemsWithWhy, stages, running, queued });
  }
  if (p === "/pipeline/retry" && method === "POST") {
    // Requeue every stuck item in one pass, choosing the correct stage for each row.
    const reset = { processing_attempts: 0, processing_error: null, processing_next_retry_at: null, processing_locked_until: null, reel_render_locked_until: null, reel_render_next_retry_at: null };
    const stuck = "(needs_ocr,ocr_complete,ready_for_asset,processing_failed)";
    const groups = [
      { filter: `processing_status=in.${stuck}&extracted_text=is.null`, status: "needs_ocr" },
      { filter: `processing_status=in.${stuck}&extracted_text=not.is.null&classification=eq.suitable`, status: "ready_for_asset" },
      { filter: `processing_status=in.${stuck}&extracted_text=not.is.null&classification=neq.suitable`, status: "ocr_complete" },
    ];
    let requeued = 0;
    for (const g of groups) {
      const rows: any[] = await db(env,"memes",`?${userFilter(ctx)}&${g.filter}&select=id`,{ method: "PATCH", body: JSON.stringify({ ...reset, processing_status: g.status }) });
      requeued += rows.length;
    }
    const reelRows: any[] = await db(env,"memes",`?${userFilter(ctx)}&reel_status=in.(render_failed,renderer_not_configured,rendering)&select=id`,{ method: "PATCH", body: JSON.stringify({ reel_status: "render_failed", reel_render_locked_until: null, reel_render_next_retry_at: new Date().toISOString(), processing_error: null }) });
    return json({ requeued, reel_requeued: reelRows.length });
  }
  if(p==="/settings"&&method==="GET") {const rows=await db(env,"user_settings",`?${userFilter(ctx)}&select=*`);return json({settings:rows[0]||{global_paused:false,auto_process_enabled:true,video_freeze_seconds:2,discovery_interval_minutes:60,timezone:"Asia/Kolkata"}});}
  const processMatch=p.match(/^\/memes\/([0-9a-f-]+)\/process$/);
  if(processMatch&&method==="POST"){
    const memeId=processMatch[1];const rows=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}&select=*`);if(!rows.length)return fail("Meme not found.",404);
    const meme=rows[0];const next=meme.classification==="suitable"&&meme.extracted_text?"ready_for_asset":meme.extracted_text?"ocr_complete":"needs_ocr";
    const updated=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({processing_status:next,processing_attempts:0,processing_next_retry_at:null,processing_locked_until:null,processing_error:null})});
    return json({queued:true,processing_status:updated?.[0]?.processing_status||next});
  }
  const classifyMatch=p.match(/^\/memes\/([0-9a-f-]+)\/classify$/);
  if(classifyMatch&&method==="POST"){
    const memeId=classifyMatch[1];const memes=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}&select=*`);if(!memes.length)return fail("Meme not found.",404);
    const meme=memes[0];if(!meme.extracted_text?.trim())return fail("Extract text with OCR before classification.");
    const creds=await db(env,"api_credentials",`?${userFilter(ctx)}&provider=eq.groq&enabled=eq.true&or=(cooldown_until.is.null,cooldown_until.lte.${encodeURIComponent(new Date().toISOString())})&status=neq.error&select=*&order=last_used_at.asc.nullsfirst,created_at.asc`);if(!creds.length)return fail("Add and enable a Groq key in Settings → API Manager.",503);
    let result:any=null,lastError="No Groq key could process this request.";
    for(const credential of creds){try{
      const secret=await decryptSecret(env,credential);
      const response=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify({model:"openai/gpt-oss-20b",temperature:0,response_format:{type:"json_object"},messages:[{role:"system",content:"Classify whether a meme can be faithfully converted into a text-only BRAT-style image. Return JSON only: {\"suitable\":boolean,\"reason\":string}. suitable=true only when the complete joke/meaning is carried by the extracted words alone and does not depend on a photo, reaction face, screenshot layout, visual context, or image-specific details. Never rewrite, correct, summarize, or improve the text."},{role:"user",content:`Extracted text (preserve exactly):\\n${meme.extracted_text}`} ]})});
      const data:any=await response.json().catch(()=>({}));if(!response.ok){lastError=data.error?.message||`Groq returned ${response.status}.`;await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:response.status===429?"rate_limited":"error",cooldown_until:response.status===429?new Date(Date.now()+5*60*1000).toISOString():null,last_used_at:new Date().toISOString()})});if(response.status===429||response.status===401||response.status>=500)continue;break;}
      result=JSON.parse(data.choices?.[0]?.message?.content||"{}");await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"connected",cooldown_until:null,last_used_at:new Date().toISOString()})});break;
    }catch(e:any){lastError=e.message||lastError;}}
    if(!result)return fail(lastError,502);
    const classification=result.suitable===true?"suitable":"rejected";
    const updated=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({classification,classification_reason:String(result.reason||"No explanation provided.").slice(0,500),processing_status:classification==="suitable"?"ready_for_asset":"rejected"})});
    return json({meme:updated?.[0]});
  }
  const ocrMatch=p.match(/^\/memes\/([0-9a-f-]+)\/ocr$/);
  if(ocrMatch&&method==="POST"){
    const memeId=ocrMatch[1];if(!await owned(env,"memes",memeId,ctx))return fail("Meme not found.",404);
    const extracted=String(body.extracted_text||"").slice(0,2000);const confidence=Number(body.ocr_confidence||0);
    if(!extracted.trim())return fail("OCR did not return readable text.");
    const suitable=confidence>=65;
    const rows=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({extracted_text:extracted,ocr_confidence:confidence,classification:suitable?"needs_review":"low_confidence",classification_reason:suitable?"Text extracted; approve or reject manually.":"OCR confidence is low; manual review required.",processing_status:"ocr_complete"})});
    return json({meme:rows?.[0]});
  }
  if(p==="/memes/assign"&&method==="POST"){
    const memeId=String(body.meme_id||"");const ids=Array.isArray(body.account_ids)?body.account_ids:[];
    if(!await owned(env,"memes",memeId,ctx))return fail("Meme not found.",404);if(!ids.length)return fail("Choose at least one destination account.");
    const rows=[];for(const id of ids){if(!await owned(env,"instagram_accounts",String(id),ctx))continue;const existing=await db(env,"account_meme_assignments",`?${userFilter(ctx)}&meme_id=eq.${memeId}&destination_account_id=eq.${id}&select=id`);if(!existing.length){const created=await db(env,"account_meme_assignments","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,meme_id:memeId,destination_account_id:id,assignment_source:"manual",approval_status:"pending",status:"pending"})});rows.push(...(created||[]));}}
    return json({assignments:rows},201);
  }

  if(p==="/schedule"&&method==="GET")return json({items:await db(env,"account_meme_assignments",`?${userFilter(ctx)}&scheduled_at=not.is.null&select=*,memes(extracted_text),instagram_accounts(username)&order=scheduled_at.asc`)});
  if(p==="/publishing"&&method==="GET")return json({items:await db(env,"publishing_history",`?${userFilter(ctx)}&select=*,memes(extracted_text)&order=created_at.desc&limit=100`)});
  if(p==="/analytics"&&method==="GET"){
    const published=await db(env,"publishing_history",`?${userFilter(ctx)}&status=eq.published&select=id`);
    const rows=await db(env,"analytics",`?${userFilter(ctx)}&select=metric_name,metric_value,meme_id,destination_account_id,collected_on&order=collected_on.desc&limit=3000`);
    const latest=new Map<string,any>();for(const r of rows){const key=`${r.meme_id||""}:${r.destination_account_id||""}:${r.metric_name}`;if(!latest.has(key))latest.set(key,r);}
    const totals:any={};for(const r of latest.values())totals[r.metric_name]=(totals[r.metric_name]||0)+Number(r.metric_value||0);
    const hasEngagement=["likes","comments","saves","shares"].some(k=>totals[k]!==undefined);return json({published:published.length,reach:totals.reach??null,views:totals.views??null,likes:totals.likes??null,comments:totals.comments??null,saves:totals.saves??null,shares:totals.shares??null,engagement:hasEngagement?(totals.likes||0)+(totals.comments||0)+(totals.saves||0)+(totals.shares||0):(totals.total_interactions??null),last_synced_at:rows[0]?.collected_on||null});
  }
  if(p==="/analytics/sync"&&method==="POST"){const result=await syncMetaAnalyticsForOwner(env,ctx);const current=await db(env,"user_settings",`?${userFilter(ctx)}&select=owner_id`);if(current.length)await db(env,"user_settings",`?${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({last_analytics_sync_at:new Date().toISOString()})});else await db(env,"user_settings","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,last_analytics_sync_at:new Date().toISOString()})});return json(result);}
  if(p==="/health"&&method==="GET"){
    const creds=await db(env,"api_credentials",`?${userFilter(ctx)}&select=provider,enabled`);
    const count=(provider:string)=>creds.filter((c:any)=>c.provider===provider&&c.enabled).length;
    const settings=await db(env,"user_settings",`?${userFilter(ctx)}&select=global_paused,auto_process_enabled`);
    const jobs=await db(env,"jobs",`?${userFilter(ctx)}&status=in.(queued,running)&select=id`);
    let renderStatus=env.GITHUB_TOKEN&&env.GITHUB_REPO?"GitHub Actions ready":"Needs configuration";
    return json({status:"ok",automation:{paused:!!settings[0]?.global_paused,auto_process_enabled:settings[0]?.auto_process_enabled!==false,active_jobs:jobs.length},integrations:[{name:"Supabase",status:"Configured"},{name:"Apify",status:count("apify")?`${count("apify")} key(s) in API Manager`:"Needs setup"},{name:"Groq",status:count("groq")?`${count("groq")} key(s) in API Manager`:"Needs setup"},{name:"Meta",status:env.META_APP_ID&&env.META_APP_SECRET?"Credentials set":"Needs configuration"},{name:"Workers AI OCR",status:env.AI?"Server-side OCR available":"AI binding missing"},{name:"BRAT render service",status:renderStatus}]});
  }
  if(p==="/api-credentials"&&method==="GET"){
    const rows=await db(env,"api_credentials",`?${userFilter(ctx)}&select=id,provider,label,key_hint,actor_id,actor_input,enabled,status,last_tested_at,last_used_at,created_at&order=created_at.desc`);
    return json({credentials:rows.map((row:any)=>({...row,actor_id:row.actor_id||(row.provider==="apify"?DEFAULT_APIFY_ACTOR:null)}))});
  }
  if(p==="/api-credentials"&&method==="POST"){
    const provider=String(body.provider||"").toLowerCase();
    const label=String(body.label||"").trim().slice(0,60);
    const secret=String(body.secret||"").trim();
    const actorId=String(body.actor_id|| (provider==="apify"?DEFAULT_APIFY_ACTOR:"")).trim();
    let actorInput:any={};try{actorInput=typeof body.actor_input==="string"?JSON.parse(body.actor_input||"{}"):body.actor_input||{};}catch{return fail("Actor input must be valid JSON.");}
    if(!actorInput||typeof actorInput!=="object"||Array.isArray(actorInput))return fail("Actor input must be a JSON object.");
    if(!["apify","groq"].includes(provider))return fail("Provider must be Apify or Groq.");
    if(!label)return fail("Give this key a name.");
    if(secret.length<12||secret.length>500)return fail("Enter a valid API key.");
    if(provider==="apify"&&!actorId)return fail("An Apify Actor ID is required.");
    const encrypted=await encryptSecret(env,secret);
    const rows=await db(env,"api_credentials","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,provider,label,key_hint:secret.slice(-4),actor_id:provider==="apify"?actorId:null,actor_input:provider==="apify"?actorInput:{},enabled:true,status:"untested",...encrypted})});
    return json({credential:credentialView(rows?.[0])},201);
  }
  const credentialMatch=p.match(/^\/api-credentials\/([0-9a-f-]+)$/);
  if(credentialMatch&&method==="PATCH"){
    const rows=await db(env,"api_credentials",`?id=eq.${credentialMatch[1]}&${userFilter(ctx)}&select=*`);
    if(!rows.length)return fail("API key not found.",404);
    const patch:any={}; if(typeof body.enabled==="boolean")patch.enabled=body.enabled;
    if(body.label!==undefined)patch.label=String(body.label).trim().slice(0,60);
    if(body.actor_id!==undefined&&rows[0].provider==="apify")patch.actor_id=String(body.actor_id).trim();
    if(body.actor_input!==undefined&&rows[0].provider==="apify"){try{const input=typeof body.actor_input==="string"?JSON.parse(body.actor_input||"{}"):body.actor_input;if(!input||typeof input!=="object"||Array.isArray(input))return fail("Actor input must be a JSON object.");patch.actor_input=input;}catch{return fail("Actor input must be valid JSON.");}}
    if(body.secret){if(String(body.secret).length<12)return fail("Enter a valid API key.");Object.assign(patch,await encryptSecret(env,String(body.secret).trim()),{key_hint:String(body.secret).slice(-4),status:"untested"});}
    const updated=await db(env,"api_credentials",`?id=eq.${credentialMatch[1]}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify(patch)});
    return json({credential:credentialView(updated?.[0])});
  }
  if(credentialMatch&&method==="DELETE"){
    const rows=await db(env,"api_credentials",`?id=eq.${credentialMatch[1]}&${userFilter(ctx)}&select=id`);if(!rows.length)return fail("API key not found.",404);
    await db(env,"api_credentials",`?id=eq.${credentialMatch[1]}&${userFilter(ctx)}`,{method:"DELETE"});return json({ok:true});
  }
  const testMatch=p.match(/^\/api-credentials\/([0-9a-f-]+)\/test$/);
  if(testMatch&&method==="POST"){
    const rows=await db(env,"api_credentials",`?id=eq.${testMatch[1]}&${userFilter(ctx)}&select=*`);if(!rows.length)return fail("API key not found.",404);
    const row=rows[0];const secret=await decryptSecret(env,row);let response:Response;
    if(row.provider==="apify")response=await fetch("https://api.apify.com/v2/users/me",{headers:{Authorization:`Bearer ${secret}`}});
    else response=await fetch("https://api.groq.com/openai/v1/models",{headers:{Authorization:`Bearer ${secret}`}});
    const ok=response.ok;const detail=ok?(row.provider==="apify"?"Apify API key authenticated.":"Groq API key authenticated."):((await response.text()).slice(0,180)||`Provider returned ${response.status}.`);
    await db(env,"api_credentials",`?id=eq.${row.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:ok?"connected":response.status===429?"rate_limited":"error",cooldown_until:response.status===429?new Date(Date.now()+5*60*1000).toISOString():null,last_tested_at:new Date().toISOString()})});
    return json({ok,message:detail},ok?200:400);
  }
  if(p==="/settings"&&method==="PATCH"){
    const current=await db(env,"user_settings",`?${userFilter(ctx)}&select=global_paused,auto_process_enabled`);
    const patch:any={owner_id:ctx.userId};
    if(typeof body.global_paused==="boolean")patch.global_paused=body.global_paused;
    if(typeof body.auto_process_enabled==="boolean")patch.auto_process_enabled=body.auto_process_enabled;
    if(body.video_freeze_seconds!==undefined){const n=Number(body.video_freeze_seconds);if(!Number.isFinite(n)||n<0||n>5)return fail("Reel final-frame freeze must be between 0 and 5 seconds.");patch.video_freeze_seconds=n; }
    if(body.discovery_interval_minutes!==undefined){const n=Number(body.discovery_interval_minutes);if(![15,30,60,120,360,720,1440].includes(n))return fail("Choose a supported discovery interval.");patch.discovery_interval_minutes=n;}
    if(current.length){await db(env,"user_settings",`?${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify(patch)});}
    else {patch.global_paused=typeof body.global_paused==="boolean"?body.global_paused:false;patch.auto_process_enabled=typeof body.auto_process_enabled==="boolean"?body.auto_process_enabled:true;patch.discovery_interval_minutes=patch.discovery_interval_minutes||60;await db(env,"user_settings","",{method:"POST",body:JSON.stringify(patch)});}
    return json({ok:true});
  }
  if(p==="/discovery/run"&&method==="POST"){
    const settings=await db(env,"user_settings",`?${userFilter(ctx)}&select=global_paused`);if(settings[0]?.global_paused)return fail("Global automation is paused. Resume it in Settings first.",423);
    const creds=await db(env,"api_credentials",`?${userFilter(ctx)}&provider=eq.apify&enabled=eq.true&or=(cooldown_until.is.null,cooldown_until.lte.${encodeURIComponent(new Date().toISOString())})&status=neq.error&select=*&order=last_used_at.asc.nullsfirst,created_at.asc`);
    if(!creds.length)return fail("Add and enable an Apify API key in Settings → API Manager first.",503);
    const activeAccounts=await db(env,"instagram_accounts",`?${userFilter(ctx)}&discovery_enabled=eq.true&select=id`);
    if(!activeAccounts.length)return fail("Enable discovery on at least one destination account first.");
    const mappings=await db(env,"destination_sources",`?${userFilter(ctx)}&select=destination_account_id,reference_account_id`);
    const allowed=new Set<string>();let allSources=false;for(const account of activeAccounts){const own=mappings.filter((m:any)=>m.destination_account_id===account.id);if(!own.length)allSources=true;for(const m of own)allowed.add(m.reference_account_id);}
    const allSourcesRows=await db(env,"reference_accounts",`?${userFilter(ctx)}&enabled=eq.true&select=id,username`);
    const sources=allSources?allSourcesRows:allSourcesRows.filter((source:any)=>allowed.has(source.id));
    if(!sources.length)return fail("Add or assign at least one enabled reference account to a destination with discovery enabled.");
    let started:any=null;let used:any=null;let lastError="No Apify key could start the run.";
    for(const credential of creds){
      try{
        const secret=await decryptSecret(env,credential);const actor=encodeURIComponent((credential.actor_id||DEFAULT_APIFY_ACTOR).replace("/","~"));const input=buildActorInput(credential.actor_input,sources.map((s:any)=>s.username),credential.actor_id||DEFAULT_APIFY_ACTOR);
        const response=await fetch(`https://api.apify.com/v2/acts/${actor}/runs?waitForFinish=0`,{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify(input)});
        const result:any=await response.json().catch(()=>({}));
        if(response.ok){started=result;used=credential;break;}
        lastError=result.error?.message||`Apify returned ${response.status}.`;
        if(response.status===401||response.status===403)await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"error",cooldown_until:null,last_used_at:new Date().toISOString()})});
        else if(response.status===429)await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"rate_limited",cooldown_until:new Date(Date.now()+5*60*1000).toISOString(),last_used_at:new Date().toISOString()})});
        if(response.status!==429&&response.status<500)continue;
      }catch(e:any){lastError=e.message||lastError;}
    }
    if(!started)return fail(lastError,502);
    await db(env,"api_credentials",`?id=eq.${used.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({last_used_at:new Date().toISOString(),status:"connected",cooldown_until:null})});
    const job=await db(env,"jobs","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,job_type:"discovery",status:"running",provider_run_id:started.data?.id,attempt_count:0,max_attempts:5,metadata:{dataset_id:started.data?.defaultDatasetId,credential_id:used.id,actor_id:used.actor_id,source_usernames:sources.map((s:any)=>s.username)}})});
    const settingsRow=await db(env,"user_settings",`?${userFilter(ctx)}&select=owner_id`);if(settingsRow.length)await db(env,"user_settings",`?${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({last_discovery_started_at:new Date().toISOString(),discovery_lock_until:null})});else await db(env,"user_settings","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,last_discovery_started_at:new Date().toISOString(),discovery_interval_minutes:60,discovery_lock_until:null})});
    return json({job_id:job?.[0]?.id,provider_run_id:started.data?.id,credential_label:used.label},202);
  }
  return fail("Route not found.",404);
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url=new URL(req.url);
    // Public browser configuration: the publishable key is designed to be public.
    // Never return SUPABASE_SECRET_KEY from this endpoint.
    if(url.pathname==="/api/public-config") {
      return new Response(JSON.stringify({supabaseUrl:env.SUPABASE_URL||"",publishableKey:env.SUPABASE_PUBLISHABLE_KEY||""}),{status:200,headers:{"Content-Type":"application/json","Cache-Control":"no-store, max-age=0"}});
    }
    if(url.pathname==="/api/meta/callback") return metaCallback(req,env,url);
    if(url.pathname.startsWith("/api/")){
      const authResult=await auth(req,env);if(!authResult.ctx)return fail(authResult.error,401);
      try{return await route(req,env,authResult.ctx,url)}catch(e:any){return fail(e.message||"Internal error",500)}
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // Durable, bounded Apify polling. A failed transient attempt is rescheduled instead of
    // losing the run; terminal Apify statuses are marked failed by runApifyPoll.
    const now=new Date().toISOString();
    const jobs = await db(env,"jobs",`?job_type=eq.discovery&status=in.(running,queued)&or=(next_retry_at.is.null,next_retry_at.lte.${encodeURIComponent(now)})&select=*&order=created_at.asc&limit=20`);
    for (const job of jobs) {
      const ctx:Ctx={userId:job.owner_id,token:""};
      try {
        const settings=await db(env,"user_settings",`?${userFilter(ctx)}&select=global_paused`);if(settings[0]?.global_paused)continue;
        const lease=await db(env,"jobs",`?id=eq.${job.id}&${userFilter(ctx)}&status=in.(running,queued)&or=(locked_until.is.null,locked_until.lte.${encodeURIComponent(now)})`,{method:"PATCH",body:JSON.stringify({last_attempt_at:now,locked_until:new Date(Date.now()+12*60*1000).toISOString()})});
        if(!lease?.length)continue;
        const result=await runApifyPoll(env,ctx,{...job,...lease[0]});
        if(!result.done)await db(env,"jobs",`?id=eq.${job.id}`,{method:"PATCH",body:JSON.stringify({status:"running",locked_until:null,next_retry_at:new Date(Date.now()+5*60*1000).toISOString()})});
      } catch (e:any) {
        const attempt=Number(job.attempt_count||0)+1;const terminal=/finished with status (FAILED|ABORTED|TIMED-OUT)/i.test(String(e?.message||e));
        const exhausted=attempt>=Number(job.max_attempts||5)||terminal;
        const delay=Math.min(60,Math.pow(2,attempt)*2);
        await db(env,"jobs",`?id=eq.${job.id}`,{method:"PATCH",body:JSON.stringify({status:exhausted?"failed":"queued",last_error:String(e?.message||e).slice(0,500),completed_at:exhausted?now:null,attempt_count:attempt,retry_count:attempt,next_retry_at:exhausted?null:new Date(Date.now()+delay*60*1000).toISOString(),locked_until:null})});
      }
    }
    try{await runScheduledDiscovery(env);}catch(e:any){console.error("Scheduled discovery phase failed",String(e?.message||e));}
    try{await runBackgroundProcessing(env);}catch(e:any){console.error("Background processing phase failed",String(e?.message||e));}
    try{await runWaitingReels(env);}catch(e:any){console.error("Reel rendering phase failed",String(e?.message||e));}
    try{const analyticsOwners=await db(env,"user_settings","?select=owner_id,last_analytics_sync_at,global_paused");
      for(const setting of analyticsOwners){if(setting.global_paused)continue;if(setting.last_analytics_sync_at&&Date.now()-new Date(setting.last_analytics_sync_at).getTime()<6*60*60*1000)continue;const ctx:Ctx={userId:setting.owner_id,token:""};try{await syncMetaAnalyticsForOwner(env,ctx);await db(env,"user_settings",`?${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({last_analytics_sync_at:new Date().toISOString()})});}catch{}}}catch(e:any){console.error("Analytics sync phase failed",String(e?.message||e));}
    const expiredPublishing=await db(env,"account_meme_assignments",`?status=eq.publishing&publishing_locked_until=lt.${encodeURIComponent(now)}&select=id,owner_id&limit=50`);
    for(const item of expiredPublishing){const ctx:Ctx={userId:item.owner_id,token:""};await db(env,"account_meme_assignments",`?id=eq.${item.id}&${userFilter(ctx)}&status=eq.publishing`,{method:"PATCH",body:JSON.stringify({status:"needs_review",publishing_locked_until:null,rejection_reason:"Publishing worker lease expired. Check Instagram before retrying to avoid a duplicate post."})});}
    const due = await db(env,"account_meme_assignments",`?approval_status=eq.approved&status=eq.scheduled&scheduled_at=lte.${encodeURIComponent(now)}&or=(publishing_locked_until.is.null,publishing_locked_until.lte.${encodeURIComponent(now)})&select=id,owner_id&order=scheduled_at.asc&limit=25`);
    for(const item of due){
      const ctx:Ctx={userId:item.owner_id,token:""};const settings=await db(env,"user_settings",`?${userFilter(ctx)}&select=global_paused`);if(settings[0]?.global_paused)continue;
      const lease=await db(env,"account_meme_assignments",`?id=eq.${item.id}&${userFilter(ctx)}&status=eq.scheduled&approval_status=eq.approved&scheduled_at=lte.${encodeURIComponent(now)}&or=(publishing_locked_until.is.null,publishing_locked_until.lte.${encodeURIComponent(now)})`,{method:"PATCH",body:JSON.stringify({status:"publishing",publishing_started_at:now,publishing_locked_until:new Date(Date.now()+10*60*1000).toISOString()})});
      if(lease?.length){try{await publishAssignment(env,item);}catch(e:any){console.error("Scheduled publish failed",item.id,String(e?.message||e));}}
    }
  }
};
