import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { KeyRound, ShieldCheck, Lock } from "lucide-react";
import { api, ApiError } from "../lib/api.js";
import { useSession } from "../state/session.jsx";
import { Button, Field, Input, ErrorState, Banner, Card } from "../components/ui.jsx";

/**
 * Two sign-in paths.
 *
 * DID challenge/response is the real one: the server issues a nonce, the holder signs
 * it with their Ed25519 private key, and the server verifies against the public key
 * encoded in the DID itself. No secret ever crosses the wire, and a captured signature
 * is useless because the nonce is single-use and bound into the signed message.
 *
 * Password login exists so a reviewer can open the app without generating a keypair.
 * The server refuses it outright when NODE_ENV=production, and the UI says so plainly
 * rather than quietly offering a weaker option as if it were equivalent.
 */
export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn, session } = useSession();
  const [mode, setMode] = useState("did");
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const destination = location.state?.from ?? "/app";

  useEffect(() => { if (session) navigate(destination, { replace: true }); }, [session, navigate, destination]);
  useEffect(() => {
    api.authConfig()
      .then((c) => { setConfig(c); if (!c.passwordLoginEnabled) setMode("did"); })
      .catch(() => setConfig({ passwordLoginEnabled: false, didAuthEnabled: true }));
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-slate-900" aria-hidden="true" />
          <div>
            <h1 className="text-lg font-semibold text-slate-900">TrustWeave</h1>
            <p className="text-sm text-slate-500">Governed identity, assets and AI actions</p>
          </div>
        </div>

        <Card>
          <div className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1">
            <ModeTab active={mode === "did"} onClick={() => { setMode("did"); setError(null); }} icon={KeyRound}>
              DID signature
            </ModeTab>
            {config?.passwordLoginEnabled && (
              <ModeTab active={mode === "password"} onClick={() => { setMode("password"); setError(null); }} icon={Lock}>
                Password
              </ModeTab>
            )}
          </div>

          {error && <div className="mb-4"><ErrorState error={error} /></div>}

          {mode === "did"
            ? <DidForm signIn={signIn} setError={setError} busy={busy} setBusy={setBusy} ttl={config?.challengeTtlSeconds} />
            : <PasswordForm signIn={signIn} setError={setError} busy={busy} setBusy={setBusy} />}
        </Card>

        {config?.passwordLoginEnabled && (
          <div className="mt-4">
            <Banner tone="warn">
              Password sign-in is a development convenience and is rejected when the server runs in
              production mode. DID challenge/response is the supported path.
            </Banner>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeTab({ active, onClick, icon: Icon, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
        active ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
      }`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {children}
    </button>
  );
}

function DidForm({ signIn, setError, busy, setBusy, ttl }) {
  const [did, setDid] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [challenge, setChallenge] = useState(null);

  async function requestChallenge(event) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      setChallenge(await api.challenge(did.trim()));
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", String(err)));
    } finally { setBusy(false); }
  }

  /**
   * The signing happens in the browser using Web Crypto. The private key is typed in,
   * used once, and never sent anywhere — only the resulting signature goes to the
   * server. In a production deployment this step belongs in a wallet or hardware key;
   * the paste field is a stand-in so the flow is demonstrable end to end.
   */
  async function signAndVerify(event) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const signature = await signEd25519(privateKey.trim(), challenge.message);
      const result = await api.verify({ challengeId: challenge.challengeId, did: did.trim(), signature });
      await signIn(result.token);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "SIGNING_FAILED", err?.message ?? String(err)));
    } finally { setBusy(false); }
  }

  if (!challenge) {
    return (
      <form onSubmit={requestChallenge} className="space-y-4">
        <Field label="Decentralized identifier" hint="The did:key issued when your identity was created.">
          <Input value={did} onChange={(e) => setDid(e.target.value)} placeholder="did:key:z6Mk…" required autoFocus spellCheck={false} />
        </Field>
        <Button type="submit" loading={busy} className="w-full">Request challenge</Button>
      </form>
    );
  }

  return (
    <form onSubmit={signAndVerify} className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Challenge to sign</p>
        <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs text-slate-700">{challenge.message}</pre>
        {ttl && <p className="mt-1.5 text-xs text-slate-500">Expires in {ttl} seconds and can be used once.</p>}
      </div>

      <Field label="Private key" hint="Used in your browser to sign the challenge. It is never transmitted.">
        <Input type="password" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="base64url private key" required autoFocus spellCheck={false} />
      </Field>

      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={() => { setChallenge(null); setPrivateKey(""); }}>Back</Button>
        <Button type="submit" loading={busy} className="flex-1">Sign in</Button>
      </div>
    </form>
  );
}

function PasswordForm({ signIn, setError, busy, setBusy }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const result = await api.login(email.trim().toLowerCase(), password);
      await signIn(result.token);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", String(err)));
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Email">
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="username" />
      </Field>
      <Field label="Password">
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
      </Field>
      <Button type="submit" loading={busy} className="w-full">Sign in</Button>
    </form>
  );
}

/**
 * Ed25519 signing via Web Crypto.
 *
 * The server stores raw 32-byte seeds (base64url). Web Crypto's importKey wants PKCS#8,
 * so the seed is wrapped in a fixed DER prefix — the prefix is constant for Ed25519
 * private keys, so this is a structural wrap rather than any kind of transformation of
 * the key material.
 */
async function signEd25519(privateKeyB64Url, message) {
  const seed = base64UrlToBytes(privateKeyB64Url);
  if (seed.length !== 32) throw new Error("An Ed25519 private key must be 32 bytes (base64url encoded).");

  const PKCS8_PREFIX = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + seed.length);
  pkcs8.set(PKCS8_PREFIX, 0);
  pkcs8.set(seed, PKCS8_PREFIX.length);

  let key;
  try {
    key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  } catch {
    throw new Error("This browser does not support Ed25519 signing. Use Chrome 137+, Firefox 129+, or Safari 17+, or sign in with a password in development.");
  }

  const signature = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(message));
  return bytesToBase64Url(new Uint8Array(signature));
}

function base64UrlToBytes(value) {
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
