---
title: Credential vault
description: "Keep project passwords in Stubwise, encrypted in the browser: activating the vault, opening it with a passkey, sharing, confirming access, the recovery kit and bulk import."
---

The **credential vault** keeps the passwords a project needs (hosting panels,
third-party services, test accounts) inside Stubwise, **encrypted end to end**.
Each password is encrypted in your browser before it is saved, and decrypted in
the browser of whoever reads it: the server only stores encrypted data and never
sees a password, nor a key that could open one.

Some things to know before you start:

- Only the **password** is encrypted. The service name, label, URL, username
  and notes are stored in clear text: **never put secrets in the notes**.
- Credentials are never used by automation: no agent run, AI chat, search,
  MCP tool or worker job can see them.
- You open the vault with a **passkey that supports PRF** (see below). An
  authenticator code or a backup code is not enough.
- The vault protects against stolen data (a copy of the database, a backup, a
  server that was switched off). It cannot protect you from a server that an
  attacker controls **while** you use it: like any web-based vault, that server
  could serve a modified page.

## Who can do what

Three project permissions govern credentials (see
[Roles and members](/docs/team/roles-and-members/)): `credentials.create`,
`credentials.edit` (edit the clear-text fields and replace the password) and
`credentials.share`. Only the **Project Lead** role has them; full admins have
everything everywhere.

A person **reads** a credential when they are one of its readers: whoever
created it, every **full admin**, and the people or project roles it was shared
with. Reading is checked on every request: someone removed from the project, or
from a role a credential was shared with, stops reading it immediately.

## Activating the vault

A **full admin** activates the vault once for the whole instance, from
**Settings → Vault**:

1. **Generate the recovery kit.** It is shown **once**: print it or download it
   and keep it outside Stubwise (not on the same server). See
   [The recovery kit](#the-recovery-kit).
2. Tick that you saved it and **activate the vault**.
3. Touch your passkey: Stubwise creates your personal vault key.

The key of the admin who activates the vault is the only one confirmed
automatically, because nobody else could confirm it. Everyone else's key needs
a confirmation (see [Confirming access](#confirming-access)).

Until the vault is active, the **Credentials** section of a project and the
**Credentials** entry of the menu don't appear.

## Opening the vault the first time

Everyone opens the vault once to create their **vault key**: from a project's
**Credentials** section or from **Credentials** in the menu, choose
**Create your key** and touch your passkey. Your private key is encrypted with
a secret that only your passkey can produce, and it is opened only in your
browser.

A new key starts **waiting for confirmation**: tell a Project Lead or a full
admin that you created it, so they can confirm it's really you. Credentials
shared with you reach you after that confirmation.

Once open, the vault stays open in that tab while you use it. It locks itself
after **15 minutes** of inactivity, when you close the tab and when you sign
out. The private key only ever lives in the page's memory, never in the
browser's storage.

## Compatible passkeys

The vault needs a passkey that supports the **PRF extension**, which lets the
passkey produce a secret for the vault. Passkeys that do:

- **iCloud Keychain** (Safari on macOS and iOS, recent versions);
- **Google Password Manager** (Chrome);
- recent hardware security keys.

Add a passkey in **Settings → Security** (see
[Two-factor sign-in](/docs/team/two-factor/#passkeys)). If you open the vault
with a passkey that does not support PRF, Stubwise says so and **creates no
key**: add a compatible passkey and try again with that one.

### Adding another passkey to the vault

Every passkey that opens the vault does so independently. A passkey you add
**after** creating your vault key doesn't open the vault yet: in
**Settings → Security**, next to it, choose **Add this passkey to the vault**,
then touch first a passkey that already opens the vault and then the new one.
Add at least two passkeys, on different devices, so that losing one doesn't
lock you out.

If you lost every passkey that opened your key, first remove them from
**Settings → Security**: once no remaining passkey opens your key, the unlock
dialog offers **Recreate the vault key**. The new key needs a confirmation
again, and the credentials you could read go back to "waiting" until someone
confirms it.

## Showing and copying a password

In a project's **Credentials** section (or in **Credentials** in the menu,
which lists every credential you can read in all projects), use **Show** or
**Copy** next to a credential. If the vault is locked, Stubwise asks for your
passkey first.

- **Show** reveals the password in the page; **Hide** hides it again.
- **Copy** puts it on the clipboard, which is **cleared after 30 seconds**. If
  the browser refuses to copy, use Show.

Every show and every copy is recorded in the project's **Access log**, visible
to whoever can edit or share credentials.

## Creating and editing credentials

With `credentials.create`, **New credential** in the project's Credentials
section asks for the service and the password, plus optional label, URL,
username and notes. The password is encrypted in your browser for every reader
(you and the full admins, plus the recovery kit) before it is sent.

With `credentials.edit`, **Edit** changes the clear-text fields; filling in
**New password** replaces the password (leave it empty to keep the current one).

## Sharing

To share a credential you need `credentials.share` **and** you must be able to
read it yourself: sharing re-encrypts the credential's key for the new readers
in your browser, so only someone who can open it can pass it on.

Open **Readers** on the credential and share it with a **person** or with a
**project role** (everyone with that role in the project, now and later). The
panel shows who reads it and who is waiting:

- **waiting: no vault key yet** — the person hasn't opened the vault yet;
- **waiting: their key needs confirmation** — see below;
- **waiting for a copy of the key** — their key is confirmed, and the next
  reader who confirms access passes the credential on.

## Confirming access

A person never starts reading a credential on their own: someone who already
reads it (with `credentials.share`), or a full admin, has to **confirm** that
their vault key is really theirs. This is what stops a stolen login: creating a
key in someone's name takes only their password and second factor.

Pending people appear under **Access to confirm** on the **Credentials** page.
For each one you see when the key was created, the device, and the **key
fingerprint**. Before confirming, **check with the person — in person or on
the phone —** that the date, the device and the fingerprint match what they
see. Then **Confirm**: the credentials you can pass on are encrypted for them
in your browser. **Reject** if the key isn't theirs: they receive nothing and
have to create a new key.

You can't confirm or reject your own key: someone else has to. Your own
fingerprint is shown next to the notice that your key is waiting (and in
**Settings → Security**) while the vault is open: read it to whoever confirms.
Nobody sees your key to confirm until a credential is shared with you, because
confirming always passes at least one credential — nobody, not even a full
admin, confirms a key "empty".

Confirming, rejecting, sharing and removing a reader need the vault open: your
browser proves to the server, with your own key, that it is really you. A
stolen login without your passkey can't pass access to anyone.

## Revoking access

Remove a person or a role from **Readers**, or remove the person from the
project: they stop reading the credential immediately. But if they already saw
or copied the password, it can't be taken back: **change the password** on the
service and then in Stubwise (**Edit → New password**). The new password is
encrypted only for the current readers.

## The recovery kit

The recovery kit is the text you saved when the vault was activated. It can
open the key of every credential, so: **whoever has the kit and the database
can read every credential**. Keep it as the most valuable thing of the
instance, offline. The web app has no way to show it again.

A full admin uses it from **Settings → Vault → Use the recovery kit** when
nobody else can confirm access — for example the only admin who lost their
passkeys (recreate the key, then confirm it with the kit), or after a domain
change. The kit is pasted in the page and read only in your browser: it is
never sent to the server and is forgotten when you leave the page. The server
checks that you really have the kit with a one-time challenge. The kit only
**confirms pending access**, never shows a password; every use is recorded in
the security log and reported to the other full admins.

If the kit is lost or might have been seen, a full admin regenerates it from
**Settings → Vault → Regenerate the recovery kit**, with the vault open. The
new kit is shown once (print or save it, then confirm); the browser re-encrypts
the key of every credential for it, and the old kit stops working at once. It
works only if you can read **every** credential of the instance: otherwise the
page lists the ones you are missing. The other full admins are notified.

Passwords are lost for good only if every reader, every admin **and** the kit
are lost.

## Importing credentials from a file

To insert many credentials at once there is an example script in the
repository, `packages/vault-crypto/scripts/vault-insert-example.mjs`. It reads
a CSV file, **encrypts each password on your computer** and creates the
credentials through the API with a personal access token, so the server never
receives a password in clear text.

The CSV has a header row; the columns, in any order, are `service` and
`password` (required) and `label`, `url`, `username`, `notes` (optional). Use
commas as separators, UTF-8, and double quotes around a value that contains
commas, quotes or line breaks (a quote inside a value is written twice: `""`).

```csv
service,label,url,username,password,notes
Hosting panel,production,https://panel.example.com,ops@example.com,"p4ss,word",
```

From the root of a checkout of the Stubwise repository, with dependencies
installed:

```sh
pnpm --filter @stubwise/vault-crypto build
STUBWISE_URL=https://stubwise.example.com STUBWISE_TOKEN=stw_pat_... \
  node packages/vault-crypto/scripts/vault-insert-example.mjs <projectId> passwords.csv
```

The token's owner needs `credentials.create` in the project. The script prints
only counts, row numbers and error codes, never a value from the file. If the
set of readers changes while it runs (an admin confirms a key, for example),
the server refuses the write and returns the current readers; the script
re-encrypts and retries once.

**Do not let an AI assistant read the CSV.** If you run the script from Claude
Code (or a similar tool), give it only the file path and the command: never ask
it to open, show, check or fix the file, because whatever it reads leaves your
computer. Write the file yourself, run the script, then **delete the file**.

A personal access token can create credentials, replace passwords, edit and
delete them, but it can **never** read a password, share, confirm access or use
the recovery kit: those need a browser session.

## Changing the domain

Passkeys are bound to the domain of the instance (`PUBLIC_URL`). If the domain
changes, **every passkey stops working**, so nobody can open the vault with
theirs. To recover:

1. Everyone signs in (with the authenticator app or a backup code), and in
   **Settings → Security** removes the old passkeys and adds a new one.
2. Everyone opens the vault and chooses **Recreate the vault key**.
3. A full admin uses the **recovery kit** to confirm the new keys (their own
   included), then the others confirm each other as usual.

Plan a domain change with the kit at hand.
