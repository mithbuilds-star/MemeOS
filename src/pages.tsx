import { useEffect, useMemo, useRef, useState } from "react";
import { Select } from "./components/Select";
import { Activity, ArrowUpRight, BarChart3, Clapperboard, Check, CheckCircle2, Clock3, Download, ExternalLink, ImagePlus, Instagram, Loader2, Plus, RefreshCw, Settings2, Sparkles, Trash2, X } from "lucide-react";
import { supabase } from "./lib/supabase";
import { api } from "./lib/api";
import type { Meme } from "./lib/types";

function PageHead({ eyebrow, title, desc, action }: any) {
  return <div className="page-head"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1></div>{action}</div>;
}
function Stat({ label, value, note, icon: Icon }: any) {
  return <div className="stat-card"><div className="stat-top"><span>{label}</span><Icon size={17}/></div><strong>{value}</strong><small>{note}</small></div>;
}
function Empty({ title, text, action }: any) {
  return <div className="empty"><div className="empty-icon"><ImagePlus size={21}/></div><b>{title}</b><p>{text}</p>{action}</div>;
}
function Notice({ children, kind = "info" }: any) { return <div className={`notice ${kind}`}>{children}</div>; }


const helpArticles = [
  {id:"auto-fill",title:"Fill all approved posts in queue order",body:"Turn on Auto-post to fill all approved posts in queue order, cycling through daily posting slots across the rolling schedule until all approved posts have times.",keywords:"auto post auto-post fill queue approved posts order schedule all slots"},
  {id:"auto-pause",title:"Pause Auto-post without losing saved times",body:"Turn Auto-post off to pause automatic publishing. Existing auto-post times stay saved. They will not publish automatically while Auto-post is off. Use Schedule on a post when you want to activate that saved time manually.",keywords:"turn off disable pause stop auto-post keep retain preserve times not scheduled publish"},
  {id:"manual-schedule",title:"Schedule a post manually",body:"Choose a date and time on an approved post, then select Schedule. A manually scheduled post can publish even when Auto-post is off.",keywords:"manual schedule date time publish post"},
  {id:"posts-per-day",title:"Change Posts / day",body:"Use the Posts / day dropdown in Scheduler to choose how many posts Auto-post assigns each day.",keywords:"posts per day daily frequency dropdown 3x"},
  {id:"approve",title:"Approve content",body:"Open Approval Queue and approve the content you want to publish. Only approved assignments can be scheduled.",keywords:"approval queue approve meme content"},
  {id:"reels",title:"Prepare a Reel for publishing",body:"A Reel must finish rendering and have an enabled song selected before it can be scheduled.",keywords:"reel render song music audio ready"},
  {id:"captions",title:"Generate missing captions",body:"In Scheduler, use Generate missing captions. MemeOS uses the enabled Groq key and readable meme text to create short captions.",keywords:"caption generate missing groq ai"},
  {id:"accounts",title:"Connect an Instagram account",body:"Open Instagram, choose the destination account, and connect it using the Meta System User Access Token flow.",keywords:"instagram account connect meta token"},
  {id:"discovery",title:"Run meme discovery",body:"Open Discovery, configure reference sources, and run discovery to collect source posts for your workspace.",keywords:"discover scrape source reference apify"},
  {id:"songs",title:"Manage Reel songs",body:"Upload and enable tracks in Song Library. Enabled tracks can be mixed into generated Reels.",keywords:"song library upload enable track audio"},
  {id:"analytics",title:"Refresh analytics",body:"Open Analytics and select Sync Meta insights to request the latest available metrics.",keywords:"analytics insights metrics sync"}
];
export function Help() {
  const [query,setQuery]=useState("");
  const [result,setResult]=useState<any>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [searched,setSearched]=useState(false);
  const search=async(e?:React.FormEvent)=>{
    e?.preventDefault();const q=query.trim();if(!q)return;
    setBusy(true);setError("");setResult(null);setSearched(true);
    try{const r=await api("/help/search",{method:"POST",body:JSON.stringify({query:q,articles:helpArticles.map(({id,title,body})=>({id,title,body}))})});const found=helpArticles.find(a=>a.id===r.article_id);if(!found)throw new Error("No matching Help article was found. Try another wording.");setResult(found);}
    catch(err:any){setError(err.message||"Help search failed.");}
    finally{setBusy(false);}
  };
  return <><PageHead eyebrow="WORKSPACE GUIDE" title="Help"/><div className="panel help-panel"><form className="help-search" onSubmit={search}><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Ask in your own words…" aria-label="Search Help"/><button className="btn primary" type="submit" disabled={busy||!query.trim()}>{busy?"Searching…":"Search"}</button></form>{error&&<Notice kind="warn">{error}</Notice>}{result&&<article className="help-result"><div className="eyebrow">BEST MATCH</div><h3>{result.title}</h3><p>{result.body}</p><button className="btn secondary" onClick={()=>{const target=result.id==="auto-fill"||result.id==="auto-pause"||result.id==="posts-per-day"||result.id==="manual-schedule"?"/scheduler":result.id==="approve"?"/queue":result.id==="accounts"?"/instagram":result.id==="discovery"?"/discovery":result.id==="songs"?"/songs":result.id==="analytics"?"/analytics":"/scheduler";window.location.href=target;}}>Open page</button></article>}{searched&&!result&&!error&&<p>No matching help article.</p>}<div className="help-topics"><h3>Browse Help topics</h3>{helpArticles.map(a=><button key={a.id} onClick={()=>{setResult(a);setError("");setSearched(true)}}><span>{a.title}</span><span>›</span></button>)}</div></div></>;
}

export function Login({ configured }: { configured: boolean }) {
  const [mode, setMode] = useState<"login"|"signup">("login");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(""); setMessage(""); setBusy(true);
    try {
      if (!supabase) throw new Error("Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in Cloudflare Worker runtime variables first.");
      const result = mode === "login"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
      if (result.error) throw result.error;
      if (mode === "signup" && !result.data.session) setMessage("Check your email to confirm your account, then sign in.");
    } catch (e: any) { setError(e.message || "Authentication failed."); }
    finally { setBusy(false); }
  };
  return <div className="login-screen"><div className="login-card"><div className="brand login-brand"><div className="brand-mark"><Sparkles size={19}/></div><div><b>MemeOS</b><small>CONTENT OPERATIONS</small></div></div><div className="eyebrow">YOUR WORKSPACE</div><h1>{mode === "login" ? "Welcome back." : "Create your account."}</h1><p>Manage discovery, creation and publishing from one place.</p>
    {!configured && <Notice kind="warn">Supabase runtime config was not found. In Cloudflare → memeos → Settings → Variables, add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY, then redeploy.</Notice>}
    <form onSubmit={submit}><label>Email address<input type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></label><label>Password<input type="password" minLength={8} required value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 8 characters"/></label><button className="btn primary full" disabled={busy || !configured}>{busy ? <Loader2 className="spin" size={16}/> : null}{mode === "login" ? "Sign in" : "Create account"}</button></form>
    {error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}<div className="login-switch">{mode === "login" ? "New to MemeOS?" : "Already have an account?"} <button onClick={()=>setMode(mode==="login"?"signup":"login")}>{mode==="login"?"Create account":"Sign in"}</button></div>
  </div></div>;
}

export function Overview() {
  const [stats, setStats] = useState<any>(null); const [error,setError]=useState("");
  useEffect(()=>{ api("/overview").then(setStats).catch(e=>setError(e.message)); },[]);
  return <><PageHead eyebrow="OVERVIEW" title="Your content command center." desc="A live view of your meme discovery and publishing operations." action={<button className="btn secondary" onClick={()=>location.reload()}><RefreshCw size={15}/> Refresh</button>}/>
    {error && <Notice kind="warn">{error} — connect and apply the database migration to load live workspace data.</Notice>}
    <div className="stats-grid"><Stat label="Destination accounts" value={stats?.accounts ?? "—"} note="Connected Instagram accounts" icon={Instagram}/><Stat label="Scheduled memes" value={stats?.scheduled ?? "—"} note="Approved and ready to post" icon={Sparkles}/><Stat label="Pending approvals" value={stats?.pending ?? "—"} note="Waiting for your decision" icon={Clock3}/><Stat label="Published posts" value={stats?.published ?? "—"} note="Successful photo posts" icon={CheckCircle2}/></div>
    <div className="section-grid"><div className="panel"><div className="panel-head"><div><h3>Workflow</h3><p>From discovery through publishing</p></div></div><div className="workflow">{[["01","Discover source posts","Add reference accounts and run discovery"],["02","Extract and classify","OCR identifies text-only meme candidates"],["03","Create BRAT assets","Generate and store reusable PNG images"],["04","Approve and schedule","Choose destination accounts and publish"]].map(x=><div className="workflow-step" key={x[0]}><span>{x[0]}</span><div><b>{x[1]}</b><small>{x[2]}</small></div></div>)}</div></div>
    <div className="panel"><div className="panel-head"><div><h3>System status</h3><p>Integration readiness</p></div><Activity size={17}/></div><div className="status-list">{["Supabase","Apify","Groq","Meta Instagram API"].map((x,i)=><div key={x}><span>{x}</span><span className={`state ${i===0&&stats?"ok":"pending"}`}><i/>{i===0&&stats?"Connected":"Needs setup"}</span></div>)}</div><div className="panel-foot">Configure integrations in Settings to enable live workflows.</div></div></div>
  </>;
}

export function Accounts() {
  const [items,setItems]=useState<any[]>([]);const [username,setUsername]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [relationships,setRelationships]=useState<any[]>([]);const [parent,setParent]=useState("");const [child,setChild]=useState("");
  const load=()=>Promise.all([api("/accounts"),api("/relationships")]).then(([a,r])=>{setItems(a.accounts||[]);setRelationships(r.relationships||[])}).catch(e=>setError(e.message));
  useEffect(()=>{load()},[]);
  const add=async()=>{if(!username.trim())return;setBusy(true);setError("");try{await api("/accounts",{method:"POST",body:JSON.stringify({username:username.replace(/^@/,"")})});setUsername("");load()}catch(e:any){setError(e.message)}finally{setBusy(false)}};
  const toggle=async(a:any)=>{try{await api(`/accounts/${a.id}`,{method:"PATCH",body:JSON.stringify({discovery_enabled:!a.discovery_enabled})});load()}catch(e:any){setError(e.message)}};
  const togglePosting=async(a:any)=>{try{await api(`/accounts/${a.id}`,{method:"PATCH",body:JSON.stringify({posting_enabled:a.posting_enabled===false})});load()}catch(e:any){setError(e.message)}};
  const link=async()=>{setBusy(true);setError("");try{await api("/relationships",{method:"POST",body:JSON.stringify({parent_account_id:parent,child_account_id:child})});setParent("");setChild("");load()}catch(e:any){setError(e.message)}finally{setBusy(false)}};
  const unlink=async(id:string)=>{try{await api(`/relationships/${id}`,{method:"DELETE"});load()}catch(e:any){setError(e.message)}};
  const removeAccount=async(a:any)=>{if(!confirm(`Delete @${a.username} from MemeOS? This also removes its parent/child links, source assignments and pending destination assignments. This cannot be undone.`))return;setBusy(true);setError("");try{await api(`/accounts/${a.id}`,{method:"DELETE"});if(parent===a.id)setParent("");if(child===a.id)setChild("");await load()}catch(e:any){setError(e.message)}finally{setBusy(false)}};
  return <><PageHead eyebrow="DESTINATIONS" title="Accounts" desc="Manage Instagram destinations, discovery and posting."/><div className="panel"><div className="panel-head"><div><h3>Destination accounts</h3><p>Accounts that MemeOS can prepare content for.</p></div><span className="tag">{items.length} ACCOUNTS</span></div><div className="inline-form"><input value={username} onChange={e=>setUsername(e.target.value)} placeholder="Instagram username (without @)"/><button className="btn primary" onClick={add} disabled={busy}><Plus size={15}/> Add account</button></div>{error&&<Notice kind="error">{error}</Notice>}{items.length===0?<Empty title="No destination accounts yet" text="Add an Instagram username to create a workspace destination."/>:<div className="table-wrap"><table><thead><tr><th>ACCOUNT</th><th>CONNECTION</th><th>DISCOVERY</th><th>POSTING</th><th>META</th><th>CREATED</th><th></th></tr></thead><tbody>{items.map(a=><tr key={a.id}><td><b>@{a.username}</b><small>{a.display_name||"Instagram destination"}</small></td><td><span className={`state ${a.connection_status==="connected"?"ok":"pending"}`}><i/>{a.connection_status||"Not connected"}</span></td><td><button className={`switch ${a.discovery_enabled?"on":""}`} title="Toggle discovery" onClick={()=>toggle(a)}><i/></button></td><td><button className={`switch ${a.posting_enabled!==false?"on":""}`} title={a.posting_enabled===false?"Resume posting for this account":"Pause posting for this account"} onClick={()=>togglePosting(a)}><i/></button><small>{a.posting_enabled===false?"Paused":"Active"}</small></td><td><span className={`state ${a.connection_status==="connected"?"ok":"pending"}`}><i/>{a.connection_status==="connected"?"Connected":"Connect below"}</span></td><td>{new Date(a.created_at).toLocaleDateString()}</td><td><button className="btn small danger-outline" onClick={()=>removeAccount(a)} disabled={busy} title={`Delete @${a.username}`}><Trash2 size={13}/> Delete</button></td></tr>)}</tbody></table></div>}</div>
    <div className="panel" style={{marginTop:18}}><div className="panel-head"><div><h3>Parent account inheritance</h3><p>Each child can inherit from multiple parents. Cycles are blocked by the database.</p></div><span className="tag">{relationships.length} LINKS</span></div><div className="inline-form"><Select value={parent} onChange={setParent} placeholder="Select parent account" defaultValue="" defaultLabel="No parent selected" options={items.map((a:any)=>({value:a.id,label:"@"+a.username}))}/><Select value={child} onChange={setChild} placeholder="Select child account" defaultValue="" defaultLabel="No child selected" options={items.map((a:any)=>({value:a.id,label:"@"+a.username}))}/><button className="btn secondary" onClick={link} disabled={busy||!parent||!child||parent===child}><Plus size={15}/> Add inheritance</button></div>{relationships.length>0&&<div className="table-wrap"><table><thead><tr><th>PARENT</th><th>CHILD</th><th></th></tr></thead><tbody>{relationships.map(r=><tr key={r.id}><td>@{r.parent?.username||"—"}</td><td>@{r.child?.username||"—"}</td><td><button className="icon-btn danger" onClick={()=>unlink(r.id)}><Trash2 size={15}/></button></td></tr>)}</tbody></table></div>}</div>
    <InstagramDashboard embedded />
  </>;
}


export function InstagramDashboard({embedded=false}: {embedded?:boolean}) {
  const [accounts,setAccounts]=useState<any[]>([]);
  const [selected,setSelected]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const [accessToken,setAccessToken]=useState("");
  const [instagramAccountId,setInstagramAccountId]=useState("");
  const load=()=>api("/accounts").then(r=>{const rows=r.accounts||[];setAccounts(rows);setSelected(v=>v||rows[0]?.id||"");}).catch(e=>setError(e.message));
  useEffect(()=>{load()},[]);
  const connect=async()=>{
    if(!selected||!accessToken.trim())return;
    setBusy(true);setError("");setMessage("");
    try{const result=await api(`/accounts/${selected}/meta-connect`,{method:"POST",body:JSON.stringify({access_token:accessToken.trim(),instagram_account_id:instagramAccountId.trim()||undefined})});
      setAccessToken("");setInstagramAccountId("");setMessage(`Connected @${result.account?.username||accounts.find(a=>a.id===selected)?.username||"Instagram"}.`);await load();
    }catch(e:any){setError(e.message||"Meta could not validate this token.");}finally{setBusy(false);}
  };
  const content=<div className="panel" style={{marginTop:18}}>
    <div className="panel-head"><div><h3>Meta publishing connection</h3><p>Connect or replace the token used to publish for a destination account.</p></div><span className="tag">{accounts.filter(a=>a.connection_status==="connected").length} CONNECTED</span></div>
    {accounts.length===0?<Empty title="Add an account first" text="Create a destination account above before connecting its Meta token."/>:<>
      <label>Destination account<Select value={selected} onChange={setSelected} options={accounts.map(a=>({value:a.id,label:"@"+a.username+(a.connection_status==="connected"?" · Connected":" · Not connected")}))} searchable={false}/></label>
      <label>Meta System User Access Token<input type="password" autoComplete="off" value={accessToken} onChange={e=>setAccessToken(e.target.value)} placeholder="Paste your Meta access token"/></label>
      <label>Instagram Business Asset ID (optional)<input inputMode="numeric" value={instagramAccountId} onChange={e=>setInstagramAccountId(e.target.value)} placeholder="Numeric Instagram Business Asset ID"/></label>
      {error&&<Notice kind="error">{error}</Notice>}{message&&<Notice kind="success">{message}</Notice>}
      <button className="btn primary" onClick={connect} disabled={!selected||!accessToken.trim()||busy}>{busy?<Loader2 size={14} className="spin"/>:<CheckCircle2 size={14}/>} Verify and connect</button>
    </>}
  </div>;
  return embedded?content:<><PageHead eyebrow="ACCOUNTS" title="Accounts"/>{content}</>;
}


export function Discovery() {
  const [sources,setSources]=useState<any[]>([]);const [accounts,setAccounts]=useState<any[]>([]);const [maps,setMaps]=useState<any[]>([]);const [username,setUsername]=useState("");const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");const [jobs,setJobs]=useState<any[]>([]);const [mapAccount,setMapAccount]=useState("");const [mapSource,setMapSource]=useState("");const [settings,setSettings]=useState<any>(null);
  const load=()=>Promise.all([api("/sources"),api("/discovery/jobs"),api("/accounts"),api("/destination-sources"),api("/settings")]).then(([s,j,a,m,st])=>{setSources(s.sources||[]);setJobs(j.jobs||[]);setAccounts(a.accounts||[]);setMaps(m.items||[]);setSettings(st.settings||{})}).catch(e=>setMessage(e.message));
  useEffect(()=>{load();const t=setInterval(load,12000);return()=>clearInterval(t)},[]);
  const add=async()=>{setBusy(true);setMessage("");try{await api("/sources",{method:"POST",body:JSON.stringify({username:username.replace(/^@/,"")})});setUsername("");load()}catch(e:any){setMessage(e.message)}finally{setBusy(false)}};
  const run=async()=>{setBusy(true);setMessage("");try{const r=await api("/discovery/run",{method:"POST",body:"{}"});setMessage(`Started ${r.started||r.jobs?.length||1} source account discovery run(s). Datasets import automatically.`);load()}catch(e:any){setMessage(e.message)}finally{setBusy(false)}};
  const nextRun=()=>{if(!settings?.last_discovery_started_at)return null;const interval=Math.max(15,Number(settings.discovery_interval_minutes||60));return new Date(new Date(settings.last_discovery_started_at).getTime()+interval*60000);};
  const next=nextRun();
  const remove=async(id:string)=>{try{await api(`/sources/${id}`,{method:"DELETE"});load()}catch(e:any){setMessage(e.message)}};
  const toggle=async(s:any)=>{try{await api(`/sources/${s.id}`,{method:"PATCH",body:JSON.stringify({enabled:!s.enabled})});load()}catch(e:any){setMessage(e.message)}};
  const addMap=async()=>{setBusy(true);try{await api("/destination-sources",{method:"POST",body:JSON.stringify({destination_account_id:mapAccount,reference_account_id:mapSource})});setMapAccount("");setMapSource("");load()}catch(e:any){setMessage(e.message)}finally{setBusy(false)}};
  const removeMap=async(id:string)=>{try{await api(`/destination-sources/${id}`,{method:"DELETE"});load()}catch(e:any){setMessage(e.message)}};
  return <><PageHead eyebrow="CONTENT INTAKE" title="Discovery" desc="Manage global reference sources, account-specific sources and Apify runs." action={<button className="btn primary" onClick={run} disabled={busy}><RefreshCw size={15}/> Run discovery</button>}/>
    <div className="panel discovery-next-run"><div><b>Next discovery run</b><strong>{settings?.global_paused?"Paused":next?next.toLocaleTimeString([],{hour:"numeric",minute:"2-digit",hour12:true})+" · "+next.toLocaleDateString([],{weekday:"long",day:"2-digit",month:"2-digit",year:"numeric"}):"Not scheduled yet"}</strong></div><small>{settings?.global_paused?"Resume automation in Settings to continue.":("Runs every "+(settings?.discovery_interval_minutes||60)+" minutes.")}</small></div>
    <div className="panel"><div className="panel-head"><div><h3>Reference accounts</h3><p>Global sources are inherited by destinations unless an account has its own source mapping.</p></div><span className="tag">{sources.length} SOURCES</span></div><div className="inline-form"><input value={username} onChange={e=>setUsername(e.target.value)} placeholder="Reference username (without @)"/><button className="btn secondary" onClick={add} disabled={busy||!username.trim()}><Plus size={15}/> Add source</button></div>{message&&<Notice kind="info">{message}</Notice>}{sources.length===0?<Empty title="No sources configured" text="Add reference accounts first. An Apify API key and compatible actor are required."/>:<div className="table-wrap"><table><thead><tr><th>REFERENCE ACCOUNT</th><th>STATUS</th><th>LAST SCRAPED</th><th>ENABLED</th><th></th></tr></thead><tbody>{sources.map(s=><tr key={s.id}><td><b>@{s.username}</b></td><td>{s.last_scrape_status||"Ready"}</td><td>{s.last_scraped_at?new Date(s.last_scraped_at).toLocaleString():"Never"}</td><td><button className={`switch ${s.enabled?"on":""}`} onClick={()=>toggle(s)}><i/></button></td><td><button className="icon-btn danger" onClick={()=>remove(s.id)}><Trash2 size={15}/></button></td></tr>)}</tbody></table></div>}</div>
    <div className="panel" style={{marginTop:18}}><div className="panel-head"><div><h3>Account-specific sources</h3><p>When a destination has explicit sources, discovery is limited to those sources for that destination.</p></div><span className="tag">{maps.length} MAPPINGS</span></div><div className="inline-form"><Select value={mapAccount} onChange={setMapAccount} placeholder="Destination account" defaultValue="" defaultLabel="Choose destination" options={accounts.map((a:any)=>({value:a.id,label:"@"+a.username}))}/><Select value={mapSource} onChange={setMapSource} placeholder="Reference source" defaultValue="" defaultLabel="Choose source" options={sources.map((x:any)=>({value:x.id,label:"@"+x.username}))}/><button className="btn secondary" disabled={busy||!mapAccount||!mapSource} onClick={addMap}><Plus size={15}/> Assign source</button></div>{maps.length>0&&<div className="table-wrap"><table><thead><tr><th>DESTINATION</th><th>REFERENCE</th><th></th></tr></thead><tbody>{maps.map(m=><tr key={m.id}><td>@{m.instagram_accounts?.username||"—"}</td><td>@{m.reference_accounts?.username||"—"}</td><td><button className="icon-btn danger" onClick={()=>removeMap(m.id)}><Trash2 size={15}/></button></td></tr>)}</tbody></table></div>}</div>
    <div className="panel" style={{marginTop:18}}><div className="panel-head"><div><h3>Discovery runs</h3><p>Apify runs are checked automatically. Completed datasets are imported into the workspace without a manual step.</p></div><span className="tag">{jobs.length} RUNS</span></div>{jobs.length===0?<Empty title="No discovery runs yet" text="Start a discovery run to see its progress here."/>:<div className="table-wrap"><table><thead><tr><th>STARTED</th><th>STATUS</th><th>IMPORTED</th></tr></thead><tbody>{jobs.map(j=><tr key={j.id}><td>{new Date(j.created_at).toLocaleString()}</td><td>{j.status}{j.last_error&&<small>{j.last_error}</small>}</td><td>{j.metadata?.inserted??"—"}</td></tr>)}</tbody></table></div>}</div>
  </>;
}

function useMemes() { const [memes,setMemes]=useState<Meme[]>([]);const [error,setError]=useState("");const requested=useRef(0);const applied=useRef(0);const load=()=>{const mine=++requested.current;return api("/memes").then(r=>{if(mine>applied.current){applied.current=mine;setMemes(r.memes||[]);}}).catch(e=>{if(mine>applied.current)setError(e.message);});};useEffect(()=>{load();const timer=window.setInterval(load,15000);return()=>window.clearInterval(timer)},[]);return {memes,error,load}; }
export function Queue() {
  const {memes,error,load}=useMemes();const [busy,setBusy]=useState("");const [message,setMessage]=useState("");const [autoProcess,setAutoProcess]=useState(true);const [paused,setPaused]=useState(false);
  const [accounts,setAccounts]=useState<any[]>([]);const [targetAccount,setTargetAccount]=useState("");const [queueFormat,setQueueFormat]=useState<"all"|"posts"|"reels">("all");const [assignmentRows,setAssignmentRows]=useState<any[]>([]);
  const refreshAssignments=()=>api("/assignments").then(r=>setAssignmentRows(r.assignments||[])).catch(()=>{});
  useEffect(()=>{api("/settings").then(r=>{setPaused(!!r.settings?.global_paused);setAutoProcess(r.settings?.auto_process_enabled!==false)}).catch(()=>{});api("/accounts").then(r=>setAccounts(r.accounts||[])).catch(()=>{});refreshAssignments()},[]);
  const rejectFromQueue=async(m:any)=>{setBusy(m.id);setMessage("");try{await api(`/memes/${m.id}/reject`,{method:"POST",body:"{}"});setMessage("Rejected. Removed from the approval queue and the library.");load();refreshAssignments()}catch(e:any){setMessage(e.message)}finally{setBusy("")}};
  const decide=async(m:Meme,decision:string,format:"photo"|"reel"|"auto"="auto")=>{setBusy(m.id);try{await api(`/memes/${m.id}/approve`,{method:"POST",body:JSON.stringify({decision,publish_format:format,...(targetAccount?{account_id:targetAccount}:{})})});const label=targetAccount?` for @${accounts.find(a=>a.id===targetAccount)?.username||"selected account"}`:" for all destination accounts";setMessage(decision==="approved"?`Approved as ${format==="reel"?"Reel":"photo post"}${label}.`:`Rejected${label}.`);load();refreshAssignments()}catch(e:any){setMessage(e.message)}finally{setBusy("")}};
  const convert=async(m:any,format:"photo"|"reel")=>{setBusy(m.id);setMessage("");try{const r=await api(`/memes/${m.id}/format`,{method:"POST",body:JSON.stringify({format})});setMessage(format==="reel"&&!r.ready?"Reel render queued. It will show here when it is ready.":`Converted to ${format==="reel"?"reel":"photo post"}.`);load();}catch(e:any){setMessage(e.message)}finally{setBusy("")}};
  const process=async(m:any)=>{setBusy(m.id);setMessage("");try{const r=await api(`/memes/${m.id}/process`,{method:"POST",body:"{}"});setMessage(`Queued for server-side processing (${r.processing_status}). MemeOS will continue while you are offline.`);load()}catch(e:any){setMessage(e.message)}finally{setBusy("")}};
  const saveText=async(m:any,text:string)=>{setBusy(m.id);setMessage("");try{await api(`/memes/${m.id}`,{method:"PATCH",body:JSON.stringify({extracted_text:text})});setMessage("Edited text saved. Classification and BRAT asset regeneration queued.");load();refreshAssignments()}catch(e:any){setMessage(e.message)}finally{setBusy("")}};
  const candidates=memes.filter(m=>{if(['rejected','media_unavailable'].includes(m.processing_status||'')||m.classification==='rejected')return false;if(m.processing_status!=='generated')return false;const rows=assignmentRows.filter(a=>a.meme_id===m.id);if(targetAccount){const row=rows.find(a=>a.destination_account_id===targetAccount);return !row||row.approval_status==='pending';}return rows.length===0||rows.some(a=>a.approval_status==='pending');});
  const visibleCandidates=candidates.filter(m=>{if(queueFormat==="all")return true;const rows=assignmentRows.filter(a=>a.meme_id===m.id&&a.approval_status==="pending"&&(!targetAccount||a.destination_account_id===targetAccount));const formats=rows.map(a=>a.publish_format||a.memes?.output_format||a.memes?.publish_format).filter(Boolean);const reel=m.output_format==="reel"||!!m.reel_asset_url||["render_requested","rendering","render_failed","generated","ready"].includes(m.reel_status)||formats.includes("reel");return queueFormat==="reels"?reel:!reel;});
  return <><PageHead eyebrow="REVIEW WORKFLOW" title="Approval queue" desc="OCR, classification and BRAT generation run on the backend. Closing this dashboard does not stop processing."/><div className="panel"><div className="panel-head"><div><h3>Awaiting review</h3><p>{paused?"Global automation is paused. Pending content and schedules are preserved.":autoProcess?"Background processing is enabled. The Worker processes discoveries while you are offline.":"Automatic content processing is paused. Existing content is preserved."}</p></div><span className="tag">{visibleCandidates.length} ITEMS</span></div><div className="inline-form" style={{marginBottom:16}}><label style={{minWidth:240}}>Review destination<Select value={targetAccount} onChange={setTargetAccount} placeholder="All destination accounts" defaultValue="" defaultLabel="All destination accounts" options={accounts.map((a:any)=>({value:a.id,label:"@"+a.username}))}/></label><label style={{minWidth:180}}>Content type<Select value={queueFormat} onChange={(v:string)=>setQueueFormat(v as "all"|"posts"|"reels")} defaultValue="all" defaultLabel="All" options={[{value:"all",label:"All"},{value:"posts",label:"Posts"},{value:"reels",label:"Reels"}]}/></label></div>{message&&<Notice kind="info">{message}</Notice>}{error&&<Notice kind="warn">{error}</Notice>}{visibleCandidates.length===0?<Empty title="No matching content" text="There are no pending items for this destination and content type."/>:<div className="meme-grid">{visibleCandidates.map(m=><MemeCard key={m.id} meme={m} busy={busy===m.id} onProcess={()=>process(m)} onSaveText={(text:string)=>saveText(m,text)} onApprove={()=>decide(m,"approved","auto")} onConvert={(fmt:"photo"|"reel")=>convert(m,fmt)} onReject={()=>rejectFromQueue(m)} />)}</div>}</div></>;
}
function MemeCard({meme,busy,onApprove,onApproveReel,onReject,onProcess,onSaveText,onConvert,showCaption=false}:any){const [view,setView]=useState<"photo"|"reel">("photo");const [editing,setEditing]=useState(false);const [draft,setDraft]=useState(meme.extracted_text||"");useEffect(()=>setDraft(meme.extracted_text||""),[meme.extracted_text]);return <div className="meme-card"><div className="meme-preview">{meme.output_format==="reel"&&meme.reel_asset_url?<video src={meme.reel_asset_url} controls muted playsInline loop preload="metadata" style={{display:"block",width:"100%",height:"auto",borderRadius:8}}/>:meme.processing_status==="generated"&&meme.asset_url?<img src={meme.asset_url} style={{display:"block",width:"100%",height:"auto"}}/>:meme.source_asset_url?<><small style={{display:"block",marginBottom:4}}>Original post (review here)</small><img src={meme.source_asset_url} style={{display:"block",width:"100%",height:"auto"}}/></>:<span>{meme.processing_status==="ready_for_asset"?"Waiting for BRAT render":"Awaiting OCR and BRAT render"}</span>}</div><div className="meme-card-body"><b>{meme.source_username?`@${meme.source_username}`:"Manual meme"}</b><p>{meme.extracted_text||meme.original_caption||"Text not extracted yet."}</p>{showCaption&&meme.social_caption&&<small className="meme-caption" style={{display:"block",marginTop:6,opacity:.8}}>{meme.social_caption}</small>}{onSaveText&&<><button className="btn small secondary" onClick={()=>setEditing(!editing)}>{editing?"Close editor":"Edit extracted text"}</button>{editing&&<div style={{marginTop:8}}><textarea rows={4} value={draft} onChange={e=>setDraft(e.target.value)} maxLength={3000}/><button className="btn small primary" disabled={busy||!draft.trim()} onClick={()=>{onSaveText(draft);setEditing(false)}}>Save & reprocess</button></div>}</>}{meme.processing_error&&<small className="error-text">{meme.processing_error}</small>}<div className="meme-meta"><span>{meme.classification}</span><span>{meme.processing_status||"pending"}</span><span>{new Date(meme.created_at).toLocaleDateString()}</span></div><div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>{onProcess&&<button className="btn secondary small" onClick={onProcess} disabled={busy}>{busy?<Loader2 className="spin" size={14}/>:<Sparkles size={14}/>} {meme.processing_error||meme.reel_status==="render_failed"?"Retry":"Reprocess"}</button>}{onConvert&&<button className="btn secondary small" onClick={()=>onConvert(meme.output_format==="reel"?"photo":"reel")} disabled={busy}>{meme.output_format==="reel"?"Convert to post":"Convert to reel"}</button>}</div>{meme.reel_status==="render_failed"&&<small className="error-text">Reel render failed. Retry to render again.</small>}<div className="button-row">{onReject&&<button className="btn secondary small" onClick={onReject} disabled={busy}><X size={14}/> Reject</button>}{onApprove&&<button className="btn primary small" onClick={onApprove} disabled={busy||meme.processing_status!=="generated"||!meme.asset_url}><Check size={14}/> Approve</button>}{onApproveReel&&<button className="btn secondary small" onClick={onApproveReel} disabled={busy||meme.reel_status!=="generated"||!meme.reel_asset_url}><Clapperboard size={14}/> Approve Reel</button>}</div></div></div>}

export function Library() {
  const {memes,error,load}=useMemes();
  const [approved,setApproved]=useState<Set<string>>(new Set());
  useEffect(()=>{api("/assignments").then(r=>setApproved(new Set((r.assignments||[]).filter((a:any)=>a.approval_status==="approved").map((a:any)=>a.meme_id)))).catch(()=>{})},[memes]);
  const [filter,setFilter]=useState<"all"|"discovered"|"generated"|"errored">("all");
  const [contentType,setContentType]=useState<"all"|"posts"|"reels">("all");const [assignmentFormats,setAssignmentFormats]=useState<any[]>([]);
  useEffect(()=>{api("/assignments").then(r=>setAssignmentFormats(r.assignments||[])).catch(()=>{})},[memes]);
  const [busy,setBusy]=useState("");const [message,setMessage]=useState("");
  const isGenerated=(m:any)=>!!m.asset_url||m.processing_status==="generated"||m.source_type==="manual";
  const isDiscovered=(m:any)=>!isGenerated(m);
  const reject=async(m:any)=>{setBusy(m.id);setMessage("");try{await api(`/memes/${m.id}/reject`,{method:"POST",body:"{}"});setMessage("Rejected. Removed from the library and the approval queue.");load()}catch(e:any){setMessage(e.message)}finally{setBusy("")}};
  const saveText=async(m:any,text:string)=>{setBusy(m.id);setMessage("");try{await api(`/memes/${m.id}`,{method:"PATCH",body:JSON.stringify({extracted_text:text})});setMessage("Text saved. Processing again.");load()}catch(e:any){setMessage(e.message)}finally{setBusy("")}};
  const isErrored=(m:any)=>m.processing_status!=="rejected"&&m.classification!=="rejected"&&!approved.has(m.id)&&(["low_confidence","processing_failed","media_unavailable"].includes(m.processing_status)||!!m.processing_error||m.reel_status==="render_failed"||!m.extracted_text);
  const errored=memes.filter(isErrored);
  const baseShown=filter==="errored"?errored:memes.filter((m:any)=>approved.has(m.id)&&m.processing_status!=="rejected"&&m.classification!=="rejected").filter((m:any)=>filter==="all"||(filter==="discovered"?isDiscovered(m):isGenerated(m)));
  const shown=baseShown.filter((m:any)=>{if(contentType==="all")return true;const rows=assignmentFormats.filter(a=>a.meme_id===m.id);const formats=rows.map(a=>a.publish_format||a.memes?.output_format||a.memes?.publish_format).filter(Boolean);const reel=m.output_format==="reel"||!!m.reel_asset_url||["render_requested","rendering","render_failed","generated","ready"].includes(m.reel_status)||formats.includes("reel");return contentType==="reels"?reel:!reel;});
  const retry=async(m:any)=>{setBusy(m.id);setMessage("");try{const r=await api(`/memes/${m.id}/process`,{method:"POST",body:"{}"});setMessage(`Retry queued (${r.processing_status}).`);load()}catch(e:any){setMessage(e.message)}finally{setBusy("")}};
  return <><PageHead eyebrow="ASSET MANAGEMENT" title="Content library" desc="Your central collection of discovered and generated meme content."/><div className="panel"><div className="panel-head"><div><h3>{filter==="all"?"All content":filter==="discovered"?"Discovered content":filter==="generated"?"Generated content":"Errored content"}</h3><p>Reusable meme records and generated assets.</p></div><div className="library-filters"><Select value={contentType} onChange={(v:string)=>setContentType(v as any)} defaultValue="all" defaultLabel="All types" searchable={false} options={[{value:"all",label:"All types"},{value:"posts",label:"Posts"},{value:"reels",label:"Reels"}]}/><Select value={filter} onChange={(v:string)=>setFilter(v as any)} defaultValue="all" defaultLabel="All content" options={[{value:"all",label:"All content"},{value:"discovered",label:"Discovered content"},{value:"generated",label:"Generated content"},{value:"errored",label:"Errored content"}]}/><span className="tag">{shown.length} MEMES</span></div></div>{error&&<Notice kind="warn">{error}</Notice>}{message&&<Notice kind="success">{message}</Notice>}{shown.length===0?<Empty title="Nothing here yet" text="Run discovery or create your first meme to populate the library."/>:<div className="meme-grid">{shown.map((m:any)=><MemeCard key={m.id} meme={m} busy={busy===m.id} showCaption onReject={()=>reject(m)} onProcess={()=>retry(m)}/>)}</div>}</div></>;
}

export function Creator() {
  const [text,setText]=useState("");const [busy,setBusy]=useState(false);const [status,setStatus]=useState("");
  const draw=(canvas:HTMLCanvasElement|null)=>{if(!canvas)return;const ctx=canvas.getContext("2d");if(!ctx)return;canvas.width=1080;canvas.height=1080;ctx.fillStyle="#b7ff3c";ctx.fillRect(0,0,1080,1080);ctx.fillStyle="#111";ctx.textAlign="center";ctx.textBaseline="middle";ctx.font="700 48px Arial Narrow, Arial, sans-serif";const words=text.trim().split(/\s+/);const lines:string[]=[];let line="";for(const word of words){const test=line?`${line} ${word}`:word;if(ctx.measureText(test).width>900&&line){lines.push(line);line=word}else line=test;}if(line)lines.push(line);const lineHeight=60;const maxLines=Math.max(1,Math.floor(900/lineHeight));const visible=lines.slice(0,maxLines);visible.forEach((l,i)=>ctx.fillText(l,540,540-(visible.length-1)*lineHeight/2+i*lineHeight,900));};
  const canvasRef=(node:HTMLCanvasElement|null)=>draw(node);
  const save=async()=>{if(!text.trim())return;setBusy(true);setStatus("");try{const r=await api("/memes/manual",{method:"POST",body:JSON.stringify({extracted_text:text})});setStatus(`Added to the library. Backend BRAT video rendering has been queued (${r.meme?.id||"created"}). The photo JPEG will be extracted from the finished MP4.`)}catch(e:any){setStatus(e.message)}finally{setBusy(false)}};
  return <><PageHead eyebrow="CREATION STUDIO" title="Meme Creator" desc="Create text and send it to the backend BRAT video renderer. The photo JPEG comes from the final MP4 frame."/><div className="creator-layout"><div className="panel"><div className="panel-head"><div><h3>Canvas settings</h3><p>Text is preserved exactly as entered.</p></div><Settings2 size={17}/></div><label>Meme text<textarea rows={7} value={text} onChange={e=>setText(e.target.value)} maxLength={2000} placeholder="Type your meme text here..."/></label><button className="btn primary full" disabled={!text.trim()||busy} onClick={save}>{busy?<Loader2 className="spin" size={15}/>:<Download size={15}/>} Queue BRAT generation</button>{status&&<Notice kind="info">{status}</Notice>}</div><div className="panel preview-panel"><div className="panel-head"><div><h3>Live preview</h3><p>Approximate preview · final assets generated by the backend</p></div><span className="tag">BRAT STYLE</span></div><div className="canvas-wrap"><canvas id="brat-preview" ref={canvasRef}/></div></div></div></>;
}


export function Scheduler() {
  const [items,setItems]=useState<any[]>([]);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState("");
  const [times,setTimes]=useState<Record<string,{date:string;time:string}>>({});
  const [editingCaption,setEditingCaption]=useState<string|null>(null);
  const [captionDraft,setCaptionDraft]=useState("");
  const [autoPost,setAutoPost]=useState(false);
  const [postsPerDay,setPostsPerDay]=useState(3);
  const [autoBusy,setAutoBusy]=useState(false);
  const [captionBusy,setCaptionBusy]=useState(false);
  const [captionStatus,setCaptionStatus]=useState("");
  const [calendarOpen,setCalendarOpen]=useState<string|null>(null);
  const [calendarMonth,setCalendarMonth]=useState(new Date());
  const load=()=>api("/assignments").then(r=>setItems((r.assignments||[]).filter((x:any)=>x.status==="scheduled"||(x.approval_status==="approved"&&!x.scheduled_at&&!["published","rejected","failed","needs_review"].includes(x.status))))).catch(e=>setError(e.message));
  useEffect(()=>{load();api("/settings").then(r=>{setAutoPost(!!r.settings?.auto_post_enabled);setPostsPerDay(Math.max(1,Math.min(10,Number(r.settings?.posts_per_day||3))))}).catch(e=>setError(e.message));const timer=setInterval(load,15000);return()=>clearInterval(timer)},[]);
  const localDate=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")};
  const schedule=async(id:string)=>{setBusy(id);setError("");try{const value=times[id];if(!value?.date||!value?.time)throw new Error("Enter both a date and time.");const time=value.time.trim();if(!/^([01]?\\d|2[0-3]):[0-5]\\d$/.test(time))throw new Error("Enter time as HH:MM (24-hour), e.g. 18:17.");const normalized=time.length===4?"0"+time:time;const local=new Date(value.date+"T"+normalized+":00");if(Number.isNaN(local.getTime())||local.getTime()<=Date.now())throw new Error("Choose a future date and time.");await api("/assignments/"+id,{method:"PATCH",body:JSON.stringify({scheduled_at:local.toISOString()})});await load()}catch(e:any){setError(e.message)}finally{setBusy("")}};
  const cancel=async(id:string)=>{setBusy(id);setError("");try{await api("/assignments/"+id,{method:"PATCH",body:JSON.stringify({scheduled_at:null})});await load()}catch(e:any){setError(e.message)}finally{setBusy("")}};
  const activateSavedSchedule=async(item:any)=>{setBusy(item.id);setError("");try{await api("/assignments/"+item.id,{method:"PATCH",body:JSON.stringify({scheduled_at:item.scheduled_at})});await load()}catch(e:any){setError(e.message)}finally{setBusy("")}};
  const saveCaption=async(id:string)=>{setBusy(id);setError("");try{await api("/memes/"+id+"/caption",{method:"PATCH",body:JSON.stringify({social_caption:captionDraft})});setEditingCaption(null);await load()}catch(e:any){setError(e.message)}finally{setBusy("")}};  const missingCaptionIds=Array.from(new Set(items.filter(i=>!String(i.memes?.social_caption||"").trim()&&(String(i.memes?.extracted_text||"").trim()||String(i.memes?.original_caption||"").trim())).map(i=>i.meme_id)));
  const backfillCaptions=async()=>{if(captionBusy||!missingCaptionIds.length)return;setCaptionBusy(true);setCaptionStatus("");setError("");let total=0,remaining=missingCaptionIds.length,rounds=0,failed=false;try{while(remaining>0&&rounds<60){rounds++;const result=await api("/captions/backfill",{method:"POST",body:JSON.stringify({meme_ids:missingCaptionIds})});total+=Number(result.generated||0);remaining=Number(result.remaining||0);failed=failed||!!(result.failed?.length);setCaptionStatus("Generated "+total+" caption(s). "+remaining+" remaining…");if(!result.generated&&remaining>0){failed=true;break;}}await load();setCaptionStatus(total?"Generated "+total+" missing caption(s)."+(failed?" Some could not be generated; check the Groq key or meme text and retry.":remaining?" More posts remain; click again to continue.":""):"No captions were generated. Check that a Groq key is enabled and the memes have readable text.");}catch(e:any){setCaptionStatus(e.message||"Caption backfill failed.");}finally{setCaptionBusy(false);}};
  const buildAutoSlots=(queueCount:number,manualBookings:any[])=>{
    const ranked=[
      ["19:00","18:00","20:00","15:00","16:00","14:00","17:00","21:00","12:00","11:00"],
      ["19:00","15:00","17:00","16:00","18:00","14:00","13:00","20:00","21:00","12:00"],
      ["12:00","18:00","20:00","19:00","17:00","15:00","21:00","14:00","11:00","09:00"],
      ["09:00","08:00","07:00","13:00","12:00","14:00","18:00","19:00","20:00","17:00"],
      ["22:00","21:00","18:00","16:00","19:00","20:00","17:00","12:00","14:00","15:00"],
      ["21:00","22:00","20:00","17:00","18:00","19:00","15:00","12:00","14:00","16:00"],
      ["21:00","22:00","20:00","19:00","18:00","17:00","15:00","14:00","12:00","11:00"]
    ];
    const now=new Date(),slots:string[]=[];
    for(let offset=0;offset<366&&slots.length<queueCount;offset++){
      const dayDate=new Date(now.getFullYear(),now.getMonth(),now.getDate()+offset);
      const date=dayDate.getFullYear()+"-"+String(dayDate.getMonth()+1).padStart(2,"0")+"-"+String(dayDate.getDate()).padStart(2,"0");
      const booked=manualBookings.filter(i=>{const d=new Date(i.scheduled_at);return d.getFullYear()===dayDate.getFullYear()&&d.getMonth()===dayDate.getMonth()&&d.getDate()===dayDate.getDate()});
      const used=new Set(booked.map(i=>{const d=new Date(i.scheduled_at);return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")}));
      const remaining=Math.max(0,postsPerDay-booked.length);
      if(!remaining)continue;
      const candidates=ranked[dayDate.getDay()].filter(t=>{const candidate=new Date(date+"T"+t+":00");return candidate.getTime()>now.getTime()+60000&&!used.has(t)}).slice(0,remaining).sort();
      for(const time of candidates){slots.push(new Date(date+"T"+time+":00").toISOString());if(slots.length>=queueCount)break;}
    }
    return slots;
  };
  const toggleAuto=async()=>{
    if(autoBusy)return;
    setAutoBusy(true);setError("");
    try{
      if(!autoPost){
        const queue=items.filter(i=>i.approval_status==="approved"&&(!i.scheduled_at||i.auto_scheduled)&&!["published","rejected","failed","needs_review"].includes(i.status)).sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime());
        const manualBookings=items.filter(i=>i.scheduled_at&&!i.auto_scheduled);
        const slots=buildAutoSlots(queue.length,manualBookings);
        if(slots.length<queue.length)throw new Error("Could not find enough future posting slots for every approved post.");
        const oldAuto=items.filter(i=>i.scheduled_at&&i.auto_scheduled&&i.approval_status==="approved");
        for(const item of oldAuto)await api("/assignments/"+item.id,{method:"PATCH",body:JSON.stringify({scheduled_at:null})});
        if(queue.length){for(let start=0;start<queue.length;start+=5){const batch=queue.slice(start,start+5),batchSlots=slots.slice(start,start+5);await api("/scheduler/auto-fill",{method:"POST",body:JSON.stringify({assignment_ids:batch.map(i=>i.id),scheduled_at:batchSlots})});}}
        await api("/settings",{method:"PATCH",body:JSON.stringify({auto_post_enabled:true,posts_per_day:postsPerDay})});
        setAutoPost(true);await load();
      }else{
        await api("/settings",{method:"PATCH",body:JSON.stringify({auto_post_enabled:false,posts_per_day:postsPerDay})});
        setAutoPost(false);
      }
    }catch(e:any){setError(e.message||"Could not update auto-posting.")}
    finally{setAutoBusy(false)}
  };
  const chooseDate=(id:string,date:string)=>{setTimes(v=>({...v,[id]:{...(v[id]||{time:"18:00"}),date}}));setCalendarOpen(null)};
  const calendarDays=(month:Date)=>{const first=new Date(month.getFullYear(),month.getMonth(),1);const offset=first.getDay();return Array.from({length:42},(_,n)=>new Date(month.getFullYear(),month.getMonth(),n-offset+1))};
  return <><PageHead eyebrow="PUBLISHING WORKFLOW" title="Scheduler"/>
    <div className="panel scheduler-panel">
      <div className="panel-head scheduler-topbar">
        <div><h3>Approved content & upcoming schedule</h3></div>
        <div className="scheduler-auto-controls">
          <div className="posts-per-day"><span>POSTS / DAY</span><Select value={String(postsPerDay)} onChange={async(v:string)=>{const n=Number(v);setPostsPerDay(n);try{await api("/settings",{method:"PATCH",body:JSON.stringify({posts_per_day:n})})}catch(err:any){setError(err.message)}}} placeholder="Posts per day" defaultValue="3" defaultLabel="3×" searchable={false} options={Array.from({length:10},(_,i)=>({value:String(i+1),label:(i+1)+"×"}))}/></div>
          <button className={"auto-post-toggle "+(autoPost?"enabled":"")} onClick={toggleAuto} disabled={autoBusy}><span className="auto-toggle-track"><i/></span><span>{autoBusy?"Applying…":autoPost?"Auto-post on":"Auto-post off"}</span></button>
        </div>
      </div>
      <div className="scheduler-count-row"><span>{items.filter(i=>i.scheduled_at).length} scheduled</span><span>{items.filter(i=>i.approval_status==="approved"&&!i.scheduled_at).length} ready to schedule</span></div>
      {missingCaptionIds.length>0&&<div className="scheduler-caption-backfill"><span>{missingCaptionIds.length} post(s) missing captions</span><button className="btn small secondary" onClick={backfillCaptions} disabled={captionBusy}>{captionBusy?<Loader2 className="spin" size={14}/>:<Sparkles size={14}/>} {captionBusy?"Generating…":"Generate missing captions"}</button></div>}
      {captionStatus&&<Notice kind="info">{captionStatus}</Notice>}
      {error&&<Notice kind="warn">{error}</Notice>}
      {items.length===0?<Empty title="No approved content" text="Approve content in the queue and it will appear here for scheduling."/>:<div className="scheduler-list">{items.map(i=>{
        const value=times[i.id]||{date:"",time:"18:00"};
        const month=calendarMonth;
        const days=calendarDays(month);
        const selectedDate=value.date;
        return <article className={"schedule-card "+(calendarOpen===i.id?"calendar-open":"")} key={i.id}>
          <div className="schedule-card-main">
            <div className="schedule-meme-text">{i.memes?.extracted_text||"Meme"}</div>
            {i.memes?.social_caption&&<div className="schedule-caption">{i.memes.social_caption}</div>}
            {editingCaption===i.meme_id&&<div className="schedule-caption-editor"><input aria-label="Caption" value={captionDraft} maxLength={80} onChange={e=>setCaptionDraft(e.target.value)} placeholder="Short caption"/><div className="schedule-caption-actions"><button className="btn small primary" disabled={busy===i.meme_id} onClick={()=>saveCaption(i.meme_id)}>Save</button><button className="btn small secondary" onClick={()=>setEditingCaption(null)}>Cancel</button></div></div>}
            <div className="schedule-meta"><span>@{i.instagram_accounts?.username||"—"}</span><span>{i.publish_format==="reel"?"REEL":"PHOTO"}</span></div>
          </div>
          <div className="schedule-card-controls">
            {i.scheduled_at?<div className="scheduled-time"><span className="schedule-control-label">SCHEDULED FOR</span><strong>{new Date(i.scheduled_at).toLocaleString([], {dateStyle:"medium",timeStyle:"short"})}</strong>{i.auto_scheduled&&<small className="auto-scheduled-label">AUTO-POST SLOT</small>}</div>:<div className="schedule-picker">
              <div className="schedule-field calendar-field"><span className="schedule-control-label">DATE</span>
                <button className="calendar-trigger" onClick={()=>{setCalendarMonth(value.date?new Date(value.date+"T12:00:00"):new Date());setCalendarOpen(calendarOpen===i.id?null:i.id)}}>{value.date?new Date(value.date+"T12:00:00").toLocaleDateString([],{weekday:"short",month:"short",day:"numeric",year:"numeric"}):"Choose a date"}<span>▾</span></button>
                {calendarOpen===i.id&&<div className="calendar-popover">
                  <div className="calendar-heading"><button onClick={()=>setCalendarMonth(new Date(month.getFullYear(),month.getMonth()-1,1))} aria-label="Previous month">‹</button><b>{month.toLocaleDateString([],{month:"long",year:"numeric"})}</b><button onClick={()=>setCalendarMonth(new Date(month.getFullYear(),month.getMonth()+1,1))} aria-label="Next month">›</button></div>
                  <div className="calendar-grid calendar-weekdays">{["S","M","T","W","T","F","S"].map((d,n)=><span key={n}>{d}</span>)}</div>
                  <div className="calendar-grid">{days.map((d,n)=>{const key=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");const today=key===localDate();const past=key<localDate();return <button key={n} disabled={past} className={"calendar-day "+(d.getMonth()!==month.getMonth()?"outside ":"")+(today?"today ":"")+(selectedDate===key?"selected":"")} onClick={()=>chooseDate(i.id,key)}>{d.getDate()}</button>})}</div>
                </div>}
              </div>
              <div className="schedule-field"><span className="schedule-control-label">TIME</span><input type="text" inputMode="numeric" placeholder="HH:MM (e.g. 18:17)" maxLength={5} value={value.time} onChange={e=>setTimes(v=>({...v,[i.id]:{...value,time:e.target.value.replace(/[^0-9:]/g,"")}}))} aria-label="Type publishing time"/></div>
            </div>}
            <div className="schedule-actions"><button className="btn small secondary" disabled={busy===i.id||busy===i.meme_id} onClick={()=>{setEditingCaption(editingCaption===i.meme_id?null:i.meme_id);setCaptionDraft(i.memes?.social_caption||"")}}>Edit caption</button>{i.scheduled_at?<>{i.auto_scheduled&&!autoPost&&<button className="btn small primary" disabled={busy===i.id} onClick={()=>activateSavedSchedule(i)}>Schedule</button>}{i.auto_scheduled&&autoPost&&<span className="muted">Auto-post</span>}<button className="btn small secondary" disabled={busy===i.id} onClick={()=>cancel(i.id)}>Cancel schedule</button></>:<button className="btn small primary" disabled={busy===i.id||!value.date} onClick={()=>schedule(i.id)}>Schedule</button>}</div>
          </div>
        </article>
      })}</div>}
    </div>
  </>;
}

export function Publishing() {const [items,setItems]=useState<any[]>([]);const [error,setError]=useState("");useEffect(()=>{api("/publishing").then(r=>setItems(r.items||[])).catch(e=>setError(e.message))},[]);return <><PageHead eyebrow="DISTRIBUTION" title="Publishing" desc="A history of photo posts and Reels published through Meta."/><div className="panel"><div className="panel-head"><div><h3>Publishing history</h3><p>Official Meta API photo and Reel publishing attempts.</p></div></div>{error&&<Notice kind="warn">{error}</Notice>}{items.length===0?<Empty title="No publishing activity" text="Successful and failed publishing attempts will be listed here."/>:<div className="table-wrap"><table><thead><tr><th>CONTENT</th><th>STATUS</th><th>PUBLISHED</th><th>LINK</th></tr></thead><tbody>{items.map(i=><tr key={i.id}><td>{i.memes?.extracted_text||"Meme"}</td><td><b>{i.status}</b>{i.error_message&&<small className="error-text" style={{display:"block",maxWidth:360,whiteSpace:"normal"}}>{i.error_message}</small>}</td><td>{i.published_at?new Date(i.published_at).toLocaleString():"—"}</td><td>{i.permalink?<a href={i.permalink} target="_blank" rel="noreferrer">Open <ExternalLink size={12}/></a>:"—"}</td></tr>)}</tbody></table></div>}</div></>}

export function Analytics() {
  const [data,setData]=useState<any>(null); const [error,setError]=useState(""); const [busy,setBusy]=useState(false); const [message,setMessage]=useState("");
  const load=()=>api("/analytics").then(setData).catch((e:any)=>setError(e.message));
  useEffect(()=>{load()},[]);
  const sync=async()=>{setBusy(true);setError("");setMessage("");try{const r=await api("/analytics/sync",{method:"POST",body:"{}"});setMessage(`Sync finished: ${r.synced} item(s) updated, ${r.failed} failed.`);await load()}catch(e:any){setError(e.message)}finally{setBusy(false)}};
  const value=(v:any)=>v===null||v===undefined?"Unavailable":Number(v).toLocaleString();
  return <><PageHead eyebrow="PERFORMANCE" title="Analytics" desc="Metrics fetched from your connected Instagram professional accounts." action={<button className="btn primary" onClick={sync} disabled={busy}><Activity size={15}/>{busy?"Syncing…":"Sync Meta insights"}</button>}/>
    <div className="stats-grid"><Stat label="Published posts" value={data?.published??"—"} note="Tracked publishing records" icon={CheckCircle2}/><Stat label="Reach" value={value(data?.reach)} note="Instagram media insights" icon={Activity}/><Stat label="Views" value={value(data?.views)} note="Where Meta returns view counts" icon={BarChart3}/><Stat label="Engagement" value={data?.engagement===null||data?.engagement===undefined?"Unavailable":Number(data.engagement).toLocaleString()} note="Likes + comments + saves + shares" icon={Sparkles}/></div>
    <div className="stats-grid" style={{marginTop:14}}><Stat label="Likes" value={value(data?.likes)} note="Collected media totals" icon={CheckCircle2}/><Stat label="Comments" value={value(data?.comments)} note="Collected media totals" icon={Activity}/><Stat label="Saves" value={value(data?.saves)} note="Where available" icon={Check}/><Stat label="Shares" value={value(data?.shares)} note="Where available" icon={ArrowUpRight}/></div>
    {error&&<Notice kind="warn">{error}</Notice>}{message&&<Notice kind="success">{message}</Notice>}{data?.published>0&&!data?.last_synced_at&&<Notice kind="info">No Meta insights have been collected yet. Click Sync Meta insights to fetch the metrics Instagram makes available.</Notice>}</>;
}

export function Health() {const [data,setData]=useState<any>(null);useEffect(()=>{api("/health").then(setData).catch(()=>setData({status:"API unavailable",integrations:[]}))},[]);const names=["Supabase","Apify","Groq","Meta Graph API","Workers AI OCR","BRAT render service"];const notes=["Database and authentication","Source discovery provider","Text classification provider","Instagram publishing and insights","Server-side image text extraction","Progressive BRAT MP4, song mixing and final-frame PNG"];return <><PageHead eyebrow="OBSERVABILITY" title="System health" desc="Check service connectivity and background workflow readiness."/><div className="panel"><div className="panel-head"><div><h3>Integrations</h3><p>Credential presence is not the same as a verified connection.</p></div><Activity size={17}/></div>{names.map((x,i)=><div className="health-row" key={x}><div><b>{x}</b><small>{notes[i]}</small></div><span className={`state ${String(data?.integrations?.[i]?.status||"").toLowerCase().includes("ready")||String(data?.integrations?.[i]?.status||"").toLowerCase().includes("available")||String(data?.integrations?.[i]?.status||"").toLowerCase().includes("configured")?"ok":"pending"}`}><i/>{data?.integrations?.[i]?.status||"Needs configuration"}</span></div>)}</div></>}

export function SongLibrary() {
  const [songs,setSongs]=useState<any[]>([]); const [busy,setBusy]=useState(false); const [error,setError]=useState(""); const [message,setMessage]=useState("");
  const load=async()=>{if(!supabase)return;const {data:{user}}=await supabase.auth.getUser();if(!user)return;const {data,error}=await supabase.from("song_library").select("*").order("created_at",{ascending:false});if(error)throw error;const enriched=await Promise.all((data||[]).map(async(song:any)=>{const {data:signed}=await supabase!.storage.from("song-library").createSignedUrl(song.storage_path,3600);return {...song,preview_url:signed?.signedUrl||null}}));setSongs(enriched)};
  useEffect(()=>{load().catch(e=>setError(e.message))},[]);
  const upload=async(e:React.ChangeEvent<HTMLInputElement>)=>{const files=Array.from(e.target.files||[]);if(!files.length||!supabase)return;setBusy(true);setError("");setMessage("");let added=0;try{const {data:{user}}=await supabase.auth.getUser();if(!user)throw new Error("Sign in again.");for(const file of files){if(!file.type.startsWith("audio/"))throw new Error(`${file.name}: choose an audio file.`);if(file.size>30*1024*1024)throw new Error(`${file.name}: each song must be 30 MB or smaller.`);const path=`${user.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,"_")}`;const up=await supabase.storage.from("song-library").upload(path,file,{contentType:file.type,upsert:false});if(up.error)throw up.error;const row=await supabase.from("song_library").insert({owner_id:user.id,title:file.name.replace(/\.[^.]+$/, ""),original_filename:file.name,storage_path:path,mime_type:file.type,file_size:file.size,is_active:true}).select().single();if(row.error){await supabase.storage.from("song-library").remove([path]);throw row.error;}added++;}setMessage(`Added ${added} song${added===1?"":"s"} to your library.`);await load()}catch(err:any){setError(err.message||"Upload failed.")}finally{setBusy(false);e.target.value=""}};
  const toggle=async(song:any)=>{if(!supabase)return;const {error}=await supabase.from("song_library").update({is_active:!song.is_active}).eq("id",song.id);if(error)setError(error.message);else load()};
  const remove=async(song:any)=>{if(!supabase||!confirm(`Delete ${song.title}?`))return;setBusy(true);try{const a=await supabase.storage.from("song-library").remove([song.storage_path]);if(a.error)throw a.error;const b=await supabase.from("song_library").delete().eq("id",song.id);if(b.error)throw b.error;await load()}catch(e:any){setError(e.message)}finally{setBusy(false)}};
  return <><PageHead eyebrow="MEDIA LIBRARY" title="Song Library" desc="Upload tracks MemeOS can randomly assign to generated Reels." action={<label className="btn primary"><Plus size={15}/> Upload songs<input type="file" accept="audio/*" multiple hidden disabled={busy} onChange={upload}/></label>}/><div className="panel"><div className="panel-head"><div><h3>Your tracks</h3><p>Enabled tracks are eligible for random Reel audio selection. Tracks are not uploaded to Instagram separately; they are mixed into the generated MP4.</p></div><span className="tag">{songs.length} TRACKS</span></div>{error&&<Notice kind="error">{error}</Notice>}{message&&<Notice kind="success">{message}</Notice>}{songs.length===0?<Empty title="Your song library is empty" text="Upload audio files you have permission to use. MemeOS will choose randomly from enabled tracks."/>:<div className="table-wrap"><table><thead><tr><th>TRACK</th><th>SIZE</th><th>USED</th><th>STATUS</th><th>ACTIONS</th></tr></thead><tbody>{songs.map(song=><tr key={song.id}><td><b>{song.title}</b><small>{song.original_filename}</small>{song.preview_url&&<audio controls preload="none" src={song.preview_url} style={{display:"block",maxWidth:240,height:32,marginTop:6}}/>}</td><td>{(song.file_size/1048576).toFixed(1)} MB</td><td>{song.times_used||0}</td><td><span className={`state ${song.is_active?"ok":"pending"}`}><i/>{song.is_active?"Enabled":"Disabled"}</span></td><td><div className="button-row"><button className="btn small secondary" onClick={()=>toggle(song)}>{song.is_active?"Disable":"Enable"}</button><button className="icon-btn danger-btn" onClick={()=>remove(song)} disabled={busy}><Trash2 size={15}/></button></div></td></tr>)}</tbody></table></div>}</div></>;
}

export function SettingsPage() {
  const [paused,setPaused]=useState(false);
  const [autoProcess,setAutoProcess]=useState(true);
  const [freezeSeconds,setFreezeSeconds]=useState(2);
  const [discoveryInterval,setDiscoveryInterval]=useState(60);
  const [actorInput,setActorInput]=useState("{\n  \"resultsType\": \"posts\",\n  \"directUrls\": \"{{profile_urls}}\",\n  \"resultsLimit\": 20,\n  \"proxyConfiguration\": { \"useApifyProxy\": true }\n}");
  const [status,setStatus]=useState("");
  const [credentials,setCredentials]=useState<any[]>([]);
  const [provider,setProvider]=useState<"apify"|"groq">("apify");
  const [label,setLabel]=useState("");
  const [secret,setSecret]=useState("");
  const [actorId,setActorId]=useState("apify/instagram-scraper");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const load=()=>api("/api-credentials").then(r=>setCredentials(r.credentials||[])).catch(e=>setError(e.message));
  useEffect(()=>{load();api("/settings").then(r=>{setPaused(!!r.settings?.global_paused);setAutoProcess(r.settings?.auto_process_enabled!==false);setFreezeSeconds(Math.max(0,Math.min(5,Number(r.settings?.video_freeze_seconds??2))));setDiscoveryInterval(Number(r.settings?.discovery_interval_minutes??60))}).catch(()=>{})},[]);
  const save=async()=>{try{await api("/settings",{method:"PATCH",body:JSON.stringify({global_paused:paused,auto_process_enabled:autoProcess,video_freeze_seconds:freezeSeconds,discovery_interval_minutes:discoveryInterval})});setStatus("Settings saved.")}catch(e:any){setStatus(e.message)}};
  const add=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);setError("");setStatus("");try{await api("/api-credentials",{method:"POST",body:JSON.stringify({provider,label,secret,actor_id:actorId,actor_input:provider==="apify"?actorInput:{}})});setLabel("");setSecret("");setActorId("apify/instagram-scraper");setStatus(`${provider.toUpperCase()} key added and encrypted.`);await load()}catch(e:any){setError(e.message)}finally{setBusy(false)}};
  const test=async(id:string)=>{setBusy(true);setError("");setStatus("");try{const r=await api(`/api-credentials/${id}/test`,{method:"POST",body:"{}"});setStatus(r.message);await load()}catch(e:any){setError(e.message);await load()}finally{setBusy(false)}};
  const toggle=async(c:any)=>{try{await api(`/api-credentials/${c.id}`,{method:"PATCH",body:JSON.stringify({enabled:!c.enabled})});await load()}catch(e:any){setError(e.message)}};
  const remove=async(c:any)=>{if(!confirm(`Delete ${c.label}?`))return;try{await api(`/api-credentials/${c.id}`,{method:"DELETE"});await load()}catch(e:any){setError(e.message)}};
  return <>
    <PageHead eyebrow="CONFIGURATION" title="Settings" desc="Manage workflow controls and provider credentials from your workspace."/>
    <div className="settings-grid">
      <div className="panel"><div className="panel-head"><div><h3>Automation controls</h3><p>Pause new background work without deleting queue state.</p></div></div><div className="setting-row"><div><b>Global pause</b><small>Stop background discovery and scheduled publishing. Existing content and schedules are preserved.</small></div><button className={`switch ${paused?"on":""}`} onClick={()=>setPaused(!paused)}><i/></button></div><div className="setting-row"><div><b>Automatic content processing</b><small>Run OCR, classification and BRAT asset generation on the scheduled backend Worker, even when the dashboard is closed.</small></div><button className={`switch ${autoProcess?"on":""}`} onClick={()=>setAutoProcess(!autoProcess)}><i/></button></div><div className="setting-row"><div><b>Automatic discovery interval</b><small>How often MemeOS starts a new Apify discovery run for enabled destination accounts.</small></div><Select value={String(discoveryInterval)} onChange={(v:string)=>setDiscoveryInterval(Number(v))} defaultValue="60" defaultLabel="Every hour" options={[{value:"15",label:"Every 15 minutes"},{value:"30",label:"Every 30 minutes"},{value:"60",label:"Every hour"},{value:"120",label:"Every 2 hours"},{value:"360",label:"Every 6 hours"},{value:"720",label:"Every 12 hours"},{value:"1440",label:"Every 24 hours"}]}/></div><div className="setting-row"><div><b>Reel final-frame freeze</b><small>Hold the final BraText-style frame for {freezeSeconds.toFixed(1)} seconds at the end of every generated Reel (0–5 seconds).</small></div><b>{freezeSeconds.toFixed(1)}s</b></div><input aria-label="Reel final-frame freeze duration" type="range" min="0" max="5" step="0.5" value={freezeSeconds} onChange={e=>setFreezeSeconds(Number(e.target.value))} style={{width:"100%",margin:"0 0 18px"}}/><button className="btn primary" onClick={save}>Save settings</button>{status&&<Notice kind="success">{status}</Notice>}</div>
      <div className="panel api-manager"><div className="panel-head"><div><h3>API Manager</h3><p>Manage your Apify and Groq API keys.</p></div><span className="tag">PRIVATE</span></div>
        <form onSubmit={add} className="api-key-form">
          <label>Provider<Select value={provider} onChange={(v:string)=>{const next=v as "apify"|"groq";setProvider(next);if(next==="apify")setActorId("apify/instagram-scraper");}} defaultValue="apify" defaultLabel="Apify" options={[{value:"apify",label:"Apify"},{value:"groq",label:"Groq"}]}/></label>
          <label>Key name<input value={label} onChange={e=>setLabel(e.target.value)} required maxLength={60} placeholder={provider==="apify"?"Apify main":"Groq backup 1"}/></label>
          <label>API key<input type="password" autoComplete="new-password" value={secret} onChange={e=>setSecret(e.target.value)} required placeholder="Paste API key"/></label>
          {provider==="apify"&&<><label>Apify Actor ID<input value={actorId} onChange={e=>setActorId(e.target.value)} required placeholder="apify/instagram-scraper"/><small>Recommended default: Apify-maintained Instagram Scraper. Prefilled automatically; change only if you intentionally use another compatible Actor. <a href="https://apify.com/apify/instagram-scraper" target="_blank" rel="noreferrer">View Actor</a>.</small></label><label>Actor input JSON<textarea value={actorInput} onChange={e=>setActorInput(e.target.value)} rows={5} spellCheck={false}/><small>The default input automatically supplies profile URLs for selected reference accounts. Keep <code>{'{{profile_urls}}'}</code> in <code>directUrls</code> unless you are customizing the Actor input.</small></label></>}
          <button className="btn primary" disabled={busy||!label.trim()||!secret.trim()||(provider==="apify"&&!actorId.trim())}><Plus size={15}/> Add API key</button>
        </form>
        {error&&<Notice kind="error">{error}</Notice>}{status&&<Notice kind="success">{status}</Notice>}
        <div className="api-key-list"><div className="api-list-head"><b>Saved keys</b><span>{credentials.length} total</span></div>
          {credentials.length===0?<div className="api-empty">No API keys added yet. Add your first Apify or Groq key above.</div>:credentials.map(c=><div className="api-key-row" key={c.id}><div className="api-key-main"><div className="api-key-title"><b>{c.label}</b><span className="tag">{c.provider.toUpperCase()}</span></div><small>••••••••{c.key_hint||"••••"}{c.provider==="apify"&&c.actor_id?` · ${c.actor_id}`:""}</small><span className={`state ${c.status==="connected"?"ok":"pending"}`}><i/>{c.status==="rate_limited"?"Rate limited":c.status||"Untested"}{c.last_tested_at?` · tested ${new Date(c.last_tested_at).toLocaleString()}`:""}</span></div><div className="api-key-actions"><button className="btn small secondary" onClick={()=>test(c.id)} disabled={busy}>Test</button><button className={`switch ${c.enabled?"on":""}`} title={c.enabled?"Disable key":"Enable key"} onClick={()=>toggle(c)}><i/></button><button className="icon-btn danger-btn" title="Delete key" onClick={()=>remove(c)}><Trash2 size={15}/></button></div></div>)}
        </div>
      </div>
    </div>
  </>;
}

export function Pipeline() {
  const [data,setData]=useState<any>(null);const [error,setError]=useState("");const [message,setMessage]=useState("");const [busy,setBusy]=useState("");
  const load=()=>{api("/pipeline").then(setData).catch(e=>setError(e.message))};
  useEffect(()=>{load();const t=setInterval(load,15000);return ()=>clearInterval(t)},[]);
  const retryAll=async()=>{setBusy("all");setMessage("");try{const r=await api("/pipeline/retry",{method:"POST",body:"{}"});setMessage(r.requeued+r.reel_requeued===0?"Nothing to retry. Every unfinished item is waiting on something else, see the WHY column.":`Requeued ${r.requeued} item(s) and ${r.reel_requeued} reel render(s). They run on the next cron tick.`);load()}catch(e:any){setMessage(e.message)}finally{setBusy("")}};
  const discardOne=async(id:string)=>{setBusy(id);setMessage("");try{await api(`/memes/${id}/discard`,{method:"POST",body:"{}"});setMessage("Discarded.");load()}catch(e:any){setMessage(e.message)}finally{setBusy("")}};
  const retryOne=async(id:string)=>{setBusy(id);setMessage("");try{const r=await api(`/memes/${id}/process`,{method:"POST",body:"{}"});setMessage(`Queued ${id.slice(0,8)} at ${r.processing_status}.`);load()}catch(e:any){setMessage(e.message)}finally{setBusy("")}};
  const stages:any[]=data?.stages||[];const running:any[]=data?.running||[];const queued:any[]=data?.queued||[];
  const rendererOk=data?.renderer==="github_actions";
  const who=(m:any)=>m.source_username?`@${m.source_username}`:"Manual";
  const bar={height:10,background:"#e5e5e5",borderRadius:6,overflow:"hidden"} as const;
  return <>
    <PageHead eyebrow="OPERATIONS" title="Pipeline" desc="What is running now, what is queued, and the render service's live log. Refreshes every 15 seconds."/>
    {error&&<Notice kind="error">{error}</Notice>}
    {message&&<Notice kind="info">{message}</Notice>}
    <div className="panel">
      <div className="panel-head"><div><h3>Progress</h3><p>Items being processed right now.</p></div><span className={`state ${rendererOk?"ok":"pending"}`}><i/>Renderer: {data?.renderer||"checking"}</span></div>
      {running.length===0?<p style={{margin:"8px 0 14px",opacity:.7}}>Nothing is running right now.</p>:running.map((m:any)=><div key={m.id} style={{marginBottom:14}}><div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}><b>{who(m)}</b><span>{m.step}</span></div><div style={bar}><div style={{width:"40%",height:"100%",background:"#7c3aed",borderRadius:6,animation:"memeos-slide 1.2s ease-in-out infinite"}}/></div></div>)}
      <style>{`@keyframes memeos-slide{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}`}</style>
      <div className="inline-form"><button className="btn primary" onClick={retryAll} disabled={busy==="all"}>{busy==="all"?<Loader2 className="spin" size={14}/>:<RefreshCw size={14}/>} Retry all stuck items</button><button className="btn secondary" onClick={load}><RefreshCw size={14}/> Refresh now</button></div>
    </div>
    <div className="panel" style={{marginTop:18}}>
      <div className="panel-head"><div><h3>Running now</h3><p>Items a worker is processing at this moment.</p></div><span className="tag">{running.length} RUNNING</span></div>
      {running.length===0?<Empty title="Nothing running" text="No item is being processed right now."/>:<div className="table-wrap"><table><thead><tr><th>ITEM</th><th>STEP</th><th>ATTEMPTS</th></tr></thead><tbody>{running.map((m:any)=><tr key={m.id}><td><b>{who(m)}</b><small>{(m.extracted_text||"").slice(0,60)}</small></td><td>{m.step}</td><td>{m.processing_attempts??0}</td></tr>)}</tbody></table></div>}
    </div>
    <div className="panel" style={{marginTop:18}}>
      <div className="panel-head"><div><h3>Queued</h3><p>Waiting for the next cron tick (runs every minute).</p></div><span className="tag">{queued.length} QUEUED</span></div>
      {queued.length===0?<Empty title="Queue is empty" text="Nothing is waiting to be processed."/>:<div className="table-wrap"><table><thead><tr><th>ITEM</th><th>NEXT STEP</th></tr></thead><tbody>{queued.map((m:any)=><tr key={m.id}><td><b>{who(m)}</b><small>{(m.extracted_text||"No text yet").slice(0,60)}</small></td><td>{m.step}</td></tr>)}</tbody></table></div>}
    </div>
    <div className="panel" style={{marginTop:18}}>
      <div className="panel-head"><div><h3>Render runs</h3><p>Each video renders as a GitHub Actions job with its own logs.</p></div></div>
      <a href="https://github.com/mithbuilds-star/MemeOS/actions/workflows/render-meme.yml" target="_blank" rel="noreferrer">Open render-meme runs on GitHub</a>
    </div>
    <div className="panel" style={{marginTop:18}}>
      <div className="panel-head"><div><h3>Not finished</h3><p>Each item and why it is not done yet. Retry one or all.</p></div><span className="tag">{data?.items?.length??0} ITEMS</span></div>
      {!data||data.items?.length===0?<Empty title="Nothing stuck" text="Every item is either generated or rejected."/>:<div className="table-wrap"><table><thead><tr><th>ITEM</th><th>STAGE</th><th>WHY</th><th>ATTEMPTS</th><th></th></tr></thead><tbody>{data.items.map((m:any)=><tr key={m.id}><td><b>{who(m)}</b><small>{(m.extracted_text||"No text yet").slice(0,80)}</small></td><td>{m.processing_status}{m.reel_status&&<small>reel: {m.reel_status}</small>}</td><td><small>{m.why}</small></td><td>{m.processing_attempts??0} <small>{m.processing_same_error_count??0}/3 same · {m.processing_consecutive_errors??0}/5 total errors</small></td><td><button className="btn small secondary" onClick={()=>retryOne(m.id)} disabled={busy===m.id}>{busy===m.id?<Loader2 className="spin" size={13}/>:<RefreshCw size={13}/>} Retry</button><button className="btn secondary small" style={{marginLeft:6}} disabled={busy===m.id} onClick={()=>{if(!confirm("Discard this item? It will not be retried."))return;discardOne(m.id)}}><X size={14}/> Discard</button></td></tr>)}</tbody></table></div>}
    </div>
  </>;
}


export function PipelineStage({ stage }: { stage: string }) {
 const [data,setData]=useState<any>(null); const [error,setError]=useState("");
 useEffect(()=>{api("/pipeline").then(setData).catch(e=>setError(e.message));},[]);
 const meta=(data?.flow||[]).find((x:any)=>x.key===stage); const rows:any[]=data?.flowRecords||[]; const assignments:any[]=data?.flowAssignments||[];
 const terminal=(m:any)=>["discarded","media_unavailable","low_confidence"].includes(m.processing_status||"")||m.classification==="low_confidence";
 const forMeme=(id:string)=>assignments.filter((a:any)=>a.meme_id===id);
 let matches:any[]=rows;
 if(stage==="to_process") matches=rows.filter((m:any)=>(["needs_ocr","ocr_complete","ready_for_asset","failed","processing_failed"].includes(m.processing_status)||["render_failed","renderer_not_configured","render_requested"].includes(m.reel_status||""))&&!terminal(m));
 else if(stage==="processing") matches=rows.filter((m:any)=>["needs_ocr","ocr_complete","ready_for_asset"].includes(m.processing_status)&&((m.processing_locked_until&&new Date(m.processing_locked_until)>new Date())||(m.reel_render_locked_until&&new Date(m.reel_render_locked_until)>new Date())));
 else if(stage==="processed") matches=rows.filter((m:any)=>m.processing_status==="generated");
 else if(stage==="approval") matches=rows.filter((m:any)=>m.processing_status==="generated"&&forMeme(m.id).some((a:any)=>a.approval_status==="pending"));
 else if(stage==="scheduled") matches=rows.filter((m:any)=>forMeme(m.id).some((a:any)=>a.status==="scheduled"));
 else if(stage==="published") matches=rows.filter((m:any)=>forMeme(m.id).some((a:any)=>a.status==="published"));
 else if(stage==="rejected") matches=rows.filter((m:any)=>m.processing_status==="rejected"||forMeme(m.id).some((a:any)=>a.approval_status==="rejected"));
 else if(stage==="discarded") matches=rows.filter((m:any)=>m.processing_status==="discarded");
 else if(stage==="media_unavailable") matches=rows.filter((m:any)=>m.processing_status==="media_unavailable");
 else if(stage==="low_confidence") matches=rows.filter((m:any)=>m.processing_status==="low_confidence"||m.classification==="low_confidence");
 else if(stage==="discovered") matches=rows;
 else matches=[];
 return <><PageHead eyebrow="PIPELINE / STAGE DETAILS" title={meta?.label||"Stage details"} desc={meta?.detail||"Memes in this pipeline stage."} action={<button className="btn secondary" onClick={()=>window.location.href="/pipeline"}>Back to Pipeline</button>}/>{error&&<Notice kind="error">{error}</Notice>}<div className="panel"><div className="panel-head"><div><h3>{matches.length} memes</h3><p>Memes currently matching this stage.</p></div><span className="tag">{meta?.count??matches.length} COUNT</span></div>{!data?<p>Loading…</p>:matches.length===0?<Empty title="No memes in this stage" text="There are currently no matching items."/>:<div className="table-wrap"><table><thead><tr><th>MEME</th><th>PROCESSING</th><th>DESTINATIONS</th><th>CREATED</th></tr></thead><tbody>{matches.map((m:any)=><tr key={m.id}><td><b>{m.source_username?"@"+m.source_username:"Manual"}</b><small>{(m.extracted_text||m.processing_error||"No extracted text").slice(0,110)}</small><small>{m.id}</small></td><td>{m.processing_status}{m.reel_status&&<small>Reel: {m.reel_status}</small>}</td><td>{forMeme(m.id).map((a:any)=>a.approval_status+(a.status&&a.status!=="pending"?" · "+a.status:"")).join(", ")||"—"}</td><td>{m.created_at?new Date(m.created_at).toLocaleString():"—"}</td></tr>)}</tbody></table></div>}</div></>;
}


export function ActivityLog() {
  const [items,setItems]=useState<any[]>([]);const [error,setError]=useState("");const [loading,setLoading]=useState(true);
  const load=()=>api("/activity").then(r=>{setItems(r.logs||[]);setError("");}).catch((e:any)=>setError(e.message)).finally(()=>setLoading(false));
  useEffect(()=>{load();const timer=window.setInterval(load,15000);return()=>window.clearInterval(timer);},[]);
  const content=<div className="panel">
    <div className="panel-head"><div><h3>Recent activity</h3><p>Major pipeline events and activity from your workspace.</p></div><div style={{display:"flex",alignItems:"center",gap:10}}><span className="tag">{items.length} events</span><button className="btn small secondary" onClick={load}><Activity size={13}/> Refresh</button></div></div>
    {error&&<Notice kind="warn">{error}</Notice>}
    {loading?<p>Loading activity…</p>:items.length===0?<Empty title="No activity recorded yet" text="New batch events will appear here as the pipeline runs."/>:<div className="activity-log-table-wrap"><table className="activity-log-table"><thead><tr><th>Event</th><th>Details</th><th>Time</th></tr></thead><tbody>{items.map((item:any)=><tr key={item.id}><td><b>{String(item.event_type||"event").replace(/^historical_/,"").replace(/_/g," ").replace(/^./,c=>c.toUpperCase())}</b></td><td>{item.message}{item.metadata?.count!=null&&<small>{item.metadata.count} items</small>}</td><td>{new Date(item.created_at).toLocaleString()}</td></tr>)}</tbody></table></div>}
    <div className="panel-foot">Older entries are summaries based on saved discovery, meme and assignment records.</div>
  </div>;
  return <><PageHead eyebrow="WORKSPACE" title="Activity log" desc="Major pipeline events and activity from your workspace."/>{content}</>;
}
