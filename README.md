# Notte account login

A minimal Next.js template for connecting an existing account to browser automation. Open an embedded browser, sign in to a website, and save a reusable Notte profile ID.

Built from [live-view-embedding](https://github.com/nottelabs/live-view-embedding/tree/953cf76f3f6ac71d163a44d79d971a48ab37a114), with the original MIT license preserved.

## Run locally

```bash
nvm install
nvm use
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000), enter a [Notte API key](https://console.notte.cc), choose a website, and click **Open browser**. Sign in inside the viewer, including any verification steps, then click **Save login**. Copy the profile ID shown after saving.

The API key stays in page memory and is sent to this app's server routes over HTTPS. It is not stored in localStorage, included in URLs, or bundled into the deployment. Each visitor uses their own key; the template has no shared server key. Refreshing the page clears the key and session controls. Sessions expire after 15 minutes; use **Stop browser** when cancelling.

## How it works

- `POST /api/session` starts a Notte browser, opens the requested website, and returns an interactive `viewer_url` for the iframe.
- `PATCH /api/session` explicitly saves cookies and web storage with `POST /sessions/{session_id}/profile/save`, then stops the browser and returns `profileId`.
- `DELETE /api/session` closes a browser without saving a profile.

Saving is an explicit user action. The app does not detect whether a website accepted the login. A failed save leaves the browser open. If the save succeeds but closing fails, the saved ID remains visible and the user can close the browser separately.

Profiles belong to the Notte user or workspace associated with the key. A profile ID alone does not grant access. Later sessions using a key with access to that profile can load it:

```ts
const session = notte.Session({
  profile: { id: profileId, persist: false },
});
await session.start();
```

See [embedding](https://docs.notte.cc/features/sessions/embed-iframe) and [browser profiles](https://docs.notte.cc/features/sessions/browser-profiles). Website sessions can expire or require login again.

## Deploy to Vercel

Import this repository in Vercel, choose the Next.js preset, and deploy. No environment variables are required. Node 24 is selected by `package.json`.

For a different Notte environment, set the server-only `NOTTE_API_URL` variable before deployment; it defaults to `https://api.notte.cc`. Never put a key in a `NEXT_PUBLIC_` variable.

## Checks

```bash
npm run lint
npm test
npm run build
```

The route tests use a local mock Notte API and do not need credentials. Live verification should save a login, launch a fresh session with the returned profile ID, and confirm the login remains available.

## License

MIT
