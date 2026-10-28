"use client";

import { type FormEvent, useMemo, useState } from "react";

import { USER_KEY_HEADER } from "../lib/api-key";

type Session = { sessionId: string; viewerUrl: string | null; apiKey: string };
type Operation = "opening" | "saving" | "stopping" | null;

function viewerSrc(viewerUrl: string) {
  const url = new URL(viewerUrl);
  url.searchParams.set("mode", "theatre");
  url.searchParams.set("interactive", "1");
  url.searchParams.set("theme", "light");
  return url.toString();
}

export default function Page() {
  const [apiKey, setApiKey] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("https://chatgpt.com");
  const [session, setSession] = useState<Session | null>(null);
  const [operation, setOperation] = useState<Operation>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const busy = operation !== null;
  const src = useMemo(() => (session?.viewerUrl ? viewerSrc(session.viewerUrl) : null), [session]);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || session) return;

    const sessionKey = apiKey.trim();
    setOperation("opening");
    setError(null);
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", [USER_KEY_HEADER]: sessionKey },
        body: JSON.stringify({ url: websiteUrl.trim() }),
      });
      const data = (await response.json()) as {
        sessionId?: string;
        viewerUrl?: string | null;
        error?: string;
      };

      // A navigation failure can still leave a browser available to save or stop.
      if (data.sessionId) {
        setSession({ sessionId: data.sessionId, viewerUrl: data.viewerUrl ?? null, apiKey: sessionKey });
        setProfileId(null);
        setCopied(false);
      }
      if (!response.ok) throw new Error(data.error ?? "The browser could not be opened.");
      if (!data.sessionId || !data.viewerUrl) throw new Error("The browser did not return a live view.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The browser could not be opened.");
    } finally {
      setOperation(null);
    }
  }

  async function save() {
    if (!session?.viewerUrl || busy || profileId) return;
    setOperation("saving");
    setError(null);
    try {
      const response = await fetch("/api/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", [USER_KEY_HEADER]: session.apiKey },
        body: JSON.stringify({ sessionId: session.sessionId }),
      });
      const data = (await response.json()) as {
        profileId?: string;
        sessionStopped?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Your login could not be saved.");
      if (!data.profileId) throw new Error("The save did not return a profile ID.");

      setProfileId(data.profileId);
      setCopied(false);
      if (data.sessionStopped) {
        setSession(null);
      } else {
        setError(data.error ?? "Your login is saved, but the browser is still open. Stop it below.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your login could not be saved.");
    } finally {
      setOperation(null);
    }
  }

  async function stop() {
    if (!session || busy) return;
    setOperation("stopping");
    setError(null);
    try {
      const response = await fetch("/api/session", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", [USER_KEY_HEADER]: session.apiKey },
        body: JSON.stringify({ sessionId: session.sessionId }),
      });
      const data = (await response.json()) as { error?: string; sessionStopped?: boolean };
      if (data.sessionStopped === true) setSession(null);
      if (!response.ok) throw new Error(data.error ?? "The browser could not be stopped.");
      setSession(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The browser could not be stopped.");
    } finally {
      setOperation(null);
    }
  }

  async function copyProfile() {
    if (!profileId) return;
    try {
      await navigator.clipboard.writeText(profileId);
      setCopied(true);
    } catch {
      setError("The profile ID could not be copied. Select it in the field and copy it manually.");
    }
  }

  return (
    <main className="shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Notte account login home">
          <span className="brand-mark" aria-hidden="true">n</span>
          notte
        </a>
        <span className="header-label">Account login template</span>
      </header>

      <section className="intro" aria-labelledby="page-title">
        <p className="eyebrow">A browser. A login. A reusable profile.</p>
        <h1 id="page-title">Connect an account.</h1>
        <p className="description">Sign in through a live browser, then save the login for your app to use later.</p>
      </section>

      <ol className="steps" aria-label="Connection steps">
        <li className={!session && !profileId ? "current" : "complete"}>
          <span aria-hidden="true">1</span> Open a browser
        </li>
        <li className={session && !profileId ? "current" : profileId ? "complete" : ""}>
          <span aria-hidden="true">2</span> Sign in to your account
        </li>
        <li className={profileId ? "complete" : ""}>
          <span aria-hidden="true">3</span> Save your login
        </li>
      </ol>

      <section className="setup-card" aria-label="Connection settings">
        <form onSubmit={start}>
          <div className="field">
            <label htmlFor="api-key">Notte API key</label>
            <input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-notte-..."
              autoComplete="off"
              spellCheck={false}
              required
              disabled={busy || !!session}
              aria-describedby="key-note"
            />
          </div>
          <div className="field">
            <label htmlFor="website-url">Website to sign in to</label>
            <input
              id="website-url"
              type="url"
              value={websiteUrl}
              onChange={(event) => setWebsiteUrl(event.target.value)}
              required
              disabled={busy || !!session}
              spellCheck={false}
            />
          </div>
          <button
            className="button primary open-button"
            type="submit"
            disabled={busy || !!session || !apiKey.trim() || !websiteUrl.trim()}
            aria-busy={operation === "opening"}
          >
            {operation === "opening" ? "Opening browser..." : "Open browser"}
            <span aria-hidden="true">↗</span>
          </button>
        </form>
        <p className="field-note" id="key-note">Your API key stays in memory for this page and is sent only to this app&apos;s server.</p>
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      {profileId && (
        <section className="saved-card" aria-labelledby="saved-title" aria-live="polite">
          <div className="saved-heading">
            <span className="success-icon" aria-hidden="true">✓</span>
            <div>
              <h2 id="saved-title">Your login is saved.</h2>
              <p>Use this profile ID to start a browser with your saved login.</p>
            </div>
          </div>
          <label htmlFor="profile-id">Profile ID</label>
          <div className="profile-value">
            <input id="profile-id" value={profileId} readOnly spellCheck={false} onFocus={(event) => event.target.select()} />
            <button className="button secondary" type="button" onClick={copyProfile}>
              {copied ? "Copied" : "Copy profile ID"}
            </button>
          </div>
        </section>
      )}

      {session ? (
        <section className="browser-card" aria-label="Live browser">
          <div className="browser-toolbar">
            <div>
              <p className="browser-status"><span aria-hidden="true" /> {src ? "Live browser" : "Browser started"}</p>
              <p className="browser-note">{!src ? "Live view unavailable. Stop this browser before opening a new one." : profileId ? "Your login is saved. You can stop this browser." : "Sign in below, then click Save login."}</p>
            </div>
            <div className="browser-actions">
              <button className="button secondary" type="button" onClick={stop} disabled={busy} aria-busy={operation === "stopping"}>
                {operation === "stopping" ? "Stopping..." : "Stop browser"}
              </button>
              <button className="button primary" type="button" onClick={save} disabled={busy || !!profileId || !src} aria-busy={operation === "saving"}>
                {operation === "saving" ? "Saving login..." : profileId ? "Login saved" : "Save login"}
              </button>
            </div>
          </div>
          {src && <div className="browser-frame">
            <iframe
              src={src}
              title="Sign in to your account in the Notte browser"
              allow="clipboard-read; clipboard-write"
              referrerPolicy="origin"
            />
          </div>}
        </section>
      ) : !profileId ? (
        <section className="empty-browser" aria-label="Browser preview">
          <svg width="44" height="38" viewBox="0 0 44 38" fill="none" aria-hidden="true">
            <rect x="2" y="2" width="40" height="34" rx="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M2 11h40" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="8" cy="6.5" r="1" fill="currentColor" />
            <circle cx="12" cy="6.5" r="1" fill="currentColor" />
            <path d="m18 19 7 4-7 4v-8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <h2>Your browser will open here.</h2>
          <p>Enter your API key above to get started.</p>
        </section>
      ) : null}

      <footer>Built with Notte <span aria-hidden="true">·</span> Your account, ready for automation.</footer>
    </main>
  );
}
