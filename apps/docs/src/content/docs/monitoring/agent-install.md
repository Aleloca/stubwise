---
title: Installing the agent
description: "Install the Stubwise monitoring agent on a Linux host: install Docker (Ubuntu/Debian, RHEL/Fedora, Alpine), run the container, and verify the connection — with troubleshooting, updates and uninstall."
---

The monitoring agent is a small **Docker container** you run on each host you
want to watch. It reads host metrics and service state locally and **pushes**
them to Stubwise over HTTPS — see [Server monitoring](/docs/monitoring/) for the
model. This page walks through installing it on a Linux host.

## Prerequisites

- A **Linux host** (the agent reads `/proc` and `/sys`, which are Linux-only).
- **Outbound HTTPS** access from the host to your Stubwise instance. No inbound
  port is opened on the monitored host.
- **Docker** installed and running (see below).
- The **server key**, obtained when you register the server in Stubwise (see
  [Getting the key](#getting-the-key)).

## Install Docker

If Docker is already installed, check it with:

```bash
docker --version
```

Otherwise install it for your distribution. The quickest path on most systems is
Docker's convenience script:

```bash
curl -fsSL https://get.docker.com | sh
```

Prefer the distro-native route below if you want packages managed by your own
package manager.

### Ubuntu / Debian

The convenience script above works. For the official apt repository instead:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io
```

On Debian replace `ubuntu` with `debian` in the two URLs.

### RHEL / CentOS / Fedora

Add Docker's repository and install with `dnf`:

```bash
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io
sudo systemctl enable --now docker
```

On Fedora use the `fedora` repo URL
(`https://download.docker.com/linux/fedora/docker-ce.repo`).

### Alpine

Docker is in the community repository:

```bash
sudo apk add docker
sudo rc-update add docker default
sudo service docker start
```

### Rootless and the `docker` group

By default Docker's socket is owned by `root:docker`, so the commands above use
`sudo`. To run `docker` as a non-root user, add that user to the `docker` group
(`sudo usermod -aG docker "$USER"`, then log out and back in). Note that this
grants root-equivalent access on the host.

Docker can also run **rootless** (the daemon under your own user). The agent
works there too — just make sure the container can reach the Docker socket your
rootless daemon exposes (typically `/run/user/$(id -u)/docker.sock`); adjust the
socket path in the run command accordingly.

## Run the agent

Register the server in Stubwise first (see [Getting the key](#getting-the-key))
to obtain the exact command with your URL and key already filled in. It looks
like this:

```bash
docker run -d --name stubwise-agent --restart unless-stopped \
  --group-add "$(stat -c %g /var/run/docker.sock)" \
  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/host/root:ro \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e STUBWISE_URL=https://your-instance.example.com \
  -e STUBWISE_SERVER_KEY=sk_your_key \
  alelocadev/stubwise-agent
```

Line by line:

- `-d --name stubwise-agent --restart unless-stopped` — run detached, name the
  container so you can manage it later, and restart it on boot or crash (but not
  if you stop it by hand).
- `--group-add "$(stat -c %g /var/run/docker.sock)"` — add the container process
  to the **group that owns the Docker socket**. The agent runs as a non-root
  user (UID 10001); without this group its `connect()` to the socket fails with
  **`EACCES`** and Docker containers silently show up as zero services.
- `-v /proc:/host/proc:ro` and `-v /sys:/host/sys:ro` — mount the host's `/proc`
  and `/sys` **read-only**; this is where CPU, memory, network and PM2 data come
  from.
- `-v /:/host/root:ro` — mount the host root **read-only** so the agent can read
  disk usage of every mount.
- `-v /var/run/docker.sock:/var/run/docker.sock:ro` — the Docker socket
  (read-only) for container discovery and stats.
- `-e STUBWISE_URL=…` — your Stubwise instance's URL (where samples are pushed).
- `-e STUBWISE_SERVER_KEY=…` — the per-server key from registration.
- `alelocadev/stubwise-agent` — the public image on Docker Hub; `docker run`
  pulls it automatically.

Every mount is **read-only**: the agent observes, it never writes to the host.

## Getting the key

The server key is minted when you **register the server** and is shown **only
once**:

1. In Stubwise open **Settings → Server** (admin only) and create a server (or,
   for an existing one, use **Regenerate key**).
2. A side panel opens with the full `docker run` command, the key already
   interpolated. Copy it now — the key is **not stored in clear and cannot be
   retrieved later**. If you lose it, regenerate the key (which invalidates the
   old one) and re-run the container.

## Verify and troubleshoot

The server turns **online** within about a minute of the agent's first push.
Watch the container's logs:

```bash
docker logs -f stubwise-agent
```

If things don't line up:

- **Server stays "never connected"** — the agent isn't reaching Stubwise. Check
  `docker logs stubwise-agent` for connection errors, confirm `STUBWISE_URL` is
  correct and reachable from the host (`curl -I "$STUBWISE_URL"`), and make sure
  the host's **outbound firewall** allows HTTPS to it.
- **No Docker containers listed** — the agent can't read the Docker socket
  (`EACCES`). Confirm the `--group-add "$(stat -c %g /var/run/docker.sock)"` was
  part of the run command and that the socket path matches your setup (rootless
  Docker uses a different path).
- **PM2 apps missing** — PM2 is discovered by scanning `/proc`, so the
  `/proc` mount must be present (`-v /proc:/host/proc:ro`). The agent does not
  report PM2 restart counts.

## Update

Pull the latest image and recreate the container:

```bash
docker pull alelocadev/stubwise-agent
docker rm -f stubwise-agent
# re-run the docker run command above (same URL and key)
```

## Uninstall

Stop and remove the container:

```bash
docker rm -f stubwise-agent
```

This leaves no state behind on the host (the agent is stateless). To also stop
monitoring the server in Stubwise, delete it from **Settings → Server**.
