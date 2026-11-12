import { NeoClient } from "@neo/client";
import { ArrowRight, KeyRound } from "lucide-react";
import { useMemo, useState } from "react";
import { cn, errorText } from "./lib/format";
import { apiUrl, forgetToken, loadToken, saveToken } from "./lib/session";
import { Workspace } from "./shell/Workspace";
import { Spinner } from "./ui/Avatar";
import { ConfirmHost } from "./ui/confirm";
import { Toaster } from "./ui/Toaster";

export function App() {
  const url = useMemo(apiUrl, []);
  const [token, setToken] = useState(() => loadToken(url));
  return (
    <>
      {token ? (
        <Workspace
          key={token}
          url={url}
          token={token}
          onForget={() => {
            forgetToken(url);
            setToken(null);
          }}
        />
      ) : (
        <Connect
          url={url}
          onToken={(t) => {
            saveToken(url, t);
            setToken(t);
          }}
        />
      )}
      <Toaster />
      <ConfirmHost />
    </>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center justify-center rounded-[30%] bg-ident text-[#0a0a0c]", className)}>
      <svg viewBox="0 0 32 32" className="size-[58%]" fill="none" stroke="currentColor" strokeWidth={3.6} strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 23V9l14 14V9" />
      </svg>
    </span>
  );
}

function Connect({ url, onToken }: { url: string; onToken: (token: string) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError(undefined);
    try {
      await new NeoClient({ url, token }).status();
      onToken(token);
    } catch (e) {
      setError(errorText(e) === "Unauthorized" ? "That token didn't work. Check it and try again." : errorText(e));
    }
    setBusy(false);
  };
  return (
    <div className="relative flex h-full items-center justify-center overflow-y-auto px-5">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,color-mix(in_srgb,var(--brand)_14%,transparent),transparent)]" />
      <form
        className="animate-up relative flex w-full max-w-[380px] flex-col items-center"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Logo className="size-14 shadow-xl" />
        <h1 className="mt-6 text-[26px] font-semibold tracking-tight">Welcome to Neo</h1>
        <p className="mt-1.5 text-center text-[14px] text-muted">Your always-on agent. Connect to your instance to continue.</p>
        <div className="mt-8 w-full">
          <div
            className={cn(
              "flex items-center gap-2 rounded-2xl border bg-raised p-1.5 pl-3.5 shadow-sm transition-[border,box-shadow] focus-within:ring-4 focus-within:ring-brand/12",
              error ? "border-danger/50" : "border-line-strong focus-within:border-brand/50",
            )}
          >
            <KeyRound className="size-4 shrink-0 text-faint" />
            <input
              autoFocus
              type="password"
              autoComplete="current-password"
              placeholder="API token"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-9 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint"
            />
            <button
              disabled={!value.trim() || busy}
              className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg transition-opacity disabled:opacity-30"
              aria-label="Connect"
            >
              {busy ? <Spinner /> : <ArrowRight className="size-4" />}
            </button>
          </div>
          {error && <p className="animate-in mt-2 px-1 text-[12.5px] text-danger">{error}</p>}
          <p className="mt-4 px-1 text-center text-[12.5px] leading-relaxed text-muted">
            It's the <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[11.5px]">NEO_TOKEN</code> secret of your deployment.
            <br />
            <span className="text-faint">{url}</span>
          </p>
        </div>
      </form>
    </div>
  );
}
