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
  "groups": [
    {
      "name": "Media",
      "services": [
        {
          "name": "Jellyfin",
          "url": "http://localhost:8096",
          "icon": "🎬"
        },
        {
          "name": "Jellyseerr",
          "url": "localhost:5055",
          "icon": "📽️"
        }
      ]
    }
  ]
}
```

## Controls

- `↑` / `↓`: move selection
- `Enter`: open selected service in browser

## Status model

- `online`: HTTP 2xx–3xx
- `offline`: any non-2xx/3xx response or network failure
- `unknown`: not checked yet

Rows show a short error code; details pane shows last checked (relative) and full error details.
