---
title: Server monitoring
description: "Self-hosted monitoring of the servers behind your projects: host metrics, Docker/PM2 service discovery, explicit checks and alerts over your notification channels — no third-party service, no inbound ports."
---

Stubwise can monitor the **servers that keep your projects up** without any
third-party service. A small **Docker agent** runs on each of your hosts,
collects metrics and service state, and **pushes** them to Stubwise. The web app
then gives you a Monitor section (server list, per-server detail with charts,
services and checks) and a per-project view, plus alerts over the notification
channels you already use.

## What it does

- **Host metrics** — CPU (and load average), RAM and swap, disk usage per mount,
  and network throughput (rx/tx), sampled every ~30 seconds by default.
- **Service auto-discovery** — the agent lists **Docker containers** (via the
  Docker socket) and **PM2 apps** (by scanning `/proc`), reporting each one's
  state and CPU/RAM with no configuration.
- **Explicit checks** — checks you define from the UI: `http` (up on 2xx/3xx),
  `tcp` (connect), `process` (match on the process list), and `postgres` /
  `mysql` (active/max connections, transactions per second, cache hit ratio,
  database sizes).
- **Alerts** — when a threshold is crossed for long enough, a server goes
  offline, or a check goes down, Stubwise sends a message over your existing
  [notification channels](/docs/notifications/). No automatic tickets.

## The model: one server, many projects

A **server** is a first-class entity that you associate with **one or more
projects**. Each project sees only the servers linked to it, so a shared
database host can surface under every project that depends on it.

Data flows **one way**: the agent **pushes** to Stubwise over HTTPS. The
monitored hosts **never open an inbound port** — they only need outbound HTTPS
access to your instance. Authentication is a **per-server key**, shown once at
registration and stored hashed (you can regenerate it later).

## Using it

1. **Register a server** — go to **Settings → Server** (admin only) and create a
   server. Stubwise mints its one-time agent key and opens an install panel with
   the ready-to-run `docker run` command. Follow
   [Installing the agent](/docs/monitoring/agent-install/) to get the agent
   running on the host.
2. **Associate projects** — edit the server and tick the projects it belongs to.
   Those projects gain a **Server** tab showing only their servers.
3. **Read the list and detail** — the Monitor section shows a card per server
   (status dot, hostname, agent uptime, CPU/RAM/disk gauges with sparklines,
   up/down service count). Open a server for the full detail: time-series charts
   (CPU + load, RAM + swap, disk, network) over `1h / 24h / 7d / 30d / 90d`, the
   **Services** table (auto-discovered containers and PM2 apps, then your
   explicit checks with status, latency and DB metrics), and the alert panel.
4. **Configure alerts** — set per-server **thresholds** (CPU, RAM, disk, and how
   many sustained minutes trigger an alert) and toggle notifications. Alerts fire
   **once** on entering an alarm and again on **recovery**, never repeating while
   the condition holds.

## Retention

Fine-grained samples (~30 s) are kept for **48 hours**. Beyond that they're
rolled up to **5-minute** aggregates (average and max) and kept for **90 days**,
so the long-range charts stay fast while recent history stays detailed.
