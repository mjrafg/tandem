import { useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { useStore } from './store';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { SettingsView } from './components/settings/SettingsView';
import { NewProjectDialog } from './components/NewProjectDialog';
import { Logo, Spinner, ToastHost } from './components/ui';
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
          <Route path="/settings" element={<SettingsView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <ToastHost />
    </>
  );
}

function Shell() {
  return (
    <div className="flex h-full">
      <Sidebar />
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
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
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
