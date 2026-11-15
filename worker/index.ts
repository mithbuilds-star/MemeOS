export interface Env {
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  APIFY_API_TOKEN?: string;
  APIFY_ACTOR_ID?: string;
  GROQ_API_KEY?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_REDIRECT_URI?: string;
  META_GRAPH_VERSION?: string;
  APP_ENV?: string;
}
type Ctx = { userId: string; token: string };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (message: string, status = 400) => json({ error: message }, status);
const headers = (env: Env) => ({ apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" });
async function auth(req: Request, env: Env): Promise<Ctx | null> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u: any = await r.json();
  return u?.id ? { userId: u.id, token } : null;
}
async function db(env: Env, table: string, path = "", init: RequestInit = {}) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}${path}`, { ...init, headers: { ...headers(env), Prefer: "return=representation", ...(init.headers || {}) } });
  const body = await r.text();
  if (!r.ok) throw new Error(`Database error ${r.status}: ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : null;
}
function userFilter(ctx: Ctx) { return `owner_id=eq.${encodeURIComponent(ctx.userId)}`; }
async function owned(env: Env, table: string, id: string, ctx: Ctx) {
  const rows = await db(env, table, `?id=eq.${encodeURIComponent(id)}&${userFilter(ctx)}&select=id`);
  return rows?.length > 0;
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
  const accountMatch = p.match(/^\/accounts\/([0-9a-f-]+)$/);
  if (accountMatch && method === "PATCH") {
    if (!await owned(env,"instagram_accounts",accountMatch[1],ctx)) return fail("Account not found.",404);
    const allowed: any = {};
    if (typeof body.discovery_enabled === "boolean") allowed.discovery_enabled = body.discovery_enabled;
    if (body.display_name !== undefined) allowed.display_name = String(body.display_name).slice(0,100);
    const rows = await db(env,"instagram_accounts",`?id=eq.${accountMatch[1]}&${userFilter(ctx)}`,{method:"PATCH",body:JSON.stringify(allowed)});
    return json({account:rows?.[0]});
  }
  if (p === "/sources" && method === "GET") return json({sources:await db(env,"reference_accounts",`?${userFilter(ctx)}&select=*&order=created_at.desc`)});
  if (p === "/sources" && method === "POST") {
    const username=String(body.username||"").trim().replace(/^@/,"").toLowerCase();
    if(!/^[a-z0-9._]{1,30}$/.test(username))return fail("Enter a valid Instagram username.");
    const rows=await db(env,"reference_accounts","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,username,enabled:true})});
    return json({source:rows?.[0]},201);
  }
  const sourceMatch=p.match(/^\/sources\/([0-9a-f-]+)$/);
  if(sourceMatch&&method==="DELETE"){
    if(!await owned(env,"reference_accounts",sourceMatch[1],ctx))return fail("Source not found.",404);
    await db(env,"reference_accounts",`?id=eq.${sourceMatch[1]}&${userFilter(ctx)}`,{method:"DELETE"});
    return json({ok:true});
  }
  if(p==="/memes"&&method==="GET")return json({memes:await db(env,"memes",`?${userFilter(ctx)}&select=*&order=created_at.desc&limit=100`)});
  if(p==="/memes/manual"&&method==="POST"){
    const text=String(body.extracted_text||"").trim();
    if(!text||text.length>2000)return fail("Meme text must be between 1 and 2000 characters.");
    const rows=await db(env,"memes","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,extracted_text:text,classification:"suitable",processing_status:"generated",asset_path:body.asset_path,asset_url:body.asset_url,source_type:"manual"})});
    return json({meme:rows?.[0]},201);
  }
  const approveMatch=p.match(/^\/memes\/([0-9a-f-]+)\/approve$/);
  if(approveMatch&&method==="POST"){
    const memeId=approveMatch[1];
    if(!await owned(env,"memes",memeId,ctx))return fail("Meme not found.",404);
    const decision=body.decision;
    if(!["approved","rejected"].includes(decision))return fail("Decision must be approved or rejected.");
    const accounts=await db(env,"instagram_accounts",`?${userFilter(ctx)}&select=id`);
    if(!accounts.length)return fail("Add a destination account before approving content.");
    const rows=await db(env,"account_meme_assignments","",{method:"POST",body:JSON.stringify(accounts.map((a:any)=>({owner_id:ctx.userId,meme_id:memeId,destination_account_id:a.id,approval_status:decision})))});
    return json({assignments:rows});
  }
  if(p==="/schedule"&&method==="GET")return json({items:await db(env,"account_meme_assignments",`?${userFilter(ctx)}&scheduled_at=not.is.null&select=*,memes(extracted_text),instagram_accounts(username)&order=scheduled_at.asc`)});
  if(p==="/publishing"&&method==="GET")return json({items:await db(env,"publishing_history",`?${userFilter(ctx)}&select=*,memes(extracted_text)&order=created_at.desc&limit=100`)});
  if(p==="/analytics"&&method==="GET"){
    const rows=await db(env,"publishing_history",`?${userFilter(ctx)}&status=eq.published&select=id`);
    return json({published:rows.length,reach:"Unavailable",impressions:"Unavailable",engagement:"Unavailable"});
  }
  if(p==="/health"&&method==="GET")return json({status:"ok",integrations:[
    {name:"Supabase",status:"Configured"},{name:"Apify",status:env.APIFY_API_TOKEN&&env.APIFY_ACTOR_ID?"Credentials set":"Needs configuration"},
    {name:"Groq",status:env.GROQ_API_KEY?"Credentials set":"Needs configuration"},{name:"Meta",status:env.META_APP_ID&&env.META_APP_SECRET?"Credentials set":"Needs configuration"}
  ]});
  if(p==="/settings"&&method==="PATCH"){
    await db(env,"user_settings","",{method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=representation"},body:JSON.stringify({owner_id:ctx.userId,global_paused:!!body.global_paused})});
    return json({ok:true});
  }
  if(p==="/discovery/run"&&method==="POST"){
    if(!env.APIFY_API_TOKEN||!env.APIFY_ACTOR_ID)return fail("Configure APIFY_API_TOKEN and APIFY_ACTOR_ID using Wrangler secrets first.",503);
    const sources=await db(env,"reference_accounts",`?${userFilter(ctx)}&enabled=eq.true&select=username`);
    if(!sources.length)return fail("Add at least one enabled reference account.");
    const input={usernames:sources.map((s:any)=>s.username),resultsLimit:20};
    const actor=encodeURIComponent(env.APIFY_ACTOR_ID);
    const start=await fetch(`https://api.apify.com/v2/acts/${actor}/runs?waitForFinish=0`,{method:"POST",headers:{"Authorization":`Bearer ${env.APIFY_API_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify(input)});
    const result:any=await start.json().catch(()=>({}));
    if(!start.ok)return fail(result.error?.message||"Apify actor could not be started.",502);
    const job=await db(env,"jobs","",{method:"POST",body:JSON.stringify({owner_id:ctx.userId,job_type:"discovery",status:"running",provider_run_id:result.data?.id,metadata:{dataset_id:result.data?.defaultDatasetId}})});
    return json({job_id:job?.[0]?.id,provider_run_id:result.data?.id},202);
  }
  return fail("Route not found.",404);
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url=new URL(req.url);
    if(url.pathname.startsWith("/api/")){
      const ctx=await auth(req,env);if(!ctx)return fail("Authentication required.",401);
      try{return await route(req,env,ctx,url)}catch(e:any){return fail(e.message||"Internal error",500)}
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // V1 scheduler entry point. Scheduled jobs are processed by the job runner in V1.1.
    // Never publish unless an approved assignment and a verified Meta connection exist.
  }
};
