import { useState } from 'react';
import { useStore } from '../store';
import { Logo, Spinner } from './ui';

export function Login() {
  const login = useStore((s) => s.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center px-5">
      <div className="w-full max-w-[360px] fade-up">
        <div className="mb-8 flex justify-center">
          <Logo size={30} />
        </div>
        <form onSubmit={submit} className="card px-6 py-6">
          <h1 className="mb-5 text-center text-[15px] font-semibold">Sign in to continue</h1>
          <div className="space-y-3.5">
            <input
              className="input"
              type="email"
              placeholder="Email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
            <input
              className="input"
              type="password"
              placeholder="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && (
              <p role="alert" className="rounded-md bg-err/10 px-3 py-2 text-[12.5px] text-[#ffb3ae]">
                {error}
              </p>
            )}
            <button className="btn-primary w-full py-2" disabled={pending || !email || !password}>
              {pending ? <Spinner size={14} /> : 'Sign in'}
            </button>
          </div>
        </form>
        <p className="mt-5 text-center text-[12px] text-dim">
          Private workspace · single user
        </p>
      </div>
    </div>
  );
}
