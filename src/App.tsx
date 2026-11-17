import { useEffect, useRef, useState } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate, useParams } from "react-router-dom";
import {
  BarChart3, CalendarDays, CheckCheck, Clapperboard, Command, Compass, Database, FileImage, GitBranch, History, HeartPulse, LayoutDashboard,
  LogOut, Menu, Moon, Settings, Sun, Users, Workflow, X
} from "lucide-react";
import { initializeSupabase, supabase } from "./lib/supabase";
import { Overview, Accounts, Discovery, Queue, Library, Creator, Scheduler, Publishing, Analytics, Health, SettingsPage, SongLibrary, Login, Pipeline, PipelineStage, ActivityLog } from "./pages";

const nav = [
  ["Overview", "/", LayoutDashboard], ["Accounts", "/accounts", Users],
  ["Discovery", "/discovery", Compass], ["Approval Queue", "/queue", CheckCheck],
  ["Content Library", "/library", Database], ["Song Library", "/songs", FileImage], ["Meme Creator", "/creator", Clapperboard],
  ["Scheduler", "/scheduler", CalendarDays], ["Publishing", "/publishing", Workflow],
  ["Analytics", "/analytics", BarChart3], ["System Health", "/health", HeartPulse], ["Activity Log", "/activity", History], ["Pipeline", "/pipeline", GitBranch],
  ["Settings", "/settings", Settings]
] as const;

export default function App() {
  const [session, setSession] = useState<any>(null);
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem("memeos-theme") || "dark");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!profileOpen) return;
    const close = (event: MouseEvent) => { if (profileRef.current && !profileRef.current.contains(event.target as Node)) setProfileOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [profileOpen]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("memeos-theme", theme);
  }, [theme]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    initializeSupabase().then(async (client) => {
      if (!active) return;
      setConfigured(!!client);
      if (!client) {
        setReady(true);
        return;
      }
      const { data } = await client.auth.getSession();
      if (!active) return;
      setSession(data.session);
      const listener = client.auth.onAuthStateChange((_event, nextSession) => {
        if (active) setSession(nextSession);
      });
      unsubscribe = () => listener.data.subscription.unsubscribe();
      setReady(true);
    }).catch(() => {
      if (active) { setConfigured(false); setReady(true); }
    });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  if (!ready) return <div className="boot">MEMEOS <span>Loading workspace…</span></div>;
  if (!session) return <Login configured={configured} />;

  const logout = async () => {
    // Clear the local session immediately so a failed network sign-out cannot
    // trap the user in an authenticated-looking workspace.
    setSession(null);
    try {
      await supabase?.auth.signOut({ scope: "local" });
    } finally {
      navigate("/", { replace: true });
    }
  };

  return <div className={`app-shell ${collapsed ? "collapsed" : ""}`}>
    <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
      <div className="brand"><div className="brand-mark"><Command size={19}/></div>{!collapsed && <div><b>MemeOS</b><small>CONTENT OPERATIONS</small></div>}<button className="icon-btn mobile-close" onClick={() => setMobileOpen(false)}><X size={17}/></button></div>
      <nav>{nav.map(([label, path, Icon]) => <NavLink key={path} to={path} end={path === "/"} onClick={() => setMobileOpen(false)} title={collapsed ? label : undefined}><Icon size={17}/>{!collapsed && <span>{label}</span>}</NavLink>)}</nav>

    </aside>
    <main className="main-area">
      <header className="topbar">
        <button className="icon-btn menu-btn" onClick={() => setMobileOpen(true)}><Menu size={19}/></button>
        <div className="topbar-spacer"/>
        <div className="top-actions">
          <button className="icon-btn" title="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={17}/> : <Moon size={17}/>}</button>
          <div className="profile-menu-wrap" ref={profileRef}>
            <button className="avatar profile-avatar" aria-label="Open account menu" aria-expanded={profileOpen} onClick={() => setProfileOpen(v => !v)}>{session.user?.email?.[0]?.toUpperCase() || "M"}</button>
            {profileOpen && <div className="profile-menu">
              <div className="profile-menu-user">{session.user?.email || "Signed in"}</div>
              <button onClick={() => {setProfileOpen(false);navigate("/settings");}}><Settings size={15}/> Account settings</button>
              <button className="profile-signout" onClick={() => {setProfileOpen(false);logout();}}><LogOut size={15}/> Sign out</button>
            </div>}
          </div>
        </div>
      </header>
      <div className="page-wrap"><Routes>
        <Route path="/" element={<Overview/>}/><Route path="/accounts" element={<Accounts/>}/><Route path="/instagram" element={<Navigate to="/accounts" replace/>}/>
        <Route path="/discovery" element={<Discovery/>}/><Route path="/queue" element={<Queue/>}/>
        <Route path="/library" element={<Library/>}/><Route path="/songs" element={<SongLibrary/>}/><Route path="/creator" element={<Creator/>}/>
        <Route path="/scheduler" element={<Scheduler/>}/><Route path="/publishing" element={<Publishing/>}/>
        <Route path="/analytics" element={<Analytics/>}/><Route path="/health" element={<Health/>}/><Route path="/activity" element={<ActivityLog/>}/><Route path="/pipeline" element={<Pipeline/>}/><Route path="/pipeline/:stage" element={<PipelineStageRoute/>}/>
        <Route path="/settings" element={<SettingsPage/>}/><Route path="*" element={<Navigate to="/" replace/>}/>
      </Routes></div>
    </main>
  </div>;
}

function PipelineStageRoute() { const { stage = "" } = useParams(); return <PipelineStage stage={stage} />; }
