/**
 * MemphisGate — sign-in and username, in the game's own visual language.
 *
 * This replaces the generic `.panel` strip that `thebes-deploy add auth`
 * scaffolds. Same contract (takes a `MemphisAuth`, renders the whole
 * signed-out / pending-create / signed-in flow), same filename so the
 * scaffold's manual-mount step still reads true — but it belongs to a menu
 * made of scratched planks rather than to a settings page.
 *
 * THREE STATES, and the middle one is the point:
 *   - signed out: a name field.
 *   - name has no identity yet: CONFIRM before registering. Memphis throws
 *     `NameNotRegistered` rather than silently minting an identity for a
 *     typo, and `useMemphis` turns that into `pendingCreate` instead of an
 *     error. Skipping this step is how a player ends up with two passkeys
 *     and a split scoreboard history.
 *   - signed in: who you are, the username you show on the board, and out.
 *
 * Passkeys need the gateway origin. On `npm run dev` sign-in cannot work at
 * all — the browser refuses the credential because passkey.js pins the
 * relying-party id. That is stated in the UI rather than left to fail
 * mysteriously, because it will otherwise be reported as a bug every time.
 */
import { useEffect, useState } from 'react';
import type { MemphisAuth } from './useMemphis';
import { getUsername, setUsername } from './lib/scores';

const isLocalhost =
  typeof location !== 'undefined' &&
  /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

export default function MemphisGate({ auth }: { auth: MemphisAuth }) {
  const [name, setName] = useState('');
  const [username, setUsernameField] = useState('');
  const [savedUsername, setSavedUsername] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string>();

  // Load whatever display name this identity already claimed.
  useEffect(() => {
    let live = true;
    const who = auth.session?.name;
    if (!who) { setSavedUsername(null); return; }
    getUsername(who)
      .then((u) => { if (live) { setSavedUsername(u); setUsernameField(u); } })
      .catch(() => { /* board is optional; sign-in still worked */ });
    return () => { live = false; };
  }, [auth.session?.name]);

  const claim = async (e: React.FormEvent) => {
    e.preventDefault();
    const who = auth.session?.name;
    const u = username.trim();
    if (!who || !u || saving) return;
    setSaving(true);
    setNameError(undefined);
    try {
      const got = await setUsername(who, u);
      setSavedUsername(got);
      setUsernameField(got);
    } catch (err) {
      // The canister traps with a readable reason ("that username is already
      // taken", "username must be 3-24 characters"). Show it as-is.
      setNameError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (auth.signedIn) {
    return (
      <div className="auth">
        <p className="auth-who">
          <span className="auth-label">signed in</span>
          <strong>{savedUsername || auth.displayName}</strong>
        </p>
        <form className="auth-row" onSubmit={claim}>
          <input
            className="auth-input"
            value={username}
            onChange={(e) => setUsernameField(e.target.value)}
            placeholder="name on the board"
            aria-label="Public username"
            maxLength={24}
          />
          <button
            className="btn btn--ghost"
            type="submit"
            disabled={saving || !username.trim() || username.trim() === savedUsername}
          >
            {saving ? '…' : savedUsername ? 'Rename' : 'Claim'}
          </button>
        </form>
        {nameError && <p className="auth-error">{nameError}</p>}
        <button className="auth-out" onClick={() => void auth.signOut()} disabled={auth.busy}>
          {auth.busy ? 'signing out…' : 'sign out'}
        </button>
      </div>
    );
  }

  if (auth.pendingCreate) {
    return (
      <div className="auth">
        <p className="auth-who">
          Nothing answers to <strong>{auth.pendingCreate}</strong>.
        </p>
        <div className="auth-row">
          <button className="btn btn--ghost" onClick={() => void auth.confirmCreate()} disabled={auth.busy}>
            {auth.busy ? 'waiting for passkey…' : 'Claim it'}
          </button>
          <button className="auth-out" onClick={auth.cancelCreate} disabled={auth.busy}>
            another name
          </button>
        </div>
        {auth.error && <p className="auth-error">{auth.error}</p>}
      </div>
    );
  }

  return (
    <div className="auth">
      <form
        className="auth-row"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          // The client requires the `.thebes` suffix; append it rather than
          // making the player learn that from a thrown error.
          void auth.signIn(n.endsWith('.thebes') ? n : `${n}.thebes`).catch(() => {});
        }}
      >
        <input
          className="auth-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="yourname.thebes"
          aria-label="Memphis name"
          autoComplete="username webauthn"
        />
        <button className="btn btn--ghost" type="submit" disabled={auth.busy || !name.trim()}>
          {auth.busy ? '…' : 'Sign in'}
        </button>
      </form>
      {auth.error && <p className="auth-error">{auth.error}</p>}
      <p className="auth-hint">
        {isLocalhost
          ? 'Passkeys need the gateway origin — sign-in does not work on localhost. Deploy, then sign in there.'
          : 'Sign in to be counted. A new name asks before it claims you.'}
      </p>
    </div>
  );
}
