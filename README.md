# homestat

Fast terminal dashboard for self-hosted services.

## Install

```bash
npm i -g homestat
```

Run:

```bash
homestat
```


## Config file

Path:

```bash
~/.homestat/config.json
```

Minimal example:

```json
{
  "settings": {
    "autoRefreshEnabled": true,
    "autoRefreshIntervalSec": 30,
    "selectedAutoRefreshIntervalSec": 5,
    "autoRefreshDockerDiscovery": false,
    "refreshOnStart": true
  },
  "services": [
    {
      "type": "manual",
      "name": "Jellyfin",
      "url": "http://localhost:8096",
      "icon": "📺",
      "group": "Media"
    }
  ]
}
```

Service types:
- `manual`: regular URL checks
- `docker`: linked to a Docker container
- `widget`: custom widget-backed service

## Controls

- `↑/↓/←/→`: navigate
- `n`: new service
- `w`: new widget
- `s`: settings
- `f`: search
- `t`: cycle view (All/Group)
- `e`: edit
- `d`: disable
- `r`: refresh now
- `Enter`: open selected URL
- `Ctrl+C`: quit

## Docker auto-discovery

If enabled, homestat scans containers with:

```bash
docker ps --filter "label=homestat.enabled=true" --format json
```

Useful labels:
- `homestat.enabled=true`
- `homestat.name=Jellyfin`
- `homestat.url=http://localhost:8096`
- `homestat.icon=📺`