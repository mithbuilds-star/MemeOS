import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import {
  Activity, BarChart3, CalendarDays, CheckCheck, ChevronDown, CircleHelp,
  Clapperboard, Command, Compass, Database, FileImage, LayoutDashboard,
  LogOut, Menu, Moon, Plus, Search, Settings, ShieldCheck, Sun, Users,
  Workflow, X
} from "lucide-react";
import { initializeSupabase, supabase } from "./lib/supabase";
import { Overview, Accounts, Discovery, Queue, Library, Creator, Scheduler, Publishing, Analytics, Health, SettingsPage, SongLibrary, Login } from "./pages";

const nav = [
  ["Overview", "/", LayoutDashboard], ["Accounts", "/accounts", Users],
  ["Discovery", "/discovery", Compass], ["Approval Queue", "/queue", CheckCheck],
  ["Content Library", "/library", Database], ["Song Library", "/songs", FileImage], ["Meme Creator", "/creator", Clapperboard],
  ["Scheduler", "/scheduler", CalendarDays], ["Publishing", "/publishing", Workflow],
  ["Analytics", "/analytics", BarChart3], ["System Health", "/health", Activity],
  ["Settings", "/settings", Settings]
] as const;

export default function App() {
  const [session, setSession] = useState<any>(null);
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem("memeos-theme") || "dark");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();

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
      <div className="workspace-label">{!collapsed && "WORKSPACE"}</div>
      <nav>{nav.map(([label, path, Icon]) => <NavLink key={path} to={path} end={path === "/"} onClick={() => setMobileOpen(false)} title={collapsed ? label : undefined}><Icon size={17}/>{!collapsed && <span>{label}</span>}{path === "/queue" && !collapsed && <em className="nav-count">—</em>}</NavLink>)}</nav>
      <div className="sidebar-bottom">
        <div className="plan-card">{!collapsed && <><span className="status-dot"/> <div><b>V1 workspace</b><small>Core operations</small></div></>}</div>
        <button className="nav-link logout" onClick={logout}><LogOut size={17}/>{!collapsed && "Sign out"}</button>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar">
        <button className="icon-btn menu-btn" onClick={() => setMobileOpen(true)}><Menu size={19}/></button>
        <div className="crumb"><span>Workspace</span><ChevronDown size={13}/><b>{nav.find(n => n[1] === location.pathname)?.[0] || "MemeOS"}</b></div>
        <div className="top-actions">
          <span className="connection-pill"><i/> V1</span>
          <button className="icon-btn" title="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={17}/> : <Moon size={17}/>}</button>
          <div className="avatar">{session.user?.email?.[0]?.toUpperCase() || "M"}</div>
        </div>
      </header>
      <div className="page-wrap"><Routes>
        <Route path="/" element={<Overview/>}/><Route path="/accounts" element={<Accounts/>}/>
        <Route path="/discovery" element={<Discovery/>}/><Route path="/queue" element={<Queue/>}/>
        <Route path="/library" element={<Library/>}/><Route path="/songs" element={<SongLibrary/>}/><Route path="/creator" element={<Creator/>}/>
        <Route path="/scheduler" element={<Scheduler/>}/><Route path="/publishing" element={<Publishing/>}/>
        <Route path="/analytics" element={<Analytics/>}/><Route path="/health" element={<Health/>}/>
        <Route path="/settings" element={<SettingsPage/>}/><Route path="*" element={<Navigate to="/" replace/>}/>
      </Routes></div>
    </main>
  </div>;
}
