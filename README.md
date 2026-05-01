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
      "icon": "🎬"
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
- `o`: open selected service in browser
- `b`: toggle bookmark on selected service (shows a subtle `★` badge)
- `e`: edit selected service
- `d`: delete selected service
- `r`: refresh service health + runtime stats
- `Ctrl+C`: quit

## Health status model

- `online`: HTTP 2xx–3xx
- `offline`: any non-2xx/3xx response or network failure
- `unknown`: not checked yet

Rows show service status; the details panel shows last checked time, error details, and runtime stats when available.
