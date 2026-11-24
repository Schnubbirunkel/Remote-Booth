## Remote Booth 1.0.2

**Docker image:** `ghcr.io/schnubbirunkel/remote-booth:1.0.2` (amd64, arm64)

### Bildschirmübertragung / Screen sharing
- Standardmäßig auf **1080p / 30 fps** begrenzt – auch bei Retina-, 1440p- und 4K-Displays wird nicht mehr in nativer Auflösung gestreamt.
  Limited to **1080p / 30 fps** by default – Retina, 1440p and 4K displays are no longer streamed at native resolution.
- Neue Einstellungen unter **Geräte**: Auflösung (720p, 1080p, 1440p, Originalauflösung) und Bildrate (5, 15, 30, 60 fps). Änderungen greifen sofort, auch während einer laufenden Freigabe.
  New settings under **Devices**: resolution (720p, 1080p, 1440p, original) and frame rate (5, 15, 30, 60 fps). Changes apply immediately, even while sharing.
- Die Bitrate passt sich automatisch an Auflösung und Bildrate an. Energiesparmodus: max. 1080p / 15 fps.
  The bitrate adapts to resolution and frame rate automatically. Power-saving mode: max. 1080p / 15 fps.
