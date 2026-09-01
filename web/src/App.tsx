import { useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useStore } from './store';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { SettingsLayout } from './components/settings/SettingsLayout';
import { AgentsPage } from './components/settings/pages/AgentsPage';
import { AgentEditorPage } from './components/settings/pages/AgentEditorPage';
import { RolesPage } from './components/settings/pages/RolesPage';
import { AccountPage, ContextPage, InstructionsPage, IntegrationsPage, ToolsPage } from './components/settings/pages/SimplePages';
import { NewProjectDialog } from './components/NewProjectDialog';
import { Logo, MenuButton, Spinner, ToastHost } from './components/ui';
import { FolderOpen } from 'lucide-react';

export default function App() {
  const authChecked = useStore((s) => s.authChecked);
  const email = useStore((s) => s.email);
  const init = useStore((s) => s.init);

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!authChecked) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  }
  if (!email) return <><Login /><ToastHost /></>;

  return (
    <>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/" element={<Home />} />
          <Route path="/c/:chatId" element={<ChatView />} />
          {/* Admin: one category at a time. /settings keeps working and lands
              on Roles; every category and the agent editor own a real URL. */}
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="roles" replace />} />
            <Route path="roles" element={<RolesPage />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="agents/:agentId" element={<AgentEditorPage />} />
            <Route path="instructions" element={<InstructionsPage />} />
            <Route path="tools" element={<ToolsPage />} />
            <Route path="integrations" element={<IntegrationsPage />} />
            <Route path="context" element={<ContextPage />} />
            <Route path="account" element={<AccountPage />} />
            <Route path="*" element={<Navigate to="/settings/roles" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <ToastHost />
    </>
  );
}

function Shell() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const location = useLocation();

  // navigating (picking a chat, opening settings) dismisses the mobile drawer
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname, setSidebarOpen]);

  return (
    <div className="flex h-full">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}
      <div
        className={`fixed inset-y-0 left-0 z-50 flex transition-transform duration-200 md:static md:z-auto md:translate-x-0 md:transition-none ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar />
      </div>
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
      <NewProjectDialog />
    </div>
  );
}

function Home() {
  const chats = useStore((s) => s.chats);
  const setNewProjectOpen = useStore((s) => s.setNewProjectOpen);
  const navigate = useNavigate();

  useEffect(() => {
    if (chats.length > 0) {
      const latest = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      navigate(`/c/${latest.id}`, { replace: true });
    }
  }, [chats, navigate]);

  if (chats.length > 0) return null;

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="absolute left-3 top-3"><MenuButton /></div>
      <Logo size={40} withWord={false} />
      <div>
        <h1 className="text-[19px] font-semibold">Welcome to Tandem</h1>
        <p className="mt-1.5 max-w-[420px] text-[13.5px] leading-relaxed text-mut">
          Open a project and start a conversation. The Builder does the work, the
          Reviewer checks it — and every step stays visible.
        </p>
      </div>
      <button className="btn-primary" onClick={() => setNewProjectOpen(true)}>
        <FolderOpen size={15} />
        Open a project
      </button>
    </div>
  );
}
