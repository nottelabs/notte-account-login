import { NextResponse } from "next/server";
import { USER_KEY_HEADER } from "../../../lib/api-key";

export const maxDuration = 60;

const API = (process.env.NOTTE_API_URL || "https://api.notte.cc").replace(/\/$/, "");
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

type Session = { session_id: string; viewer_url: string | null };

class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Every request uses the visitor's key. The deployment holds no shared key. */
function headers(req: Request) {
  const key = req.headers.get(USER_KEY_HEADER)?.trim();
  if (!key) throw new RequestError("Enter your Notte API key first.", 401);
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

function reply(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(error: unknown) {
  return reply(
    { error: error instanceof Error ? error.message : "The request failed." },
    error instanceof RequestError ? error.status : 502,
  );
}

async function body(req: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    throw new RequestError("Send a valid JSON request.", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("Send a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new RequestError(`A valid ${label} is required.`, 400);
  }
  return value;
}

async function request<T>(path: string, auth: ReturnType<typeof headers>, init: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: auth, cache: "no-store" });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new RequestError(`Notte returned an unreadable response (${res.status}).`, 502);
    }
  }
  if (!res.ok) {
    const detail = typeof data.detail === "string" ? data.detail : typeof data.error === "string" ? data.error : null;
    const key = auth.Authorization.slice("Bearer ".length);
    throw new RequestError(
      detail ? detail.replaceAll(key, "[redacted]") : `Notte could not complete the request (${res.status}).`,
      res.status,
    );
  }
  return data as T;
}

/** Start a browser and navigate before handing its interactive viewer to the page. */
export async function POST(req: Request) {
  let session: Session | undefined;
  let auth: ReturnType<typeof headers> | undefined;
  try {
    auth = headers(req);
    const input = await body(req);
    let url: URL;
    try {
      if (typeof input.url !== "string") throw new Error();
      url = new URL(input.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
      throw new RequestError("Enter a valid website URL starting with https:// or http://.", 400);
    }

    session = await request<Session>("/sessions/start", auth, {
      method: "POST",
      body: JSON.stringify({ max_duration_minutes: 15, proxies: false, solve_captchas: false }),
    });
    identifier(session.session_id, "session ID from Notte");
    const viewerUrl = session.viewer_url;
    session.viewer_url = null;
    if (!viewerUrl) throw new Error("Notte started the browser without a viewer URL.");
    const viewer = new URL(viewerUrl);
    if (!["http:", "https:"].includes(viewer.protocol)) throw new Error("Notte returned an invalid viewer URL.");
    viewer.searchParams.set("interactive", "1");
    viewer.searchParams.set("mode", "theatre");
    session.viewer_url = viewer.toString();

    const navigation = await request<{ success: boolean }>(
      `/sessions/${session.session_id}/page/execute`,
      auth,
      { method: "POST", body: JSON.stringify({ type: "goto", url: url.toString() }) },
    );
    if (navigation.success !== true) throw new Error("The browser could not open that website.");
    return reply({ sessionId: session.session_id, viewerUrl: session.viewer_url });
  } catch (error) {
    if (session?.session_id && ID.test(session.session_id) && auth) {
      try {
        await request(`/sessions/${session.session_id}/stop`, auth, { method: "DELETE" });
      } catch {
        return reply(
          {
            error: "Browser setup failed and the browser could not be closed. Use Stop browser to close it.",
            sessionId: session.session_id,
            viewerUrl: session.viewer_url,
          },
          502,
        );
      }
    }
    return failure(error);
  }
}

/** Save first, then stop. A close failure never discards a successfully saved profile. */
export async function PATCH(req: Request) {
  try {
    const auth = headers(req);
    const input = await body(req);
    const sessionId = identifier(input.sessionId, "session ID");
    const target = input.profileId === undefined
      ? { name: "Saved login" }
      : { profile_id: identifier(input.profileId, "profile ID") };
    const profile = await request<{ profile_id: string }>(`/sessions/${sessionId}/profile/save`, auth, {
      method: "POST",
      body: JSON.stringify(target),
    });
    const profileId = identifier(profile.profile_id, "profile ID from Notte");
    try {
      await request(`/sessions/${sessionId}/stop`, auth, { method: "DELETE" });
    } catch {
      return reply({
        profileId,
        sessionStopped: false,
        error: "Your profile was saved, but the browser could not be closed. Use Stop browser to close it.",
      });
    }
    return reply({ profileId, sessionStopped: true });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = headers(req);
    const input = await body(req);
    const sessionId = identifier(input.sessionId, "session ID");
    await request(`/sessions/${sessionId}/stop`, auth, { method: "DELETE" });
    return reply({ ok: true });
  } catch (error) {
    if (error instanceof RequestError && error.status === 404) {
      return reply({ sessionStopped: true, error: "The browser is already closed or has expired." }, 404);
    }
    return failure(error);
  }
}
