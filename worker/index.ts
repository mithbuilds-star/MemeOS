import * as L from "./lifecycle.mjs";
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
function credentialFailureStatus(status:number,currentStatus?:string){if(status===429)return "rate_limited";if(status===401||status===403)return "error";return currentStatus||"untested";}
function credentialView(row: any) {
  return {id:row.id,provider:row.provider,label:row.label,key_hint:row.key_hint,actor_id:row.actor_id||(row.provider==="apify"?DEFAULT_APIFY_ACTOR:null),enabled:row.enabled,status:row.status,last_tested_at:row.last_tested_at,last_used_at:row.last_used_at,created_at:row.created_at,usage_snapshot:row.usage_snapshot||null,usage_refreshed_at:row.usage_refreshed_at||null,auto_disabled_until:row.auto_disabled_until||null,auto_disabled_reason:row.auto_disabled_reason||null};
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
  const rawDate = item?.takenAt ?? item?.timestamp ?? item?.takenAtTimestamp ?? item?.takenAtIso ?? item?.timestampIso ?? item?.date ?? item?.createdAt ?? item?.publishedAt;
  let postedAt:string|null=null;
  if(typeof rawDate==="number"&&Number.isFinite(rawDate))postedAt=new Date(rawDate<1000000000000?rawDate*1000:rawDate).toISOString();
  else if(typeof rawDate==="string"&&rawDate.trim()){const parsed=new Date(rawDate);if(!Number.isNaN(parsed.getTime()))postedAt=parsed.toISOString();}
  return { username, permalink, postId, image, caption, type, postedAt };
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

function isApifyMonthlyLimitError(message:string){
  return /used the?\s*\$?[\d,.]+\s+of monthly usage included in (the )?(free|starter) plan|monthly usage.{0,120}(blocked|limit|exhausted)|actor runs and other apify services are blocked|monthly usage cycle resets|cost.{0,100}(over|exceed).{0,80}balance|insufficient.{0,80}balance|not enough.{0,80}(credit|balance)/i.test(message);
}
async function disableApifyKeyUntilCycleEnds(env:Env,ctx:Ctx,credential:any,secret:string,message:string){
  const now=new Date().toISOString();let limits:any={};
  try{const response=await fetch("https://api.apify.com/v2/users/me/limits",{headers:{Authorization:"Bearer "+secret}});const data:any=await response.json().catch(()=>({}));if(response.ok)limits=data.data||{};}catch{}
  const previous=credential.usage_snapshot?.usage||{};const cycleEnd=limits.monthlyUsageCycle?.endAt||previous.cycle_end||null;
  const snapshot={provider:"apify",refreshed_at:now,usage:{used_usd:limits.current?.monthlyUsageUsd??previous.used_usd??null,limit_usd:limits.limits?.maxMonthlyUsageUsd??previous.limit_usd??null,used_compute_units:limits.current?.monthlyActorComputeUnits??previous.used_compute_units??null,limit_compute_units:limits.limits?.maxMonthlyActorComputeUnits??previous.limit_compute_units??null,cycle_start:limits.monthlyUsageCycle?.startAt||previous.cycle_start||null,cycle_end:cycleEnd},limit_reached:true,balance_error:message};
  await db(env,"api_credentials","?id=eq."+credential.id+"&"+userFilter(ctx),{method:"PATCH",body:JSON.stringify({enabled:false,status:"limit_reached",auto_disabled_reason:"apify_monthly_limit",auto_disabled_until:cycleEnd,usage_snapshot:snapshot,usage_refreshed_at:now,last_used_at:now,cooldown_until:null})});
  credential.enabled=false;credential.status="limit_reached";credential.auto_disabled_reason="apify_monthly_limit";credential.auto_disabled_until=cycleEnd;credential.usage_snapshot=snapshot;
}
async function apifyRequestWithFallback(env:Env,ctx:Ctx,url:string){
  const now=new Date().toISOString();
  const creds=await db(env,"api_credentials",`?${userFilter(ctx)}&provider=eq.apify&enabled=eq.true&or=(cooldown_until.is.null,cooldown_until.lte.${encodeURIComponent(now)})&status=neq.error&select=*&order=last_used_at.asc.nullsfirst,created_at.asc`);
  if(!creds.length)throw new Error("No available Apify API key. Enable another key in Settings → API Manager.");
  let lastError="Apify request failed.";
  for(const credential of creds){
    try{
      const secret=await decryptSecret(env,credential);
      const response=await fetch(url,{headers:{Authorization:`Bearer ${secret}`}});
      if(!response.ok){
        const data:any=await response.clone().json().catch(()=>({}));
        lastError=data.error?.message||`Apify returned ${response.status}.`;
        if(isApifyMonthlyLimitError(lastError))await disableApifyKeyUntilCycleEnds(env,ctx,credential,secret,lastError);
        else await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:credentialFailureStatus(response.status,credential.status),cooldown_until:response.status===429?new Date(Date.now()+5*60*1000).toISOString():null,last_used_at:new Date().toISOString()})});
        continue;
      }
      await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"connected",cooldown_until:null,last_used_at:new Date().toISOString()})});
      return response;
    }catch(e:any){lastError=e?.message||lastError;}
  }
  throw new Error(lastError);
}

async function runApifyPoll(env: Env, ctx: Ctx, job: any) {
  const runId=job.provider_run_id;
  if(!runId)throw new Error("Discovery job has no Apify run ID.");
  const statusRes=await apifyRequestWithFallback(env,ctx,`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`);
  const statusData:any=await statusRes.json().catch(()=>({}));
  const run=statusData.data||{};
  if(!["SUCCEEDED","FAILED","ABORTED","TIMED-OUT"].includes(run.status))return {done:false,status:run.status};
  if(run.status!=="SUCCEEDED"){
    await db(env,"jobs",`?id=eq.${job.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"failed",last_error:`Apify run finished with status ${run.status}.`,completed_at:new Date().toISOString(),next_retry_at:null,locked_until:null})});
    throw new Error(`Apify run finished with status ${run.status}.`);
  }
  const datasetId=run.defaultDatasetId||job.metadata?.dataset_id;
  if(!datasetId)throw new Error("Apify run completed without a dataset ID.");
  // Read the complete dataset in pages; the actor can return up to 10,000
  // results per profile and the default API page must not silently truncate it.
  const items:any[]=[];
  for(let offset=0;offset<10000;offset+=1000){
    const itemsRes=await apifyRequestWithFallback(env,ctx,`https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?clean=true&format=json&limit=1000&offset=${offset}`);
    const page:any[]=await itemsRes.json();
    items.push(...page);
    if(page.length<1000)break;
  }
  // Backfill runs are bounded by the oldest post in the incremental result.
  // The official Apify actor has no onlyPostsOlderThan input, so enforce the
  // cutoff locally after fetching its maximum timeline; compatible custom actors
  // can also apply the same cutoff server-side.
  const backfillBefore=job.metadata?.phase==="backfill"&&job.metadata?.backfill_before?Date.parse(job.metadata.backfill_before):null;
  const batch=backfillBefore?items.filter((item:any)=>{
    const postedAt=normalizeApifyItem(item).postedAt;
    return !!postedAt&&Date.parse(postedAt)<backfillBefore;
  }):items;
  let inserted = 0, skipped = 0, failedMedia = 0;
  for (const item of batch) {
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
  const sourceNames=Array.isArray(job.metadata?.source_usernames)?job.metadata.source_usernames:[];
  // Only the incremental pass advances the successful cursor. A historical
  // backfill is deliberately independent and must never move it backwards.
  if(job.metadata?.phase!=="backfill"){
    const cursorAt=job.created_at||new Date().toISOString();
    for(const username of sourceNames){
      const sourceRows=await db(env,"reference_accounts",`?${userFilter(ctx)}&username=eq.${encodeURIComponent(String(username).replace(/^@/,""))}&select=id`);
      for(const source of sourceRows)await db(env,"reference_accounts",`?id=eq.${source.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({last_scraped_at:cursorAt,last_scrape_status:"completed"})});
    }
  }
  // Fewer than five recent posts means this source is likely quiet or its
  // previous cursor was advanced past older content. Start one bounded historical
  // pass ending at the oldest post returned by the incremental scrape.
  const lastSuccessfulScrapeAt=job.metadata?.last_successful_scrape_at?Date.parse(job.metadata.last_successful_scrape_at):null;
  const genuinelyNewPosts=lastSuccessfulScrapeAt?items.filter((item:any)=>{
    const postedAt=normalizeApifyItem(item).postedAt;
    return !!postedAt&&Date.parse(postedAt)>lastSuccessfulScrapeAt;
  }):[];
  if(job.metadata?.phase!=="backfill"&&lastSuccessfulScrapeAt!==null&&genuinelyNewPosts.length<SCRAPE_BACKFILL_THRESHOLD){
    const dated=genuinelyNewPosts.map((item:any)=>normalizeApifyItem(item).postedAt).filter((v:any)=>!!v).map((v:string)=>new Date(v).getTime()).filter((v:number)=>Number.isFinite(v));
    const oldest=dated.length?new Date(Math.min(...dated)).toISOString():new Date(lastSuccessfulScrapeAt).toISOString();
      const credentialRows=await db(env,"api_credentials",`?id=eq.${encodeURIComponent(String(job.metadata?.credential_id||""))}&${userFilter(ctx)}&select=*`);
      const credential=credentialRows?.[0];
      if(credential&&credential.enabled!==false){
        try{
          const secret=await decryptSecret(env,credential);
          const actorId=credential.actor_id||DEFAULT_APIFY_ACTOR;
          const actor=encodeURIComponent(actorId.replace("/","~"));
          const backfillInput=buildActorInput(credential.actor_input,sourceNames,actorId,10000,null,oldest);
          const response=await fetch(`https://api.apify.com/v2/acts/${actor}/runs?waitForFinish=0`,{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify(backfillInput)});
          const result:any=await response.json().catch(()=>({}));
          if(!response.ok)throw new Error(result.error?.message||`Apify backfill returned ${response.status}.`);
          await db(env,"jobs","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,job_type:"discovery",status:"running",provider_run_id:result.data?.id,attempt_count:0,max_attempts:5,metadata:{dataset_id:result.data?.defaultDatasetId,credential_id:credential.id,actor_id:actorId,source_usernames:sourceNames,source_reference_account_id:job.metadata?.source_reference_account_id,scheduled:job.metadata?.scheduled,phase:"backfill",backfill_before:oldest,backfill_for_job_id:job.id}})});
          LOG("discovery_backfill_started",{source_usernames:sourceNames,newer_posts:genuinelyNewPosts.length,items_seen:items.length,backfill_before:oldest});
        }catch(e:any){
          LOG("discovery_backfill_start_failed",{source_usernames:sourceNames,error:String(e?.message||e).slice(0,300)});
        }
      }
    }
  await db(env,"jobs",`?id=eq.${job.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"completed",completed_at:new Date().toISOString(),locked_until:null,next_retry_at:null,metadata:{...job.metadata,dataset_id:datasetId,items_seen:items.length,inserted,skipped,failed_media:failedMedia}})});
  await refreshAllCredentialUsage(env,ctx);
  await logMajorActivity(env,ctx.userId,"discovery_batch",`Discovery imported ${inserted} memes (${failedMedia} media unavailable, ${skipped} skipped).`,inserted,{items_seen:items.length,inserted,skipped,failed_media:failedMedia,source_usernames:sourceNames});
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
      if(!response.ok){lastError=data.error?.message||`Groq returned ${response.status}.`;await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:credentialFailureStatus(response.status,credential.status),cooldown_until:response.status===429?new Date(Date.now()+5*60*1000).toISOString():null,last_used_at:new Date().toISOString()})});continue;}
      const parsed=JSON.parse(data.choices?.[0]?.message?.content||"{}");
      await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"connected",cooldown_until:null,last_used_at:new Date().toISOString()})});
      return {suitable:parsed.suitable===true,reason:String(parsed.reason||"No explanation provided.").slice(0,500)};
    }catch(e:any){lastError=e.message||lastError;}
  }
  throw new Error(lastError);
}

async function generateCaptionWithGroq(env:Env,ctx:Ctx,meme:any):Promise<string>{
  const source=String(meme.extracted_text||meme.original_caption||"").trim();
  if(!source)throw new Error("This meme has no readable text for AI caption generation.");
  const creds=await db(env,"api_credentials","?"+userFilter(ctx)+"&provider=eq.groq&enabled=eq.true&or=(cooldown_until.is.null,cooldown_until.lte."+encodeURIComponent(new Date().toISOString())+")&status=neq.error&select=*&order=last_used_at.asc.nullsfirst,created_at.asc");
  if(!creds.length)throw new Error("No enabled Groq API key. Add one in Settings → API Manager to generate captions.");
  let lastError="Groq could not generate a caption.";
  for(const credential of creds){
    try{
      const secret=await decryptSecret(env,credential);
      const response=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+secret,"Content-Type":"application/json"},body:JSON.stringify({model:"openai/gpt-oss-20b",temperature:0.8,response_format:{type:"json_object"},messages:[
        {role:"system",content:"Create a short, sharp Instagram caption for this specific meme. Return JSON only: {\"caption\":\"...\"}. The caption must be exactly one or two words, lowercase, and feel like a natural human reaction. Read the joke first and choose words that fit its actual situation, emotion, reference, or punchline; be specific rather than using a generic reaction. Vary your vocabulary and phrasing across memes. Do NOT default to or repeatedly use filler captions such as real, too real, relatable, fr, ong, literally me, or same; use one only when it is genuinely the best fit for this particular meme. Consider concise reactions, dry humor, irony, understatement, niche slang, or a relevant phrase. No hashtags, emojis, punctuation, sentences, explanations, quotes, or more than two words. Never simply copy text from the meme."},
        {role:"user",content:"Meme text:\n"+source.slice(0,3000)}
      ]})});
      const data:any=await response.json().catch(()=>({}));
      if(!response.ok){lastError=data.error?.message||"Groq returned "+response.status+".";await db(env,"api_credentials","?id=eq."+credential.id+"&"+userFilter(ctx),{method:"PATCH",body:JSON.stringify({status:credentialFailureStatus(response.status,credential.status),cooldown_until:response.status===429?new Date(Date.now()+5*60*1000).toISOString():null,last_used_at:new Date().toISOString()})});continue;}
      const parsed=JSON.parse(data.choices?.[0]?.message?.content||"{}");
      const caption=String(parsed.caption||"").trim().toLowerCase().replace(/^["']+|["']+$/g,"").replace(/[.!?,;:]+$/g,"").replace(/\s+/g," ");
      if(!/^[a-z0-9][a-z0-9'_-]*(?:\s+[a-z0-9][a-z0-9'_-]*)?$/.test(caption))throw new Error("AI returned a caption that was not one or two words. Try approving again.");
      await db(env,"api_credentials","?id=eq."+credential.id+"&"+userFilter(ctx),{method:"PATCH",body:JSON.stringify({status:"connected",cooldown_until:null,last_used_at:new Date().toISOString()})});
      return caption;
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
const LOG=(event:string,fields:Record<string,unknown>)=>console.log(L.logEvent(event,fields));
async function logMajorActivity(env:Env,ownerId:string,eventType:string,message:string,count:number,metadata:Record<string,unknown>={}){
  if(count<2)return;
  try{await db(env,"activity_logs","",{method:"POST",body:JSON.stringify({owner_id:ownerId,event_type:eventType,message,metadata:{...metadata,count}})});}
  catch(e:any){console.warn("Could not persist activity summary",String(e?.message||e).slice(0,180));}
}
// Thrown when a write matches no row because another owner now holds the job. The result is discarded.
class LostOwnership extends Error{memeId:string;token:string;constructor(memeId:string,token:string){super(`Lost ownership of meme ${memeId}; this attempt's result was discarded.`);this.name="LostOwnership";this.memeId=memeId;this.token=token;}}
function withTimeout<T>(p:Promise<T>,ms:number,label:string):Promise<T>{let t:any;return Promise.race([p,new Promise<T>((_,rej)=>{t=setTimeout(()=>rej(new Error(`${label} timed out after ${Math.round(ms/1000)} s.`)),ms);})]).finally(()=>clearTimeout(t));}
function memeFilter(ctx:Ctx,id:string,token?:string|null){return `?id=eq.${encodeURIComponent(id)}&${userFilter(ctx)}${token?`&processing_token=eq.${encodeURIComponent(token)}`:""}`;}
// Compare-and-set write. With a token, the row must still be owned by that token or the write is rejected.
async function memeWrite(env:Env,ctx:Ctx,id:string,token:string|null,patch:any){
  const rows=await db(env,"memes",memeFilter(ctx,id,token),{method:"PATCH",body:JSON.stringify(patch)});
  if(token&&!rows?.length)throw new LostOwnership(id,token);
  return rows;
}
// Heartbeat: extend our own lease before each long step, so recovery never treats live work as stale.
async function renewLease(env:Env,ctx:Ctx,id:string,token:string){
  await memeWrite(env,ctx,id,token,L.renewPatch(Date.now()));
}

async function renderReelForMeme(env:Env,meme:any,token:string|null){
  const ctx:Ctx={userId:meme.owner_id,token:""};
  const nowMs=Date.now();
  // Choose the output format once, at generation: about 30% Reels, 70% photo posts.
  if(!meme.output_format){
    const fmt=Math.random()<0.3?"reel":"photo";
    await memeWrite(env,ctx,meme.id,token,{output_format:fmt});
    meme.output_format=fmt;
  }
  // A render was already dispatched (or is waiting on its watchdog): don't start another.
  if(meme.reel_render_next_retry_at&&new Date(meme.reel_render_next_retry_at).getTime()>nowMs)return {status:"rendering_on_github"};
  if(!env.GITHUB_TOKEN||!env.GITHUB_REPO){await memeWrite(env,ctx,meme.id,token,{reel_status:"renderer_not_configured",reel_render_locked_until:null});return {status:"renderer_not_configured"};}
  // Every dispatch counts as an attempt. Once the limit is reached the job is failed, not re-dispatched.
  if(L.shouldFailRender(meme))return {status:"attempts_exhausted"};
  const songs=await db(env,"song_library",`?${userFilter(ctx)}&is_active=eq.true&select=*&order=times_used.asc,last_used_at.asc.nullsfirst&limit=100`);
  const minUses=songs.length?Math.min(...songs.map((s:any)=>Number(s.times_used||0))):null;
  const leastUsed=songs.length?songs.filter((s:any)=>Number(s.times_used||0)===minUses):[];
  const song=leastUsed.length?leastUsed[Math.floor(Math.random()*leastUsed.length)]:null;
  const songUrl=song?await signedSongUrl(env,song.storage_path):null;
  const settings=await db(env,"user_settings",`?${userFilter(ctx)}&select=video_freeze_seconds`);
  const freeze=Math.max(0,Math.min(5,Number(settings[0]?.video_freeze_seconds??2)));
  const dispatch=await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/render-meme.yml/dispatches`,{method:"POST",headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"memeos-worker","Content-Type":"application/json"},body:JSON.stringify({ref:"main",inputs:{meme_id:String(meme.id),owner_id:String(ctx.userId),text:String(meme.extracted_text||"").slice(0,3000),freeze_seconds:String(freeze),song_id:song?.id||"",attempt_token:String(token||"")}})});
  if(!dispatch.ok){const detail=(await dispatch.text()).slice(0,200);throw new Error(`GitHub render dispatch failed (${dispatch.status}): ${detail}`);}
  if(song)await db(env,"song_library",`?id=eq.${song.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({times_used:Number(song.times_used||0)+1,last_used_at:new Date().toISOString()})});
  // The renderer writes the final result, matched on this token. Until then the job stays out of the queue.
  await memeWrite(env,ctx,meme.id,token,{reel_status:"rendering",reel_song_id:song?.id||null,reel_render_locked_until:null,reel_render_next_retry_at:new Date(nowMs+L.DEFAULTS.renderWatchdogMs).toISOString(),processing_error:null,...L.renderDispatchPatch(meme,nowMs)});
  LOG("render_dispatched",{meme_id:meme.id,attempt:Number(meme.processing_attempts||0)+1,worker_id:token,song_id:song?.id||null});
  return {status:"dispatched"};
}

// Text fingerprint: SHA-256 of the normalised text. Must match the backfill in migration 0011.
async function textFingerprint(text:string):Promise<string|null>{
  const norm=String(text||"").normalize("NFC").trim().replace(/\s+/g," ").toLowerCase();
  if(!norm)return null;
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(norm));
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
// Returns the id of an earlier meme (any time, any status) with the same text, or null when the text is new.
// A new text is recorded so later memes are checked against it.
async function findDuplicateText(env:Env,ctx:Ctx,memeId:string,text:string):Promise<string|null>{
  const fp=await textFingerprint(text);
  if(!fp)return null;
  const base=`owner_id=eq.${encodeURIComponent(ctx.userId)}`;
  // If this meme's text was edited, forget its old fingerprint.
  await db(env,"meme_text_fingerprints",`?${base}&meme_id=eq.${encodeURIComponent(memeId)}&fingerprint=neq.${fp}`,{method:"DELETE"});
  const existing=await db(env,"meme_text_fingerprints",`?${base}&fingerprint=eq.${fp}&select=meme_id`);
  if(existing?.length)return existing[0].meme_id===memeId?null:existing[0].meme_id;
  try{
    await db(env,"meme_text_fingerprints","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,fingerprint:fp,meme_id:memeId})});
    return null;
  }catch(e:any){
    // Another worker recorded the same text at the same moment: re-read and decide.
    const again=await db(env,"meme_text_fingerprints",`?${base}&fingerprint=eq.${fp}&select=meme_id`);
    if(again?.length&&again[0].meme_id!==memeId)return again[0].meme_id;
    return null;
  }
}

async function processMemeInBackground(env:Env,meme:any,token:string){
  const ctx:Ctx={userId:meme.owner_id,token:""};
  const timeoutMs=L.DEFAULTS.attemptTimeoutMs;
  let current=meme;
  if(current.processing_status==="needs_ocr"){
    const sourceUrl=current.source_asset_url||current.asset_url;
    if(!sourceUrl)throw new Error("No original image is available for OCR.");
    const media=await withTimeout(fetch(sourceUrl),timeoutMs,"Original image download");
    if(!media.ok)throw new Error(`Original image download failed (${media.status}).`);
    const contentType=media.headers.get("content-type")||"image/jpeg";
    if(!contentType.startsWith("image/"))throw new Error("The discovered media is not a supported image. Video processing is a later milestone.");
    const bytes=await media.arrayBuffer();
    if(bytes.byteLength>8*1024*1024)throw new Error("Image exceeds the 8 MB OCR processing limit.");
    await renewLease(env,ctx,current.id,token);
    const started=Date.now();let providerOutcome="ok";
    let extracted="";
    try{extracted=await withTimeout(extractTextWithWorkersAI(env,bytes,contentType),timeoutMs,"OCR request");}
    catch(e:any){providerOutcome=String(e?.message||e).slice(0,200);throw e;}
    finally{LOG("ocr_request",{meme_id:current.id,worker_id:token,attempt:Number(current.processing_attempts||0)+1,duration_ms:Date.now()-started,provider:"workers_ai",provider_response:providerOutcome});}
    if(!extracted){
      await memeWrite(env,ctx,current.id,token,{processing_status:"low_confidence",classification:"needs_review",classification_reason:"No readable text was confidently extracted. Manual review required.",processing_error:null,processing_locked_until:null,processing_token:null,processing_next_retry_at:null});
      LOG("status_change",{meme_id:current.id,previous_status:"needs_ocr",new_status:"low_confidence",worker_id:token});
      return {status:"manual_review",reason:"No readable text"};
    }
    const rows=await memeWrite(env,ctx,current.id,token,{extracted_text:extracted,ocr_confidence:null,processing_status:"ocr_complete",classification:"needs_review",classification_reason:"Server-side OCR completed. OCR confidence is not provided by the vision model; verify the transcription before approval.",processing_error:null,processing_consecutive_errors:0,processing_same_error_count:0,processing_last_error_key:null,processing_next_retry_at:null});
    LOG("status_change",{meme_id:current.id,previous_status:"needs_ocr",new_status:"ocr_complete",worker_id:token,database_update:"ok"});
    current=rows?.[0]||{...current,extracted_text:extracted,processing_status:"ocr_complete"};
  }
  if(current.processing_status==="ocr_complete"){
    if(!current.extracted_text?.trim())throw new Error("OCR produced no text to classify.");
    // Duplicate check against every earlier text: a repeat is rejected before any classification or rendering.
    const duplicateOf=await findDuplicateText(env,ctx,current.id,current.extracted_text);
    if(duplicateOf){
      await memeWrite(env,ctx,current.id,token,{processing_status:"rejected",classification:"rejected",classification_reason:"Duplicate: this text already appears in an earlier meme.",processing_error:null,processing_locked_until:null,processing_token:null,processing_next_retry_at:null});
      LOG("duplicate_text_rejected",{meme_id:current.id,duplicate_of:duplicateOf,worker_id:token});
      return {status:"duplicate"};
    }
    await renewLease(env,ctx,current.id,token);
    const started=Date.now();
    const classification=await withTimeout(classifyTextWithGroq(env,ctx,current.extracted_text),timeoutMs,"Classification request");
    LOG("classify_request",{meme_id:current.id,worker_id:token,duration_ms:Date.now()-started,provider:"groq"});
    const next=classification.suitable?"ready_for_asset":"rejected";
    const rows=await memeWrite(env,ctx,current.id,token,{classification:classification.suitable?"suitable":"rejected",classification_reason:classification.reason,processing_status:next,processing_error:null,processing_consecutive_errors:0,processing_same_error_count:0,processing_last_error_key:null,processing_next_retry_at:null});
    LOG("status_change",{meme_id:current.id,previous_status:"ocr_complete",new_status:next,worker_id:token});
    current=rows?.[0]||{...current,classification:classification.suitable?"suitable":"rejected",processing_status:next};
  }
  if(current.processing_status==="ready_for_asset"){
    const text=String(current.extracted_text||"").trim();
    if(!text)throw new Error("Cannot generate BRAT assets without extracted text.");
    await renewLease(env,ctx,current.id,token);
    const reel:any=await renderReelForMeme(env,{...current,owner_id:ctx.userId,extracted_text:text},token);
    if(reel.status==="attempts_exhausted")return {status:"attempts_exhausted"};
    if(reel.status==="dispatched"||reel.status==="rendering_on_github")return {status:"rendering_on_github"};
    if(reel.status==="renderer_not_configured"){await memeWrite(env,ctx,current.id,token,{processing_locked_until:null,processing_token:null});return {status:"waiting_for_renderer"};}
    return {status:"generated"};
  }
  await memeWrite(env,ctx,current.id,token,{processing_locked_until:null,processing_token:null});
  return {status:current.processing_status};
}

async function runBackgroundProcessing(env:Env){
  const nowIso=new Date().toISOString();
  const pending=await db(env,"memes",`?processing_status=in.(needs_ocr,ocr_complete,ready_for_asset)&or=(processing_next_retry_at.is.null,processing_next_retry_at.lte.${encodeURIComponent(nowIso)})&or=(processing_locked_until.is.null,processing_locked_until.lte.${encodeURIComponent(nowIso)})&classification=neq.low_confidence&select=*&order=created_at.asc&limit=25`);
  const summaries=new Map<string,Record<string,number>>();
  const tally=(ownerId:string,outcome:string)=>{const row=summaries.get(ownerId)||{};row[outcome]=(row[outcome]||0)+1;summaries.set(ownerId,row);};
  let processed=0;
  // Keep working through the queue within this tick (about 45 s), so the next item starts as soon as the last one finishes.
  const tickStart=Date.now();
  for(const meme of pending){
    if(Date.now()-tickStart>45000)break;
    const ctx:Ctx={userId:meme.owner_id,token:""};
    const settings=await db(env,"user_settings",`?${userFilter(ctx)}&select=global_paused,auto_process_enabled,discovery_interval_minutes`);
    if(settings[0]?.global_paused||settings[0]?.auto_process_enabled===false)continue;
    // Stale-lease recovery: a lease that expired without renewal means the worker died mid-attempt.
    // That attempt is counted and the job goes to retry_wait, so it cannot loop without limit.
    const stale=L.staleRecovery(meme,Date.now());
    if(stale&&meme.processing_token){
      const {_terminal,_attempt,...patch}=stale;
      const rows=await db(env,"memes",memeFilter(ctx,meme.id,meme.processing_token),{method:"PATCH",body:JSON.stringify({...patch,...(_terminal?{processing_failed_at:nowIso}:{})})});
      LOG("stale_lease_recovered",{meme_id:meme.id,previous_status:meme.processing_status,new_status:_terminal?"discarded":"retry_wait",worker_id:meme.processing_token,attempt:_attempt,lease_expires_at:meme.processing_locked_until,reason:"lease expired without renewal",database_update:rows?.length?"ok":"no_match"});
      continue;
    }
    if(!L.canClaim(meme,Date.now()))continue;
    const token=crypto.randomUUID();
    // Compare-and-set claim: matches only if the status is unchanged and no live lease or retry is pending.
    const claim=await db(env,"memes",`?id=eq.${meme.id}&owner_id=eq.${meme.owner_id}&processing_status=eq.${meme.processing_status}&or=(processing_locked_until.is.null,processing_locked_until.lte.${encodeURIComponent(nowIso)})&or=(processing_next_retry_at.is.null,processing_next_retry_at.lte.${encodeURIComponent(nowIso)})`,{method:"PATCH",body:JSON.stringify(L.claimPatch(Date.now(),token))});
    if(!claim?.length)continue;
    processed++;
    const row={...meme,...claim[0]};
    LOG("claimed",{meme_id:meme.id,previous_status:meme.processing_status,new_status:meme.processing_status,worker_id:token,attempt:Number(row.processing_attempts||0)+1,lease_expires_at:claim[0].processing_locked_until,reason:"claim"});
    try{
      const result:any=await processMemeInBackground(env,row,token);
      if(result.status==="attempts_exhausted"){
        await memeWrite(env,ctx,meme.id,token,{processing_status:"discarded",reel_status:"discarded",processing_locked_until:null,processing_token:null,processing_next_retry_at:null,reel_render_next_retry_at:null,reel_render_locked_until:null,processing_failed_at:new Date().toISOString(),processing_error:`Automatically discarded after 3 identical consecutive errors or 5 consecutive errors. The record and media are kept.`});
        LOG("status_change",{meme_id:meme.id,previous_status:meme.processing_status,new_status:"discarded",worker_id:token,attempt:Number(row.processing_attempts||0),reason:"max attempts exhausted"});
        tally(ctx.userId,"discarded");
      }else{
        tally(ctx.userId,String(result.status||"processed"));
        LOG("attempt_end",{meme_id:meme.id,worker_id:token,result:result.status});
      }
    }catch(e:any){
      if(e instanceof LostOwnership){LOG("lost_ownership_discarded",{meme_id:meme.id,worker_id:token,reason:e.message});continue;}
      const out=L.failureOutcome(row,e?.message||e,Date.now());
      const {_terminal,_attempt,...patch}=out;
      if(_terminal)patch.processing_failed_at=new Date().toISOString();
      let dbResult="ok";
      try{await memeWrite(env,ctx,meme.id,token,patch);}
      catch(writeErr:any){dbResult=writeErr instanceof LostOwnership?"lost_ownership":String(writeErr?.message||writeErr).slice(0,200);}
      LOG("attempt_failed",{meme_id:meme.id,previous_status:meme.processing_status,new_status:_terminal?"discarded":"retry_wait",worker_id:token,attempt:_attempt,reason:String(e?.message||e).slice(0,200),database_update:dbResult});
      tally(ctx.userId,_terminal?"discarded":"retry_wait");
    }
  }
  for(const [ownerId,outcomes] of summaries){
    for(const [outcome,count] of Object.entries(outcomes)){
      await logMajorActivity(env,ownerId,"processing_batch",`${count} memes: ${outcome.replace(/_/g," ")}.`,count,{outcome});
    }
  }
}

async function runWaitingReels(env:Env){
  const nowIso=new Date().toISOString();
  // Watchdog: a dispatched render that never reported back is a failed attempt, counted and retried with backoff.
  const stuck=await db(env,"memes",`?processing_status=in.(ready_for_asset,generated)&classification=neq.low_confidence&reel_status=eq.rendering&reel_render_next_retry_at=lte.${encodeURIComponent(nowIso)}&select=*&limit=3`);
  for(const m of stuck){
    const ctx:Ctx={userId:m.owner_id,token:""};
    const msg="The GitHub render did not report back within 30 minutes.";
    const {_terminal,_attempt,...patch}=L.failureOutcome(m,msg,Date.now());
    const body:any={...patch,reel_status:_terminal?"discarded":"render_failed",reel_render_next_retry_at:_terminal?null:patch.processing_next_retry_at,reel_render_locked_until:null,processing_error:msg,...(_terminal?{processing_status:"discarded",processing_failed_at:nowIso}:{})};
    const rows=await db(env,"memes",`?id=eq.${encodeURIComponent(m.id)}&${userFilter(ctx)}&processing_status=in.(ready_for_asset,generated)&classification=neq.low_confidence&reel_status=eq.rendering`,{method:"PATCH",body:JSON.stringify(body)});
    LOG("render_watchdog_expired",{meme_id:m.id,previous_status:m.processing_status,new_status:_terminal?"discarded":"retry_wait",attempt:_attempt,reason:msg,database_update:rows?.length?"ok":"no_match"});
  }
  const sel="&select=id,owner_id,extracted_text,reel_asset_url,reel_song_id,reel_status,processing_status,processing_attempts,processing_consecutive_errors,processing_same_error_count,processing_last_error_key,processing_token,output_format,reel_render_next_retry_at&order=created_at.asc&limit=10";
  const auto=await db(env,"memes",`?processing_status=in.(ready_for_asset,generated)&classification=neq.low_confidence&reel_status=in.(renderer_not_configured,render_requested)&or=(reel_render_next_retry_at.is.null,reel_render_next_retry_at.lte.${encodeURIComponent(nowIso)})${sel}`);
  const manual=await db(env,"memes",`?processing_status=in.(ready_for_asset,generated)&classification=neq.low_confidence&reel_status=eq.render_failed&reel_render_next_retry_at=lte.${encodeURIComponent(nowIso)}${sel}`);
  const pending=[...auto,...manual].slice(0,10);
  for(const meme of pending){
    const ctx:Ctx={userId:meme.owner_id,token:""};
    const settings=await db(env,"user_settings",`?${userFilter(ctx)}&select=global_paused,auto_process_enabled`);
    if(settings[0]?.global_paused||settings[0]?.auto_process_enabled===false)continue;
    const leaseToken=crypto.randomUUID();
    const lease=await db(env,"memes",`?id=eq.${meme.id}&${userFilter(ctx)}&processing_status=in.(ready_for_asset,generated)&classification=neq.low_confidence&reel_status=eq.${meme.reel_status}&or=(reel_render_locked_until.is.null,reel_render_locked_until.lte.${encodeURIComponent(nowIso)})`,{method:"PATCH",body:JSON.stringify({reel_render_locked_until:new Date(Date.now()+L.leaseMs()).toISOString(),processing_token:leaseToken})});
    if(!lease?.length)continue;
    try{
      const result:any=await renderReelForMeme(env,meme,leaseToken);
      const patch:any={reel_render_locked_until:null};
      if(result.status==="attempts_exhausted"){patch.processing_status="discarded";patch.reel_status="discarded";patch.processing_failed_at=nowIso;patch.processing_token=null;patch.processing_error=`Automatically discarded after 3 identical consecutive errors or 5 consecutive errors. The record and media are kept.`;}
      else if(result.status==="renderer_not_configured"){patch.processing_token=null;}
      await memeWrite(env,ctx,meme.id,leaseToken,patch);
    }catch(e:any){
      if(e instanceof LostOwnership){LOG("lost_ownership_discarded",{meme_id:meme.id,reason:e.message});continue;}
      const out=L.failureOutcome(meme,e?.message||e,Date.now());
      const {_terminal,_attempt,...p}=out;
      await memeWrite(env,ctx,meme.id,leaseToken,{...p,reel_status:_terminal?"discarded":"render_failed",reel_render_next_retry_at:_terminal?null:p.processing_next_retry_at,reel_render_locked_until:null,...(_terminal?{processing_status:"discarded",processing_failed_at:nowIso}:{})}).catch(()=>{});
      LOG("render_dispatch_failed",{meme_id:meme.id,attempt:_attempt,new_status:_terminal?"discarded":"retry_wait",reason:String(e?.message||e).slice(0,200)});
    }
  }
}

const DEFAULT_APIFY_ACTOR = "apify/instagram-scraper";
const SCRAPE_BATCH=10000;
const SCRAPE_BACKFILL_THRESHOLD=5;

async function startApifyDiscoveryForSource(env:Env,ctx:Ctx,source:any,credentials:any[],scheduled=false){
  let lastError="No Apify key could start the run.";
  for(const credential of credentials){
    if(credential.enabled===false||credential.auto_disabled_reason&&credential.auto_disabled_until&&Date.parse(credential.auto_disabled_until)>Date.now())continue;
    try{
      const secret=await decryptSecret(env,credential);
      const actor=encodeURIComponent((credential.actor_id||DEFAULT_APIFY_ACTOR).replace("/","~"));
      // Incremental scan starts at this source's last successfully completed scrape.
      // A large per-profile cap lets us accurately decide whether a historical
      // backfill is needed instead of mistaking a capped result set for <5 posts.
      const input=buildActorInput(credential.actor_input,[source.username],credential.actor_id||DEFAULT_APIFY_ACTOR,SCRAPE_BATCH,source.last_scraped_at||null);
      const response=await fetch(`https://api.apify.com/v2/acts/${actor}/runs?waitForFinish=0`,{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify(input)});
      const result:any=await response.json().catch(()=>({}));
      if(!response.ok){
        lastError=result.error?.message||`Apify returned ${response.status}.`;
        const balanceError=isApifyMonthlyLimitError(lastError);
        const failedAt=new Date().toISOString();
        if(balanceError)await disableApifyKeyUntilCycleEnds(env,ctx,credential,secret,lastError);
        else if(response.status===401||response.status===403)await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"error",cooldown_until:null,last_used_at:failedAt})});
        else if(response.status===429)await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"rate_limited",cooldown_until:new Date(Date.now()+5*60*1000).toISOString(),last_used_at:failedAt})});
        continue;
      }
      await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({last_used_at:new Date().toISOString(),status:"connected",cooldown_until:null})});
      const job=await db(env,"jobs","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,job_type:"discovery",status:"running",provider_run_id:result.data?.id,attempt_count:0,max_attempts:5,metadata:{dataset_id:result.data?.defaultDatasetId,credential_id:credential.id,actor_id:credential.actor_id,source_usernames:[source.username],source_reference_account_id:source.id,scheduled,last_successful_scrape_at:source.last_scraped_at||null}})});
      if(!job?.[0]?.id)throw new Error("Apify started, but MemeOS could not save the discovery job.");
      return job[0];
    }catch(e:any){lastError=e?.message||lastError;}
  }
  throw new Error(`@${source.username}: ${lastError}`);
}
function buildActorInput(template:any,usernames:string[],actorId=DEFAULT_APIFY_ACTOR,limit=SCRAPE_BATCH,newerThan?:string|null,olderThan?:string|null){
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
  result.resultsLimit=limit;
  if(newerThan){
    // Apify accepts UTC timestamps ending in Z, but Postgres/Supabase may
    // return timezone offsets such as +00:00, which its input validator rejects.
    const parsed=new Date(newerThan);
    if(!Number.isNaN(parsed.getTime()))result.onlyPostsNewerThan=parsed.toISOString().replace(/\.\d{3}Z$/,"Z");
  }
  if(olderThan){
    const parsed=new Date(olderThan);
    if(!Number.isNaN(parsed.getTime())){
      delete result.onlyPostsNewerThan;
      // The official apify/instagram-scraper actor exposes onlyPostsNewerThan,
      // not onlyPostsOlderThan. For it, fetch the maximum timeline and enforce
      // the historical cutoff against each returned post during import.
      if(actorId!==DEFAULT_APIFY_ACTOR)result.onlyPostsOlderThan=parsed.toISOString().replace(/\.\d{3}Z$/,"Z");
      else delete result.onlyPostsOlderThan;
    }
  }
  return result;
}

async function syncMetaAnalyticsForHistory(env:Env,history:any){
  const ctx:Ctx={userId:history.owner_id,token:""};
  const rows=await db(env,"publishing_history",`?id=eq.${history.id}&${userFilter(ctx)}&select=*,instagram_accounts(*)`);
  const item=rows?.[0];const account=item?.instagram_accounts;
  if(!item?.meta_media_id||!account?.meta_access_token_enc||!account?.meta_access_token_iv)throw new Error("Published media or connected Meta token is unavailable.");
  const token=await decryptSecret(env,{encrypted_secret:account.meta_access_token_enc,encryption_iv:account.meta_access_token_iv});
  const version=env.META_GRAPH_VERSION||"v27.0";
  const media=await graphRequest(version,`${encodeURIComponent(item.meta_media_id)}?fields=id,like_count,comments_count,media_type,media_product_type,timestamp,permalink&access_token=${encodeURIComponent(token)}`,undefined,account.meta_api_host||"graph.instagram.com");
  const today=new Date().toISOString().slice(0,10);
  const metrics:any={likes:media.like_count,comments:media.comments_count};
  const insightMetrics=["reach","views","saved","shares","total_interactions"];
  try{
    const all=await graphRequest(version,`${encodeURIComponent(item.meta_media_id)}/insights?metric=${insightMetrics.join(",")}&access_token=${encodeURIComponent(token)}`,undefined,account.meta_api_host||"graph.instagram.com");
    for(const entry of all.data||[]){const key=entry.name==="saved"?"saves":entry.name;const value=entry.values?.[0]?.value??entry.total_value?.value;if(typeof value==="number")metrics[key]=value;}
  }catch{
    // Metric support varies by media type and account. Retry individually so one
    // unsupported metric does not suppress other values that Meta does provide.
    for(const metric of insightMetrics){try{const one=await graphRequest(version,`${encodeURIComponent(item.meta_media_id)}/insights?metric=${metric}&access_token=${encodeURIComponent(token)}`,undefined,account.meta_api_host||"graph.instagram.com");const entry=(one.data||[])[0];const value=entry?.values?.[0]?.value??entry?.total_value?.value;if(typeof value==="number")metrics[metric==="saved"?"saves":metric]=value;}catch{}}
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

async function refreshCredentialUsage(env:Env,ctx:Ctx,row:any){
  const refreshedAt=new Date().toISOString();
  const secret=await decryptSecret(env,row);
  let snapshot:any;
  if(row.provider==="apify"){
    const response=await fetch("https://api.apify.com/v2/users/me/limits",{headers:{Authorization:`Bearer ${secret}`}});
    const data:any=await response.json().catch(()=>({}));
    if(!response.ok){await db(env,"api_credentials",`?id=eq.${row.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:credentialFailureStatus(response.status,row.status),cooldown_until:response.status===429?new Date(Date.now()+5*60*1000).toISOString():null,last_used_at:refreshedAt})});throw new Error(data.error?.message||`Apify usage lookup failed (${response.status}).`);}
    const d=data.data||{};
    const used=Number(d.current?.monthlyUsageUsd),limit=Number(d.limits?.maxMonthlyUsageUsd);
    const cycleEnd=d.monthlyUsageCycle?.endAt||null;
    const exhausted=Number.isFinite(used)&&Number.isFinite(limit)&&limit>=0&&used>=limit;
    const previousCycleEnd=row.usage_snapshot?.usage?.cycle_end||null;
    const cycleRolled=!!(previousCycleEnd&&cycleEnd&&previousCycleEnd!==cycleEnd&&Date.parse(cycleEnd)>Date.now());
    const shouldReenable=row.auto_disabled_reason&&cycleRolled&&!exhausted;
    snapshot={provider:"apify",refreshed_at:refreshedAt,usage:{used_usd:d.current?.monthlyUsageUsd??null,limit_usd:d.limits?.maxMonthlyUsageUsd??null,used_compute_units:d.current?.monthlyActorComputeUnits??null,limit_compute_units:d.limits?.maxMonthlyActorComputeUnits??null,cycle_start:d.monthlyUsageCycle?.startAt??null,cycle_end:cycleEnd},limit_reached:exhausted};
    if(exhausted){
      await db(env,"api_credentials",`?id=eq.${row.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({enabled:false,status:"limit_reached",auto_disabled_reason:"apify_monthly_limit",auto_disabled_until:cycleEnd,usage_snapshot:snapshot,usage_refreshed_at:refreshedAt,last_used_at:refreshedAt,cooldown_until:null})});
      return snapshot;
    }
    if(shouldReenable){
      await db(env,"api_credentials",`?id=eq.${row.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({enabled:true,status:"connected",auto_disabled_reason:null,auto_disabled_until:null,usage_snapshot:snapshot,usage_refreshed_at:refreshedAt,last_used_at:refreshedAt,cooldown_until:null})});
      return snapshot;
    }
  }else if(row.provider==="groq"){
    // Rate-limit headers are returned on inference responses, not reliably by /models.
    const response=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify({model:"openai/gpt-oss-20b",messages:[{role:"user",content:"Reply with OK."}],max_completion_tokens:1,temperature:0})});
    const h=response.headers;
    const numberHeader=(name:string)=>{const value=h.get(name);if(value===null)return null;const n=Number(value);return Number.isFinite(n)?n:null;};
    const limited=response.status===429||numberHeader("x-ratelimit-remaining-requests")===0||numberHeader("x-ratelimit-remaining-tokens")===0;
    if(response.status===401||response.status===403){await db(env,"api_credentials",`?id=eq.${row.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"error",cooldown_until:null,last_used_at:refreshedAt})});throw new Error("Groq rejected this API key. Check it in API Manager.");}if(!response.ok&&response.status!==429)throw new Error(`Groq usage check failed (${response.status}): ${(await response.text()).slice(0,180)}`);
    snapshot={provider:"groq",refreshed_at:refreshedAt,rate_limited:limited,request_limit:numberHeader("x-ratelimit-limit-requests"),request_remaining:numberHeader("x-ratelimit-remaining-requests"),request_reset:h.get("x-ratelimit-reset-requests"),token_limit:numberHeader("x-ratelimit-limit-tokens"),token_remaining:numberHeader("x-ratelimit-remaining-tokens"),token_reset:h.get("x-ratelimit-reset-tokens"),retry_after:h.get("retry-after"),http_status:response.status};
  }else return null;
  const limited=row.provider==="groq"&&snapshot.rate_limited;
  const retryAfter=Number(snapshot.retry_after);
  await db(env,"api_credentials",`?id=eq.${row.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({usage_snapshot:snapshot,usage_refreshed_at:refreshedAt,status:limited?"rate_limited":"connected",cooldown_until:limited?new Date(Date.now()+(Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:60000)).toISOString():null,last_used_at:refreshedAt})});
  return snapshot;
}
async function refreshAllCredentialUsage(env:Env,ctx:Ctx){
  const credentials=await db(env,"api_credentials",`?${userFilter(ctx)}&enabled=eq.true&select=*`);
  for(const credential of credentials){try{await refreshCredentialUsage(env,ctx,credential);}catch(error:any){console.error("Credential usage refresh failed",credential.provider,credential.label,String(error?.message||error));}}
}
async function refreshDueApifyKeys(env:Env,ctx:Ctx){
  const now=new Date().toISOString();
  const credentials=await db(env,"api_credentials",`?${userFilter(ctx)}&provider=eq.apify&enabled=eq.false&auto_disabled_reason=not.is.null&auto_disabled_until=lte.${encodeURIComponent(now)}&select=*`);
  for(const credential of credentials){try{await refreshCredentialUsage(env,ctx,credential);}catch(error:any){console.error("Apify cycle reset check failed",credential.label,String(error?.message||error));}}
}

async function runScheduledDiscovery(env:Env){
  const active=await db(env,"instagram_accounts","?discovery_enabled=eq.true&select=owner_id");
  const owners=[...new Set(active.map((a:any)=>a.owner_id))].slice(0,1);const now=Date.now();
  for(const ownerId of owners){
    const ctx:Ctx={userId:ownerId,token:""};
    const settingsRows=await db(env,"user_settings",`?${userFilter(ctx)}&select=global_paused,discovery_interval_minutes,last_discovery_started_at,last_usage_refresh_date`);
    await refreshDueApifyKeys(env,ctx);
    const settings=settingsRows[0]||{};
    const indiaDate=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    if(settings.last_usage_refresh_date!==indiaDate){
      await refreshAllCredentialUsage(env,ctx);
      if(settingsRows.length)await db(env,"user_settings",`?${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({last_usage_refresh_date:indiaDate})});
      else {await db(env,"user_settings","",{method:"POST",body:JSON.stringify({owner_id:ownerId,discovery_interval_minutes:60,last_usage_refresh_date:indiaDate})});settingsRows.push({last_usage_refresh_date:indiaDate});}
    }
    if(settings.global_paused)continue;
    const interval=Math.max(15,Number(settings.discovery_interval_minutes||60));
    if(settings.last_discovery_started_at&&now-new Date(settings.last_discovery_started_at).getTime()<interval*60000)continue;
    const accounts=await db(env,"instagram_accounts",`?${userFilter(ctx)}&discovery_enabled=eq.true&select=id`);if(!accounts.length)continue;
    const mappings=await db(env,"destination_sources",`?${userFilter(ctx)}&select=destination_account_id,reference_account_id`);
    const allowed=new Set<string>();let all=false;for(const a of accounts){const own=mappings.filter((m:any)=>m.destination_account_id===a.id);if(!own.length)all=true;for(const m of own)allowed.add(m.reference_account_id);}
    const sources=await db(env,"reference_accounts",`?${userFilter(ctx)}&enabled=eq.true&select=id,username,scraped_offset,last_scraped_at`);
    const selected=all?sources:sources.filter((s:any)=>allowed.has(s.id));if(!selected.length)continue;
    const creds=await db(env,"api_credentials",`?${userFilter(ctx)}&provider=eq.apify&enabled=eq.true&or=(cooldown_until.is.null,cooldown_until.lte.${encodeURIComponent(new Date().toISOString())})&status=neq.error&select=*&order=last_used_at.asc.nullsfirst,created_at.asc`);if(!creds.length)continue;
    const lockUntil=new Date(Date.now()+10*60*1000).toISOString();
    if(settingsRows.length){const lock=await db(env,"user_settings",`?${userFilter(ctx)}&or=(discovery_lock_until.is.null,discovery_lock_until.lte.${encodeURIComponent(new Date().toISOString())})`,{method:"PATCH",body:JSON.stringify({discovery_lock_until:lockUntil})});if(!lock?.length)continue;}else{try{await db(env,"user_settings","",{method:"POST",body:JSON.stringify({owner_id:ownerId,discovery_interval_minutes:60,discovery_lock_until:lockUntil})});}catch{continue;}}
    let startedCount=0;
    for(const source of selected){try{await startApifyDiscoveryForSource(env,ctx,source,creds,true);startedCount++;}catch(e:any){console.error("Scheduled discovery start failed",source.username,String(e?.message||e));}}
    if(settingsRows.length)await db(env,"user_settings",`?${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({last_discovery_started_at:startedCount?new Date().toISOString():settings.last_discovery_started_at,discovery_lock_until:null})});else await db(env,"user_settings","",{method:"POST",body:JSON.stringify({owner_id:ownerId,last_discovery_started_at:startedCount?new Date().toISOString():null,discovery_interval_minutes:60,discovery_lock_until:null})});
  }
}

// Validates a Meta System User Access Token and binds its Instagram asset to one destination.
async function connectMetaSystemUserToken(env: Env, ctx: Ctx, accountId: string, accessToken: string, suppliedInstagramId?: string) {
  if (!env.META_APP_ID || !env.META_APP_SECRET) throw new Error("META_APP_ID and META_APP_SECRET must be configured as Worker variables/secrets.");
  if (accessToken.length < 40 || accessToken.length > 5000) throw new Error("That does not look like a valid Meta access token.");
  const version = env.META_GRAPH_VERSION || "v27.0";
  const appAccessToken = env.META_APP_ID + "|" + env.META_APP_SECRET;
  const debugUrl = new URL("https://graph.facebook.com/" + version + "/debug_token");
  debugUrl.searchParams.set("input_token", accessToken);
  debugUrl.searchParams.set("access_token", appAccessToken);
  const debugRes = await fetch(debugUrl.toString());
  const debugBody: any = await debugRes.json().catch(() => ({}));
  const debug = debugBody.data || {};
  if (!debugRes.ok || !debug.is_valid) throw new Error(debugBody.error?.message || "Meta says this token is invalid or revoked.");
  if (debug.app_id && String(debug.app_id) !== String(env.META_APP_ID)) throw new Error("This token belongs to a different Meta app. Generate it from the app configured for BRATLOOP.");
  const scopes: string[] = Array.isArray(debug.scopes) ? debug.scopes : [];
  const hasBasic = scopes.includes("instagram_basic");
  const hasPublish = scopes.includes("instagram_content_publish");
  if (!hasBasic || !hasPublish) throw new Error("This token is missing Instagram permissions. Enable instagram_basic and instagram_content_publish in your Meta configuration, then generate a new token.");
  const candidates = new Set<string>();
  for (const grant of (Array.isArray(debug.granular_scopes) ? debug.granular_scopes : [])) {
    if (String(grant.scope || "").startsWith("instagram_")) {
      for (const id of (Array.isArray(grant.target_ids) ? grant.target_ids : [])) candidates.add(String(id));
    }
  }
  if (suppliedInstagramId && /^\d{5,30}$/.test(suppliedInstagramId)) candidates.add(suppliedInstagramId);
  if (!candidates.size) throw new Error("Meta validated the token but did not expose an Instagram asset ID. Enter the Instagram Account ID from your Meta Business portfolio and try again.");
  const accountRows = await db(env, "instagram_accounts", "?id=eq." + encodeURIComponent(accountId) + "&" + userFilter(ctx) + "&select=id,username");
  const destination = accountRows?.[0];
  if (!destination) throw new Error("Destination account not found.");
  let selected: any = null;
  let lastAssetError = "";
  for (const candidate of candidates) {
    // Business Portfolio Instagram asset IDs are not always the same as the IG User ID.
    // Resolve the asset using the documented IG Business Asset fields, then store ig_user_id
    // because publishing endpoints require the Instagram User ID.
    const assetUrl = new URL("https://graph.facebook.com/" + version + "/" + encodeURIComponent(candidate));
    assetUrl.searchParams.set("fields", "id,ig_user_id,ig_username");
    assetUrl.searchParams.set("access_token", accessToken);
    const assetRes = await fetch(assetUrl.toString());
    const asset: any = await assetRes.json().catch(() => ({}));
    const expectedUsername = String(destination.username).replace(/^@/, "").toLowerCase();

    // A Business Portfolio asset exposes ig_user_id/ig_username. Some IDs
    // supplied from Meta's account-details panel resolve directly to an IGUser,
    // which instead exposes id/username. Support both documented object shapes.
    if (assetRes.ok) {
      const assetUsername = String(asset.ig_username || "").replace(/^@/, "").toLowerCase();
      const igUserId = String(asset.ig_user_id || "");
      if (assetUsername === expectedUsername && /^\d{5,30}$/.test(igUserId)) {
        selected = {
          id: igUserId,
          username: assetUsername,
          account_type: "BUSINESS",
          profile_picture_url: null,
          business_asset_id: String(asset.id || candidate)
        };
        break;
      }
    } else {
      lastAssetError = asset.error?.message || "Meta could not read the supplied Instagram Business Asset.";
    }

    // Fallback: the supplied identifier may already be the IG User ID.
    const userUrl = new URL("https://graph.facebook.com/" + version + "/" + encodeURIComponent(candidate));
    userUrl.searchParams.set("fields", "id,username,profile_picture_url");
    userUrl.searchParams.set("access_token", accessToken);
    const userRes = await fetch(userUrl.toString());
    const user: any = await userRes.json().catch(() => ({}));
    if (userRes.ok) {
      const userUsername = String(user.username || "").replace(/^@/, "").toLowerCase();
      const userId = String(user.id || "");
      if (userUsername === expectedUsername && /^\d{5,30}$/.test(userId)) {
        selected = {
          id: userId,
          username: userUsername,
          account_type: "BUSINESS",
          profile_picture_url: user.profile_picture_url || null,
          business_asset_id: candidate
        };
        break;
      }
    } else if (user.error?.message) {
      lastAssetError = user.error.message;
    }
  }
  if (!selected) {
    throw new Error("Meta validated the token, but BRATLOOP could not resolve the supplied Business Portfolio Instagram asset to @" + destination.username + ". Make sure you entered the Instagram Business Asset ID (not the Business Portfolio ID or Page ID), and that the System User has CONTENT access. " + (lastAssetError ? "Meta API detail: " + lastAssetError : ""));
  }
  const encrypted = await encryptSecret(env, accessToken);
  const expiresAt = Number(debug.expires_at || 0) > 0 ? new Date(Number(debug.expires_at) * 1000).toISOString() : null;
  const tokenType = expiresAt ? "facebook_user" : "system_user";
  const updated = await db(env, "instagram_accounts", "?id=eq." + encodeURIComponent(accountId) + "&" + userFilter(ctx), {
    method: "PATCH",
    body: JSON.stringify({
      instagram_account_id: String(selected.id),
      meta_user_id: String(selected.id),
      username: String(selected.username).toLowerCase(),
      account_type: selected.account_type || "BUSINESS",
      profile_picture_url: selected.profile_picture_url || null,
      meta_access_token_enc: encrypted.encrypted_secret,
      meta_access_token_iv: encrypted.encryption_iv,
      meta_token_expires_at: expiresAt,
      meta_token_refreshed_at: new Date().toISOString(),
      meta_token_refresh_error: null,
      meta_token_type: tokenType,
      meta_api_host: "graph.facebook.com",
      connection_status: "connected"
    })
  });
  return { ok: true, account: updated?.[0] || { id: accountId, username: selected.username }, token_type: tokenType };
}

// Refreshes long-lived tokens that are close to expiry. Only refreshes tokens that are still valid.
async function refreshInstagramTokens(env: Env) {
  const soon = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
  const rows: any[] = await db(env, "instagram_accounts", `?meta_access_token_enc=not.is.null&meta_api_host=eq.graph.instagram.com&meta_token_expires_at=lte.${encodeURIComponent(soon)}&select=*&limit=20`);
  for (const acc of rows) {
    try {
      const token = await decryptSecret(env, { encrypted_secret: acc.meta_access_token_enc, encryption_iv: acc.meta_access_token_iv });
      if (new Date(acc.meta_token_expires_at).getTime() < Date.now()) throw new Error("The token has expired. Reconnect this account.");
      const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`);
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data.access_token) throw new Error(data.error?.message || "Refresh was refused. Reconnect this account.");
      const enc = await encryptSecret(env, data.access_token);
      await db(env, "instagram_accounts", `?id=eq.${acc.id}`, { method: "PATCH", body: JSON.stringify({ meta_access_token_enc: enc.encrypted_secret, meta_access_token_iv: enc.encryption_iv, meta_token_expires_at: new Date(Date.now() + Number(data.expires_in || 5184000) * 1000).toISOString(), meta_token_refreshed_at: new Date().toISOString(), meta_token_refresh_error: null }) });
    } catch (e: any) {
      // Never overwrite a working token with a failed result; just record the reason.
      await db(env, "instagram_accounts", `?id=eq.${acc.id}`, { method: "PATCH", body: JSON.stringify({ meta_token_refresh_error: String(e?.message || e).slice(0, 300) }) }).catch(() => {});
    }
  }
}

// Instagram Login Graph calls. Tokens are only ever sent server-side.
async function graphRequest(version: string, pathWithQuery: string, init?: RequestInit, host = "graph.instagram.com"): Promise<any> {
  const res = await fetch(`https://${host}/${version}/${pathWithQuery}`, init);
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error?.message || `Meta Graph request failed (${res.status}).`);
  return data;
}

// Publishes one approved, scheduled assignment with the official Content Publishing flow:
// create container -> wait until FINISHED -> media_publish. Failures never leave a fake "published" state.
async function publishAssignment(env: Env, item: { id: string; owner_id: string }) {
  const ctx: Ctx = { userId: item.owner_id, token: "" };
  const setAssignment = (patch: any) =>
    db(env, "account_meme_assignments", `?id=eq.${item.id}&${userFilter(ctx)}`, { method: "PATCH", body: JSON.stringify(patch) });
  const recordHistory = (row: any) =>
    db(env, "publishing_history", "", { method: "POST", body: JSON.stringify({ owner_id: item.owner_id, ...row }) }).catch(() => {});
  let assignmentRow: any = null;
  try {
    const rows: any[] = await db(env, "account_meme_assignments", `?id=eq.${item.id}&${userFilter(ctx)}&select=id,meme_id,destination_account_id,memes(id,output_format,asset_url,reel_asset_url,social_caption),instagram_accounts(id,posting_enabled,meta_user_id,meta_access_token_enc,meta_access_token_iv,meta_token_expires_at,meta_api_host,meta_token_type)`);
    assignmentRow = rows?.[0];
    if (!assignmentRow) throw new Error("Scheduled assignment no longer exists.");
    const account = assignmentRow.instagram_accounts;
    const meme = assignmentRow.memes;
    if (account?.posting_enabled === false) { await setAssignment({status:"scheduled",publishing_locked_until:null,publishing_started_at:null}); return; }
    if (!account?.meta_access_token_enc || !account?.meta_user_id) throw new Error("This account is not connected to Instagram. Reconnect it in Accounts.");
    if (account.meta_token_expires_at && new Date(account.meta_token_expires_at).getTime() < Date.now()) throw new Error("The Meta token has expired. Reconnect this account.");

    // Idempotency: never publish the same meme to the same account twice.
    const done: any[] = await db(env, "publishing_history", `?owner_id=eq.${encodeURIComponent(item.owner_id)}&meme_id=eq.${meme.id}&destination_account_id=eq.${account.id}&status=eq.published&select=id,meta_media_id,permalink&limit=1`);
    if (done?.length) { await setAssignment({ status: "published", publishing_locked_until: null }); return; }

    const isReel = meme.output_format === "reel";
    const mediaUrl = isReel ? meme.reel_asset_url : meme.asset_url;
    if (!mediaUrl) throw new Error(isReel ? "The Reel file is missing. Reprocess this meme." : "The photo file is missing. Reprocess this meme.");
    if (!isReel && !/\.jpe?g(?:[?#]|$)/i.test(mediaUrl)) {
      // Older workspace rows may still point at the legacy PNG poster. Queue a
      // fresh render and release the schedule instead of logging a doomed publish.
      await db(env, "memes", `?id=eq.${encodeURIComponent(meme.id)}&${userFilter(ctx)}`, {
        method: "PATCH",
        body: JSON.stringify({ reel_status: "render_requested", reel_render_next_retry_at: null, reel_render_locked_until: null })
      });
      await setAssignment({
        status: "approved",
        scheduled_at: null,
        publishing_locked_until: null,
        rejection_reason: "The photo asset was an older PNG. A fresh JPEG render was queued; schedule it again when rendering finishes."
      });
      return;
    }

    const token = await decryptSecret(env, { encrypted_secret: account.meta_access_token_enc, encryption_iv: account.meta_access_token_iv });
    const version = env.META_GRAPH_VERSION || "v27.0";
    const userId = encodeURIComponent(account.meta_user_id);

    const form = new URLSearchParams();
    form.set("access_token", token);
    if (isReel) { form.set("media_type", "REELS"); form.set("video_url", mediaUrl); }
    else form.set("image_url", mediaUrl);
    if (meme.social_caption) form.set("caption", String(meme.social_caption).slice(0, 80));
    const container = await graphRequest(version, `${userId}/media`, { method: "POST", body: form }, account.meta_api_host || "graph.instagram.com");
    const creationId = encodeURIComponent(container.id);

    let statusCode = "IN_PROGRESS";
    for (let attempt = 0; attempt < 24; attempt++) {
      const s = await graphRequest(version, `${creationId}?fields=status_code&access_token=${encodeURIComponent(token)}`, undefined, account.meta_api_host || "graph.instagram.com");
      statusCode = s.status_code || "IN_PROGRESS";
      if (statusCode === "FINISHED") break;
      if (statusCode === "ERROR" || statusCode === "EXPIRED") throw new Error(`Instagram rejected the media (${statusCode}).`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (statusCode !== "FINISHED") throw new Error("Instagram is still processing the media. Check Instagram before retrying to avoid a duplicate.");

    const pub = new URLSearchParams();
    pub.set("access_token", token);
    pub.set("creation_id", container.id);
    const published = await graphRequest(version, `${userId}/media_publish`, { method: "POST", body: pub }, account.meta_api_host || "graph.instagram.com");

    let permalink: string | null = null;
    try { const m = await graphRequest(version, `${encodeURIComponent(published.id)}?fields=permalink&access_token=${encodeURIComponent(token)}`, undefined, account.meta_api_host || "graph.instagram.com"); permalink = m.permalink || null; } catch {}
    const now = new Date().toISOString();
    await recordHistory({ meme_id: meme.id, destination_account_id: account.id, meta_media_id: published.id, permalink, status: "published", published_at: now });
    await setAssignment({ status: "published", publishing_locked_until: null, rejection_reason: null });
  } catch (e: any) {
    const message = String(e?.message || e).slice(0, 500);
    LOG("publish_failed", { assignment: item.id, message });
    await setAssignment({ status: "needs_review", publishing_locked_until: null, rejection_reason: message }).catch(() => {});
    if (assignmentRow) await recordHistory({ meme_id: assignmentRow.meme_id, destination_account_id: assignmentRow.destination_account_id, status: "failed", error_message: message });
  }
}

async function route(req: Request, env: Env, ctx: Ctx, url: URL): Promise<Response> {
  const p = url.pathname.replace(/^\/api/, "");
  const method = req.method;
  const body = method === "GET" || method === "DELETE" ? {} : await req.json().catch(() => ({})) as any;

  if(p==="/activity"&&method==="GET"){
    const [saved,jobs,memes,assignments,publishing]=await Promise.all([
      db(env,"activity_logs",`?${userFilter(ctx)}&select=id,event_type,message,metadata,created_at&order=created_at.desc&limit=300`),
      db(env,"jobs",`?${userFilter(ctx)}&select=id,job_type,status,created_at,started_at,completed_at,last_error&order=created_at.desc&limit=1000`),
      db(env,"memes",`?${userFilter(ctx)}&select=id,source_type,processing_status,classification,created_at&order=created_at.desc&limit=5000`),
      db(env,"account_meme_assignments",`?${userFilter(ctx)}&select=id,approval_status,status,created_at&order=created_at.desc&limit=5000`),
      db(env,"publishing_history",`?${userFilter(ctx)}&select=id,status,published_at,created_at,error_message,permalink&order=created_at.desc&limit=1000`)
    ]);
    const firstLiveLog=saved.length?Math.min(...saved.map((x:any)=>new Date(x.created_at).getTime()).filter(Number.isFinite)):Infinity;
    const historical:any[]=[];
    const dayKey=(value:string)=>new Date(value).toISOString().slice(0,10);
    const includeBeforeLive=(value:string|null|undefined)=>!!value&&new Date(value).getTime()<firstLiveLog;
    const memeDays=new Map<string,any>();
    for(const m of memes){if(!includeBeforeLive(m.created_at))continue;const key=dayKey(m.created_at);const row=memeDays.get(key)||{count:0,sources:{}};row.count++;const source=m.source_type||"unknown";row.sources[source]=(row.sources[source]||0)+1;memeDays.set(key,row);}
    for(const [day,row] of memeDays){historical.push({id:`history-memes-${day}`,event_type:"historical_intake",message:`${row.count} meme records were added to the workspace.`,metadata:{count:row.count,source_breakdown:row.sources},created_at:`${day}T23:59:59.000Z`,historical:true});}
    const assignmentDays=new Map<string,any>();
    for(const a of assignments){if(!includeBeforeLive(a.created_at))continue;const key=dayKey(a.created_at);const row=assignmentDays.get(key)||{count:0,states:{}};row.count++;const state=a.status||a.approval_status||"unknown";row.states[state]=(row.states[state]||0)+1;assignmentDays.set(key,row);}
    for(const [day,row] of assignmentDays){const summary=Object.entries(row.states).map(([k,v])=>`${k}: ${v}`).join(", ");historical.push({id:`history-assignments-${day}`,event_type:"historical_assignments",message:`${row.count} destination assignments were created. Current status snapshot: ${summary}.`,metadata:{count:row.count,status_breakdown:row.states},created_at:`${day}T23:59:58.000Z`,historical:true});}
    for(const j of jobs){const at=j.completed_at||j.started_at||j.created_at;if(!includeBeforeLive(at))continue;historical.push({id:`history-job-${j.id}`,event_type:"historical_discovery_run",message:`Discovery run ${j.status||"recorded"}.${j.last_error?` Last error: ${String(j.last_error).slice(0,180)}`:""}`,metadata:{job_type:j.job_type,status:j.status},created_at:at,historical:true});}
    for(const h of publishing){const at=h.published_at||h.created_at;if(!includeBeforeLive(at))continue;historical.push({id:`history-publish-${h.id}`,event_type:"historical_publishing",message:h.status==="published"?"Instagram post published.":`Publishing attempt recorded: ${h.status||"unknown"}.${h.error_message?` ${String(h.error_message).slice(0,160)}`:""}`,metadata:{status:h.status,permalink:h.permalink},created_at:at,historical:true});}
    const logs=[...saved,...historical].sort((a:any,b:any)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime()).slice(0,300);
    return json({logs});
  }
  if (p === "/overview" && method === "GET") {
    const [a,m,q,pub,sched] = await Promise.all([
      db(env,"instagram_accounts",`?${userFilter(ctx)}&select=id`),
      db(env,"memes",`?${userFilter(ctx)}&select=id`),
      db(env,"account_meme_assignments",`?${userFilter(ctx)}&approval_status=eq.pending&select=id,memes!inner(processing_status,classification)&memes.processing_status=eq.generated&memes.classification=neq.rejected`),
      db(env,"publishing_history",`?${userFilter(ctx)}&status=eq.published&select=id`),
      db(env,"account_meme_assignments",`?${userFilter(ctx)}&status=eq.scheduled&select=id`)
    ]);
    return json({ accounts:a.length, memes:m.length, pending:q.length, published:pub.length, scheduled:sched.length });
  }
  if (p === "/accounts" && method === "GET") return json({ accounts: await db(env,"instagram_accounts",`?${userFilter(ctx)}&select=id,owner_id,instagram_account_id,username,display_name,account_type,connection_status,token_expires_at,discovery_enabled,posting_enabled,created_at,updated_at,meta_user_id,meta_token_expires_at,meta_token_refreshed_at,meta_token_refresh_error,profile_picture_url,meta_token_type,meta_api_host&order=created_at.desc`) });
  if (p === "/accounts" && method === "POST") {
    const username = String(body.username || "").trim().replace(/^@/,"").toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(username)) return fail("Enter a valid Instagram username.");
    const rows = await db(env,"instagram_accounts","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,username,connection_status:"not_connected",discovery_enabled:true,posting_enabled:true})});
    return json({ account:rows?.[0] },201);
  }
  const metaConnect=p.match(/^\/accounts\/([0-9a-f-]+)\/meta-connect$/);
  if(metaConnect&&method==="POST"){
    if(!env.META_APP_ID||!env.META_APP_SECRET)return fail("Set META_APP_ID and META_APP_SECRET in the Cloudflare Worker first.",503);
    if(!await owned(env,"instagram_accounts",metaConnect[1],ctx))return fail("Account not found.",404);
    const accessToken=String(body.access_token||"").trim();
    if(!accessToken)return fail("Paste the System User Access Token generated in Meta Business settings.");
    try{
      const result=await connectMetaSystemUserToken(env,ctx,metaConnect[1],accessToken,String(body.instagram_account_id||"").trim()||undefined);
      return json(result);
    }catch(e:any){return fail(String(e?.message||"Meta token validation failed."),400);}
  }
  const accountMatch = p.match(/^\/accounts\/([0-9a-f-]+)$/);
  if (accountMatch && method === "PATCH") {
    if (!await owned(env,"instagram_accounts",accountMatch[1],ctx)) return fail("Account not found.",404);
    const allowed: any = {};
    if (typeof body.discovery_enabled === "boolean") allowed.discovery_enabled = body.discovery_enabled;
    if (typeof body.posting_enabled === "boolean") allowed.posting_enabled = body.posting_enabled;
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
  if(p==="/memes"&&method==="GET")return json({memes:await db(env,"memes",`?${userFilter(ctx)}&select=*&order=created_at.desc&limit=5000`)});
  if(p==="/captions/backfill"&&method==="POST"){
    const ids=Array.isArray(body.meme_ids)?Array.from(new Set(body.meme_ids.map((x:any)=>String(x)).filter((x:string)=>/^[0-9a-f-]{36}$/i.test(x)))).slice(0,300):[];
    if(!ids.length)return json({generated:0,remaining:0,failed:[],message:"No scheduler memes were supplied."});
    const memes=await db(env,"memes",`?${userFilter(ctx)}&id=in.(${ids.join(",")})&select=id,social_caption,extracted_text,original_caption&limit=300`);
    const missing=(memes||[]).filter((m:any)=>!String(m.social_caption||"").trim()&&(String(m.extracted_text||"").trim()||String(m.original_caption||"").trim()));
    const batch=missing.slice(0,5),failed:string[]=[];let generated=0;
    for(const meme of batch){try{const caption=await generateCaptionWithGroq(env,ctx,meme);await db(env,"memes",`?id=eq.${meme.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({social_caption:caption})});generated++;}catch(e:any){failed.push(String(e?.message||"Caption generation failed.").slice(0,180));}}
    return json({generated,remaining:Math.max(0,missing.length-batch.length),failed,attempted:batch.length});
  }
  const memeCaptionEdit=p.match(/^\/memes\/([0-9a-f-]+)\/caption$/);
  if(memeCaptionEdit&&method==="PATCH"){
    const memeId=memeCaptionEdit[1];if(!await owned(env,"memes",memeId,ctx))return fail("Meme not found.",404);
    const caption=String(body.social_caption??"").trim().toLowerCase().replace(/\s+/g," ");
    if(caption.length>80||(caption&&!/^[a-z0-9][a-z0-9\x27_-]*(?:\s+[a-z0-9][a-z0-9\x27_-]*)?$/.test(caption)))return fail("Caption must be one or two short words (max 80 characters).");
    const updated=await db(env,"memes","?id=eq."+memeId+"&"+userFilter(ctx),{method:"PATCH",body:JSON.stringify({social_caption:caption||null})});
    return json({meme:updated?.[0]});
  }
  const memeEdit=p.match(/^\/memes\/([0-9a-f-]+)$/);
  if(memeEdit&&method==="PATCH"){
    const memeId=memeEdit[1];if(!await owned(env,"memes",memeId,ctx))return fail("Meme not found.",404);
    const current=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}&select=processing_status,classification`);
    if(["discarded","media_unavailable","low_confidence"].includes(current[0]?.processing_status) || current[0]?.classification==="low_confidence")return fail("This item is terminal and cannot be reopened.",409);
    const text=String(body.extracted_text||"").trim();if(!text||text.length>3000)return fail("Meme text must be between 1 and 3000 characters.");
    const updated=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({extracted_text:text,social_caption:null,classification:"needs_review",classification_reason:"Text edited by user. Reclassification and asset regeneration queued.",processing_status:"ocr_complete",processing_attempts:0,processing_next_retry_at:null,processing_locked_until:null,processing_error:null,reel_status:"not_started",reel_asset_path:null,reel_asset_url:null,reel_song_id:null})});
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
  // Convert a meme between photo post and Reel. A Reel that doesn't exist yet is queued for render.
  const formatMatch=p.match(/^\/memes\/([0-9a-f-]+)\/format$/);
  if(formatMatch&&method==="POST"){
    const memeId=formatMatch[1];
    if(!await owned(env,"memes",memeId,ctx))return fail("Meme not found.",404);
    const format=body.format;
    if(!["photo","reel"].includes(format))return fail("format must be photo or reel.");
    const rows:any[]=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}&select=id,processing_status,asset_url,reel_asset_url,reel_status`);
    const m=rows?.[0];
    if(!m)return fail("Meme not found.",404);
    if(["discarded","media_unavailable","low_confidence"].includes(m.processing_status)||m.classification==="low_confidence")return fail("This item is terminal and cannot be converted or rendered again.",409);
    if(format==="photo"){
      await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({output_format:"photo"})});
      return json({output_format:"photo",ready:!!m.asset_url});
    }
    if(m.reel_asset_url){
      await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({output_format:"reel"})});
      return json({output_format:"reel",ready:true});
    }
    // No Reel yet: queue a render. The waiting-reels sweep picks it up within a minute.
    await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({output_format:"reel",reel_status:"render_requested",reel_render_next_retry_at:null,reel_render_locked_until:null,processing_error:null,processing_attempts:0})});
    return json({output_format:"reel",ready:false});
  }
  const approveMatch=p.match(/^\/memes\/([0-9a-f-]+)\/approve$/);
  if(approveMatch&&method==="POST"){
    const memeId=approveMatch[1];
    if(!await owned(env,"memes",memeId,ctx))return fail("Meme not found.",404);
    const decision=body.decision;
    if(!["approved","rejected"].includes(decision))return fail("Decision must be approved or rejected.");
    let publishFormat=body.publish_format||"auto";if(!["photo","reel","auto"].includes(publishFormat))return fail("publish_format must be photo, reel or auto.");
    const memeReady=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}&select=processing_status,asset_url,reel_status,reel_asset_url,reel_song_id,output_format,social_caption,extracted_text,original_caption`);const ready=memeReady[0];
    // auto: about 30% of approved memes become Reels (when a Reel with a song exists), the rest are photo posts.
    if(publishFormat==="auto"){publishFormat=ready?.output_format==="reel"?"reel":"photo";}
    if(decision==="approved"&&publishFormat==="photo"&&(ready?.processing_status!=="generated"||!ready?.asset_url))return fail("The BRAT final-frame photo asset is not ready yet.",409);
    if(decision==="approved"&&publishFormat==="reel"&&(ready?.reel_status!=="generated"||!ready?.reel_asset_url||!ready?.reel_song_id))return fail("The Reel and selected song are not ready yet.",409);
    if(decision==="approved"&&!String(ready?.social_caption||"").trim()){
      const caption=await generateCaptionWithGroq(env,ctx,ready||{});
      await db(env,"memes","?id=eq."+memeId+"&"+userFilter(ctx),{method:"PATCH",body:JSON.stringify({social_caption:caption})});
      ready.social_caption=caption;
    }
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

  if(p==="/scheduler/auto-fill"&&method==="POST"){
    const ids=Array.isArray(body.assignment_ids)?body.assignment_ids.map((x:any)=>String(x)).slice(0,5):[];
    const slots=Array.isArray(body.scheduled_at)?body.scheduled_at.slice(0,5):[];
    if(!ids.length||ids.length!==slots.length)return fail("Choose matching approved posts and future time slots.");
    const results=[];
    for(let i=0;i<ids.length;i++){
      const date=new Date(slots[i]);
      if(Number.isNaN(date.getTime())||date.getTime()<=Date.now())return fail("Every auto-post slot must be in the future.");
      const rows=await db(env,"account_meme_assignments",`?id=eq.${ids[i]}&${userFilter(ctx)}&select=*`);
      if(!rows.length||rows[0].approval_status!=="approved"||rows[0].scheduled_at||!["approved","pending"].includes(rows[0].status))return fail("One of the selected posts is no longer available to schedule.",409);
      if(rows[0].publish_format==="reel"){
        const meme=await db(env,"memes",`?id=eq.${rows[0].meme_id}&${userFilter(ctx)}&select=reel_status,reel_song_id`);
        if(meme[0]?.reel_status!=="generated"||!meme[0]?.reel_song_id)return fail("A selected Reel is not ready yet. Finish rendering and add an enabled song first.",409);
      }
      const updated=await db(env,"account_meme_assignments",`?id=eq.${ids[i]}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({scheduled_at:date.toISOString(),status:"scheduled",auto_scheduled:true})});
      results.push(updated?.[0]);
    }
    return json({scheduled:results.length,assignments:results});
  }
  if(p==="/assignments"&&method==="GET") return json({assignments:await db(env,"account_meme_assignments",`?${userFilter(ctx)}&select=*,memes(id,extracted_text,original_caption,social_caption,asset_url,source_permalink,classification,reel_asset_url,reel_status,reel_song_id),instagram_accounts(id,username)&order=created_at.desc&limit=300`)});
  const assignmentMatch=p.match(/^\/assignments\/([0-9a-f-]+)$/);
  if(assignmentMatch&&method==="PATCH"){
    const rows=await db(env,"account_meme_assignments",`?id=eq.${assignmentMatch[1]}&${userFilter(ctx)}&select=*`);if(!rows.length)return fail("Assignment not found.",404);
    const patch:any={};if(["pending","approved","rejected"].includes(body.approval_status))patch.approval_status=body.approval_status;
    if(body.rejection_reason!==undefined)patch.rejection_reason=String(body.rejection_reason).slice(0,500);
    if(body.publish_format!==undefined){if(!["photo","reel"].includes(body.publish_format))return fail("publish_format must be photo or reel.");patch.publish_format=body.publish_format;}
    if(body.scheduled_at!==undefined&&body.scheduled_at!==null){const d=new Date(body.scheduled_at);if(Number.isNaN(d.getTime())||d.getTime()<=Date.now())return fail("Choose a future schedule time.");if(rows[0].approval_status!=="approved"&&patch.approval_status!=="approved")return fail("Approve this account assignment before scheduling.");if(rows[0].publish_format==="reel"){const m=await db(env,"memes",`?id=eq.${rows[0].meme_id}&${userFilter(ctx)}&select=reel_status,reel_song_id`);if(m[0]?.reel_status!=="generated"||!m[0]?.reel_song_id)return fail("This Reel is not ready yet. Add an enabled song and wait for Reel rendering to finish.",409);}patch.scheduled_at=d.toISOString();patch.status="scheduled";patch.auto_scheduled=false;}
    if(body.scheduled_at===null){patch.scheduled_at=null;patch.status="approved";patch.auto_scheduled=false;patch.publishing_locked_until=null;patch.publishing_started_at=null;}
    const updated=await db(env,"account_meme_assignments",`?id=eq.${assignmentMatch[1]}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify(patch)});return json({assignment:updated?.[0]});
  }
  if (p === "/pipeline" && method === "GET") {
    const rows: any[] = await db(env,"memes",`?${userFilter(ctx)}&select=id,processing_status,reel_status,processing_error,processing_attempts,processing_consecutive_errors,processing_same_error_count,classification,extracted_text,source_username,created_at,processing_next_retry_at,processing_locked_until,reel_render_locked_until&order=created_at.desc&limit=5000`);
    const assignments: any[] = await db(env,"account_meme_assignments",`?${userFilter(ctx)}&select=id,meme_id,approval_status,status&limit=5000`);
    const processing: Record<string, number> = {};
    const reel: Record<string, number> = {};
    for (const r of rows) {
      const ps = r.processing_status || "unknown";
      processing[ps] = (processing[ps] || 0) + 1;
      if (r.reel_status) reel[r.reel_status] = (reel[r.reel_status] || 0) + 1;
    }
    const nowMs = Date.now();
    const isLocked = (r: any) => (r.processing_locked_until && new Date(r.processing_locked_until).getTime() > nowMs) || (r.reel_render_locked_until && new Date(r.reel_render_locked_until).getTime() > nowMs);
    const terminal = (r: any) => ["discarded","media_unavailable","low_confidence"].includes(r.processing_status || "") || r.classification === "low_confidence";
    const items = rows.filter((r) => !terminal(r) &&
      (!["generated","rejected"].includes(r.processing_status || "") || ["render_failed","renderer_not_configured"].includes(r.reel_status || "")) &&
      !["discarded","media_unavailable","low_confidence"].includes(r.reel_status || "")
    ).slice(0, 200);
    const total = rows.length;
    const activeRows = rows.filter((r) => ["needs_ocr","ocr_complete","ready_for_asset"].includes(r.processing_status) && !terminal(r));
    const legacyFailedRows = rows.filter((r) => ["failed","processing_failed"].includes(r.processing_status) && !terminal(r));
    const runningRows = rows.filter((r) => (activeRows.includes(r) || (r.processing_status === "generated" && r.reel_status === "rendering")) && isLocked(r));
    const readyQueueRows = activeRows.filter((r) => !isLocked(r) && (!r.processing_next_retry_at || new Date(r.processing_next_retry_at).getTime() <= nowMs));
    const retryWaitRows = activeRows.filter((r) => !isLocked(r) && r.processing_next_retry_at && new Date(r.processing_next_retry_at).getTime() > nowMs);
    const generatedIds = new Set(rows.filter((r) => r.processing_status === "generated").map((r) => r.id));
    const pendingApproval = assignments.filter((a) => generatedIds.has(a.meme_id) && a.approval_status === "pending").length;
    const rejectedCount = rows.filter((r) => r.processing_status === "rejected").length +
      assignments.filter((a) => generatedIds.has(a.meme_id) && a.approval_status === "rejected").length;
    const flow = [
      { key:"discovered", label:"Discovered", count:total, detail:"All source and manual meme records" },
      { key:"to_process", label:"To be processed", count:readyQueueRows.length + retryWaitRows.length + rows.filter((r) => ["ready_for_asset","generated"].includes(r.processing_status) && ["render_failed","renderer_not_configured","render_requested"].includes(r.reel_status) && !terminal(r)).length + legacyFailedRows.length, detail:"Queued, waiting for retry time or needing a legacy failure reset" },
      { key:"processing", label:"Processing", count:runningRows.length, detail:"OCR, classification or render work in progress" },
      { key:"processed", label:"Processed", count:rows.filter((r) => r.processing_status === "generated").length, detail:"Assets generated and ready for approval" },
      { key:"approval", label:"Approval queue", count:pendingApproval, detail:"Generated items awaiting your decision" },
      { key:"scheduled", label:"Scheduled", count:assignments.filter((a) => a.status === "scheduled").length, detail:"Approved destination assignments with a schedule" },
      { key:"published", label:"Published", count:assignments.filter((a) => a.status === "published").length, detail:"Successfully published assignments" },
      { key:"rejected", label:"Rejected", count:rejectedCount, detail:"Content or destination assignments rejected" },
      { key:"discarded", label:"Discarded", count:rows.filter((r) => r.processing_status === "discarded").length, detail:"Terminal processing failures; retained for history" },
      { key:"media_unavailable", label:"Media unavailable", count:rows.filter((r) => r.processing_status === "media_unavailable").length, detail:"Source media could not be retrieved" },
      { key:"low_confidence", label:"Low confidence", count:rows.filter((r) => r.processing_status === "low_confidence" || r.classification === "low_confidence").length, detail:"No reliable text extraction; terminal manual-review outcome" },
    ];
    const stages = [
      { label:"Text read", count:rows.filter((r) => !!r.extracted_text).length, total },
      { label:"Classified", count:rows.filter((r) => ["suitable","rejected"].includes(r.classification)).length, total },
      { label:"Rendered and ready to approve", count:rows.filter((r) => r.processing_status === "generated").length, total },
    ];
    const stepFor = (st: string) => ({ needs_ocr:"Reading text (OCR)", ocr_complete:"Classifying", ready_for_asset:"Rendering BRAT video" } as Record<string,string>)[st] || st;
    const running = runningRows.map((r: any) => ({ ...r, step:r.reel_status === "rendering" ? "Rendering video on GitHub" : stepFor(r.processing_status) }));
    const queued = readyQueueRows.map((r: any) => ({ ...r, step:stepFor(r.processing_status) }));
    const renderer = env.GITHUB_TOKEN && env.GITHUB_REPO ? "github_actions" : "not_configured";
    const explain = (r: any): string => {
      const err = r.processing_error ? ` Error: ${r.processing_error}` : "";
      const locked = isLocked(r);
      if (r.reel_status === "rendering") return "Video is rendering on GitHub Actions. It retries if no result comes back in 30 minutes.";
      if (r.reel_status === "renderer_not_configured") return "The GitHub renderer is not configured. Set GITHUB_TOKEN and GITHUB_REPO on the Worker.";
      if (r.reel_status === "render_failed") return `Video render failed.${err} It retries automatically.`;
      if (r.reel_status === "waiting_for_song") return "Photo is ready. The Reel needs a track in Song Library.";
      switch (r.processing_status) {
        case "needs_ocr": return locked ? "Reading text now." : (r.processing_attempts > 0 ? `Text reading failed.${err}` : "Waiting for the background job to read the text (runs every minute).");
        case "ocr_complete": return locked ? "Classifying now." : `Waiting for classification.${err}`;
        case "ready_for_asset": return locked ? "Starting the video render." : `Waiting to start the video render.${err}`;
        default: return `Status: ${r.processing_status}.${err}`;
      }
    };
    const itemsWithWhy = items.map((r: any) => ({ ...r, why:explain(r) }));
    return json({ counts:{processing,reel}, renderer, items:itemsWithWhy, stages, running, queued, flow, flowRecords:rows, flowAssignments:assignments, total, retry_wait:retryWaitRows.length });
  }
  const discardMatch=p.match(/^\/memes\/([0-9a-f-]+)\/discard$/);
  if(discardMatch&&method==="POST"){
    const memeId=discardMatch[1];
    const rows=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}&select=id,processing_status`);
    if(!rows.length)return fail("Meme not found.",404);
    if(rows[0].processing_status==="generated")return fail("Generated items are not stuck; they can be rejected from the approval queue instead.",409);
    const updated=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}&processing_status=neq.generated`,{method:"PATCH",body:JSON.stringify({processing_status:"discarded",reel_status:"discarded",classification_reason:"Discarded by user from Not Finished.",processing_locked_until:null,processing_token:null,processing_next_retry_at:null,reel_render_locked_until:null,reel_render_next_retry_at:null})});
    if(!updated?.length)return fail("Could not discard this item. It may have just finished.",409);
    return json({meme:updated[0]});
  }
  if (p === "/pipeline/retry" && method === "POST") {
    // Only active, non-terminal pipeline stages can be retried. Error streak counters are deliberately preserved.
    const reset = { processing_attempts:0, processing_error:null, processing_next_retry_at:null, processing_locked_until:null, reel_render_locked_until:null, reel_render_next_retry_at:null };
    const groups = [
      { filter:"processing_status=in.(needs_ocr,failed,processing_failed)&classification=neq.low_confidence&extracted_text=is.null", status:"needs_ocr" },
      { filter:"processing_status=in.(ocr_complete,ready_for_asset,failed,processing_failed)&extracted_text=not.is.null&classification=eq.suitable", status:"ready_for_asset" },
      { filter:"processing_status=in.(ocr_complete,failed,processing_failed)&extracted_text=not.is.null&classification=neq.suitable", status:"ocr_complete" },
    ];
    let requeued = 0;
    for (const g of groups) {
      const rows: any[] = await db(env,"memes",`?${userFilter(ctx)}&${g.filter}&select=id`,{method:"PATCH",body:JSON.stringify({...reset,processing_status:g.status})});
      requeued += rows.length;
    }
    const reelRows: any[] = await db(env,"memes",`?${userFilter(ctx)}&processing_status=in.(ready_for_asset,generated)&classification=neq.low_confidence&reel_status=in.(render_failed,renderer_not_configured)&select=id`,{method:"PATCH",body:JSON.stringify({reel_status:"render_failed",reel_render_locked_until:null,reel_render_next_retry_at:new Date().toISOString(),processing_error:null})});
    return json({requeued,reel_requeued:reelRows.length});
  }

  if(p==="/help/search"&&method==="POST"){
    const query=String(body.query||"").trim().slice(0,500);
    if(!query)return fail("Enter a Help question.");
    const articles=[
      {id:"auto-fill",title:"Fill all approved posts in queue order",body:"Turn on Auto-post to fill all approved posts in queue order, cycling through daily posting slots across the rolling schedule until all approved posts have times."},
      {id:"auto-pause",title:"Pause Auto-post without losing saved times",body:"Turn Auto-post off to pause automatic publishing. Existing auto-post times stay saved. They will not publish automatically while Auto-post is off. Use Schedule on a post when you want to activate that saved time manually."},
      {id:"manual-schedule",title:"Schedule a post manually",body:"Choose a date and time on an approved post, then select Schedule. A manually scheduled post can publish even when Auto-post is off."},
      {id:"posts-per-day",title:"Change Posts / day",body:"Use the Posts / day dropdown in Scheduler to choose how many posts Auto-post assigns each day."},
      {id:"approve",title:"Approve content",body:"Open Approval Queue and approve the content you want to publish. Only approved assignments can be scheduled."},
      {id:"reels",title:"Prepare a Reel for publishing",body:"A Reel must finish rendering and have an enabled song selected before it can be scheduled."},
      {id:"captions",title:"Generate missing captions",body:"In Scheduler, use Generate missing captions. MemeOS uses the enabled Groq key and readable meme text to create short captions."},
      {id:"accounts",title:"Connect an Instagram account",body:"Open Instagram, choose the destination account, and connect it using the Meta System User Access Token flow."},
      {id:"discovery",title:"Run meme discovery",body:"Open Discovery, configure reference sources, and run discovery to collect source posts for your workspace."},
      {id:"songs",title:"Manage Reel songs",body:"Upload and enable tracks in Song Library. Enabled tracks can be mixed into generated Reels."},
      {id:"analytics",title:"Refresh analytics",body:"Open Analytics and select Sync Meta insights to request the latest available metrics."}
    ];
    const creds=await db(env,"api_credentials",`?${userFilter(ctx)}&provider=eq.groq&enabled=eq.true&or=(cooldown_until.is.null,cooldown_until.lte.${encodeURIComponent(new Date().toISOString())})&status=neq.error&select=*&order=last_used_at.asc.nullsfirst,created_at.asc`);
    if(!creds.length)return fail("AI Help search needs an enabled Groq key. Add one in Settings → API Manager.",503);
    let lastError="AI Help search could not find a match.";
    for(const credential of creds){try{
      const secret=await decryptSecret(env,credential);
      const response=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+secret,"Content-Type":"application/json"},body:JSON.stringify({model:"openai/gpt-oss-20b",temperature:0,response_format:{type:"json_object"},messages:[{role:"system",content:"Match the user's natural-language question to exactly one Help article. Choose the closest article even if the wording differs. Return JSON only: {\"article_id\":\"one supplied id\"}. Never invent an id."},{role:"user",content:JSON.stringify({query,articles:articles.map(({id,title,body})=>({id,title,body}))})}]})});
      const data:any=await response.json().catch(()=>({}));
      if(!response.ok){lastError=data.error?.message||`Groq returned ${response.status}.`;await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:credentialFailureStatus(response.status,credential.status),cooldown_until:response.status===429?new Date(Date.now()+5*60*1000).toISOString():null,last_used_at:new Date().toISOString()})});continue;}
      const parsed=JSON.parse(data.choices?.[0]?.message?.content||"{}"),article=articles.find(x=>x.id===parsed.article_id);
      await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:"connected",cooldown_until:null,last_used_at:new Date().toISOString()})});
      if(!article)return fail("No matching Help article. Try describing what you want to do another way.",404);
      return json({article_id:article.id});
    }catch(e:any){lastError=e.message||lastError;}}
    return fail(lastError,502);
  }

  if(p==="/settings"&&method==="GET") {const rows=await db(env,"user_settings",`?${userFilter(ctx)}&select=*`);return json({settings:rows[0]||{global_paused:false,auto_process_enabled:true,video_freeze_seconds:2,discovery_interval_minutes:60,timezone:"Asia/Kolkata",auto_post_enabled:false,posts_per_day:3}});}
  const processMatch=p.match(/^\/memes\/([0-9a-f-]+)\/process$/);
  if(processMatch&&method==="POST"){
    const memeId=processMatch[1];const rows=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}&select=*`);if(!rows.length)return fail("Meme not found.",404);
    const meme=rows[0];
    if (["discarded","media_unavailable","low_confidence"].includes(meme.processing_status) || meme.classification === "low_confidence") return fail("This item is terminal and cannot be retried.",409);
    const next=meme.classification==="suitable"&&meme.extracted_text?"ready_for_asset":meme.extracted_text?"ocr_complete":"needs_ocr";
    const updated=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({processing_status:next,processing_attempts:0,processing_next_retry_at:null,processing_locked_until:null,processing_token:null,reel_render_locked_until:null,reel_render_next_retry_at:null,processing_error:null})});
    // Reprocessing produces a new image, so every destination goes back to the approval queue.
    await db(env,"account_meme_assignments",`?${userFilter(ctx)}&meme_id=eq.${memeId}`,{method:"PATCH",body:JSON.stringify({approval_status:"pending",status:"pending",scheduled_at:null,publishing_locked_until:null,rejection_reason:"Reprocessed; approval reset."})});
    return json({queued:true,processing_status:updated?.[0]?.processing_status||next});
  }
  const classifyMatch=p.match(/^\/memes\/([0-9a-f-]+)\/classify$/);
  if(classifyMatch&&method==="POST"){
    const memeId=classifyMatch[1];const memes=await db(env,"memes",`?id=eq.${memeId}&${userFilter(ctx)}&select=*`);if(!memes.length)return fail("Meme not found.",404);
    const meme=memes[0];if(["discarded","media_unavailable","low_confidence"].includes(meme.processing_status)||meme.classification==="low_confidence")return fail("This item is terminal and cannot be reclassified.",409);if(!meme.extracted_text?.trim())return fail("Extract text with OCR before classification.");
    const creds=await db(env,"api_credentials",`?${userFilter(ctx)}&provider=eq.groq&enabled=eq.true&or=(cooldown_until.is.null,cooldown_until.lte.${encodeURIComponent(new Date().toISOString())})&status=neq.error&select=*&order=last_used_at.asc.nullsfirst,created_at.asc`);if(!creds.length)return fail("Add and enable a Groq key in Settings → API Manager.",503);
    let result:any=null,lastError="No Groq key could process this request.";
    for(const credential of creds){try{
      const secret=await decryptSecret(env,credential);
      const response=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify({model:"openai/gpt-oss-20b",temperature:0,response_format:{type:"json_object"},messages:[{role:"system",content:"Classify whether a meme can be faithfully converted into a text-only BRAT-style image. Return JSON only: {\"suitable\":boolean,\"reason\":string}. suitable=true only when the complete joke/meaning is carried by the extracted words alone and does not depend on a photo, reaction face, screenshot layout, visual context, or image-specific details. Never rewrite, correct, summarize, or improve the text."},{role:"user",content:`Extracted text (preserve exactly):\\n${meme.extracted_text}`} ]})});
      const data:any=await response.json().catch(()=>({}));if(!response.ok){lastError=data.error?.message||`Groq returned ${response.status}.`;await db(env,"api_credentials",`?id=eq.${credential.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status:response.status===429?"rate_limited":"error",cooldown_until:response.status===429?new Date(Date.now()+5*60*1000).toISOString():null,last_used_at:new Date().toISOString()})});continue;}
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

  if(p==="/schedule"&&method==="GET")return json({items:await db(env,"account_meme_assignments",`?${userFilter(ctx)}&scheduled_at=not.is.null&select=*,memes(extracted_text,social_caption),instagram_accounts(username)&order=scheduled_at.asc`)});
  if(p==="/publishing"&&method==="GET")return json({items:await db(env,"publishing_history",`?${userFilter(ctx)}&select=*,memes(extracted_text,social_caption)&order=created_at.desc&limit=100`)});
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
    const rows=await db(env,"api_credentials",`?${userFilter(ctx)}&select=id,provider,label,key_hint,actor_id,actor_input,enabled,status,last_tested_at,last_used_at,created_at,usage_snapshot,usage_refreshed_at,auto_disabled_until,auto_disabled_reason&order=created_at.desc`);
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
    const patch:any={}; if(typeof body.enabled==="boolean"){const lockedUntil=rows[0].auto_disabled_until;if(body.enabled&&rows[0].auto_disabled_reason&&lockedUntil&&Date.parse(lockedUntil)>Date.now())return fail("This Apify key is paused until its usage cycle ends.",409);patch.enabled=body.enabled;if(body.enabled){patch.auto_disabled_until=null;patch.auto_disabled_reason=null;}}
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
  const usageMatch=p.match(/^\/api-credentials\/([0-9a-f-]+)\/usage$/);
  if(usageMatch&&method==="POST"){
    const rows=await db(env,"api_credentials",`?id=eq.${usageMatch[1]}&${userFilter(ctx)}&select=*`);
    if(!rows.length)return fail("API key not found.",404);
    const row=rows[0];if(!row.enabled)return fail("Enable this API key before refreshing its usage.",400);
    try{const snapshot=await refreshCredentialUsage(env,ctx,row);return json(snapshot||{});}
    catch(e:any){return fail(e?.message||"Usage refresh failed.",502);}
  }
  const testMatch=p.match(/^\/api-credentials\/([0-9a-f-]+)\/test$/);
  if(testMatch&&method==="POST"){
    const rows=await db(env,"api_credentials",`?id=eq.${testMatch[1]}&${userFilter(ctx)}&select=*`);if(!rows.length)return fail("API key not found.",404);
    const row=rows[0];const secret=await decryptSecret(env,row);let response:Response;
    if(row.provider==="apify")response=await fetch("https://api.apify.com/v2/users/me",{headers:{Authorization:`Bearer ${secret}`}});
    else response=await fetch("https://api.groq.com/openai/v1/models",{headers:{Authorization:`Bearer ${secret}`}});
    const ok=response.ok,rateLimited=response.status===429,temporaryFailure=response.status>=500;
    const detail=ok?(row.provider==="apify"?"Apify API key authenticated.":"Groq API key authenticated."):rateLimited?"Provider rate-limited this test. The key remains marked connected; try again later.":temporaryFailure?"Provider is temporarily unavailable. The saved key status was left unchanged.":((await response.text()).slice(0,180)||`Provider returned ${response.status}.`);
    const status=ok||rateLimited?"connected":temporaryFailure?(row.status==="connected"?"connected":row.status||"untested"):"error";
    await db(env,"api_credentials",`?id=eq.${row.id}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({status,cooldown_until:rateLimited?new Date(Date.now()+5*60*1000).toISOString():null,last_tested_at:new Date().toISOString()})});
    return json({ok:ok||rateLimited||temporaryFailure,message:detail},ok||rateLimited||temporaryFailure?200:400);
  }
  if(p==="/settings"&&method==="PATCH"){
    const current=await db(env,"user_settings",`?${userFilter(ctx)}&select=global_paused,auto_process_enabled`);
    const patch:any={owner_id:ctx.userId};
    if(typeof body.global_paused==="boolean")patch.global_paused=body.global_paused;
    if(typeof body.auto_process_enabled==="boolean")patch.auto_process_enabled=body.auto_process_enabled;if(typeof body.auto_post_enabled==="boolean")patch.auto_post_enabled=body.auto_post_enabled;if(body.posts_per_day!==undefined){const n=Number(body.posts_per_day);if(!Number.isInteger(n)||n<1||n>10)return fail("Posts per day must be between 1 and 10.");patch.posts_per_day=n;}
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
    const allSourcesRows=await db(env,"reference_accounts",`?${userFilter(ctx)}&enabled=eq.true&select=id,username,scraped_offset,last_scraped_at`);
    const sources=allSources?allSourcesRows:allSourcesRows.filter((source:any)=>allowed.has(source.id));
    if(!sources.length)return fail("Add or assign at least one enabled reference account to a destination with discovery enabled.");
    const jobs:any[]=[];const errors:string[]=[];
    for(const source of sources){try{jobs.push(await startApifyDiscoveryForSource(env,ctx,source,creds,false));}catch(e:any){errors.push(e?.message||String(e));}}
    if(!jobs.length)return fail(errors.join(" ")||"No source account could start a discovery run.",502);
    const settingsRow=await db(env,"user_settings",`?${userFilter(ctx)}&select=owner_id`);if(settingsRow.length)await db(env,"user_settings",`?${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({last_discovery_started_at:new Date().toISOString(),discovery_lock_until:null})});else await db(env,"user_settings","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,last_discovery_started_at:new Date().toISOString(),discovery_interval_minutes:60,discovery_lock_until:null})});
    return json({job_id:jobs[0]?.id,provider_run_id:jobs[0]?.provider_run_id,jobs:jobs.map((job:any)=>({job_id:job.id,provider_run_id:job.provider_run_id,source_username:job.metadata?.source_usernames?.[0]})),started:jobs.length,errors},202);
  }
  return fail("Route not found.",404);
}

async function scheduleDailyAutoPosts(env:Env,ctx:Ctx,settings:any){
  if(!settings?.auto_post_enabled||settings?.global_paused)return;
  const timezone=String(settings.timezone||"Asia/Kolkata"),now=new Date();
  const localDateKey=(value:Date)=>{const p=new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(value);const v=(t:string)=>p.find((x:any)=>x.type===t)?.value||"";return v("year")+"-"+v("month")+"-"+v("day")};
  const toIso=(date:string,time:string)=>{const b=date.split("-").map(Number),c=time.split(":").map(Number),target=Date.UTC(b[0],b[1]-1,b[2],c[0],c[1]);let guess=target;for(let n=0;n<3;n++){const p=new Intl.DateTimeFormat("en-US",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(guess));const v=(t:string)=>Number(p.find((x:any)=>x.type===t)?.value||0);guess+=target-Date.UTC(v("year"),v("month")-1,v("day"),v("hour"),v("minute"));}return new Date(guess)};
  const ranked=[["19:00","18:00","20:00","15:00","16:00","14:00","17:00","21:00","12:00","11:00"],["19:00","15:00","17:00","16:00","18:00","14:00","13:00","20:00","21:00","12:00"],["12:00","18:00","20:00","19:00","17:00","15:00","21:00","14:00","11:00","09:00"],["09:00","08:00","07:00","13:00","12:00","14:00","18:00","19:00","20:00","17:00"],["22:00","21:00","18:00","16:00","19:00","20:00","17:00","12:00","14:00","15:00"],["21:00","22:00","20:00","17:00","18:00","19:00","15:00","12:00","14:00","16:00"],["21:00","22:00","20:00","19:00","18:00","17:00","15:00","14:00","12:00","11:00"]];
  const today=localDateKey(now),startOfToday=toIso(today,"00:00");
  await db(env,"account_meme_assignments",`?${userFilter(ctx)}&auto_scheduled=eq.true&status=eq.scheduled&scheduled_at=lt.${encodeURIComponent(startOfToday.toISOString())}`,{method:"PATCH",body:JSON.stringify({scheduled_at:null,status:"approved",auto_scheduled:false})});
  const existing=await db(env,"account_meme_assignments",`?${userFilter(ctx)}&scheduled_at=gte.${encodeURIComponent(now.toISOString())}&select=scheduled_at&limit=1000`);
  const usedByDay=new Map<string,Set<number>>(),countByDay=new Map<string,number>();
  for(const row of existing||[]){if(!row.scheduled_at)continue;const instant=new Date(row.scheduled_at),key=localDateKey(instant);if(!usedByDay.has(key))usedByDay.set(key,new Set<number>());usedByDay.get(key)!.add(instant.getTime());countByDay.set(key,(countByDay.get(key)||0)+1);}
  const dailyLimit=Math.max(1,Math.min(10,Number(settings.posts_per_day||3))),available:Date[]=[];
  // Process a small slice on each cron tick. This keeps Supabase subrequests bounded.
  const queue=await db(env,"account_meme_assignments",`?${userFilter(ctx)}&approval_status=eq.approved&status=in.(approved,pending)&scheduled_at=is.null&select=id,publish_format,meme_id&order=created_at.desc&limit=5`);
  if(!queue.length)return;
  const memeIds=[...new Set(queue.filter((x:any)=>x.publish_format==="reel").map((x:any)=>x.meme_id))];
  const memeRows=memeIds.length?await db(env,"memes",`?${userFilter(ctx)}&id=in.(${memeIds.join(",")})&select=id,reel_status,reel_song_id`):[];
  const memeMap=new Map((memeRows||[]).map((m:any)=>[m.id,m]));
  const readyQueue=queue.filter((item:any)=>item.publish_format!=="reel"||(memeMap.get(item.meme_id) as any)?.reel_status==="generated"&&(memeMap.get(item.meme_id) as any)?.reel_song_id);
  const horizon=Math.min(365,Math.ceil((readyQueue.length+(existing||[]).length)/dailyLimit)+7),todayParts=today.split("-").map(Number);
  for(let offset=0;offset<horizon;offset++){const d=new Date(Date.UTC(todayParts[0],todayParts[1]-1,todayParts[2]+offset,12));const date=d.getUTCFullYear()+"-"+String(d.getUTCMonth()+1).padStart(2,"0")+"-"+String(d.getUTCDate()).padStart(2,"0"),day=d.getUTCDay(),used=usedByDay.get(date)||new Set<number>();let remaining=dailyLimit-(countByDay.get(date)||0);if(remaining<=0)continue;const daySlots:Date[]=[];for(const time of ranked[day]){const slot=toIso(date,time);if(slot.getTime()<=now.getTime()+60000||used.has(slot.getTime()))continue;daySlots.push(slot);if(daySlots.length>=remaining)break;}daySlots.sort((a,b)=>a.getTime()-b.getTime());available.push(...daySlots);if(available.length>=readyQueue.length)break;}
  let slotIndex=0,count=0;
  for(const item of readyQueue){if(slotIndex>=available.length)break;const slot=available[slotIndex],updated=await db(env,"account_meme_assignments",`?id=eq.${item.id}&${userFilter(ctx)}&scheduled_at=is.null`,{method:"PATCH",body:JSON.stringify({scheduled_at:slot.toISOString(),status:"scheduled",auto_scheduled:true})});if(updated?.length){slotIndex++;count++;}}
  if(count){console.log("Rolling auto-scheduled posts",ctx.userId,count);await logMajorActivity(env,ctx.userId,"scheduling_batch",`${count} approved memes were automatically scheduled.`,count,{scheduled_count:count});}
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url=new URL(req.url);
    // Public browser configuration: the publishable key is designed to be public.
    // Never return SUPABASE_SECRET_KEY from this endpoint.
    if(url.pathname==="/api/public-config") {
      return new Response(JSON.stringify({supabaseUrl:env.SUPABASE_URL||"",publishableKey:env.SUPABASE_PUBLISHABLE_KEY||""}),{status:200,headers:{"Content-Type":"application/json","Cache-Control":"no-store, max-age=0"}});
    }
    if(url.pathname==="/api/meta/callback") return new Response("BRATLOOP uses a Meta System User Access Token. Return to the app and connect from the Instagram page.",{status:410,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}});
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
    const jobs = await db(env,"jobs",`?job_type=eq.discovery&status=in.(running,queued)&or=(next_retry_at.is.null,next_retry_at.lte.${encodeURIComponent(now)})&select=*&order=created_at.asc&limit=30`);
    let polledJobs=0;
    for (const job of jobs) {
      if(polledJobs>=5)break;
      // Skip leased jobs instead of letting the oldest lock block every newer run.
      if(job.locked_until&&new Date(job.locked_until).getTime()>Date.now())continue;
      const ctx:Ctx={userId:job.owner_id,token:""};
      try {
        const settings=await db(env,"user_settings",`?${userFilter(ctx)}&select=global_paused`);if(settings[0]?.global_paused)continue;
        const lease=await db(env,"jobs",`?id=eq.${job.id}&${userFilter(ctx)}&status=in.(running,queued)&or=(locked_until.is.null,locked_until.lte.${encodeURIComponent(now)})`,{method:"PATCH",body:JSON.stringify({last_attempt_at:now,locked_until:new Date(Date.now()+12*60*1000).toISOString()})});
        if(!lease?.length)continue;
        polledJobs++;
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
    try{await refreshInstagramTokens(env);}catch(e:any){console.error("Token refresh phase failed",String(e?.message||e));}
    try{await runBackgroundProcessing(env);}catch(e:any){console.error("Background processing phase failed",String(e?.message||e));}
    try{await runWaitingReels(env);}catch(e:any){console.error("Reel rendering phase failed",String(e?.message||e));}
    try{const analyticsOwners=await db(env,"user_settings","?select=owner_id,last_analytics_sync_at,global_paused");
      for(const setting of analyticsOwners){if(setting.global_paused)continue;if(setting.last_analytics_sync_at&&Date.now()-new Date(setting.last_analytics_sync_at).getTime()<6*60*60*1000)continue;const ctx:Ctx={userId:setting.owner_id,token:""};try{await syncMetaAnalyticsForOwner(env,ctx);await db(env,"user_settings",`?${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify({last_analytics_sync_at:new Date().toISOString()})});}catch{}}}catch(e:any){console.error("Analytics sync phase failed",String(e?.message||e));}
    try{const autoOwners=await db(env,"user_settings","?auto_post_enabled=eq.true&global_paused=eq.false&select=owner_id,auto_post_enabled,posts_per_day,timezone,global_paused&limit=1");for(const setting of autoOwners){const ctx:Ctx={userId:setting.owner_id,token:""};try{await scheduleDailyAutoPosts(env,ctx,setting)}catch(e:any){console.error("Daily auto-scheduling failed",setting.owner_id,String(e?.message||e));}}}catch(e:any){console.error("Daily auto-scheduling scan failed",String(e?.message||e));}
    const expiredPublishing=await db(env,"account_meme_assignments",`?status=eq.publishing&publishing_locked_until=lt.${encodeURIComponent(now)}&select=id,owner_id&limit=50`);
    for(const item of expiredPublishing){const ctx:Ctx={userId:item.owner_id,token:""};await db(env,"account_meme_assignments",`?id=eq.${item.id}&${userFilter(ctx)}&status=eq.publishing`,{method:"PATCH",body:JSON.stringify({status:"needs_review",publishing_locked_until:null,rejection_reason:"Publishing worker lease expired. Check Instagram before retrying to avoid a duplicate post."})});}
    const due = await db(env,"account_meme_assignments",`?approval_status=eq.approved&status=eq.scheduled&scheduled_at=lte.${encodeURIComponent(now)}&or=(publishing_locked_until.is.null,publishing_locked_until.lte.${encodeURIComponent(now)})&select=id,owner_id,auto_scheduled,instagram_accounts!inner(posting_enabled)&instagram_accounts.posting_enabled=eq.true&order=scheduled_at.asc&limit=5`);
    for(const item of due){
      const ctx:Ctx={userId:item.owner_id,token:""};const settings=await db(env,"user_settings",`?${userFilter(ctx)}&select=global_paused,auto_post_enabled`);if(settings[0]?.global_paused||(item.auto_scheduled&&!settings[0]?.auto_post_enabled))continue;
      const lease=await db(env,"account_meme_assignments",`?id=eq.${item.id}&${userFilter(ctx)}&status=eq.scheduled&approval_status=eq.approved&scheduled_at=lte.${encodeURIComponent(now)}&or=(publishing_locked_until.is.null,publishing_locked_until.lte.${encodeURIComponent(now)})`,{method:"PATCH",body:JSON.stringify({status:"publishing",publishing_started_at:now,publishing_locked_until:new Date(Date.now()+10*60*1000).toISOString()})});
      if(lease?.length){try{await publishAssignment(env,item);}catch(e:any){console.error("Scheduled publish failed",item.id,String(e?.message||e));}}
    }
  }
};
