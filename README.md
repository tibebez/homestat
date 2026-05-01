# homestat

Terminal homepage dashboard for self-hosted services, built with OpenTUI.

## Requirements

- Bun runtime

## Run

```bash
bun install
bun run dashboard
```

## Config

Create `~/.homestat/config.json`:

```json
{
  "services": [
    {
      "name": "Jellyfin",
      "url": "http://localhost:8096",
      "icon": "🎬",
      "enabled": true
    },
    {
      "name": "Jellyseerr",
      "url": "localhost:5055",
      "icon": "📽️",
      "containerName": "jellyseerr"
    },
    {
      "name": "Grafana",
      "url": "http://localhost:3000",
      "icon": "📊",
      "containerId": "a1b2c3d4e5f6"
    }
  ]
}
```

## Controls

- `←` / `→` / `↑` / `↓`: navigate cards
- `n`: add a new service (opens form in details panel)
- `t`: toggle list view (All Services → each group → back to All Services)
- `o`: open selected service in browser
- `b`: toggle bookmark on selected service (shows a subtle `★` badge)
- `e`: edit selected service
- `d`: disable selected service (`enabled: false` in config)
- `r`: refresh service health + runtime stats
- `Ctrl+C`: quit

## Health status model

- `online`: HTTP 2xx–3xx
- `offline`: any non-2xx/3xx response or network failure
- `unknown`: not checked yet

Rows show service status; the details panel shows last checked time, error details, and runtime stats when available.

## Docker auto-discovery

On startup and on `r` refresh, homestat also checks running Docker containers with:

```bash
docker ps --filter "label=homestat.enabled=true" --format json
```

For each matching container, homestat creates a temporary service (`source: "docker"`) using:

- `homestat.name`, `homestat.url`, `homestat.icon` labels when present
- fallback name: container name
- fallback URL: `http://localhost:<published-port>`
- fallback icon: `🐳`

Discovered services are merged with static `~/.homestat/config.json` services and deduped by container ID.

Discovered containers are also tracked in config with `enabled: true` the first time they are seen. Disabled services (`enabled: false`) are hidden from the dashboard (including docker-discovered containers with matching `containerId`).
