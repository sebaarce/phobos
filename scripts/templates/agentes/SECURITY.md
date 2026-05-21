# Phobos — Shared security policy

> **Audience**: all Phobos agents (phobos, researcher, planner, programmer, tester, archivist).
> **Source of truth**: this document. Per-agent prompts include only a short summary + agent-specific deltas.
> **Enforcement**: most rules below are also declared in each agent's frontmatter (`security:`, `permission:`, `tools:`). OpenCode (and Claude Code via `.claude/settings.json`) enforces them at runtime. This document explains the *why* and the *what to do when in doubt*.

---

## 1 — Paths

- **Always relative to the project cwd.** Never use absolute paths (`/`, `C:\`, `D:\`) or global tilde expansions (`~/`, `$HOME/`).
- **Never construct paths with `../`, `./`, `/`, `\`** at the start, or with mixed separators.
- All artifacts live under `vault/`, `.opencode/`, `.claude/`, `src/`, `lib/`, `app/`, or wherever the project keeps source — but the agent operates from cwd. If a subagent returns an absolute path, re-delegate asking for correction.

## 2 — Slug validation

The `<slug>` Phobos passes to subagents matches `^[a-zA-Z0-9_-]{3,60}$`. This is declared in `security.slug_regex` of each frontmatter.

Defense in depth — every subagent re-validates:

- If the slug contains `..`, `/`, `\`, spaces, `*`, `?`, or is outside 3-60 chars → **stop work, reject**:
  > `Invalid slug received: <value>. Expected [a-zA-Z0-9_-]{3,60}.`
- Never pass the slug to shell commands without escaping.
- Never use the slug as a prefix for paths outside `vault/memory/tasks/<slug>/`.

## 3 — Secrets

Vault artifacts (`research.md`, `plan.md`, `implementation.md`, `test-report.md`, `conclusion.md`, `insights/`, `wiki/`, `glossary/`) are read by other agents and committed to git. **Any credential transcribed propagates through the pipeline and ends up in the repo**.

### Forbidden to transcribe into any vault file

- API keys, tokens (Bearer, OAuth, JWT, GitHub PAT, AWS access keys, etc.)
- Passwords (including bcrypt hashes — they are offline-attackable)
- Connection strings with resolved credentials (`postgres://user:pass@host`)
- Environment variables with real values (`DATABASE_URL=...`, `AWS_ACCESS_KEY=AKIA...`)
- Content of `.env`, `.env.*`, `~/.aws/credentials`, `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`, `auth.json`, etc.
- Text between `-----BEGIN ... PRIVATE KEY-----` and `-----END ... PRIVATE KEY-----`
- Shell commands that *expose* credentials in their output: `cat .env`, `printenv`, `env`, `Get-ChildItem env:`, `gh auth token`, `npm config get //...:_authToken`.

### If you encounter a credential during work

Mention it abstractly, without transcribing:

```
- File: src/config/db.ts:15
  - Reads `DATABASE_URL` from environment (real value NOT included here).
```

Or use an explicit placeholder:

```
- `<SECRET_DETECTED_IN_src/auth/dev.ts:42>`
- `<TOKEN_IN_.env_NOT_TRANSCRIBED>`
```

**Rule of thumb**: if in doubt whether something is a secret, assume it is. Over-redacting is cheap; leaking is irreversible.

### If you need to know a credential's format

Do not read the credential file. Ask Phobos to ask the user, abstractly:
> I need to know the expected keys of `DATABASE_URL` (no real values). Can the user tell me?

## 4 — Files you may NOT read

Although `cat*` / `Get-Content*` / `Read` technically allow access to any user-readable file, **never read** these by convention (also enforced via `security.forbidden_read_files` and adapter deny lists):

- **Credential files**: `.env`, `.env.local`, `.env.production`, `.env.*`, `~/.aws/credentials`, `~/.aws/config`, `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`.
- **Private keys**: `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `id_ecdsa`, anything in `~/.ssh/`, `~/.gnupg/`.
- **IDE auth state**: `~/.config/opencode/auth.json`, `~/.local/share/opencode/auth.json`, equivalents in `%APPDATA%`/`%LOCALAPPDATA%` on Windows.
- **OS files**: `/etc/passwd`, `/etc/shadow`, `/etc/sudoers`, `C:\Windows\System32\config\*`.
- **Rails-specific** (when applicable): `config/credentials/**`, `config/master.key`.

## 5 — Shell command scope

Even with broad read allowlists (`cat`, `find`, `rg`, `grep`, `ls`, etc.), apply commands **only inside the project cwd**.

- ❌ `find /`, `find ~`, `Get-ChildItem C:\` — filesystem reconnaissance, never necessary.
- ❌ `rg "pattern" /` — same.
- ❌ `cat` on arbitrary files "to see what they contain". Read files identified as relevant to the task.
- ❌ `git show HEAD~50:file` — historical fishing. Use `git show` on specific commits identified as relevant to the task.

Before each shell command, mentally answer: *does this advance the current task, or am I exploring for exploration's sake?* If the latter, do not run it.

## 6 — Forbidden commands (categorically — no `[REQUIRES MANUAL REVIEW]` workaround)

### Git mutations
- `git commit`, `git push`, `git add`, `git merge`, `git rebase`, `git reset --hard`, `git checkout -- *`, `git branch -D`
- The user does all git operations themselves.

### Network egress
- `curl`, `wget`, `iwr`, `Invoke-WebRequest`, `nc`/`netcat`, raw socket operations
- WebFetch / WebSearch tools are allowed when the agent's frontmatter permits them (researcher only).

### Destructive
- `rm -rf` outside known-safe paths (`.tmp-*`, `vault/memory/.engine/node_modules/`, `.codegraph/node_modules/`)
- `find ... -delete`, `xargs rm`
- Database `DROP`, `TRUNCATE`, `DELETE FROM ... WHERE 1=1`
- `:>file` / `> file` to truncate existing project files

### System reconnaissance
- `whoami`, `id`, `hostname`, `uname -a`, `Get-ComputerInfo`, `systeminfo`
- `ps aux`, `tasklist` (process listing of the host)
- `netstat`, `ss`, `Get-NetTCPConnection`
- `lsof`, `fuser`

### Credential exposure
- `printenv`, `env`, `Get-ChildItem env:` (would dump env vars to logs)
- `cat ~/.ssh/*`, `cat ~/.aws/*`
- `gh auth token`, `gh auth status --show-token`
- `npm config get //...:_authToken`

### Plans (Planner-specific)

The Planner may not include any of the above as a step in `plan.md`. If a step legitimately requires one of these (rare — usually the human does it), mark explicitly:

```markdown
- [ ] **N.** [REQUIRES MANUAL REVIEW] <description>
  - File(s): <none — manual operation>
  - Change: User runs `<command>` after reviewing the plan.
  - Acceptance: User confirms in chat.
```

The Programmer skips `[REQUIRES MANUAL REVIEW]` steps and reports them to Phobos at close.

## 7 — Traceability footers

Every artifact (`research.md`, `plan.md`, `implementation.md`, `test-report.md`, `conclusion.md`, agent-touched files) ends with a traceability HTML comment. It is **not** a cryptographic signature — it is an audit marker.

### Format

```markdown
<!-- Traceability: <type> by <agent> at YYYY-MM-DD HH:MM:SS -->
```

Examples:
```markdown
<!-- Traceability: research by Researcher at 2026-05-19 14:23:11 -->
<!-- Traceability: plan generated by Planner at 2026-05-19 14:25:02 -->
<!-- Traceability: implementation by Programmer at 2026-05-19 14:40:18 -->
<!-- Traceability: test-report by Tester at 2026-05-19 14:42:33 -->
<!-- Traceability: conclusion written by Archivist at 2026-05-19 14:45:07 -->
```

### Timestamp command (shell-aware)

| Shell | Command |
|---|---|
| bash / Unix / macOS | `date "+%Y-%m-%d %H:%M:%S"` |
| PowerShell / Windows | `Get-Date -Format "yyyy-MM-dd HH:mm:ss"` |

**Do NOT use `npx node -e "..."`** or cross-shell hacks — quoting conflicts between PowerShell and bash cause multiple failed retries and burn tokens.

### Behavior on re-run

If you re-run (plan change, fix), **replace** the timestamp. Do not accumulate. The comment lives at the end of the file as a single line.

### Drift detection (Phobos + Tester role)

Phobos checks that artifacts retain their timestamp after delegation. If a file's content changed but the timestamp didn't, that indicates drift (the file was modified outside the pipeline). Optional: `<artifact>.sha256` files alongside, for stronger detection.

## 8 — System-file overwrites — absolute deny

**Never write to** (regardless of permissions):

- `/etc/`, `/usr/`, `/var/`, `/bin/`, `/sbin/`, `/root/`, `/sys/`, `/proc/`
- `C:\Windows\`, `C:\Program Files\`, `C:\ProgramData\`
- `~/.bash_profile`, `~/.bashrc`, `~/.zshrc`, `~/.config/**`, `~/.aws/`, `~/.ssh/`, `~/.gnupg/`, `~/.docker/`
- The user's global git config (`git config --global ...`)

These are categorically out of scope. If a plan step requires touching one of them, the user does it manually after the task — mark `[REQUIRES MANUAL REVIEW]`.

## 9 — Output contract — never echo secrets to chat

Even when an agent's chat output is short (≤5 bullets, ≤400 chars), the rule against secrets still applies. If you must reference a credential, do it abstractly:

> "Detecté credenciales en `<path>` — no las transcribo. Mirá el archivo si las necesitás."

The Phobos orchestrator forwards subagent outputs to the user. A secret echoed to chat ends up in the conversation history → indirect leak.

## 10 — When in doubt

- Treat unknown strings that look like credentials as credentials.
- Treat unknown paths outside cwd as out-of-scope until proven otherwise.
- Treat unknown commands not in your allowlist as denied — ask Phobos for an explicit allowance instead of trying.
- The cost of stopping to ask is one round-trip. The cost of leaking, deleting, or executing the wrong thing is days.

---

## Where this file lives

- **Source**: `scripts/templates/agentes/SECURITY.md` (Phobos installer repo)
- **Per-project copy**: `vault/SECURITY.md` (copied by the wizard at bootstrap; readable by humans inspecting the vault)
- **Per-agent reference**: each agent prompt has a short summary section (5-10 lines) + this file as the canonical reference. Agent-specific deltas (extra denylists, extra allowlists) live in each agent's frontmatter `security:` block, which is what the runtime enforces.
